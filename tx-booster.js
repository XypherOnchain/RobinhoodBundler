/**
 * Robinhood TX booster — tiny Uniswap V3 buys to pad tx count / stay trending.
 * Designed to burn as little ETH as possible (skip quotes, floor tips, small size).
 */
const { ethers } = require("ethers");
const chain = require("./blockchain");

const SPEEDS = {
    slow: { label: "Slow", minMs: 45_000, maxMs: 90_000 },
    medium: { label: "Medium", minMs: 8_000, maxMs: 15_000 },
    high: { label: "High", minMs: 800, maxMs: 2_000 },
    blaze: { label: "Blaze", minMs: 150, maxMs: 400 },
};

const DEFAULT_BUY_ETH = "0.0000001"; // dust — gas dominates cost
const MIN_BUY_ETH = "0.00000005";
const MAX_BUY_ETH = "0.00001";
// Actual Uniswap V3 micro-buy ~120k gas; keep headroom without over-reserving
const CHEAP_GAS_LIMIT = 160000n;
const TRANSFER_GAS_LIMIT = 65000n; // ERC20 transfer ~30k
const LOG_CAP = 80;
const MODES = {
    buy: { label: "Buy (Uniswap)", note: "~$0.01/tx" },
    transfer: { label: "Transfer (cheap)", note: "~$0.002–0.003/tx" },
    mix: { label: "Mix 1 buy : 9 xfer", note: "~$0.003/tx avg" },
};
const ERC20_IFACE = new ethers.Interface([
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
]);

function randBetween(a, b) {
    return a + Math.floor(Math.random() * Math.max(1, b - a + 1));
}

function clampBuyEth(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUY_ETH;
    const min = Number(MIN_BUY_ETH);
    const max = Number(MAX_BUY_ETH);
    const c = Math.min(max, Math.max(min, n));
    // keep scientific-ish precision without trailing junk
    return c.toFixed(10).replace(/\.?0+$/, "") || DEFAULT_BUY_ETH;
}


function walletPrivateKey(w) {
    if (!w) return null;
    const pk = w.private_key || w.privateKey || null;
    if (!pk) return null;
    return String(pk);
}

function findTxBotWallet(store) {
    if (!store?.wallets?.length) return { index: null, wallet: null };
    // Prefer configured index only if it has a usable key
    const prefer = store.txBot?.walletIndex;
    if (prefer != null && store.wallets[prefer]) {
        const w = store.wallets[prefer];
        if (walletPrivateKey(w) && chain.isEvmPrivateKey(walletPrivateKey(w))) {
            return { index: Number(prefer), wallet: w };
        }
    }
    // Else first role=txbot with a valid key
    for (let i = 0; i < store.wallets.length; i++) {
        const w = store.wallets[i];
        if (w.role !== "txbot") continue;
        const pk = walletPrivateKey(w);
        if (pk && chain.isEvmPrivateKey(pk)) return { index: i, wallet: w };
    }
    return { index: null, wallet: null };
}

function createBooster(options = {}) {
    const state = {
        running: false,
        stopping: false,
        token: "",
        speed: "medium",
        mode: "transfer", // cheapest default
        buyEth: DEFAULT_BUY_ETH,
        jitterBuy: true,
        _mixCounter: 0,
        walletIndex: null,
        startedAt: null,
        lastTxAt: null,
        nextAt: null,
        stats: {
            ok: 0,
            fail: 0,
            skipped: 0,
            ethSpent: 0,
            gasEth: 0,
            totalEth: 0,
            spentUsd: null,
            ethUsd: null,
            lastError: null,
            lastHash: null,
        },
        _wake: null,
        logs: [],
        _timer: null,
        _loopId: 0,
        onBroadcast: options.onBroadcast || (() => {}),
        getStore: options.getStore || (() => null),
        saveStore: options.saveStore || (() => {}),
        isPeerRunning: options.isPeerRunning || (() => false),
    };

    function pushLog(text, kind = "info") {
        const entry = { at: new Date().toISOString(), text, kind };
        state.logs.unshift(entry);
        if (state.logs.length > LOG_CAP) state.logs.length = LOG_CAP;
        state.onBroadcast({ type: "txbot_log", entry, status: publicStatus() });
    }

    function recomputeSpend() {
        const total = Number(state.stats.ethSpent || 0) + Number(state.stats.gasEth || 0);
        state.stats.totalEth = total;
        const px = Number(state.stats.ethUsd || 0);
        state.stats.spentUsd = px > 0 ? total * px : null;
    }

    async function refreshEthUsd() {
        try {
            const px = await chain.getEthUsdPrice();
            if (px > 0) state.stats.ethUsd = px;
            recomputeSpend();
        } catch (_) {}
    }

    function wakeLoop() {
        if (state._timer) {
            clearTimeout(state._timer);
            state._timer = null;
        }
        if (typeof state._wake === "function") {
            const w = state._wake;
            state._wake = null;
            w();
        }
    }

    function trackGasAsync(txHash, fallbackTip) {
        if (!txHash) return;
        (async () => {
            try {
                let receipt = null;
                for (let i = 0; i < 40; i++) {
                    receipt = await chain.provider.getTransactionReceipt(txHash);
                    if (receipt) break;
                    await new Promise((r) => setTimeout(r, 1500));
                }
                if (!receipt) return;
                const gasUsed = BigInt(receipt.gasUsed || 0);
                let price =
                    receipt.effectiveGasPrice != null
                        ? BigInt(receipt.effectiveGasPrice)
                        : receipt.gasPrice != null
                          ? BigInt(receipt.gasPrice)
                          : fallbackTip != null
                            ? BigInt(fallbackTip)
                            : 0n;
                if (gasUsed <= 0n || price <= 0n) return;
                const gasEth = Number(ethers.formatEther(gasUsed * price));
                state.stats.gasEth = Number(state.stats.gasEth || 0) + gasEth;
                recomputeSpend();
                state.onBroadcast({ type: "txbot_status", status: publicStatus() });
            } catch (_) {}
        })();
    }

    function publicStatus() {
        const store = state.getStore();
        const found = findTxBotWallet(store);
        const w = found.wallet;
        if (found.index != null) state.walletIndex = found.index;
        const spd = SPEEDS[state.speed] || SPEEDS.medium;
        const hasKey = !!(w && walletPrivateKey(w) && chain.isEvmPrivateKey(walletPrivateKey(w)));
        return {
            running: state.running,
            stopping: state.stopping,
            token: state.token,
            speed: state.speed,
            speedLabel: spd.label,
            intervalMs: { min: spd.minMs, max: spd.maxMs },
            mode: state.mode,
            modeLabel: (MODES[state.mode] || MODES.transfer).label,
            buyEth: state.buyEth,
            jitterBuy: state.jitterBuy,
            walletIndex: state.walletIndex,
            walletHasKey: hasKey,
            wallet: w
                ? {
                      index: found.index,
                      name: w.name || "TX Bot",
                      address: w.address,
                      role: w.role,
                      hasKey,
                  }
                : null,
            startedAt: state.startedAt,
            lastTxAt: state.lastTxAt,
            nextAt: state.nextAt,
            stats: {
                ...state.stats,
                totalEth: Number(state.stats.ethSpent || 0) + Number(state.stats.gasEth || 0),
                avgEthPerTx: state.stats.ok > 0
                    ? (Number(state.stats.ethSpent || 0) + Number(state.stats.gasEth || 0)) / state.stats.ok
                    : null,
                avgUsdPerTx: state.stats.ok > 0 && state.stats.spentUsd != null
                    ? Number(state.stats.spentUsd) / state.stats.ok
                    : null,
            },
            ethUsd: state.stats.ethUsd,
            spentUsd: state.stats.spentUsd,
            logs: state.logs.slice(0, 40),
            presets: {
                speeds: Object.fromEntries(
                    Object.entries(SPEEDS).map(([k, v]) => [
                        k,
                        { label: v.label, minMs: v.minMs, maxMs: v.maxMs },
                    ])
                ),
                buyEthDefault: DEFAULT_BUY_ETH,
                buyEthMin: MIN_BUY_ETH,
                buyEthMax: MAX_BUY_ETH,
                modes: MODES,
            },
        };
    }

    function pickBuyAmount() {
        const base = Number(clampBuyEth(state.buyEth));
        if (!state.jitterBuy) return clampBuyEth(base);
        // ±40% jitter so sizes aren't identical
        const factor = 0.6 + Math.random() * 0.8;
        return clampBuyEth(base * factor);
    }


    function pickAction() {
        const mode = state.mode || "transfer";
        if (mode === "buy") return "buy";
        if (mode === "transfer") return "transfer";
        // mix: 1 buy every 10 actions
        state._mixCounter = (state._mixCounter || 0) + 1;
        return state._mixCounter % 10 === 1 ? "buy" : "transfer";
    }

    async function ensureFeeCache() {
        const now = Date.now();
        if (!state._feeCache || now - state._feeCache.at > 12_000) {
            const feeData = await chain.provider.getFeeData();
            let tip = feeData.maxPriorityFeePerGas ?? 0n;
            if (tip < 0n) tip = 0n;
            let maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("0.05", "gwei");
            const gp = feeData.gasPrice ?? maxFee;
            if (tip === 0n && gp > 0n && maxFee > (gp * 130n) / 100n) {
                maxFee = (gp * 130n) / 100n;
            }
            if (maxFee < tip) maxFee = tip > 0n ? tip : gp;
            state._feeCache = { at: now, tip, maxFee, gasPrice: gp };
        }
        return state._feeCache;
    }

    async function resolveWallet() {
        const store = state.getStore();
        if (!store) throw new Error("No store");
        const found = findTxBotWallet(store);
        if (!found.wallet) {
            throw new Error("No TX bot wallet with a private key — Create wallet, then Fund");
        }
        state.walletIndex = found.index;
        const w = found.wallet;
        const pk = walletPrivateKey(w);
        if (!pk || !chain.isEvmPrivateKey(pk)) {
            throw new Error("TX bot wallet has no usable private key");
        }
        if (!w.private_key) w.private_key = pk.startsWith("0x") ? pk : `0x${pk}`;
        return w;
    }

    async function nextNonce(address) {
        if (state._nonce == null || state._nonceAddr !== address.toLowerCase()) {
            state._nonce = await chain.provider.getTransactionCount(address, "pending");
            state._nonceAddr = address.toLowerCase();
        }
        const nonce = state._nonce;
        state._nonce = nonce + 1;
        return nonce;
    }

    async function cheapTransferOnce() {
        const w = await resolveWallet();
        const token = state.token;
        if (!chain.isEvmAddress(token)) throw new Error("Invalid token");

        const { tip, maxFee, gasPrice } = await ensureFeeCache();
        let gasReserve = TRANSFER_GAS_LIMIT * maxFee;
        const minReserve = ethers.parseEther("0.000004");
        const maxReserve = ethers.parseEther("0.00002");
        if (gasReserve < minReserve) gasReserve = minReserve;
        if (gasReserve > maxReserve) gasReserve = maxReserve;

        const balNow = Date.now();
        if (!state._balCache || state._balCache.addr !== w.address.toLowerCase() || balNow - state._balCache.at > 5_000) {
            const balStr = await chain.getWalletBalance(w.address);
            state._balCache = { at: balNow, addr: w.address.toLowerCase(), bal: String(balStr || "0") };
        }
        const balWei = ethers.parseEther(String(state._balCache.bal || "0"));
        if (balWei < gasReserve) {
            state.stats.skipped++;
            state.stats.lastError = `Low ETH (${state._balCache.bal}) — fund TX bot wallet`;
            if (!state._lowBalLogAt || Date.now() - state._lowBalLogAt > 8_000) {
                state._lowBalLogAt = Date.now();
                pushLog(`⏭ low ETH ${Number(state._balCache.bal).toFixed(6)} for transfer gas — Fund wallet`, "warn");
            }
            return { skipped: true, reason: "low_balance" };
        }
        state._lowBalLogAt = null;

        // Need at least 1 wei of token — if empty, do a dust buy once to seed
        const tokenBal = await chain.provider.call({
            to: token,
            data: ERC20_IFACE.encodeFunctionData("balanceOf", [w.address]),
        });
        const tokWei = BigInt(tokenBal === "0x" ? "0" : tokenBal);
        if (tokWei <= 0n) {
            pushLog("🪙 no token yet — dust buy to seed transfers", "info");
            return await cheapBuyOnce();
        }

        // Transfer 1 wei to self — still emits Transfer, pads token tx count ~4× cheaper
        const amount = tokWei > 1n ? 1n : tokWei;
        const data = ERC20_IFACE.encodeFunctionData("transfer", [w.address, amount]);
        const nonce = await nextNonce(w.address);
        const wallet = new ethers.Wallet(w.private_key, chain.provider);
        let sent;
        try {
            sent = await wallet.sendTransaction({
                to: token,
                data,
                value: 0n,
                chainId: chain.CHAIN_ID || 20242,
                gasLimit: TRANSFER_GAS_LIMIT,
                nonce,
                maxFeePerGas: maxFee,
                maxPriorityFeePerGas: tip,
            });
        } catch (e) {
            state._nonce = null;
            throw e;
        }

        state.stats.ok++;
        state.stats.lastHash = sent.hash;
        state.stats.lastError = null;
        state.lastTxAt = new Date().toISOString();
        if (state._balCache) {
            try {
                const estGas = 35000n * maxFee;
                const left = ethers.parseEther(state._balCache.bal) - estGas;
                state._balCache.bal = ethers.formatEther(left > 0n ? left : 0n);
            } catch (_) {}
        }
        recomputeSpend();
        trackGasAsync(sent.hash, tip);
        pushLog(`✅ xfer dust · ${sent.hash.slice(0, 10)}…`, "ok");
        state.onBroadcast({
            type: "txbot_tx",
            hash: sent.hash,
            kind: "transfer",
            status: publicStatus(),
        });
        return { hash: sent.hash, kind: "transfer" };
    }

    async function cheapActionOnce() {
        const action = pickAction();
        if (action === "transfer") return cheapTransferOnce();
        return cheapBuyOnce();
    }

    async function cheapBuyOnce() {
        const store = state.getStore();
        if (!store) throw new Error("No store");
        const found = findTxBotWallet(store);
        if (!found.wallet) {
            throw new Error("No TX bot wallet with a private key — Create wallet (or Import PK), then Fund");
        }
        state.walletIndex = found.index;
        const w = found.wallet;
        const pk = walletPrivateKey(w);
        if (!pk || !chain.isEvmPrivateKey(pk)) {
            throw new Error("TX bot wallet has no usable private key — Create a new TX Bot wallet");
        }
        // Normalize field so future reads work
        if (!w.private_key) w.private_key = pk.startsWith("0x") ? pk : `0x${pk}`;

        const token = state.token;
        if (!chain.isEvmAddress(token)) throw new Error("Invalid token");

        const amount = pickBuyAmount();

        // Cache fee data ~12s — use absolute floor tips (network tip is often 0)
        const now = Date.now();
        if (!state._feeCache || now - state._feeCache.at > 12_000) {
            const feeData = await chain.provider.getFeeData();
            // Tip 0 when network says 0 — every wei of tip is pure waste on RH
            let tip = feeData.maxPriorityFeePerGas ?? 0n;
            if (tip < 0n) tip = 0n;
            // Cap maxFee to ~1.15× suggested (or gasPrice×2) — don't overpay spikes
            let maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("0.05", "gwei");
            const gp = feeData.gasPrice ?? maxFee;
            const cap = (gp * 115n) / 100n;
            if (maxFee > cap * 2n) maxFee = cap * 2n; // still allow some headroom
            // Prefer paying near gasPrice when tip is 0
            if (tip === 0n && gp > 0n && maxFee > (gp * 130n) / 100n) {
                maxFee = (gp * 130n) / 100n;
            }
            if (maxFee < tip) maxFee = tip > 0n ? tip : gp;
            state._feeCache = { at: now, tip, maxFee, gasPrice: gp };
        }
        const { tip, maxFee, gasPrice } = state._feeCache;

        // Tight reserve from live fees
        let gasReserve = CHEAP_GAS_LIMIT * maxFee;
        const minReserve = ethers.parseEther("0.000008");
        const maxReserve = ethers.parseEther("0.00004");
        if (gasReserve < minReserve) gasReserve = minReserve;
        if (gasReserve > maxReserve) gasReserve = maxReserve;

        // Fresh balance when low / every 3s
        const balNow = Date.now();
        const forceBal = !state._balCache || state._balCache.addr !== w.address.toLowerCase()
            || balNow - state._balCache.at > 3_000
            || (state._balCache && ethers.parseEther(String(state._balCache.bal || "0")) < gasReserve * 2n);
        if (forceBal) {
            const balStr = await chain.getWalletBalance(w.address);
            state._balCache = { at: balNow, addr: w.address.toLowerCase(), bal: String(balStr || "0") };
        }
        const bal = state._balCache.bal;
        const balWei = ethers.parseEther(String(bal || "0"));
        const amountWei = ethers.parseEther(amount);
        if (balWei < amountWei + gasReserve) {
            state.stats.skipped++;
            state.stats.lastError = `Low ETH (${bal}) — fund TX bot wallet`;
            // Don't spam: only log every ~8s when stuck low
            if (!state._lowBalLogAt || Date.now() - state._lowBalLogAt > 8_000) {
                state._lowBalLogAt = Date.now();
                pushLog(
                    `⏭ low balance ${Number(bal).toFixed(6)} ETH (need ~${ethers.formatEther(amountWei + gasReserve)} incl gas) — Fund wallet`,
                    "warn"
                );
            }
            return { skipped: true, reason: "low_balance", balance: bal };
        }
        state._lowBalLogAt = null;

        // Local nonce — fire next buy without waiting for confirmation
        if (state._nonce == null || state._nonceAddr !== w.address.toLowerCase()) {
            state._nonce = await chain.provider.getTransactionCount(w.address, "pending");
            state._nonceAddr = w.address.toLowerCase();
        }
        const nonce = state._nonce;
        state._nonce = nonce + 1;

        // Cache token meta so we don't re-hit API every micro-buy
        if (!state._tokenCache || state._tokenCache.addr !== token.toLowerCase() || now - state._tokenCache.at > 120_000) {
            try {
                const info = await chain.getTokenInfo(token);
                state._tokenCache = { at: now, addr: token.toLowerCase(), info };
            } catch (_) {
                state._tokenCache = { at: now, addr: token.toLowerCase(), info: null };
            }
        }

        const tx = await chain.buy(
            { private_key: w.private_key, address: w.address },
            amount,
            token,
            {
                skipQuote: true,
                skipMulticall: true, // cheaper calldata path
                clamp: true,
                gasLimit: CHEAP_GAS_LIMIT,
                priorityMultiplier: 1,
                nonce,
                balance: balWei,
                tokenInfo: state._tokenCache?.info || undefined,
                feeData: {
                    maxFeePerGas: maxFee,
                    maxPriorityFeePerGas: tip,
                    gasPrice,
                },
                gasCost: gasReserve + ethers.parseEther("0.000002"),
            }
        );

        if (tx?.error) {
            state.stats.fail++;
            state.stats.lastError = tx.error;
            state._nonce = null;
            pushLog(`❌ buy failed: ${tx.error}`, "err");
            return { error: tx.error };
        }

        state.stats.ok++;
        state.stats.ethSpent += Number(amount);
        if (state._balCache) {
            try {
                // Rough local debit: buy + typical gas (~122k * maxFee) until receipt corrects
                const estGas = 130000n * maxFee;
                const left = ethers.parseEther(state._balCache.bal) - ethers.parseEther(amount) - estGas;
                state._balCache.bal = ethers.formatEther(left > 0n ? left : 0n);
            } catch (_) {}
        }
        state.stats.lastHash = tx.hash;
        state.stats.lastError = null;
        state.lastTxAt = new Date().toISOString();
        recomputeSpend();
        trackGasAsync(tx.hash, tip);
        pushLog(
            `✅ micro-buy ${amount} ETH · ${tx.hash.slice(0, 10)}…`,
            "ok"
        );
        state.onBroadcast({
            type: "txbot_tx",
            hash: tx.hash,
            amount,
            status: publicStatus(),
        });
        return { hash: tx.hash, amount };
    }

    async function loop(loopId) {
        while (state.running && state._loopId === loopId && !state.stopping) {
            try {
                await cheapActionOnce();
            } catch (e) {
                state.stats.fail++;
                state.stats.lastError = e.shortMessage || e.message;
                state._nonce = null;
                pushLog(`❌ ${state.stats.lastError}`, "err");
            }

            if (!state.running || state._loopId !== loopId || state.stopping) break;

            const spd = SPEEDS[state.speed] || SPEEDS.medium;
            const wait = randBetween(spd.minMs, spd.maxMs);
            state.nextAt = new Date(Date.now() + wait).toISOString();
            state.onBroadcast({ type: "txbot_status", status: publicStatus() });
            await new Promise((r) => {
                state._wake = r;
                state._timer = setTimeout(() => {
                    state._wake = null;
                    r();
                }, wait);
            });
            state._timer = null;
            state._wake = null;
        }
        state.running = false;
        state.stopping = false;
        state.nextAt = null;
        pushLog("TX booster stopped", "info");
        state.onBroadcast({ type: "txbot_status", status: publicStatus() });
    }

    function start(cfg = {}) {
        if (state.running) return { ok: false, error: "Already running" };
        if (typeof state.isPeerRunning === "function" && state.isPeerRunning()) {
            return {
                ok: false,
                error: "Stop Volume booster first — only one loop at a time on this wallet",
            };
        }
        const token = String(cfg.token || state.token || "").trim();
        if (!chain.isEvmAddress(token)) {
            return { ok: false, error: "Set a valid token address" };
        }
        const speed = String(cfg.speed || state.speed || "medium").toLowerCase();
        if (!SPEEDS[speed]) return { ok: false, error: "Speed must be slow|medium|high|blaze" };
        const mode = String(cfg.mode || state.mode || "transfer").toLowerCase();
        if (!MODES[mode]) return { ok: false, error: "Mode must be buy|transfer|mix" };

        state.token = token;
        state.speed = speed;
        state.mode = mode;
        state._mixCounter = 0;
        state.buyEth = clampBuyEth(cfg.buyEth ?? state.buyEth);
        state.jitterBuy = cfg.jitterBuy !== false;
        if (cfg.walletIndex != null) state.walletIndex = Number(cfg.walletIndex);

        const store = state.getStore();
        if (!store) return { ok: false, error: "No store" };
        const found = findTxBotWallet(store);
        if (!found.wallet) {
            return {
                ok: false,
                error: "No TX bot wallet with a private key. Click Create wallet (do not reuse Sniper), then Fund.",
            };
        }
        state.walletIndex = found.index;
        store.txBot = {
            ...(store.txBot || {}),
            token: state.token,
            speed: state.speed,
            mode: state.mode,
            buyEth: state.buyEth,
            jitterBuy: state.jitterBuy,
            walletIndex: state.walletIndex,
        };
        state.saveStore(store);

        state.running = true;
        state.stopping = false;
        state.startedAt = new Date().toISOString();
        state._feeCache = null;
        state._nonce = null;
        state._nonceAddr = null;
        state._balCache = null;
        state._tokenCache = null;
        // Session spend counters
        state.stats.ok = 0;
        state.stats.fail = 0;
        state.stats.skipped = 0;
        state.stats.ethSpent = 0;
        state.stats.gasEth = 0;
        state.stats.totalEth = 0;
        state.stats.spentUsd = null;
        state.stats.lastError = null;
        state.stats.lastHash = null;
        state._loopId++;
        const id = state._loopId;
        void refreshEthUsd();
        pushLog(
            `▶ TX booster · ${SPEEDS[speed].label} · ${MODES[mode].label} · ${token.slice(0, 10)}…`,
            "ok"
        );
        setImmediate(() => loop(id));
        state.onBroadcast({ type: "txbot_status", status: publicStatus() });
        return { ok: true, status: publicStatus() };
    }

    function stop() {
        if (!state.running) return { ok: true, status: publicStatus() };
        state.stopping = true;
        state.running = false;
        if (state._timer) {
            clearTimeout(state._timer);
            state._timer = null;
        }
        state._wake = null;
        state._loopId++;
        pushLog("Stopping…", "info");
        state.onBroadcast({ type: "txbot_status", status: publicStatus() });
        return { ok: true, status: publicStatus() };
    }

    function configure(cfg = {}) {
        const prevSpeed = state.speed;
        const prevBuy = state.buyEth;
        let changed = false;
        if (cfg.token != null) {
            const tok = String(cfg.token).trim();
            if (tok && tok !== state.token) {
                state.token = tok;
                changed = true;
            }
        }
        if (cfg.speed != null && SPEEDS[String(cfg.speed).toLowerCase()]) {
            const sp = String(cfg.speed).toLowerCase();
            if (sp !== state.speed) {
                state.speed = sp;
                changed = true;
            }
        }
        if (cfg.mode != null && MODES[String(cfg.mode).toLowerCase()]) {
            const md = String(cfg.mode).toLowerCase();
            if (md !== state.mode) {
                state.mode = md;
                changed = true;
            }
        }
        if (cfg.buyEth != null) {
            const b = clampBuyEth(cfg.buyEth);
            if (b !== state.buyEth) {
                state.buyEth = b;
                changed = true;
            }
        }
        if (cfg.jitterBuy != null) {
            const j = Boolean(cfg.jitterBuy);
            if (j !== state.jitterBuy) {
                state.jitterBuy = j;
                changed = true;
            }
        }
        if (cfg.walletIndex != null) state.walletIndex = Number(cfg.walletIndex);
        const store = state.getStore();
        if (store) {
            store.txBot = {
                ...(store.txBot || {}),
                token: state.token,
                speed: state.speed,
                mode: state.mode,
                buyEth: state.buyEth,
                jitterBuy: state.jitterBuy,
                walletIndex: state.walletIndex,
            };
            state.saveStore(store);
        }
        if (changed && state.running) {
            const bits = [];
            if (state.speed !== prevSpeed) bits.push(`speed ${SPEEDS[state.speed].label}`);
            if (state.buyEth !== prevBuy) bits.push(`size ${state.buyEth} ETH`);
            if (cfg.mode != null) bits.push(`mode ${(MODES[state.mode]||{}).label||state.mode}`);
            pushLog(`⚡ live adjust · ${bits.join(" · ") || "updated"}`, "info");
            // Cut current wait so new interval applies on next tick
            wakeLoop();
        }
        state.onBroadcast({ type: "txbot_status", status: publicStatus() });
        return publicStatus();
    }

    function hydrateFromStore() {
        const store = state.getStore();
        const cfg = store?.txBot || {};
        if (cfg.token) state.token = cfg.token;
        if (cfg.speed && SPEEDS[cfg.speed]) state.speed = cfg.speed;
        if (cfg.mode && MODES[cfg.mode]) state.mode = cfg.mode;
        if (cfg.buyEth) state.buyEth = clampBuyEth(cfg.buyEth);
        if (cfg.jitterBuy != null) state.jitterBuy = Boolean(cfg.jitterBuy);
        if (cfg.walletIndex != null) state.walletIndex = Number(cfg.walletIndex);
        else {
            const i = (store?.wallets || []).findIndex((w) => w.role === "txbot");
            if (i >= 0) state.walletIndex = i;
        }
    }

    function status() {
        if (!state.stats.ethUsd) void refreshEthUsd().then(() => {
            state.onBroadcast({ type: "txbot_status", status: publicStatus() });
        });
        else recomputeSpend();
        return publicStatus();
    }

    return {
        start,
        stop,
        configure,
        status,
        hydrateFromStore,
        isRunning: () => !!state.running,
        SPEEDS,
    };
}

module.exports = {
    createBooster,
    SPEEDS,
    MODES,
    DEFAULT_BUY_ETH,
    MIN_BUY_ETH,
    MAX_BUY_ETH,
};
