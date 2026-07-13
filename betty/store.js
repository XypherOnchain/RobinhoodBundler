/**
 * Shared Betty JSON store (automation jobs, guards, tape, events).
 * Used by betty/index.js (PM2) and server.js routes.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const BETTY_FILE = path.join(DATA_DIR, "betty.json");

function emptyStore() {
    return {
        automationJobs: [],
        automationEvents: [],
        priceGuards: [],
        tape: {},
        signals: [],
        actions: [],
        alerts: [],
        agentStatus: {},
        updatedAt: null,
    };
}

function load() {
    try {
        if (!fs.existsSync(BETTY_FILE)) return emptyStore();
        const raw = JSON.parse(fs.readFileSync(BETTY_FILE, "utf8"));
        return { ...emptyStore(), ...raw };
    } catch (_) {
        return emptyStore();
    }
}

function save(store) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    store.updatedAt = new Date().toISOString();
    const tmp = BETTY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, BETTY_FILE);
}

function mutate(fn) {
    const store = load();
    const out = fn(store) || store;
    save(out);
    return out;
}

function nanoid() {
    return crypto.randomBytes(8).toString("hex");
}

function pushEvent(store, jobId, type, detail, txHash, simulated) {
    store.automationEvents = store.automationEvents || [];
    store.automationEvents.unshift({
        id: nanoid(),
        jobId,
        type,
        detail: detail || {},
        txHash: txHash || null,
        simulated: !!simulated,
        at: new Date().toISOString(),
    });
    store.automationEvents = store.automationEvents.slice(0, 500);
}

function pushAlert(store, kind, msg) {
    store.alerts = store.alerts || [];
    store.alerts.unshift({ kind, msg, at: new Date().toISOString() });
    store.alerts = store.alerts.slice(0, 80);
}

module.exports = {
    BETTY_FILE,
    emptyStore,
    load,
    save,
    mutate,
    nanoid,
    pushEvent,
    pushAlert,
};
