/**
 * Playbooks — one-click recipe sequences for launch → support → airdrop → guards → peel.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "..", "data", "playbooks.json");

const TEMPLATES = [
    {
        id: "stealth-organic",
        name: "Stealth organic",
        desc: "20m organic pump → airdrop top rival buyers → arm TP/SL → exit-liquidity peel",
        steps: [
            { type: "wait", minutes: 1, label: "Settle after launch" },
            {
                type: "chart_pattern",
                patternId: "organic-pump",
                durationMin: 20,
                ethPerTrade: 0.005,
            },
            {
                type: "airdrop",
                mode: "fixed",
                amountEach: "50",
                limit: 40,
                source: "competitor",
            },
            {
                type: "price_guard",
                takeProfitUsd: null,
                stopLossPct: 40,
                sellPct: 100,
            },
            { type: "exit_radar", minEth: 0.03, windowSec: 180, peelPct: 25 },
        ],
    },
    {
        id: "fast-siphon",
        name: "Fast competitor siphon",
        desc: "Immediate airdrop to competitor buyers + bump support + stagger peel when hot",
        steps: [
            {
                type: "airdrop",
                mode: "tiered",
                totalAmount: "5000",
                limit: 60,
                source: "competitor",
            },
            {
                type: "chart_pattern",
                patternId: "bump",
                durationMin: 15,
                ethPerTrade: 0.008,
            },
            { type: "exit_radar", minEth: 0.02, windowSec: 120, peelPct: 35 },
        ],
    },
    {
        id: "diamond-only",
        name: "Diamond CRM drip",
        desc: "Airdrop only CRM diamond/whale tags on our tape, then arm guards",
        steps: [
            {
                type: "airdrop",
                mode: "fixed",
                amountEach: "100",
                limit: 30,
                source: "our",
                crmOnly: ["diamond", "whale"],
            },
            {
                type: "price_guard",
                takeProfitUsd: null,
                stopLossPct: 35,
                sellPct: 50,
            },
        ],
    },
];

function empty() {
    return { runs: [], updatedAt: null };
}

function load() {
    try {
        if (!fs.existsSync(DATA_FILE)) return empty();
        return { ...empty(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    } catch (_) {
        return empty();
    }
}

function save(store) {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

function listTemplates() {
    return TEMPLATES;
}

function startRun(opts = {}) {
    const tpl = TEMPLATES.find((t) => t.id === opts.templateId);
    if (!tpl) throw new Error("unknown playbook template");
    const store = load();
    const id = crypto.randomBytes(6).toString("hex");
    const run = {
        id,
        templateId: tpl.id,
        name: tpl.name,
        token: opts.token || null,
        competitorToken: opts.competitorToken || null,
        status: "queued",
        stepIndex: 0,
        steps: tpl.steps.map((s) => ({ ...s, status: "pending", result: null })),
        armedLive: !!opts.armedLive,
        createdAt: new Date().toISOString(),
        log: [],
    };
    store.runs.unshift(run);
    store.runs = store.runs.slice(0, 30);
    save(store);
    return run;
}

function getRun(id) {
    return load().runs.find((r) => r.id === id) || null;
}

function listRuns() {
    return load().runs || [];
}

function stopRun(id) {
    const store = load();
    const r = store.runs.find((x) => x.id === id);
    if (r && (r.status === "running" || r.status === "queued")) {
        r.status = "stopped";
        r.finishedAt = new Date().toISOString();
        save(store);
    }
    return r;
}

function patchRun(id, fn) {
    const store = load();
    const r = store.runs.find((x) => x.id === id);
    if (!r) return null;
    fn(r);
    save(store);
    return r;
}

/**
 * Advance one playbook step. Callers (Betty or route) execute side effects
 * and then mark step done via completeStep.
 */
function markRunning(id) {
    return patchRun(id, (r) => {
        if (r.status === "queued") r.status = "running";
        const step = r.steps[r.stepIndex];
        if (step) step.status = "running";
    });
}

function completeStep(id, result) {
    return patchRun(id, (r) => {
        const step = r.steps[r.stepIndex];
        if (step) {
            step.status = "done";
            step.result = result || null;
        }
        r.log.push({
            at: new Date().toISOString(),
            step: r.stepIndex,
            result,
        });
        r.stepIndex += 1;
        if (r.stepIndex >= r.steps.length) {
            r.status = "completed";
            r.finishedAt = new Date().toISOString();
        }
    });
}

function failStep(id, error) {
    return patchRun(id, (r) => {
        const step = r.steps[r.stepIndex];
        if (step) {
            step.status = "failed";
            step.result = { error };
        }
        r.status = "failed";
        r.error = error;
        r.finishedAt = new Date().toISOString();
    });
}

module.exports = {
    TEMPLATES,
    listTemplates,
    startRun,
    getRun,
    listRuns,
    stopRun,
    markRunning,
    completeStep,
    failStep,
    patchRun,
    load,
};
