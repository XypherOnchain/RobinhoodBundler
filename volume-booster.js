/**
 * Volume booster — separate from TX count padder.
 * Cycles buy → full sell to print Uniswap volume for DEX ranking.
 *
 * Cost reality on NOXA (1% pool fee each way):
 *   loss ≈ 1–2% of notional + ~$0.02 gas.
 *   $50 cycle ≈ $0.50+ loss (mostly pool fee, not gas).
 *   $2–3 cycle ≈ a few cents — default for sustainable volume.
 */
const { ethers } = require("ethers");
const chain = require("./blockchain");
const volumeLp = require("./volume-lp");

const SPEEDS = {
    slow: { label: "Slow", minMs: 90_000, maxMs: 180_000 },
    medium: { label: "Medium", minMs: 35_000, maxMs: 70_000 },
    high: { label: "High", minMs: 18_000, maxMs: 35_000 },
};

// Without rebate: micro default. With rebate (self-LP): $50 is viable.
const DEFAULT_USD = 2.5;
const DEFAULT_REBATE_USD = 50;
const MIN_USD = 0.5;
const MAX_USD = 200;
const DEFAULT_MAX_LOSS_USD = 0.08;
const DEFAULT_REBATE_MAX_LOSS_USD = 0.25; // after real rebate (~55%+ share), net should be << $1
const DEFAULT_LP_ETH = 0.30; // need enough L to beat locker full-range
const COLLECT_EVERY_N = 4; // batch fee collects — saves a tx most cycles
// Self-LP multi-tick swaps need more headroom than bare pool (145k OOGed at ~143k)
const BUY_GAS_LIMIT = 220000n;
const SELL_GAS_LIMIT = 280000n;
const LOG_CAP = 100;
const DEFAULT_WIDTH_STEPS = 2; // tight band → more L per ETH vs locker
const MIN_LP_SHARE = 0.55; // pause/warn if fee capture below this

function randBetween(a, b) {
    return a + Math.floor(Math.random() * Math.max(1, b - a + 1));
}

function walletPrivateKey(w) {
    if (!w) return null;
    const pk = w.private_key || w.privateKey || null;
    return pk ? String(pk) : null;
}

function findTxBotWallet(store) {
    if (!store?.wallets?.length) return { index: null, wallet: null };
    const prefer = store.volumeBot?.walletIndex ?? store.txBot?.walletIndex;
    if (prefer != null && store.wallets[prefer]) {
        const w = store.wallets[prefer];
        if (walletPrivateKey(w) && chain.isEvmPrivateKey(walletPrivateKey(w))) {
            return { index: Number(prefer), wallet: w };
        }
    }
    for (let i = 0; i < store.wallets.length; i++) {
        const w = store.wallets[i];
        if (w.role !== "txbot") continue;
        const pk = walletPrivateKey(w);
        if (pk && chain.isEvmPrivateKey(pk)) return { index: i, wallet: w };
    }
    return { index: null, wallet: null };
}

function createVolumeBooster(options = {}) {
    const state = {
        running: false,
        stopping: false,
        token: "",
        speed: "medium",
        targetUsd: DEFAULT_USD,
        jitterPct: 5,
        maxLossUsd: DEFAULT_MAX_LOSS_USD,
        rebateMode: true, // self-LP → collect fees → net ≈ gas
        lpEth: DEFAULT_LP_ETH,
        lpTokenId: null,
        collectEveryN: COLLECT_EVERY_N,
        widthSteps: DEFAULT_WIDTH_STEPS,
        minLpShare: MIN_LP_SHARE,
        lpShare: null,
        walletIndex: null,
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
            feesCollectedEth: 0,
            ethUsd: null,
            lastError: null,
            lastBuyHash: null,
            lastSellHash: null,
            lastCycleLossEth: null,
            lastCycleLossUsd: null,
            lastFeesCollectedEth: null,
            avgGasUsd: null,
        },
        logs: [],
        _timer: null,
        _wake: null,
        _loopId: 0,
        _feeCache: null,
        _approved: new Set(),
        _lpReady: false,
        onBroadcast: options.onBroadcast || (() => {}),
        getStore: options.getStore || (() => null),
        saveStore: options.saveStore || (() => {}),
        isPeerRunning: options.isPeerRunning || (() => false),
    };

    function pushLog(text, kind = "info") {
        const entry = { at: new Date().toISOString(), text, kind };
        state.logs.unshift(entry);
        if (state.logs.length > LOG_CAP) state.logs.length = LOG_CAP;
        state.onBroadcast({ type: "volume_log", entry, status: publicStatus() });
    }

    function publicStatus() {
        const store = state.getStore();
        const found = findTxBotWallet(store);
        const spd = SPEEDS[state.speed] || SPEEDS.medium;
        const gasUsd =
            state.stats.ethUsd && state.stats.gasEth
                ? Number(state.stats.gasEth) * Number(state.stats.ethUsd)
                : null;
        const lossUsd =
            state.stats.ethUsd && state.stats.roundtripLossEth
                ? Number(state.stats.roundtripLossEth) * Number(state.stats.ethUsd)
                : null;
        return {
            running: state.running,
            stopping: state.stopping,
            feature: "volume",
            token: state.token,
            speed: state.speed,
            speedLabel: spd.label,
            targetUsd: state.targetUsd,
            jitterPct: state.jitterPct,
            maxLossUsd: state.maxLossUsd,
            rebateMode: !!state.rebateMode,
            lpEth: state.lpEth,
            lpTokenId: state.lpTokenId,
            collectEveryN: state.collectEveryN,
            widthSteps: state.widthSteps,
            minLpShare: state.minLpShare,
            lpShare: state.lpShare,
            estLossUsd: estimateCycleLossUsd(state.targetUsd, state.rebateMode),
            walletIndex: found.index,
            wallet: found.wallet
                ? {
                      address: found.wallet.address,
                      name: found.wallet.name || "TX Bot",
                  }
                : null,
            startedAt: state.startedAt,
            lastTxAt: state.lastTxAt,
            nextAt: state.nextAt,
            stats: {
                ...state.stats,
                gasUsd,
                lossUsd,
                avgGasUsd:
                    state.stats.cycles > 0 && gasUsd != null
                        ? gasUsd / state.stats.cycles
                        : null,
            },
            ethUsd: state.stats.ethUsd,
            logs: state.logs.slice(0, 40),
            presets: {
                speeds: Object.fromEntries(
                    Object.entries(SPEEDS).map(([k, v]) => [
                        k,
                        { label: v.label, minMs: v.minMs, maxMs: v.maxMs },
                    ])
                ),
                targetUsdDefault: DEFAULT_USD,
                targetUsdMin: MIN_USD,
                targetUsdMax: MAX_USD,
                maxLossUsdDefault: DEFAULT_MAX_LOSS_USD,
                rebateDefault: true,
                lpEthDefault: DEFAULT_LP_ETH,
                presets: [
                    { id: "micro", usd: 2.5, note: "~$0.03–0.06 without rebate" },
                    { id: "small", usd: 5, note: "~$0.06–0.12 without rebate" },
                    { id: "rebate50", usd: 50, note: "~gas only WITH self-LP rebate" },
                    { id: "large", usd: 50, note: "~$0.50 without rebate — burns" },
                ],
            },
        };
    }

    /** Honest est: unrecovered pool fee ≈ (1-share)*2%*size + gas. */
    function estimateCycleLossUsd(usd, rebate = state.rebateMode) {
        const n = Number(usd) || DEFAULT_USD;
        if (rebate) {
            const every = Math.max(1, Number(state.collectEveryN) || COLLECT_EVERY_N);
            const share =
                state.lpShare != null && state.lpShare > 0
                    ? Math.min(0.99, Number(state.lpShare))
                    : 0.55; // assume target share until measured
            const unrecovered = n * 0.02 * (1 - share); // buy+sell 1% each
            const gas = 0.035 + 0.015 / every;
            return Math.round((unrecovered + gas) * 1000) / 1000;
        }
        return Math.round((n * 0.011 + 0.02) * 1000) / 1000;
    }

    function persist() {
        const store = state.getStore();
        if (!store) return;
        store.volumeBot = {
            ...(store.volumeBot || {}),
            token: state.token,
            speed: state.speed,
            targetUsd: state.targetUsd,
            jitterPct: state.jitterPct,
            maxLossUsd: state.maxLossUsd,
            rebateMode: !!state.rebateMode,
            lpEth: state.lpEth,
            lpTokenId: state.lpTokenId,
            collectEveryN: state.collectEveryN,
            widthSteps: state.widthSteps,
            minLpShare: state.minLpShare,
            walletIndex: state.walletIndex,
        };
        state.saveStore(store);
    }

    function hydrateFromStore() {
        const store = state.getStore();
        const vb = store?.volumeBot || {};
        if (vb.token) state.token = String(vb.token);
        if (vb.speed && SPEEDS[vb.speed]) state.speed = vb.speed;
        if (vb.rebateMode != null) state.rebateMode = !!vb.rebateMode;
        else state.rebateMode = true;
        if (vb.lpEth != null) state.lpEth = Math.max(0.02, Number(vb.lpEth) || DEFAULT_LP_ETH);
        if (vb.lpTokenId) state.lpTokenId = String(vb.lpTokenId);
        if (vb.collectEveryN != null) {
            state.collectEveryN = Math.max(1, Math.min(20, Number(vb.collectEveryN) || COLLECT_EVERY_N));
        }
        if (vb.widthSteps != null) {
            state.widthSteps = Math.max(1, Math.min(20, Number(vb.widthSteps) || DEFAULT_WIDTH_STEPS));
        }
        // Old thin/wide LP settings couldn't beat locker — migrate once
        if (vb._shareMigrated !== true) {
            if (Number(state.widthSteps) >= 6) state.widthSteps = DEFAULT_WIDTH_STEPS;
            if (Number(state.lpEth) < 0.2) state.lpEth = DEFAULT_LP_ETH;
            if (Number(state.maxLossUsd) < 0.15 && state.rebateMode) {
                state.maxLossUsd = DEFAULT_REBATE_MAX_LOSS_USD;
            }
            // Force remint of thin NFT on next start
            state.lpTokenId = state.lpTokenId; // keep id so ensureSelfLp can close it
            if (store) {
                store.volumeBot = {
                    ...(store.volumeBot || {}),
                    widthSteps: state.widthSteps,
                    lpEth: state.lpEth,
                    maxLossUsd: state.maxLossUsd,
                    _shareMigrated: true,
                };
                state.saveStore(store);
            }
        }
        if (vb.targetUsd != null) {
            state.targetUsd = Math.min(
                MAX_USD,
                Math.max(MIN_USD, Number(vb.targetUsd) || DEFAULT_USD)
            );
        }
        // Old $50 without rebate flag → enable rebate + keep $50
        if (Number(vb.targetUsd) >= 40 && vb._rebateMigrated !== true) {
            state.rebateMode = true;
            state.targetUsd = DEFAULT_REBATE_USD;
            state.maxLossUsd = DEFAULT_REBATE_MAX_LOSS_USD;
            store.volumeBot = {
                ...(store.volumeBot || {}),
                rebateMode: true,
                targetUsd: DEFAULT_REBATE_USD,
                maxLossUsd: DEFAULT_REBATE_MAX_LOSS_USD,
                _rebateMigrated: true,
                _microMigrated: true,
            };
            state.saveStore(store);
        }
        if (vb.jitterPct != null) {
            state.jitterPct = Math.min(25, Math.max(0, Number(vb.jitterPct) || 0));
        }
        if (vb.maxLossUsd != null) {
            state.maxLossUsd = Math.max(0.01, Number(vb.maxLossUsd) || DEFAULT_MAX_LOSS_USD);
        } else if (state.rebateMode) {
            state.maxLossUsd = DEFAULT_REBATE_MAX_LOSS_USD;
        }
        if (vb.walletIndex != null) state.walletIndex = Number(vb.walletIndex);
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
        if (cfg.rebateMode != null) state.rebateMode = !!cfg.rebateMode;
        if (cfg.lpEth != null) state.lpEth = Math.max(0.02, Number(cfg.lpEth) || DEFAULT_LP_ETH);
        if (cfg.lpTokenId != null) state.lpTokenId = cfg.lpTokenId ? String(cfg.lpTokenId) : null;
        if (cfg.collectEveryN != null) {
            state.collectEveryN = Math.max(1, Math.min(20, Number(cfg.collectEveryN) || COLLECT_EVERY_N));
        }
        if (cfg.widthSteps != null) {
            state.widthSteps = Math.max(1, Math.min(20, Number(cfg.widthSteps) || DEFAULT_WIDTH_STEPS));
        }
        if (cfg.targetUsd != null) {
            state.targetUsd = Math.min(
                MAX_USD,
                Math.max(MIN_USD, Number(cfg.targetUsd) || DEFAULT_USD)
            );
        }
        if (cfg.jitterPct != null) {
            state.jitterPct = Math.min(25, Math.max(0, Number(cfg.jitterPct) || 0));
        }
        if (cfg.maxLossUsd != null) {
            state.maxLossUsd = Math.max(0.01, Number(cfg.maxLossUsd) || DEFAULT_MAX_LOSS_USD);
        }
        if (cfg.walletIndex != null) state.walletIndex = Number(cfg.walletIndex);
        persist();
        state.onBroadcast({ type: "volume_status", status: publicStatus() });
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
        let tip = feeData.maxPriorityFeePerGas ?? 0n;
        if (tip < 0n) tip = 0n;
        // Volume doesn't need to race — tip 0 when network allows
        if (tip > 0n && tip < ethers.parseUnits("0.01", "gwei")) tip = 0n;
        let maxFee =
            feeData.maxFeePerGas ??
            feeData.gasPrice ??
            ethers.parseUnits("0.05", "gwei");
        const gp = feeData.gasPrice ?? maxFee;
        // Cap maxFee near gasPrice — volume is not time-critical
        if (gp > 0n) {
            const cap = (gp * 105n) / 100n;
            if (maxFee > cap) maxFee = cap;
        }
        // Hard tip floor at 0 for volume
        tip = 0n;
        if (maxFee < tip) maxFee = tip > 0n ? tip : gp;
        state._feeCache = { at: now, tip, maxFee, gasPrice: gp };
        return state._feeCache;
    }

    async function resolveWallet() {
        const store = state.getStore();
        if (!store) throw new Error("No store");
        const found = findTxBotWallet(store);
        if (!found.wallet) {
            throw new Error("No TX bot wallet — create/import on this host first");
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

    function pickBuyEth(ethUsd) {
        const usd = Number(state.targetUsd) || DEFAULT_USD;
        const jitter = Number(state.jitterPct) || 0;
        const factor =
            jitter > 0 ? 1 + ((Math.random() * 2 - 1) * jitter) / 100 : 1;
        const target = Math.max(MIN_USD, Math.min(MAX_USD, usd * factor));
        const px = ethUsd > 0 ? ethUsd : 3000;
        const eth = target / px;
        // 8 decimals for micro sizes (~$0.50–$5)
        return Math.max(0.00005, Math.round(eth * 1e8) / 1e8);
    }

    async function trackGas(hash) {
        if (!hash) return 0;
        for (let i = 0; i < 40; i++) {
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
            await chain.sleep(1500);
        }
        return 0;
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

    async function cycleOnce() {
        const w = await resolveWallet();
        const token = state.token;
        if (!chain.isEvmAddress(token)) throw new Error("Invalid token");

        const ethUsd = await refreshEthUsd();
        const buyEth = pickBuyEth(ethUsd);
        const { tip, maxFee, gasPrice } = await ensureFeeCache();

        // Need buy size + buy gas + sell gas
        const buyGasReserve = BUY_GAS_LIMIT * maxFee;
        const sellGasReserve = SELL_GAS_LIMIT * maxFee;
        const minGasPad = ethers.parseEther("0.00015");
        let reserve = buyGasReserve + sellGasReserve;
        if (reserve < minGasPad) reserve = minGasPad;
        if (reserve > ethers.parseEther("0.002")) reserve = ethers.parseEther("0.002");

        const balStr = await chain.getWalletBalance(w.address);
        const balWei = ethers.parseEther(String(balStr || "0"));
        const buyWei = ethers.parseEther(String(buyEth));
        if (balWei < buyWei + reserve) {
            state.stats.skipped++;
            state.stats.lastError = `Low ETH (${balStr}) — need ~${ethers.formatEther(buyWei + reserve)} for $${state.targetUsd} cycle`;
            pushLog(
                `⏭ low ETH ${Number(balStr).toFixed(5)} — fund wallet (~$${state.targetUsd} + gas)`,
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
        pushLog(
            `📈 volume BUY ~$${Number(buyUsdEst).toFixed(2)} (${buyEth} ETH) · est loss ~$${estimateCycleLossUsd(buyUsdEst).toFixed(3)} · tip ${tip === 0n ? "0" : ethers.formatUnits(tip, "gwei")} gwei`,
            "info"
        );

        const buyTx = await chain.buy(
            { private_key: w.private_key, address: w.address },
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
                gasCost: buyGasReserve,
                sellGasReserve: sellGasReserve,
                reserveSellGas: false,
                preflight: true,
            }
        );

        if (buyTx?.error) {
            state.stats.fail++;
            state.stats.lastError = buyTx.error;
            pushLog(`❌ volume buy failed: ${buyTx.error}`, "err");
            return { error: buyTx.error };
        }

        state.stats.okBuys++;
        state.stats.lastBuyHash = buyTx.hash;
        state.stats.volumeEth = Number(state.stats.volumeEth || 0) + buyEth;
        if (ethUsd > 0) {
            state.stats.volumeUsd =
                Number(state.stats.volumeUsd || 0) + buyEth * ethUsd;
        }
        pushLog(`✅ buy · ${buyTx.hash.slice(0, 12)}…`, "ok");
        state.onBroadcast({
            type: "volume_tx",
            kind: "buy",
            hash: buyTx.hash,
            status: publicStatus(),
        });

        const buyReceipt = await waitReceipt(buyTx.hash);
        if (!buyReceipt) {
            state.stats.fail++;
            state.stats.lastError = "buy receipt timeout";
            pushLog(
                `❌ buy pending too long (${buyTx.hash.slice(0, 12)}…) — aborting sell`,
                "err"
            );
            return { error: "buy_timeout" };
        }
        if (buyReceipt.status !== 1) {
            state.stats.fail++;
            const used = buyReceipt.gasUsed != null ? String(buyReceipt.gasUsed) : "?";
            state.stats.lastError = `buy reverted (gasUsed ${used})`;
            pushLog(
                `❌ buy reverted (gasUsed ${used}/${BUY_GAS_LIMIT}) — aborting sell · ${buyTx.hash.slice(0, 12)}…`,
                "err"
            );
            return { error: "buy_reverted" };
        }
        await trackGas(buyTx.hash);

        // Brief settle so balanceOf sees tokens
        await chain.sleep(800);

        let tokBal = 0n;
        let decimals = 18;
        try {
            const raw = await chain.getTokenBalanceRaw(w.address, token);
            tokBal = raw.balance || 0n;
            decimals = Number(raw.decimals ?? 18);
        } catch (e) {
            state.stats.fail++;
            pushLog(`❌ token balance: ${e.message}`, "err");
            return { error: e.message };
        }
        if (!(tokBal > 0n)) {
            state.stats.fail++;
            pushLog(`❌ no tokens after buy — skip sell`, "err");
            return { error: "no_tokens" };
        }

        // Leave 1 wei dust to avoid zero-balance edge cases
        const sellAmt = tokBal > 1n ? tokBal - 1n : tokBal;
        const amountHuman = ethers.formatUnits(sellAmt, decimals);

        // Refresh fees for sell (still floor tip)
        const sellFees = await ensureFeeCache(true);
        pushLog(`📉 volume SELL ${Number(amountHuman).toPrecision(6)} tokens`, "info");

        const sellTx = await chain.sell(
            { private_key: w.private_key, address: w.address },
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
                slippageBps: 800, // tighter — less giveaway; rebate LP absorbs most flow
            }
        );

        if (sellTx?.error) {
            state.stats.fail++;
            state.stats.lastError = sellTx.error;
            pushLog(`❌ volume sell failed: ${sellTx.error} — tokens may remain`, "err");
            return { error: sellTx.error };
        }

        state.stats.okSells++;
        state.stats.lastSellHash = sellTx.hash;
        pushLog(`✅ sell · ${sellTx.hash.slice(0, 12)}…`, "ok");
        state.onBroadcast({
            type: "volume_tx",
            kind: "sell",
            hash: sellTx.hash,
            status: publicStatus(),
        });

        const sellReceipt = await waitReceipt(sellTx.hash);
        if (!sellReceipt || sellReceipt.status !== 1) {
            state.stats.fail++;
            pushLog(`⚠️ sell receipt missing/reverted — check wallet`, "warn");
        } else {
            await trackGas(sellTx.hash);
        }

        await chain.sleep(400);

        // Keep LP in range — remint when price leaves our band (or near edge)
        if (state.rebateMode && state.lpTokenId) {
            try {
                const st = await volumeLp.isPositionInRange(state.lpTokenId);
                if (st.dead || !st.inRange || st.nearEdge) {
                    pushLog(
                        st.dead
                            ? `🔄 LP dead — reminting around tick ${st.tick ?? "?"}`
                            : !st.inRange
                              ? `🔄 LP out of range (tick ${st.tick} ∉ [${st.tickLower},${st.tickUpper})) — refreshing`
                              : `🔄 LP near edge (tick ${st.tick}) — refreshing`,
                        "info"
                    );
                    const fees = await ensureFeeCache(true);
                    const lp = await volumeLp.ensureSelfLp(
                        { private_key: w.private_key, address: w.address },
                        state.token,
                        {
                            lpEth: state.lpEth,
                            tokenId: state.lpTokenId,
                            widthSteps: state.widthSteps || DEFAULT_WIDTH_STEPS,
                            minShare: state.minLpShare || MIN_LP_SHARE,
                            forceRefresh: true,
                            feeData: {
                                maxFeePerGas: fees.maxFee,
                                maxPriorityFeePerGas: fees.tip,
                                gasPrice: fees.gasPrice,
                            },
                        }
                    );
                    state.lpTokenId = lp.tokenId;
                    if (lp.share != null) state.lpShare = Number(lp.share);
                    persist();
                    pushLog(
                        `🏦 LP refreshed · NFT #${lp.tokenId} · [${lp.tickLower},${lp.tickUpper}]${
                            state.lpShare != null
                                ? ` · share ${(state.lpShare * 100).toFixed(1)}%`
                                : ""
                        }`,
                        "ok"
                    );
                }
            } catch (e) {
                pushLog(`⚠️ LP range check: ${e.shortMessage || e.message}`, "warn");
            }
        }

        // Rebate: collect LP fees every N cycles (not every cycle) to save gas
        let feesEth = 0;
        const every = Math.max(1, Number(state.collectEveryN) || COLLECT_EVERY_N);
        const shouldCollect =
            state.rebateMode &&
            state.lpTokenId &&
            (state.stats.cycles + 1) % every === 0;
        if (shouldCollect) {
            try {
                const fees = await ensureFeeCache(true);
                const collected = await volumeLp.collectLpFees(
                    { private_key: w.private_key, address: w.address },
                    state.lpTokenId,
                    {
                        feeData: {
                            maxFeePerGas: fees.maxFee,
                            maxPriorityFeePerGas: fees.tip,
                            gasPrice: fees.gasPrice,
                        },
                    }
                );
                feesEth = Number(collected.ethOut || 0) + Number(collected.wethOut || 0);
                state.stats.lastFeesCollectedEth = feesEth;
                state.stats.feesCollectedEth =
                    Number(state.stats.feesCollectedEth || 0) + feesEth;
                if (feesEth > 0) {
                    pushLog(
                        `💰 LP fees collected ~${feesEth.toFixed(6)} ETH (~$${((feesEth * (ethUsd || 0)) || 0).toFixed(3)}) · every ${every} cycles`,
                        "ok"
                    );
                } else {
                    pushLog(`💰 LP collect (batched) — little accrued yet`, "info");
                }
            } catch (e) {
                pushLog(`⚠️ LP collect: ${e.shortMessage || e.message}`, "warn");
            }
        } else if (state.rebateMode && state.lpTokenId) {
            const left = every - ((state.stats.cycles + 1) % every);
            if (left === every - 1 || left === 1) {
                // quiet — don't spam every cycle
            }
        }

        let ethAfter = ethBefore;
        try {
            ethAfter = Number(await chain.getWalletBalance(w.address));
        } catch (_) {}

        // Net wallet delta this cycle (before batched collect, pool fee still "out")
        const loss = Math.max(0, ethBefore - ethAfter);
        state.stats.roundtripLossEth =
            Number(state.stats.roundtripLossEth || 0) + loss;
        state.stats.lastCycleLossEth = loss;
        state.stats.lastCycleLossUsd =
            ethUsd > 0 ? loss * ethUsd : null;
        state.stats.cycles++;
        state.lastTxAt = new Date().toISOString();

        // ethAfter already includes any collect this cycle — don't subtract feesCollected again
        const amortizedUsd =
            ethUsd > 0 && state.stats.cycles > 0
                ? (Number(state.stats.roundtripLossEth) * ethUsd) /
                  state.stats.cycles
                : null;

        const lossUsdStr =
            state.stats.lastCycleLossUsd != null
                ? `~$${state.stats.lastCycleLossUsd.toFixed(3)}`
                : `${loss.toFixed(6)} ETH`;
        const modeNote = state.rebateMode
            ? shouldCollect
                ? "net after LP collect"
                : `gross (fees accrue · collect in ${every - (state.stats.cycles % every || every)})`
            : "mostly pool fee";
        pushLog(
            `🔁 cycle #${state.stats.cycles} · ${lossUsdStr} ${modeNote}${
                amortizedUsd != null ? ` · avg net ~$${amortizedUsd.toFixed(3)}` : ""
            }`,
            shouldCollect &&
                state.stats.lastCycleLossUsd != null &&
                state.stats.lastCycleLossUsd > state.maxLossUsd
                ? "warn"
                : "ok"
        );

        // Circuit breaker only after a collect (when rebate is realized)
        if (
            shouldCollect &&
            state.stats.lastCycleLossUsd != null &&
            state.stats.lastCycleLossUsd > Number(state.maxLossUsd || DEFAULT_MAX_LOSS_USD)
        ) {
            pushLog(
                state.rebateMode
                    ? `🛑 net loss $${state.stats.lastCycleLossUsd.toFixed(3)} > max $${Number(state.maxLossUsd).toFixed(3)} after collect — pausing (LP share ${(
                          (state.lpShare || 0) * 100
                      ).toFixed(1)}% — raise LP seed / tighten width).`
                    : `🛑 loss $${state.stats.lastCycleLossUsd.toFixed(3)} > max $${Number(state.maxLossUsd).toFixed(3)} — pausing. Enable Fee rebate (self-LP) for $50 cycles.`,
                "err"
            );
            state.stopping = true;
            state.running = false;
            state.onBroadcast({ type: "volume_status", status: publicStatus() });
            return { ok: true, loss, paused: true };
        }

        state.onBroadcast({ type: "volume_status", status: publicStatus() });
        return { ok: true, loss, buyHash: buyTx.hash, sellHash: sellTx.hash, feesEth };
    }

    async function loop(loopId) {
        while (state.running && state._loopId === loopId && !state.stopping) {
            try {
                await cycleOnce();
            } catch (e) {
                state.stats.fail++;
                state.stats.lastError = e.shortMessage || e.message;
                pushLog(`❌ ${state.stats.lastError}`, "err");
            }

            if (!state.running || state._loopId !== loopId || state.stopping) break;

            const spd = SPEEDS[state.speed] || SPEEDS.medium;
            const wait = randBetween(spd.minMs, spd.maxMs);
            state.nextAt = new Date(Date.now() + wait).toISOString();
            state.onBroadcast({ type: "volume_status", status: publicStatus() });
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
        pushLog("Volume booster stopped", "info");
        state.onBroadcast({ type: "volume_status", status: publicStatus() });
    }

    function start(cfg = {}) {
        if (state.running) return { ok: false, error: "Volume booster already running" };
        if (typeof state.isPeerRunning === "function" && state.isPeerRunning()) {
            return {
                ok: false,
                error: "Stop the TX count booster first — only one loop at a time on this wallet",
            };
        }
        const token = String(cfg.token || state.token || "").trim();
        if (!chain.isEvmAddress(token)) {
            return { ok: false, error: "Set a valid token address" };
        }
        const speed = String(cfg.speed || state.speed || "medium").toLowerCase();
        if (!SPEEDS[speed]) return { ok: false, error: "Speed must be slow|medium|high" };

        if (cfg.rebateMode != null) state.rebateMode = !!cfg.rebateMode;
        if (cfg.lpEth != null) state.lpEth = Math.max(0.02, Number(cfg.lpEth) || DEFAULT_LP_ETH);
        if (cfg.lpTokenId != null) state.lpTokenId = cfg.lpTokenId ? String(cfg.lpTokenId) : null;
        if (cfg.collectEveryN != null) {
            state.collectEveryN = Math.max(1, Math.min(20, Number(cfg.collectEveryN) || COLLECT_EVERY_N));
        }
        if (cfg.widthSteps != null) {
            state.widthSteps = Math.max(1, Math.min(20, Number(cfg.widthSteps) || DEFAULT_WIDTH_STEPS));
        }
        if (cfg.targetUsd != null) {
            state.targetUsd = Math.min(
                MAX_USD,
                Math.max(MIN_USD, Number(cfg.targetUsd) || DEFAULT_USD)
            );
        } else if (state.rebateMode && Number(state.targetUsd) < 10) {
            // Rebate mode defaults to $50 if user left micro size
            state.targetUsd = DEFAULT_REBATE_USD;
        }
        if (cfg.jitterPct != null) {
            state.jitterPct = Math.min(25, Math.max(0, Number(cfg.jitterPct) || 0));
        }
        if (cfg.maxLossUsd != null) {
            state.maxLossUsd = Math.max(0.01, Number(cfg.maxLossUsd) || DEFAULT_MAX_LOSS_USD);
        } else if (state.rebateMode) {
            state.maxLossUsd = Math.max(state.maxLossUsd, DEFAULT_REBATE_MAX_LOSS_USD);
        }

        if (!state.rebateMode && state.targetUsd >= 25) {
            pushLog(
                `⚠️ Size $${state.targetUsd} without rebate ≈ ~$${estimateCycleLossUsd(state.targetUsd, false).toFixed(2)}/cycle. Enable Fee rebate (self-LP).`,
                "warn"
            );
        }

        state.token = token;
        state.speed = speed;
        state.running = true;
        state.stopping = false;
        state.startedAt = new Date().toISOString();
        state.stats.lastError = null;
        state._lpReady = false;
        const store = state.getStore();
        if (store) {
            store.volumeBot = {
                ...(store.volumeBot || {}),
                _rebateMigrated: true,
                _microMigrated: true,
            };
        }
        persist();

        const loopId = ++state._loopId;
        pushLog(
            `Volume ON · ~$${state.targetUsd}/cycle · ${state.rebateMode ? "REBATE self-LP" : "no rebate"} · collect/${state.collectEveryN || COLLECT_EVERY_N} · est ~$${estimateCycleLossUsd(state.targetUsd).toFixed(3)} · ${speed}`,
            "ok"
        );
        state.onBroadcast({ type: "volume_status", status: publicStatus() });
        setImmediate(() => runWithLpSetup(loopId));
        return { ok: true, status: publicStatus() };
    }

    async function runWithLpSetup(loopId) {
        try {
            if (state.rebateMode && state.running && state._loopId === loopId) {
                const w = await resolveWallet();
                pushLog(
                    `🏦 seeding self-LP (~${state.lpEth} ETH, width ${state.widthSteps || DEFAULT_WIDTH_STEPS}) — need ≥${Math.round((state.minLpShare || MIN_LP_SHARE) * 100)}% of in-range L to rebate…`,
                    "info"
                );
                const fees = await ensureFeeCache(true);
                // Always remint on start so thin/wide NFTs get replaced
                const lp = await volumeLp.ensureSelfLp(
                    { private_key: w.private_key, address: w.address },
                    state.token,
                    {
                        lpEth: state.lpEth,
                        tokenId: state.lpTokenId,
                        widthSteps: state.widthSteps || DEFAULT_WIDTH_STEPS,
                        minShare: state.minLpShare || MIN_LP_SHARE,
                        forceRefresh: true,
                        feeData: {
                            maxFeePerGas: fees.maxFee,
                            maxPriorityFeePerGas: fees.tip,
                            gasPrice: fees.gasPrice,
                        },
                    }
                );
                state.lpTokenId = lp.tokenId;
                state.lpShare = lp.share != null ? Number(lp.share) : null;
                if (state.lpShare == null) {
                    try {
                        const s = await volumeLp.getLpShare(state.lpTokenId);
                        state.lpShare = s.share;
                    } catch (_) {}
                }
                state._lpReady = true;
                persist();
                const pct =
                    state.lpShare != null
                        ? `${(state.lpShare * 100).toFixed(1)}%`
                        : "?";
                pushLog(
                    `🏦 LP ready · NFT #${lp.tokenId} · ticks ${lp.tickLower}→${lp.tickUpper} · share ${pct} · est ~$${estimateCycleLossUsd(state.targetUsd).toFixed(3)}/cycle`,
                    state.lpShare != null && state.lpShare < (state.minLpShare || MIN_LP_SHARE)
                        ? "warn"
                        : "ok"
                );
                if (
                    state.lpShare != null &&
                    state.lpShare < (state.minLpShare || MIN_LP_SHARE)
                ) {
                    pushLog(
                        `⚠️ LP share ${pct} < ${Math.round((state.minLpShare || MIN_LP_SHARE) * 100)}% — most fees still go to locker. Raise LP seed (try 0.4–0.6 ETH) or tighten range width to 1–2.`,
                        "warn"
                    );
                }
            }
        } catch (e) {
            state.stats.fail++;
            state.stats.lastError = e.shortMessage || e.message;
            pushLog(`❌ self-LP setup failed: ${state.stats.lastError}`, "err");
            pushLog(
                `Falling back to no-rebate (pool fee will apply). Fund more ETH or disable rebate.`,
                "warn"
            );
            state.rebateMode = false;
            persist();
        }
        if (state.running && state._loopId === loopId && !state.stopping) {
            await loop(loopId);
        } else {
            state.running = false;
            state.stopping = false;
            state.onBroadcast({ type: "volume_status", status: publicStatus() });
        }
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
        if (state._wake) {
            const w = state._wake;
            state._wake = null;
            w();
        }
        pushLog("Volume stop requested…", "info");
        state.onBroadcast({ type: "volume_status", status: publicStatus() });
        return { ok: true, status: publicStatus() };
    }

    function status() {
        return publicStatus();
    }

    return {
        start,
        stop,
        configure,
        status,
        hydrateFromStore,
        isRunning: () => !!state.running,
    };
}

module.exports = { createVolumeBooster };
