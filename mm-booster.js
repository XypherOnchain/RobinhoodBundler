/**
 * Chart market-maker — inventory MM for painting zig-zag candles.
 * Sells existing bags into strength; buys dips with funder dry powder.
 * Not wash volume: uses real inventory + 1% fee per leg only.
 */
const { ethers } = require("ethers");
const chain = require("./blockchain");
const volumeLp = require("./volume-lp");

const SPEEDS = {
    slow: { label: "Slow", minMs: 25_000, maxMs: 55_000 },
    medium: { label: "Medium", minMs: 12_000, maxMs: 28_000 },
    high: { label: "High", minMs: 5_000, maxMs: 12_000 },
};

const BUY_GAS_LIMIT = 220000n;
const SELL_GAS_LIMIT = 280000n;
const MIN_BUY_ETH = 0.002;
/** Leave this much ETH in the wallet after a buy so gas still lands. */
const BUY_GAS_PAD_ETH = 0.0006;
const LOG_CAP = 300;
const DEFAULT_TOKEN = "0x8E0821112f5b63a5939eAeeBaF251eB7958081b6";
const WETH = chain.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/** Phase script matching the chart plan (tempered bands).
 *  Buy budgets below are the *reference* plan (~0.70 ETH total).
 *  They scale to `buyBudgetEth` (default 0.55) so smaller bankrolls work. */
const DEFAULT_PHASES = [
    { id: "pump1", action: "buy", targetUsd: 0.000074, ceilingUsd: 0.000075, floorUsd: 0.000048, budgetEth: 0.18, label: "Pump → 0.000074" },
    { id: "dump1", action: "sell", targetUsd: 0.00005, ceilingUsd: 0.000075, floorUsd: 0.000048, sellPctOfBag: 12, label: "Dip → 0.000050" },
    { id: "pump2", action: "buy", targetUsd: 0.000074, ceilingUsd: 0.000075, floorUsd: 0.000048, budgetEth: 0.25, label: "Pump → 0.000074" },
    { id: "dump2", action: "sell", targetUsd: 0.000052, ceilingUsd: 0.000075, floorUsd: 0.000048, sellPctOfBag: 10, label: "Dip → 0.000052" },
    { id: "push", action: "buy", targetUsd: 0.000095, ceilingUsd: 0.0001, floorUsd: 0.000048, budgetEth: 0.27, label: "Push → 0.000095" },
];
const BASE_BUY_BUDGET_ETH = DEFAULT_PHASES.filter((p) => p.action === "buy").reduce(
    (s, p) => s + Number(p.budgetEth || 0),
    0
);

function scalePhases(buyBudgetEth) {
    const budget = Math.min(5, Math.max(0.05, Number(buyBudgetEth) || 0.55));
    const scale = budget / (BASE_BUY_BUDGET_ETH || 0.7);
    return DEFAULT_PHASES.map((p) => {
        const copy = { ...p };
        if (copy.action === "buy" && copy.budgetEth != null) {
            copy.budgetEth = Math.round(Number(copy.budgetEth) * scale * 10000) / 10000;
        }
        return copy;
    });
}

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

function shortAddr(a) {
    return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

/** Truncate ETH to 6 dp so ethers parseEther never sees float dust. */
function roundEth(n, dp = 6) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return 0;
    const f = 10 ** dp;
    return Math.floor(x * f + 1e-12) / f;
}

function listMmWallets(store) {
    const out = [];
    for (let i = 0; i < (store?.wallets || []).length; i++) {
        const w = store.wallets[i];
        if (!isUsableWallet(w)) continue;
        const role = String(w.role || "buyer").toLowerCase();
        if (role === "funder" || role === "sniper" || role === "distributor") continue;
        if (role === "buyer" || role === "trend" || role === "mm") {
            out.push({ index: i, wallet: w });
        }
    }
    return out;
}

function findFunder(store) {
    return (store?.wallets || []).find((w) => String(w.role || "").toLowerCase() === "funder") || null;
}

async function readTokenPriceUsd(token) {
    const pool = await volumeLp.getPool(token);
    const tick = pool.tick;
    const t0 = String(pool.token0).toLowerCase();
    const weth = String(WETH).toLowerCase();
    // Uniswap: price = 1.0001^tick = token1 per token0
    const token1PerToken0 = Math.pow(1.0001, tick);
    let ethPerToken;
    if (t0 === weth) {
        // token1 is the meme → eth per meme = 1 / (token1/token0)
        ethPerToken = 1 / token1PerToken0;
    } else {
        // token0 is meme → eth per meme = token1/token0 (WETH per meme)
        ethPerToken = token1PerToken0;
    }
    let ethUsd = 1770;
    try {
        const px = await chain.getEthUsdPrice();
        if (px > 0) ethUsd = px;
    } catch (_) {}
    return {
        priceUsd: ethPerToken * ethUsd,
        ethPerToken,
        ethUsd,
        tick,
        pool: pool.address,
    };
}

function createMmBooster(options = {}) {
    const state = {
        running: false,
        stopping: false,
        token: DEFAULT_TOKEN,
        speed: "medium",
        maxInventoryPct: 25,
        sessionFeeCapUsd: 400,
        buyEthPerTx: 0.008,
        sellPctPerTx: 3,
        jitterPct: 30,
        buyBudgetEth: 0.55,
        phases: scalePhases(0.55),
        phaseIndex: 0,
        startedAt: null,
        lastTxAt: null,
        nextAt: null,
        inventoryStartTok: null,
        inventorySoldTok: 0,
        phaseSpentEth: 0,
        phaseSoldPctOfBag: 0,
        rrBuy: 0,
        rrSell: 0,
        _needFundStreak: 0,
        _lastNeedFundLogAt: 0,
        _autoFundAt: 0,
        stats: {
            buys: 0,
            sells: 0,
            fail: 0,
            skipped: 0,
            volumeEth: 0,
            volumeUsd: 0,
            feesEstUsd: 0,
            gasEth: 0,
            gasUsd: 0,
            buyEthSpent: 0,
            sellEthIn: 0,
            costUsd: 0,
            extMoves: 0,
            makers: {},
            makerCount: 0,
            ethUsd: null,
            lastError: null,
            lastPriceUsd: null,
            prevPriceUsd: null,
            lastBuyHash: null,
            lastSellHash: null,
            lastGasEth: null,
            fundedWallets: 0,
            fundedEth: 0,
        },
        logs: [],
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
        state.onBroadcast({ type: "mm_log", entry, status: publicStatus() });
        return entry;
    }

    function recomputeCost() {
        const ethUsd = Number(state.stats.ethUsd || 0);
        state.stats.gasUsd = Number(state.stats.gasEth || 0) * ethUsd;
        state.stats.costUsd =
            Number(state.stats.feesEstUsd || 0) + Number(state.stats.gasUsd || 0);
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

    function currentPhase() {
        return state.phases[state.phaseIndex] || null;
    }

    function publicStatus() {
        const store = state.getStore();
        const pool = listMmWallets(store);
        const phase = currentPhase();
        const spd = SPEEDS[state.speed] || SPEEDS.medium;
        const invPct =
            state.inventoryStartTok != null && state.inventoryStartTok > 0n
                ? (state.inventorySoldTok /
                      Number(ethers.formatUnits(state.inventoryStartTok, 18))) *
                  100
                : 0;
        return {
            running: state.running,
            stopping: state.stopping,
            feature: "mm",
            token: state.token,
            speed: state.speed,
            speedLabel: spd.label,
            maxInventoryPct: state.maxInventoryPct,
            sessionFeeCapUsd: state.sessionFeeCapUsd,
            buyEthPerTx: state.buyEthPerTx,
            sellPctPerTx: state.sellPctPerTx,
            buyBudgetEth: state.buyBudgetEth,
            baseBuyBudgetEth: BASE_BUY_BUDGET_ETH,
            phaseIndex: state.phaseIndex,
            phaseCount: state.phases.length,
            phase: phase
                ? {
                      id: phase.id,
                      action: phase.action,
                      label: phase.label,
                      targetUsd: phase.targetUsd,
                      floorUsd: phase.floorUsd,
                      ceilingUsd: phase.ceilingUsd,
                      budgetEth: phase.budgetEth,
                  }
                : null,
            inventorySoldPct: Math.round(invPct * 10) / 10,
            walletCount: pool.length,
            makerCount: state.stats.makerCount,
            stats: { ...state.stats },
            logs: state.logs.slice(0, 120),
            startedAt: state.startedAt,
            lastTxAt: state.lastTxAt,
            nextAt: state.nextAt,
            ledger: {
                buyEthSpent: state.stats.buyEthSpent,
                sellEthIn: state.stats.sellEthIn,
                feesEstUsd: state.stats.feesEstUsd,
                gasEth: state.stats.gasEth,
                gasUsd: state.stats.gasUsd,
                costUsd: state.stats.costUsd,
                volumeUsd: state.stats.volumeUsd,
                extMoves: state.stats.extMoves,
                fundedWallets: state.stats.fundedWallets,
                fundedEth: state.stats.fundedEth,
            },
            opsPrep: {
                funder: "0x684D107Cd9898fd5F1c8f068F16DC6418279f9F7",
                buyBudgetEth: state.buyBudgetEth,
                steps: [
                    `Funder dry powder ~${state.buyBudgetEth} ETH (you set this) → 0x684D107C…f9F7`,
                    "Import buyers from bundler (MM section)",
                    "Fund wallets — set count × ETH/wallet to fit your balance",
                    "Start chart MM — watch DexScreener 5m",
                ],
            },
        };
    }

    function persist() {
        const store = state.getStore();
        if (!store) return;
        store.mmBot = {
            ...(store.mmBot || {}),
            token: state.token,
            speed: state.speed,
            maxInventoryPct: state.maxInventoryPct,
            sessionFeeCapUsd: state.sessionFeeCapUsd,
            buyEthPerTx: state.buyEthPerTx,
            sellPctPerTx: state.sellPctPerTx,
            jitterPct: state.jitterPct,
            buyBudgetEth: state.buyBudgetEth,
        };
        state.saveStore(store);
    }

    function hydrateFromStore() {
        const store = state.getStore();
        const mb = store?.mmBot || {};
        if (mb.token) state.token = String(mb.token);
        if (mb.speed && SPEEDS[mb.speed]) state.speed = mb.speed;
        if (mb.maxInventoryPct != null) {
            state.maxInventoryPct = Math.min(50, Math.max(5, Number(mb.maxInventoryPct) || 25));
        }
        if (mb.sessionFeeCapUsd != null) {
            state.sessionFeeCapUsd = Math.max(50, Number(mb.sessionFeeCapUsd) || 400);
        }
        if (mb.buyEthPerTx != null) {
            state.buyEthPerTx = Math.min(0.05, Math.max(0.002, Number(mb.buyEthPerTx) || 0.008));
        }
        if (mb.sellPctPerTx != null) {
            state.sellPctPerTx = Math.min(15, Math.max(1, Number(mb.sellPctPerTx) || 3));
        }
        if (mb.jitterPct != null) {
            state.jitterPct = Math.min(60, Math.max(0, Number(mb.jitterPct) || 30));
        }
        if (mb.buyBudgetEth != null) {
            state.buyBudgetEth = Math.min(5, Math.max(0.05, Number(mb.buyBudgetEth) || 0.55));
            if (!state.running) state.phases = scalePhases(state.buyBudgetEth);
        }
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
        if (cfg.maxInventoryPct != null) {
            state.maxInventoryPct = Math.min(50, Math.max(5, Number(cfg.maxInventoryPct) || 25));
        }
        if (cfg.sessionFeeCapUsd != null) {
            state.sessionFeeCapUsd = Math.max(50, Number(cfg.sessionFeeCapUsd) || 400);
        }
        if (cfg.buyEthPerTx != null) {
            state.buyEthPerTx = Math.min(0.05, Math.max(0.002, Number(cfg.buyEthPerTx) || 0.008));
        }
        if (cfg.sellPctPerTx != null) {
            state.sellPctPerTx = Math.min(15, Math.max(1, Number(cfg.sellPctPerTx) || 3));
        }
        if (cfg.jitterPct != null) {
            state.jitterPct = Math.min(60, Math.max(0, Number(cfg.jitterPct) || 30));
        }
        if (cfg.buyBudgetEth != null) {
            state.buyBudgetEth = Math.min(5, Math.max(0.05, Number(cfg.buyBudgetEth) || 0.55));
            if (!state.running) state.phases = scalePhases(state.buyBudgetEth);
        }
        persist();
        return publicStatus();
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
        try {
            const receipt = await chain.provider.getTransactionReceipt(hash);
            if (!receipt) return 0;
            const used = BigInt(receipt.gasUsed || 0);
            const price = BigInt(receipt.effectiveGasPrice || receipt.gasPrice || 0);
            const eth = Number(ethers.formatEther(used * price));
            state.stats.gasEth = Number(state.stats.gasEth || 0) + eth;
            state.stats.lastGasEth = eth;
            recomputeCost();
            return eth;
        } catch (_) {
            return 0;
        }
    }

    async function totalTokenBalance(pool, token) {
        let sum = 0n;
        for (const { wallet: w } of pool) {
            try {
                const raw = await chain.getTokenBalanceRaw(w.address, token);
                sum += raw.balance || 0n;
            } catch (_) {}
        }
        return sum;
    }

    async function pickBuyWallet(pool) {
        if (!pool.length) return null;
        // Any wallet that can still do a min buy after gas pad is usable —
        // doBuy will size down to fit (don't require full buyEthPerTx).
        const need = MIN_BUY_ETH + BUY_GAS_PAD_ETH;
        for (let n = 0; n < pool.length; n++) {
            const i = (state.rrBuy + n) % pool.length;
            const w = pool[i].wallet;
            try {
                const bal = Number(await chain.getWalletBalance(w.address));
                if (bal >= need) {
                    state.rrBuy = i + 1;
                    return { ...pool[i], ethBal: bal };
                }
            } catch (_) {}
        }
        return null;
    }

    /** Top up a few dry MM wallets from funder so a buy phase can continue. */
    async function maybeAutoFundBuys(pool) {
        const now = Date.now();
        if (now - (state._autoFundAt || 0) < 45_000) return { funded: 0, skipped: true };
        state._autoFundAt = now;

        const store = state.getStore();
        const funder = findFunder(store);
        const fpk = funder && walletPrivateKey(funder);
        if (!funder || !fpk) {
            pushLog("⏭ auto-fund skipped — no funder key", "warn");
            return { funded: 0, error: "no_funder" };
        }

        let funderBal;
        try {
            funderBal = Number(await chain.getWalletBalance(funder.address));
        } catch (e) {
            pushLog(`⏭ auto-fund: funder bal failed · ${e.message || e}`, "warn");
            return { funded: 0, error: "funder_bal" };
        }
        const leave = 0.01;
        const target = roundEth(Math.max(MIN_BUY_ETH + 0.004, state.buyEthPerTx + 0.003), 6);
        if (funderBal < leave + target) {
            pushLog(
                `🛑 buy wallets dry · funder only ${funderBal.toFixed(5)} ETH — top up funder or Fund MM`,
                "err"
            );
            return { funded: 0, error: "funder_low" };
        }

        const dry = [];
        for (const entry of pool) {
            try {
                const bal = Number(await chain.getWalletBalance(entry.wallet.address));
                if (bal < MIN_BUY_ETH + BUY_GAS_PAD_ETH) {
                    dry.push({ ...entry, bal });
                }
            } catch (_) {}
        }
        dry.sort((a, b) => a.bal - b.bal);
        const take = dry.slice(0, 8);
        if (!take.length) return { funded: 0 };

        pushLog(
            `💸 auto-fund · topping ${take.length} dry wallets → ~${target} ETH each · funder ${funderBal.toFixed(5)}`,
            "ok"
        );

        let nonce;
        try {
            nonce = await chain.provider.getTransactionCount(funder.address, "pending");
        } catch (e) {
            pushLog(`⏭ auto-fund nonce failed · ${e.message || e}`, "warn");
            return { funded: 0, error: "nonce" };
        }

        let funded = 0;
        let fundedEth = 0;
        for (const { wallet: w, bal } of take) {
            const need = roundEth(Math.max(0, target - bal), 6);
            if (need < 0.0015) continue;
            if (funderBal - need < leave) {
                pushLog(`🛑 funder low mid auto-fund · ${funderBal.toFixed(5)} left`, "warn");
                break;
            }
            try {
                const tx = await chain.transferEth(
                    { private_key: fpk, address: funder.address },
                    w.address,
                    need,
                    nonce
                );
                if (tx?.hash || tx?.ok !== false) {
                    nonce += 1;
                    funderBal -= need;
                    funded += 1;
                    fundedEth += need;
                    state.stats.fundedWallets = Number(state.stats.fundedWallets || 0) + 1;
                    state.stats.fundedEth = Number(state.stats.fundedEth || 0) + need;
                    const label = w.name || shortAddr(w.address);
                    pushLog(
                        `💸 ${label} +${need.toFixed(5)} ETH (${bal.toFixed(5)}→~${(bal + need).toFixed(5)})`,
                        "info"
                    );
                }
            } catch (e) {
                pushLog(`❌ auto-fund ${shortAddr(w.address)}: ${e.message || e}`, "err");
            }
            await chain.sleep(200);
        }
        if (funded > 0) {
            pushLog(`💸 auto-fund done · ${funded} wallets · ${fundedEth.toFixed(4)} ETH`, "ok");
            // Brief wait so RPC balance reads catch up
            await chain.sleep(2500);
        }
        return { funded, fundedEth };
    }

    async function pickSellWallet(pool, token) {
        if (!pool.length) return null;
        let best = null;
        let bestBal = 0n;
        // Prefer rotating among top holders
        for (let n = 0; n < pool.length; n++) {
            const i = (state.rrSell + n) % pool.length;
            const w = pool[i].wallet;
            try {
                const raw = await chain.getTokenBalanceRaw(w.address, token);
                const bal = raw.balance || 0n;
                if (bal > bestBal) {
                    bestBal = bal;
                    best = { ...pool[i], raw };
                }
            } catch (_) {}
        }
        if (best) state.rrSell = (best.index + 1) % Math.max(1, pool.length);
        // Re-pick with rotation among those with meaningful bal
        for (let n = 0; n < pool.length; n++) {
            const i = (state.rrSell + n) % pool.length;
            const w = pool[i].wallet;
            try {
                const raw = await chain.getTokenBalanceRaw(w.address, token);
                if (raw.balance > ethers.parseUnits("1000", raw.decimals ?? 18)) {
                    state.rrSell = i + 1;
                    return { ...pool[i], raw };
                }
            } catch (_) {}
        }
        return best && bestBal > 0n ? best : null;
    }

    function phaseComplete(phase, priceUsd) {
        if (!phase) return true;
        if (phase.action === "buy") {
            if (priceUsd >= phase.targetUsd) return true;
            if (state.phaseSpentEth >= Number(phase.budgetEth || 0)) return true;
        } else if (phase.action === "sell") {
            if (priceUsd <= phase.targetUsd) return true;
            if (state.phaseSoldPctOfBag >= Number(phase.sellPctOfBag || 10)) return true;
        }
        return false;
    }

    function advancePhase() {
        const prev = currentPhase();
        state.phaseIndex++;
        state.phaseSpentEth = 0;
        state.phaseSoldPctOfBag = 0;
        const next = currentPhase();
        if (!next) {
            pushLog("🏁 All MM phases complete — stopping", "ok");
            state.stopping = true;
            state.running = false;
            return false;
        }
        pushLog(
            `➡️ Phase ${state.phaseIndex + 1}/${state.phases.length}: ${next.label} (${next.action})`,
            "ok"
        );
        if (prev) {
            pushLog(`✅ Finished ${prev.label}`, "ok");
        }
        return true;
    }

    async function doBuy(pool, phase, priceInfo) {
        if (priceInfo.priceUsd >= phase.ceilingUsd) {
            state.stats.skipped++;
            pushLog(
                `⏸ buy paused — price $${priceInfo.priceUsd.toFixed(8)} ≥ ceiling $${phase.ceilingUsd}`,
                "warn"
            );
            return { skipped: true, hitCeiling: true };
        }
        const picked = await pickBuyWallet(pool);
        if (!picked) {
            state.stats.skipped++;
            return { skipped: true, needFund: true };
        }
        const w = picked.wallet;
        const pk = walletPrivateKey(w);
        const ethBefore =
            picked.ethBal != null
                ? Number(picked.ethBal)
                : Number(await chain.getWalletBalance(w.address));
        const maxSpend = roundEth(Math.max(0, ethBefore - BUY_GAS_PAD_ETH), 6);
        if (maxSpend < MIN_BUY_ETH) {
            state.stats.skipped++;
            return { skipped: true, needFund: true };
        }

        const jitter = 1 + ((Math.random() * 2 - 1) * (state.jitterPct || 0)) / 100;
        let buyEth = roundEth(Math.max(MIN_BUY_ETH, state.buyEthPerTx * jitter), 6);
        const left = roundEth(
            Math.max(0, Number(phase.budgetEth || 0) - state.phaseSpentEth),
            6
        );
        if (left < MIN_BUY_ETH) return { skipped: true, budgetDone: true };
        if (buyEth > left) buyEth = left;
        if (buyEth > maxSpend) buyEth = maxSpend;
        buyEth = roundEth(buyEth, 6);
        if (buyEth < MIN_BUY_ETH) return { skipped: true, needFund: true };

        const fees = await ensureFeeCache();
        const label = w.name || shortAddr(w.address);
        pushLog(
            `🟢 BUY ${label} ${buyEth.toFixed(5)} ETH · wallet ${ethBefore.toFixed(5)} ETH · px $${priceInfo.priceUsd.toFixed(8)} · phase left ${Math.max(0, left - buyEth).toFixed(4)} ETH`,
            "info"
        );

        const buyTx = await chain.buy(
            { private_key: pk, address: w.address },
            buyEth.toFixed(6),
            state.token,
            {
                skipQuote: true,
                skipMulticall: true,
                clamp: true,
                gasLimit: BUY_GAS_LIMIT,
                priorityMultiplier: 1,
                useProvidedFees: true,
                feeData: {
                    maxFeePerGas: fees.maxFee,
                    maxPriorityFeePerGas: fees.tip,
                    gasPrice: fees.gasPrice,
                },
                gasCost: BUY_GAS_LIMIT * fees.maxFee,
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
        const rc = await waitReceipt(buyTx.hash);
        if (!rc || rc.status !== 1) {
            state.stats.fail++;
            pushLog(`❌ buy ${rc ? "reverted" : "timeout"} · ${label}`, "err");
            return { error: "buy_failed" };
        }
        const gasEth = await trackGas(buyTx.hash);
        let ethAfter = null;
        try {
            ethAfter = Number(await chain.getWalletBalance(w.address));
        } catch (_) {}
        let pxAfter = priceInfo.priceUsd;
        try {
            const p2 = await readTokenPriceUsd(state.token);
            pxAfter = p2.priceUsd;
        } catch (_) {}
        const feeUsd = buyEth * (priceInfo.ethUsd || 0) * 0.01;
        const gasUsd = gasEth * (priceInfo.ethUsd || 0);
        const pxDeltaPct =
            priceInfo.priceUsd > 0
                ? ((pxAfter - priceInfo.priceUsd) / priceInfo.priceUsd) * 100
                : 0;
        state.stats.buys++;
        state.stats.lastBuyHash = buyTx.hash;
        state.phaseSpentEth += buyEth;
        state.stats.buyEthSpent = Number(state.stats.buyEthSpent || 0) + buyEth;
        state.stats.volumeEth += buyEth;
        state.stats.volumeUsd += buyEth * (priceInfo.ethUsd || 0);
        state.stats.feesEstUsd += feeUsd;
        recomputeCost();
        noteMaker(w.address);
        state.lastTxAt = new Date().toISOString();
        pushLog(
            `✅ BUY ${label} · spent ${buyEth.toFixed(5)} ETH · gas ${gasEth.toFixed(6)} ETH ($${gasUsd.toFixed(3)}) · pool fee ~$${feeUsd.toFixed(3)} · wallet ${ethBefore != null ? ethBefore.toFixed(5) : "?"}→${ethAfter != null ? ethAfter.toFixed(5) : "?"} · px $${priceInfo.priceUsd.toFixed(8)}→$${pxAfter.toFixed(8)} (${pxDeltaPct >= 0 ? "+" : ""}${pxDeltaPct.toFixed(2)}%) · session cost ~$${Number(state.stats.costUsd).toFixed(2)} · ${buyTx.hash.slice(0, 14)}…`,
            "ok"
        );
        if (Math.abs(pxDeltaPct) > 0.4) {
            state.stats.extMoves++;
            pushLog(
                `⚡ price moved ${pxDeltaPct >= 0 ? "+" : ""}${pxDeltaPct.toFixed(2)}% on/around our buy — possible external flow`,
                "warn"
            );
        }
        state.onBroadcast({
            type: "mm_tx",
            kind: "buy",
            hash: buyTx.hash,
            status: publicStatus(),
        });
        return { ok: true, buyEth };
    }

    async function doSell(pool, phase, priceInfo) {
        if (priceInfo.priceUsd <= phase.floorUsd) {
            state.stats.skipped++;
            pushLog(
                `⏸ sell paused — price $${priceInfo.priceUsd.toFixed(8)} ≤ floor $${phase.floorUsd}`,
                "warn"
            );
            return { skipped: true, hitFloor: true };
        }
        const invPct =
            state.inventoryStartTok > 0n
                ? (state.inventorySoldTok /
                      Number(ethers.formatUnits(state.inventoryStartTok, 18))) *
                  100
                : 0;
        if (invPct >= state.maxInventoryPct) {
            pushLog(
                `🛑 session inventory cap ${state.maxInventoryPct}% hit — stopping sells`,
                "warn"
            );
            return { skipped: true, invCap: true };
        }

        const picked = await pickSellWallet(pool, state.token);
        if (!picked || !(picked.raw?.balance > 0n)) {
            state.stats.skipped++;
            pushLog("⏭ no token bags to sell", "warn");
            return { skipped: true };
        }
        const w = picked.wallet;
        const pk = walletPrivateKey(w);
        const decimals = Number(picked.raw.decimals ?? 18);
        const jitter = 1 + ((Math.random() * 2 - 1) * (state.jitterPct || 0)) / 100;
        let pct = Math.max(1, Math.min(15, state.sellPctPerTx * jitter));
        const phaseLeft = Math.max(0, Number(phase.sellPctOfBag || 10) - state.phaseSoldPctOfBag);
        // Approximate: each sell of pct% of ONE wallet ≈ phaseLeft tracking by wallet pct not bag %
        // Track phase progress by summing (tokens sold / start inventory)
        const sellAmt = (picked.raw.balance * BigInt(Math.round(pct * 100))) / 10000n;
        if (sellAmt <= 0n) {
            state.stats.skipped++;
            return { skipped: true };
        }
        const amountHuman = ethers.formatUnits(sellAmt, decimals);
        const fees = await ensureFeeCache(true);
        const label = w.name || shortAddr(w.address);
        const ethBal = Number(await chain.getWalletBalance(w.address));
        const tokHuman = Number(ethers.formatUnits(picked.raw.balance, decimals));
        pushLog(
            `🔴 SELL ${label} ${pct.toFixed(1)}% of bag (~${Number(amountHuman).toLocaleString(undefined,{maximumFractionDigits:0})} tok · ~$${(Number(amountHuman)*priceInfo.priceUsd).toFixed(2)}) · wallet ${ethBal.toFixed(5)} ETH · bag ${tokHuman >= 1e6 ? (tokHuman/1e6).toFixed(2)+"M" : tokHuman.toFixed(0)} · px $${priceInfo.priceUsd.toFixed(8)}`,
            "info"
        );

        if (ethBal < 0.0004) {
            state.stats.skipped++;
            pushLog(`⏭ ${label} needs gas ETH for sell (has ${ethBal.toFixed(5)})`, "warn");
            return { skipped: true, needGas: true };
        }

        const sellTx = await chain.sell(
            { private_key: pk, address: w.address },
            amountHuman,
            state.token,
            {
                skipQuote: true,
                gasLimit: SELL_GAS_LIMIT,
                priorityMultiplier: 1,
                useProvidedFees: true,
                feeData: {
                    maxFeePerGas: fees.maxFee,
                    maxPriorityFeePerGas: fees.tip,
                    gasPrice: fees.gasPrice,
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
        const rc = await waitReceipt(sellTx.hash);
        if (!rc || rc.status !== 1) {
            state.stats.fail++;
            pushLog(`❌ sell ${rc ? "reverted" : "timeout"} · ${label}`, "err");
            return { error: "sell_failed" };
        }
        const gasEth = await trackGas(sellTx.hash);
        let ethAfter = null;
        try {
            ethAfter = Number(await chain.getWalletBalance(w.address));
        } catch (_) {}
        const ethIn =
            ethAfter != null && Number.isFinite(ethBal)
                ? Math.max(0, ethAfter - ethBal + gasEth)
                : null;
        let pxAfter = priceInfo.priceUsd;
        try {
            const p2 = await readTokenPriceUsd(state.token);
            pxAfter = p2.priceUsd;
        } catch (_) {}
        const soldTok = Number(amountHuman);
        state.inventorySoldTok += soldTok;
        const startHuman =
            state.inventoryStartTok > 0n
                ? Number(ethers.formatUnits(state.inventoryStartTok, decimals))
                : 0;
        const bagPct = startHuman > 0 ? (soldTok / startHuman) * 100 : pct;
        state.phaseSoldPctOfBag += bagPct;
        const soldUsd = soldTok * priceInfo.priceUsd;
        const feeUsd = soldUsd * 0.01;
        const gasUsd = gasEth * (priceInfo.ethUsd || 0);
        const pxDeltaPct =
            priceInfo.priceUsd > 0
                ? ((pxAfter - priceInfo.priceUsd) / priceInfo.priceUsd) * 100
                : 0;
        state.stats.volumeUsd += soldUsd;
        state.stats.volumeEth += soldUsd / (priceInfo.ethUsd || 1);
        state.stats.feesEstUsd += feeUsd;
        if (ethIn != null) state.stats.sellEthIn = Number(state.stats.sellEthIn || 0) + ethIn;
        recomputeCost();
        state.stats.sells++;
        state.stats.lastSellHash = sellTx.hash;
        noteMaker(w.address);
        state.lastTxAt = new Date().toISOString();
        const sessionPct = startHuman > 0 ? (state.inventorySoldTok / startHuman) * 100 : 0;
        pushLog(
            `✅ SELL ${label} · ~$${soldUsd.toFixed(2)} · ETH in ~${ethIn != null ? ethIn.toFixed(5) : "?"} · gas ${gasEth.toFixed(6)} ETH ($${gasUsd.toFixed(3)}) · pool fee ~$${feeUsd.toFixed(3)} · wallet ${ethBal.toFixed(5)}→${ethAfter != null ? ethAfter.toFixed(5) : "?"} · px $${priceInfo.priceUsd.toFixed(8)}→$${pxAfter.toFixed(8)} (${pxDeltaPct >= 0 ? "+" : ""}${pxDeltaPct.toFixed(2)}%) · bag sold ${sessionPct.toFixed(1)}% · session cost ~$${Number(state.stats.costUsd).toFixed(2)} · ${sellTx.hash.slice(0, 14)}…`,
            "ok"
        );
        if (Math.abs(pxDeltaPct) > 0.4) {
            state.stats.extMoves++;
            pushLog(
                `⚡ price moved ${pxDeltaPct >= 0 ? "+" : ""}${pxDeltaPct.toFixed(2)}% on/around our sell — possible external flow`,
                "warn"
            );
        }
        state.onBroadcast({
            type: "mm_tx",
            kind: "sell",
            hash: sellTx.hash,
            status: publicStatus(),
        });
        return { ok: true, soldTok, phaseLeft };
    }

    async function maybeRecycleEthToFunder(pool) {
        const store = state.getStore();
        const funder = findFunder(store);
        if (!funder || !walletPrivateKey(funder)) return;
        // Pull excess ETH from wallets that just sold (keep gas pad)
        let moved = 0;
        for (const { wallet: w } of pool.slice(0, 40)) {
            try {
                const bal = Number(await chain.getWalletBalance(w.address));
                if (bal < 0.015) continue;
                const send = bal - 0.002;
                if (send < 0.008) continue;
                const tx = await chain.transferEth(
                    { private_key: walletPrivateKey(w), address: w.address },
                    funder.address,
                    send
                );
                if (tx?.hash) {
                    moved += send;
                    await chain.sleep(300);
                }
            } catch (_) {}
        }
        if (moved > 0) {
            pushLog(`♻️ recycled ~${moved.toFixed(4)} ETH → funder`, "info");
        }
    }

    async function cycleOnce() {
        const store = state.getStore();
        const pool = listMmWallets(store);
        if (pool.length < 2) {
            state.stats.skipped++;
            pushLog("⏭ need ≥2 MM wallets — import buyers", "warn");
            return { skipped: true };
        }
        const phase = currentPhase();
        if (!phase) {
            state.stopping = true;
            state.running = false;
            return { done: true };
        }

        const priceInfo = await readTokenPriceUsd(state.token);
        const prevPx = state.stats.lastPriceUsd;
        state.stats.prevPriceUsd = prevPx;
        state.stats.lastPriceUsd = priceInfo.priceUsd;
        state.stats.ethUsd = priceInfo.ethUsd;
        recomputeCost();

        if (prevPx != null && prevPx > 0) {
            const dPct = ((priceInfo.priceUsd - prevPx) / prevPx) * 100;
            if (Math.abs(dPct) >= 0.25) {
                state.stats.extMoves++;
                pushLog(
                    `📡 market move (between our txs) ${dPct >= 0 ? "+" : ""}${dPct.toFixed(2)}% · $${prevPx.toFixed(8)} → $${priceInfo.priceUsd.toFixed(8)} · likely external buys/sells`,
                    dPct > 0 ? "ok" : "warn"
                );
            }
        }

        if (state.stats.feesEstUsd >= state.sessionFeeCapUsd) {
            pushLog(
                `🛑 fee estimate $${state.stats.feesEstUsd.toFixed(0)} ≥ cap $${state.sessionFeeCapUsd} — pausing`,
                "err"
            );
            state.stopping = true;
            state.running = false;
            return { paused: true };
        }

        if (phaseComplete(phase, priceInfo.priceUsd)) {
            if (phase.action === "sell") {
                await maybeRecycleEthToFunder(pool);
            }
            advancePhase();
            state.onBroadcast({ type: "mm_status", status: publicStatus() });
            return { advanced: true };
        }

        let result;
        if (phase.action === "buy") {
            result = await doBuy(pool, phase, priceInfo);
            if (result?.needFund) {
                state._needFundStreak = Number(state._needFundStreak || 0) + 1;
                const fund = await maybeAutoFundBuys(pool);
                if (fund?.funded > 0) {
                    state._needFundStreak = 0;
                    // Retry buy same cycle after top-up
                    result = await doBuy(pool, phase, priceInfo);
                } else if (fund?.error === "funder_low") {
                    const now = Date.now();
                    if (now - (state._lastNeedFundLogAt || 0) > 60_000) {
                        state._lastNeedFundLogAt = now;
                        pushLog(
                            "⏸ buy phase paused — wallets dry and funder low. Fund funder or hit Fund MM, then restart.",
                            "err"
                        );
                    }
                    if (state._needFundStreak >= 3) {
                        state.stopping = true;
                        state.running = false;
                        pushLog("🛑 Chart MM stopped — no buy powder left", "err");
                    }
                } else {
                    const now = Date.now();
                    if (now - (state._lastNeedFundLogAt || 0) > 45_000) {
                        state._lastNeedFundLogAt = now;
                        pushLog(
                            "⏭ no wallet with enough ETH for buy — auto-fund pending / Fund MM",
                            "warn"
                        );
                    }
                }
            } else if (result?.ok) {
                state._needFundStreak = 0;
            }
            if (result?.hitCeiling || result?.budgetDone) {
                advancePhase();
            }
        } else {
            result = await doSell(pool, phase, priceInfo);
            if (result?.hitFloor || result?.invCap) {
                if (result.invCap) {
                    state.stopping = true;
                    state.running = false;
                } else {
                    await maybeRecycleEthToFunder(pool);
                    advancePhase();
                }
            }
        }

        state.onBroadcast({ type: "mm_status", status: publicStatus() });
        return result || { ok: true };
    }

    async function loop(loopId) {
        while (state.running && state._loopId === loopId && !state.stopping) {
            try {
                await cycleOnce();
            } catch (e) {
                state.stats.fail++;
                state.stats.lastError = e.shortMessage || e.message;
                pushLog(`❌ MM cycle: ${state.stats.lastError}`, "err");
            }
            if (!state.running || state.stopping || state._loopId !== loopId) break;
            const spd = SPEEDS[state.speed] || SPEEDS.medium;
            const wait = randBetween(spd.minMs, spd.maxMs);
            state.nextAt = new Date(Date.now() + wait).toISOString();
            state.onBroadcast({ type: "mm_status", status: publicStatus() });
            await chain.sleep(wait);
        }
        state.running = false;
        state.stopping = false;
        state.nextAt = null;
        pushLog("Chart MM stopped", "info");
        state.onBroadcast({ type: "mm_status", status: publicStatus() });
    }

    async function start(cfg = {}) {
        if (state.running) return { ok: false, error: "MM already running" };
        if (typeof state.isPeerRunning === "function" && state.isPeerRunning()) {
            return {
                ok: false,
                error: "Stop Volume / Trend / TX padder first — only one loop at a time",
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
        const store = state.getStore();
        const pool = listMmWallets(store);
        if (pool.length < 2) {
            return {
                ok: false,
                error: `Need ≥2 wallets with keys (have ${pool.length}) — Import buyers first`,
            };
        }

        state.token = token;
        state.phases = scalePhases(state.buyBudgetEth);
        state.phaseIndex = 0;
        state.phaseSpentEth = 0;
        state.phaseSoldPctOfBag = 0;
        state.inventorySoldTok = 0;
        state._needFundStreak = 0;
        state._lastNeedFundLogAt = 0;
        state._autoFundAt = 0;
        state.stats.feesEstUsd = 0;
        state.stats.volumeEth = 0;
        state.stats.volumeUsd = 0;
        state.stats.gasEth = 0;
        state.stats.gasUsd = 0;
        state.stats.buyEthSpent = 0;
        state.stats.sellEthIn = 0;
        state.stats.costUsd = 0;
        state.stats.extMoves = 0;
        state.stats.buys = 0;
        state.stats.sells = 0;
        state.stats.fail = 0;
        state.stats.skipped = 0;
        state.stats.makers = {};
        state.stats.makerCount = 0;
        state.stats.prevPriceUsd = null;

        try {
            const startBal = await totalTokenBalance(pool, token);
            state.inventoryStartTok = startBal;
            if (!(startBal > 0n)) {
                return { ok: false, error: "No token inventory in MM wallets — import buyers that hold bags" };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }

        state.running = true;
        state.stopping = false;
        state.startedAt = new Date().toISOString();
        state.stats.lastError = null;
        persist();

        let px = "?";
        try {
            const p = await readTokenPriceUsd(token);
            px = p.priceUsd.toFixed(8);
            state.stats.lastPriceUsd = p.priceUsd;
        } catch (_) {}

        const loopId = ++state._loopId;
        const phase = currentPhase();
        pushLog(
            `Chart MM ON · px $${px} · ${pool.length} wallets · buy budget ${state.buyBudgetEth} ETH · bag cap ${state.maxInventoryPct}% · fee cap $${state.sessionFeeCapUsd}`,
            "ok"
        );
        pushLog(
            `📊 watching: per-tx wallet ETH, gas, ~1% pool fees, price Δ (external flow), running session cost`,
            "info"
        );
        pushLog(
            `➡️ Phase 1/${state.phases.length}: ${phase.label} (${phase.action})`,
            "ok"
        );
        state.onBroadcast({ type: "mm_status", status: publicStatus() });
        setImmediate(() => loop(loopId));
        return { ok: true, status: publicStatus() };
    }

    function stop() {
        if (!state.running && !state.stopping) {
            return { ok: true, status: publicStatus() };
        }
        state.stopping = true;
        state.running = false;
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
        log: pushLog,
        listMmWallets: () => listMmWallets(state.getStore()),
        DEFAULT_PHASES,
    };
}

module.exports = {
    createMmBooster,
    listMmWallets,
    readTokenPriceUsd,
    DEFAULT_PHASES,
    SPEEDS,
};
