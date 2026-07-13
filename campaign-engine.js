/**
 * Batch Launch Factory + capital recycle + test matrix + ranking + Bayesian stub.
 * Closed loop: generate → launch → execute → realize → recall → score → next.
 */

const { STAGES } = require("./job-queue");
const { ethers } = require("ethers");

const EXIT_STRATEGIES = [
    "early_recovery",
    "ladder",
    "trailing",
    "hold_monitor",
];

const BUY_TIMINGS = ["immediate", "5s", "15s"];

function defaultCampaignConfig() {
    return {
        name: "Test campaign",
        count: 10,
        maxConcurrent: 3,
        autoRecycle: true,
        autoStartNext: true,
        maxTestDurationSec: 15 * 60,
        capitalRecoveryTargetX: 1.0, // recover principal
        template: {
            namePrefix: "Test",
            symbolPrefix: "T",
            metadataURI: "",
            twitter: "",
            website: "",
            telegram: "",
            description: "Automated test launch",
        },
        // Fixed defaults when not using matrix
        defaults: {
            devBuyEth: 0.02,
            totalEth: 0.25,
            walletCount: 6,
            buyMode: "organic", // burst | organic | sequential
            buyTiming: "immediate",
            lpAllocationPct: 0,
            exitStrategy: "early_recovery",
            maxTestDurationSec: 15 * 60,
            capitalRecoveryTargetX: 1.0,
        },
        // Parameter sweep (optional)
        matrix: null,
        // Early termination
        earlyStop: {
            noProgressSec: 600,
            minProjectedReturnPct: -50,
            maxFailedTxEth: 0.03,
        },
    };
}

function ensureCampaigns(store) {
    if (!store.campaigns || typeof store.campaigns !== "object") {
        store.campaigns = {};
    }
    if (!store.campaignResults || !Array.isArray(store.campaignResults)) {
        store.campaignResults = [];
    }
    if (!store.walletPools || typeof store.walletPools !== "object") {
        store.walletPools = {
            ready: [],
            funded: [],
            inUse: [],
            recallPending: [],
            needsReconcile: [],
        };
    }
    if (!store.optimizer || typeof store.optimizer !== "object") {
        store.optimizer = {
            trials: [],
            lastRecommendation: null,
        };
    }
    return store;
}

function cartesian(matrix) {
    if (!matrix || typeof matrix !== "object") return [{}];
    const keys = Object.keys(matrix).filter((k) => Array.isArray(matrix[k]) && matrix[k].length);
    if (!keys.length) return [{}];
    let rows = [{}];
    for (const k of keys) {
        const next = [];
        for (const row of rows) {
            for (const v of matrix[k]) {
                next.push({ ...row, [k]: v });
            }
        }
        rows = next;
    }
    return rows;
}

/**
 * Build a test matrix from user ranges.
 */
function buildTestMatrix(spec = {}) {
    const matrix = {
        devBuyEth: spec.devBuyEth || [0.01, 0.03, 0.05],
        totalEth: spec.totalEth || [0.2, 0.4, 0.8],
        walletCount: spec.walletCount || [4, 8, 16],
        buyTiming: spec.buyTiming || ["immediate", "5s", "15s"],
        lpAllocationPct: spec.lpAllocationPct || [0, 10, 20],
        exitStrategy: spec.exitStrategy || ["early_recovery", "ladder", "trailing"],
        buyMode: spec.buyMode || ["burst", "organic"],
    };
    const combos = cartesian(matrix);
    return { matrix, combos, count: combos.length };
}

function rankResults(results) {
    const scored = (results || []).map((r) => {
        const deployed = Math.max(1e-9, Number(r.deployedEth) || 0);
        const net = Number(r.netProfitEth) || 0;
        const hours = Math.max(1 / 60, (Number(r.durationSec) || 60) / 3600);
        const profitPerEth = net / deployed;
        const profitPerHour = net / hours;
        const timeToRecover = Number(r.timeToRecoverSec) || null;
        const drawdown = Number(r.maxDrawdownPct) || 0;
        const gasPct = deployed > 0 ? (Number(r.gasEth) || 0) / deployed : 0;
        const failed = Number(r.failedTxEth) || 0;
        const turnover = Number(r.capitalTurnover) || (net > 0 ? 1 : 0);
        // Composite score (higher better)
        const score =
            profitPerEth * 40 +
            profitPerHour * 10 +
            (timeToRecover != null ? Math.max(0, 20 - timeToRecover / 60) : 0) -
            drawdown * 0.2 -
            gasPct * 15 -
            failed * 50 +
            turnover * 5;
        return {
            ...r,
            metrics: {
                profitPerEth,
                profitPerHour,
                timeToRecoverSec: timeToRecover,
                maxDrawdownPct: drawdown,
                gasPct,
                failedTxEth: failed,
                capitalTurnover: turnover,
                compositeScore: score,
            },
        };
    });
    scored.sort((a, b) => (b.metrics.compositeScore || 0) - (a.metrics.compositeScore || 0));
    return scored;
}

/**
 * Simple Bayesian-ish bandit: Thompson sampling over discretized configs.
 * Uses Beta priors on "win" (net > 0) and mean return.
 */
function recommendNextConfig(trials, explorationPct = 0.2) {
    const list = Array.isArray(trials) ? trials : [];
    if (list.length < 3) {
        return {
            source: "explore",
            confidence: 0.2,
            config: {
                devBuyEth: 0.025,
                totalEth: 0.4,
                walletCount: 8,
                lpAllocationPct: 10,
                exitStrategy: "early_recovery",
                buyMode: "organic",
                buyTiming: "5s",
                capitalRecoveryTargetX: 1.65,
                trailingPct: 18,
            },
            plainEnglish:
                "Not enough tests yet — running a balanced starter config while we learn.",
            predictedNetReturnPct: null,
        };
    }

    // Group by coarse key
    const groups = new Map();
    for (const t of list) {
        const c = t.config || {};
        const key = [
            Number(c.devBuyEth || 0).toFixed(3),
            Number(c.totalEth || 0).toFixed(2),
            Number(c.walletCount || 0),
            Number(c.lpAllocationPct || 0),
            c.exitStrategy || "early_recovery",
            c.buyMode || "organic",
        ].join("|");
        if (!groups.has(key)) {
            groups.set(key, { key, config: c, wins: 1, losses: 1, sumReturn: 0, n: 0 });
        }
        const g = groups.get(key);
        g.n += 1;
        const ret = Number(t.netProfitEth || 0) / Math.max(1e-9, Number(t.deployedEth) || 1);
        g.sumReturn += ret;
        if (ret > 0) g.wins += 1;
        else g.losses += 1;
    }

    const explore = Math.random() < explorationPct;
    let best = null;
    let bestSample = -Infinity;
    for (const g of groups.values()) {
        // Thompson sample from Beta(wins, losses)
        const sample = betaSample(g.wins, g.losses) + g.sumReturn / Math.max(1, g.n);
        if (sample > bestSample) {
            bestSample = sample;
            best = g;
        }
    }

    if (explore || !best) {
        const keys = [...groups.keys()];
        const pick = groups.get(keys[Math.floor(Math.random() * keys.length)]);
        return {
            source: "explore",
            confidence: 0.35,
            config: { ...pick.config, capitalRecoveryTargetX: 1.5, trailingPct: 18 },
            plainEnglish: "Exploring a less-tested setup so we don’t get stuck.",
            predictedNetReturnPct: (pick.sumReturn / Math.max(1, pick.n)) * 100,
        };
    }

    const avg = best.sumReturn / Math.max(1, best.n);
    const conf = Math.min(0.95, 0.4 + best.n * 0.05);
    return {
        source: "exploit",
        confidence: conf,
        config: {
            ...best.config,
            capitalRecoveryTargetX: 1.65,
            trailingPct: 18,
        },
        plainEnglish: `Model likes this setup from ${best.n} prior tests (confidence ${(conf * 100).toFixed(0)}%).`,
        predictedNetReturnPct: avg * 100,
    };
}

function betaSample(a, b) {
    // Approximate via gamma ratio
    const x = gammaSample(a);
    const y = gammaSample(b);
    return x / (x + y);
}

function gammaSample(k) {
    // Marsaglia for k >= 1; for k < 1 boost
    if (k < 1) return gammaSample(k + 1) * Math.pow(Math.random(), 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
        let x, v;
        do {
            x = randn();
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = Math.random();
        if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}

function randn() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Shadow strategies — paper P&L vs actual (simplified using MC path points).
 */
function runShadowStrategies({ deployedEth, path = [], actualNetEth }) {
    // path: [{ t, mcapX, realizableEth }]
    const shadows = {
        hold_to_end: 0,
        sell_10_each_50pct: 0,
        trailing_18: 0,
        early_recovery: 0,
    };
    if (!path.length) {
        return {
            actual: actualNetEth,
            shadows: Object.entries(shadows).map(([id, v]) => ({ id, netEth: v })),
            plainEnglish: "Not enough price path to score shadows.",
        };
    }
    const last = path[path.length - 1];
    shadows.hold_to_end = Number(last.realizableEth || 0) - deployedEth;

    let bag = deployedEth;
    let sold = 0;
    let nextX = 1.5;
    for (const p of path) {
        if (p.mcapX >= nextX && bag > 0) {
            const slice = bag * 0.1;
            sold += slice * (p.realizableEth / Math.max(bag, 1e-9)); // rough
            bag *= 0.9;
            nextX += 0.5;
        }
    }
    shadows.sell_10_each_50pct = sold + bag * 0.5 - deployedEth;

    let peak = 0;
    let trailExit = null;
    for (const p of path) {
        const rv = Number(p.realizableEth || 0);
        peak = Math.max(peak, rv);
        if (peak > 0 && rv < peak * 0.82 && trailExit == null) trailExit = rv;
    }
    shadows.trailing_18 = (trailExit != null ? trailExit : last.realizableEth) - deployedEth;

    for (const p of path) {
        if (Number(p.realizableEth || 0) >= deployedEth) {
            shadows.early_recovery = Number(p.realizableEth) - deployedEth;
            break;
        }
    }
    if (!shadows.early_recovery) shadows.early_recovery = last.realizableEth - deployedEth;

    const rows = Object.entries(shadows).map(([id, netEth]) => ({ id, netEth }));
    rows.sort((a, b) => b.netEth - a.netEth);
    return {
        actual: actualNetEth,
        shadows: rows,
        winner: rows[0],
        plainEnglish: `Best paper strategy was ${rows[0].id} (~${rows[0].netEth.toFixed(4)} ETH). Actual: ${(actualNetEth || 0).toFixed(4)} ETH.`,
    };
}

/**
 * Capital allocation suggestion (expected profit per +0.1 ETH).
 */
function allocateCapitalHint({ currentTokenEv, lpEv, newTestEv, keepEv = 0 }) {
    const options = [
        { id: "current_token", label: "Add to current token", ev: Number(currentTokenEv) || 0 },
        { id: "lp", label: "Add to LP", ev: Number(lpEv) || 0 },
        { id: "new_test", label: "Start new test", ev: Number(newTestEv) || 0 },
        { id: "keep", label: "Keep in funder", ev: Number(keepEv) || 0 },
    ].map((o) => ({ ...o, per01Eth: o.ev }));
    options.sort((a, b) => b.ev - a.ev);
    return {
        options,
        best: options[0],
        plainEnglish: `Next 0.1 ETH is best used for: ${options[0].label} (expected ~${options[0].ev.toFixed(4)} ETH).`,
    };
}

function createCampaignEngine({
    getStore,
    saveStore,
    chain,
    moneyDesk,
    hydrateProject,
    syncActiveProjectFromFlat,
    emptyProject,
    funder,
    findDev,
    buyersOnly,
    assertMoneyGate,
    projectCapital,
    broadcast,
    jobQueue,
    liveFunderEth,
}) {
    function logCampaign(c, msg, kind = "info") {
        c.logs = c.logs || [];
        c.logs.push({ t: Date.now(), msg, kind });
        if (c.logs.length > 300) c.logs = c.logs.slice(-300);
        broadcast({ type: "campaign_log", campaignId: c.id, entry: c.logs[c.logs.length - 1] });
    }

    function publicCampaign(c) {
        if (!c) return null;
        const tests = c.tests || [];
        const completed = tests.filter((t) => t.stage === "COMPLETE");
        const profitable = completed.filter((t) => Number(t.netProfitEth) > 0);
        const deployed = tests.reduce((a, t) => a + (Number(t.deployedEth) || 0), 0);
        const recovered = tests.reduce((a, t) => a + (Number(t.recoveredEth) || 0), 0);
        const durations = completed
            .map((t) => Number(t.durationSec) || 0)
            .filter((x) => x > 0);
        const avgMin =
            durations.length > 0
                ? durations.reduce((a, b) => a + b, 0) / durations.length / 60
                : null;
        return {
            id: c.id,
            name: c.name,
            status: c.status,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            config: c.config,
            counts: {
                total: tests.length,
                completed: completed.length,
                profitable: profitable.length,
                failed: tests.filter((t) => t.stage === "FAILED").length,
                running: tests.filter((t) =>
                    !["COMPLETE", "FAILED", "QUEUED", "SKIPPED"].includes(t.stage)
                ).length,
                queued: tests.filter((t) => t.stage === "QUEUED").length,
            },
            totals: {
                deployedEth: deployed,
                recoveredEth: recovered,
                netProfitEth: recovered - deployed + completed.reduce((a, t) => a + (Number(t.netProfitEth) || 0) - ((Number(t.recoveredEth) || 0) - (Number(t.deployedEth) || 0)), 0),
                // simpler net:
                netEth: recovered - (deployed - recovered > 0 ? 0 : 0),
            },
            // Cleaner net: sum of per-test netProfitEth
            netTestProfitEth: completed.reduce((a, t) => a + (Number(t.netProfitEth) || 0), 0),
            avgMinutesPerTest: avgMin,
            tests: tests.map((t) => ({
                id: t.id,
                projectId: t.projectId,
                label: t.label,
                stage: t.stage,
                config: t.config,
                deployedEth: t.deployedEth,
                recoveredEth: t.recoveredEth,
                netProfitEth: t.netProfitEth,
                error: t.error,
                durationSec: t.durationSec,
                shadows: t.shadows || null,
            })),
            recommendation: c.recommendation || null,
            ranking: c.ranking || null,
            recycle: c.recycle || null,
            logs: (c.logs || []).slice(-50),
        };
    }

    function createCampaign(body = {}) {
        const store = ensureCampaigns(getStore());
        const cfg = {
            ...defaultCampaignConfig(),
            ...(body || {}),
            template: { ...defaultCampaignConfig().template, ...(body.template || {}) },
            defaults: { ...defaultCampaignConfig().defaults, ...(body.defaults || {}) },
            earlyStop: { ...defaultCampaignConfig().earlyStop, ...(body.earlyStop || {}) },
        };
        if (body.useMatrix || body.matrix) {
            const built = buildTestMatrix(body.matrix || {});
            cfg.matrix = built.matrix;
            cfg._combos = built.combos;
            cfg.count = Math.min(100, Math.max(1, body.count || built.count));
        } else {
            cfg.count = Math.min(100, Math.max(1, Number(body.count) || cfg.count));
        }

        const id = `camp-${Date.now().toString(36)}`;
        const tests = [];
        const combos = cfg._combos || null;
        for (let i = 0; i < cfg.count; i++) {
            const combo = combos ? combos[i % combos.length] : {};
            const conf = { ...cfg.defaults, ...combo };
            const n = i + 1;
            const projectId = `camp_${id}_${n}`;
            const label = `${cfg.template.namePrefix}${n}`;
            tests.push({
                id: `${id}-t${n}`,
                projectId,
                label,
                stage: "QUEUED",
                config: conf,
                tokenName: `${cfg.template.namePrefix} ${n}`,
                tokenSymbol: `${cfg.template.symbolPrefix}${n}`.slice(0, 10).toUpperCase(),
                deployedEth: 0,
                recoveredEth: 0,
                netProfitEth: 0,
                startedAt: null,
                finishedAt: null,
                durationSec: null,
                path: [],
                shadows: null,
                error: null,
            });
            // Create empty project slot
            if (!store.projects) store.projects = {};
            store.projects[projectId] = emptyProject(projectId, label);
        }
        delete cfg._combos;

        const campaign = {
            id,
            name: cfg.name,
            status: "draft",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            config: cfg,
            tests,
            logs: [],
            recommendation: null,
            ranking: null,
            recycle: {
                startingCapitalEth: null,
                currentlyDeployedEth: 0,
                beingRecalledEth: 0,
                availableEth: null,
                strandedEth: 0,
            },
        };
        store.campaigns[id] = campaign;
        saveStore(store);
        logCampaign(campaign, `Created campaign with ${tests.length} tests`, "ok");
        return publicCampaign(campaign);
    }

    async function startCampaign(campaignId, opts = {}) {
        const store = ensureCampaigns(getStore());
        const c = store.campaigns[campaignId];
        if (!c) throw new Error("Campaign not found");
        if (c.status === "running") return publicCampaign(c);

        const funderEth = await liveFunderEth().catch(() => 0);
        c.recycle = c.recycle || {};
        c.recycle.startingCapitalEth = funderEth;
        c.recycle.availableEth = funderEth;
        c.status = "running";
        c.updatedAt = new Date().toISOString();
        if (opts.maxConcurrent) {
            c.config.maxConcurrent = Number(opts.maxConcurrent);
            jobQueue.setMaxConcurrent(c.config.maxConcurrent);
        } else {
            jobQueue.setMaxConcurrent(c.config.maxConcurrent || 3);
        }

        // Enqueue all QUEUED tests
        let enqueued = 0;
        for (const t of c.tests) {
            if (t.stage !== "QUEUED" && t.stage !== "PAUSED") continue;
            t.stage = "QUEUED";
            jobQueue.enqueue({
                id: t.id,
                campaignId: c.id,
                projectId: t.projectId,
                label: t.label,
                stage: "QUEUED",
                config: {
                    ...t.config,
                    campaignId: c.id,
                    testId: t.id,
                    tokenName: t.tokenName,
                    tokenSymbol: t.tokenSymbol,
                    template: c.config.template,
                    maxTestDurationSec:
                        t.config.maxTestDurationSec || c.config.maxTestDurationSec,
                    autoRecycle: c.config.autoRecycle !== false,
                    earlyStop: c.config.earlyStop,
                },
            });
            enqueued++;
        }
        saveStore(store);
        logCampaign(c, `Started — queued ${enqueued} tests · concurrency ${c.config.maxConcurrent}`, "ok");
        broadcast({ type: "campaign", campaign: publicCampaign(c) });
        return publicCampaign(c);
    }

    function pauseCampaign(campaignId) {
        const store = ensureCampaigns(getStore());
        const c = store.campaigns[campaignId];
        if (!c) throw new Error("Campaign not found");
        c.status = "paused";
        jobQueue.pauseAll();
        for (const t of c.tests) {
            if (!["COMPLETE", "FAILED", "SKIPPED"].includes(t.stage)) {
                // leave running ones; waiting stay queued
            }
        }
        saveStore(store);
        logCampaign(c, "Campaign paused — no new stages will start", "info");
        broadcast({ type: "campaign", campaign: publicCampaign(c) });
        return publicCampaign(c);
    }

    function resumeCampaign(campaignId) {
        const store = ensureCampaigns(getStore());
        const c = store.campaigns[campaignId];
        if (!c) throw new Error("Campaign not found");
        c.status = "running";
        jobQueue.resumeAll();
        saveStore(store);
        logCampaign(c, "Campaign resumed", "ok");
        broadcast({ type: "campaign", campaign: publicCampaign(c) });
        return publicCampaign(c);
    }

    function getCampaign(id) {
        const store = ensureCampaigns(getStore());
        return publicCampaign(store.campaigns[id] || null);
    }

    function listCampaigns() {
        const store = ensureCampaigns(getStore());
        return Object.values(store.campaigns)
            .map(publicCampaign)
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    function updateTest(campaignId, testId, patch) {
        const store = ensureCampaigns(getStore());
        const c = store.campaigns[campaignId];
        if (!c) return;
        const t = c.tests.find((x) => x.id === testId);
        if (!t) return;
        Object.assign(t, patch);
        c.updatedAt = new Date().toISOString();
        // Refresh ranking when a test completes
        if (patch.stage === "COMPLETE" || patch.stage === "FAILED") {
            const done = c.tests.filter((x) => x.stage === "COMPLETE");
            c.ranking = rankResults(done);
            store.campaignResults.push(
                ...done.filter((d) => d.id === testId).map((d) => ({
                    campaignId,
                    ...d,
                    at: new Date().toISOString(),
                }))
            );
            if (store.campaignResults.length > 500) {
                store.campaignResults = store.campaignResults.slice(-500);
            }
            store.optimizer.trials.push({
                config: t.config,
                netProfitEth: t.netProfitEth,
                deployedEth: t.deployedEth,
                durationSec: t.durationSec,
            });
            c.recommendation = recommendNextConfig(store.optimizer.trials);
            store.optimizer.lastRecommendation = c.recommendation;

            // Recycle snapshot
            refreshRecycle(c).catch(() => {});

            // Auto-complete campaign
            const pending = c.tests.some(
                (x) => !["COMPLETE", "FAILED", "SKIPPED"].includes(x.stage)
            );
            if (!pending) {
                c.status = "complete";
                logCampaign(c, "All tests finished", "ok");
            }
        }
        saveStore(store);
        broadcast({ type: "campaign", campaign: publicCampaign(c) });
    }

    async function refreshRecycle(c) {
        const funderEth = await liveFunderEth().catch(() => 0);
        const deployed = c.tests
            .filter((t) => !["COMPLETE", "FAILED", "SKIPPED", "QUEUED"].includes(t.stage))
            .reduce((a, t) => a + (Number(t.deployedEth) || Number(t.config?.totalEth) || 0), 0);
        const recalling = c.tests
            .filter((t) => t.stage === "RECALLING")
            .reduce((a, t) => a + (Number(t.deployedEth) || 0), 0);
        c.recycle = {
            startingCapitalEth: c.recycle?.startingCapitalEth ?? funderEth,
            currentlyDeployedEth: deployed,
            beingRecalledEth: recalling,
            availableEth: funderEth,
            strandedEth: Math.max(0, (c.recycle?.startingCapitalEth || 0) - funderEth - deployed),
        };
    }

    /**
     * Stage runner used by job-queue.
     */
    async function runStage(job, { push, shouldAbort }) {
        const store = ensureCampaigns(getStore());
        const campaignId = job.config.campaignId;
        const testId = job.config.testId;
        const c = store.campaigns[campaignId];
        const test = c?.tests?.find((t) => t.id === testId);

        const setStage = (stage) => {
            job.stage = stage;
            if (test) {
                test.stage = stage;
                updateTest(campaignId, testId, { stage });
            }
        };

        // Keep campaign test stage in sync
        if (test && test.stage !== job.stage) {
            test.stage = job.stage;
        }

        try {
            switch (job.stage) {
                case "PREFLIGHT":
                    return await stagePreflight(job, { push, shouldAbort, setStage, store, test, c });
                case "FUNDING":
                    return await stageFunding(job, { push, shouldAbort, setStage, store, test });
                case "LAUNCHING":
                    return await stageLaunching(job, { push, shouldAbort, setStage, store, test });
                case "BUYING":
                    return await stageBuying(job, { push, shouldAbort, setStage, store, test });
                case "MONITORING":
                    return await stageMonitoring(job, { push, shouldAbort, setStage, store, test, c });
                case "EXITING":
                    return await stageExiting(job, { push, shouldAbort, setStage, store, test });
                case "RECALLING":
                    return await stageRecalling(job, { push, shouldAbort, setStage, store, test, c });
                default:
                    return { stage: "FAILED", error: `Unknown stage ${job.stage}` };
            }
        } catch (e) {
            if (test) updateTest(campaignId, testId, { stage: "FAILED", error: e.message });
            return { stage: "FAILED", error: e.message || String(e) };
        }
    }

    async function stagePreflight(job, { push, setStage, store, test }) {
        setStage("PREFLIGHT");
        push("Preflight: create wallets + plan");
        hydrateProject(store, job.projectId);

        const conf = job.config;
        const walletCount = Math.min(50, Math.max(2, Number(conf.walletCount) || 6));

        // Ensure funder exists (shared)
        if (!funder()) {
            return { error: "No funder wallet — import funder before running campaigns" };
        }

        // Dev wallet
        let d = findDev();
        if (!d) {
            const w = chain.generateWallet();
            store.wallets.push({
                ...w,
                role: "dev",
                name: "Dev",
                buyAmountEth: 0,
                delaySec: 0,
            });
            d = store.wallets[store.wallets.length - 1];
            push(`Created Dev ${d.address}`);
        }

        // Buyers
        let buyers = buyersOnly();
        while (buyers.length < walletCount) {
            const w = chain.generateWallet();
            store.wallets.push({
                ...w,
                role: "buyer",
                name: `Buyer ${buyers.length + 1}`,
                buyAmountEth: 0,
                delaySec: 0,
            });
            buyers = buyersOnly();
        }

        const amounts = chain.allocateSplits(
            Number(conf.totalEth) || 0.25,
            walletCount,
            "ramp"
        );
        const baseDelay =
            conf.buyTiming === "15s" ? 15 : conf.buyTiming === "5s" ? 5 : 0;
        const list = buyersOnly().slice(0, walletCount);
        for (let i = 0; i < list.length; i++) {
            list[i].buyAmountEth = Number(amounts[i]) || 0;
            list[i].delaySec = baseDelay * i;
        }
        for (const w of buyersOnly().slice(walletCount)) {
            w.buyAmountEth = 0;
        }

        store.lastPlan = {
            totalEth: Number(conf.totalEth) || 0.25,
            walletCount,
            rows: list.map((w, i) => ({
                eth: w.buyAmountEth,
                delaySec: w.delaySec,
                name: w.name,
            })),
        };
        syncActiveProjectFromFlat(store);
        saveStore(store);

        const planned =
            list.reduce((a, w) => a + Number(w.buyAmountEth || 0), 0) +
            Number(conf.devBuyEth || 0.02);
        if (test) {
            test.deployedEth = planned;
            updateTest(job.config.campaignId, test.id, { deployedEth: planned });
        }

        // Money gate (warn only for campaigns — still block kill switch)
        try {
            const gate = await assertMoneyGate({ plannedEth: planned, action: "fund" });
            if (!gate.ok && gate.status === "kill") {
                return { error: gate.plainEnglish };
            }
            if (!gate.ok && gate.status === "reserve") {
                push(`Reserve warning: ${gate.plainEnglish}`, "info");
                // For batch tests, skip if can't fund safely
                return { stage: "SKIPPED", error: gate.plainEnglish };
            }
        } catch (_) {}

        if (test && !test.startedAt) {
            updateTest(job.config.campaignId, test.id, {
                startedAt: new Date().toISOString(),
            });
        }
        return { stage: "FUNDING" };
    }

    async function stageFunding(job, { push, setStage, store }) {
        setStage("FUNDING");
        hydrateProject(store, job.projectId);
        const f = funder();
        if (!f?.private_key && !f?.privateKey) return { error: "No funder key" };

        const conf = job.config;
        // Fund Dev
        const d = findDev();
        const devNeed = Number(conf.devBuyEth || 0.02) + 0.02;
        try {
            push(`Funding Dev ~${devNeed} ETH`);
            await chain.transferEth(
                { private_key: f.private_key || f.privateKey },
                d.address,
                String(devNeed)
            );
        } catch (e) {
            return { error: `Dev fund failed: ${e.message}` };
        }

        const destinations = buyersOnly()
            .filter((w) => Number(w.buyAmountEth) > 0)
            .map((w) => ({
                address: w.address,
                amountEth: Number(w.buyAmountEth),
                name: w.name,
            }));
        if (!destinations.length) return { error: "No buyers to fund" };

        push(`Funding ${destinations.length} buyers (hops=1 for speed)`);
        try {
            await chain.disperseWithHops(
                { private_key: f.private_key || f.privateKey, address: f.address },
                destinations,
                {
                    hops: 1,
                    delayMsMin: 500,
                    delayMsMax: 1500,
                    onProgress: (ev) => {
                        if (ev.type === "funded" || ev.type === "delivered" || ev.msg) {
                            push(ev.msg || ev.type, "info");
                        }
                    },
                }
            );
        } catch (e) {
            return { error: `Funding failed: ${e.message}` };
        }
        syncActiveProjectFromFlat(store);
        saveStore(store);
        return { stage: "LAUNCHING" };
    }

    async function stageLaunching(job, { push, setStage, store, test }) {
        setStage("LAUNCHING");
        hydrateProject(store, job.projectId);
        const d = findDev();
        if (!d) return { error: "No Dev wallet" };
        const conf = job.config;
        const tpl = conf.template || {};
        push(`Launching $${conf.tokenSymbol || test?.tokenSymbol}`);
        const launched = await chain.launchToken(
            { private_key: d.private_key || d.privateKey, address: d.address },
            {
                name: conf.tokenName || test?.tokenName,
                symbol: conf.tokenSymbol || test?.tokenSymbol,
                metadataURI: tpl.metadataURI || "",
                description: tpl.description || "",
                twitter: tpl.twitter || "",
                website: tpl.website || "",
                telegram: tpl.telegram || "",
                buyEth: Number(conf.devBuyEth || 0.02),
            }
        );
        if (launched?.error) return { error: launched.error };
        store.lastToken = launched.token;
        if (store.projects[job.projectId]) {
            store.projects[job.projectId].token = launched.token;
            store.projects[job.projectId].status = "live";
        }
        const cap = projectCapital(job.projectId);
        cap.deployedEth = Number(test?.deployedEth || conf.totalEth || 0);
        try {
            const mc = await chain.resolveLiveMarketCap(launched.token);
            if (mc?.mcapUsd) cap.launchMcapUsd = mc.mcapUsd;
        } catch (_) {}
        syncActiveProjectFromFlat(store);
        saveStore(store);
        push(`Launched ${launched.token}`, "ok");
        job.result = { ...(job.result || {}), token: launched.token, launchHash: launched.hash };
        if (test) {
            updateTest(job.config.campaignId, test.id, {
                token: launched.token,
            });
        }
        await chain.sleep(800);
        return { stage: "BUYING", result: { token: launched.token } };
    }

    async function stageBuying(job, { push, setStage, store }) {
        setStage("BUYING");
        hydrateProject(store, job.projectId);
        const token = job.result?.token || store.lastToken;
        if (!chain.isEvmAddress(token || "")) return { error: "No token to buy" };
        const conf = job.config;
        const list = buyersOnly().filter((w) => Number(w.buyAmountEth) > 0);
        if (!list.length) return { error: "No funded buyers" };

        const timing = conf.buyTiming || "immediate";
        if (timing === "5s") await chain.sleep(5000);
        if (timing === "15s") await chain.sleep(15000);

        push(`Buying with ${list.length} wallets · mode=${conf.buyMode || "organic"}`);
        const results = await chain.multiBuy(
            list.map((w) => ({
                private_key: w.private_key,
                address: w.address,
                name: w.name,
                buyAmountEth: w.buyAmountEth,
                delaySec: w.delaySec || 0,
            })),
            token,
            {
                mode: conf.buyMode === "burst" ? "burst" : conf.buyMode === "sequential" ? "sequential" : "organic",
                organicPaceSec: 6,
                organicQuietSec: 8,
                organicMaxDipPct: 0.12,
                shouldAbort: () => job.abort,
                onProgress: (ev) => {
                    if (ev.type === "bought") push(`bought ${ev.name || ev.wallet}`, "ok");
                    if (ev.type === "error") push(`buy err ${ev.error}`, "err");
                },
            }
        );
        const ok = results.filter((r) => r.hash).length;
        push(`Buys done · ${ok}/${list.length}`, ok ? "ok" : "err");
        return { stage: "MONITORING", result: { buyResults: results, token } };
    }

    async function stageMonitoring(job, { push, setStage, store, test, c }) {
        setStage("MONITORING");
        hydrateProject(store, job.projectId);
        const token = job.result?.token || store.lastToken;
        const conf = job.config;
        const maxSec = Number(conf.maxTestDurationSec || 900);
        const early = conf.earlyStop || {};
        const started = Date.now();
        let lastProgress = Date.now();
        let peakRv = 0;
        const path = [];
        const deployed = Number(test?.deployedEth || conf.totalEth || 0);

        push(`Monitoring up to ${Math.round(maxSec / 60)} min · exit=${conf.exitStrategy}`);

        while (!job.abort && Date.now() - started < maxSec * 1000) {
            let rv = 0;
            let mcapX = 1;
            try {
                const mc = await chain.resolveLiveMarketCap(token);
                const launchMc = projectCapital(job.projectId).launchMcapUsd || mc.mcapUsd;
                mcapX = launchMc > 0 ? mc.mcapUsd / launchMc : 1;
                // Rough realizable: sample sell of all buyer bags via preview-ish
                const buyers = buyersOnly();
                for (const w of buyers.slice(0, 8)) {
                    try {
                        const { balance } = await chain.getTokenBalanceRaw(
                            w.address,
                            token
                        );
                        if (balance > 0n) {
                            const amt = ethers.formatUnits(balance, 18);
                            const q = await chain.quoteSell(token, amt);
                            rv += Number(q.ethOut || 0);
                        }
                    } catch (_) {}
                }
            } catch (_) {}

            peakRv = Math.max(peakRv, rv);
            path.push({ t: Date.now(), mcapX, realizableEth: rv });
            if (test) test.path = path.slice(-60);

            // Exit triggers
            const targetX = Number(conf.capitalRecoveryTargetX || 1);
            if (conf.exitStrategy === "early_recovery" && rv >= deployed * targetX) {
                push(`Recovery target hit · RV ${rv.toFixed(4)} ETH`, "ok");
                break;
            }
            if (conf.exitStrategy === "trailing" && peakRv > 0 && rv < peakRv * 0.82) {
                push(`Trailing stop · peak ${peakRv.toFixed(4)} → ${rv.toFixed(4)}`, "info");
                break;
            }
            if (conf.exitStrategy === "ladder" && mcapX >= 2 && rv >= deployed * 0.5) {
                push(`Ladder rung · 2× MC and 50% capital back`, "ok");
                break;
            }

            // Early stop: no progress
            if (rv > peakRv * 0.98) lastProgress = Date.now();
            if (
                early.noProgressSec &&
                Date.now() - lastProgress > early.noProgressSec * 1000 &&
                Date.now() - started > 120000
            ) {
                push("Early stop — no useful progress", "info");
                break;
            }

            // Graduation unreachable heuristic: mcap stuck & rv << deployed after half time
            if (
                Date.now() - started > maxSec * 500 &&
                rv < deployed * 0.4 &&
                mcapX < 1.2
            ) {
                push("Early stop — underperforming vs benchmark", "info");
                break;
            }

            await chain.sleep(15000);
            push(`Monitor · RV≈${rv.toFixed(4)} ETH · MC×${mcapX.toFixed(2)}`);
        }

        job.result = { ...(job.result || {}), path, peakRv };
        return { stage: "EXITING" };
    }

    async function stageExiting(job, { push, setStage, store, test }) {
        setStage("EXITING");
        hydrateProject(store, job.projectId);
        const token = job.result?.token || store.lastToken;
        const list = buyersOnly();
        push(`Exiting ${list.length} wallets`);
        try {
            const results = await chain.multiSell(list, token, {
                mode: "sequential",
                percent: 100,
                delayMs: 400,
                onProgress: (ev) => {
                    if (ev.type === "sold") push(`sold ${ev.name || ev.wallet}`, "ok");
                },
            });
            const ethOut = results.reduce(
                (a, r) => a + (Number(r.quotedEth || r.ethOut) || 0),
                0
            );
            push(`Exit done · ~${ethOut.toFixed(4)} ETH`, "ok");
            job.result = { ...(job.result || {}), exitEth: ethOut, sellResults: results };
        } catch (e) {
            push(`Exit error: ${e.message}`, "err");
        }
        return { stage: "RECALLING" };
    }

    async function stageRecalling(job, { push, setStage, store, test, c }) {
        setStage("RECALLING");
        hydrateProject(store, job.projectId);
        const f = funder();
        if (!f) return { error: "No funder for recall" };

        push("Recalling ETH → funder (buyers + Dev)");
        const sources = [
            ...buyersOnly(),
            findDev(),
        ].filter(Boolean);

        let gained = 0;
        try {
            const r = await chain.recallEth(sources, f.address, {
                unwrapWeth: true,
                gasReserveEth: 0.00015,
                onProgress: (ev) => {
                    if (ev.type === "recalled") push(`recalled ${ev.wallet}`, "ok");
                },
            });
            gained = Number(r?.gained || r?.totalEth || 0);
            if (!gained && Array.isArray(r)) {
                gained = r.reduce((a, x) => a + (Number(x.eth) || 0), 0);
            }
        } catch (e) {
            push(`Recall warn: ${e.message}`, "info");
        }

        // Hop recover for this project
        try {
            const hops = (store.hopVault || []).filter((h) => !h.recovered);
            if (hops.length) {
                await chain.recallEth(
                    hops.map((h) => ({
                        private_key: h.private_key || h.privateKey,
                        address: h.address,
                    })),
                    f.address,
                    { unwrapWeth: true, gasReserveEth: 0.0001 }
                );
            }
        } catch (_) {}

        const deployed = Number(test?.deployedEth || job.config.totalEth || 0);
        const exitEth = Number(job.result?.exitEth || 0);
        const recovered = Math.max(gained, exitEth);
        const net = recovered - deployed;
        const startedAt = test?.startedAt ? new Date(test.startedAt).getTime() : Date.now();
        const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

        const shadows = runShadowStrategies({
            deployedEth: deployed,
            path: job.result?.path || test?.path || [],
            actualNetEth: net,
        });

        const cap = projectCapital(job.projectId);
        cap.recoveredEth = Number(cap.recoveredEth || 0) + recovered;

        if (test) {
            updateTest(job.config.campaignId, test.id, {
                stage: "COMPLETE",
                recoveredEth: recovered,
                netProfitEth: net,
                finishedAt: new Date().toISOString(),
                durationSec,
                shadows,
                error: null,
            });
        }

        push(
            `COMPLETE · deployed ${deployed.toFixed(4)} · recovered ~${recovered.toFixed(4)} · net ${net >= 0 ? "+" : ""}${net.toFixed(4)} ETH`,
            net >= 0 ? "ok" : "err"
        );
        push(shadows.plainEnglish, "info");

        syncActiveProjectFromFlat(store);
        if (store.projects[job.projectId]) {
            store.projects[job.projectId].status = "archived";
        }
        saveStore(store);

        // Auto-start next is inherent via job queue
        return { stage: "COMPLETE", result: { recoveredEth: recovered, netProfitEth: net, shadows } };
    }

    // Command center metrics
    function commandCenter() {
        const store = ensureCampaigns(getStore());
        const all = store.campaignResults || [];
        const recent = all.slice(-100);
        const completed = recent.filter((t) => t.stage === "COMPLETE" || t.netProfitEth != null);
        const deployed = completed.reduce((a, t) => a + (Number(t.deployedEth) || 0), 0);
        const net = completed.reduce((a, t) => a + (Number(t.netProfitEth) || 0), 0);
        const wins = completed.filter((t) => Number(t.netProfitEth) > 0).length;
        const hours =
            completed.reduce((a, t) => a + (Number(t.durationSec) || 0), 0) / 3600 || 1;
        const ranking = rankResults(completed).slice(0, 10);
        const rec = store.optimizer?.lastRecommendation || recommendNextConfig(store.optimizer?.trials || []);
        return {
            realizedNetProfitEth: net,
            profitPerLaunchEth: completed.length ? net / completed.length : 0,
            profitPerEthDeployed: deployed > 0 ? net / deployed : 0,
            profitPerEthHour: net / Math.max(hours, 0.01),
            capitalTurnoverPerDay: null,
            avgTimeToRecoverSec:
                completed
                    .map((t) => t.durationSec)
                    .filter(Boolean)
                    .reduce((a, b, _, arr) => a + b / arr.length, 0) || null,
            winRate: completed.length ? wins / completed.length : 0,
            testsCompleted: completed.length,
            ranking,
            recommendation: rec,
            allocation: allocateCapitalHint({
                currentTokenEv: 0.011,
                lpEv: 0.018,
                newTestEv: rec.predictedNetReturnPct
                    ? (rec.predictedNetReturnPct / 100) * 0.1
                    : 0.027,
                keepEv: 0,
            }),
            queue: jobQueue.snapshot(),
            campaigns: listCampaigns().slice(0, 10),
            plainEnglish:
                completed.length === 0
                    ? "No finished tests yet — create a campaign and hit Start."
                    : `Across ${completed.length} tests: net ${net >= 0 ? "+" : ""}${net.toFixed(3)} ETH · win rate ${((wins / completed.length) * 100).toFixed(0)}% · best next: ${rec.plainEnglish}`,
        };
    }

    return {
        STAGES,
        defaultCampaignConfig,
        buildTestMatrix,
        rankResults,
        recommendNextConfig,
        runShadowStrategies,
        allocateCapitalHint,
        createCampaign,
        startCampaign,
        pauseCampaign,
        resumeCampaign,
        getCampaign,
        listCampaigns,
        publicCampaign,
        runStage,
        commandCenter,
        ensureCampaigns,
        updateTest,
    };
}

module.exports = {
    createCampaignEngine,
    defaultCampaignConfig,
    buildTestMatrix,
    rankResults,
    recommendNextConfig,
    runShadowStrategies,
    allocateCapitalHint,
    ensureCampaigns,
    STAGES,
    EXIT_STRATEGIES,
    BUY_TIMINGS,
};
