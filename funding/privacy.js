/**
 * Privacy funding: ChangeNOW (break source link) → Across (Base → Robinhood 4663).
 *
 * Pipeline (matches stealth-bundler T4 plan):
 *   1) ChangeNOW: dirty ETH (eth) → clean ETH on Base (ethbase) to PRIVACY_BRIDGE wallet
 *   2) Across Swap API: Base native ETH → Robinhood ETH, recipient = each helper (≠ depositor)
 *
 * Dry-run by default. Real Across sends require:
 *   PRIVACY_FUND_ARM=1  AND  PRIVACY_BRIDGE_PK=<Base-funded key>
 * ChangeNOW create requires CHANGENOW_API_KEY.
 */
const axios = require("axios");
const { ethers } = require("ethers");

const ACROSS_API = process.env.ACROSS_API_URL || "https://app.across.to/api";
const CHANGENOW_API = process.env.CHANGENOW_API_URL || "https://api.changenow.io";
const CHANGENOW_KEY = process.env.CHANGENOW_API_KEY || "";

const BASE_CHAIN_ID = 8453;
const RH_CHAIN_ID = 4663;
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_RPC =
    process.env.BASE_RPC_URL || "https://mainnet.base.org";
const RH_RPC =
    process.env.ROBINHOOD_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID);
const rhProvider = new ethers.JsonRpcProvider(RH_RPC, RH_CHAIN_ID);

function isEvmAddress(txt) {
    return typeof txt === "string" && /^0x[0-9a-fA-F]{40}$/.test(txt);
}

function isArmed() {
    return (
        process.env.PRIVACY_FUND_ARM === "1" ||
        process.env.PRIVACY_FUND_ARM === "true"
    );
}

function bridgeWallet() {
    const pk = process.env.PRIVACY_BRIDGE_PK || process.env.BASE_BRIDGE_PK;
    if (!pk) return null;
    try {
        return new ethers.Wallet(pk, baseProvider);
    } catch (_) {
        return null;
    }
}

async function acrossQuote({
    amountEth,
    depositor,
    recipient,
    originChainId = BASE_CHAIN_ID,
}) {
    const amountWei = ethers.parseEther(String(amountEth));
    const params = new URLSearchParams({
        tradeType: "exactInput",
        amount: amountWei.toString(),
        inputToken: ZERO,
        originChainId: String(originChainId),
        outputToken: ZERO,
        destinationChainId: String(RH_CHAIN_ID),
        depositor: ethers.getAddress(depositor),
        recipient: ethers.getAddress(recipient),
    });
    const { data } = await axios.get(`${ACROSS_API}/swap/approval?${params}`, {
        timeout: 30000,
    });
    if (!data?.swapTx?.to) {
        throw new Error(
            data?.message || data?.error || "Across quote failed — no swapTx"
        );
    }
    return {
        amountEth: Number(amountEth),
        amountWei: amountWei.toString(),
        expectedOutEth: Number(
            ethers.formatEther(BigInt(data.expectedOutputAmount || 0))
        ),
        minOutEth: Number(
            ethers.formatEther(BigInt(data.minOutputAmount || 0))
        ),
        expectedFillTime: data.expectedFillTime,
        fees: data.fees || null,
        swapTx: data.swapTx,
        approvalTxns: data.approvalTxns || [],
        checks: data.checks || null,
        quoteId: data.id || null,
        originChainId,
        destinationChainId: RH_CHAIN_ID,
    };
}

/**
 * Execute Across bridge from PRIVACY_BRIDGE_PK on Base → recipient on 4663.
 */
async function acrossBridge({ amountEth, recipient, dryRun = true }) {
    const wallet = bridgeWallet();
    if (!wallet) {
        throw new Error(
            "PRIVACY_BRIDGE_PK missing — set a Base-funded private key for Across deposits"
        );
    }
    const quote = await acrossQuote({
        amountEth,
        depositor: wallet.address,
        recipient,
    });
    const armed = isArmed() && dryRun === false;
    if (!armed) {
        return {
            dryRun: true,
            armed: false,
            depositor: wallet.address,
            recipient: ethers.getAddress(recipient),
            quote,
            note: "Dry-run only. Set PRIVACY_FUND_ARM=1 and dryRun:false to broadcast.",
        };
    }

    const bal = await baseProvider.getBalance(wallet.address);
    const need = BigInt(quote.swapTx.value || quote.amountWei);
    if (bal < need) {
        throw new Error(
            `Base bridge wallet underfunded: have ${ethers.formatEther(bal)} need ≥ ${ethers.formatEther(need)} ETH`
        );
    }

    // Native ETH path — approvalTxns usually empty
    for (const a of quote.approvalTxns || []) {
        const tx = await wallet.sendTransaction({
            to: a.to,
            data: a.data,
            value: a.value ? BigInt(a.value) : 0n,
            chainId: BASE_CHAIN_ID,
        });
        await tx.wait();
    }

    const tx = await wallet.sendTransaction({
        to: quote.swapTx.to,
        data: quote.swapTx.data || "0x",
        value: BigInt(quote.swapTx.value || 0),
        chainId: Number(quote.swapTx.chainId || BASE_CHAIN_ID),
        gasLimit: quote.swapTx.gas
            ? BigInt(quote.swapTx.gas)
            : undefined,
    });
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
        throw new Error(`Across bridge reverted: ${tx.hash}`);
    }
    return {
        dryRun: false,
        armed: true,
        depositor: wallet.address,
        recipient: ethers.getAddress(recipient),
        hash: tx.hash,
        quote,
        explorer: `https://basescan.org/tx/${tx.hash}`,
    };
}

async function changeNowEstimate(amountEth, from = "eth", to = "ethbase") {
    const { data } = await axios.get(
        `${CHANGENOW_API}/v1/exchange-amount/${amountEth}/${from}_${to}`,
        { timeout: 20000 }
    );
    return {
        from,
        to,
        amountIn: Number(amountEth),
        estimatedOut: Number(data.estimatedAmount || 0),
        speed: data.transactionSpeedForecast || null,
        warning: data.warningMessage || null,
    };
}

/**
 * Create ChangeNOW order: send `from` (default eth) → Base eth (`ethbase`) to bridge wallet.
 * Returns deposit address — you (or a CEX withdraw) send dirty ETH there.
 */
async function changeNowCreate({
    amountEth,
    toAddress,
    from = "eth",
    to = "ethbase",
    refundAddress = null,
}) {
    if (!CHANGENOW_KEY) {
        throw new Error(
            "CHANGENOW_API_KEY not set — add it to .env to create privacy swaps"
        );
    }
    if (!isEvmAddress(toAddress)) {
        throw new Error("Invalid ChangeNOW destination address");
    }
    const body = {
        from,
        to,
        amount: Number(amountEth),
        address: ethers.getAddress(toAddress),
        flow: "standard",
        type: "direct",
    };
    if (refundAddress && isEvmAddress(refundAddress)) {
        body.refundAddress = ethers.getAddress(refundAddress);
    }
    const { data } = await axios.post(`${CHANGENOW_API}/v1/transactions/${CHANGENOW_KEY}`, body, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
    });
    return {
        id: data.id,
        status: data.status,
        payinAddress: data.payinAddress,
        payinExtraId: data.payinExtraId || null,
        from,
        to,
        amountFrom: data.amountFrom || amountEth,
        amountTo: data.amountTo || null,
        payoutAddress: data.payoutAddress || toAddress,
        trackUrl: data.id
            ? `https://changenow.io/exchange/txs/${data.id}`
            : null,
    };
}

async function changeNowStatus(id) {
    if (!CHANGENOW_KEY) throw new Error("CHANGENOW_API_KEY not set");
    const { data } = await axios.get(
        `${CHANGENOW_API}/v1/transactions/${id}/${CHANGENOW_KEY}`,
        { timeout: 20000 }
    );
    return data;
}

/**
 * Preview privacy fund for a list of { address, amountEth } destinations on 4663.
 */
async function previewPrivacyFund(destinations = []) {
    const wallet = bridgeWallet();
    const depositor = wallet?.address || ZERO;
    const rows = [];
    let totalIn = 0;
    let totalOut = 0;
    for (const d of destinations) {
        const addr = d.address;
        const amountEth = Number(d.amountEth || d.buyAmountEth || 0);
        if (!isEvmAddress(addr) || !(amountEth > 0)) continue;
        totalIn += amountEth;
        try {
            const q = await acrossQuote({
                amountEth,
                depositor: depositor === ZERO ? addr : depositor,
                recipient: addr,
            });
            totalOut += q.expectedOutEth;
            rows.push({
                address: ethers.getAddress(addr),
                amountEth,
                expectedOutEth: q.expectedOutEth,
                minOutEth: q.minOutEth,
                fillSec: q.expectedFillTime,
                ok: true,
            });
        } catch (e) {
            rows.push({
                address: addr,
                amountEth,
                ok: false,
                error: e.message,
            });
        }
    }

    let cn = null;
    if (CHANGENOW_KEY && totalIn > 0) {
        try {
            cn = await changeNowEstimate(totalIn);
        } catch (e) {
            cn = { error: e.message };
        }
    }

    let baseBal = null;
    if (wallet) {
        try {
            baseBal = Number(
                ethers.formatEther(await baseProvider.getBalance(wallet.address))
            );
        } catch (_) {}
    }

    return {
        pipeline: "ChangeNOW(eth→ethbase) → Across(Base→Robinhood 4663)",
        armed: isArmed(),
        changeNowKey: Boolean(CHANGENOW_KEY),
        bridgeWallet: wallet?.address || null,
        bridgeBalanceEth: baseBal,
        changeNowEstimate: cn,
        totalInEth: totalIn,
        totalExpectedOutEth: totalOut,
        rows,
        note:
            "1) Optional: create ChangeNOW order to top up Base bridge wallet. 2) Across from Base → each helper on 4663 (recipient ≠ depositor).",
    };
}

/**
 * Execute Across legs for each destination. ChangeNOW create is separate (async deposit).
 */
async function executeAcrossLegs(destinations = [], options = {}) {
    const dryRun = options.dryRun !== false;
    const results = [];
    for (const d of destinations) {
        const addr = d.address;
        const amountEth = Number(d.amountEth || d.buyAmountEth || 0);
        if (!isEvmAddress(addr) || !(amountEth > 0)) continue;
        try {
            const r = await acrossBridge({
                amountEth,
                recipient: addr,
                dryRun,
            });
            results.push({ ok: true, ...r });
            if (options.onProgress) {
                await options.onProgress({
                    type: dryRun ? "quoted" : "bridged",
                    address: addr,
                    amountEth,
                    hash: r.hash || null,
                });
            }
            if (!dryRun && options.delayMs) {
                await new Promise((r) =>
                    setTimeout(r, Number(options.delayMs) || 0)
                );
            }
        } catch (e) {
            results.push({
                ok: false,
                address: addr,
                amountEth,
                error: e.message,
            });
            if (options.onProgress) {
                await options.onProgress({
                    type: "error",
                    address: addr,
                    error: e.message,
                });
            }
        }
    }
    return { dryRun, armed: isArmed() && !dryRun, results };
}

async function status() {
    const wallet = bridgeWallet();
    let baseBal = null;
    if (wallet) {
        try {
            baseBal = ethers.formatEther(
                await baseProvider.getBalance(wallet.address)
            );
        } catch (e) {
            baseBal = `err:${e.message}`;
        }
    }
    let acrossOk = false;
    try {
        const q = await acrossQuote({
            amountEth: 0.001,
            depositor: wallet?.address || "0x1111111111111111111111111111111111111111",
            recipient: "0x2222222222222222222222222222222222222222",
        });
        acrossOk = Boolean(q.swapTx?.to);
    } catch (_) {}

    return {
        ok: acrossOk,
        acrossOk,
        changeNowKey: Boolean(CHANGENOW_KEY),
        armed: isArmed(),
        bridgeWallet: wallet?.address || null,
        bridgeBalanceEth: baseBal,
        origin: "Base (8453)",
        destination: "Robinhood (4663)",
        pipeline: "ChangeNOW eth→ethbase → Across Base→4663",
    };
}

module.exports = {
    acrossQuote,
    acrossBridge,
    changeNowEstimate,
    changeNowCreate,
    changeNowStatus,
    previewPrivacyFund,
    executeAcrossLegs,
    status,
    bridgeWallet,
    isArmed,
    BASE_CHAIN_ID,
    RH_CHAIN_ID,
};
