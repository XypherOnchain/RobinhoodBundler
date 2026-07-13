/**
 * Trend booster — multi-wallet buy↔sell for DexScreener makers + volume + txs.
 * Separate from single-wallet volume rebate and TX count padder.
 *
 * Cost reality (NOXA 1% pool, no self-LP rebate):
 *   round-trip loss ≈ 2% of notional + gas (~$0.02–0.04)
 *   Prefer many small wallets over one whale for unique makers.
 */
const { ethers } = require("ethers");
const chain = require("./blockchain");

const SPEEDS = {
    slow: { label: "Slow", minMs: 45_000, maxMs: 90_000 },
    medium: { label: "Medium", minMs: 18_000, maxMs: 40_000 },
    high: { label: "High", minMs: 8_000, maxMs: 18_000 },
};

const DEFAULT_USD = 8;
const MIN_USD = 1;
const MAX_USD = 80;
const BUY_GAS_LIMIT = 220000n;
const SELL_GAS_LIMIT = 280000n;
const LOG_CAP = 120;
const DEFAULT_MAX_LOSS_USD = 0.35; // per cycle circuit breaker (2% of ~$15 + gas)

function randBetween(a, b) {
    return a + Math.floor(Math.random() * Math.max(1, b - a + 1));
}

function walletPrivateKey(w) {
    if (!w) return null;
    const pk = w.private_key || w.privateKey || null;
    return pk ? String(pk) : null;
}

function isUsableWallet(w) {
    const pk = walletPrivateKey(w);
    return !!(pk && chain.isEvmPrivateKey(pk) && chain.isEvmAddress(w.address));
}

/** Buyer / trend wallets with keys — never funder/sniper/txbot unless opted in. */
function listTrendWallets(store) {
    const out = [];
    for (let i = 0; i < (store?.wallets || []).length; i++) {
        const w = store.wallets[i];
        if (!isUsableWallet(w)) continue;
        const role = String(w.role || "buyer").toLowerCase();
        if (role === "funder" || role === "sniper" || role === "distributor") continue;
        if (role === "txbot" && !store?.trendBot?.includeTxBot) continue;
        if (role === "buyer" || role === "trend" || role === "txbot") {
            out.push({ index: i, wallet: w });
        }
    }
    return out;
}

function createTrendBooster(options = {}) {
    const state = {
        running: false,
        stopping: false,
        token: "",
        speed: "medium",
        targetUsd: DEFAULT_USD,
        jitterPct: 35,
        maxLossUsd: DEFAULT_MAX_LOSS_USD,
        walletIndices: null, // null = all eligible
        rr: 0,
        startedAt: null,
        lastTxAt: null,
        nextAt: null,
        stats: {
            cycles: 0,
            okBuys: 0,
            okSells: 0,
            fail: 0,
            skipped: 0,
            volumeEth: 0,
            volumeUsd: 0,
            gasEth: 0,
            roundtripLossEth: 0,
            makers: {},
            makerCount: 0,
            ethUsd: null,
            lastError: null,
            lastBuyHash: null,
            lastSellHash: null,
            lastCycleLossUsd: null,
        },
        logs: [],
        _timer: null,
        _loopId: 0,
        _feeCache: null,
        onBroadcast: options.onBroadcast || (() => {}),
        getStore: options.getStore || (() => null),
        saveStore: options.saveStore || (() => {}),
        isPeerRunning: options.isPeerRunning || (() => false),
    };

    function pushLog(text, kind = "info") {
        const entry = { at: new Date().toISOString(), text, kind };
        state.logs.unshift(entry);
        if (state.logs.length > LOG_CAP) state.logs.length = LOG_CAP;
        state.onBroadcast({ type: "trend_log", entry, status: publicStatus() });
    }

    function estimateCycleLossUsd(usd) {
        const n = Number(usd) || DEFAULT_USD;
        // 1% each way + gas
        return Math.round((n * 0.02 + 0.03) * 1000) / 1000;
    }

    function publicStatus() {
        const store = state.getStore();
        const pool = listTrendWallets(store);
        const spd = SPEEDS[state.speed] || SPEEDS.medium;
        const lossUsd =
            state.stats.ethUsd && state.stats.roundtripLossEth
                ? Number(state.stats.roundtripLossEth) * Number(state.stats.ethUsd)
                : null;
        return {
            running: state.running,
            stopping: state.stopping,
            feature: "trend",
            token: state.token,
            speed: state.speed,
            speedLabel: spd.label,
            targetUsd: state.targetUsd,
            jitterPct: state.jitterPct,
            maxLossUsd: state.maxLossUsd,
            estLossUsd: estimateCycleLossUsd(state.targetUsd),
            walletCount: pool.length,
            makerCount: state.stats.makerCount,
            stats: { ...state.stats, lossUsd },
            logs: state.logs.slice(0, 40),
            startedAt: state.startedAt,
            lastTxAt: state.lastTxAt,
            nextAt: state.nextAt,
        };
    }

    function persist() {
        const store = state.getStore();
        if (!store) return;
        store.trendBot = {
            ...(store.trendBot || {}),
            token: state.token,
            speed: state.speed,
            targetUsd: state.targetUsd,
            jitterPct: state.jitterPct,
            maxLossUsd: state.maxLossUsd,
            walletIndices: state.walletIndices,
        };
        state.saveStore(store);
    }

    function hydrateFromStore() {
        const store = state.getStore();
        const tb = store?.trendBot || {};
        if (tb.token) state.token = String(tb.token);
        if (tb.speed && SPEEDS[tb.speed]) state.speed = tb.speed;
        if (tb.targetUsd != null) {
            state.targetUsd = Math.min(
                MAX_USD,
                Math.max(MIN_USD, Number(tb.targetUsd) || DEFAULT_USD)
            );
        }
        if (tb.jitterPct != null) {
            state.jitterPct = Math.min(80, Math.max(0, Number(tb.jitterPct) || 0));
        }
        if (tb.maxLossUsd != null) {
            state.maxLossUsd = Math.max(0.05, Number(tb.maxLossUsd) || DEFAULT_MAX_LOSS_USD);
        }
        if (Array.isArray(tb.walletIndices)) state.walletIndices = tb.walletIndices;
    }

    function configure(cfg = {}) {
        if (cfg.token != null) {
            const t = String(cfg.token).trim();
            if (t && !chain.isEvmAddress(t)) throw new Error("Invalid token");
            if (t) state.token = t;
        }
        if (cfg.speed != null) {
            const s = String(cfg.speed).toLowerCase();
            if (!SPEEDS[s]) throw new Error("Speed must be slow|medium|high");
            state.speed = s;
        }
        if (cfg.targetUsd != null) {
            state.targetUsd = Math.min(
                MAX_USD,
                Math.max(MIN_USD, Number(cfg.targetUsd) || DEFAULT_USD)
            );
        }
        if (cfg.jitterPct != null) {
            state.jitterPct = Math.min(80, Math.max(0, Number(cfg.jitterPct) || 0));
        }
        if (cfg.maxLossUsd != null) {
            state.maxLossUsd = Math.max(0.05, Number(cfg.maxLossUsd) || DEFAULT_MAX_LOSS_USD);
        }
        if (cfg.walletIndices != null) {
            state.walletIndices = Array.isArray(cfg.walletIndices)
                ? cfg.walletIndices.map(Number)
                : null;
        }
        persist();
        return publicStatus();
    }

    async function refreshEthUsd() {
        try {
            const px = await chain.getEthUsdPrice();
            if (px > 0) state.stats.ethUsd = px;
        } catch (_) {}
        return Number(state.stats.ethUsd || 0);
    }

    async function ensureFeeCache(force = false) {
        const now = Date.now();
        if (!force && state._feeCache && now - state._feeCache.at < 10_000) {
            return state._feeCache;
        }
        const feeData = await chain.provider.getFeeData();
        let maxFee =
            feeData.maxFeePerGas ??
            feeData.gasPrice ??
            ethers.parseUnits("0.05", "gwei");
        const gp = feeData.gasPrice ?? maxFee;
        if (gp > 0n) {
            const cap = (gp * 110n) / 100n;
            if (maxFee > cap) maxFee = cap;
        }
        state._feeCache = { at: now, tip: 0n, maxFee, gasPrice: gp };
        return state._feeCache;
    }

    function pickPool() {
        const store = state.getStore();
        let pool = listTrendWallets(store);
        if (Array.isArray(state.walletIndices) && state.walletIndices.length) {
            const allow = new Set(state.walletIndices.map(Number));
            pool = pool.filter((p) => allow.has(p.index));
        }
        return pool;
    }

    function nextWallet(pool) {
        if (!pool.length) return null;
        const i = state.rr % pool.length;
        state.rr++;
        return pool[i];
    }

    function pickBuyEth(ethUsd) {
        const usd = Number(state.targetUsd) || DEFAULT_USD;
        const jitter = Number(state.jitterPct) || 0;
        const factor =
            jitter > 0 ? 1 + ((Math.random() * 2 - 1) * jitter) / 100 : 1;
        const target = Math.max(MIN_USD, Math.min(MAX_USD, usd * factor));
        const px = ethUsd > 0 ? ethUsd : 1770;
        const eth = target / px;
        return Math.max(0.0003, Math.round(eth * 1e8) / 1e8);
    }

    async function waitReceipt(hash, timeoutMs = 90_000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const r = await chain.provider.getTransactionReceipt(hash);
                if (r && r.status != null) return r;
            } catch (_) {}
            await chain.sleep(1200);
        }
        return null;
    }

    async function trackGas(hash) {
        if (!hash) return 0;
        try {
            const receipt = await chain.provider.getTransactionReceipt(hash);
            if (receipt && receipt.status != null) {
                const used = BigInt(receipt.gasUsed || 0);
                const price = BigInt(
                    receipt.effectiveGasPrice || receipt.gasPrice || 0
                );
                const eth = Number(ethers.formatEther(used * price));
                state.stats.gasEth = Number(state.stats.gasEth || 0) + eth;
                return eth;
            }
        } catch (_) {}
        return 0;
    }

    function noteMaker(addr) {
        const a = String(addr || "").toLowerCase();
        if (!a) return;
        if (!state.stats.makers[a]) {
            state.stats.makers[a] = 0;
            state.stats.makerCount = Object.keys(state.stats.makers).length;
        }
        state.stats.makers[a]++;
    }

    async function cycleOnce() {
        const pool = pickPool();
        const picked = nextWallet(pool);
        if (!picked) {
            state.stats.skipped++;
            pushLog("⏭ no trend wallets — import buyers first", "warn");
            return { skipped: true };
        }
        const w = picked.wallet;
        const pk = walletPrivateKey(w);
        if (!pk) {
            state.stats.skipped++;
            return { skipped: true };
        }
        const token = state.token;
        if (!chain.isEvmAddress(token)) throw new Error("Invalid token");

        const ethUsd = await refreshEthUsd();
        const buyEth = pickBuyEth(ethUsd);
        const { tip, maxFee, gasPrice } = await ensureFeeCache();
        const reserve =
            BUY_GAS_LIMIT * maxFee + SELL_GAS_LIMIT * maxFee + ethers.parseEther("0.0002");
        const balStr = await chain.getWalletBalance(w.address);
        const balWei = ethers.parseEther(String(balStr || "0"));
        const buyWei = ethers.parseEther(String(buyEth));
        if (balWei < buyWei + reserve) {
            state.stats.skipped++;
            pushLog(
                `⏭ ${w.name || shortAddr(w.address)} low ETH ${Number(balStr).toFixed(5)} — skip`,
                "warn"
            );
            return { skipped: true };
        }

        const feeData = {
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: tip,
            gasPrice,
        };
        const ethBefore = Number(balStr);
        const buyUsdEst = buyEth * (ethUsd || 0) || state.targetUsd;
        const label = w.name || shortAddr(w.address);
        pushLog(
            `📈 ${label} BUY ~$${Number(buyUsdEst).toFixed(2)} (${buyEth} ETH) · est loss ~$${estimateCycleLossUsd(buyUsdEst).toFixed(3)}`,
            "info"
        );

        const buyTx = await chain.buy(
            { private_key: pk, address: w.address },
            buyEth,
            token,
            {
                skipQuote: true,
                skipMulticall: true,
                clamp: false,
                gasLimit: BUY_GAS_LIMIT,
                priorityMultiplier: 1,
                useProvidedFees: true,
                feeData,
                gasCost: BUY_GAS_LIMIT * maxFee,
                reserveSellGas: false,
                preflight: true,
            }
        );
        if (buyTx?.error) {
            state.stats.fail++;
            state.stats.lastError = buyTx.error;
            pushLog(`❌ buy ${label}: ${buyTx.error}`, "err");
            return { error: buyTx.error };
        }

        state.stats.okBuys++;
        state.stats.lastBuyHash = buyTx.hash;
        state.stats.volumeEth = Number(state.stats.volumeEth || 0) + buyEth;
        if (ethUsd > 0) {
            state.stats.volumeUsd =
                Number(state.stats.volumeUsd || 0) + buyEth * ethUsd;
        }
        noteMaker(w.address);
        pushLog(`✅ buy ${label} · ${buyTx.hash.slice(0, 12)}…`, "ok");
        state.onBroadcast({
            type: "trend_tx",
            kind: "buy",
            hash: buyTx.hash,
            wallet: w.address,
            status: publicStatus(),
        });

        const buyReceipt = await waitReceipt(buyTx.hash);
        if (!buyReceipt || buyReceipt.status !== 1) {
            state.stats.fail++;
            pushLog(
                `❌ buy ${!buyReceipt ? "timeout" : "reverted"} — skip sell · ${label}`,
                "err"
            );
            return { error: "buy_failed" };
        }
        await trackGas(buyTx.hash);
        await chain.sleep(600);

        let tokBal = 0n;
        let decimals = 18;
        try {
            const raw = await chain.getTokenBalanceRaw(w.address, token);
            tokBal = raw.balance || 0n;
            decimals = Number(raw.decimals ?? 18);
        } catch (e) {
            state.stats.fail++;
            pushLog(`❌ token bal ${label}: ${e.message}`, "err");
            return { error: e.message };
        }
        if (!(tokBal > 0n)) {
            state.stats.fail++;
            pushLog(`❌ ${label} got 0 tokens after buy`, "err");
            return { error: "zero_tokens" };
        }

        // Sell ~99.5% — leave dust so wallet stays a "holder"
        const sellAmt = (tokBal * 995n) / 1000n;
        const amountHuman = ethers.formatUnits(sellAmt, decimals);
        const sellFees = await ensureFeeCache(true);
        pushLog(`📉 ${label} SELL ${Number(amountHuman).toFixed(0)} tokens`, "info");

        const sellTx = await chain.sell(
            { private_key: pk, address: w.address },
            amountHuman,
            token,
            {
                skipQuote: true,
                gasLimit: SELL_GAS_LIMIT,
                priorityMultiplier: 1,
                useProvidedFees: true,
                feeData: {
                    maxFeePerGas: sellFees.maxFee,
                    maxPriorityFeePerGas: sellFees.tip,
                    gasPrice: sellFees.gasPrice,
                },
                slippageBps: 1200,
            }
        );
        if (sellTx?.error) {
            state.stats.fail++;
            state.stats.lastError = sellTx.error;
            pushLog(`❌ sell ${label}: ${sellTx.error}`, "err");
            return { error: sellTx.error };
        }

        state.stats.okSells++;
        state.stats.lastSellHash = sellTx.hash;
        noteMaker(w.address);
        pushLog(`✅ sell ${label} · ${sellTx.hash.slice(0, 12)}…`, "ok");
        state.onBroadcast({
            type: "trend_tx",
            kind: "sell",
            hash: sellTx.hash,
            wallet: w.address,
            status: publicStatus(),
        });

        const sellReceipt = await waitReceipt(sellTx.hash);
        if (sellReceipt?.status === 1) await trackGas(sellTx.hash);

        let ethAfter = ethBefore;
        try {
            ethAfter = Number(await chain.getWalletBalance(w.address));
        } catch (_) {}
        const loss = Math.max(0, ethBefore - ethAfter);
        state.stats.roundtripLossEth =
            Number(state.stats.roundtripLossEth || 0) + loss;
        state.stats.lastCycleLossUsd = ethUsd > 0 ? loss * ethUsd : null;
        state.stats.cycles++;
        state.lastTxAt = new Date().toISOString();

        const lossStr =
            state.stats.lastCycleLossUsd != null
                ? `~$${state.stats.lastCycleLossUsd.toFixed(3)}`
                : `${loss.toFixed(6)} ETH`;
        pushLog(
            `🔁 cycle #${state.stats.cycles} · ${label} · ${lossStr} · makers ${state.stats.makerCount} · vol ~$${Number(state.stats.volumeUsd || 0).toFixed(0)}`,
            state.stats.lastCycleLossUsd != null &&
                state.stats.lastCycleLossUsd > state.maxLossUsd
                ? "warn"
                : "ok"
        );

        if (
            state.stats.lastCycleLossUsd != null &&
            state.stats.lastCycleLossUsd > Number(state.maxLossUsd || DEFAULT_MAX_LOSS_USD)
        ) {
            pushLog(
                `🛑 cycle loss $${state.stats.lastCycleLossUsd.toFixed(3)} > max $${Number(state.maxLossUsd).toFixed(3)} — pausing`,
                "err"
            );
            state.stopping = true;
            state.running = false;
            state.onBroadcast({ type: "trend_status", status: publicStatus() });
            return { ok: true, loss, paused: true };
        }

        state.onBroadcast({ type: "trend_status", status: publicStatus() });
        return { ok: true, loss };
    }

    async function loop(loopId) {
        while (state.running && state._loopId === loopId && !state.stopping) {
            try {
                await cycleOnce();
            } catch (e) {
                state.stats.fail++;
                state.stats.lastError = e.shortMessage || e.message;
                pushLog(`❌ cycle: ${state.stats.lastError}`, "err");
            }
            if (!state.running || state.stopping || state._loopId !== loopId) break;
            const spd = SPEEDS[state.speed] || SPEEDS.medium;
            const wait = randBetween(spd.minMs, spd.maxMs);
            state.nextAt = new Date(Date.now() + wait).toISOString();
            state.onBroadcast({ type: "trend_status", status: publicStatus() });
            await chain.sleep(wait);
        }
        state.running = false;
        state.stopping = false;
        state.nextAt = null;
        pushLog("Trend booster stopped", "info");
        state.onBroadcast({ type: "trend_status", status: publicStatus() });
    }

    function start(cfg = {}) {
        if (state.running) return { ok: false, error: "Trend booster already running" };
        if (typeof state.isPeerRunning === "function" && state.isPeerRunning()) {
            return {
                ok: false,
                error: "Stop Volume / TX padder first — only one loop at a time",
            };
        }
        if (cfg && Object.keys(cfg).length) {
            try {
                configure(cfg);
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }
        const token = String(cfg.token || state.token || "").trim();
        if (!chain.isEvmAddress(token)) {
            return { ok: false, error: "Set a valid token address" };
        }
        const pool = pickPool();
        if (pool.length < 2) {
            return {
                ok: false,
                error: `Need ≥2 funded trend wallets (have ${pool.length}) — import buyers from bundler`,
            };
        }

        state.token = token;
        state.running = true;
        state.stopping = false;
        state.startedAt = new Date().toISOString();
        state.stats.lastError = null;
        persist();

        const loopId = ++state._loopId;
        pushLog(
            `Trend ON · ~$${state.targetUsd}/cycle · ${pool.length} wallets · est ~$${estimateCycleLossUsd(state.targetUsd).toFixed(3)}/cycle · ${state.speed}`,
            "ok"
        );
        state.onBroadcast({ type: "trend_status", status: publicStatus() });
        setImmediate(() => loop(loopId));
        return { ok: true, status: publicStatus() };
    }

    function stop() {
        if (!state.running && !state.stopping) {
            return { ok: true, status: publicStatus() };
        }
        state.stopping = true;
        state.running = false;
        if (state._timer) {
            clearTimeout(state._timer);
            state._timer = null;
        }
        return { ok: true, status: publicStatus() };
    }

    function isRunning() {
        return !!state.running;
    }

    return {
        start,
        stop,
        configure,
        status: publicStatus,
        isRunning,
        hydrateFromStore,
        listTrendWallets: () => listTrendWallets(state.getStore()),
        estimateCycleLossUsd,
    };
}

function shortAddr(a) {
    return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

module.exports = {
    createTrendBooster,
    listTrendWallets,
    SPEEDS,
};
