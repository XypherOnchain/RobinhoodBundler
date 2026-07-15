/**
 * ApeStore launchpad adapter — Robinhood Chain (4663).
 *
 * Trade path (protocol 30, RouterVersion2=0):
 *   SignalR Heartbeat key → POST /api/transaction → buy/sell on ApeRouters[token.router]
 *   buy(token, amount, minTokenOutput, signature) payable
 *   sell(token, amount, minNativeOutput, signature)
 */
const axios = require("axios");
const WebSocket = require("ws");
const { ethers } = require("ethers");

const CHAIN_ID = 4663;
const CHAIN_SHORT = "robinhood";
const APE_ORIGIN = "https://ape.store";

const DEFAULT_RPC =
    process.env.ROBINHOOD_RPC_URL ||
    process.env.APESTORE_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";

/** Fallback if /api/config fails */
const FALLBACK = {
    ApeRouters: ["0x2211C504DBbD87D4401f3533933E46bDd0E3F32c"],
    ApeV30Routers: ["0x6e4910ea5A04376032F6564da9a9E4E88B7a87C1"],
    ApeProxy: "0x789b3D92147C26b701bD95614D5662dB9d4Cc1f6",
    Wrapped: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    DexV3Quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    ScannerUrl: "https://robinhoodchain.blockscout.com",
    RouterVersion2: 0,
};

const BUY_SELECTOR = "0x6c025572"; // buy(address,uint256,uint256,bytes)
const SELL_SELECTOR = "0x3581f5bb"; // sell(address,uint256,uint256,bytes)

const ROUTER_ABI = [
    "function buy(address token, uint256 amount, uint256 minTokenOutput, bytes signature) payable",
    "function sell(address token, uint256 amount, uint256 minNativeOutput, bytes signature)",
];

const provider = new ethers.JsonRpcProvider(DEFAULT_RPC, CHAIN_ID);

let chainConfig = { ...FALLBACK };
let configAt = 0;

let sessionKey = null;
let sessionKeyAt = 0;
let ws = null;
let wsReady = false;
let negotiateLock = false;
let lastInvocationId = 3;
const pendingHeartbeats = new Set();

const browserHeaders = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    Origin: APE_ORIGIN,
    Referer: `${APE_ORIGIN}/`,
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Robinhood RPC sometimes never returns estimateGas for empty wallets. */
async function withTimeout(promise, ms, label = "operation") {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `${label} timeout after ${ms}ms (RPC hang / unfunded wallet)`
                            )
                        ),
                    ms
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function isEvmAddress(txt) {
    return typeof txt === "string" && /^0x[0-9a-fA-F]{40}$/.test(txt);
}

function isEvmPrivateKey(txt) {
    if (typeof txt !== "string") return false;
    const h = txt.startsWith("0x") ? txt.slice(2) : txt;
    return /^[0-9a-fA-F]{64}$/.test(h);
}

function explorerBase() {
    return (chainConfig.ScannerUrl || FALLBACK.ScannerUrl).replace(/\/$/, "");
}

async function refreshConfig(force = false) {
    if (!force && Date.now() - configAt < 5 * 60 * 1000 && chainConfig.ApeRouters?.length) {
        return chainConfig;
    }
    try {
        const { data: raw } = await axios.get(`${APE_ORIGIN}/api/config`, {
            headers: browserHeaders,
            timeout: 15000,
            responseType: "text",
            transformResponse: [(d) => d],
        });
        let text = String(raw || "");
        text = text.replace(/^var\s+ApeConfig\s*=\s*/, "");
        const end = text.indexOf("];");
        if (end >= 0) text = text.slice(0, end + 1);
        const arr = JSON.parse(text);
        const rh = (arr || []).find(
            (c) => c.ID === CHAIN_ID || c.Short === CHAIN_SHORT
        );
        if (rh) {
            chainConfig = { ...FALLBACK, ...rh };
            configAt = Date.now();
        }
    } catch (_) {
        /* keep fallback */
    }
    return chainConfig;
}

function routerForToken(tokenMeta) {
    const routers = chainConfig.ApeRouters || FALLBACK.ApeRouters;
    const idx = Number(tokenMeta?.router ?? 0);
    return routers[idx] || routers[0];
}

async function getWalletBalance(address) {
    const bal = await provider.getBalance(address);
    return ethers.formatEther(bal);
}

async function getTokenBalance(address, token) {
    const c = new ethers.Contract(
        token,
        [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
        ],
        provider
    );
    const [raw, decimals] = await Promise.all([
        c.balanceOf(address),
        c.decimals().catch(() => 18),
    ]);
    return {
        raw,
        formatted: ethers.formatUnits(raw, decimals),
        decimals: Number(decimals),
    };
}

async function getTokenInfo(tokenAddress) {
    if (!isEvmAddress(tokenAddress)) throw new Error("Invalid token");
    const { data } = await axios.get(
        `${APE_ORIGIN}/api/token/${CHAIN_SHORT}/${tokenAddress}`,
        { headers: browserHeaders, timeout: 15000 }
    );
    return data;
}

/**
 * Shape ape.store token detail into the NOXA-like object buildBuyPlan expects.
 * Ape marketCap is USD; currentPrice is ETH per token.
 */
function toPlanTokenInfo(apeInfo, ethUsd = 0) {
    const t = apeInfo?.token || apeInfo || {};
    const address = t.address;
    const priceEth = Number(apeInfo?.currentPrice ?? t.priceEth ?? 0) || 0;
    const mcapUsd = Number(apeInfo?.marketCap ?? t.marketCap ?? 0) || 0;
    const px = Number(ethUsd) || 0;
    let marketCapEth = 0;
    if (mcapUsd > 0 && px > 0) marketCapEth = mcapUsd / px;
    else if (priceEth > 0) marketCapEth = priceEth * 1_000_000_000;
    return {
        token: {
            address,
            name: t.name,
            symbol: t.symbol,
            decimals: 18,
            supply: "1000000000",
            priceEth,
            marketCapEth,
            poolFee: 10000,
            pairedToken: chainConfig.Wrapped || FALLBACK.Wrapped,
            router: t.router,
            protocol: t.protocol,
            id: t.id,
            pairAddress: t.pairAddress,
            launchpad: "apestore",
        },
        stats: {
            volume24hEth: 0,
        },
        marketCapEth,
        currentPrice: priceEth,
        launchpad: "apestore",
        apeUrl: address ? `${APE_ORIGIN}/rh/${address}` : null,
    };
}

function tokenMetaFromInfo(info) {
    return info?.token || info;
}

function parseSignalRMessages(raw) {
    const text = raw.toString();
    const parts = text.split("\x1e").filter((p) => p && p.trim());
    const out = [];
    for (const part of parts) {
        try {
            out.push(JSON.parse(part));
        } catch (_) {}
    }
    return out;
}

function handleSignalRMessage(message) {
    if (
        message.type === 3 &&
        pendingHeartbeats.has(String(message.invocationId))
    ) {
        pendingHeartbeats.delete(String(message.invocationId));
        if (message.result != null && message.result !== "") {
            sessionKey = message.result;
            sessionKeyAt = Date.now();
        }
    }
}

async function connectSignalR() {
    if (negotiateLock) return;
    negotiateLock = true;
    wsReady = false;
    try {
        const { data } = await axios.post(
            `${APE_ORIGIN}/eventHub/negotiate?negotiateVersion=1`,
            {},
            { headers: browserHeaders, timeout: 15000 }
        );
        const { url, accessToken } = data || {};
        if (!url || !accessToken) throw new Error("ApeStore negotiate failed");

        if (ws) {
            try {
                ws.close();
            } catch (_) {}
        }
        ws = new WebSocket(`${url}&access_token=${accessToken}`);

        ws.on("message", (raw) => {
            for (const message of parseSignalRMessages(raw)) {
                handleSignalRMessage(message);
            }
        });

        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("WS connect timeout")), 15000);
            ws.on("open", () => {
                clearTimeout(t);
                ws.send('{"protocol":"json","version":1}\x1e');
                ws.send(
                    '{"arguments":[],"invocationId":"3","target":"GetLatestEvents","type":1}\x1e'
                );
                wsReady = true;
                resolve();
            });
            ws.on("error", (e) => {
                clearTimeout(t);
                reject(e);
            });
        });

        ws.on("close", () => {
            wsReady = false;
        });

        const iv = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                clearInterval(iv);
                return;
            }
            try {
                ws.send(JSON.stringify({ type: 6 }) + "\x1e");
            } catch (_) {}
        }, 15000);
    } finally {
        negotiateLock = false;
    }
}

async function ensureSessionKey(force = false) {
    if (!force && sessionKey && Date.now() - sessionKeyAt < 20000) {
        return sessionKey;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) {
                await connectSignalR();
            }
            if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) {
                throw new Error("ApeStore SignalR not ready — cannot sign trades");
            }
            lastInvocationId += 1;
            const id = String(lastInvocationId);
            pendingHeartbeats.add(id);
            const keyBefore = sessionKeyAt;
            ws.send(
                `{"arguments":[],"invocationId":"${id}","target":"Heartbeat","type":1}\x1e`
            );
            const start = Date.now();
            while (Date.now() - start < 10000) {
                if (sessionKey && sessionKeyAt > keyBefore) return sessionKey;
                if (sessionKey && Date.now() - sessionKeyAt < 5000) return sessionKey;
                await sleep(50);
            }
            // force reconnect next attempt
            wsReady = false;
            try {
                ws.close();
            } catch (_) {}
        } catch (e) {
            wsReady = false;
            if (attempt === 2) throw e;
            await sleep(400);
        }
    }
    if (sessionKey) return sessionKey;
    throw new Error("ApeStore Heartbeat key timeout");
}

async function getSignature({ wallet, amountWei, tokenId }) {
    const key = await ensureSessionKey();
    // Browser sends tokenId as a number (k.token.id), not a string.
    const payload = {
        tokenId: Number(tokenId),
        address: wallet,
        key,
        amount: String(amountWei),
    };
    let lastErr;
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            if (attempt > 0 && attempt % 2 === 0) await ensureSessionKey(true);
            const { data } = await axios.post(
                `${APE_ORIGIN}/api/transaction`,
                payload,
                {
                    headers: {
                        ...browserHeaders,
                        Referer: `${APE_ORIGIN}/${CHAIN_SHORT}/`,
                    },
                    timeout: 4000,
                }
            );
            if (!data || typeof data !== "string" || !data.startsWith("0x")) {
                throw new Error(`Bad signature payload: ${JSON.stringify(data)}`);
            }
            return data;
        } catch (e) {
            lastErr = e;
            const body = e?.response?.data;
            if (body && typeof body === "object") {
                lastErr = new Error(
                    typeof body === "string"
                        ? body
                        : body.message || body.error || JSON.stringify(body)
                );
            }
            await sleep(Math.min(2000, 150 * 2 ** attempt));
        }
    }
    throw new Error(
        `ApeStore signature failed: ${lastErr?.response?.data || lastErr?.message || lastErr}`
    );
}

function encodeTradeCalldata(selector, tokenAddress, amountWei, signature, minOut = 0n) {
    const tokenParam = ethers.zeroPadValue(tokenAddress, 32).slice(2);
    const amountParam = ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2);
    const minOutParam = ethers.zeroPadValue(ethers.toBeHex(minOut), 32).slice(2);
    const padding =
        "0000000000000000000000000000000000000000000000000000000000000080";
    const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
    const sigLen = Math.ceil(sigHex.length / 2);
    const signatureLength = ethers
        .zeroPadValue(ethers.toBeHex(sigLen), 32)
        .slice(2);
    const paddedSig =
        sigHex + "0".repeat((64 - (sigHex.length % 64)) % 64);
    return `${selector}${tokenParam}${amountParam}${minOutParam}${padding}${signatureLength}${paddedSig}`;
}

async function feeOverrides(options = {}) {
    const feeData = await provider.getFeeData();
    const tipBase =
        feeData.maxPriorityFeePerGas || ethers.parseUnits("0.01", "gwei");
    const maxBase = feeData.maxFeePerGas || ethers.parseUnits("0.05", "gwei");
    const mult = Number(options.priorityMultiplier || 1);
    const tip =
        mult > 1
            ? (tipBase * BigInt(Math.round(mult * 100))) / 100n
            : tipBase;
    const maxFee = mult > 1 ? (maxBase * BigInt(Math.round(mult * 100))) / 100n : maxBase;
    // L1: never default create/buy to 450k — that OOGed image+dev-buy creates.
    // Callers should pass estimated gasLimit; fallback is intentionally high.
    const fallbackGas = options.createTx ? 6_000_000 : 800_000;
    return {
        maxFeePerGas: maxFee > tip ? maxFee : tip + ethers.parseUnits("0.01", "gwei"),
        maxPriorityFeePerGas: tip,
        gasLimit: BigInt(options.gasLimit || fallbackGas),
    };
}

function minOutFromSlippage(quoted, slippageBps) {
    const bps = Math.min(9900, Math.max(0, Number(slippageBps ?? 5000)));
    if (!quoted || quoted <= 0n) return 0n;
    return (quoted * BigInt(10000 - bps)) / 10000n;
}

/**
 * Buy ApeStore (Robinhood) token with native ETH.
 */
async function buy(walletData, amountEth, tokenAddress, options = {}) {
    if (!isEvmPrivateKey(walletData?.private_key || walletData?.privateKey)) {
        throw new Error("Invalid private key");
    }
    if (!isEvmAddress(tokenAddress)) throw new Error("Invalid token");
    const amount = Number(amountEth);
    if (!(amount > 0)) throw new Error("Invalid buy amount");

    await refreshConfig();

    const pk = walletData.private_key || walletData.privateKey;
    const wallet = new ethers.Wallet(pk, provider);
    const info = await getTokenInfo(tokenAddress);
    const meta = tokenMetaFromInfo(info);
    const tokenId = meta?.id;
    if (tokenId == null) {
        throw new Error(
            "ApeStore token id missing — is this a Robinhood ape.store token?"
        );
    }
    if (Number(meta.chain) && Number(meta.chain) !== CHAIN_ID) {
        throw new Error(`Token chain ${meta.chain} ≠ Robinhood ${CHAIN_ID}`);
    }

    const router = routerForToken(meta);
    const amountWei = ethers.parseEther(String(amount));
    const signature = await getSignature({
        wallet: wallet.address,
        amountWei,
        tokenId,
    });
    const minOut = minOutFromSlippage(0n, options.slippageBps);
    const data = encodeTradeCalldata(
        BUY_SELECTOR,
        tokenAddress,
        amountWei,
        signature,
        minOut
    );
    const fees = await feeOverrides(options);

    if (options.dryRun) {
        let estimateGas = null;
        let staticError = null;
        const gasTimeoutMs = Number(options.estimateTimeoutMs || 12000);
        try {
            estimateGas = await withTimeout(
                provider.estimateGas({
                    from: wallet.address,
                    to: router,
                    value: amountWei,
                    data,
                }),
                gasTimeoutMs,
                "buy estimateGas"
            );
        } catch (e) {
            staticError = e.shortMessage || e.message || String(e);
        }
        return {
            dryRun: true,
            wallet: wallet.address,
            amountEth: amount,
            token: tokenAddress,
            tokenId,
            router,
            signature,
            calldata: data,
            estimateGas: estimateGas != null ? estimateGas.toString() : null,
            staticError,
            launchpad: "apestore",
            chainId: CHAIN_ID,
        };
    }

    const tx = await wallet.sendTransaction({
        to: router,
        value: amountWei,
        data,
        chainId: CHAIN_ID,
        ...fees,
    });
    if (options.waitForReceipt !== false) {
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`ApeStore buy reverted · ${tx.hash}`);
        }
    }
    return {
        hash: tx.hash,
        wallet: wallet.address,
        amountEth: amount,
        token: tokenAddress,
        explorer: `${explorerBase()}/tx/${tx.hash}`,
        launchpad: "apestore",
        chainId: CHAIN_ID,
        router,
    };
}

/**
 * Sell token amount (or percent of balance) back to ETH.
 */
async function sell(walletData, amountTokens, tokenAddress, options = {}) {
    if (!isEvmPrivateKey(walletData?.private_key || walletData?.privateKey)) {
        throw new Error("Invalid private key");
    }
    if (!isEvmAddress(tokenAddress)) throw new Error("Invalid token");

    await refreshConfig();

    const pk = walletData.private_key || walletData.privateKey;
    const wallet = new ethers.Wallet(pk, provider);
    const info = await getTokenInfo(tokenAddress);
    const meta = tokenMetaFromInfo(info);
    const tokenId = meta?.id;
    if (tokenId == null) throw new Error("ApeStore token id missing");

    const router = routerForToken(meta);
    const tokenContract = new ethers.Contract(
        tokenAddress,
        [
            "function balanceOf(address) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function approve(address spender, uint256 amount) returns (bool)",
            "function allowance(address owner, address spender) view returns (uint256)",
        ],
        wallet
    );
    const decimals = Number(await tokenContract.decimals().catch(() => 18));
    let amountWei;
    if (options.percent != null) {
        const bal = await tokenContract.balanceOf(wallet.address);
        const pct = Math.min(100, Math.max(1, Number(options.percent)));
        amountWei = (bal * BigInt(pct)) / 100n;
    } else {
        amountWei = ethers.parseUnits(String(amountTokens), decimals);
    }
    if (amountWei <= 0n) throw new Error("Nothing to sell");

    const allowance = await tokenContract.allowance(wallet.address, router);
    if (allowance < amountWei) {
        const aTx = await tokenContract.approve(router, ethers.MaxUint256);
        await aTx.wait();
    }

    const signature = await getSignature({
        wallet: wallet.address,
        amountWei,
        tokenId,
    });
    const data = encodeTradeCalldata(
        SELL_SELECTOR,
        tokenAddress,
        amountWei,
        signature,
        0n
    );
    const fees = await feeOverrides(options);
    const tx = await wallet.sendTransaction({
        to: router,
        value: 0n,
        data,
        chainId: CHAIN_ID,
        ...fees,
    });
    if (options.waitForReceipt !== false) {
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`ApeStore sell reverted · ${tx.hash}`);
        }
    }
    return {
        hash: tx.hash,
        wallet: wallet.address,
        amountRaw: amountWei.toString(),
        token: tokenAddress,
        explorer: `${explorerBase()}/tx/${tx.hash}`,
        launchpad: "apestore",
        chainId: CHAIN_ID,
        router,
    };
}

async function multiBuy(wallets, tokenAddress, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const mode = String(options.mode || "sequential").toLowerCase();
    const results = [];
    const list = (wallets || []).filter(
        (w) => Number(w.buyAmountEth) > 0 && (w.private_key || w.privateKey)
    );
    if (!list.length) return results;

    await refreshConfig();
    await ensureSessionKey().catch(() => {});

    const forceUni = options.forceUni === true;
    const uniFallback = options.uniFallback !== false; // L3: default ON
    let chainBuy = null;
    const getChainBuy = () => {
        if (chainBuy) return chainBuy;
        try {
            chainBuy = require("../blockchain").buy;
        } catch (_) {
            chainBuy = null;
        }
        return chainBuy;
    };

    const runOne = async (w) => {
        if (options.shouldAbort?.()) {
            results.push({
                ok: false,
                wallet: w.address,
                name: w.name || w.address,
                error: "aborted",
            });
            return null;
        }
        const label = w.name || w.address;
        const walletData = { private_key: w.private_key || w.privateKey, address: w.address };
        try {
            onProgress({
                type: "buying",
                wallet: w.address,
                name: label,
                amount: w.buyAmountEth,
            });
            let r;
            if (forceUni) {
                const buyFn = getChainBuy();
                if (!buyFn) throw new Error("Uni fallback unavailable (blockchain.buy missing)");
                onProgress({ type: "info", wallet: w.address, name: label, msg: "forceUni" });
                r = await buyFn(walletData, w.buyAmountEth, tokenAddress, {
                    waitForReceipt: options.waitForReceipt !== false,
                    fee: 10000,
                    slippageBps: options.slippageBps,
                });
                r = { ...r, via: "uniswap", ok: true, name: label };
            } else {
                try {
                    r = await buy(walletData, w.buyAmountEth, tokenAddress, {
                        waitForReceipt: options.waitForReceipt !== false,
                        slippageBps: options.slippageBps,
                        priorityMultiplier: options.priorityMultiplier,
                    });
                    r = { ...r, via: "apestore", ok: true, name: label };
                } catch (apeErr) {
                    const apeMsg = apeErr.shortMessage || apeErr.message || String(apeErr);
                    const shouldFallback =
                        uniFallback &&
                        /500|429|signature|timeout|rate|session|fetch|network|ECONN|aborted/i.test(
                            apeMsg
                        );
                    if (!shouldFallback) throw apeErr;
                    const buyFn = getChainBuy();
                    if (!buyFn) throw apeErr;
                    onProgress({
                        type: "info",
                        wallet: w.address,
                        name: label,
                        msg: `ApeStore sig failed → Uni fallback (${apeMsg.slice(0, 80)})`,
                    });
                    r = await buyFn(walletData, w.buyAmountEth, tokenAddress, {
                        waitForReceipt: options.waitForReceipt !== false,
                        fee: 10000,
                        slippageBps: options.slippageBps,
                    });
                    r = {
                        ...r,
                        via: "uniswap_fallback",
                        apeError: apeMsg,
                        ok: true,
                        name: label,
                    };
                }
            }
            onProgress({
                type: "bought",
                wallet: w.address,
                name: label,
                hash: r.hash,
                via: r.via,
            });
            results.push(r);
            return r;
        } catch (e) {
            const err = e.shortMessage || e.message || String(e);
            onProgress({ type: "error", wallet: w.address, name: label, error: err });
            results.push({
                ok: false,
                wallet: w.address,
                name: label,
                error: err,
            });
            return null;
        }
    };

    if (mode === "burst" || mode === "parallel") {
        // Signatures rate-limit — keep concurrency low vs NOXA Uni path
        const concurrency = Math.min(
            4,
            Math.max(1, Number(options.concurrency || 3))
        );
        for (let i = 0; i < list.length; i += concurrency) {
            if (options.shouldAbort?.()) break;
            const chunk = list.slice(i, i + concurrency);
            await Promise.all(chunk.map(runOne));
            if (i + concurrency < list.length) await sleep(400);
        }
    } else {
        for (const w of list) {
            if (options.shouldAbort?.()) break;
            await runOne(w);
            const delayMs = Math.max(
                0,
                Number(options.delayMs ?? (Number(w.delaySec) || 0) * 1000)
            );
            if (delayMs) {
                onProgress({ type: "waiting", delayMs });
                await sleep(delayMs);
            } else {
                await sleep(250);
            }
        }
    }
    return results;
}

async function multiSell(wallets, tokenAddress, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const percent = Math.min(100, Math.max(1, Number(options.percent || 100)));
    const results = [];
    await refreshConfig();
    await ensureSessionKey().catch(() => {});

    let list = [...(wallets || [])];
    if (Array.isArray(options.walletOrder) && options.walletOrder.length) {
        const by = new Map(
            list.map((w) => [String(w.address || "").toLowerCase(), w])
        );
        const ordered = [];
        for (const a of options.walletOrder) {
            const w = by.get(String(a).toLowerCase());
            if (w) ordered.push(w);
        }
        for (const w of list) {
            if (
                !ordered.some(
                    (o) =>
                        String(o.address).toLowerCase() ===
                        String(w.address).toLowerCase()
                )
            ) {
                ordered.push(w);
            }
        }
        list = ordered;
    }

    const mode = String(options.mode || "sequential").toLowerCase();
    const runOne = async (w) => {
        const label = w.name || w.address;
        try {
            onProgress({
                type: "selling",
                wallet: w.address,
                name: label,
                amount: `${percent}%`,
                percent,
            });
            const r = await sell(
                { private_key: w.private_key || w.privateKey },
                null,
                tokenAddress,
                {
                    percent,
                    waitForReceipt: options.waitForReceipt !== false,
                    priorityMultiplier: options.priorityMultiplier,
                }
            );
            onProgress({
                type: "sold",
                wallet: w.address,
                name: label,
                hash: r.hash,
            });
            results.push({ ...r, ok: true, name: label });
        } catch (e) {
            const err = e.shortMessage || e.message || String(e);
            onProgress({ type: "error", wallet: w.address, name: label, error: err });
            results.push({ ok: false, wallet: w.address, name: label, error: err });
        }
    };

    if (mode === "parallel") {
        const concurrency = Math.min(
            4,
            Math.max(1, Number(options.concurrency || 3))
        );
        for (let i = 0; i < list.length; i += concurrency) {
            await Promise.all(list.slice(i, i + concurrency).map(runOne));
            await sleep(300);
        }
    } else {
        for (const w of list) {
            await runOne(w);
            const delayMs = Math.max(0, Number(options.delayMs || 300));
            if (delayMs) {
                onProgress({ type: "waiting", delayMs });
                await sleep(delayMs);
            }
        }
    }
    return results;
}

const CREATE_ABI = [
    "event CreateToken(address indexed token, uint256 indexed id)",
    "function deployToken(uint256 id, (string name, string symbol, int24 initialTick, uint24 fee) _token, bytes signature) payable returns (address token)",
];

function v30Router() {
    const list = chainConfig.ApeV30Routers || FALLBACK.ApeV30Routers;
    return list[list.length - 1] || list[0];
}

/**
 * Create a Robinhood ApeStore token (protocol 30) from the creator wallet.
 * Flow matches ape.store UI: POST /api/token → deployToken on ApeV30Routers.
 */
async function launchToken(walletData, options = {}) {
    if (!isEvmPrivateKey(walletData?.private_key || walletData?.privateKey)) {
        throw new Error("Invalid private key");
    }
    const name = String(options.name || "").trim();
    const symbol = String(options.symbol || "").trim();
    if (!name || !symbol) throw new Error("name and symbol required");

    const buyEth = Math.min(
        2,
        Math.max(0, Number(options.buyEth ?? options.devBuyEth ?? 0))
    );
    const deployCostEth = Math.max(
        0,
        Number(options.deployCostEth ?? process.env.APESTORE_DEPLOY_COST_ETH ?? 0)
    );
    const valueEth = buyEth + deployCostEth;
    if (!(valueEth >= 0)) throw new Error("Invalid create value");

    await refreshConfig();
    const pk = walletData.private_key || walletData.privateKey;
    const wallet = new ethers.Wallet(pk, provider);
    const router = v30Router();
    if (!isEvmAddress(router)) throw new Error("ApeStore V30 router missing");

    const form = new FormData();
    form.append("data.Chain", String(CHAIN_ID));
    form.append("data.Protocol", "30");
    form.append("data.Creator", wallet.address);
    form.append("data.Name", name);
    form.append("data.Symbol", symbol.slice(0, 12));
    form.append("data.Description", String(options.description || "").slice(0, 500));
    form.append("data.Telegram", String(options.telegram || ""));
    form.append("data.Twitter", String(options.twitter || ""));
    form.append("data.Website", String(options.website || ""));

    let signed;
    try {
        // Prefer fetch for multipart — axios + Node FormData can hang.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30000);
        let res;
        try {
            res = await fetch(`${APE_ORIGIN}/api/token`, {
                method: "POST",
                headers: {
                    accept: browserHeaders.accept,
                    Origin: APE_ORIGIN,
                    Referer: `${APE_ORIGIN}/rh/`,
                    "User-Agent": browserHeaders["User-Agent"],
                },
                body: form,
                signal: ac.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        const text = await res.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (_) {
            data = text;
        }
        if (!res.ok) {
            const msg =
                (data && (data.message || data.error || data.title)) ||
                (typeof data === "string" ? data : null) ||
                `HTTP ${res.status}`;
            throw new Error(msg);
        }
        signed = data;
    } catch (e) {
        throw new Error(`ApeStore create sign failed: ${e.message || e}`);
    }

    const tokenId = signed?.id;
    const signature = signed?.signature;
    if (tokenId == null || !signature) {
        throw new Error(
            `ApeStore create missing id/signature: ${JSON.stringify(signed)?.slice(0, 200)}`
        );
    }

    const c = new ethers.Contract(router, CREATE_ABI, wallet);
    const valueWei = ethers.parseEther(String(valueEth));
    const deployArgs = [
        tokenId,
        {
            name,
            symbol: symbol.slice(0, 12),
            initialTick: -208200,
            fee: 10000,
        },
        signature,
    ];

    // L1: always estimateGas × safety multiplier for live create (image + dev buy)
    const gasMult = Math.max(1.5, Number(options.gasSafetyMult || 2.0));
    let estimatedGas = null;
    let estimateErr = null;
    try {
        estimatedGas = await withTimeout(
            c.deployToken.estimateGas(...deployArgs, { value: valueWei }),
            Number(options.estimateTimeoutMs || 20000),
            "deployToken estimateGas"
        );
    } catch (e) {
        estimateErr = e.shortMessage || e.message || String(e);
    }
    const safeGasLimit = estimatedGas
        ? (estimatedGas * BigInt(Math.round(gasMult * 100))) / 100n
        : BigInt(options.gasLimit || 6_000_000);
    // Floor: never below 2M for create-with-buy; cap absurd estimates
    const floored =
        safeGasLimit < 2_000_000n
            ? 2_000_000n
            : safeGasLimit > 12_000_000n
              ? 12_000_000n
              : safeGasLimit;
    const fees = await feeOverrides({
        ...options,
        createTx: true,
        gasLimit: floored,
    });

    if (options.dryRun) {
        return {
            dryRun: true,
            apeId: tokenId,
            signature,
            router,
            creator: wallet.address,
            name,
            symbol: symbol.slice(0, 12),
            valueEth,
            buyEth,
            estimateGas: estimatedGas != null ? estimatedGas.toString() : null,
            gasLimitUsed: floored.toString(),
            staticError: estimateErr,
            launchpad: "apestore",
            chainId: CHAIN_ID,
            note: "Signed with ape.store — on-chain deploy NOT sent",
        };
    }

    if (!estimatedGas && !options.forceWithoutEstimate) {
        // Still allow with high fallback, but surface the estimate failure
        console.warn(
            "[apestore] deployToken estimateGas failed, using fallback",
            estimateErr,
            "gasLimit",
            floored.toString()
        );
    }

    let tx;
    try {
        tx = await c.deployToken(...deployArgs, {
            value: valueWei,
            ...fees,
        });
    } catch (e) {
        return {
            error: e.shortMessage || e.message || String(e),
            hash: null,
            token: null,
            gasLimitTried: floored.toString(),
            estimateError: estimateErr,
        };
    }

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
        return { error: `ApeStore create reverted · ${tx.hash}`, hash: tx.hash, token: null };
    }

    let token = null;
    try {
        const iface = new ethers.Interface(CREATE_ABI);
        for (const log of receipt.logs || []) {
            try {
                const parsed = iface.parseLog(log);
                if (parsed?.name === "CreateToken") {
                    token = parsed.args.token || parsed.args[0];
                    break;
                }
            } catch (_) {}
        }
    } catch (_) {}

    if (!token) {
        // fallback: look up by id via API after a short wait
        await sleep(1500);
        try {
            const { data } = await axios.get(
                `${APE_ORIGIN}/api/tokens?chain=${CHAIN_ID}&search=${encodeURIComponent(symbol)}`,
                { headers: browserHeaders, timeout: 15000 }
            );
            const items = data?.items || data || [];
            const hit = (Array.isArray(items) ? items : []).find(
                (t) =>
                    Number(t.id) === Number(tokenId) ||
                    (String(t.symbol || "").toLowerCase() === symbol.toLowerCase() &&
                        String(t.creator || "").toLowerCase() ===
                            wallet.address.toLowerCase())
            );
            token = hit?.address || null;
        } catch (_) {}
    }

    if (!token) {
        return {
            error: "Created on-chain but token address not found in receipt",
            hash: tx.hash,
            token: null,
            apeId: tokenId,
        };
    }

    return {
        token: ethers.getAddress(token),
        hash: tx.hash,
        apeId: tokenId,
        router,
        explorer: `${explorerBase()}/tx/${tx.hash}`,
        apeUrl: `${APE_ORIGIN}/${CHAIN_SHORT}/${ethers.getAddress(token)}`,
        launchpad: "apestore",
        chainId: CHAIN_ID,
        noxaUrl: `${APE_ORIGIN}/${CHAIN_SHORT}/${ethers.getAddress(token)}`,
    };
}

async function ping() {
    try {
        await refreshConfig(true);
        const block = await provider.getBlockNumber();
        return {
            ok: true,
            launchpad: "apestore",
            chainId: CHAIN_ID,
            chain: CHAIN_SHORT,
            block,
            router: (chainConfig.ApeRouters || [])[0],
            v30: v30Router(),
            rpc: DEFAULT_RPC,
            active: chainConfig.Active !== false,
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = {
    CHAIN_ID,
    CHAIN_SHORT,
    provider,
    isEvmAddress,
    isEvmPrivateKey,
    getWalletBalance,
    getTokenBalance,
    getTokenInfo,
    toPlanTokenInfo,
    refreshConfig,
    buy,
    sell,
    multiBuy,
    multiSell,
    launchToken,
    ping,
    ensureSessionKey,
    getSignature,
};
