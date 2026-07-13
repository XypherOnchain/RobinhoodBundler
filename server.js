require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const chain = require("./blockchain");
const apestore = require("./launchpads/apestore");
const koa = require("./launchpads/koa");
const privacy = require("./funding/privacy");
const moneyDesk = require("./money-desk");
const { createJobQueue } = require("./job-queue");
const { createCampaignEngine } = require("./campaign-engine");
const { createBooster } = require("./tx-booster");
const { createVolumeBooster } = require("./volume-booster");
const { createTrendBooster } = require("./trend-booster");
const { createMmBooster } = require("./mm-booster");


const PORT = Number(process.env.PORT || 3847);
// bundler = buy/fund/sell · sniper = pairs/snipe · txbot = TX booster (separate processes)
const DASHBOARD_MODE = String(
    process.env.DASHBOARD_MODE || process.env.MODE || "bundler"
)
    .toLowerCase()
    .trim();
const IS_SNIPER_HOST =
    DASHBOARD_MODE === "sniper" ||
    process.env.ENABLE_SNIPER === "1" ||
    process.env.ENABLE_SNIPER === "true";
const IS_TXBOT_HOST =
    DASHBOARD_MODE === "txbot" ||
    process.env.ENABLE_TXBOT === "1" ||
    process.env.ENABLE_TXBOT === "true";
const IS_BUNDLER_HOST = !IS_SNIPER_HOST && !IS_TXBOT_HOST;
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(
    DATA_DIR,
    IS_SNIPER_HOST
        ? "sniper.json"
        : IS_TXBOT_HOST
          ? "txbot.json"
          : "dashboard.json"
);
const EXPLORER = "https://robinhoodchain.blockscout.com";

function resolveLaunchpad(raw) {
    const v = String(raw || store?.launchpad || "noxa")
        .toLowerCase()
        .trim();
    if (v === "apestore" || v === "ape" || v === "ape.store") return "apestore";
    if (v === "koa" || v === "koa.fi" || v === "koafactory") return "koa";
    return "noxa";
}

function launchpadLabel(pad) {
    if (pad === "apestore") return "ApeStore";
    if (pad === "koa") return "KOA";
    return "NOXA";
}

const MAX_BUNDLE_WALLETS = chain.MAX_BUNDLE_WALLETS || 250;
const BALANCE_CACHE_MS = 45_000;
const BALANCE_RPC_TIMEOUT_MS = 2500;
const balanceCache = new Map(); // address -> { bal, at }
let balanceRefreshRunning = false;

async function getCachedBalance(address, { force = false } = {}) {
    const key = String(address || "").toLowerCase();
    const hit = balanceCache.get(key);
    if (!force && hit && Date.now() - hit.at < BALANCE_CACHE_MS) {
        return hit.bal;
    }
    // Fast path: never block the UI request path on RPC
    if (!force) {
        return hit ? hit.bal : null;
    }
    try {
        const bal = await Promise.race([
            chain.getWalletBalance(address),
            new Promise((_, rej) =>
                setTimeout(
                    () => rej(new Error("balance timeout")),
                    BALANCE_RPC_TIMEOUT_MS
                )
            ),
        ]);
        balanceCache.set(key, { bal, at: Date.now() });
        return bal;
    } catch (_) {
        if (hit) return hit.bal;
        return null;
    }
}

/** Background balance sweep — never awaited by /api/state. (sync kick; async work inside) */
function kickBalanceRefresh(addresses = null) {
    if (balanceRefreshRunning) return { started: false, running: true };
    const list =
        addresses && addresses.length
            ? addresses
            : (typeof store !== "undefined" && store?.wallets
                  ? store.wallets
                        .filter((w) => {
                            // Bundler: skip infra wallets that live on other hosts
                            if (IS_BUNDLER_HOST && w.role === "sniper")
                                return false;
                            if (IS_BUNDLER_HOST && w.role === "txbot")
                                return false;
                            return !!w.address;
                        })
                        .map((w) => w.address)
                  : []);
    if (!list.length) return { started: false, running: false };
    balanceRefreshRunning = true;
    setImmediate(() => {
        refreshAndBroadcastBalances(list)
            .catch((e) =>
                console.warn("balance refresh failed:", e.message || e)
            )
            .finally(() => {
                balanceRefreshRunning = false;
            });
    });
    return { started: true, running: true, count: list.length };
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
        return {
            wallets: [],
            lastToken: "",
            launchpad: "noxa",
            lastPlan: null,
            lastSellPlan: null,
            lastSellPreview: null,
            sellHistory: [],
            txBot: {
                token: "",
                speed: "medium",
                buyEth: "0.0000005",
                jitterBuy: true,
                walletIndex: null,
            },
            volumeBot: {
                token: "",
                speed: "medium",
                targetUsd: 2.5,
                jitterPct: 5,
                maxLossUsd: 0.08,
                walletIndex: null,
            },
            snipes: [],
            hopVault: [],
            snipeConfig: {
                enabled: false,
                amountEth: 0.005,
                walletIndex: null,
                takeProfitX: 1.6, // first partial TP
                takeProfit2X: 3, // full exit if still holding
                stopLossPct: 35,
                trailPct: 25, // sell remainder if down this % from peak after partial
                partialSellPct: 50, // % sold at first TP — hold the rest
                maxAgeSec: 90,
                maxInitialBuyEth: 1.0,
                cooldownMs: 1500,
                sellPercent: 100,
                autoSell: true,
                maxOpenPositions: 40,
                skipSerialCreators: false,
                minEntryMcapEth: 0,
                maxEntryMcapEth: 0,
                // Always leave this much ETH after buys so sells can fire
                sellGasReserveEth: 0.0004,
                // Dump immediately when creator sells into the pool
                exitOnDevSell: true,
                devSellMinEth: 0.001,
                skipNoSocials: true,
                skipLowAthSerials: true,
                minCreatorAthEth: 2,
                qualityMode: true,
                requireDevBuy: true,
                requireSocials: true,
                requireWebsite: false,
                skipDuplicateNames: true,
                skipRecycledSocials: true,
                minNarrativeScore: 3,
                minQualityScore: 6,
                // Bank small at 1x/2x/3x, hold rest for 5x+
                tpLadder: [
                    { x: 1.0, pct: 15 },
                    { x: 2.0, pct: 20 },
                    { x: 3.0, pct: 25 },
                    { x: 5.0, pct: 0 }, // 0 = hold remainder; trail/SL still apply
                ],
            },
            ...raw,
            snipeConfig: {
                enabled: false,
                amountEth: 0.005,
                walletIndex: null,
                takeProfitX: 1.6,
                takeProfit2X: 3,
                stopLossPct: 35,
                trailPct: 25,
                partialSellPct: 50,
                maxAgeSec: 90,
                maxInitialBuyEth: 1.0,
                cooldownMs: 1500,
                sellPercent: 100,
                autoSell: true,
                maxOpenPositions: 40,
                skipSerialCreators: true,
                minEntryMcapEth: 0,
                maxEntryMcapEth: 0,
                sellGasReserveEth: 0.0004,
                exitOnDevSell: true,
                devSellMinEth: 0.001,
                skipNoSocials: true,
                skipLowAthSerials: true,
                minCreatorAthEth: 2,
                qualityMode: true,
                requireDevBuy: true,
                requireSocials: true,
                requireWebsite: false,
                skipDuplicateNames: true,
                skipRecycledSocials: true,
                minNarrativeScore: 3,
                minQualityScore: 6,
                tpLadder: [
                    { x: 1.0, pct: 15 },
                    { x: 2.0, pct: 20 },
                    { x: 3.0, pct: 25 },
                    { x: 5.0, pct: 0 },
                ],
                ...(raw.snipeConfig || {}),
            },
            snipes: Array.isArray(raw.snipes) ? raw.snipes : [],
            hopVault: Array.isArray(raw.hopVault) ? raw.hopVault : [],
            volumeBot: {
                token: "",
                speed: "medium",
                targetUsd: 2.5,
                jitterPct: 5,
                maxLossUsd: 0.08,
                walletIndex: null,
                ...(raw.volumeBot || {}),
            },
        };
    } catch {
        return {
            wallets: [],
            lastToken: "",
            lastPlan: null,
            lastSellPlan: null,
            lastSellPreview: null,
            snipes: [],
            hopVault: [],
            volumeBot: {
                token: "",
                speed: "medium",
                targetUsd: 2.5,
                jitterPct: 5,
                maxLossUsd: 0.08,
                walletIndex: null,
            },
            snipeConfig: {
                enabled: false,
                amountEth: 0.005,
                walletIndex: null,
                takeProfitX: 1.6,
                takeProfit2X: 3,
                stopLossPct: 35,
                trailPct: 25,
                partialSellPct: 50,
                maxAgeSec: 90,
                maxInitialBuyEth: 1.0,
                cooldownMs: 1500,
                sellPercent: 100,
                autoSell: true,
                maxOpenPositions: 40,
                skipSerialCreators: true,
                minEntryMcapEth: 0,
                maxEntryMcapEth: 0,
                sellGasReserveEth: 0.0004,
                exitOnDevSell: true,
                devSellMinEth: 0.001,
                skipNoSocials: true,
                skipLowAthSerials: true,
                minCreatorAthEth: 2,
                qualityMode: true,
                requireDevBuy: true,
                requireSocials: true,
                requireWebsite: false,
                skipDuplicateNames: true,
                skipRecycledSocials: true,
                minNarrativeScore: 3,
                minQualityScore: 6,
                tpLadder: [
                    { x: 1.0, pct: 15 },
                    { x: 2.0, pct: 20 },
                    { x: 3.0, pct: 25 },
                    { x: 5.0, pct: 0 },
                ],
            },
        };
    }
}
const INFRA_ROLES = new Set(["funder", "sniper", "txbot"]);

function isInfraWallet(w) {
    const role = String(w?.role || "buyer").toLowerCase();
    return INFRA_ROLES.has(role);
}

function emptyProject(id, label) {
    return {
        id,
        label: label || id,
        status: "draft",
        token: "",
        wallets: [],
        lastPlan: null,
        lastSellPlan: null,
        lastSellPreview: null,
        lastBuyFailures: [],
        hopVault: [],
    };
}

/** Push flat working fields (buyers/plans/hops) into the active project slot. */
function syncActiveProjectFromFlat(s) {
    if (!IS_BUNDLER_HOST) return;
    if (!s?.projects || !s.activeProjectId) return;
    const p = s.projects[s.activeProjectId];
    if (!p) return;
    const all = Array.isArray(s.wallets) ? s.wallets : [];
    const infra = all.filter(isInfraWallet);
    const buyers = all.filter((w) => !isInfraWallet(w));
    s.infraWallets = infra;
    p.wallets = buyers;
    p.token = s.lastToken || "";
    p.lastPlan = s.lastPlan || null;
    p.lastSellPlan = s.lastSellPlan || null;
    p.lastSellPreview = s.lastSellPreview || null;
    p.lastBuyFailures = Array.isArray(s.lastBuyFailures) ? s.lastBuyFailures : [];
    p.hopVault = Array.isArray(s.hopVault) ? s.hopVault : [];
    if (p.token || buyers.length) {
        if (p.status !== "live") p.status = buyers.length ? "live" : p.status;
    }
}

/** Load a project into the flat working set used by existing bundler routes. */
function hydrateProject(s, projectId) {
    if (!s?.projects?.[projectId]) {
        throw new Error(`Unknown project: ${projectId}`);
    }
    // Persist current tab first
    syncActiveProjectFromFlat(s);
    const p = s.projects[projectId];
    s.activeProjectId = projectId;
    const infra =
        Array.isArray(s.infraWallets) && s.infraWallets.length
            ? s.infraWallets
            : (s.wallets || []).filter(isInfraWallet);
    s.infraWallets = infra;
    s.wallets = [...infra, ...(Array.isArray(p.wallets) ? p.wallets : [])];
    s.lastToken = p.token || "";
    s.lastPlan = p.lastPlan || null;
    s.lastSellPlan = p.lastSellPlan || null;
    s.lastSellPreview = p.lastSellPreview || null;
    s.lastBuyFailures = Array.isArray(p.lastBuyFailures) ? p.lastBuyFailures : [];
    s.hopVault = Array.isArray(p.hopVault) ? p.hopVault : [];
    return p;
}

/**
 * One-time: wrap legacy flat launch into projects.token1 + empty token2.
 * Runtime keeps store.wallets = infra + active project buyers.
 */
function migrateStoreToProjects(s) {
    if (!IS_BUNDLER_HOST) return { migrated: false, store: s };
    if (s.projects && typeof s.projects === "object" && s.activeProjectId) {
        // Ensure infraWallets + flat wallets match active project
        const infra =
            Array.isArray(s.infraWallets) && s.infraWallets.length
                ? s.infraWallets
                : (s.wallets || []).filter(isInfraWallet);
        s.infraWallets = infra;
        const active = s.projects[s.activeProjectId];
        if (active) {
            s.wallets = [
                ...infra,
                ...(Array.isArray(active.wallets) ? active.wallets : []),
            ];
            s.lastToken = active.token || s.lastToken || "";
            s.lastPlan = active.lastPlan ?? s.lastPlan;
            s.lastSellPlan = active.lastSellPlan ?? s.lastSellPlan;
            s.lastSellPreview = active.lastSellPreview ?? s.lastSellPreview;
            s.lastBuyFailures = active.lastBuyFailures || s.lastBuyFailures || [];
            s.hopVault = Array.isArray(active.hopVault)
                ? active.hopVault
                : s.hopVault || [];
        }
        return { migrated: false, store: s };
    }

    const all = Array.isArray(s.wallets) ? s.wallets : [];
    const infra = all.filter(isInfraWallet);
    const buyers = all.filter((w) => !isInfraWallet(w));
    const token1 = {
        ...emptyProject("token1", "Token 1"),
        status: buyers.length || s.lastToken ? "live" : "draft",
        token: s.lastToken || "",
        wallets: buyers,
        lastPlan: s.lastPlan || null,
        lastSellPlan: s.lastSellPlan || null,
        lastSellPreview: s.lastSellPreview || null,
        lastBuyFailures: Array.isArray(s.lastBuyFailures) ? s.lastBuyFailures : [],
        hopVault: Array.isArray(s.hopVault) ? s.hopVault : [],
    };
    s.projects = {
        token1,
    };
    s.activeProjectId = "token1";
    s.infraWallets = infra;
    s.wallets = [...infra, ...buyers];
    return { migrated: true, store: s };
}

function backupStoreFile(reason = "pre-migrate") {
    try {
        if (!fs.existsSync(STORE_FILE)) return null;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dest = path.join(
            DATA_DIR,
            `dashboard.backup-${reason}-${stamp}.json`
        );
        fs.copyFileSync(STORE_FILE, dest);
        console.log(`📦 store backup → ${dest}`);
        return dest;
    } catch (e) {
        console.warn("store backup failed:", e.message || e);
        return null;
    }
}

function saveStore(s) {
    if (IS_BUNDLER_HOST) syncActiveProjectFromFlat(s);
    fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2));
}

function persistHopKeys(hops, meta = {}) {
    if (!Array.isArray(hops) || !hops.length) return;
    store.hopVault = store.hopVault || [];
    const now = new Date().toISOString();
    for (const h of hops) {
        if (!h?.address || !h?.privateKey) continue;
        const addr = String(h.address).toLowerCase();
        const existing = store.hopVault.find(
            (x) => String(x.address).toLowerCase() === addr
        );
        if (existing) {
            Object.assign(existing, {
                ...h,
                ...meta,
                updatedAt: now,
            });
        } else {
            store.hopVault.push({
                ...h,
                ...meta,
                createdAt: h.createdAt || now,
                updatedAt: now,
                recovered: false,
            });
        }
    }
    saveStore(store);
}

function markHopsDelivered(destAddress) {
    const dest = String(destAddress || "").toLowerCase();
    if (!dest || !store.hopVault?.length) return;
    let changed = false;
    for (const h of store.hopVault) {
        if (String(h.dest || "").toLowerCase() === dest && !h.recovered) {
            h.status = h.status === "delivered" ? h.status : "delivered";
            h.updatedAt = new Date().toISOString();
            changed = true;
        }
    }
    if (changed) saveStore(store);
}

function publicHopVault() {
    return (store.hopVault || []).map((h) => ({
        address: h.address,
        step: h.step,
        dest: h.dest,
        destName: h.destName,
        status: h.status,
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
        recovered: !!h.recovered,
        recoveredAt: h.recoveredAt || null,
        fundedTx: h.fundedTx || null,
        // never expose private keys in public API
    }));
}

let store = loadStore();
if (IS_BUNDLER_HOST) {
    moneyDesk.ensureMoneyDesk(store);
    const needsMigrate = !(store.projects && store.activeProjectId);
    if (needsMigrate) backupStoreFile("pre-projects");
    const { migrated } = migrateStoreToProjects(store);
    if (migrated || needsMigrate) {
        moneyDesk.ensureMoneyDesk(store);
        saveStore(store);
        console.log(
            `📁 projects ready · active=${store.activeProjectId} · tabs=${Object.keys(store.projects || {}).join(",")}`
        );
    } else {
        saveStore(store); // persist moneyDesk defaults if newly added
    }
}
let volumeBooster = null;
let trendBooster = null;
let mmBooster = null;
const txBooster = createBooster({
    getStore: () => store,
    saveStore: (s) => {
        store = s;
        saveStore(store);
    },
    onBroadcast: (msg) => broadcast(msg),
    isPeerRunning: () =>
        !!(
            (volumeBooster && volumeBooster.isRunning()) ||
            (trendBooster && trendBooster.isRunning()) ||
            (mmBooster && mmBooster.isRunning())
        ),
});
volumeBooster = createVolumeBooster({
    getStore: () => store,
    saveStore: (s) => {
        store = s;
        saveStore(store);
    },
    onBroadcast: (msg) => broadcast(msg),
    isPeerRunning: () =>
        !!(
            (txBooster.isRunning && txBooster.isRunning()) ||
            (trendBooster && trendBooster.isRunning()) ||
            (mmBooster && mmBooster.isRunning())
        ),
});
trendBooster = createTrendBooster({
    getStore: () => store,
    saveStore: (s) => {
        store = s;
        saveStore(store);
    },
    onBroadcast: (msg) => broadcast(msg),
    isPeerRunning: () =>
        !!(
            (txBooster.isRunning && txBooster.isRunning()) ||
            (volumeBooster && volumeBooster.isRunning()) ||
            (mmBooster && mmBooster.isRunning())
        ),
});
mmBooster = createMmBooster({
    getStore: () => store,
    saveStore: (s) => {
        store = s;
        saveStore(store);
    },
    onBroadcast: (msg) => broadcast(msg),
    isPeerRunning: () =>
        !!(
            (txBooster.isRunning && txBooster.isRunning()) ||
            (volumeBooster && volumeBooster.isRunning()) ||
            (trendBooster && trendBooster.isRunning())
        ),
});
txBooster.hydrateFromStore();
volumeBooster.hydrateFromStore();
trendBooster.hydrateFromStore();
mmBooster.hydrateFromStore();

let job = {
    running: false,
    type: null,
    logs: [],
    result: null,
    progress: { done: 0, total: 0, label: "" },
    abort: false,
    pause: false,
    paused: false,
    projectId: null,
};
let fundingPreview = null; // scheduled jobs before execute

function setJob(partial = {}) {
    job = {
        running: false,
        type: null,
        logs: [],
        result: null,
        progress: { done: 0, total: 0, label: "" },
        abort: false,
        pause: false,
        paused: false,
        projectId: null,
        ...partial,
    };
    if (job.running && !job.projectId) {
        job.projectId = store.activeProjectId || null;
    }
    return job;
}

function pushLog(msg, kind = "info") {
    const entry = { t: Date.now(), msg, kind };
    job.logs.push(entry);
    if (job.logs.length > 200) job.logs.shift();
    // Mirror to process logs so pm2 captures wait/skip/snipe decisions
    if (kind === "err") console.warn(msg);
    else console.log(msg);
    broadcast({ type: "log", entry, job: publicJob() });
}

function setProgress(done, total, label) {
    job.progress = { done, total, label: label || "" };
    broadcast({ type: "progress", job: publicJob() });
}

function publicJob() {
    const projectId =
        job.projectId ||
        (job.running ? store.activeProjectId || null : null);
    const proj =
        projectId && store.projects ? store.projects[projectId] : null;
    return {
        running: job.running,
        type: job.type,
        logs: job.logs.slice(-80),
        result: job.result,
        progress: job.progress,
        pause: !!job.pause,
        paused: !!job.paused,
        abort: !!job.abort,
        projectId: projectId || null,
        projectLabel: proj?.label || projectId || null,
    };
}

/** Force-refresh balances for addresses and push live updates to the UI. */
async function refreshAndBroadcastBalances(addresses = []) {
    const uniq = [
        ...new Set(
            (addresses || [])
                .filter(Boolean)
                .map((a) => String(a).toLowerCase())
        ),
    ];
    if (!uniq.length) return [];
    const updates = [];
    // Prioritize funder + sniper so the top of the UI fills first
    const roleRank = (addr) => {
        const w = store.wallets.find(
            (x) => String(x.address || "").toLowerCase() === addr
        );
        if (!w) return 9;
        if (w.role === "funder") return 0;
        if (w.role === "sniper") return 1;
        return 2;
    };
    uniq.sort((a, b) => roleRank(a) - roleRank(b));
    // Keep concurrency low — public Robinhood RPC 429s hard under load
    await chain.mapPool(uniq, 6, async (addr) => {
        try {
            const bal = await getCachedBalance(addr, { force: true });
            const w = store.wallets.find(
                (x) => String(x.address || "").toLowerCase() === addr
            );
            if (w && bal != null) {
                w.lastBalance = Number(bal);
                w.lastBalanceAt = new Date().toISOString();
            }
            const row = w
                ? {
                      address: w.address,
                      index: store.wallets.indexOf(w),
                      name: w.name,
                      role: w.role || "buyer",
                      balance: bal != null ? Number(bal) : (w.lastBalance != null ? Number(w.lastBalance) : null),
                      buyAmountEth: w.buyAmountEth,
                  }
                : {
                      address: addr,
                      balance: bal != null ? Number(bal) : null,
                  };
            updates.push(row);
            // Stream each balance so the UI fills progressively
            if (row.balance != null) {
                broadcast({ type: "balances", updates: [row], at: Date.now() });
            }
        } catch (_) {}
        // Small gap between calls to avoid 429
        await new Promise((r) => setTimeout(r, 40));
    });
    const ok = updates.filter((u) => u.balance != null).length;
    console.log(`Balances refreshed · ${ok}/${updates.length} ok`);
    // Persist last-known balances so /api/state never blanks after restart
    if (ok > 0) {
        try {
            saveStore(store);
        } catch (_) {}
    }
    return updates;
}

const clients = new Set();
function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
        try {
            res.write(data);
        } catch (_) {}
    }
}

function publicWallets() {
    return store.wallets.map((w, i) => ({
        index: i,
        name: w.name,
        address: w.address,
        role: w.role || "buyer",
        buyAmountEth: w.buyAmountEth,
        delaySec: w.delaySec ?? 0,
        parentIndex: w.parentIndex ?? null,
        seasoned: !!w.seasoned,
        seasonTxCount: w.seasonTxCount || 0,
        seasonedAt: w.seasonedAt || null,
    }));
}

function funder() {
    return store.wallets.find((w) => w.role === "funder") || null;
}
/** Dedicated sniper wallet — separate from bundler funder/buyers. */
function sniper() {
    return store.wallets.find((w) => w.role === "sniper") || null;
}
function distributors() {
    return store.wallets.filter((w) => w.role === "distributor");
}
function buyers() {
    return store.wallets.filter(
        (w) => w.role === "buyer" || (!w.role || w.role === "buyer")
    );
}
function buyersOnly() {
    return store.wallets.filter((w) => w.role === "buyer");
}

/** Bundler sell plan: real buyers only — never sniper / txbot / funder / dust-cost wallets. */
function sellPlanWallets() {
    const INFRA = new Set(["sniper", "txbot", "funder", "distributor"]);
    return store.wallets.filter((w) => {
        const role = String(w.role || "buyer").toLowerCase();
        if (INFRA.has(role)) return false;
        if (role !== "buyer") return false;
        const name = String(w.name || "");
        if (/^(sniper|tx\s*bot|funder)$/i.test(name.trim())) return false;
        // Must have a real buy cost basis (excludes dust / mis-roled wallets)
        if (!(Number(w.buyAmountEth) > 0)) return false;
        return true;
    });
}

/** After a partial/full sell, shrink remaining cost basis so P&L stays honest. */
function applySoldCostBasis(wallet, percent, ethOut) {
    if (!wallet) return;
    const pct = Math.min(100, Math.max(0, Number(percent) || 0));
    const costFull = Number(wallet.buyAmountEth || 0) || 0;
    const costSold = costFull * (pct / 100);
    const remain = Math.max(0, costFull - costSold);
    wallet.buyAmountEth = remain > 1e-12 ? Math.round(remain * 1e9) / 1e9 : 0;
    wallet.realizedEthOut = Number(wallet.realizedEthOut || 0) + (Number(ethOut) || 0);
    wallet.realizedCostEth = Number(wallet.realizedCostEth || 0) + costSold;
    wallet.realizedProfitEth =
        Number(wallet.realizedEthOut || 0) - Number(wallet.realizedCostEth || 0);
    wallet.soldPctTotal = Math.min(
        100,
        Number(wallet.soldPctTotal || 0) + pct
    );
}

/** Record successful sells into store.sellHistory with running profit totals. */
async function recordSellHistory(results, meta = {}) {
    if (!Array.isArray(results) || !results.length) return null;
    const ethUsd = await chain.getEthUsdPrice().catch(() => 0);
    if (!Array.isArray(store.sellHistory)) store.sellHistory = [];
    const token = String(meta.token || store.lastToken || "").toLowerCase();
    const percent = Math.min(100, Math.max(1, Number(meta.percent || 100)));
    const byAddr = new Map(
        (store.wallets || []).map((w) => [
            String(w.address || "").toLowerCase(),
            w,
        ])
    );
    const added = [];
    for (const r of results) {
        if (!r || r.skipped || r.error || !r.hash) continue;
        const addr = String(r.wallet || "").toLowerCase();
        const w = byAddr.get(addr);
        const costFull = Number(w?.buyAmountEth ?? meta.costEth ?? 0) || 0;
        const costEth = costFull * (percent / 100);
        const ethOut = Number(r.quotedEth ?? r.ethOut ?? 0) || 0;
        const profitEth = ethOut - costEth;
        const entry = {
            id: `${Date.now()}-${(r.hash || "").slice(2, 10)}-${added.length}`,
            at: new Date().toISOString(),
            token,
            wallet: r.wallet,
            name: w?.name || meta.name || r.wallet,
            percent,
            ethOut,
            costEth,
            profitEth,
            ethUsd,
            ethOutUsd: ethOut * (ethUsd || 0),
            costUsd: costEth * (ethUsd || 0),
            profitUsd: profitEth * (ethUsd || 0),
            hash: r.hash,
            source: meta.source || "sell",
        };
        store.sellHistory.push(entry);
        added.push(entry);
    }
    // Cap history size
    if (store.sellHistory.length > 500) {
        store.sellHistory = store.sellHistory.slice(-500);
    }
    // Running totals (all tokens + this token)
    let cumEth = 0;
    let cumProfit = 0;
    let cumUsd = 0;
    let cumProfitUsd = 0;
    for (const e of store.sellHistory) {
        cumEth += Number(e.ethOut || 0);
        cumProfit += Number(e.profitEth || 0);
        cumUsd += Number(e.ethOutUsd || 0);
        cumProfitUsd += Number(e.profitUsd || 0);
        e.cumEthOut = cumEth;
        e.cumProfitEth = cumProfit;
        e.cumEthOutUsd = cumUsd;
        e.cumProfitUsd = cumProfitUsd;
    }
    if (added.length) saveStore(store);
    return {
        added,
        summary: sellHistorySummary(token),
    };
}

function sellHistorySummary(tokenFilter) {
    const all = Array.isArray(store.sellHistory) ? store.sellHistory : [];
    const tok = tokenFilter ? String(tokenFilter).toLowerCase() : "";
    const rows = tok
        ? all.filter((e) => String(e.token || "").toLowerCase() === tok)
        : all;
    const ethOut = rows.reduce((a, e) => a + Number(e.ethOut || 0), 0);
    const costEth = rows.reduce((a, e) => a + Number(e.costEth || 0), 0);
    const profitEth = rows.reduce((a, e) => a + Number(e.profitEth || 0), 0);
    const ethOutUsd = rows.reduce((a, e) => a + Number(e.ethOutUsd || 0), 0);
    const costUsd = rows.reduce((a, e) => a + Number(e.costUsd || 0), 0);
    const profitUsd = rows.reduce((a, e) => a + Number(e.profitUsd || 0), 0);
    return {
        count: rows.length,
        ethOut,
        costEth,
        profitEth,
        ethOutUsd,
        costUsd,
        profitUsd,
        ethOutUsdLabel: chain.formatUsd(ethOutUsd, 0),
        costUsdLabel: chain.formatUsd(costUsd, 0),
        profitUsdLabel: chain.formatUsdSigned(profitUsd, 0),
        ethOutLabel: `${ethOut.toFixed(4)} ETH`,
        profitEthLabel: `${profitEth >= 0 ? "+" : ""}${profitEth.toFixed(4)} ETH`,
    };
}



const app = express();
app.use(express.json({ limit: "1mb" }));
const PUBLIC_DIR = path.join(__dirname, "public");
// Each host gets its own dashboard; bundler keeps index.html
if (IS_SNIPER_HOST) {
    app.get("/", (_req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, "sniper.html"));
    });
} else if (IS_TXBOT_HOST) {
    app.get("/", (_req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, "txbot.html"));
    });
}
app.use(express.static(PUBLIC_DIR));

app.get("/api/state", async (req, res) => {
    const wantBalances =
        req.query.refresh === "1" || req.query.balances === "1";
    // Always serve from cache instantly; kick a background RPC sweep if asked
    if (wantBalances) kickBalanceRefresh();
    const walletsOut = store.wallets.map((w, i) => {
        const key = String(w.address || "").toLowerCase();
        const cached = balanceCache.has(key)
            ? balanceCache.get(key).bal
            : null;
        // Prefer live cache; fall back to last known so UI never blanks mid-launch
        const balance =
            cached != null
                ? cached
                : w.lastBalance != null
                  ? Number(w.lastBalance)
                  : null;
        return {
            index: i,
            name: w.name,
            address: w.address,
            role: w.role || "buyer",
            buyAmountEth: w.buyAmountEth,
            realizedEthOut: w.realizedEthOut || 0,
            realizedCostEth: w.realizedCostEth || 0,
            realizedProfitEth: w.realizedProfitEth || 0,
            soldPctTotal: w.soldPctTotal || 0,
            delaySec: w.delaySec ?? 0,
            balance,
            seasoned: !!w.seasoned,
            seasonTxCount: w.seasonTxCount || 0,
            seasonedAt: w.seasonedAt || null,
        };
    });
    let ethUsd = null;
    try {
        ethUsd = await chain.getEthUsdPrice();
    } catch (_) {}
    res.json({
        mode: IS_SNIPER_HOST ? "sniper" : IS_TXBOT_HOST ? "txbot" : "bundler",
        sniperHostEnabled: IS_SNIPER_HOST,
        txbotHostEnabled: IS_TXBOT_HOST,
        wallets: walletsOut,
        lastToken: store.lastToken || "",
        launchpad: resolveLaunchpad(store.launchpad),
        lastPlan: IS_BUNDLER_HOST ? store.lastPlan : null,
        // Sticky sell plan / P&L — survives page refresh until Force restart
        lastSellPlan: IS_BUNDLER_HOST ? store.lastSellPlan || null : null,
        lastSellPreview: IS_BUNDLER_HOST ? store.lastSellPreview || null : null,
        sellHistory: IS_BUNDLER_HOST
            ? (store.sellHistory || []).slice(-80).reverse()
            : [],
        sellHistorySummary: IS_BUNDLER_HOST
            ? sellHistorySummary(store.lastToken || "")
            : null,
        activeProjectId: IS_BUNDLER_HOST ? store.activeProjectId || null : null,
        projects: IS_BUNDLER_HOST ? publicProjects(store) : [],
        txBot: IS_TXBOT_HOST ? txBooster.status() : null,
        volumeBot: IS_TXBOT_HOST ? volumeBooster.status() : null,
        trendBot: IS_TXBOT_HOST ? trendBooster.status() : null,
        mmBot: IS_TXBOT_HOST ? mmBooster.status() : null,
        job: publicJob(),
        fundingPreview: IS_BUNDLER_HOST ? fundingPreview : null,
        snipeConfig: IS_SNIPER_HOST ? store.snipeConfig : { enabled: false, autoSell: false },
        snipes: IS_SNIPER_HOST
            ? (store.snipes || []).slice(-30).reverse()
            : [],
        sniper: IS_SNIPER_HOST
            ? (() => {
                  const s = sniper();
                  if (!s) return null;
                  const i = store.wallets.indexOf(s);
                  const row = walletsOut.find((w) => w.index === i);
                  return (
                      row || {
                          index: i,
                          name: s.name || "Sniper",
                          address: s.address,
                          role: "sniper",
                          balance: null,
                      }
                  );
              })()
            : null,
        pairs: IS_SNIPER_HOST
            ? enrichPairsWithCreator(pairsCache.tokens.slice(0, 60)).sort(
                  (a, b) => {
                      const ab = Number(a.createdAtBlock || 0);
                      const bb = Number(b.createdAtBlock || 0);
                      if (bb !== ab) return bb - ab;
                      const aa = a.ageSec != null ? a.ageSec : 1e12;
                      const ba = b.ageSec != null ? b.ageSec : 1e12;
                      if (aa !== ba) return aa - ba;
                      return (
                          new Date(b.createdAt || 0).getTime() -
                          new Date(a.createdAt || 0).getTime()
                      );
                  }
              )
            : [],
        pairsUpdatedAt: IS_SNIPER_HOST ? pairsCache.updatedAt : 0,
        pairsFeedNote: IS_SNIPER_HOST ? pairsCache.feedNote || null : null,
        pairsSource: IS_SNIPER_HOST ? pairsCache.source || null : null,
        hopVault: publicHopVault(),
        hopVaultPending: (store.hopVault || []).filter(
            (h) => !h.recovered && h.status !== "delivered"
        ).length,
        lastBuyFailures: store.lastBuyFailures || [],
        dev: IS_BUNDLER_HOST
            ? (() => {
                  const d = findDev();
                  if (!d) return null;
                  const i = store.wallets.indexOf(d);
                  const key = String(d.address || "").toLowerCase();
                  const cached = balanceCache.has(key)
                      ? balanceCache.get(key).bal
                      : d.lastBalance != null
                        ? Number(d.lastBalance)
                        : null;
                  return {
                      index: i,
                      name: d.name || "Dev",
                      address: d.address,
                      role: "dev",
                      balance: cached,
                  };
              })()
            : null,
        meta: {
            chainId: chain.CHAIN_ID,
            startingMcEth: chain.NOXA_STARTING_MC_ETH,
            startingMcUsd: ethUsd
                ? chain.ethToUsd(chain.NOXA_STARTING_MC_ETH, ethUsd)
                : null,
            startingMcUsdLabel: ethUsd
                ? chain.formatUsd(
                      chain.ethToUsd(chain.NOXA_STARTING_MC_ETH, ethUsd)
                  )
                : null,
            ethUsd,
            defaultSupply: chain.NOXA_DEFAULT_SUPPLY,
            maxWalletBps: chain.NOXA_MAX_WALLET_BPS,
            maxBundleWallets: MAX_BUNDLE_WALLETS,
            explorer: EXPLORER,
        },
        moneyDesk: IS_BUNDLER_HOST
            ? moneyDesk.publicMoneyDeskConfig(moneyDesk.ensureMoneyDesk(store))
            : null,
        killPaused: IS_BUNDLER_HOST
            ? !!(store.moneyDesk?.killSwitch?.paused)
            : false,
    });
});

// ─── Money Desk (treasury / P&L / readiness / kill switch) ───────────────

async function liveFunderEth() {
    const f = funder();
    if (!f?.address) return 0;
    try {
        const bal = await getCachedBalance(f.address, { force: true });
        if (bal != null) return Number(bal);
    } catch (_) {}
    return Number(f.lastBalance || 0) || 0;
}

function plannedBuyEthFromStore() {
    return buyersOnly().reduce(
        (a, w) => a + (Number(w.buyAmountEth) > 0 ? Number(w.buyAmountEth) : 0),
        0
    );
}

function projectCapital(projectId) {
    const md = moneyDesk.ensureMoneyDesk(store);
    const id = projectId || store.activeProjectId || "default";
    if (!md.projectCapital[id]) {
        md.projectCapital[id] = {
            deployedEth: 0,
            recoveredEth: 0,
            gasSpentEth: 0,
            initialTreasuryEth: null,
            launchMcapUsd: null,
        };
    }
    return md.projectCapital[id];
}

async function estimateBundleGasEth(buyerCount) {
    const n = Math.max(0, Number(buyerCount) || 0);
    // Rough: ~0.0012 ETH per buy + hops + launch cushion
    const per = 0.0012;
    const hops = 0.0008 * Math.max(1, Math.ceil(n / 10));
    const launch = 0.01;
    return Math.min(1.5, launch + n * per + hops);
}

async function buildMoneyOverview({ plannedEth = null, forceBalances = true } = {}) {
    const md = moneyDesk.ensureMoneyDesk(store);
    const ethUsd = await chain.getEthUsdPrice().catch(() => 0);
    const funderEth = forceBalances
        ? await liveFunderEth()
        : Number(funder()?.lastBalance || 0) || 0;
    const planned =
        plannedEth != null ? Number(plannedEth) : plannedBuyEthFromStore();
    const gasEst = await estimateBundleGasEth(
        buyersOnly().filter((w) => Number(w.buyAmountEth) > 0).length
    );
    // Keep treasury.estimatedGasEth fresh for display
    md.treasury.estimatedGasEth = gasEst;

    const treasury = moneyDesk.buildTreasurySnapshot({
        funderBalanceEth: funderEth,
        ethUsd,
        md,
        plannedDeployEth: planned,
        gasEstimateEth: gasEst,
    });

    const cap = projectCapital(store.activeProjectId);
    const token = store.lastToken || "";
    const sells = store.sellHistory || [];
    const tokenSells = token
        ? sells.filter(
              (e) =>
                  String(e.token || "").toLowerCase() ===
                  String(token).toLowerCase()
          )
        : sells;
    const recoveredFromSells = tokenSells.reduce(
        (a, e) => a + Number(e.ethOut || 0),
        0
    );
    if (recoveredFromSells > Number(cap.recoveredEth || 0)) {
        cap.recoveredEth = recoveredFromSells;
    }

    // Remaining supply % from last sell preview if present
    let remainingSupplyPct = 0;
    const prev = store.lastSellPreview;
    if (prev?.summary?.supplyHeldPct != null) {
        remainingSupplyPct = Number(prev.summary.supplyHeldPct);
    } else if (prev?.heldPct != null) {
        remainingSupplyPct = Number(prev.heldPct);
    } else if (prev?.rows?.length && prev?.tokenSupply) {
        // fallback rough
        remainingSupplyPct = 5;
    }

    let liveMc = null;
    let liveMcUsd = null;
    let bagValueEth = 0;
    if (token && chain.isEvmAddress(token)) {
        try {
            const mc = await chain.resolveLiveMarketCap(token);
            liveMc = mc;
            liveMcUsd = mc.mcapUsd;
            if (!cap.launchMcapUsd && mc.mcapUsd) {
                // don't overwrite if set at launch
            }
        } catch (_) {}
        try {
            if (store.lastSellPreview?.summary?.dumpAllEth != null) {
                bagValueEth = Number(store.lastSellPreview.summary.dumpAllEth);
            }
        } catch (_) {}
    }

    const deployedEth =
        Number(cap.deployedEth) > 0
            ? Number(cap.deployedEth)
            : plannedBuyEthFromStore() +
              Number(md.treasury.liquidityAllocationEth || 0) * 0;

    const breakEven = moneyDesk.buildBreakEven({
        capitalDeployedEth: deployedEth || planned,
        capitalRecoveredEth: Number(cap.recoveredEth || 0),
        remainingSupplyPct: remainingSupplyPct || 8,
        ethUsd,
        currentMcapUsd: liveMcUsd,
    });

    const netProfit = moneyDesk.buildNetProfit({
        md,
        sellHistory: sells,
        ethUsd,
        token: token || null,
    });

    const kill = moneyDesk.evaluateKillSwitch({
        md,
        funderBalanceEth: funderEth,
        projectDrawdownPct: (() => {
            const d = Number(cap.deployedEth || 0);
            const r = Number(cap.recoveredEth || 0);
            if (!(d > 0)) return 0;
            const unreal = bagValueEth;
            const equity = r + unreal;
            return Math.max(0, ((d - equity) / d) * 100);
        })(),
    });

    const sizing = moneyDesk.buildPositionSizing({
        requestedEth: planned,
        maxDeployableEth: treasury.maxDeployableEth,
        availableLiquidityEth: Number(liveMc?.mcapEth || 0) * 0.15 || treasury.maxDeployableEth,
        currentMcapEth: Number(liveMc?.mcapEth || 0),
        ethUsd,
    });

    const ladder = moneyDesk.buildProfitLadder({
        md,
        launchMcapUsd: Number(cap.launchMcapUsd) || liveMcUsd || 0,
        currentMcapUsd: liveMcUsd || 0,
        capitalDeployedEth: deployedEth || planned,
        ethUsd,
    });

    const hasDev = !!findDev();
    const buyersFunded = buyersOnly().some(
        (w) => Number(w.buyAmountEth) > 0 && Number(w.lastBalance || 0) > 0.001
    );
    const readiness = moneyDesk.buildLaunchReadiness({
        md,
        treasury,
        kill,
        hasDev,
        buyersFunded:
            buyersFunded ||
            buyersOnly().filter((w) => Number(w.buyAmountEth) > 0).length > 0,
        hasBuyPlan: !!store.lastPlan,
        hasExitPlan: !!store.lastSellPlan || !!md.readiness.exitPlanApproved,
        ethUsd,
    });

    // Portfolio across tabs
    const projects = Object.values(store.projects || {}).map((p) => {
        const c = md.projectCapital[p.id] || {};
        return {
            id: p.id,
            label: p.label,
            status: p.status,
            token: p.token,
            deployedEth: Number(c.deployedEth || 0),
            recoveredEth: Number(c.recoveredEth || 0),
            unrealizedEth: 0,
        };
    });
    const portfolio = moneyDesk.buildPortfolioRisk({
        funderEth,
        md,
        projects,
        ethUsd,
    });

    // Exit simulator from last preview rows if available
    let exitSim = null;
    if (store.lastSellPreview?.rows?.length) {
        const rows = store.lastSellPreview.rows;
        const aloneSum = rows.reduce((a, r) => a + Number(r.ethOut || 0), 0);
        bagValueEth = bagValueEth || aloneSum;
        // Approximate haircuts for partial exits
        const exits = [10, 25, 50, 100].map((pct) => {
            const ideal = aloneSum * (pct / 100);
            // bonding-style: larger % → worse average
            const haircut = pct <= 10 ? 0.08 : pct <= 25 ? 0.18 : pct <= 50 ? 0.35 : 0.55;
            return {
                pct,
                ethOut: ideal * (1 - haircut),
                note: pct === 100 ? "Full dump estimate" : `${pct}% trim`,
            };
        });
        exitSim = moneyDesk.buildExitSimulator({
            bagValueEth: aloneSum,
            exits,
            ethUsd,
        });
    } else {
        exitSim = moneyDesk.buildExitSimulator({
            bagValueEth: 0,
            exits: [],
            ethUsd,
        });
    }

    // RPC health (simple)
    let rpcHealthy = true;
    let rpcMs = null;
    try {
        const t0 = Date.now();
        await Promise.race([
            chain.provider.getBlockNumber(),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error("rpc timeout")), 4000)
            ),
        ]);
        rpcMs = Date.now() - t0;
        rpcHealthy = rpcMs < 3500;
    } catch (_) {
        rpcHealthy = false;
    }
    md.readiness.rpcHealthy = rpcHealthy;

    return {
        ethUsd,
        ethUsdLabel: ethUsd ? `$${Number(ethUsd).toFixed(0)}/ETH` : "—",
        treasury,
        netProfit,
        breakEven,
        ladder,
        kill,
        readiness,
        sizing,
        exitSim,
        portfolio,
        lp: md.lp,
        capital: cap,
        rpc: { healthy: rpcHealthy, latencyMs: rpcMs },
        config: moneyDesk.publicMoneyDeskConfig(md),
        updatedAt: new Date().toISOString(),
    };
}

/** Gate spend actions — returns { ok, status, plainEnglish, overview } */
async function assertMoneyGate({ plannedEth, action = "spend", allowWarn = false } = {}) {
    const overview = await buildMoneyOverview({ plannedEth });
    if (!overview.kill.ok) {
        return {
            ok: false,
            status: "kill",
            plainEnglish: overview.kill.plainEnglish,
            overview,
        };
    }
    if (overview.treasury.status === "block") {
        return {
            ok: false,
            status: "reserve",
            plainEnglish: overview.treasury.plainEnglish,
            overview,
        };
    }
    if (action === "launch" && !overview.readiness.canLaunch) {
        return {
            ok: false,
            status: "readiness",
            plainEnglish: overview.readiness.plainEnglish,
            overview,
        };
    }
    if (!allowWarn && overview.treasury.status === "warn" && action === "launch") {
        // warn still allows with confirm on client; server allows warn
    }
    if (!overview.sizing.ok && (action === "fund" || action === "plan")) {
        return {
            ok: true,
            status: "sizing_warn",
            plainEnglish: overview.sizing.plainEnglish,
            overview,
        };
    }
    return { ok: true, status: overview.treasury.status, plainEnglish: "OK", overview };
}

if (IS_BUNDLER_HOST) {
    app.get("/api/money", async (req, res) => {
        try {
            const planned =
                req.query.plannedEth != null
                    ? Number(req.query.plannedEth)
                    : null;
            const overview = await buildMoneyOverview({ plannedEth: planned });
            res.json(overview);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get("/api/money/config", (req, res) => {
        res.json(moneyDesk.publicMoneyDeskConfig(moneyDesk.ensureMoneyDesk(store)));
    });

    app.post("/api/money/config", (req, res) => {
        const md = moneyDesk.ensureMoneyDesk(store);
        const b = req.body || {};
        if (b.treasury && typeof b.treasury === "object") {
            md.treasury = { ...md.treasury, ...b.treasury };
            md.treasury.minReserveEth = Math.max(
                0,
                Number(md.treasury.minReserveEth) || 0
            );
            md.treasury.minReservePct = Math.min(
                90,
                Math.max(0, Number(md.treasury.minReservePct) || 0)
            );
        }
        if (b.killSwitch && typeof b.killSwitch === "object") {
            const { paused, pauseReason, ...rest } = b.killSwitch;
            md.killSwitch = { ...md.killSwitch, ...rest };
            // paused controlled via /api/money/kill
        }
        if (b.readiness && typeof b.readiness === "object") {
            md.readiness = { ...md.readiness, ...b.readiness };
        }
        if (b.lp && typeof b.lp === "object") {
            md.lp = { ...md.lp, ...b.lp };
        }
        if (b.ladder && typeof b.ladder === "object") {
            md.ladder = { ...md.ladder, ...b.ladder };
        }
        saveStore(store);
        res.json({ ok: true, config: moneyDesk.publicMoneyDeskConfig(md) });
    });

    app.post("/api/money/expense", (req, res) => {
        const md = moneyDesk.ensureMoneyDesk(store);
        const eth = Number(req.body?.eth);
        if (!(eth > 0)) return res.status(400).json({ error: "eth amount required" });
        const ethUsd = Number(req.body?.ethUsd) || 0;
        const row = moneyDesk.addExpense(md, {
            category: req.body?.category || "other",
            label: req.body?.label,
            eth,
            usd: ethUsd > 0 ? eth * ethUsd : Number(req.body?.usd) || 0,
            projectId: req.body?.projectId || store.activeProjectId,
            token: req.body?.token || store.lastToken,
            note: req.body?.note,
            kind: req.body?.kind === "income" ? "income" : "expense",
        });
        saveStore(store);
        res.json({ ok: true, expense: row });
    });

    app.post("/api/money/kill", (req, res) => {
        const md = moneyDesk.ensureMoneyDesk(store);
        const pause = req.body?.pause !== false && req.body?.resume !== true;
        if (req.body?.resume) {
            md.killSwitch.paused = false;
            md.killSwitch.pauseReason = "";
        } else if (pause) {
            md.killSwitch.paused = true;
            md.killSwitch.pauseReason =
                String(req.body?.reason || "Manual safety stop").slice(0, 200);
        }
        saveStore(store);
        broadcast({
            type: "money_kill",
            paused: md.killSwitch.paused,
            reason: md.killSwitch.pauseReason,
        });
        res.json({
            ok: true,
            paused: md.killSwitch.paused,
            reason: md.killSwitch.pauseReason,
        });
    });

    app.post("/api/money/ladder", (req, res) => {
        const md = moneyDesk.ensureMoneyDesk(store);
        if (req.body?.approve === true) md.ladder.approved = true;
        if (req.body?.approve === false) {
            md.ladder.approved = false;
            md.ladder.active = false;
        }
        if (req.body?.active === true) {
            if (!md.ladder.approved) {
                return res.status(400).json({
                    error: "Approve the profit ladder before turning it on",
                });
            }
            md.ladder.active = true;
        }
        if (req.body?.active === false) md.ladder.active = false;
        if (req.body?.completeRungId) {
            const id = String(req.body.completeRungId);
            if (!md.ladder.completedRungIds.includes(id)) {
                md.ladder.completedRungIds.push(id);
            }
        }
        saveStore(store);
        res.json({ ok: true, ladder: md.ladder });
    });

    app.post("/api/money/capital", (req, res) => {
        const cap = projectCapital(req.body?.projectId || store.activeProjectId);
        if (req.body?.deployedEth != null)
            cap.deployedEth = Math.max(0, Number(req.body.deployedEth) || 0);
        if (req.body?.recoveredEth != null)
            cap.recoveredEth = Math.max(0, Number(req.body.recoveredEth) || 0);
        if (req.body?.addDeployedEth)
            cap.deployedEth =
                Number(cap.deployedEth || 0) + Number(req.body.addDeployedEth);
        if (req.body?.addRecoveredEth)
            cap.recoveredEth =
                Number(cap.recoveredEth || 0) + Number(req.body.addRecoveredEth);
        if (req.body?.launchMcapUsd != null)
            cap.launchMcapUsd = Number(req.body.launchMcapUsd) || null;
        if (req.body?.initialTreasuryEth != null)
            cap.initialTreasuryEth = Number(req.body.initialTreasuryEth);
        if (req.body?.remainingSupplyPct != null)
            cap.remainingSupplyPct = Number(req.body.remainingSupplyPct);
        saveStore(store);
        res.json({ ok: true, capital: cap });
    });

    app.post("/api/money/review", async (req, res) => {
        try {
            const md = moneyDesk.ensureMoneyDesk(store);
            const ethUsd = await chain.getEthUsdPrice().catch(() => 0);
            const pid = req.body?.projectId || store.activeProjectId;
            const project = store.projects?.[pid] || {
                id: pid,
                label: pid,
                token: store.lastToken,
            };
            const review = moneyDesk.buildPostLaunchReview({
                project,
                md,
                sellHistory: store.sellHistory || [],
                ethUsd,
                capital: projectCapital(pid),
                readiness: md.readiness,
                whatWorked: req.body?.whatWorked || "",
                whatChange: req.body?.whatChange || "",
            });
            md.reviews.push(review);
            if (md.reviews.length > 50) md.reviews = md.reviews.slice(-50);
            saveStore(store);
            res.json({ ok: true, review });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get("/api/money/reviews", (req, res) => {
        const md = moneyDesk.ensureMoneyDesk(store);
        res.json({ reviews: (md.reviews || []).slice().reverse() });
    });

    app.get("/api/money/rpc-health", async (req, res) => {
        const t0 = Date.now();
        try {
            const bn = await Promise.race([
                chain.provider.getBlockNumber(),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("timeout")), 4000)
                ),
            ]);
            const ms = Date.now() - t0;
            res.json({
                ok: true,
                healthy: ms < 3500,
                blockNumber: bn,
                latencyMs: ms,
            });
        } catch (e) {
            res.json({
                ok: false,
                healthy: false,
                error: e.message,
                latencyMs: Date.now() - t0,
            });
        }
    });
}

// ─── Campaign factory + per-project job queue ───────────────────────────
let campaignEngine = null;
let projectJobQueue = null;

if (IS_BUNDLER_HOST) {
    moneyDesk.ensureMoneyDesk(store);
    const { ensureCampaigns } = require("./campaign-engine");
    ensureCampaigns(store);

    projectJobQueue = createJobQueue({
        maxConcurrent: 3,
        onChange: (ev) => {
            broadcast({ type: "queue", ...ev });
            // Mirror into legacy job for UI status pill when campaign work is active
            if (ev.job && (ev.type === "started" || ev.type === "progress" || ev.type === "log")) {
                if (!job.running || job.type === "campaign") {
                    job.running = true;
                    job.type = "campaign";
                    job.projectId = ev.job.projectId;
                    job.progress = ev.job.progress;
                    if (ev.entry) {
                        pushLog(`[${ev.job.label}] ${ev.entry.msg}`, ev.entry.kind || "info");
                    }
                }
            }
            if (ev.type === "complete" || ev.type === "failed") {
                const snap = projectJobQueue.snapshot();
                if (snap.activeCount === 0 && snap.waitingCount === 0) {
                    job.running = false;
                    job.type = null;
                    broadcast({ type: "job_done", job: publicJob() });
                }
            }
        },
        runStage: async (j, ctx) => campaignEngine.runStage(j, ctx),
    });

    campaignEngine = createCampaignEngine({
        getStore: () => store,
        saveStore: (s) => {
            store = s;
            saveStore(store);
        },
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
        jobQueue: projectJobQueue,
        liveFunderEth,
    });

    app.get("/api/campaigns", (_req, res) => {
        res.json({
            campaigns: campaignEngine.listCampaigns(),
            queue: projectJobQueue.snapshot(),
            center: campaignEngine.commandCenter(),
        });
    });

    app.get("/api/campaigns/center", (_req, res) => {
        res.json(campaignEngine.commandCenter());
    });

    app.get("/api/campaigns/:id", (req, res) => {
        const c = campaignEngine.getCampaign(req.params.id);
        if (!c) return res.status(404).json({ error: "Campaign not found" });
        res.json({ campaign: c, queue: projectJobQueue.snapshot() });
    });

    app.post("/api/campaigns", (req, res) => {
        try {
            const c = campaignEngine.createCampaign(req.body || {});
            res.json({ ok: true, campaign: c });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post("/api/campaigns/start", async (req, res) => {
        try {
            const id = req.body?.id || req.body?.campaignId;
            if (!id) return res.status(400).json({ error: "campaign id required" });
            const c = await campaignEngine.startCampaign(id, {
                maxConcurrent: req.body?.maxConcurrent,
            });
            res.json({ ok: true, campaign: c, queue: projectJobQueue.snapshot() });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post("/api/campaigns/pause", (req, res) => {
        try {
            const id = req.body?.id || req.body?.campaignId;
            if (!id) return res.status(400).json({ error: "campaign id required" });
            const c = campaignEngine.pauseCampaign(id);
            res.json({ ok: true, campaign: c });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post("/api/campaigns/resume", (req, res) => {
        try {
            const id = req.body?.id || req.body?.campaignId;
            if (!id) return res.status(400).json({ error: "campaign id required" });
            const c = campaignEngine.resumeCampaign(id);
            res.json({ ok: true, campaign: c });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post("/api/campaigns/matrix", (req, res) => {
        try {
            const built = campaignEngine.buildTestMatrix(req.body || {});
            res.json({
                ok: true,
                count: built.count,
                matrix: built.matrix,
                sample: built.combos.slice(0, 5),
            });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get("/api/queue", (_req, res) => {
        res.json(projectJobQueue.snapshot());
    });

    app.post("/api/queue/config", (req, res) => {
        if (req.body?.maxConcurrent != null) {
            projectJobQueue.setMaxConcurrent(req.body.maxConcurrent);
        }
        if (req.body?.pause) projectJobQueue.pauseAll();
        if (req.body?.resume) projectJobQueue.resumeAll();
        res.json({ ok: true, queue: projectJobQueue.snapshot() });
    });
}
app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "hello", job: publicJob() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
});

// --- Multi-token projects (bundler only) ---
app.get("/api/projects", (_req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Projects are bundler-only" });
    }
    res.json({
        activeProjectId: store.activeProjectId || null,
        projects: publicProjects(store),
        job: publicJob(),
    });
});

app.post("/api/projects", (req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Projects are bundler-only" });
    }
    syncActiveProjectFromFlat(store);
    store.projects = store.projects || {};
    const n = Object.keys(store.projects).length + 1;
    let id = `token${n}`;
    while (store.projects[id]) {
        id = `token${Date.now().toString(36)}`;
    }
    const label =
        String(req.body?.label || "").trim() || `Token ${n}`;
    store.projects[id] = emptyProject(id, label);
    saveStore(store);
    res.json({
        ok: true,
        project: publicProjects(store).find((p) => p.id === id),
        activeProjectId: store.activeProjectId,
        projects: publicProjects(store),
    });
});

app.post("/api/projects/switch", (req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Projects are bundler-only" });
    }
    const projectId = String(req.body?.projectId || "").trim();
    if (!projectId || !store.projects?.[projectId]) {
        return res.status(400).json({ error: "Unknown projectId" });
    }
    if (job.running && job.projectId && job.projectId !== projectId) {
        // Allow switch for viewing, but warn — job still belongs to other tab
    }
    try {
        hydrateProject(store, projectId);
        // Clear in-memory fund preview when leaving a project mid-schedule
        fundingPreview = null;
        saveStore(store);
        kickBalanceRefresh();
        res.json({
            ok: true,
            activeProjectId: store.activeProjectId,
            projects: publicProjects(store),
            lastToken: store.lastToken || "",
            lastPlan: store.lastPlan,
            lastSellPlan: store.lastSellPlan,
            lastSellPreview: store.lastSellPreview,
            wallets: publicWallets(),
            job: publicJob(),
            warning:
                job.running && job.projectId && job.projectId !== projectId
                    ? `Job still running on ${job.projectId}`
                    : null,
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.patch("/api/projects/:id", (req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Projects are bundler-only" });
    }
    const id = String(req.params.id || "").trim();
    const p = store.projects?.[id];
    if (!p) return res.status(404).json({ error: "Unknown project" });
    if (req.body?.label != null) {
        const label = String(req.body.label).trim();
        if (label) p.label = label.slice(0, 40);
    }
    if (req.body?.status != null) {
        const st = String(req.body.status).toLowerCase();
        if (st === "live" || st === "draft" || st === "archived") p.status = st;
    }
    // If renaming active, sync is enough via save
    saveStore(store);
    res.json({
        ok: true,
        project: publicProjects(store).find((x) => x.id === id),
        projects: publicProjects(store),
        activeProjectId: store.activeProjectId,
    });
});

/** Delete a coin project tab. Keeps at least one empty draft. */
app.delete("/api/projects/:id", (req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Projects are bundler-only" });
    }
    if (job.running) {
        return res.status(409).json({ error: "Wait for the current job to finish" });
    }
    const id = String(req.params.id || "").trim();
    if (!store.projects?.[id]) {
        return res.status(404).json({ error: "Unknown project" });
    }
    syncActiveProjectFromFlat(store);
    delete store.projects[id];
    const ids = Object.keys(store.projects || {});
    if (!ids.length) {
        const nid = "token1";
        store.projects[nid] = emptyProject(nid, "Token 1");
        ids.push(nid);
    }
    if (store.activeProjectId === id || !store.projects[store.activeProjectId]) {
        hydrateProject(store, ids[0]);
    }
    saveStore(store);
    res.json({
        ok: true,
        deleted: id,
        activeProjectId: store.activeProjectId,
        projects: publicProjects(store),
        lastToken: store.lastToken || "",
        wallets: publicWallets(),
    });
});

/** Fund the active project's DEV wallet from the shared funder. */
app.post("/api/dev/fund", async (req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Bundler only" });
    }
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    const d = findDev();
    if (!f?.private_key && !f?.privateKey) {
        return res.status(400).json({ error: "Import funder first" });
    }
    if (!d?.private_key && !d?.privateKey) {
        return res.status(400).json({ error: "Create/import a Dev wallet on this tab first" });
    }
    const amountEth = Math.min(5, Math.max(0.005, Number(req.body?.amountEth || 0.05)));
    setJob({
        running: true,
        type: "fund",
        logs: [],
        result: null,
        progress: { done: 0, total: 1, label: "fund dev" },
    });
    pushLog(
        `Funding DEV ${d.address.slice(0, 10)}… with ${amountEth} ETH from funder`,
        "info"
    );
    res.json({ ok: true, job: publicJob() });
    try {
        const tx = await chain.transferEth(
            { private_key: f.private_key || f.privateKey, address: f.address },
            d.address,
            amountEth
        );
        await chain.waitTx(tx);
        setProgress(1, 1, "funded");
        pushLog(`✅ DEV funded · ${EXPLORER}/tx/${tx.hash}`, "ok");
        job.result = { hash: tx.hash, amountEth, to: d.address };
        kickBalanceRefresh([f.address, d.address]);
    } catch (e) {
        pushLog(`❌ fund DEV: ${e.shortMessage || e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

/**
 * Launch token from DEV wallet, then optionally burst-buy with project buyers.
 * Buyers should already be funded. Dev buy ETH is msg.value on create (first swap).
 */
app.post("/api/launch", async (req, res) => {
    if (!IS_BUNDLER_HOST) {
        return res.status(404).json({ error: "Bundler only" });
    }
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const d = findDev();
    if (!d?.private_key && !d?.privateKey) {
        return res.status(400).json({ error: "Create/import Dev wallet on this tab first" });
    }
    const name = String(req.body?.name || "").trim();
    const symbol = String(req.body?.symbol || "").trim();
    if (!name || !symbol) {
        return res.status(400).json({ error: "name and symbol required" });
    }

    // Money Desk gates — reserve lock + kill switch + launch readiness
    const planned = plannedBuyEthFromStore() + Math.max(
        0.001,
        Number(req.body?.devBuyEth ?? req.body?.buyEth ?? 0.02)
    );
    try {
        const gate = await assertMoneyGate({
            plannedEth: planned,
            action: "launch",
            allowWarn: !!req.body?.forceWarn,
        });
        if (!gate.ok) {
            return res.status(400).json({
                error: gate.plainEnglish,
                code: gate.status,
                money: {
                    treasury: gate.overview?.treasury,
                    readiness: gate.overview?.readiness,
                    kill: gate.overview?.kill,
                },
            });
        }
        if (
            gate.overview?.treasury?.status === "warn" &&
            !req.body?.confirmTightReserve
        ) {
            return res.status(400).json({
                error: gate.overview.treasury.plainEnglish,
                code: "tight_reserve",
                needConfirm: true,
                money: { treasury: gate.overview.treasury },
            });
        }
    } catch (e) {
        return res.status(500).json({ error: `Money check failed: ${e.message}` });
    }
    const buyAfter = req.body?.buyAfter !== false;
    const buyModeRaw = String(req.body?.buyMode || req.body?.mode || "burst").toLowerCase();
    const buyMode =
        buyModeRaw === "organic"
            ? "organic"
            : buyModeRaw === "sequential"
              ? "sequential"
              : "burst";
    const organicPaceSec = Math.max(2, Number(req.body?.organicPaceSec ?? 10));
    const organicQuietSec = Math.max(4, Number(req.body?.organicQuietSec ?? 12));
    const organicMaxDipPct = Math.min(
        0.2,
        Math.max(
            0.1,
            Number(req.body?.organicMaxDipPct ?? 0.15) > 1
                ? Number(req.body.organicMaxDipPct) / 100
                : Number(req.body?.organicMaxDipPct ?? 0.15)
        )
    );
    const organicSellPct = Math.min(
        50,
        Math.max(8, Number(req.body?.organicSellPct ?? 25))
    );
    const foreignMinEth = Math.max(
        0,
        Number(req.body?.foreignMinEth ?? 0.008)
    );
    const devBuyEth = Math.min(
        2,
        Math.max(0.001, Number(req.body?.devBuyEth ?? req.body?.buyEth ?? 0.02))
    );
    const list = buyersOnly().filter((w) => Number(w.buyAmountEth) > 0);
    if (buyAfter && list.length < 1) {
        return res.status(400).json({
            error: "Apply a buy plan + fund buyers first (or set buyAfter:false to launch only)",
        });
    }

    setJob({
        running: true,
        type: "launch",
        logs: [],
        result: null,
        progress: {
            done: 0,
            total: buyAfter ? list.length + 1 : 1,
            label: "launching",
        },
        abort: false,
    });
    const launchpad = resolveLaunchpad(req.body?.launchpad);
    store.launchpad = launchpad;
    saveStore(store);
    pushLog(
        `🚀 Launching $${symbol} on ${launchpadLabel(launchpad)} · creator buy ${devBuyEth} ETH${
            buyAfter
                ? ` · then ${buyMode} buy ${list.length} wallets`
                : ""
        }`,
        "ok"
    );
    res.json({ ok: true, job: publicJob() });

    try {
        const launchWallet = {
            private_key: d.private_key || d.privateKey,
            address: d.address,
        };
        const launchOpts = {
                name,
                symbol,
                metadataURI: req.body?.metadataURI || req.body?.uri || "",
                description: req.body?.description || "",
                twitter: req.body?.twitter || "",
                telegram: req.body?.telegram || "",
                website: req.body?.website || "",
                discord: req.body?.discord || "",
                buyEth: devBuyEth,
            };
        const launched =
            launchpad === "apestore"
                ? await apestore.launchToken(launchWallet, launchOpts)
                : launchpad === "koa"
                  ? await koa.launchToken(launchWallet, launchOpts)
                  : await chain.launchToken(launchWallet, launchOpts);
        if (launched?.error) {
            pushLog(`❌ launch failed: ${launched.error}`, "err");
            job.result = { error: launched.error, hash: launched.hash || null };
            return;
        }
        const token = launched.token;
        store.lastToken = token;
        if (store.projects?.[store.activeProjectId]) {
            store.projects[store.activeProjectId].status = "live";
            store.projects[store.activeProjectId].token = token;
        }
        // Money Desk: track deployed capital + launch expense
        try {
            const md = moneyDesk.ensureMoneyDesk(store);
            const cap = projectCapital(store.activeProjectId);
            const buySum = list.reduce(
                (a, w) => a + (Number(w.buyAmountEth) || 0),
                0
            );
            const deployed = buySum + Number(devBuyEth || 0);
            cap.deployedEth = Math.max(Number(cap.deployedEth || 0), deployed);
            const fBal = await liveFunderEth().catch(() => 0);
            if (cap.initialTreasuryEth == null) cap.initialTreasuryEth = fBal + deployed;
            moneyDesk.addExpense(md, {
                category: "launch_tx",
                label: `Launch $${symbol}`,
                eth: Number(devBuyEth || 0) * 0.05 + 0.005, // rough create gas placeholder
                projectId: store.activeProjectId,
                token,
                kind: "expense",
            });
            try {
                const mc = await chain.resolveLiveMarketCap(token);
                if (mc?.mcapUsd) cap.launchMcapUsd = mc.mcapUsd;
            } catch (_) {}
        } catch (_) {}
        saveStore(store);
        setProgress(1, buyAfter ? list.length + 1 : 1, "launched");
        pushLog(
            `✅ launched ${token} · ${EXPLORER}/tx/${launched.hash}`,
            "ok"
        );
        pushLog(`🔗 ${launched.apeUrl || launched.koaUrl || launched.noxaUrl || token}`, "info");

        // Brief wait so pool is queryable; creator swap already happened in create tx
        await chain.sleep(800);
        try {
            const swaps = await chain.countPoolSwaps(token);
            pushLog(`Pool swaps: ${swaps}`, "info");
        } catch (_) {}

        let buyResult = null;
        if (buyAfter) {
            const byAddr = new Map(
                list.map((w) => [
                    String(w.address || "").toLowerCase(),
                    w,
                ])
            );
            pushLog(
                buyMode === "organic"
                    ? `🌱 Organic buying ${list.length} wallets · ≤${(organicMaxDipPct * 100).toFixed(0)}% MC soft-sells…`
                    : `⚡ Burst buying ${list.length} wallets…`,
                "info"
            );
            let done = 1;
            const launchBuyers = list.map((w) => ({
                    private_key: w.private_key || w.privateKey,
                    address: w.address,
                    name: w.name,
                    buyAmountEth: w.buyAmountEth,
                    delaySec: w.delaySec ?? 0,
                }));
            buyResult =
                launchpad === "apestore"
                    ? await apestore.multiBuy(launchBuyers, token, {
                          mode: buyMode === "organic" ? "sequential" : buyMode,
                          concurrency: Math.min(4, Number(req.body?.concurrency || 3)),
                          waitForReceipt: true,
                          shouldAbort: () => job.abort === true,
                          onProgress: (ev) => {
                              if (ev.type === "bought") {
                                  done++;
                                  setProgress(done, list.length + 1, "bought");
                                  pushLog(`✅ helper buy · ${EXPLORER}/tx/${ev.hash}`, "ok");
                              } else if (ev.type === "error") {
                                  done++;
                                  setProgress(done, list.length + 1, "error");
                                  pushLog(`❌ ${ev.name || ev.wallet}: ${ev.error}`, "err");
                              } else if (ev.type === "buying") {
                                  pushLog(`🛒 ${ev.name || ev.wallet} buying ${ev.amount} ETH`, "info");
                              }
                          },
                      })
                    : await chain.multiBuy(launchBuyers, token, {
                    mode: buyMode,
                    fast: buyMode === "burst",
                    waitForReceipt: false,
                    concurrency: Math.min(
                        16,
                        Math.max(6, Number(req.body?.concurrency || 12))
                    ),
                    staggerMs: Math.max(0, Number(req.body?.staggerMs ?? 35)),
                    tapeGuard: true,
                    foreignBuyPolicy:
                        buyMode === "organic" ? "organic" : "react",
                    foreignMinEth,
                    organicPaceSec,
                    organicQuietSec,
                    organicMaxDipPct,
                    organicSellPct,
                    shouldAbort: () => job.abort === true,
                    reactSell: async (bought) => {
                        if (buyMode === "organic") return;
                        const toSell = bought
                            .map((r) =>
                                byAddr.get(String(r.wallet || "").toLowerCase())
                            )
                            .filter(Boolean);
                        if (!toSell.length) return;
                        pushLog(
                            `REACT: dumping ${toSell.length} filled wallet(s)…`,
                            "info"
                        );
                        await chain.multiSell(toSell, token, {
                            mode: "parallel",
                            percent: 100,
                            onProgress: (sev) => {
                                if (sev.type === "sold") {
                                    pushLog(
                                        `💥 react-sold ${sev.name || sev.wallet}`,
                                        "ok"
                                    );
                                }
                            },
                        });
                    },
                    onProgress: (ev) => {
                        if (ev.type === "buying") {
                            pushLog(
                                `💸 ${ev.name || ev.wallet} buying ${ev.amountEth ?? ev.amount} ETH`,
                                "info"
                            );
                        } else if (ev.type === "bought") {
                            done++;
                            setProgress(
                                Math.min(done, list.length + 1),
                                list.length + 1,
                                "buying"
                            );
                            pushLog(
                                `${ev.pending ? "📡" : "✅"} ${ev.name || ev.wallet} · ${EXPLORER}/tx/${ev.hash}`,
                                "ok"
                            );
                        } else if (ev.type === "error") {
                            pushLog(
                                `❌ ${ev.name || ev.wallet}: ${ev.error || ev.reason}`,
                                "err"
                            );
                        } else if (ev.type === "warn") {
                            pushLog(`⚠️ ${ev.msg || ev.wallet}`, "info");
                        } else if (ev.type === "waiting") {
                            pushLog(
                                `⏳ waiting ${ev.delaySec}s${ev.organic ? " (organic)" : ""}…`,
                                "info"
                            );
                        } else if (ev.type === "foreign_buy") {
                            pushLog(
                                `🚨 FOREIGN BUY · ${ev.count} · ~${Number(ev.ethTotal || 0).toFixed(4)} ETH`,
                                "err"
                            );
                        } else if (ev.type === "organic_soft_sell") {
                            pushLog(`📉 ${ev.msg || "Soft-sell…"}`, "info");
                        } else if (ev.type === "organic_sold") {
                            pushLog(
                                `💸 soft-sold ${ev.name || ev.wallet} · ${ev.percent}%`,
                                "ok"
                            );
                        } else if (ev.type === "organic_soft_sell_done") {
                            pushLog(`🛡️ ${ev.msg || "Soft-sell done"}`, "ok");
                        } else if (ev.type === "organic_wait_quiet") {
                            pushLog(`⏸️ ${ev.msg}`, "info");
                        } else if (ev.type === "organic_resume") {
                            pushLog(`▶️ ${ev.msg}`, "ok");
                        } else if (ev.type === "guard_action") {
                            pushLog(`🛡️ ${ev.msg || ev.action}`, "info");
                        } else if (ev.type === "wave") {
                            pushLog(`⚡ ${ev.msg || "buying"}`, "info");
                        }
                    },
                });
        }

        job.result = {
            ok: true,
            token,
            launchHash: launched.hash,
            noxaUrl: launched.noxaUrl,
            buyResults: buyResult || null,
        };
        pushLog(`🏁 Launch${buyAfter ? "+buy" : ""} done · ${token}`, "ok");
        broadcast({
            type: "launched",
            token,
            hash: launched.hash,
            job: publicJob(),
        });
    } catch (e) {
        pushLog(`❌ launch: ${e.shortMessage || e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

function normalizeRole(raw) {
    if (raw === "funder") return "funder";
    if (raw === "distributor") return "distributor";
    if (raw === "sniper") return "sniper";
    if (raw === "dev" || raw === "creator" || raw === "deployer") return "dev";
    return "buyer";
}

function findDev() {
    return (
        (store.wallets || []).find(
            (w) => String(w.role || "").toLowerCase() === "dev"
        ) || null
    );
}

function publicProjects(s = store) {
    const projects = s?.projects || {};
    return Object.values(projects).map((p) => {
        const wallets = Array.isArray(p.wallets) ? p.wallets : [];
        const buyers = wallets.filter(
            (w) => String(w.role || "buyer").toLowerCase() === "buyer"
        );
        const dev = wallets.find(
            (w) => String(w.role || "").toLowerCase() === "dev"
        );
        return {
            id: p.id,
            label: p.label || p.id,
            status: p.status || "draft",
            token: p.token || "",
            buyerCount: buyers.length,
            hasPlan: !!p.lastPlan,
            hasDev: !!dev,
            devAddress: dev?.address || null,
        };
    });
}

app.post("/api/wallets/create", (req, res) => {
    const count = Math.min(
        MAX_BUNDLE_WALLETS,
        Math.max(1, Number(req.body.count || 1))
    );
    const role = normalizeRole(req.body.role);
    const existingBuyers = buyersOnly().length;
    if (role === "buyer" && existingBuyers + count > MAX_BUNDLE_WALLETS) {
        return res.status(400).json({
            error: `Would exceed max ${MAX_BUNDLE_WALLETS} buyers (have ${existingBuyers})`,
        });
    }
    const created = [];
    for (let i = 0; i < count; i++) {
        if (role === "funder") {
            store.wallets.forEach((w) => {
                if (w.role === "funder") w.role = "buyer";
            });
        }
        if (role === "sniper") {
            // Only one dedicated sniper wallet
            store.wallets = store.wallets.filter((w) => w.role !== "sniper");
        }
        if (role === "dev") {
            // One creator/dev wallet per active project tab
            store.wallets = store.wallets.filter(
                (w) => String(w.role || "").toLowerCase() !== "dev"
            );
        }
        const w = chain.generateWallet();
        const buyerNum = buyersOnly().length + 1;
        const entry = {
            name:
                role === "funder"
                    ? "Funder"
                    : role === "sniper"
                      ? "Sniper"
                      : role === "dev"
                        ? "Dev"
                        : role === "distributor"
                          ? `Distributor ${distributors().length + 1}`
                          : `Buyer ${buyerNum}`,
            address: w.address,
            private_key: w.privateKey,
            role,
            buyAmountEth: null,
            delaySec: role === "buyer" ? 15 * buyersOnly().length : 0,
        };
        store.wallets.push(entry);
        if (role === "sniper") {
            store.snipeConfig = store.snipeConfig || {};
            store.snipeConfig.walletIndex = store.wallets.length - 1;
        }
        created.push({
            name: entry.name,
            address: entry.address,
            privateKey: entry.private_key,
            role,
        });
    }
    saveStore(store);
    res.json({ ok: true, created, wallets: publicWallets() });
});

app.post("/api/wallets/import", (req, res) => {
    const { privateKey, role: rawRole, name } = req.body || {};
    if (!chain.isEvmPrivateKey(privateKey || "")) {
        return res.status(400).json({ error: "Invalid private key" });
    }
    const role = normalizeRole(rawRole);
    const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const w = chain.generateWallet(pk);
    if (store.wallets.some((x) => x.address.toLowerCase() === w.address.toLowerCase())) {
        return res.status(400).json({ error: "Wallet already added" });
    }
    if (role === "funder") {
        store.wallets.forEach((x) => {
            if (x.role === "funder") x.role = "buyer";
        });
    }
    if (role === "sniper") {
        store.wallets = store.wallets.filter((x) => x.role !== "sniper");
    }
    if (role === "dev") {
        store.wallets = store.wallets.filter(
            (x) => String(x.role || "").toLowerCase() !== "dev"
        );
    }
    store.wallets.push({
        name:
            name ||
            (role === "funder"
                ? "Funder"
                : role === "sniper"
                  ? "Sniper"
                  : role === "dev"
                    ? "Dev"
                    : `Buyer ${buyersOnly().length + 1}`),
        address: w.address,
        private_key: w.privateKey,
        role,
        buyAmountEth: null,
        delaySec: role === "buyer" ? 15 : 0,
    });
    if (role === "sniper") {
        store.snipeConfig = store.snipeConfig || {};
        store.snipeConfig.walletIndex = store.wallets.length - 1;
    }
    saveStore(store);
    res.json({ ok: true, address: w.address, wallets: publicWallets(), role });
});

app.patch("/api/wallets/:index", (req, res) => {
    const i = Number(req.params.index);
    const w = store.wallets[i];
    if (!w) return res.status(404).json({ error: "Not found" });
    const { name, buyAmountEth, delaySec, role } = req.body || {};
    if (name != null) w.name = String(name);
    if (buyAmountEth != null) {
        w.buyAmountEth = buyAmountEth === "" || buyAmountEth === null ? null : Number(buyAmountEth);
    }
    if (delaySec != null) w.delaySec = Number(delaySec);
    if (role === "funder") {
        store.wallets.forEach((x, idx) => {
            x.role = idx === i ? "funder" : x.role === "funder" ? "buyer" : x.role || "buyer";
        });
    } else if (role === "buyer") {
        w.role = "buyer";
    }
    saveStore(store);
    res.json({ ok: true, wallets: publicWallets() });
});

app.delete("/api/wallets/:index", (req, res) => {
    const i = Number(req.params.index);
    if (!store.wallets[i]) return res.status(404).json({ error: "Not found" });
    const removed = store.wallets[i];
    store.wallets.splice(i, 1);
    // Keep snipeConfig.walletIndex pointed at the sniper after deletes
    const s = sniper();
    if (s) {
        store.snipeConfig = store.snipeConfig || {};
        store.snipeConfig.walletIndex = store.wallets.indexOf(s);
    } else if (removed?.role === "sniper" && store.snipeConfig) {
        store.snipeConfig.walletIndex = null;
        store.snipeConfig.enabled = false;
    }
    saveStore(store);
    res.json({ ok: true, wallets: publicWallets() });
});

/** Remove buyer wallets for the *active project only*. Keeps funder/sniper/dev and other projects. */
app.post("/api/wallets/clear-buyers", (req, res) => {
    const before = store.wallets.length;
    const removed = store.wallets.filter(
        (w) => (w.role || "buyer") === "buyer"
    ).length;
    store.wallets = store.wallets.filter(
        (w) => (w.role || "buyer") !== "buyer"
    );
    const s = sniper();
    if (s) {
        store.snipeConfig = store.snipeConfig || {};
        store.snipeConfig.walletIndex = store.wallets.indexOf(s);
    }
    // Drop buy + sell plans tied to this project (Force restart)
    store.lastPlan = null;
    store.lastSellPlan = null;
    store.lastSellPreview = null;
    store.lastToken = "";
    store.lastBuyFailures = [];
    store.hopVault = [];
    if (IS_BUNDLER_HOST && store.projects && store.activeProjectId) {
        const p = store.projects[store.activeProjectId];
        if (p) {
            p.status = "draft";
            p.label = p.label || store.activeProjectId;
        }
    }
    saveStore(store);
    res.json({
        ok: true,
        removed,
        kept: store.wallets.length,
        before,
        projectId: store.activeProjectId || null,
        wallets: publicWallets(),
        projects: IS_BUNDLER_HOST ? publicProjects(store) : [],
    });
});

app.post("/api/sniper/fund", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    const s = sniper();
    if (!f) return res.status(400).json({ error: "Import a funder first (bundler)" });
    if (!s) return res.status(400).json({ error: "Import/create a sniper wallet first" });
    const amountEth = Number(req.body?.amountEth || 0.05);
    if (!(amountEth > 0)) return res.status(400).json({ error: "Invalid amount" });

    setJob({
        running: true,
        type: "fund",
        logs: [],
        result: null,
        progress: { done: 0, total: 1, label: "fund sniper" },
    });
    pushLog(
        `Funding sniper ${s.address.slice(0, 10)}… with ${amountEth} ETH from funder`,
        "info"
    );
    res.json({ ok: true, job: publicJob() });

    try {
        const tx = await chain.transferEth(
            { private_key: f.private_key },
            s.address,
            amountEth
        );
        await chain.waitTx(tx);
        setProgress(1, 1, "funded");
        pushLog(`✅ sniper funded · ${EXPLORER}/tx/${tx.hash}`, "ok");
        job.result = { hash: tx.hash, amountEth, to: s.address };
    } catch (e) {
        pushLog(`❌ fund sniper: ${e.shortMessage || e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

/** Wipe snipes + P&L history and start fresh (keeps wallets). */
app.post("/api/sniper/reset", (req, res) => {
    const before = (store.snipes || []).length;
    // Archive old ledger once, then wipe
    try {
        const archive = path.join(
            path.dirname(STORE_FILE),
            `snipes-archive-${Date.now()}.json`
        );
        fs.writeFileSync(
            archive,
            JSON.stringify(
                {
                    at: new Date().toISOString(),
                    snipes: store.snipes || [],
                    snipeConfig: store.snipeConfig,
                },
                null,
                2
            )
        );
    } catch (_) {}

    store.snipes = [];
    openPositions.clear();
    store.snipeConfig = store.snipeConfig || {};
    store.snipeConfig.enabled = false;
    if (req.body?.clearAutoSell) store.snipeConfig.autoSell = false;
    store.snipeLedgerResetAt = new Date().toISOString();
    saveStore(store);

    // Clear in-memory job logs so UI starts clean
    job.logs = [];
    job.result = null;
    job.progress = { done: 0, total: 0, label: "" };

    pushLog(
        `🧹 Fresh start · cleared ${before} snipe records + logs · P&L at $0 · sniper ${sniper()?.address?.slice(0, 10) || "—"}…`,
        "info"
    );
    broadcast({ type: "snipe_reset", cleared: before, logsCleared: true });
    res.json({
        ok: true,
        cleared: before,
        resetAt: store.snipeLedgerResetAt,
        sniper: sniper()
            ? { address: sniper().address, role: "sniper" }
            : null,
        config: store.snipeConfig,
    });
});

/** Download all wallet private keys as CSV (local backup). */
app.get("/api/wallets/export.csv", (req, res) => {
    if (!store.wallets.length) {
        return res.status(400).json({ error: "No wallets to export" });
    }
    const roles = String(req.query.roles || "all")
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
    const includeAll = roles.includes("all") || !roles.length;

    const esc = (v) => {
        const s = v == null ? "" : String(v);
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const header = [
        "index",
        "role",
        "name",
        "address",
        "private_key",
        "buyAmountEth",
        "delaySec",
        "seasoned",
    ];
    const lines = [header.join(",")];
    let count = 0;
    store.wallets.forEach((w, i) => {
        const role = String(w.role || "buyer").toLowerCase();
        if (!includeAll && !roles.includes(role)) return;
        count++;
        lines.push(
            [
                i,
                w.role || "buyer",
                w.name || "",
                w.address || "",
                w.private_key || "",
                w.buyAmountEth ?? "",
                w.delaySec ?? 0,
                w.seasoned ? "yes" : "no",
            ]
                .map(esc)
                .join(",")
        );
    });
    if (!count) {
        return res.status(400).json({ error: "No wallets matched filter" });
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="noxa-wallets-${stamp}.csv"`
    );
    res.send(lines.join("\n") + "\n");
});

app.get("/api/wallets/:index/pk", (req, res) => {
    const i = Number(req.params.index);
    const w = store.wallets[i];
    if (!w) return res.status(404).json({ error: "Not found" });
    res.json({ address: w.address, privateKey: w.private_key });
});

app.get("/api/token/:address", async (req, res) => {
    try {
        if (!chain.isEvmAddress(req.params.address)) {
            return res.status(400).json({ error: "Invalid address" });
        }
        const pad = resolveLaunchpad(req.query.launchpad || store.launchpad);
        const ethUsd = await chain.getEthUsdPrice();
        let t;
        let stats = {};
        let supply = chain.NOXA_DEFAULT_SUPPLY;
        let priceEth = 0;
        let mcapEth = 0;
        let mcapUsd = 0;
        let tokenUrl = "";

        if (pad === "apestore") {
            let apeInfo;
            try {
                apeInfo = await apestore.getTokenInfo(req.params.address);
            } catch (e) {
                const status = e?.response?.status;
                if (status === 404) {
                    return res.status(404).json({
                        error:
                            "Token not found on ApeStore (Robinhood). Check the address or switch launchpad to NOXA.",
                        launchpad: "apestore",
                    });
                }
                throw e;
            }
            const shaped = apestore.toPlanTokenInfo(apeInfo, ethUsd);
            t = shaped.token;
            stats = shaped.stats || {};
            supply = Number(t.supply) || chain.NOXA_DEFAULT_SUPPLY;
            priceEth = Number(t.priceEth || 0);
            mcapEth = Number(t.marketCapEth || 0);
            mcapUsd =
                Number(apeInfo.marketCap || 0) ||
                chain.ethToUsd(mcapEth, ethUsd);
            tokenUrl = shaped.apeUrl || `https://ape.store/rh/${t.address}`;
        } else {
            let info;
            try {
                info = await chain.getTokenInfo(req.params.address);
            } catch (e) {
                const status = e?.response?.status;
                if (status === 404) {
                    return res.status(404).json({
                        error:
                            "Token not found on NOXA. If this is an ApeStore coin, switch the launchpad to ApeStore and try again.",
                        launchpad: "noxa",
                    });
                }
                throw e;
            }
            t = info.token || info;
            stats = info.stats || {};
            try {
                supply = Number(
                    ethers.formatUnits(
                        t.supply || t.totalSupply || "0",
                        t.decimals ?? 18
                    )
                );
            } catch (_) {}
            priceEth = Number(t.priceEth || 0);
            mcapEth = Number(t.marketCapEth || 0);
            mcapUsd = chain.ethToUsd(mcapEth, ethUsd);
            tokenUrl = `https://fun.noxa.fi/robinhood/${t.address || req.params.address}`;
        }

        store.lastToken = t.address || req.params.address;
        store.launchpad = pad;
        saveStore(store);
        res.json({
            address: t.address || req.params.address,
            name: t.name,
            symbol: t.symbol,
            supply,
            priceEth,
            mcapEth,
            mcapUsd,
            mcapUsdLabel: chain.formatUsd(mcapUsd),
            ethUsd,
            volume24hEth: Number(stats.volume24hEth || 0),
            poolFee: t.poolFee || 10000,
            startingMcEth: chain.NOXA_STARTING_MC_ETH,
            startingMcUsd: chain.ethToUsd(chain.NOXA_STARTING_MC_ETH, ethUsd),
            startingMcUsdLabel: chain.formatUsd(
                chain.ethToUsd(chain.NOXA_STARTING_MC_ETH, ethUsd)
            ),
            maxWalletPct: chain.NOXA_MAX_WALLET_BPS / 100,
            maxWalletTokens: (supply * chain.NOXA_MAX_WALLET_BPS) / 10000,
            launchpad: pad,
            noxaUrl: tokenUrl,
            apeUrl: pad === "apestore" ? tokenUrl : undefined,
        });
    } catch (e) {
        const status = e?.response?.status;
        res.status(status === 404 ? 404 : 500).json({
            error: e.response?.data?.message || e.message,
        });
    }
});

app.post("/api/plan", async (req, res) => {
    try {
        const {
            token,
            totalEth,
            walletCount,
            baseDelaySec,
            startPctSupply,
            endPctSupply,
            launchpad: bodyPad,
        } = req.body || {};
        if (!chain.isEvmAddress(token)) {
            return res.status(400).json({ error: "Invalid token" });
        }
        const pad = resolveLaunchpad(bodyPad || store.launchpad);
        const planOpts = {
            baseDelaySec: baseDelaySec ?? 0,
            startPctSupply:
                startPctSupply != null ? Number(startPctSupply) : 0.4,
            endPctSupply:
                endPctSupply != null ? Number(endPctSupply) : undefined,
            useQuoter: true,
        };

        if (pad === "apestore") {
            try {
                const ethUsd = await chain.getEthUsdPrice();
                const apeInfo = await apestore.getTokenInfo(token);
                planOpts.tokenInfo = apestore.toPlanTokenInfo(apeInfo, ethUsd);
                planOpts.fee = 10000;
            } catch (e) {
                const status = e?.response?.status;
                if (status === 404) {
                    return res.status(404).json({
                        error:
                            "Token not found on ApeStore. Paste the Robinhood token contract address.",
                        launchpad: "apestore",
                    });
                }
                throw e;
            }
        }

        const plan = await chain.buildBuyPlan(
            token,
            totalEth,
            walletCount,
            planOpts
        );
        plan.rows = plan.rows.map((r) => ({
            ...r,
            tokensLabel: chain.formatTokenAmount(r.tokensEst),
        }));
        plan.totalTokensLabel = chain.formatTokenAmount(plan.totalTokensEst);
        plan.launchpad = pad;
        store.lastPlan = plan;
        store.lastToken = token;
        store.launchpad = pad;
        saveStore(store);
        res.json(plan);
    } catch (e) {
        const status = e?.response?.status;
        if (status === 404) {
            return res.status(404).json({
                error:
                    "Token not found. Switch launchpad (NOXA / ApeStore) to match where the coin lives.",
            });
        }
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/plan/apply", (req, res) => {
    const plan = store.lastPlan;
    if (!plan) return res.status(400).json({ error: "No plan yet" });
    if (plan.walletCount > MAX_BUNDLE_WALLETS) {
        return res.status(400).json({
            error: `Plan has ${plan.walletCount} wallets — max is ${MAX_BUNDLE_WALLETS}`,
        });
    }

    const need = plan.walletCount - buyersOnly().length;
    if (need > 0) {
        const batch = [];
        for (let i = 0; i < need; i++) {
            const w = chain.generateWallet();
            batch.push({
                name: `Buyer ${buyersOnly().length + batch.length + 1}`,
                address: w.address,
                private_key: w.privateKey,
                role: "buyer",
                buyAmountEth: null,
                delaySec: 0,
            });
        }
        store.wallets.push(...batch);
    }

    const b = buyersOnly();
    b.slice(0, plan.walletCount).forEach((w, i) => {
        w.buyAmountEth = plan.rows[i].eth;
        w.delaySec = plan.rows[i].delaySec;
        w.name = `Buyer ${i + 1}`;
    });
    b.slice(plan.walletCount).forEach((w) => {
        w.buyAmountEth = null;
    });
    saveStore(store);
    res.json({ ok: true, wallets: publicWallets() });
});

app.post("/api/fund", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    if (!f) return res.status(400).json({ error: "Add a funder wallet first" });
    const dest = buyersOnly().filter((w) => Number(w.buyAmountEth) > 0);
    if (!dest.length) {
        return res.status(400).json({ error: "No buyer amounts — apply a plan first" });
    }
    const hops = Math.min(3, Math.max(1, Number(req.body?.hops || 2)));

    setJob({ running: true, type: "fund", logs: [], result: null });
    pushLog(`Funding ${dest.length} wallets via ${hops} hop(s)…`, "info");
    res.json({ ok: true, job: publicJob() });

    try {
        const results = await chain.disperseWithHops(
            { private_key: f.private_key },
            dest.map((w) => ({
                address: w.address,
                amountEth: w.buyAmountEth,
                name: w.name,
            })),
            {
                hops,
                buyerGasBufferEth: chain.BUYER_GAS_BUFFER_ETH,
                onHopCreated: ({ hops: hopKeys, dest: d, name }) => {
                    persistHopKeys(hopKeys, { dest: d, destName: name });
                    pushLog(
                        `🔐 saved ${hopKeys.length} hop key(s) for ${name || d} (recoverable if stuck)`,
                        "info"
                    );
                },
                onProgress: (ev) => {
                    if (ev.type === "start") {
                        pushLog(
                            `→ ${ev.name}: ${ev.amountEth} ETH (+gas) via ${ev.hops.length} hops`,
                            "info"
                        );
                    } else if (ev.type === "hop") {
                        pushLog(`  hop ${ev.step}: ${EXPLORER}/tx/${ev.hash}`, "tx");
                    } else if (ev.type === "done") {
                        markHopsDelivered(ev.dest);
                        pushLog(`✅ ${ev.name} funded · ${EXPLORER}/tx/${ev.hash}`, "ok");
                    } else if (ev.type === "error") {
                        pushLog(
                            `❌ ${ev.name || ev.dest}: ${ev.error} — hop keys kept for recovery`,
                            "err"
                        );
                    }
                },
            }
        );
        job.result = results;
        const okN = results.filter((r) => r.ok !== false && !r.error).length;
        pushLog(`Funding complete · ${okN}/${results.length} ok`, "ok");
    } catch (e) {
        pushLog(`Funding failed: ${e.shortMessage || e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});


app.get("/api/launchpad", async (_req, res) => {
    const pad = resolveLaunchpad(store.launchpad);
    let ape = null;
    let koaPing = null;
    try {
        ape = await apestore.ping();
    } catch (e) {
        ape = { ok: false, error: e.message };
    }
    try {
        koaPing = await koa.ping();
    } catch (e) {
        koaPing = { ok: false, error: e.message };
    }
    const notes = {
        apestore: "Buys/sells use ApeStore Robinhood router + signature API",
        koa: "Launch via KOA factory; buys/sells use Uniswap V3 (same as NOXA)",
        noxa: "Buys/sells use NOXA Fun factory / Uni V3",
    };
    res.json({
        launchpad: pad,
        options: ["noxa", "apestore", "koa"],
        apestore: ape,
        koa: koaPing,
        note: notes[pad] || notes.noxa,
    });
});

app.post("/api/launchpad", (req, res) => {
    const pad = resolveLaunchpad(req.body?.launchpad);
    store.launchpad = pad;
    saveStore(store);
    res.json({ ok: true, launchpad: pad });
});

/** Privacy funding: ChangeNOW → Across (Base → Robinhood) */
app.get("/api/privacy/status", async (_req, res) => {
    try {
        res.json(await privacy.status());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/privacy/preview", async (req, res) => {
    try {
        const list =
            Array.isArray(req.body?.destinations) && req.body.destinations.length
                ? req.body.destinations
                : buyersOnly()
                      .filter((w) => Number(w.buyAmountEth) > 0)
                      .map((w) => ({
                          address: w.address,
                          amountEth:
                              Number(w.buyAmountEth) +
                              Number(process.env.BUYER_GAS_BUFFER_ETH || 0.002),
                      }));
        res.json(await privacy.previewPrivacyFund(list));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/privacy/changenow", async (req, res) => {
    try {
        const amountEth = Number(req.body?.amountEth || 0);
        if (!(amountEth > 0)) {
            return res.status(400).json({ error: "amountEth required" });
        }
        const wallet = privacy.bridgeWallet();
        const toAddress =
            req.body?.toAddress ||
            wallet?.address ||
            null;
        if (!toAddress) {
            return res.status(400).json({
                error:
                    "Set PRIVACY_BRIDGE_PK (Base wallet) or pass toAddress for ChangeNOW payout",
            });
        }
        const order = await privacy.changeNowCreate({
            amountEth,
            toAddress,
            from: req.body?.from || "eth",
            to: req.body?.to || "ethbase",
            refundAddress: req.body?.refundAddress || null,
        });
        res.json({ ok: true, order });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/privacy/changenow/:id", async (req, res) => {
    try {
        res.json(await privacy.changeNowStatus(req.params.id));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/privacy/across", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const dryRun = req.body?.dryRun !== false && req.body?.arm !== true;
    const list =
        Array.isArray(req.body?.destinations) && req.body.destinations.length
            ? req.body.destinations
            : buyersOnly()
                  .filter((w) => Number(w.buyAmountEth) > 0)
                  .map((w) => ({
                      address: w.address,
                      amountEth:
                          Number(w.buyAmountEth) +
                          Number(process.env.BUYER_GAS_BUFFER_ETH || 0.002),
                  }));
    if (!list.length) {
        return res.status(400).json({ error: "No destinations — apply a plan first" });
    }

    setJob({
        running: true,
        type: "privacy_across",
        logs: [],
        result: null,
        progress: { done: 0, total: list.length, label: dryRun ? "quoting" : "bridging" },
        abort: false,
    });
    pushLog(
        dryRun
            ? `🔐 Privacy Across preview · ${list.length} wallets (dry-run)`
            : `🔐 Privacy Across LIVE · ${list.length} wallets Base→Robinhood`,
        dryRun ? "info" : "ok"
    );
    res.json({ ok: true, job: publicJob(), dryRun });

    try {
        let done = 0;
        const out = await privacy.executeAcrossLegs(list, {
            dryRun,
            delayMs: Number(req.body?.delayMs || 2500),
            onProgress: async (ev) => {
                done++;
                setProgress(done, list.length, ev.type || "progress");
                if (ev.type === "bridged") {
                    pushLog(
                        `✅ bridged → ${ev.address?.slice(0, 10)}… · ${ev.hash}`,
                        "ok"
                    );
                } else if (ev.type === "quoted") {
                    pushLog(`quote ok · ${ev.address?.slice(0, 10)}… ${ev.amountEth} ETH`, "info");
                } else if (ev.type === "error") {
                    pushLog(`❌ ${ev.address?.slice(0, 10)}… ${ev.error}`, "err");
                }
            },
        });
        job.result = out;
        pushLog(
            dryRun
                ? `Done quoting ${out.results?.length || 0} legs`
                : `Across finished · ${out.results?.filter((r) => r.ok).length || 0} ok`,
            "ok"
        );
    } catch (e) {
        pushLog(`Privacy Across failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

app.post("/api/buy/cancel", (req, res) => {
    if (!job.running || (job.type !== "buy" && job.type !== "launch")) {
        return res.status(400).json({ error: "No buy/launch job running" });
    }
    job.abort = true;
    pushLog(
        "⛔ Cancel requested — finishing current wallet, then stopping remaining buys",
        "info"
    );
    res.json({ ok: true, job: publicJob() });
});

app.post("/api/buy", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const token = req.body?.token || store.lastToken;
    if (!chain.isEvmAddress(token || "")) {
        return res.status(400).json({ error: "Invalid token" });
    }
    const listAll = buyersOnly().filter((w) => Number(w.buyAmountEth) > 0);
    let list = listAll;
    // Retry path: only wallets that failed last run (or explicit addresses)
    if (req.body?.onlyFailed) {
        const failSet = new Set(
            (store.lastBuyFailures || []).map((f) =>
                String(f.address || "").toLowerCase()
            )
        );
        list = listAll.filter((w) =>
            failSet.has(String(w.address || "").toLowerCase())
        );
        if (!list.length) {
            return res.status(400).json({
                error: "No failed buyers to retry — run a buy first, or all already filled",
            });
        }
    } else if (Array.isArray(req.body?.addresses) && req.body.addresses.length) {
        const want = new Set(
            req.body.addresses.map((a) => String(a).toLowerCase())
        );
        list = listAll.filter((w) =>
            want.has(String(w.address || "").toLowerCase())
        );
    }
    if (!list.length) {
        return res.status(400).json({ error: "No buyer amounts — apply a plan first" });
    }

    // Money Desk: kill switch + reserve (buys spend buyer wallets, still check funder floor)
    try {
        const planned = list.reduce(
            (a, w) => a + (Number(w.buyAmountEth) || 0),
            0
        );
        const gate = await assertMoneyGate({
            plannedEth: planned,
            action: "buy",
        });
        if (!gate.ok && gate.status === "kill") {
            return res.status(400).json({
                error: gate.plainEnglish,
                code: "kill",
                money: { kill: gate.overview?.kill },
            });
        }
    } catch (_) {}

    const modeRaw = String(req.body?.mode || "burst").toLowerCase();
    const mode =
        modeRaw === "sequential"
            ? "sequential"
            : modeRaw === "organic"
              ? "organic"
              : "burst";
    // Pipeline in-flight cap — public RPC hangs above ~16 parallel sends
    const concurrency = Math.min(
        16,
        Math.max(6, Number(req.body?.concurrency || 12))
    );
    const slippageBps = Number(req.body?.slippageBps) || undefined;
    const priorityMultiplier = Number(req.body?.priorityMultiplier) || undefined;
    const tapeGuard = req.body?.tapeGuard !== false;
    const foreignBuyPolicy = String(
        req.body?.foreignBuyPolicy ||
            (mode === "organic" ? "organic" : "react")
    ).toLowerCase();
    const foreignMinEth = Math.max(
        0,
        Number(req.body?.foreignMinEth ?? 0.008)
    );
    const retries = Math.min(
        6,
        Math.max(
            1,
            Number(
                req.body?.retries ??
                    (mode === "burst" ? 3 : mode === "organic" ? 2 : 2)
            )
        )
    );
    const buyTimeoutMs = Math.max(
        8000,
        Number(req.body?.buyTimeoutMs || 18000)
    );
    const staggerMs = Math.max(0, Number(req.body?.staggerMs ?? 35));
    // Organic: pace + chart-safe soft sells (10–20% MC dips)
    const organicPaceSec = Math.max(
        2,
        Number(req.body?.organicPaceSec ?? 10)
    );
    const organicPaceJitterSec = Math.max(
        0,
        Number(req.body?.organicPaceJitterSec ?? 6)
    );
    const organicQuietSec = Math.max(
        4,
        Number(req.body?.organicQuietSec ?? 12)
    );
    const organicMaxDipPct = Math.min(
        0.2,
        Math.max(
            0.1,
            Number(req.body?.organicMaxDipPct ?? 0.15) > 1
                ? Number(req.body.organicMaxDipPct) / 100
                : Number(req.body?.organicMaxDipPct ?? 0.15)
        )
    );
    const organicSellPct = Math.min(
        50,
        Math.max(8, Number(req.body?.organicSellPct ?? 25))
    );

    const launchpad = resolveLaunchpad(req.body?.launchpad);
    store.launchpad = launchpad;
    store.lastToken = token;
    saveStore(store);

    setJob({
        running: true,
        type: "buy",
        logs: [],
        result: null,
        progress: { done: 0, total: list.length, label: "buying" },
        abort: false,
    });
    pushLog(`Launchpad: ${launchpadLabel(launchpad)}`, "info");
    pushLog(
        mode === "burst"
            ? `BURST buy ${list.length} wallets · pipeline ${concurrency} in-flight · tip · slip · auto-retry ×${retries} (gas→shrink buy)` +
                  (req.body?.onlyFailed ? " · RETRY FAILED ONLY" : "")
            : mode === "organic"
              ? `ORGANIC buy ${list.length} wallets · ~${organicPaceSec}s pace · soft-sell ≤${(organicMaxDipPct * 100).toFixed(0)}% MC dips · quiet ${organicQuietSec}s · retry ×${retries}`
              : `Sequential buy ${list.length} wallets (honors delays) · auto-retry ×${retries}`,
        "info"
    );
    if (mode === "burst") {
        pushLog(
            "Note: public chain can't lock out other traders — burst maximizes our txs landing together.",
            "info"
        );
        if (tapeGuard) {
            pushLog(
                `Interference guard ON · policy=${foreignBuyPolicy} · min foreign buy ${foreignMinEth} ETH (checks between waves)`,
                "info"
            );
        }
    } else if (mode === "organic") {
        pushLog(
            `Organic: slow buy-up · on foreign buy → pause + soft-sell (≤${(organicMaxDipPct * 100).toFixed(0)}% chart dip) · resume when tape quiet ${organicQuietSec}s`,
            "info"
        );
    }
    res.json({ ok: true, job: publicJob() });

    const byAddr = new Map(
        list.map((w) => [String(w.address || "").toLowerCase(), w])
    );

    try {
        let done = 0;
        const buyerPayload = list.map((w) => ({
                private_key: w.private_key,
                address: w.address,
                name: w.name,
                buyAmountEth: w.buyAmountEth,
                delaySec: w.delaySec ?? 0,
            }));
        const results =
            launchpad === "apestore"
                ? await apestore.multiBuy(buyerPayload, token, {
                      mode: mode === "organic" ? "sequential" : mode,
                      concurrency: Math.min(4, Number(concurrency) || 3),
                      slippageBps,
                      priorityMultiplier,
                      waitForReceipt: true,
                      shouldAbort: () => job.abort === true,
                      onProgress: (ev) => {
                          if (ev.type === "buying") {
                              pushLog(
                                  `🛒 ${ev.name || ev.wallet} buying ${ev.amount} ETH (ApeStore)`,
                                  "info"
                              );
                          } else if (ev.type === "bought") {
                              done++;
                              setProgress(done, list.length, "bought");
                              pushLog(
                                  `✅ ${done}/${list.length} · ${EXPLORER}/tx/${ev.hash}`,
                                  "ok"
                              );
                          } else if (ev.type === "waiting") {
                              pushLog(`⏳ ${ev.delayMs}ms…`, "info");
                          } else if (ev.type === "error") {
                              done++;
                              setProgress(done, list.length, "error");
                              pushLog(
                                  `❌ ${ev.name || ev.wallet}: ${ev.error}`,
                                  "err"
                              );
                          }
                      },
                  })
                : await chain.multiBuy(buyerPayload, token, {
                mode,
                concurrency,
                slippageBps,
                priorityMultiplier,
                retries,
                buyTimeoutMs,
                staggerMs,
                tapeGuard:
                    mode === "burst" || mode === "organic" ? tapeGuard : false,
                foreignBuyPolicy,
                foreignMinEth,
                organicPaceSec,
                organicPaceJitterSec,
                organicQuietSec,
                organicMaxDipPct,
                organicSellPct,
                shouldAbort: () => job.abort === true,
                reactSell: async (bought) => {
                    // Burst "react" only — organic uses built-in soft sells
                    if (mode === "organic") return;
                    const toSell = bought
                        .map((r) => byAddr.get(String(r.wallet || "").toLowerCase()))
                        .filter(Boolean);
                    if (!toSell.length) {
                        pushLog("REACT: no filled wallets to dump", "info");
                        return;
                    }
                    pushLog(
                        `REACT: dumping ${toSell.length} filled wallet(s) into foreign buy…`,
                        "info"
                    );
                    setProgress(done, list.length, "react-sell");
                    const sellResults = await chain.multiSell(toSell, token, {
                        mode: "parallel",
                        percent: 100,
                        onProgress: (sev) => {
                            if (sev.type === "sold") {
                                pushLog(
                                    `💥 react-sold ${sev.name || sev.wallet} · ${EXPLORER}/tx/${sev.hash}`,
                                    "ok"
                                );
                            } else if (sev.type === "error") {
                                pushLog(
                                    `❌ react-sell ${sev.wallet}: ${sev.error}`,
                                    "err"
                                );
                            }
                        },
                    });
                    const soldN = sellResults.filter((r) => r.hash).length;
                    pushLog(
                        `REACT sell done · ${soldN}/${toSell.length} sold — resuming remaining buys`,
                        soldN ? "ok" : "err"
                    );
                },
                onProgress: (ev) => {
                    if (ev.type === "mode") {
                        pushLog(
                            `Mode: ${ev.mode} · ${ev.count} wallets · slip ${ev.slippageBps / 100}% · tip ×${ev.priorityMultiplier}` +
                                (ev.tapeGuard
                                    ? ` · guard=${ev.foreignBuyPolicy}`
                                    : "") +
                                (ev.mode === "organic" && ev.organicMaxDipPct
                                    ? ` · max dip ${(ev.organicMaxDipPct * 100).toFixed(0)}%`
                                    : ""),
                            "info"
                        );
                    } else if (ev.type === "wave") {
                        pushLog(
                            `⚡ ${ev.msg || `wave ${ev.from}–${ev.to} / ${ev.total}`}`,
                            "info"
                        );
                        setProgress(ev.from - 1, list.length, "buying");
                    } else if (ev.type === "waiting") {
                        pushLog(
                            `⏳ waiting ${ev.delaySec}s${ev.organic ? " (organic pace)" : ""}…`,
                            "info"
                        );
                    } else if (ev.type === "buying") {
                        if (
                            mode === "organic" ||
                            mode !== "burst" ||
                            (ev.index + 1) % 10 === 1
                        ) {
                            pushLog(
                                `🛒 ${ev.name || ev.wallet} buying ${ev.amountEth} ETH`,
                                "info"
                            );
                        }
                    } else if (ev.type === "warn") {
                        pushLog(`⚠️ ${ev.wallet}: ${ev.msg}`, "info");
                    } else if (ev.type === "bought") {
                        done++;
                        setProgress(done, list.length, "bought");
                        if (
                            mode === "organic" ||
                            mode !== "burst" ||
                            done % 10 === 0 ||
                            done === list.length
                        ) {
                            pushLog(
                                `✅ ${done}/${list.length} submitted · ${EXPLORER}/tx/${ev.hash}`,
                                "ok"
                            );
                        }
                    } else if (ev.type === "error") {
                        done++;
                        setProgress(done, list.length, "error");
                        pushLog(`❌ ${ev.wallet}: ${ev.error}`, "err");
                    } else if (ev.type === "retry") {
                        pushLog(
                            `↻ retry ${ev.attempt}/${ev.maxAttempts} ${ev.name || (ev.wallet || "").slice(0, 10)}… · ${ev.next} · ${ev.error}`,
                            "info"
                        );
                    } else if (ev.type === "foreign_buy") {
                        const b = ev.biggest || {};
                        pushLog(
                            `🚨 FOREIGN BUY · ${ev.count} outsider(s) · ~${Number(ev.ethTotal || 0).toFixed(4)} ETH` +
                                (b.ethAmount
                                    ? ` · biggest ${Number(b.ethAmount).toFixed(4)} ETH from ${(b.trader || "?").slice(0, 10)}…`
                                    : "") +
                                ` · policy=${ev.policy}`,
                            "err"
                        );
                    } else if (ev.type === "organic_soft_sell") {
                        pushLog(`📉 ${ev.msg || "Soft-selling into foreign buy…"}`, "info");
                    } else if (ev.type === "organic_sold") {
                        pushLog(
                            `💸 soft-sold ${ev.name || ev.wallet} · ${ev.percent}% · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "organic_soft_sell_done") {
                        pushLog(`🛡️ ${ev.msg || "Soft-sell done"}`, "ok");
                    } else if (ev.type === "organic_wait_quiet") {
                        pushLog(`⏸️ ${ev.msg || "Waiting for quiet tape…"}`, "info");
                    } else if (ev.type === "organic_resume") {
                        pushLog(`▶️ ${ev.msg || "Resuming buys"}`, "ok");
                    } else if (ev.type === "guard_action") {
                        pushLog(`🛡️ ${ev.msg || ev.action}`, "info");
                    } else if (ev.type === "aborted") {
                        pushLog(ev.msg || "Buy aborted", "info");
                    }
                },
            });
        job.result = results;
        const okN = results.filter((r) => r.hash).length;
        const failN = results.filter((r) => r.error).length;
        const skipped = results.filter((r) => r.skipped);
        const clampedN = results.filter((r) => r.clampedFrom != null).length;
        const pausedN = skipped.filter((r) =>
            String(r.reason || "").includes("paused")
        ).length;
        // Remember failed addresses for one-click retry
        store.lastBuyFailures = results
            .filter((r) => r.error)
            .map((r) => ({
                address: r.wallet,
                name: r.name,
                error: r.error,
            }));
        saveStore(store);
        pushLog(
            `Done · ${okN} submitted · ${failN} failed · ${skipped.length} skipped` +
                (clampedN ? ` · ${clampedN} gas-clamped` : "") +
                (pausedN ? ` (${pausedN} paused after foreign buy)` : "") +
                (failN
                    ? ` — click Retry failed buys to try the ${failN} again`
                    : ""),
            okN ? "ok" : "err"
        );
    } catch (e) {
        pushLog(`Buys failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        job.abort = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});


// --- Stealth-bundler inspired: split modes, funding preview, recall ---

app.post("/api/allocate", (req, res) => {
    try {
        const { totalEth, mode, variancePct, baseDelaySec } = req.body || {};
        const list = buyersOnly();
        if (!list.length) return res.status(400).json({ error: "No buyer wallets" });
        const amounts = chain.allocateSplits(
            totalEth,
            list.length,
            mode || "ramp",
            variancePct ?? 15
        );
        const delayBase = Number(baseDelaySec ?? 15);
        list.forEach((w, i) => {
            w.buyAmountEth = amounts[i];
            w.delaySec = i === 0 ? 0 : delayBase * i;
        });
        saveStore(store);
        res.json({
            ok: true,
            mode: mode || "ramp",
            amounts,
            wallets: publicWallets(),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/distributors/create", (req, res) => {
    const count = Math.min(10, Math.max(1, Number(req.body?.count || 2)));
    const created = [];
    for (let i = 0; i < count; i++) {
        const w = chain.generateWallet();
        const entry = {
            name: `Distributor ${distributors().length + 1}`,
            address: w.address,
            private_key: w.privateKey,
            role: "distributor",
            buyAmountEth: null,
            delaySec: 0,
            parentIndex: null,
        };
        store.wallets.push(entry);
        created.push({ name: entry.name, address: entry.address, privateKey: entry.private_key });
    }
    const dists = distributors();
    const buys = buyersOnly();
    buys.forEach((b, i) => {
        const di = store.wallets.indexOf(dists[i % dists.length]);
        b.parentIndex = di;
    });
    saveStore(store);
    res.json({ ok: true, created, wallets: publicWallets() });
});

app.post("/api/fund/preview", async (req, res) => {
    const f = funder();
    if (!f) return res.status(400).json({ error: "Add a funder first" });
    const hops = Math.min(3, Math.max(1, Number(req.body?.hops || 2)));
    const useDistributors = !!req.body?.useDistributors && distributors().length > 0;
    const skipFunded = req.body?.skipFunded !== false; // default: skip already-funded buyers

    const jobs = [];
    if (useDistributors) {
        const dists = distributors();
        dists.forEach((d) => {
            const di = store.wallets.indexOf(d);
            const kids = buyersOnly().filter(
                (b) => b.parentIndex === di && Number(b.buyAmountEth) > 0
            );
            const total = kids.reduce((s, b) => s + Number(b.buyAmountEth), 0);
            if (total <= 0) return;
            const buffer = hops * 0.0005 * Math.max(1, kids.length);
            const gasPad = chain.BUYER_GAS_BUFFER_ETH * Math.max(1, kids.length);
            jobs.push({
                phase: 1,
                from: "funder",
                fromAddress: f.address,
                to: d.name,
                toAddress: d.address,
                toRole: "distributor",
                amountEth: Math.round((total + buffer + gasPad) * 1e6) / 1e6,
                hops,
                status: "pending",
            });
            kids.forEach((b) => {
                jobs.push({
                    phase: 2,
                    from: d.name,
                    fromAddress: d.address,
                    to: b.name,
                    toAddress: b.address,
                    toRole: "buyer",
                    amountEth:
                        Math.round(
                            (Number(b.buyAmountEth) + chain.BUYER_GAS_BUFFER_ETH) *
                                1e6
                        ) / 1e6,
                    hops,
                    status: "pending",
                });
            });
        });
    } else {
        const buyers = buyersOnly().filter((b) => Number(b.buyAmountEth) > 0);
        for (const b of buyers) {
            const amountEth =
                Math.round(
                    (Number(b.buyAmountEth) + chain.BUYER_GAS_BUFFER_ETH) * 1e6
                ) / 1e6;
            let alreadyFunded = false;
            let balEth = null;
            if (skipFunded) {
                try {
                    balEth = Number(await chain.getWalletBalance(b.address));
                    // Treat as funded if they already hold most of buy+gas (dust ok)
                    alreadyFunded = balEth >= amountEth * 0.85;
                } catch (_) {}
            }
            if (alreadyFunded) continue;
            jobs.push({
                phase: 1,
                from: "funder",
                fromAddress: f.address,
                to: b.name,
                toAddress: b.address,
                toRole: "buyer",
                amountEth,
                buyAmountEth: Number(b.buyAmountEth),
                gasBufferEth: chain.BUYER_GAS_BUFFER_ETH,
                hops,
                status: "pending",
                balEth,
            });
        }
    }

    if (!jobs.length) {
        return res.status(400).json({
            error: skipFunded
                ? "Nothing left to fund — all buyers with buy amounts already look funded"
                : "No buyer amounts set",
        });
    }

    const totalEth = jobs
        .filter((j) => j.phase === 1)
        .reduce((s, j) => s + j.amountEth, 0);
    fundingPreview = {
        hops,
        useDistributors,
        skipFunded,
        jobs,
        summary: {
            total: jobs.length,
            phase1: jobs.filter((j) => j.phase === 1).length,
            phase2: jobs.filter((j) => j.phase === 2).length,
            totalEth: Math.round(totalEth * 1e6) / 1e6,
            pending: jobs.length,
            complete: 0,
            failed: 0,
        },
    };
    res.json(fundingPreview);
});

app.post("/api/fund/pause", (req, res) => {
    if (!job.running || job.type !== "fund") {
        return res.status(400).json({ error: "No funding job running" });
    }
    job.pause = true;
    pushLog(
        "⏸ Pause requested — finishing current wallet, then holding. Change hops and click Resume when ready.",
        "info"
    );
    res.json({ ok: true, job: publicJob() });
});

app.post("/api/fund/resume", (req, res) => {
    if (!job.running || job.type !== "fund") {
        return res.status(400).json({ error: "No funding job to resume" });
    }
    const hops = Number(req.body?.hops);
    if (Number.isFinite(hops) && hops >= 1 && hops <= 3 && fundingPreview) {
        fundingPreview.hops = Math.floor(hops);
        pushLog(`Resuming with ${fundingPreview.hops} hop(s)`, "info");
    }
    job.pause = false;
    job.paused = false;
    pushLog("▶ Funding resumed", "info");
    broadcast({ type: "funding_preview", fundingPreview, job: publicJob() });
    res.json({ ok: true, job: publicJob(), hops: fundingPreview?.hops });
});

app.post("/api/fund/cancel", (req, res) => {
    if (!job.running || job.type !== "fund") {
        return res.status(400).json({ error: "No funding job running" });
    }
    job.abort = true;
    job.pause = false;
    job.paused = false;
    pushLog(
        "⛔ Cancel requested — finishing current wallet, then stopping. Use Continue funding later for the rest.",
        "info"
    );
    res.json({ ok: true, job: publicJob() });
});

app.post("/api/fund/execute", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    if (!fundingPreview?.jobs?.length) {
        return res.status(400).json({ error: "Build a funding preview first" });
    }
    const f = funder();
    if (!f) return res.status(400).json({ error: "No funder" });

    // Money Desk: block funding that breaks reserve / kill switch
    try {
        const planned =
            Number(fundingPreview?.summary?.totalEth) ||
            plannedBuyEthFromStore();
        const gate = await assertMoneyGate({
            plannedEth: planned,
            action: "fund",
        });
        if (!gate.ok) {
            return res.status(400).json({
                error: gate.plainEnglish,
                code: gate.status,
                money: {
                    treasury: gate.overview?.treasury,
                    kill: gate.overview?.kill,
                    sizing: gate.overview?.sizing,
                },
            });
        }
        if (
            gate.overview?.sizing &&
            !gate.overview.sizing.ok &&
            !req.body?.confirmOversized
        ) {
            return res.status(400).json({
                error: gate.overview.sizing.plainEnglish,
                code: "sizing_warn",
                needConfirm: true,
                money: { sizing: gate.overview.sizing, treasury: gate.overview.treasury },
            });
        }
    } catch (e) {
        return res.status(500).json({ error: `Money check failed: ${e.message}` });
    }

    const preview = fundingPreview;
    // Allow hops override at start of run
    if (Number.isFinite(Number(req.body?.hops))) {
        preview.hops = Math.min(3, Math.max(1, Math.floor(Number(req.body.hops))));
    }
    let hops = preview.hops || 2;

    // Only run jobs that still need funding (skip already-complete from a prior run)
    const onlyRemaining = req.body?.onlyRemaining !== false;
    if (onlyRemaining) {
        for (const j of preview.jobs) {
            if (j.status === "failed" || j.status === "pending") {
                j.status = "pending";
                delete j.error;
            }
        }
    }

    const remaining = preview.jobs.filter(
        (j) => !onlyRemaining || j.status !== "complete"
    );
    if (!remaining.length) {
        return res.status(400).json({
            error: "All funding jobs already complete — nothing left to run",
        });
    }

    setJob({
        running: true,
        type: "fund",
        logs: [],
        result: null,
        progress: { done: 0, total: remaining.length, label: "funding" },
        abort: false,
        pause: false,
        paused: false,
    });

    // Preflight: buy amounts + gas buffers already in job.amountEth; hops still need reserves
    const hopReserve = Number(chain.HOP_GAS_RESERVE_ETH || 0.0005);
    const phase1Jobs = remaining.filter((j) => j.phase === 1);
    const needEth =
        phase1Jobs.reduce((s, j) => s + Number(j.amountEth || 0), 0) +
        hopReserve * hops * phase1Jobs.length;
    let funderBal = 0;
    try {
        funderBal = Number(await chain.getWalletBalance(f.address));
    } catch (_) {}
    if (funderBal > 0 && needEth > funderBal + 1e-9) {
        const short = (needEth - funderBal).toFixed(4);
        pushLog(
            `⚠️ Funder has ${funderBal.toFixed(4)} ETH but this run needs ~${needEth.toFixed(4)} ETH (buys + gas buffers + ${hops} hop reserves × ${phase1Jobs.length}). Short ~${short} ETH — most/all jobs will fail until you top up or lower Total ETH / hop count.`,
            "err"
        );
    }

    const skippedComplete = preview.jobs.length - remaining.length;
    pushLog(
        `Executing ${remaining.length} funding jobs` +
            (skippedComplete ? ` (skipping ${skippedComplete} already complete)` : "") +
            ` · ${hops} hop(s) (${preview.useDistributors ? "2-phase" : "direct"})…`,
        "info"
    );
    res.json({ ok: true, job: publicJob() });

    async function waitIfPaused() {
        if (!job.pause && !job.paused) return;
        job.paused = true;
        job.pause = true;
        pushLog(
            "⏸ Paused. Change hops if you want, then click Resume funding.",
            "info"
        );
        broadcast({ type: "fund_paused", job: publicJob(), fundingPreview: preview });
        while (job.pause && !job.abort) {
            await new Promise((r) => setTimeout(r, 400));
        }
        job.paused = false;
        hops = preview.hops || hops;
        if (!job.abort) {
            pushLog(`▶ Continuing · ${hops} hop(s)`, "info");
        }
    }

    try {
        let done = 0;
        const phase1 = remaining.filter((j) => j.phase === 1);
        for (const j of phase1) {
            if (job.abort) {
                pushLog("Funding stopped — remaining wallets left for Continue funding", "info");
                break;
            }
            await waitIfPaused();
            if (job.abort) break;

            hops = preview.hops || hops;
            setProgress(done, remaining.length, `phase1 → ${j.to}`);
            pushLog(`P1 ${j.to}: ${j.amountEth} ETH via ${hops} hops`, "info");
            try {
                const results = await chain.disperseWithHops(
                    { private_key: f.private_key },
                    [{ address: j.toAddress, amountEth: j.amountEth, name: j.to }],
                    {
                        hops,
                        shuffle: false,
                        buyerGasBufferEth: 0,
                        onHopCreated: ({ hops: hopKeys, dest: d, name }) => {
                            persistHopKeys(hopKeys, { dest: d, destName: name });
                        },
                        onProgress: (ev) => {
                            if (ev.type === "done") {
                                markHopsDelivered(ev.dest);
                                pushLog(`✅ ${j.to} · ${EXPLORER}/tx/${ev.hash}`, "ok");
                            } else if (ev.type === "hop") {
                                pushLog(`  hop ${ev.step}: ${EXPLORER}/tx/${ev.hash}`, "tx");
                            } else if (ev.type === "error") {
                                pushLog(
                                    `❌ ${j.to}: ${ev.error} — hop keys kept`,
                                    "err"
                                );
                            }
                        },
                    }
                );
                const r = results?.[0];
                if (r?.ok) {
                    j.status = "complete";
                    await refreshAndBroadcastBalances([j.toAddress, f.address]);
                } else {
                    j.status = "failed";
                    j.error = r?.error || "funding failed";
                }
            } catch (e) {
                j.status = "failed";
                j.error = e.shortMessage || e.message;
                pushLog(`❌ ${j.to}: ${j.error}`, "err");
            }
            done++;
            setProgress(done, remaining.length, `phase1 → ${j.to}`);
            preview.summary.complete = preview.jobs.filter((x) => x.status === "complete").length;
            preview.summary.failed = preview.jobs.filter((x) => x.status === "failed").length;
            preview.summary.pending = preview.jobs.filter((x) => x.status === "pending").length;
            broadcast({ type: "funding_preview", fundingPreview: preview, job: publicJob() });
        }

        const phase2 = remaining.filter((j) => j.phase === 2);
        for (const j of phase2) {
            if (job.abort) break;
            await waitIfPaused();
            if (job.abort) break;

            hops = preview.hops || hops;
            setProgress(done, remaining.length, `phase2 → ${j.to}`);
            const dist = store.wallets.find(
                (w) => w.address.toLowerCase() === j.fromAddress.toLowerCase()
            );
            if (!dist) {
                j.status = "failed";
                pushLog(`❌ missing distributor for ${j.to}`, "err");
                done++;
                continue;
            }
            pushLog(`P2 ${j.from} → ${j.to}: ${j.amountEth} ETH`, "info");
            try {
                const results = await chain.disperseWithHops(
                    { private_key: dist.private_key },
                    [{ address: j.toAddress, amountEth: j.amountEth, name: j.to }],
                    {
                        hops: Math.max(1, hops - 1),
                        shuffle: false,
                        buyerGasBufferEth: 0,
                        onHopCreated: ({ hops: hopKeys, dest: d, name }) => {
                            persistHopKeys(hopKeys, { dest: d, destName: name });
                        },
                        onProgress: (ev) => {
                            if (ev.type === "done") {
                                markHopsDelivered(ev.dest);
                                pushLog(`✅ ${j.to} · ${EXPLORER}/tx/${ev.hash}`, "ok");
                            } else if (ev.type === "error") {
                                pushLog(
                                    `❌ ${j.to}: ${ev.error} — hop keys kept`,
                                    "err"
                                );
                            }
                        },
                    }
                );
                const r = results?.[0];
                if (r?.ok) {
                    j.status = "complete";
                    await refreshAndBroadcastBalances([j.toAddress, dist.address, f.address]);
                } else {
                    j.status = "failed";
                    j.error = r?.error || "funding failed";
                }
            } catch (e) {
                j.status = "failed";
                pushLog(`❌ ${j.to}: ${e.shortMessage || e.message}`, "err");
            }
            done++;
            setProgress(done, remaining.length, `phase2 → ${j.to}`);
            preview.summary.complete = preview.jobs.filter((x) => x.status === "complete").length;
            preview.summary.failed = preview.jobs.filter((x) => x.status === "failed").length;
            preview.summary.pending = preview.jobs.filter((x) => x.status === "pending").length;
            broadcast({ type: "funding_preview", fundingPreview: preview, job: publicJob() });
        }

        fundingPreview = preview;
        job.result = preview;
        const okN = preview.summary.complete;
        const failN = preview.summary.failed;
        const pendingN = preview.jobs.filter((x) => x.status === "pending").length;
        pushLog(
            job.abort
                ? `Funding paused/stopped · ${okN} ok · ${failN} failed · ${pendingN} left — use Continue funding`
                : `Funding done · ${okN} ok · ${failN} failed`,
            failN && !okN ? "err" : okN ? "ok" : "err"
        );
        // Final balance sweep for funder + any completed buyers in this run
        const addrs = [
            f.address,
            ...preview.jobs
                .filter((x) => x.status === "complete")
                .map((x) => x.toAddress),
        ];
        await refreshAndBroadcastBalances(addrs.slice(0, 40));
    } catch (e) {
        pushLog(`Funding failed: ${e.shortMessage || e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        job.abort = false;
        job.pause = false;
        job.paused = false;
        broadcast({ type: "job_done", job: publicJob(), fundingPreview });
    }
});

app.post("/api/recall", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    if (!f) return res.status(400).json({ error: "No funder" });

    const roles = req.body?.roles || ["buyer", "distributor"];
    // Sniper is separate — only included when explicitly requested
    const sources = store.wallets.filter((w) =>
        roles.includes(w.role || "buyer")
    );
    if (!sources.length) return res.status(400).json({ error: "Nothing to recall" });

    setJob({
        running: true,
        type: "recall",
        logs: [],
        result: null,
        progress: { done: 0, total: sources.length, label: "recall" },
    });
    let funderBalBefore = "0";
    try {
        funderBalBefore = await chain.getWalletBalance(f.address);
    } catch (_) {}

    pushLog(
        `Recalling ETH (+unwrap WETH) from ${sources.length} wallets → funder ${f.address}`,
        "info"
    );
    pushLog(`Funder balance before: ${funderBalBefore} ETH`, "info");
    pushLog(
        `Check on Robinhood explorer (not ETH mainnet): ${EXPLORER}/address/${f.address}`,
        "info"
    );
    res.json({ ok: true, job: publicJob(), funder: f.address });

    try {
        let done = 0;
        let totalEth = 0;
        let okCount = 0;
        const results = await chain.recallEth(
            sources.map((w) => ({
                address: w.address,
                private_key: w.private_key,
                name: w.name,
            })),
            f.address,
            {
                unwrapWeth: req.body?.unwrapWeth !== false,
                gasReserveEth: Number(req.body?.gasReserveEth ?? 0.0002),
                onProgress: (ev) => {
                    if (ev.type === "unwrapping") {
                        pushLog(
                            `  unwrap ${ev.amount} WETH @ ${ev.wallet}`,
                            "info"
                        );
                    } else if (ev.type === "unwrapped") {
                        pushLog(`  unwrapped · ${EXPLORER}/tx/${ev.hash}`, "tx");
                    } else if (ev.type === "recalling") {
                        pushLog(
                            `← ${ev.name || ev.wallet}: ${ev.amountEth} ETH → ${f.address.slice(0, 10)}…`,
                            "info"
                        );
                    } else if (ev.type === "recalled") {
                        done++;
                        okCount++;
                        totalEth += Number(ev.amountEth || 0);
                        setProgress(done, sources.length, "recall");
                        pushLog(
                            `✅ confirmed ${ev.amountEth} ETH · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "skip") {
                        done++;
                        setProgress(done, sources.length, "recall");
                        pushLog(`skip ${ev.wallet} (dust)`, "info");
                    } else if (ev.type === "error" || ev.type === "unwrap_error") {
                        done++;
                        setProgress(done, sources.length, "recall");
                        pushLog(`❌ ${ev.wallet}: ${ev.error}`, "err");
                    }
                },
            }
        );

        let funderBalAfter = funderBalBefore;
        try {
            funderBalAfter = await chain.getWalletBalance(f.address);
        } catch (_) {}
        const gained =
            Math.round(
                (Number(funderBalAfter) - Number(funderBalBefore)) * 1e6
            ) / 1e6;

        job.result = {
            results,
            totalEth,
            okCount,
            funder: f.address,
            funderBalBefore,
            funderBalAfter,
            gained,
        };
        pushLog(
            `Recall done · ${okCount} confirmed · claimed ~${totalEth.toFixed(5)} ETH`,
            okCount ? "ok" : "err"
        );
        pushLog(
            `Funder balance after: ${funderBalAfter} ETH (${gained >= 0 ? "+" : ""}${gained} ETH)`,
            gained > 0.0001 ? "ok" : "err"
        );
        if (okCount > 0 && gained < 0.0001) {
            pushLog(
                `⚠️ Confirmed txs but funder balance barely moved — open ${EXPLORER}/address/${f.address}`,
                "err"
            );
        }
    } catch (e) {
        pushLog(`Recall failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

/**
 * Recover ETH stuck in hop wallets (mid-funding failures).
 * Sweeps hopVault keys with balance back to the funder.
 */
app.post("/api/recover/hops", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    if (!f) return res.status(400).json({ error: "No funder" });

    const vault = store.hopVault || [];
    const onlyPending = req.body?.onlyPending !== false;
    const candidates = vault.filter((h) => {
        if (!h?.privateKey || !h?.address) return false;
        if (h.recovered) return false;
        if (onlyPending && h.status === "delivered") return false;
        return true;
    });
    if (!candidates.length) {
        return res.status(400).json({
            error: "No recoverable hop wallets (vault empty or all delivered)",
        });
    }

    setJob({
        running: true,
        type: "recall",
        logs: [],
        result: null,
        progress: { done: 0, total: candidates.length, label: "recover hops" },
    });
    pushLog(
        `Recovering ${candidates.length} hop wallet(s) → funder ${f.address}`,
        "info"
    );
    res.json({ ok: true, job: publicJob(), count: candidates.length });

    try {
        let done = 0;
        const results = await chain.recallEth(
            candidates.map((h) => ({
                address: h.address,
                private_key: h.privateKey,
                name: `hop${h.step}→${h.destName || h.dest || ""}`,
            })),
            f.address,
            {
                unwrapWeth: true,
                gasReserveEth: Number(req.body?.gasReserveEth ?? 0.00015),
                onProgress: (ev) => {
                    if (ev.type === "recalling") {
                        pushLog(
                            `← hop ${ev.name || ev.wallet}: ${ev.amountEth} ETH`,
                            "info"
                        );
                    } else if (ev.type === "recalled") {
                        done++;
                        setProgress(done, candidates.length, "recover");
                        const hop = store.hopVault.find(
                            (x) =>
                                String(x.address).toLowerCase() ===
                                String(ev.wallet).toLowerCase()
                        );
                        if (hop) {
                            hop.recovered = true;
                            hop.recoveredAt = new Date().toISOString();
                            hop.status = "recovered";
                            hop.recoverTx = ev.hash;
                            saveStore(store);
                        }
                        pushLog(
                            `✅ hop recovered · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "skip") {
                        done++;
                        setProgress(done, candidates.length, "recover");
                        const hop = store.hopVault.find(
                            (x) =>
                                String(x.address).toLowerCase() ===
                                String(ev.wallet).toLowerCase()
                        );
                        if (hop && ev.reason === "dust") {
                            hop.recovered = true;
                            hop.recoveredAt = new Date().toISOString();
                            hop.status = "empty";
                            saveStore(store);
                        }
                        pushLog(`skip ${ev.wallet}: ${ev.reason}`, "info");
                    } else if (ev.type === "error") {
                        done++;
                        setProgress(done, candidates.length, "recover");
                        pushLog(`❌ ${ev.wallet}: ${ev.error}`, "err");
                    }
                },
            }
        );
        job.result = results;
        const okN = results.filter((r) => r.hash).length;
        pushLog(`Hop recovery done · ${okN} swept`, "ok");
    } catch (e) {
        pushLog(`Hop recovery failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

app.get("/api/recover/hops", async (_req, res) => {
    const vault = publicHopVault();
    const pending = vault.filter((h) => !h.recovered && h.status !== "delivered");
    const withBal = [];
    for (const h of pending.slice(0, 50)) {
        let balance = null;
        try {
            balance = await chain.getWalletBalance(h.address);
        } catch (_) {}
        withBal.push({ ...h, balance });
    }
    res.json({
        total: vault.length,
        pending: pending.length,
        hops: withBal,
        funder: funder()?.address || null,
    });
});

app.post("/api/season", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    if (!f) return res.status(400).json({ error: "Import a funder first — seasoning needs ETH" });

    const {
        intensity = "medium",
        budgetEth = 0.008,
        recallLeftover = true,
        onlyUnseasoned = true,
        indices = null,
    } = req.body || {};

    let targets = buyersOnly();
    if (Array.isArray(indices) && indices.length) {
        targets = indices
            .map((i) => store.wallets[Number(i)])
            .filter((w) => w && w.role === "buyer");
    } else if (onlyUnseasoned) {
        targets = targets.filter((w) => !w.seasoned);
    }

    if (!targets.length) {
        return res.status(400).json({
            error: onlyUnseasoned
                ? "No unseasoned buyers — create buyers first, or set onlyUnseasoned=false"
                : "No buyer wallets to season",
        });
    }

    setJob({
        running: true,
        type: "season",
        logs: [],
        result: null,
        progress: { done: 0, total: targets.length, label: "seasoning" },
    });
    pushLog(
        `Seasoning ${targets.length} wallet(s) · ${intensity} · ~${budgetEth} ETH each…`,
        "info"
    );
    res.json({ ok: true, job: publicJob(), count: targets.length });

    try {
        let done = 0;
        const results = await chain.seasonWallets(
            { private_key: f.private_key, address: f.address },
            targets.map((w) => ({
                address: w.address,
                private_key: w.private_key,
                name: w.name,
            })),
            {
                budgetEth: Number(budgetEth),
                intensity,
                recallLeftover: !!recallLeftover,
                onProgress: (ev) => {
                    if (ev.type === "wallet_start") {
                        pushLog(
                            `🧂 ${ev.name || ev.address} (${ev.index + 1}/${ev.total})…`,
                            "info"
                        );
                        setProgress(ev.index, targets.length, ev.name || "seasoning");
                    } else if (ev.type === "funding") {
                        pushLog(`  funding ${ev.amount} ETH → ${ev.address}`, "info");
                    } else if (ev.type === "funded") {
                        pushLog(`  funded · ${EXPLORER}/tx/${ev.hash}`, "tx");
                    } else if (ev.type === "plan") {
                        pushLog(`  plan: ${ev.plan.join(", ")}`, "info");
                    } else if (ev.type === "done") {
                        pushLog(
                            `  ✅ ${ev.activity} · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "skip") {
                        pushLog(`  skip ${ev.activity}: ${ev.reason}`, "info");
                    } else if (ev.type === "error") {
                        pushLog(`  ❌ ${ev.activity}: ${ev.error}`, "err");
                    } else if (ev.type === "recalled") {
                        pushLog(`  leftover → funder · ${EXPLORER}/tx/${ev.hash}`, "tx");
                    } else if (ev.type === "wallet_done") {
                        done++;
                        setProgress(done, targets.length, "seasoned");
                        pushLog(
                            `✅ seasoned ${ev.address} · ${ev.txCount} txs`,
                            "ok"
                        );
                    } else if (ev.type === "wallet_error") {
                        done++;
                        setProgress(done, targets.length, "error");
                        pushLog(`❌ ${ev.address}: ${ev.error}`, "err");
                    }
                },
            }
        );

        for (const r of results) {
            const w = store.wallets.find(
                (x) => x.address.toLowerCase() === r.address.toLowerCase()
            );
            if (w && r.ok) {
                w.seasoned = true;
                w.seasonTxCount = r.txCount;
                w.seasonedAt = new Date().toISOString();
            }
        }
        saveStore(store);
        job.result = results;
        pushLog(
            `Seasoning complete · ${results.filter((r) => r.ok).length}/${results.length} ok`,
            "ok"
        );
        broadcast({ type: "wallets", wallets: publicWallets() });
    } catch (e) {
        pushLog(`Seasoning failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});


app.post("/api/sell/history/clear", (req, res) => {
    const token = req.body?.token || store.lastToken;
    if (req.body?.all) {
        store.sellHistory = [];
    } else if (token) {
        const t = String(token).toLowerCase();
        store.sellHistory = (store.sellHistory || []).filter(
            (e) => String(e.token || "").toLowerCase() !== t
        );
    } else {
        store.sellHistory = [];
    }
    saveStore(store);
    res.json({ ok: true, summary: sellHistorySummary(store.lastToken || "") });
});

app.post("/api/sell/preview", async (req, res) => {
    try {
        const token = req.body?.token || store.lastToken;
        if (!chain.isEvmAddress(token || "")) {
            return res.status(400).json({ error: "Invalid token — set it in Step 2" });
        }
        const list = sellPlanWallets();
        if (!list.length) {
            return res.status(400).json({ error: "No buyer wallets" });
        }
        const preview = await chain.estimatePositions(
            list.map((w) => ({
                address: w.address,
                name: w.name,
                buyAmountEth: w.buyAmountEth,
            })),
            token,
            { slippageBps: Number(req.body?.slippageBps) || undefined }
        );
        store.lastToken = token;
        store.lastSellPreview = preview;
        saveStore(store);
        res.json(preview);
    } catch (e) {
        res.status(500).json({ error: e.shortMessage || e.message });
    }
});

app.post("/api/sell/plan", async (req, res) => { /* sellPlanWallets */
    try {
        const token = req.body?.token || store.lastToken;
        if (!chain.isEvmAddress(token || "")) {
            return res.status(400).json({ error: "Invalid token — set it in Step 2" });
        }
        const list = sellPlanWallets();
        if (!list.length) {
            return res.status(400).json({ error: "No buyer wallets" });
        }
        const plan = await chain.buildSellPlan(
            list.map((w) => ({
                address: w.address,
                name: w.name,
                buyAmountEth: w.buyAmountEth,
                role: w.role,
            })),
            token,
            {
                strategy: req.body?.strategy || "auto",
                slippageBps: Number(req.body?.slippageBps) || undefined,
                targetMcapUsd: Number(req.body?.targetMcapUsd) || 1_000_000,
            }
        );
        store.lastToken = token;
        // Persist so page refresh keeps the sell plan until Force restart
        store.lastSellPlan = {
            ...plan,
            savedAt: new Date().toISOString(),
            token: String(token).toLowerCase(),
            strategyUsed: req.body?.strategy || plan.strategy || "auto",
            targetMcapUsd: Number(req.body?.targetMcapUsd) || 1_000_000,
        };
        saveStore(store);
        res.json(store.lastSellPlan);
    } catch (e) {
        res.status(500).json({ error: e.shortMessage || e.message });
    }
});

/** Live tape + OHLC for chart / MM monitor (works while buys are running). */
app.get("/api/tape/:address", async (req, res) => {
    try {
        const token = req.params.address;
        if (!chain.isEvmAddress(token || "")) {
            return res.status(400).json({ error: "Invalid token" });
        }
        const tape = await chain.analyzeMarketTape(token);
        res.json({
            ...tape,
            noxaUrl: `https://fun.noxa.fi/robinhood/${String(token).toLowerCase()}`,
            chartEmbedUrl: `https://fun.noxa.fi/robinhood/${String(token).toLowerCase()}`,
        });
    } catch (e) {
        res.status(500).json({ error: e.shortMessage || e.message });
    }
});

app.post("/api/sell", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const token = req.body?.token || store.lastToken;
    if (!chain.isEvmAddress(token || "")) {
        return res.status(400).json({ error: "Invalid token" });
    }

    const mode = req.body?.mode === "parallel" ? "parallel" : "sequential";
    const percent = Math.min(100, Math.max(1, Number(req.body?.percent ?? 100)));
    // Keep sequential gaps short — swaps already wait on chain; old 1500ms felt stuck
    const delayMs = Number(req.body?.delayMs ?? (mode === "sequential" ? 200 : 0));
    const indices = Array.isArray(req.body?.indices) ? req.body.indices : null;
    const walletOrder = Array.isArray(req.body?.walletOrder)
        ? req.body.walletOrder
        : null;
    const usePlan = Boolean(req.body?.usePlan);
    const fast = req.body?.fast !== false;
    const waitForReceipt = req.body?.waitForReceipt === true;
    const priorityMultiplier = Number(req.body?.priorityMultiplier ?? (fast ? 1.75 : 1.5));
    const concurrency = Number(req.body?.concurrency) || (fast ? 8 : 4);

    let list = buyersOnly();
    if (indices && indices.length) {
        list = indices
            .map((i) => store.wallets[Number(i)])
            .filter((w) => w && (w.role === "buyer" || !w.role));
    }
    if (!list.length) return res.status(400).json({ error: "No buyer wallets" });

    let order = walletOrder;
    let sellMode = mode;
    let sellDelay = delayMs;
    let sellPercent = percent;
    const planLogs = [];

    if (usePlan && !order) {
        try {
            const plan = await chain.buildSellPlan(
                list.map((w) => ({
                    address: w.address,
                    name: w.name,
                    buyAmountEth: w.buyAmountEth,
                    role: w.role,
                })),
                token,
                { strategy: req.body?.strategy || "auto" }
            );
            order = plan.executeHint?.order || plan.plan?.map((p) => p.address);
            if (req.body?.mode == null) {
                sellMode = plan.executeHint?.mode || "sequential";
            }
            if (req.body?.delayMs == null) {
                sellDelay = plan.executeHint?.delayMs ?? sellDelay;
            }
            planLogs.push(
                `Sell plan · ${plan.strategy} · tape ${plan.tape?.regime} (score ${plan.tape?.score}) · urgency ${plan.tape?.urgency}`
            );
            if (plan.tape?.action || plan.strategyLabel) {
                planLogs.push(plan.tape?.action || plan.strategyLabel);
            }
        } catch (e) {
            planLogs.push(`Sell plan failed, selling default order: ${e.message}`);
        }
    }

    const launchpad = resolveLaunchpad(req.body?.launchpad);
    store.launchpad = launchpad;
    store.lastToken = token;
    saveStore(store);

    setJob({
        running: true,
        type: "sell",
        logs: [],
        result: null,
        progress: { done: 0, total: list.length, label: "selling" },
    });
    for (const msg of planLogs) {
        pushLog(msg, msg.includes("failed") ? "err" : "info");
    }
    pushLog(`Launchpad: ${launchpadLabel(launchpad)}`, "info");
    pushLog(
        `Sell ${sellPercent}% from ${list.length} wallet(s) · ${sellMode}${sellMode === "parallel" ? " (near-simultaneous)" : ""}${order ? " · plan order" : ""}`,
        "info"
    );
    res.json({ ok: true, job: publicJob() });

    try {
        let done = 0;
        const sellerPayload = list.map((w) => ({
                private_key: w.private_key,
                address: w.address,
                name: w.name,
                buyAmountEth: w.buyAmountEth,
            }));
        const results =
            launchpad === "apestore"
                ? await apestore.multiSell(sellerPayload, token, {
                      mode: sellMode,
                      percent: sellPercent,
                      delayMs: sellDelay,
                      walletOrder: order || undefined,
                      waitForReceipt: true,
                      priorityMultiplier,
                      concurrency: Math.min(4, Number(concurrency) || 3),
                      onProgress: (ev) => {
                          if (ev.type === "selling") {
                              pushLog(
                                  `💸 ${ev.name || ev.wallet} selling ${ev.amount} tokens (ApeStore)`,
                                  "info"
                              );
                          } else if (ev.type === "sold") {
                              done++;
                              setProgress(done, list.length, "sold");
                              pushLog(
                                  `✅ sold · ${EXPLORER}/tx/${ev.hash}`,
                                  "ok"
                              );
                          } else if (ev.type === "waiting") {
                              pushLog(`⏳ ${ev.delayMs}ms…`, "info");
                          } else if (ev.type === "error") {
                              done++;
                              setProgress(done, list.length, "error");
                              pushLog(
                                  `❌ ${ev.wallet}: ${ev.error}`,
                                  "err"
                              );
                          }
                      },
                  })
                : await chain.multiSell(sellerPayload, token, {
                mode: sellMode,
                percent: sellPercent,
                delayMs: sellDelay,
                walletOrder: order || undefined,
                fast,
                waitForReceipt,
                priorityMultiplier,
                concurrency,
                onProgress: (ev) => {
                    if (ev.type === "mode") {
                        pushLog(`Mode: ${ev.mode} · ${ev.count} wallets`, "info");
                    } else if (ev.type === "selling") {
                        pushLog(
                            `💸 ${ev.name || ev.wallet} selling ${ev.amount} tokens`,
                            "info"
                        );
                    } else if (ev.type === "sold") {
                        done++;
                        setProgress(done, list.length, "sold");
                        pushLog(
                            `${ev.pending ? "📡 broadcast" : "✅ sold"} · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "confirmed") {
                        pushLog(`✅ confirmed · ${EXPLORER}/tx/${ev.hash}`, "ok");
                    } else if (ev.type === "skip") {
                        done++;
                        setProgress(done, list.length, "skip");
                        pushLog(`skip ${ev.wallet}: ${ev.reason}`, "info");
                    } else if (ev.type === "waiting") {
                        pushLog(`⏳ ${ev.delayMs}ms…`, "info");
                    } else if (ev.type === "error") {
                        done++;
                        setProgress(done, list.length, "error");
                        pushLog(`❌ ${ev.wallet}: ${ev.error}`, "err");
                    }
                },
            });
        job.result = results;
        const okN = results.filter((r) => r.hash).length;
        pushLog(`Sell done · ${okN}/${list.length} submitted`, "ok");
        try {
            const hist = await recordSellHistory(results, {
                token,
                percent: sellPercent,
                source: usePlan ? "sell_plan" : "sell_all",
            });
            if (hist?.added?.length) {
                const s = hist.summary;
                pushLog(
                    `📒 Banked ${hist.added.length} sell(s) · session profit ${s.profitUsdLabel} (${s.profitEthLabel}) · taken out ${s.ethOutUsdLabel}`,
                    "ok"
                );
                broadcast({ type: "sell_history", summary: s, entries: hist.added });
            }
        } catch (he) {
            pushLog(`Sell history note failed: ${he.message}`, "info");
        }
    } catch (e) {
        pushLog(`Sell failed: ${e.shortMessage || e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

app.post("/api/sell/one", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running — wait for it to finish" });
    const token = req.body?.token || store.lastToken;
    const index = Number(req.body?.index);
    const w = store.wallets[index];
    if (!w) return res.status(404).json({ error: "Wallet not found" });
    const role = String(w.role || "buyer").toLowerCase();
    if (role !== "buyer" || /^(sniper|tx\s*bot|funder)$/i.test(String(w.name || "").trim())) {
        return res.status(400).json({
            error: `Cannot sell from ${w.name || role} — sell plan is for bundler buyers only`,
        });
    }
    if (!(Number(w.buyAmountEth) > 0) && !req.body?.force) {
        return res.status(400).json({
            error: "Wallet has no buy cost basis — not a bundler buyer position",
        });
    }
    if (!chain.isEvmAddress(token || "")) {
        return res.status(400).json({ error: "Invalid token" });
    }
    const percent = Math.min(
        100,
        Math.max(1, Number(req.body?.percent ?? 100))
    );

    setJob({
        running: true,
        type: "sell",
        logs: [],
        result: null,
        progress: { done: 0, total: 1, label: `sell ${percent}%` },
    });
    pushLog(
        `Manual sell ${percent}% · ${w.name || w.address?.slice(0, 10)}… · cost basis ${w.buyAmountEth ?? "?"} ETH`,
        "info"
    );
    res.json({ ok: true, job: publicJob(), percent });

    const launchpad = resolveLaunchpad(req.body?.launchpad);
    store.launchpad = launchpad;
    store.lastToken = token;
    saveStore(store);
    pushLog(`Launchpad: ${launchpadLabel(launchpad)}`, "info");

    try {
        const onePayload = [
                {
                    private_key: w.private_key,
                    address: w.address,
                    name: w.name,
                    buyAmountEth: w.buyAmountEth,
                },
            ];
        const oneOpts = {
                percent,
                fast: true,
                waitForReceipt: launchpad === "apestore",
                priorityMultiplier: Number(req.body?.priorityMultiplier ?? 2),
                onProgress: (ev) => {
                    if (ev.type === "sold") {
                        setProgress(1, 1, "sold");
                        pushLog(
                            `${ev.pending ? "📡 broadcast" : "✅ sold"} ${percent}% · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "confirmed") {
                        pushLog(`✅ confirmed · ${EXPLORER}/tx/${ev.hash}`, "ok");
                    } else if (ev.type === "error") {
                        pushLog(`❌ ${ev.error}`, "err");
                    } else if (ev.type === "skip") {
                        pushLog(`skip: ${ev.reason}`, "info");
                    }
                },
            };
        const results =
            launchpad === "apestore"
                ? await apestore.multiSell(onePayload, token, oneOpts)
                : await chain.multiSell(onePayload, token, oneOpts);
        job.result = results;
        pushLog("Manual sell done", "ok");
        try {
            const hist = await recordSellHistory(results, {
                token,
                percent,
                source: "sell_one",
                name: w.name,
                costEth: w.buyAmountEth,
            });
            // Shrink remaining cost basis so leftover bag P&L is honest
            for (const r of results || []) {
                if (r && r.hash && !r.error && !r.skipped) {
                    applySoldCostBasis(w, percent, r.quotedEth ?? r.ethOut);
                }
            }
            saveStore(store);
            if (hist?.added?.length) {
                const s = hist.summary;
                const e0 = hist.added[0];
                const rem = Number(w.buyAmountEth || 0);
                pushLog(
                    `📒 ${e0.name}: got $${Math.round(e0.ethOutUsd||0)} · trade P&L ${e0.profitUsd>=0?"+":""}$${Math.round(e0.profitUsd||0)} · remaining cost ${rem.toFixed(5)} ETH · banked ${s.profitUsdLabel}`,
                    "ok"
                );
                broadcast({ type: "sell_history", summary: s, entries: hist.added });
            }
        } catch (he) {
            pushLog(`Sell history note failed: ${he.message}`, "info");
        }
    } catch (e) {
        pushLog(`Sell failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

// --- Pairs feed + sniper ---
let pairsCache = { tokens: [], updatedAt: 0, seen: new Set() };
let snipeBusy = false;
let lastAutoSnipeAt = 0;
const exitingTokens = new Set(); // per-token exit lock — rug-guard must not freeze other bags
const openPositions = new Map(); // token -> { walletIndex, costEth, entryMcap, takeProfitX, stopLossPct, snipeIds }
const creatorIndex = new Map(); // creator -> { launches, bestAth, avgAth, updatedAt }

/** Rebuild in-memory exit monitor from unsold snipes (survives restarts). */
function syncOpenPositionsFromStore() {
    const s = sniper();
    if (!s) {
        openPositions.clear();
        return { count: 0 };
    }
    const cfg = store.snipeConfig || {};
    const sniperAddr = String(s.address).toLowerCase();
    const byToken = new Map();
    for (const x of store.snipes || []) {
        if (!x.ok || x.sold || !x.token) continue;
        if (x.filled === false) continue;
        if (String(x.wallet || "").toLowerCase() !== sniperAddr) continue;
        const key = String(x.token).toLowerCase();
        const prev = byToken.get(key) || {
            id: x.id,
            snipeIds: [],
            walletIndex: store.wallets.indexOf(s),
            costEth: 0,
            entryMcap: null,
            takeProfitX: Number(cfg.takeProfitX || 2),
            stopLossPct: Number(cfg.stopLossPct || 40),
            token: x.token,
            symbol: x.symbol || "?",
            creator: x.creator || null,
            creatorBalRaw: null,
            openedAt: x.at || null,
        };
        prev.snipeIds.push(x.id);
        prev.costEth += Number(x.amountEth || 0);
        prev.symbol = x.symbol || prev.symbol;
        if (x.creator && !prev.creator) prev.creator = x.creator;
        if (x.at && !prev.openedAt) prev.openedAt = x.at;
        if (x.entryMcap && (!prev.entryMcap || Number(x.entryMcap) < prev.entryMcap)) {
            prev.entryMcap = Number(x.entryMcap);
        }
        if (x.takeProfitX) prev.takeProfitX = Number(x.takeProfitX);
        if (x.stopLossPct) prev.stopLossPct = Number(x.stopLossPct);
        byToken.set(key, prev);
    }
    // Keep live map in sync (drop closed, add/update open)
    for (const key of [...openPositions.keys()]) {
        if (!byToken.has(key)) openPositions.delete(key);
    }
    for (const [key, pos] of byToken) {
        const existing = openPositions.get(key);
        // Recover creator from pairs cache if snipe record lacked it
        let creator = pos.creator || existing?.creator || null;
        if (!creator) {
            const t = (pairsCache.tokens || []).find(
                (p) => String(p.address || "").toLowerCase() === key
            );
            if (t?.creator) creator = t.creator;
        }
        openPositions.set(key, {
            ...pos,
            creator: creator ? String(creator).toLowerCase() : null,
            creatorBalRaw: existing?.creatorBalRaw ?? null,
            openedAt: pos.openedAt || existing?.openedAt || null,
            entryMcap: pos.entryMcap || existing?.entryMcap || chain.NOXA_STARTING_MC_ETH,
            takeProfitX: Number(cfg.takeProfitX || pos.takeProfitX || 1.6),
            stopLossPct: Number(cfg.stopLossPct || pos.stopLossPct || 35),
            peakMcap: existing?.peakMcap || pos.entryMcap || chain.NOXA_STARTING_MC_ETH,
            partialTaken: !!existing?.partialTaken,
            remainingPct: existing?.remainingPct ?? 100,
            tpRungsTaken: Array.isArray(existing?.tpRungsTaken)
                ? existing.tpRungsTaken
                : [],
        });
    }
    return { count: openPositions.size };
}

async function exitOpenPosition(pos, reason, sellPercent = 100) {
    const tokenKey = String(pos.token || "").toLowerCase();
    if (tokenKey && exitingTokens.has(tokenKey)) {
        return { ok: false, error: "already exiting" };
    }
    const w = store.wallets[pos.walletIndex] || sniper();
    if (!w) {
        openPositions.delete(tokenKey);
        return { ok: false, error: "no sniper wallet" };
    }
    const pct = Math.min(100, Math.max(1, Number(sellPercent) || 100));
    const partial = pct < 100;
    pushLog(
        `🚪 exit $${pos.symbol}: ${reason}${partial ? ` · sell ${pct}%` : ""}`,
        "info"
    );
    if (tokenKey) exitingTokens.add(tokenKey);
    snipeBusy = true;
    try {
        let balRaw = 0n;
        try {
            const tb = await chain.getTokenBalanceRaw(w.address, pos.token);
            balRaw = tb.balance || 0n;
        } catch (_) {}
        if (!(balRaw > 0n)) {
            const key = String(pos.token).toLowerCase();
            // Never filled (reverted buy) vs dumped already — check buy receipt + fill flag
            let neverFilled = false;
            for (const rec of store.snipes || []) {
                if (!rec.ok || rec.sold) continue;
                if (String(rec.token || "").toLowerCase() !== key) continue;
                if (rec.filled === false) {
                    neverFilled = true;
                    break;
                }
                if (rec.hash) {
                    try {
                        const receipt = await chain.provider.getTransactionReceipt(
                            rec.hash
                        );
                        if (receipt && receipt.status === 0) neverFilled = true;
                        // Confirmed buy but 0 tokens now = already dumped / transferred out
                        if (receipt && receipt.status === 1 && rec.filled !== false) {
                            neverFilled = false;
                        }
                    } catch (_) {}
                }
            }
            for (const rec of store.snipes || []) {
                if (!rec.ok || rec.sold) continue;
                if (String(rec.token || "").toLowerCase() !== key) continue;
                if (neverFilled || rec.filled === false) {
                    // Reverted / never-filled buy — not a real position; don't fake −100% "sold"
                    rec.ok = false;
                    rec.sold = false;
                    rec.filled = false;
                    rec.error = `buy never filled (${String(rec.hash || "").slice(0, 12)}…)`;
                    rec.exitReason = null;
                    rec.ethOut = null;
                    rec.profitEth = null;
                    rec.pnlEth = null;
                    rec.sellHash = null;
                } else {
                    // Had a fill earlier but tokens are gone (sold elsewhere / dust) —
                    // mark closed WITHOUT inventing −100% loss
                    rec.sold = true;
                    rec.exitReason = `${reason} · no tokens left`;
                    if (rec.ethOut == null && rec.profitEth == null) {
                        rec.ethOut = null;
                        rec.profitEth = null;
                        rec.pnlUnknown = true;
                    }
                    rec.sellHash = rec.sellHash || null;
                }
            }
            saveStore(store);
            openPositions.delete(key);
            pushLog(
                neverFilled
                    ? `⚠️ $${pos.symbol}: buy never filled — removed from open`
                    : `⚠️ $${pos.symbol}: no tokens left to sell (P&L unknown — not counting −100%)`,
                "err"
            );
            broadcast({
                type: "snipe_exit",
                token: pos.token,
                reason: neverFilled ? "buy never filled" : reason,
                ethOut: null,
                neverFilled,
            });
            return {
                ok: false,
                error: neverFilled ? "buy never filled" : "no tokens",
                ethOut: null,
            };
        }

        const balBefore = Number(await chain.getWalletBalance(w.address));
        const isDevExit = /dev\s*sell|creator\s*sell|rug/i.test(String(reason || ""));
        const results = await chain.multiSell(
            [{ private_key: w.private_key, address: w.address, name: w.name }],
            pos.token,
            {
                percent: pct,
                fast: true,
                waitForReceipt: false,
                // Race the chart — dump hard on rugs / normal exits still tipped up
                priorityMultiplier: isDevExit ? 3 : 2,
                sellOptions: {
                    slippageBps: isDevExit ? 2500 : 1500,
                    retries: 4,
                },
            }
        );
        const sold = results.find((r) => r.hash);

        if (!sold?.hash) {
            const err =
                results[0]?.error || results[0]?.reason || "sell failed";
            pushLog(`⚠️ sell $${pos.symbol} FAILED (keeping open): ${err}`, "err");
            broadcast({
                type: "snipe_exit_failed",
                token: pos.token,
                reason,
                error: err,
            });
            return { ok: false, error: err, results };
        }

        let ethOut = null;
        try {
            // Fire-and-forget sells need a real receipt before balance delta is meaningful
            if (sold.hash) {
                try {
                    await chain.waitTx({ hash: sold.hash }, 1);
                } catch (_) {}
            }
            await chain.sleep(400);
            const balAfter = Number(await chain.getWalletBalance(w.address));
            ethOut = Math.max(0, balAfter - balBefore);
        } catch (_) {}
        // Prefer measured balance delta; fall back to pre-sell quote
        if (!(ethOut > 0) && sold.quotedEth != null && Number(sold.quotedEth) > 0) {
            ethOut = Number(sold.quotedEth);
            pushLog(
                `ℹ️ $${pos.symbol}: using quote for P&L (${ethOut.toFixed(5)} ETH) — balance delta was 0`,
                "info"
            );
        }
        if (!(ethOut > 0)) ethOut = null;

        const ids = new Set(pos.snipeIds || (pos.id ? [pos.id] : []));
        const key = String(pos.token).toLowerCase();

        if (partial) {
            // Record a partial exit line; keep original snipes open for remainder
            const costShare =
                (Number(pos.costEth || 0) * pct) / 100;
            store.snipes = [
                ...(store.snipes || []),
                {
                    id: `partial_${Date.now()}`,
                    token: pos.token,
                    symbol: pos.symbol,
                    amountEth: costShare,
                    wallet: w.address,
                    walletIndex: pos.walletIndex,
                    hash: null,
                    ok: true,
                    auto: true,
                    at: new Date().toISOString(),
                    sold: true,
                    sellHash: sold.hash,
                    exitReason: reason,
                    ethOut,
                    profitEth:
                        ethOut != null ? ethOut - costShare : null,
                    pnlEth:
                        ethOut != null ? ethOut - costShare : null,
                    partial: true,
                    entryMcap: pos.entryMcap,
                },
            ].slice(-150);
            // Shrink basis on the open snipe(s) so TP2/trail P&L isn't charged full size
            for (const rec of store.snipes || []) {
                if (!rec.ok || rec.sold || rec.partial) continue;
                if (String(rec.token || "").toLowerCase() !== key) continue;
                if (ids.size && !ids.has(rec.id)) continue;
                const left = Math.max(
                    0,
                    Number(rec.amountEth || 0) * (1 - pct / 100)
                );
                rec.amountEth = Math.round(left * 1e8) / 1e8;
                rec.partialTaken = true;
            }
            const live = openPositions.get(key) || pos;
            live.partialTaken = true;
            live.remainingPct = Math.max(0, (live.remainingPct ?? 100) - pct);
            live.costEth = Math.max(
                0,
                Number(live.costEth || 0) * (1 - pct / 100)
            );
            if (pos._tpRungX != null) {
                const taken = Array.isArray(live.tpRungsTaken)
                    ? live.tpRungsTaken
                    : [];
                if (!taken.includes(pos._tpRungX)) {
                    live.tpRungsTaken = [...taken, pos._tpRungX];
                }
            }
            openPositions.set(key, live);
            saveStore(store);
            pushLog(
                `✅ partial $${pos.symbol} ${pct}%${ethOut != null ? ` · +${ethOut.toFixed(5)} ETH` : ""} · holding rest · ${EXPLORER}/tx/${sold.hash}`,
                "ok"
            );
            broadcast({
                type: "snipe_exit",
                token: pos.token,
                reason,
                hash: sold.hash,
                ethOut,
                partial: true,
                percent: pct,
            });
            return { ok: true, hash: sold.hash, ethOut, partial: true, results };
        }

        const mark = (rec) => {
            rec.sold = true;
            rec.sellHash = sold.hash;
            rec.exitReason = reason;
            if (ethOut != null && Number(rec.amountEth) > 0) {
                const share =
                    pos.costEth > 0
                        ? Number(rec.amountEth) / pos.costEth
                        : 1 / Math.max(ids.size, 1);
                rec.ethOut = ethOut * share;
                rec.profitEth = rec.ethOut - Number(rec.amountEth || 0);
                rec.pnlEth = rec.profitEth;
            } else {
                rec.ethOut = null;
                rec.profitEth = null;
            }
        };
        let marked = 0;
        for (const rec of store.snipes || []) {
            if (!rec.ok || rec.sold) continue;
            if (String(rec.token || "").toLowerCase() !== key) continue;
            if (ids.size && !ids.has(rec.id)) continue;
            mark(rec);
            marked += 1;
        }
        if (!marked) {
            for (const rec of store.snipes || []) {
                if (!rec.ok || rec.sold) continue;
                if (String(rec.token || "").toLowerCase() !== key) continue;
                mark(rec);
            }
        }
        saveStore(store);
        openPositions.delete(key);

        pushLog(
            `✅ sold $${pos.symbol}${ethOut != null ? ` · +${ethOut.toFixed(5)} ETH` : " · out pending"} · ${EXPLORER}/tx/${sold.hash}`,
            "ok"
        );
        broadcast({
            type: "snipe_exit",
            token: pos.token,
            reason,
            hash: sold.hash,
            ethOut,
        });
        return { ok: true, hash: sold.hash, ethOut, results };
    } finally {
        if (tokenKey) exitingTokens.delete(tokenKey);
        snipeBusy = false;
    }
}

/** Re-open snipes that were wrongly marked sold with no sell tx (fake full losses).
 *  Also demote broadcast-only "ok" buys whose tx reverted on-chain. */
async function repairFakeSoldSnipes() {
    let fixed = 0;
    let demoted = 0;
    for (const rec of store.snipes || []) {
        if (!rec.hash) continue;
        // Check receipt for claimed-ok buys (sold or open)
        if (rec.ok) {
            try {
                const receipt = await chain.provider.getTransactionReceipt(
                    rec.hash
                );
                if (receipt && receipt.status === 0) {
                    rec.ok = false;
                    rec.sold = false;
                    rec.filled = false;
                    rec.error = `buy reverted (${String(rec.hash).slice(0, 12)}…)`;
                    rec.exitReason = null;
                    rec.ethOut = null;
                    rec.profitEth = null;
                    rec.sellHash = null;
                    demoted += 1;
                    continue;
                }
            } catch (_) {}
        }
        if (!rec.sold) continue;
        if (rec.sellHash) continue;
        // Failed exit marked as full loss — only reopen if tokens may still exist
        if (Number(rec.ethOut) === 0 || rec.ethOut == null) {
            // Leave write-offs that already confirmed 0 tokens + no revert as sold
            if (/no tokens left/i.test(String(rec.exitReason || ""))) {
                // Keep as write-off but flag so UI doesn't look like a real sell
                rec.filled = false;
                continue;
            }
            rec.sold = false;
            rec.exitReason = null;
            rec.ethOut = null;
            rec.profitEth = null;
            rec.sellHash = null;
            fixed += 1;
        }
    }
    if (fixed || demoted) {
        saveStore(store);
        syncOpenPositionsFromStore();
        if (demoted) {
            pushLog(
                `🔧 Demoted ${demoted} snipes whose buy tx reverted (were fake "ok")`,
                "info"
            );
        }
        if (fixed) {
            pushLog(
                `🔧 Reopened ${fixed} snipes marked sold without a sell tx`,
                "info"
            );
        }
    }
    return fixed + demoted;
}

function ingestCreators(tokens) {
    for (const t of tokens || []) {
        const c = (t.creator || "").toLowerCase();
        if (!c) continue;
        const entry = creatorIndex.get(c) || {
            launches: [],
            bestAth: 0,
            avgAth: 0,
            updatedAt: 0,
        };
        const addr = (t.address || "").toLowerCase();
        const existingIdx = entry.launches.findIndex(
            (l) => (l.address || "").toLowerCase() === addr
        );
        const slim = {
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            logoUrl: t.logoUrl,
            createdAt: t.createdAt,
            marketCapEth: t.marketCapEth,
            athMarketCapEth: t.athMarketCapEth,
            initialBuyEth: t.initialBuyEth,
            noxaUrl: t.noxaUrl,
        };
        if (existingIdx >= 0) entry.launches[existingIdx] = slim;
        else entry.launches.push(slim);
        entry.launches.sort(
            (a, b) =>
                new Date(b.createdAt || 0).getTime() -
                new Date(a.createdAt || 0).getTime()
        );
        if (entry.launches.length > 40) entry.launches = entry.launches.slice(0, 40);
        const aths = entry.launches.map((l) => l.athMarketCapEth || 0);
        entry.bestAth = aths.length ? Math.max(...aths) : 0;
        entry.avgAth = aths.length
            ? aths.reduce((s, x) => s + x, 0) / aths.length
            : 0;
        entry.updatedAt = Date.now();
        creatorIndex.set(c, entry);
    }
}

function enrichPairsWithCreator(tokens) {
    return (tokens || []).map((t) => {
        const c = (t.creator || "").toLowerCase();
        const info = creatorIndex.get(c);
        const bestAth = info ? info.bestAth : t.athMarketCapEth || 0;
        const avgAth = info ? info.avgAth : t.athMarketCapEth || 0;
        const ethUsd = t.ethUsd || 0;
        return {
            ...t,
            creatorLaunchCount: info ? info.launches.length : 1,
            creatorBestAthMcEth: bestAth,
            creatorAvgAthMcEth: avgAth,
            creatorBestAthMcUsd: chain.ethToUsd(bestAth, ethUsd),
            creatorBestAthMcUsdLabel: chain.formatUsd(
                chain.ethToUsd(bestAth, ethUsd)
            ),
            creatorAvgAthMcUsdLabel: chain.formatUsd(
                chain.ethToUsd(avgAth, ethUsd)
            ),
            creatorSerial: info ? info.launches.length >= 3 : false,
            creatorOtherLaunches: info
                ? info.launches
                      .filter(
                          (l) =>
                              (l.address || "").toLowerCase() !==
                              (t.address || "").toLowerCase()
                      )
                      .slice(0, 5)
                : [],
        };
    });
}

/** Merge latest pairs-cache / API fields onto a launch row (socials, desc, buys). */
function mergeTokenMeta(t) {
    const key = String(t?.address || "").toLowerCase();
    if (!key) return t || {};
    const cached = (pairsCache.tokens || []).find(
        (p) => String(p.address || "").toLowerCase() === key
    );
    if (!cached) return { ...t };
    const out = { ...cached, ...t };
    for (const k of [
        "twitter",
        "telegram",
        "website",
        "description",
        "logoUrl",
        "logo",
        "initialBuyEth",
        "organicBuyEth",
        "signals",
        "name",
        "symbol",
        "creator",
    ]) {
        if ((out[k] == null || out[k] === "" || (Array.isArray(out[k]) && !out[k].length)) && cached[k]) {
            out[k] = cached[k];
        }
    }
    return out;
}

/** Same ticker/name already launched recently → clone / duplicate. */
function findDuplicateLaunch(t) {
    const key = String(t.address || "").toLowerCase();
    const sym = chain.normalizeNameKey(t.symbol);
    const nam = chain.normalizeNameKey(t.name);
    if (!sym && !nam) return null;
    for (const p of pairsCache.tokens || []) {
        const pk = String(p.address || "").toLowerCase();
        if (!pk || pk === key) continue;
        const ps = chain.normalizeNameKey(p.symbol);
        const pn = chain.normalizeNameKey(p.name);
        if (sym && ps && sym === ps && sym.length >= 3) {
            return { kind: "symbol", match: p.symbol, other: pk };
        }
        if (nam && pn && nam === pn && nam.length >= 4) {
            return { kind: "name", match: p.name, other: pk };
        }
    }
    return null;
}

/** X/TG/web already used on another token → recycled social, not fresh. */
function findRecycledSocial(t) {
    const key = String(t.address || "").toLowerCase();
    const socials = [
        chain.normalizeSocialKey(t.twitter),
        chain.normalizeSocialKey(t.telegram),
        chain.normalizeSocialKey(t.website),
    ].filter(Boolean);
    if (!socials.length) return null;
    for (const p of pairsCache.tokens || []) {
        const pk = String(p.address || "").toLowerCase();
        if (!pk || pk === key) continue;
        const theirs = [
            chain.normalizeSocialKey(p.twitter),
            chain.normalizeSocialKey(p.telegram),
            chain.normalizeSocialKey(p.website),
        ].filter(Boolean);
        for (const s of socials) {
            if (theirs.includes(s)) {
                return { social: s, other: pk, symbol: p.symbol };
            }
        }
    }
    // Also scan creator history for reused X on prior launches
    const c = String(t.creator || "").toLowerCase();
    const info = c ? creatorIndex.get(c) : null;
    if (info?.launches?.length) {
        for (const l of info.launches) {
            const lk = String(l.address || "").toLowerCase();
            if (!lk || lk === key) continue;
            // creatorIndex slim rows may lack socials — check pairs cache for those addrs
            const full = (pairsCache.tokens || []).find(
                (p) => String(p.address || "").toLowerCase() === lk
            );
            if (!full) continue;
            const theirs = [
                chain.normalizeSocialKey(full.twitter),
                chain.normalizeSocialKey(full.telegram),
            ].filter(Boolean);
            for (const s of socials) {
                if (theirs.includes(s)) {
                    return { social: s, other: lk, symbol: full.symbol || l.symbol };
                }
            }
        }
    }
    return null;
}

/**
 * Quality hunt score — parse everything, only buy high-conviction.
 * Returns { ok, score, reasons, waitForMeta }.
 */
function scoreTokenQuality(t, cfg = {}) {
    const reasons = [];
    let score = 0;
    const requireDevBuy = cfg.requireDevBuy !== false;
    const requireSocials = cfg.requireSocials !== false || cfg.skipNoSocials === true;
    const requireWebsite = cfg.requireWebsite === true;
    const minNarr = Number(cfg.minNarrativeScore ?? 3);
    const minScore = Number(cfg.minQualityScore ?? 6);
    const minDev = Number(cfg.minDevBuyEth ?? 0.001);
    const maxDev = Number(
        cfg.maxDevBuyEth != null ? cfg.maxDevBuyEth : cfg.maxInitialBuyEth || 0.35
    );

    const hasTw = !!t.twitter;
    const hasTg = !!t.telegram;
    const hasWeb = !!t.website;
    const hasAnySocial = hasTw || hasTg || hasWeb;
    const init = Number(t.initialBuyEth || 0);
    const metaReady =
        t.source === "api" ||
        hasAnySocial ||
        !!t.description ||
        (t.initialBuyEth != null && t.initialBuyEth !== "");

    // Chain-fast rows often lack socials until API enrich — ask caller to wait
    if (!metaReady && (requireSocials || requireDevBuy)) {
        return { ok: false, score: 0, reasons: ["awaiting_meta"], waitForMeta: true };
    }

    if (hasTw) {
        score += 2;
        reasons.push("x");
    }
    if (hasWeb) {
        score += 2;
        reasons.push("web");
    }
    if (hasTg) {
        score += 1;
        reasons.push("tg");
    }
    if (requireSocials && !hasAnySocial) {
        return { ok: false, score, reasons: [...reasons, "no_socials"], waitForMeta: false };
    }
    if (requireWebsite && !hasWeb) {
        return { ok: false, score, reasons: [...reasons, "no_website"], waitForMeta: false };
    }
    // Prefer fresh X (twitter present) when hunting narratives
    if (requireSocials && !hasTw && !hasWeb) {
        return { ok: false, score, reasons: [...reasons, "need_x_or_web"], waitForMeta: false };
    }

    if (init > 0) {
        if (init >= minDev && init <= maxDev) {
            score += init < 0.05 ? 3 : 2;
            reasons.push("dev_buy");
        } else if (init > maxDev) {
            return { ok: false, score, reasons: [...reasons, "fat_dev_buy"], waitForMeta: false };
        } else {
            reasons.push("tiny_dev_buy");
        }
    } else if (requireDevBuy) {
        // API said 0 vs unknown — if we have socials but no buy field yet, wait once
        if (t.initialBuyEth == null && !metaReady) {
            return { ok: false, score, reasons: ["awaiting_dev_buy"], waitForMeta: true };
        }
        return { ok: false, score, reasons: [...reasons, "no_dev_buy"], waitForMeta: false };
    }

    const narr = chain.narrativeQuality(t);
    score += Math.max(0, narr.score);
    if (narr.ok) reasons.push("narrative");
    if (narr.score < minNarr) {
        return {
            ok: false,
            score,
            reasons: [...reasons, `weak_narrative(${narr.score})`],
            waitForMeta: false,
        };
    }

    if (t.creatorSerial || Number(t.creatorLaunchCount || 0) >= 3) {
        score -= 2;
        reasons.push("serial");
    }

    const dup = cfg.skipDuplicateNames !== false ? findDuplicateLaunch(t) : null;
    if (dup) {
        return {
            ok: false,
            score,
            reasons: [...reasons, `dup_${dup.kind}:${dup.match}`],
            waitForMeta: false,
            duplicate: dup,
        };
    }
    const recycled =
        cfg.skipRecycledSocials !== false ? findRecycledSocial(t) : null;
    if (recycled) {
        return {
            ok: false,
            score,
            reasons: [...reasons, `recycled:${recycled.social}`],
            waitForMeta: false,
            recycled,
        };
    }

    return {
        ok: score >= minScore,
        score,
        reasons,
        waitForMeta: false,
        narrative: narr,
    };
}

function normalizeTpLadder(cfg) {
    const raw = Array.isArray(cfg?.tpLadder) ? cfg.tpLadder : null;
    if (raw?.length) {
        return raw
            .map((r) => ({
                x: Number(r.x),
                pct: Math.max(0, Math.min(100, Number(r.pct) || 0)),
            }))
            .filter((r) => r.x > 0)
            .sort((a, b) => a.x - b.x);
    }
    // Legacy TP1/TP2 → ladder
    const tp1 = Number(cfg?.takeProfitX || 1.6);
    const tp2 = Number(cfg?.takeProfit2X || 3);
    const partial = Math.min(90, Math.max(10, Number(cfg?.partialSellPct || 50)));
    return [
        { x: tp1, pct: partial },
        { x: tp2, pct: 100 },
    ];
}

function resolveSnipeWallet(walletIndex) {
    // Prefer dedicated sniper wallet — keep sniping separate from funder/buyers
    const s = sniper();
    if (s) return { wallet: s, index: store.wallets.indexOf(s) };
    return null;
}

function publicSnipe(s) {
    return {
        id: s.id,
        token: s.token,
        symbol: s.symbol,
        name: s.name,
        amountEth: s.amountEth,
        wallet: s.wallet,
        hash: s.hash,
        ok: s.ok,
        error: s.error,
        auto: !!s.auto,
        at: s.at,
        sold: !!s.sold,
        sellHash: s.sellHash,
        exitReason: s.exitReason,
        entryMcap: s.entryMcap,
        exitMcap: s.exitMcap,
        ethOut: s.ethOut ?? null,
        profitEth: s.profitEth ?? null,
        filled: s.filled !== false,
        partial: !!s.partial,
    };
}

function rangeToMs(range) {
    const r = String(range || "24h").toLowerCase();
    if (r === "1h") return 3600_000;
    if (r === "24h" || r === "1d") return 86400_000;
    if (r === "7d") return 7 * 86400_000;
    if (r === "30d") return 30 * 86400_000;
    if (r === "all") return null;
    return 86400_000;
}

async function buildSniperPortfolio(range = "24h") {
    const s = sniper();
    if (!s) {
        return { error: "No sniper wallet — import one on the Pairs tab", sniper: null };
    }
    const windowMs = rangeToMs(range);
    const now = Date.now();
    const ethUsd = await chain.getEthUsdPrice();
    const toUsd = (eth) => chain.ethToUsd(eth, ethUsd);
    const usdLabel = (eth, digits = 2) => chain.formatUsd(toUsd(eth), digits);
    const usdSigned = (eth, digits = 2) =>
        chain.formatUsdSigned(toUsd(eth), digits);

    const allSnipes = (store.snipes || []).filter(
        (x) =>
            String(x.wallet || "").toLowerCase() ===
            String(s.address).toLowerCase()
    );
    const snipes = allSnipes.filter((x) => {
        if (!windowMs) return true;
        const t = new Date(x.at || 0).getTime();
        return now - t <= windowMs;
    });

    let ethBalance = null;
    try {
        ethBalance = Number(await chain.getWalletBalance(s.address));
    } catch (_) {}

    // Open holdings: unique successful unsold snipes that actually filled
    const openByToken = new Map();
    for (const x of allSnipes) {
        if (!x.ok || x.sold || !x.token) continue;
        if (x.filled === false) continue;
        const key = String(x.token).toLowerCase();
        const prev = openByToken.get(key) || {
            token: x.token,
            symbol: x.symbol,
            costEth: 0,
            buys: 0,
            entryMcap: x.entryMcap,
            firstAt: x.at,
            lastAt: x.at,
        };
        prev.costEth += Number(x.amountEth || 0);
        prev.buys += 1;
        prev.symbol = x.symbol || prev.symbol;
        prev.lastAt = x.at;
        openByToken.set(key, prev);
    }

    const openPositions = [];
    let openValueEth = 0;
    let openCostEth = 0;
    const tokens = [...openByToken.values()];
    const quoted = await chain.mapPool(tokens, 6, async (pos) => {
        try {
            const { balance, decimals } = await chain.getTokenBalanceRaw(
                s.address,
                pos.token
            );
            if (!(balance > 0n)) {
                return {
                    ...pos,
                    tokens: 0,
                    valueEth: 0,
                    unrealized: -pos.costEth,
                    dead: true,
                };
            }
            let valueEth = 0;
            try {
                const q = await chain.quoteSell(pos.token, balance, {});
                valueEth = Number(q.ethOut || 0);
            } catch (_) {
                try {
                    const info = await chain.getTokenInfo(pos.token);
                    const price = Number(info?.token?.priceEth || 0);
                    const tok = Number(ethers.formatUnits(balance, decimals));
                    valueEth = price > 0 ? tok * price : 0;
                } catch (_) {}
            }
            const tokensHuman = Number(ethers.formatUnits(balance, decimals));
            return {
                ...pos,
                tokens: tokensHuman,
                valueEth,
                unrealized: valueEth - pos.costEth,
                dead: false,
            };
        } catch (e) {
            return {
                ...pos,
                tokens: 0,
                valueEth: 0,
                unrealized: null,
                error: e.message,
            };
        }
    });

    for (const p of quoted) {
        openPositions.push(p);
    }

    const live = openPositions.filter(
        (p) => !p.dead && (p.tokens || 0) > 0
    );
    const dead = openPositions.filter((p) => p.dead || !(p.tokens > 0));
    openCostEth = live.reduce((a, p) => a + Number(p.costEth || 0), 0);
    openValueEth = live.reduce((a, p) => a + Number(p.valueEth || 0), 0);
    const deadCostEth = dead.reduce((a, p) => a + Number(p.costEth || 0), 0);

    // Realized: only confirmed sells with a sell tx (and known profit)
    // Exclude never-filled / write-offs without sellHash from "closed" win-rate
    const closed = snipes.filter(
        (x) =>
            x.ok &&
            x.sold &&
            x.sellHash &&
            x.profitEth != null &&
            x.filled !== false
    );
    const wins = closed.filter((x) => Number(x.profitEth) > 0).length;
    const losses = closed.filter((x) => Number(x.profitEth) < 0).length;
    const realizedProfit = closed.reduce(
        (a, x) => a + (Number(x.profitEth) || 0),
        0
    );
    const realizedOut = closed.reduce(
        (a, x) => a + (Number(x.ethOut) || 0),
        0
    );
    // Buys that still show open in ledger but have 0 tokens = written-off loss
    // (only count if they were real fills — reverted buys are demoted to ok:false)
    const writeOffLoss = -deadCostEth;
    const spentInRange = snipes
        .filter((x) => x.ok && !x.partial)
        .reduce((a, x) => a + Number(x.amountEth || 0), 0);
    const failed = snipes.filter((x) => !x.ok).length;
    const unrealized = openValueEth - openCostEth;
    // Total = confirmed realized + live unrealized + dead write-offs
    const totalPnl = realizedProfit + unrealized + writeOffLoss;

    const enrichSnipe = (x) => {
        const base = publicSnipe(x);
        const spentUsd = toUsd(x.amountEth);
        const outUsd = x.ethOut != null ? toUsd(x.ethOut) : null;
        const profitUsd = x.profitEth != null ? toUsd(x.profitEth) : null;
        let profitUsdLabel = null;
        if (x.profitEth != null) profitUsdLabel = usdSigned(x.profitEth, 2);
        else if (x.sold && !x.sellHash) profitUsdLabel = "sell failed";
        else if (x.sold && x.sellHash && x.profitEth == null)
            profitUsdLabel = "out pending";
        return {
            ...base,
            spentUsd,
            spentUsdLabel: usdLabel(x.amountEth, 2),
            ethOutUsd: outUsd,
            ethOutUsdLabel: x.ethOut != null ? usdLabel(x.ethOut, 2) : null,
            profitUsd,
            profitUsdLabel,
        };
    };

    const openOut = live
        .sort((a, b) => (b.valueEth || 0) - (a.valueEth || 0))
        .map((p) => ({
            ...p,
            costUsd: toUsd(p.costEth),
            costUsdLabel: usdLabel(p.costEth, 2),
            valueUsd: toUsd(p.valueEth),
            valueUsdLabel: usdLabel(p.valueEth, 2),
            unrealizedUsd: p.unrealized != null ? toUsd(p.unrealized) : null,
            unrealizedUsdLabel:
                p.unrealized != null ? usdSigned(p.unrealized, 2) : "—",
        }));

    return {
        sniper: {
            address: s.address,
            name: s.name || "Sniper",
            ethBalance,
            ethBalanceUsd: toUsd(ethBalance),
            ethBalanceUsdLabel: usdLabel(ethBalance, 2),
            explorer: `${EXPLORER}/address/${s.address}`,
        },
        range,
        ethUsd,
        summary: {
            ethBalance,
            ethBalanceUsd: toUsd(ethBalance),
            ethBalanceUsdLabel: usdLabel(ethBalance, 2),
            spentEth: spentInRange,
            spentUsd: toUsd(spentInRange),
            spentUsdLabel: usdLabel(spentInRange, 2),
            openCostEth,
            openCostUsd: toUsd(openCostEth),
            openCostUsdLabel: usdLabel(openCostEth, 2),
            openValueEth,
            openValueUsd: toUsd(openValueEth),
            openValueUsdLabel: usdLabel(openValueEth, 2),
            unrealizedPnlEth: unrealized,
            unrealizedPnlUsd: toUsd(unrealized),
            unrealizedPnlUsdLabel: usdSigned(unrealized, 2),
            realizedPnlEth: realizedProfit,
            realizedPnlUsd: toUsd(realizedProfit),
            realizedPnlUsdLabel: usdSigned(realizedProfit, 2),
            writeOffEth: writeOffLoss,
            writeOffUsd: toUsd(writeOffLoss),
            writeOffUsdLabel: usdSigned(writeOffLoss, 2),
            deadCount: dead.length,
            realizedEthOut: realizedOut,
            totalPnlEth: totalPnl,
            totalPnlUsd: toUsd(totalPnl),
            totalPnlUsdLabel: usdSigned(totalPnl, 2),
            buys: snipes.filter((x) => x.ok && !x.partial).length,
            failed,
            openCount: live.length,
            closedCount: closed.length,
            wins,
            losses,
            winRate: closed.length > 0 ? (wins / closed.length) * 100 : null,
        },
        openPositions: openOut,
        snipes: snipes.slice().reverse().slice(0, 50).map(enrichSnipe),
        updatedAt: new Date().toISOString(),
    };
}

app.get("/api/sniper/portfolio", async (req, res) => {
    try {
        const range = req.query.range || "24h";
        const portfolio = await buildSniperPortfolio(range);
        if (portfolio.error && !portfolio.sniper) {
            return res.status(400).json(portfolio);
        }
        res.json(portfolio);
    } catch (e) {
        res.status(500).json({ error: e.shortMessage || e.message });
    }
});


/** Background: pull logos/socials/initialBuy from NOXA API for chain rows missing them */
let logoEnrichBusy = false;
async function enrichPairLogos() {
    if (!IS_SNIPER_HOST || logoEnrichBusy) return;
    const rows = pairsCache.tokens || [];
    const need = rows
        .filter(
            (t) =>
                t.address &&
                (!t.logoUrl ||
                    (!t.twitter && !t.telegram && !t.website) ||
                    t.initialBuyEth == null)
        )
        .slice(0, 20);
    if (!need.length) return;
    logoEnrichBusy = true;
    try {
        const listed = await chain.listTokens({ limit: 80, newest: true });
        const byAddr = new Map(
            (listed.tokens || []).map((t) => [
                String(t.address || "").toLowerCase(),
                t,
            ])
        );
        let changed = 0;
        for (const t of pairsCache.tokens || []) {
            const api = byAddr.get(String(t.address || "").toLowerCase());
            if (!api) continue;
            let hit = false;
            if (!t.logoUrl && (api.logoUrl || api.logo)) {
                t.logo = api.logo || t.logo;
                t.logoUrl = api.logoUrl || api.logo;
                hit = true;
            }
            if (!t.initialBuyEth && api.initialBuyEth) {
                t.initialBuyEth = api.initialBuyEth;
                t.organicBuyEth = api.organicBuyEth;
                hit = true;
            }
            for (const k of ["twitter", "telegram", "website", "description", "signals"]) {
                if ((!t[k] || (Array.isArray(t[k]) && !t[k].length)) && api[k]) {
                    t[k] = api[k];
                    hit = true;
                }
            }
            if (api.name && (!t.name || t.name === "Unknown")) {
                t.name = api.name;
                hit = true;
            }
            if (api.symbol && (!t.symbol || t.symbol === "???")) {
                t.symbol = api.symbol;
                hit = true;
            }
            if (hit) changed++;
        }
        if (changed) {
            broadcast({
                type: "pairs",
                tokens: (pairsCache.tokens || []).slice(0, 60),
                updatedAt: pairsCache.updatedAt,
                fresh: [],
                source: pairsCache.source,
                feedNote: pairsCache.feedNote,
                freshestAgeSec: pairsCache.freshestAgeSec,
            });
        }
    } catch (_) {
    } finally {
        logoEnrichBusy = false;
    }
}

let pairsPollBusy = false;
let launchScanBusy = false;
let lastLaunchBlock = 0;
const snipingTokens = new Set(); // prevent double-fire on same token
/** Tokens that failed live preflight while still young — retry for a few seconds. */
const pendingTradable = new Map(); // key -> { token meta, firstAt, tries }
const pendingQuality = new Map(); // key -> { meta, firstAt, tries } — wait for socials/API enrich

/** Skip tokens the creator already dumped — don't buy into a finished rug. */
async function creatorAlreadySold(token, creator, { minEth = 0.002 } = {}) {
    if (!creator || !token) return false;
    try {
        const swaps = await chain.fetchRecentSwaps(token, { limit: 30 });
        const hits = chain.detectCreatorSells(swaps, creator, { minEth, sinceTs: 0 });
        return hits.length > 0;
    } catch (_) {
        return false;
    }
}

async function tryAutoSnipeFresh(freshList, { source = "poll" } = {}) {
    const cfg = store.snipeConfig || {};
    if (!cfg.enabled) return;
    if (!sniper()) return;
    if (job.running) return;
    syncOpenPositionsFromStore();
    const maxOpen = Math.max(1, Number(cfg.maxOpenPositions || 40));
    if (openPositions.size >= maxOpen) return;

    const qualityMode = cfg.qualityMode !== false;
    // Re-queue young tokens that weren't tradable yet + quality-wait queue
    const now = Date.now();
    const retryList = [];
    for (const [key, row] of pendingTradable) {
        if (now - row.firstAt > 18_000 || row.tries >= 10) {
            pendingTradable.delete(key);
            continue;
        }
        if (snipingTokens.has(key) || openPositions.has(key)) {
            pendingTradable.delete(key);
            continue;
        }
        retryList.push(row.meta);
    }
    for (const [key, row] of pendingQuality) {
        if (now - row.firstAt > 25_000 || row.tries >= 12) {
            pendingQuality.delete(key);
            pushLog(
                `⏭ skip $${row.meta?.symbol || key.slice(0, 8)}: quality meta never arrived`,
                "info"
            );
            continue;
        }
        if (snipingTokens.has(key) || openPositions.has(key)) {
            pendingQuality.delete(key);
            continue;
        }
        retryList.push(row.meta);
    }
    const merged = [];
    const seenMerge = new Set();
    for (const t of [...(freshList || []), ...retryList]) {
        const k = String(t.address || "").toLowerCase();
        if (!k || seenMerge.has(k)) continue;
        seenMerge.add(k);
        merged.push(t);
    }
    if (!merged.length) return;

    // First-block sniping: only buy VERY fresh launches
    // Quality mode: allow a bit more age so API socials can land
    const maxAge = Math.min(
        Number(cfg.maxAgeSec || 90),
        Number(cfg.fastMaxAgeSec || 12) + (qualityMode ? 8 : 0)
    );
    let sniped = 0;
    // Quality = fewer buys per tick (hunt, don't spray)
    const maxPerTick = qualityMode ? 1 : source === "block" ? 2 : 3;
    const minMc = Number(cfg.minEntryMcapEth || 0);
    const maxMc = Number(cfg.maxEntryMcapEth || 0);
    const skipNoSocials = cfg.skipNoSocials === true || qualityMode;
    const skipLowAthSerials = cfg.skipLowAthSerials !== false;
    const minCreatorAth = Number(cfg.minCreatorAthEth ?? 2);
    // Quality hunt always skips serials
    const skipSerials = qualityMode || cfg.skipSerialCreators === true;

    for (let raw of merged) {
        if (sniped >= maxPerTick) break;
        if (openPositions.size >= maxOpen) break;
        let t = mergeTokenMeta(raw);
        // Prefer creator-enriched row
        try {
            t = enrichPairsWithCreator([t])[0] || t;
        } catch (_) {}
        const key = String(t.address || "").toLowerCase();
        if (!key) continue;
        if (snipingTokens.has(key) || openPositions.has(key)) continue;
        // Cooldown only between different tokens on poll path; block path is urgent
        if (source !== "block" && Date.now() - lastAutoSnipeAt < Number(cfg.cooldownMs || 400)) {
            break;
        }
        const age = t.ageSec != null ? Number(t.ageSec) : 0;
        if (age > maxAge && !pendingTradable.has(key) && !pendingQuality.has(key)) {
            pushLog(`⏭ skip $${t.symbol || key.slice(0, 8)}: age ${age}s > ${maxAge}s (too late)`, "info");
            continue;
        }
        if (Number(t.initialBuyEth || 0) > Number(cfg.maxInitialBuyEth || 1.0)) {
            pushLog(`⏭ skip $${t.symbol}: creator initial buy ${t.initialBuyEth} ETH too large`, "info");
            pendingQuality.delete(key);
            continue;
        }
        if (skipSerials && (t.creatorSerial || Number(t.creatorLaunchCount || 0) >= 3)) {
            pushLog(`⏭ skip $${t.symbol}: serial creator`, "info");
            pendingQuality.delete(key);
            continue;
        }

        // MC band — only when we have a real live MC (not just launch default)
        const mcap = Number(t.marketCapEth || 0);
        const isDefaultMc =
            !mcap ||
            Math.abs(mcap - Number(chain.NOXA_STARTING_MC_ETH || 1.36)) < 1e-6;
        if (!isDefaultMc) {
            if (minMc > 0 && mcap < minMc) {
                pushLog(`⏭ skip $${t.symbol}: MC ${mcap.toFixed(2)} < min ${minMc}`, "info");
                continue;
            }
            if (maxMc > 0 && mcap > maxMc) {
                pushLog(`⏭ skip $${t.symbol}: MC ${mcap.toFixed(2)} > max ${maxMc}`, "info");
                continue;
            }
        }

        // Quality hunt: parse all, buy only high-conviction (narrative + socials + fresh X + real dev buy)
        if (qualityMode) {
            const q = scoreTokenQuality(t, cfg);
            if (q.waitForMeta) {
                const row = pendingQuality.get(key) || {
                    meta: t,
                    firstAt: Date.now(),
                    tries: 0,
                };
                row.meta = { ...row.meta, ...t, ageSec: age };
                row.tries += 1;
                pendingQuality.set(key, row);
                pairsCache.seen.delete(key); // allow re-eval after enrich
                if (row.tries === 1 || row.tries % 3 === 0) {
                    pushLog(
                        `⏳ quality wait $${t.symbol || key.slice(0, 8)}: need socials/dev buy · try ${row.tries}`,
                        "info"
                    );
                }
                continue;
            }
            if (!q.ok) {
                pendingQuality.delete(key);
                pushLog(
                    `⏭ skip $${t.symbol || key.slice(0, 8)}: quality ${q.score} · ${q.reasons.join(",")}`,
                    "info"
                );
                continue;
            }
            pendingQuality.delete(key);
            pushLog(
                `✨ quality $${t.symbol}: score ${q.score} · ${q.reasons.join("+")}`,
                "ok"
            );
        } else {
            // Legacy lighter gates
            const allowHeavy = source !== "block" || age > 2;
            if (allowHeavy) {
                const signals = Array.isArray(t.signals) ? t.signals : [];
                const hasSig = (id) => signals.some((s) => s?.id === id || s === id);
                if (skipNoSocials && (hasSig("no_socials") || (!t.twitter && !t.telegram && !t.website && t.source === "api"))) {
                    pushLog(`⏭ skip $${t.symbol}: no socials`, "info");
                    continue;
                }
                if (hasSig("fat_dev_buy") && Number(t.initialBuyEth || 0) > Number(cfg.maxInitialBuyEth || 1)) {
                    pushLog(`⏭ skip $${t.symbol}: fat_dev_buy signal`, "info");
                    continue;
                }
                const init = Number(t.initialBuyEth || 0);
                const organic = Number(t.organicBuyEth || 0);
                if (init >= 0.15 && organic > 0 && organic < init * 0.15) {
                    pushLog(`⏭ skip $${t.symbol}: fat creator / thin organic (${init.toFixed(3)}/${organic.toFixed(3)}Ξ)`, "info");
                    continue;
                }
                if (
                    skipLowAthSerials &&
                    Number(t.creatorLaunchCount || 0) >= 3 &&
                    Number(t.creatorBestAthMcEth || 0) > 0 &&
                    Number(t.creatorBestAthMcEth) < minCreatorAth
                ) {
                    pushLog(
                        `⏭ skip $${t.symbol}: serial low-ATH (best ${Number(t.creatorBestAthMcEth).toFixed(2)}Ξ < ${minCreatorAth})`,
                        "info"
                    );
                    continue;
                }
            }
        }

        // Don't buy a token the dev already sold out of (skip on brand-new block hits — too early to be rugged, and the API call costs time)
        if (
            cfg.skipRugged !== false &&
            t.creator &&
            (source !== "block" || age > 2 || qualityMode)
        ) {
            const rugged = await creatorAlreadySold(t.address, t.creator, {
                minEth: Number(cfg.devSellMinEth ?? 0.002),
            });
            if (rugged) {
                pushLog(`⏭ skip $${t.symbol || key.slice(0, 8)}: creator ALREADY SOLD — not buying the rug`, "err");
                pairsCache.seen.add(key);
                pendingTradable.delete(key);
                pendingQuality.delete(key);
                continue;
            }
        }

        // Dynamic size: quality winners get full size; weaker get cut
        let size = Number(cfg.amountEth || 0.003);
        let sizeMult = 1;
        if (t.creatorSerial || Number(t.creatorLaunchCount || 0) >= 3) sizeMult *= 0.6;
        if (Number(t.creatorBestAthMcEth || 0) > 0 && Number(t.creatorBestAthMcEth) < 5) sizeMult *= 0.75;
        const signals = Array.isArray(t.signals) ? t.signals : [];
        if (signals.some((s) => s?.id === "no_socials" || s === "no_socials")) sizeMult *= 0.7;
        if (signals.some((s) => s?.tone === "ok")) sizeMult = Math.min(1.15, sizeMult * 1.1);
        if (qualityMode && (t.twitter && t.website)) sizeMult = Math.min(1.2, sizeMult * 1.1);
        size = Math.max(0.001, Math.round(size * sizeMult * 1e6) / 1e6);

        // Live tradability gate — historical eth_call on this RPC lies; estimateGas is honest.
        // Prefer buying as soon as the pool is tradable (create swap alone is enough).
        // Waiting for a 2nd external swap made us 45–90 blocks late and ate the edge.
        try {
            const minSwaps = Number(
                cfg.minPoolSwapsBeforeBuy != null ? cfg.minPoolSwapsBeforeBuy : 1
            );
            if (minSwaps > 0) {
                const swapInfo = await chain.countPoolSwaps(t.address, {
                    fee: t.poolFee ?? chain.DEFAULT_POOL_FEE,
                    pairedToken: t.pairedToken || chain.WETH,
                    fromBlock: t.createdAtBlock
                        ? Math.max(0, Number(t.createdAtBlock) - 1)
                        : undefined,
                    lookbackBlocks: 120,
                });
                if (!swapInfo.ok || Number(swapInfo.swaps || 0) < minSwaps) {
                    const row = pendingTradable.get(key) || {
                        meta: t,
                        firstAt: Date.now(),
                        tries: 0,
                    };
                    row.meta = { ...row.meta, ...t, ageSec: age };
                    row.tries += 1;
                    pendingTradable.set(key, row);
                    pairsCache.seen.delete(key);
                    pushLog(
                        `⏳ wait $${t.symbol || key.slice(0, 8)}: pool swaps ${swapInfo.swaps || 0}/${minSwaps} · retry ${row.tries}`,
                        "info"
                    );
                    continue;
                }
            }
            const ready = await chain.estimateBuyReady(t.address, size, {
                fee: t.poolFee ?? chain.DEFAULT_POOL_FEE,
                pairedToken: t.pairedToken || chain.WETH,
                walletAddress: sniper()?.address,
            });
            if (!ready?.ok) {
                const err = String(ready?.error || "estimate");
                const isTf = /["']TF["']|transfer|STF|execution reverted/i.test(err);
                const row = pendingTradable.get(key) || {
                    meta: t,
                    firstAt: Date.now(),
                    tries: 0,
                };
                row.meta = { ...row.meta, ...t, ageSec: age };
                row.tries += 1;
                // TF antibot window: retry briefly, then abandon (don't sit 90s late)
                if (isTf && Date.now() - row.firstAt > 12_000) {
                    pendingTradable.delete(key);
                    pairsCache.seen.add(key);
                    pushLog(
                        `⏭ skip $${t.symbol || key.slice(0, 8)}: still TF after 12s — antibot/honeypot`,
                        "info"
                    );
                    continue;
                }
                pendingTradable.set(key, row);
                pairsCache.seen.delete(key);
                pushLog(
                    `⏳ wait $${t.symbol || key.slice(0, 8)}: not tradable yet (${err.slice(0, 60)}) · retry ${row.tries}`,
                    "info"
                );
                continue;
            }
            pendingTradable.delete(key);
        } catch (e) {
            pushLog(`⏭ skip $${t.symbol || key.slice(0, 8)}: preflight ${e.message}`, "info");
            continue;
        }

        snipingTokens.add(key);
        pendingTradable.delete(key);
        lastAutoSnipeAt = Date.now();
        sniped++;
        // Fire without awaiting fill — unlocks next launch immediately
        executeSnipe({
            token: t.address,
            amountEth: size,
            walletIndex: cfg.walletIndex,
            auto: true,
            takeProfitX: Number(cfg.takeProfitX || 1.5),
            stopLossPct: Number(cfg.stopLossPct || 25),
            meta: t,
            fastEntry: true,
        })
            .catch((e) => pushLog(`snipe error: ${e.message}`, "err"))
            .finally(() => {
                snipingTokens.delete(key);
            });
        // Gap so same-wallet nonces stay ordered under load
        await chain.sleep(source === "block" ? 120 : 80);
    }
}

/** Block-level launch scanner — fires as soon as a new block has TokenCreated logs. */
async function scanNewLaunches() {
    if (!IS_SNIPER_HOST) return;
    if (launchScanBusy) return;
    launchScanBusy = true;
    try {
        const cfg = store.snipeConfig || {};
        if (!cfg.enabled) return;
        const latest = await chain.provider.getBlockNumber();
        const fromBlock =
            lastLaunchBlock > 0
                ? Math.max(0, lastLaunchBlock)
                : Math.max(0, latest - 2);
        if (fromBlock > latest) {
            lastLaunchBlock = latest + 1;
            return;
        }
        const { tokens } = await chain.fetchLaunchEventsFast({
            fromBlock,
            toBlock: latest,
            lookbackBlocks: 3,
        });
        lastLaunchBlock = latest + 1;
        if (!tokens.length) {
            if (pendingTradable.size || pendingQuality.size) {
                await tryAutoSnipeFresh([], { source: "block" });
            }
            return;
        }

        const prevSeen = pairsCache.seen;
        const fresh = [];
        for (const t of tokens) {
            const key = String(t.address || "").toLowerCase();
            if (!key) continue;
            if (!prevSeen.has(key)) {
                fresh.push(t);
                prevSeen.add(key);
            }
        }
        if (!fresh.length) {
            if (pendingTradable.size || pendingQuality.size) {
                await tryAutoSnipeFresh([], { source: "block" });
            }
            return;
        }

        // Merge onto board (newest first)
        const byAddr = new Map(
            (pairsCache.tokens || []).map((x) => [
                String(x.address || "").toLowerCase(),
                x,
            ])
        );
        for (const t of fresh) {
            byAddr.set(String(t.address).toLowerCase(), {
                ...(byAddr.get(String(t.address).toLowerCase()) || {}),
                ...t,
            });
        }
        pairsCache.tokens = [...byAddr.values()].sort(
            (a, b) =>
                (b.createdAtBlock || 0) - (a.createdAtBlock || 0) ||
                new Date(b.createdAt || 0).getTime() -
                    new Date(a.createdAt || 0).getTime()
        );
        pairsCache.updatedAt = Date.now();
        pairsCache.source = "chain-fast";
        pairsCache.freshestAgeSec = fresh[0]?.ageSec ?? 0;
        pairsCache.feedNote = `⚡ block scan · ${fresh.length} new launch(es)`;
        broadcast({
            type: "pairs",
            tokens: pairsCache.tokens.slice(0, 60),
            freshTokens: fresh,
            updatedAt: pairsCache.updatedAt,
            fresh: fresh.map((t) => t.address),
            source: pairsCache.source,
            feedNote: pairsCache.feedNote,
            freshestAgeSec: pairsCache.freshestAgeSec,
        });
        pushLog(
            `⚡ NEW LAUNCH${fresh.length > 1 ? "ES" : ""} · ${fresh.map((t) => t.symbol || t.address.slice(0, 8)).join(", ")} — sniping`,
            "ok"
        );
        await tryAutoSnipeFresh(fresh, { source: "block" });
    } catch (e) {
        // silent — next block retries
    } finally {
        launchScanBusy = false;
    }
}

async function pollPairs() {
    if (!IS_SNIPER_HOST) return; // pairs/sniper live on sniper host only
    if (pairsPollBusy) return;
    pairsPollBusy = true;
    try {
        // On-chain factory first — NOXA /tokens API can lag ~1h+
        const listed = await chain.listNewestTokens({ limit: 60, lookbackBlocks: 400 });
        const tokens = (listed.tokens || []).slice().sort((a, b) => {
            const ab = Number(a.createdAtBlock || 0);
            const bb = Number(b.createdAtBlock || 0);
            if (bb !== ab) return bb - ab;
            return (
                new Date(b.createdAt || 0).getTime() -
                new Date(a.createdAt || 0).getTime()
            );
        });
        const prevSeen = pairsCache.seen;
        const nextSeen = new Set(prevSeen);
        const fresh = [];
        for (const t of tokens) {
            const key = (t.address || "").toLowerCase();
            if (!key) continue;
            if (!prevSeen.has(key) && prevSeen.size > 0) {
                fresh.push(t);
            }
            nextSeen.add(key);
        }
        // Cap seen set
        if (nextSeen.size > 500) {
            const arr = [...nextSeen];
            pairsCache.seen = new Set(arr.slice(arr.length - 400));
        } else {
            pairsCache.seen = nextSeen;
        }
        pairsCache.tokens = tokens;
        pairsCache.updatedAt = Date.now();
        pairsCache.source = listed.source || "unknown";
        pairsCache.feedNote = listed.feedNote || null;
        pairsCache.freshestAgeSec = listed.freshestAgeSec ?? null;
        ingestCreators(tokens);
        const enriched = enrichPairsWithCreator(tokens);
        // Keep newest-first after enrich
        enriched.sort((a, b) => {
            const ab = Number(a.createdAtBlock || 0);
            const bb = Number(b.createdAtBlock || 0);
            if (bb !== ab) return bb - ab;
            return (
                new Date(b.createdAt || 0).getTime() -
                new Date(a.createdAt || 0).getTime()
            );
        });
        pairsCache.tokens = enriched;
        broadcast({
            type: "pairs",
            tokens: enriched.slice(0, 60),
            freshTokens: fresh.slice(0, 20),
            updatedAt: pairsCache.updatedAt,
            fresh: fresh.map((t) => t.address),
            source: pairsCache.source,
            feedNote: pairsCache.feedNote,
            freshestAgeSec: pairsCache.freshestAgeSec,
        });
        setImmediate(() => enrichPairLogos());

        // Auto-snipe backup path (block scanner is primary)
        if (fresh.length || pendingTradable.size || pendingQuality.size) {
            await tryAutoSnipeFresh(fresh, { source: "poll" });
        }
    } catch (e) {
        broadcast({ type: "pairs_error", error: e.message });
    } finally {
        pairsPollBusy = false;
    }
}

/**
 * Background fill confirm for fast-entry snipes.
 * If the buy reverts or lands 0 tokens, drop the fake open position.
 */
function markSnipeFillResult(snipeId, token, fill) {
    const key = String(token || "").toLowerCase();
    const rec = (store.snipes || []).find((x) => x.id === snipeId);
    if (!fill?.ok) {
        if (rec) {
            rec.ok = false;
            rec.filled = false;
            rec.error = `buy ${fill?.reason || "failed"} (${String(fill?.hash || "").slice(0, 12)}…)`;
            rec.pending = false;
        }
        const pos = openPositions.get(key);
        if (pos) {
            // Only remove if this snipe was the sole contributor
            const ids = pos.snipeIds || [];
            if (ids.length <= 1 || (ids.length === 1 && ids[0] === snipeId)) {
                openPositions.delete(key);
            } else {
                pos.snipeIds = ids.filter((id) => id !== snipeId);
                pos.costEth = Math.max(
                    0,
                    Number(pos.costEth || 0) - Number(rec?.amountEth || 0)
                );
                openPositions.set(key, pos);
            }
        }
        saveStore(store);
        pushLog(
            `⚠️ $${rec?.symbol || key.slice(0, 8)}: fill FAILED (${fill?.reason || "?"}) — removed from open`,
            "err"
        );
        broadcast({
            type: "snipe_fill_failed",
            token,
            snipeId,
            reason: fill?.reason || "failed",
            hash: fill?.hash || null,
        });
        return;
    }
    if (rec) {
        rec.filled = true;
        rec.pending = false;
        rec.ok = true;
        rec.error = null;
        if (fill.hash) rec.hash = fill.hash;
        if (fill.tokensRaw) rec.tokensRaw = fill.tokensRaw;
        if (fill.retried) rec.retriedFill = true;
        saveStore(store);
        if (fill.retried) {
            pushLog(
                `✅ $${rec?.symbol || key.slice(0, 8)}: fill OK after retry`,
                "ok"
            );
        }
    }
}

async function executeSnipe({
    token,
    amountEth,
    walletIndex,
    auto = false,
    takeProfitX = 2,
    stopLossPct = 40,
    meta = null,
    fastEntry = false,
}) {
    // Allow concurrent auto-snipes on different tokens (nonce managed per-wallet by ethers)
    if (snipeBusy && !fastEntry) return { ok: false, error: "snipe already in progress" };
    const resolved = resolveSnipeWallet(walletIndex);
    if (!resolved) {
        return {
            ok: false,
            error: "No sniper wallet — import or create one on the Pairs tab first",
        };
    }
    if (!chain.isEvmAddress(token || "")) return { ok: false, error: "Invalid token" };

    if (!fastEntry) snipeBusy = true;
    const id = `snipe_${Date.now()}`;
    const symbol = meta?.symbol || "?";
    pushLog(
        `🎯 ${auto ? "AUTO " : ""}SNIPE $${symbol} ${token.slice(0, 10)}… · ${amountEth} ETH from ${resolved.wallet.name || resolved.wallet.address.slice(0, 8)}${fastEntry ? " · FAST" : ""}`,
        "info"
    );
    broadcast({ type: "snipe_start", id, token, auto });

    try {
        const result = await chain.snipeBuy(
            { private_key: resolved.wallet.private_key },
            amountEth,
            token,
            {
                // Fast entry: broadcast and move on — don't wait for receipt
                waitForFill: !fastEntry,
                retries: fastEntry ? 3 : auto ? 8 : 5,
                retryDelayMs: fastEntry ? 80 : 400,
                fee: meta?.poolFee ?? chain.DEFAULT_POOL_FEE ?? 10000,
                pairedToken: meta?.pairedToken || chain.WETH,
                symbol: meta?.symbol,
                name: meta?.name,
                marketCapEth: meta?.marketCapEth,
                skipQuote: true,
                skipMulticall: true, // direct exactInputSingle — fastest path
                priorityMultiplier: fastEntry ? 2.75 : 1.8,
                legacyGas: true,
                preflight: true,
                reserveSellGas: true,
                sellGasReserveEth: Number(
                    store.snipeConfig?.sellGasReserveEth ?? 0.0004
                ),
                onFillResult: fastEntry
                    ? (fill) => {
                          try {
                              markSnipeFillResult(id, token, fill);
                          } catch (e) {
                              console.warn("markSnipeFillResult:", e.message || e);
                          }
                      }
                    : undefined,
            }
        );

        let entryMcap = Number(meta?.marketCapEth || 0) || null;
        // Fast entry: skip slow API/quoter MC lookups — use starting MC, refine later
        if (!fastEntry) {
            try {
                const info = await chain.getTokenInfo(token, { optional: true });
                entryMcap = Number(
                    info?.token?.marketCapEth || info?.marketCapEth || entryMcap || 0
                );
            } catch (_) {}
            if (!(entryMcap > 0) || entryMcap === chain.NOXA_STARTING_MC_ETH) {
                try {
                    const live = await chain.resolveLiveMarketCap(token, null, {
                        fee: meta?.poolFee ?? chain.DEFAULT_POOL_FEE,
                    });
                    if (Number(live?.mcapEth) > 0) entryMcap = Number(live.mcapEth);
                } catch (_) {}
            }
        }
        if (!(entryMcap > 0)) entryMcap = chain.NOXA_STARTING_MC_ETH;

        const record = {
            id,
            token,
            symbol,
            name: meta?.name || symbol,
            amountEth,
            wallet: resolved.wallet.address,
            walletIndex: resolved.index,
            hash: result.hash || null,
            ok: !!result.ok,
            error: result.error || null,
            auto,
            at: new Date().toISOString(),
            sold: false,
            filled: fastEntry ? null : true,
            pending: !!(fastEntry && result.ok && result.pending),
            entryMcap,
            takeProfitX,
            stopLossPct,
            creator: meta?.creator
                ? String(meta.creator).toLowerCase()
                : null,
        };
        store.snipes = [...(store.snipes || []), record].slice(-100);
        store.lastToken = token;
        saveStore(store);

        if (result.ok) {
            pushLog(`✅ sniped · ${EXPLORER}/tx/${result.hash}`, "ok");
            const key = token.toLowerCase();
            const prev = openPositions.get(key);
            openPositions.set(key, {
                id,
                snipeIds: [...(prev?.snipeIds || []), id],
                walletIndex: resolved.index,
                costEth: Number(prev?.costEth || 0) + Number(amountEth),
                entryMcap:
                    entryMcap ||
                    prev?.entryMcap ||
                    chain.NOXA_STARTING_MC_ETH,
                takeProfitX: Number(
                    store.snipeConfig?.takeProfitX || takeProfitX
                ),
                stopLossPct: Number(
                    store.snipeConfig?.stopLossPct || stopLossPct
                ),
                peakMcap:
                    entryMcap ||
                    prev?.peakMcap ||
                    chain.NOXA_STARTING_MC_ETH,
                partialTaken: !!prev?.partialTaken,
                remainingPct: prev?.remainingPct ?? 100,
                tpRungsTaken: Array.isArray(prev?.tpRungsTaken)
                    ? prev.tpRungsTaken
                    : [],
                token,
                symbol,
                creator: record.creator || prev?.creator || null,
                creatorBalRaw: prev?.creatorBalRaw ?? null,
                openedAt: prev?.openedAt || record.at,
            });
        } else {
            pushLog(`❌ snipe failed: ${result.error}`, "err");
        }
        broadcast({ type: "snipe_done", snipe: publicSnipe(record) });
        return record;
    } catch (e) {
        pushLog(`❌ snipe error: ${e.shortMessage || e.message}`, "err");
        return { ok: false, error: e.message };
    } finally {
        snipeBusy = false;
    }
}

async function monitorPositions() {
    const cfg = store.snipeConfig || {};
    syncOpenPositionsFromStore();
    if (!cfg.autoSell) return;
    if (!openPositions.size || job.running) return;

    const ladder = normalizeTpLadder(cfg);
    const slPct = Number(cfg.stopLossPct || 35);
    const trailPct = Number(cfg.trailPct || 25);
    // Moonbag hold: after banking 1x/2x/3x, trail the rest (don't force-dump at 5x)
    const moonbagX = Number(cfg.moonbagHoldX || 5);

    for (const [key, pos] of [...openPositions.entries()]) {
        try {
            if (exitingTokens.has(key)) continue;
            // Skip bags with no tokens (reverted / already dumped) before MC math
            const w = store.wallets[pos.walletIndex] || sniper();
            if (w) {
                try {
                    const tb = await chain.getTokenBalanceRaw(w.address, pos.token);
                    if (!(tb.balance > 0n)) {
                        await exitOpenPosition(pos, "no tokens on wallet", 100);
                        continue;
                    }
                } catch (_) {}
            }

            const info = await chain.getTokenInfo(pos.token, { optional: true });
            let mcap = Number(
                info?.token?.marketCapEth || info?.marketCapEth || 0
            );
            // Brand-new tokens often lack API MC — use Uniswap quoter
            if (!(mcap > 0)) {
                try {
                    const live = await chain.resolveLiveMarketCap(pos.token, null, {
                        fee: chain.DEFAULT_POOL_FEE,
                    });
                    mcap = Number(live?.mcapEth || 0);
                } catch (_) {}
            }
            if (!mcap || !pos.entryMcap) continue;

            // Track peak for trailing
            const peak = Math.max(Number(pos.peakMcap || pos.entryMcap), mcap);
            pos.peakMcap = peak;
            openPositions.set(key, pos);

            const multiple = mcap / pos.entryMcap;
            const dropFromEntry =
                ((pos.entryMcap - mcap) / pos.entryMcap) * 100;
            const dropFromPeak = ((peak - mcap) / peak) * 100;
            const rungsTaken = Array.isArray(pos.tpRungsTaken)
                ? pos.tpRungsTaken
                : [];

            let reason = null;
            let sellPct = 100;
            let rungX = null;

            // 1) Hard stop from entry — only before we've banked anything
            if (!rungsTaken.length && !pos.partialTaken && dropFromEntry >= slPct) {
                reason = `SL -${dropFromEntry.toFixed(0)}%`;
                sellPct = 100;
            } else {
                // 2) Ladder: bank small at 1x / 2x / 3x; pct=0 means hold (moonbag marker)
                for (const rung of ladder) {
                    if (rungsTaken.includes(rung.x)) continue;
                    if (multiple < rung.x) break;
                    if (!(rung.pct > 0)) {
                        // Mark rung hit without selling (e.g. 5x hold target)
                        const live = openPositions.get(key) || pos;
                        live.tpRungsTaken = [...(live.tpRungsTaken || []), rung.x];
                        openPositions.set(key, live);
                        pushLog(
                            `🚀 $${pos.symbol}: ${multiple.toFixed(2)}x ≥ ${rung.x}x — holding moonbag`,
                            "ok"
                        );
                        continue;
                    }
                    // Sell % of *current* bag so ladder compounds correctly
                    const rem = Math.max(1, Number(pos.remainingPct ?? 100));
                    sellPct = Math.min(99, Math.max(1, Math.round((rung.pct / rem) * 100)));
                    // If this would leave dust, just sell all remaining
                    if (rem - rung.pct < 5) sellPct = 100;
                    reason = `TP ${rung.x}x · bank ~${rung.pct}% of bag (${multiple.toFixed(2)}x)`;
                    rungX = rung.x;
                    break;
                }
                // 3) After any bank: trail the runner (especially past moonbag)
                if (!reason && (rungsTaken.length || pos.partialTaken)) {
                    const pastMoon =
                        multiple >= moonbagX ||
                        rungsTaken.some((x) => x >= moonbagX);
                    const trailUse = pastMoon
                        ? Math.max(12, trailPct - 5)
                        : trailPct;
                    if (dropFromPeak >= trailUse) {
                        reason = `TRAIL -${dropFromPeak.toFixed(0)}% from peak${pastMoon ? " · moonbag" : ""}`;
                        sellPct = 100;
                    }
                }
            }

            if (!reason) continue;

            const exitPos = { ...pos, _tpRungX: rungX };
            const r = await exitOpenPosition(
                exitPos,
                `${reason} (mcap ${mcap.toFixed(3)} ETH)`,
                sellPct
            );
            // one exit per tick
            if (r?.ok) break;
            break;
        } catch (_) {
            // keep monitoring
        }
    }
}

/**
 * Watch open bags for creator/dev sells — dump immediately when detected.
 * Uses NOXA swap feed + on-chain creator token balance as fallback.
 * Runs faster than the TP/SL monitor so rugs get priority.
 */
async function watchDevSells() {
    if (!IS_SNIPER_HOST) return;
    const cfg = store.snipeConfig || {};
    if (cfg.exitOnDevSell === false) return;
    if (!cfg.autoSell) return;
    // Do NOT gate on global snipeBusy — a TP sell on bag A must not block rug-dump on bag B
    if (!openPositions.size || job.running) return;

    const minEth = Number(cfg.devSellMinEth ?? 0.001);
    // Snapshot entries so we can break after one exit
    for (const [key, pos] of [...openPositions.entries()]) {
        if (job.running) return;
        if (exitingTokens.has(key)) continue;
        const creator = String(pos.creator || "").toLowerCase();
        if (!creator || creator.length < 10) {
            // Try recover creator from pairs cache once
            const t = (pairsCache.tokens || []).find(
                (p) => String(p.address || "").toLowerCase() === key
            );
            if (t?.creator) {
                pos.creator = String(t.creator).toLowerCase();
                openPositions.set(key, pos);
            } else {
                continue;
            }
        }
        const creatorAddr = String(pos.creator || "").toLowerCase();
        if (!creatorAddr) continue;

        try {
            // 1) Swap feed — confirmed creator sells
            const sinceTs = pos.openedAt
                ? Math.floor(new Date(pos.openedAt).getTime() / 1000) - 5
                : 0;
            const swaps = await chain.fetchRecentSwaps(pos.token, { limit: 40 });
            const hits = chain.detectCreatorSells(swaps, creatorAddr, {
                minEth,
                sinceTs,
            });
            if (hits.length) {
                const h = hits[0];
                const eth = Number(h.ethAmount || 0).toFixed(4);
                pushLog(
                    `🚨 DEV SELL $${pos.symbol}: creator dumped ~${eth} ETH — exiting NOW`,
                    "err"
                );
                await exitOpenPosition(
                    { ...pos },
                    `DEV SELL ~${eth} ETH${h.txHash ? ` · ${String(h.txHash).slice(0, 12)}…` : ""}`,
                    100
                );
                return; // one dump per tick
            }

            // 2) On-chain creator balance drop (catches sells API missed)
            try {
                const { balance } = await chain.getTokenBalanceRaw(
                    creatorAddr,
                    pos.token
                );
                const prev = pos.creatorBalRaw != null ? BigInt(pos.creatorBalRaw) : null;
                pos.creatorBalRaw = balance.toString();
                openPositions.set(key, pos);
                    if (prev != null && balance < prev) {
                        const dropped = prev - balance;
                        // ≥1% of creator's prior bag — ignore dust transfers
                        const meaningful = prev > 0n && dropped * 100n >= prev;
                        if (meaningful) {
                            pushLog(
                                `🚨 DEV DUMP $${pos.symbol}: creator token bal dropped — exiting NOW`,
                                "err"
                            );
                            await exitOpenPosition(
                                { ...pos },
                                "DEV DUMP · creator token balance dropped",
                                100
                            );
                            return;
                        }
                    }
            } catch (_) {}
        } catch (_) {
            // keep watching
        }
    }
}

app.get("/api/pairs", async (req, res) => {
    if (!IS_SNIPER_HOST) {
        return res.json({
            tokens: [],
            updatedAt: 0,
            source: null,
            feedNote: "Pairs/sniper moved to http://localhost:3848 (npm run sniper)",
            freshestAgeSec: null,
            disabled: true,
        });
    }
    try {
        const limit = Number(req.query.limit || 40);
        // Never block the HTTP response on a full poll — serve cache, refresh async
        if (!pairsCache.tokens.length || Date.now() - pairsCache.updatedAt > 2000) {
            setImmediate(() => {
                pollPairs().catch(() => {});
            });
        }
        const tokens = enrichPairsWithCreator(
            (pairsCache.tokens || []).slice(0, limit)
        ).sort((a, b) => {
            const ab = Number(a.createdAtBlock || 0);
            const bb = Number(b.createdAtBlock || 0);
            if (bb !== ab) return bb - ab;
            const aa = a.ageSec != null ? a.ageSec : 1e12;
            const ba = b.ageSec != null ? b.ageSec : 1e12;
            if (aa !== ba) return aa - ba;
            return (
                new Date(b.createdAt || 0).getTime() -
                new Date(a.createdAt || 0).getTime()
            );
        });
        res.json({
            tokens,
            updatedAt: pairsCache.updatedAt,
            source: pairsCache.source || null,
            feedNote: pairsCache.feedNote || null,
            freshestAgeSec: pairsCache.freshestAgeSec ?? null,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/balances/refresh", (req, res) => {
    const result = kickBalanceRefresh();
    res.json({ ok: true, ...result });
});

app.get("/api/creator/:address", async (req, res) => {
    try {
        if (!chain.isEvmAddress(req.params.address)) {
            return res.status(400).json({ error: "Invalid address" });
        }
        const deep = req.query.deep === "1" || req.query.deep === "true";
        const addr = req.params.address.toLowerCase();
        // Prefer live cache for speed; optional deep scan of recent pages
        if (!deep && creatorIndex.has(addr)) {
            const c = creatorIndex.get(addr);
            return res.json({
                creator: addr,
                launchCount: c.launches.length,
                bestAthMcEth: c.bestAth,
                avgAthMcEth: c.avgAth,
                serialLauncher: c.launches.length >= 3,
                launches: c.launches.slice(0, 30),
                source: "cache",
                explorerUrl: `https://robinhoodchain.blockscout.com/address/${addr}`,
            });
        }
        const data = await chain.getCreatorLaunches(req.params.address, {
            maxPages: deep ? 8 : 3,
        });
        // merge into cache
        const existing = creatorIndex.get(addr) || {
            launches: [],
            bestAth: 0,
            avgAth: 0,
        };
        const byAddr = new Map(
            [...existing.launches, ...data.launches].map((l) => [
                l.address.toLowerCase(),
                l,
            ])
        );
        const merged = [...byAddr.values()];
        const aths = merged.map((l) => l.athMarketCapEth || 0);
        creatorIndex.set(addr, {
            launches: merged,
            bestAth: aths.length ? Math.max(...aths) : 0,
            avgAth: aths.length
                ? aths.reduce((s, x) => s + x, 0) / aths.length
                : 0,
            updatedAt: Date.now(),
        });
        res.json({ ...data, source: "scan" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/token/:address/intel", async (req, res) => {
    try {
        if (!chain.isEvmAddress(req.params.address)) {
            return res.status(400).json({ error: "Invalid address" });
        }
        const addr = String(req.params.address).toLowerCase();
        const cachedPair = (pairsCache.tokens || []).find(
            (p) => String(p.address || "").toLowerCase() === addr
        );
        let info = null;
        let fromCache = false;
        try {
            info = await chain.getTokenInfo(req.params.address, { optional: true });
        } catch (_) {
            info = null;
        }
        // Brand-new launches often 404 on NOXA — fall back to pairs board + synthetic meta
        if (!info) {
            fromCache = true;
            const syn = await chain.resolveTokenInfo(req.params.address, {
                optional: true,
                fee: cachedPair?.poolFee,
                pairedToken: cachedPair?.pairedToken,
                symbol: cachedPair?.symbol,
                name: cachedPair?.name,
                marketCapEth: cachedPair?.marketCapEth,
            });
            info = {
                token: {
                    ...(syn?.token || syn || {}),
                    ...(cachedPair || {}),
                    address: req.params.address,
                    creator: cachedPair?.creator || syn?.token?.creator,
                },
                stats: {},
                recentSwaps: [],
            };
        }
        const t = info.token || info;
        const normalized = chain.normalizeListedToken({
            ...(cachedPair || {}),
            ...t,
            address: t.address || req.params.address,
            creator: t.creator || cachedPair?.creator,
        });
        const creator = (normalized.creator || cachedPair?.creator || "").toLowerCase();
        let creatorStats = null;
        if (creator) {
            if (creatorIndex.has(creator)) {
                const c = creatorIndex.get(creator);
                creatorStats = {
                    launchCount: c.launches.length,
                    bestAthMcEth: c.bestAth,
                    avgAthMcEth: c.avgAth,
                    bestAthMcUsdLabel: chain.formatUsd(chain.ethToUsd(c.bestAth)),
                    avgAthMcUsdLabel: chain.formatUsd(chain.ethToUsd(c.avgAth)),
                    serialLauncher: c.launches.length >= 3,
                    launches: c.launches.slice(0, 12),
                    source: "cache",
                };
            } else {
                try {
                    creatorStats = await chain.getCreatorLaunches(creator, {
                        maxPages: 3,
                    });
                } catch (_) {
                    creatorStats = {
                        launchCount: 1,
                        bestAthMcEth: 0,
                        avgAthMcEth: 0,
                        serialLauncher: false,
                        launches: [],
                        source: "none",
                    };
                }
            }
        }
        let recentSwaps = (info.recentSwaps || []).slice(0, 15);
        if (!recentSwaps.length) {
            try {
                recentSwaps = await chain.fetchRecentSwaps(req.params.address, {
                    limit: 15,
                });
            } catch (_) {}
        }
        res.json({
            token: {
                ...normalized,
                source: fromCache ? "pairs-cache" : normalized.source || "api",
            },
            stats: info.stats || {},
            recentSwaps: recentSwaps.map((s) => ({
                txHash: s.txHash || s.hash || null,
                sender: s.sender || s.trader || null,
                recipient: s.recipient || null,
                blockNumber: s.blockNumber || null,
                timestamp: s.timestamp || s.time || null,
                amount0: s.amount0,
                amount1: s.amount1,
                amountEth: s.amountEth ?? s.ethAmount ?? null,
                type: s.type || s.side || null,
            })),
            creator: creatorStats,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/snipe/config", (_req, res) => {
    const s = sniper();
    res.json({
        config: store.snipeConfig,
        snipes: (store.snipes || []).slice(-30).reverse().map(publicSnipe),
        openPositions: [...openPositions.values()],
        sniper: s
            ? {
                  index: store.wallets.indexOf(s),
                  address: s.address,
                  name: s.name,
              }
            : null,
    });
});

app.post("/api/snipe/config", (req, res) => {
    const body = req.body || {};
    const cfg = store.snipeConfig || {};
    for (const k of [
        "enabled",
        "amountEth",
        "takeProfitX",
        "takeProfit2X",
        "stopLossPct",
        "trailPct",
        "partialSellPct",
        "maxAgeSec",
        "maxInitialBuyEth",
        "cooldownMs",
        "sellPercent",
        "autoSell",
        "maxOpenPositions",
        "skipSerialCreators",
        "minEntryMcapEth",
        "maxEntryMcapEth",
        "sellGasReserveEth",
        "exitOnDevSell",
        "devSellMinEth",
        "fastMaxAgeSec",
        "skipRugged",
        "skipNoSocials",
        "skipLowAthSerials",
        "minCreatorAthEth",
        "minPoolSwapsBeforeBuy",
        "qualityMode",
        "requireDevBuy",
        "requireSocials",
        "requireWebsite",
        "skipDuplicateNames",
        "skipRecycledSocials",
        "minNarrativeScore",
        "minQualityScore",
        "minDevBuyEth",
        "maxDevBuyEth",
        "moonbagHoldX",
        "tpLadder",
    ]) {
        if (body[k] !== undefined) cfg[k] = body[k];
    }
    // Always bind to dedicated sniper when present
    const s = sniper();
    cfg.walletIndex = s ? store.wallets.indexOf(s) : null;
    if (cfg.enabled && !s) {
        return res.status(400).json({
            error: "Import a sniper wallet on the Pairs tab before enabling auto-snipe",
        });
    }
    if (cfg.autoSell && !s) {
        return res.status(400).json({
            error: "Import a sniper wallet before enabling auto-sell",
        });
    }
    cfg.enabled = !!cfg.enabled;
    cfg.autoSell = cfg.autoSell !== false;
    cfg.qualityMode = cfg.qualityMode !== false;
    cfg.requireDevBuy = cfg.requireDevBuy !== false;
    cfg.requireSocials = cfg.requireSocials !== false;
    cfg.requireWebsite = !!cfg.requireWebsite;
    cfg.skipDuplicateNames = cfg.skipDuplicateNames !== false;
    cfg.skipRecycledSocials = cfg.skipRecycledSocials !== false;
    cfg.skipSerialCreators = cfg.qualityMode
        ? true
        : !!cfg.skipSerialCreators;
    cfg.exitOnDevSell = cfg.exitOnDevSell !== false;
    cfg.skipNoSocials = cfg.qualityMode ? true : !!cfg.skipNoSocials;
    cfg.skipLowAthSerials = cfg.skipLowAthSerials !== false;
    cfg.amountEth = Number(cfg.amountEth) || 0.005;
    cfg.takeProfitX = Number(cfg.takeProfitX) || 1.6;
    cfg.takeProfit2X = Number(cfg.takeProfit2X) || 3;
    cfg.stopLossPct = Number(cfg.stopLossPct) || 35;
    cfg.trailPct = Number(cfg.trailPct) || 25;
    cfg.partialSellPct = Number(cfg.partialSellPct) || 50;
    cfg.maxAgeSec = Number(cfg.maxAgeSec) || 90;
    cfg.maxOpenPositions = Math.max(
        1,
        Number(cfg.maxOpenPositions) || (cfg.qualityMode ? 8 : 40)
    );
    cfg.minEntryMcapEth = Number(cfg.minEntryMcapEth || 0);
    cfg.maxEntryMcapEth = Number(cfg.maxEntryMcapEth || 0);
    cfg.maxInitialBuyEth = Number(cfg.maxInitialBuyEth || 1);
    cfg.cooldownMs = Number(cfg.cooldownMs || 1500);
    cfg.sellGasReserveEth = Math.max(
        0.00015,
        Number(cfg.sellGasReserveEth != null ? cfg.sellGasReserveEth : 0.0004)
    );
    cfg.devSellMinEth = Math.max(
        0,
        Number(cfg.devSellMinEth != null ? cfg.devSellMinEth : 0.001)
    );
    cfg.fastMaxAgeSec = Math.max(
        3,
        Math.min(30, Number(cfg.fastMaxAgeSec != null ? cfg.fastMaxAgeSec : 12))
    );
    cfg.minCreatorAthEth = Math.max(
        0,
        Number(cfg.minCreatorAthEth != null ? cfg.minCreatorAthEth : 2)
    );
    cfg.minNarrativeScore = Math.max(
        0,
        Number(cfg.minNarrativeScore != null ? cfg.minNarrativeScore : 3)
    );
    cfg.minQualityScore = Math.max(
        1,
        Number(cfg.minQualityScore != null ? cfg.minQualityScore : 6)
    );
    cfg.minDevBuyEth = Math.max(
        0,
        Number(cfg.minDevBuyEth != null ? cfg.minDevBuyEth : 0.001)
    );
    cfg.maxDevBuyEth = Math.max(
        cfg.minDevBuyEth,
        Number(cfg.maxDevBuyEth != null ? cfg.maxDevBuyEth : 0.35)
    );
    cfg.moonbagHoldX = Math.max(
        2,
        Number(cfg.moonbagHoldX != null ? cfg.moonbagHoldX : 5)
    );
    cfg.skipRugged = cfg.skipRugged !== false;
    cfg.cooldownMs = Math.min(Number(cfg.cooldownMs || 300), 800);
    if (Array.isArray(body.tpLadder) && body.tpLadder.length) {
        cfg.tpLadder = normalizeTpLadder({ tpLadder: body.tpLadder });
    } else if (!Array.isArray(cfg.tpLadder) || !cfg.tpLadder.length) {
        cfg.tpLadder = [
            { x: 1.0, pct: 15 },
            { x: 2.0, pct: 20 },
            { x: 3.0, pct: 25 },
            { x: 5.0, pct: 0 },
        ];
    } else {
        cfg.tpLadder = normalizeTpLadder(cfg);
    }
    store.snipeConfig = cfg;
    saveStore(store);
    const synced = syncOpenPositionsFromStore();
    const ladderLabel = (cfg.tpLadder || [])
        .map((r) => (r.pct > 0 ? `${r.x}x→${r.pct}%` : `${r.x}x hold`))
        .join(" · ");
    pushLog(
        `Snipe cfg · buy ${cfg.enabled ? "ON" : "OFF"} · quality ${cfg.qualityMode ? "ON" : "OFF"} · exits ${cfg.autoSell ? "ON" : "OFF"} · rug-guard ${cfg.exitOnDevSell ? "ON" : "OFF"} · ${cfg.amountEth} ETH · ladder ${ladderLabel || "legacy"} · open ${synced.count}`,
        "info"
    );
    res.json({
        ok: true,
        config: cfg,
        openCount: synced.count,
        sniper: s
            ? { index: store.wallets.indexOf(s), address: s.address, name: s.name }
            : null,
    });
});

app.post("/api/sniper/sell", async (req, res) => {
    if (job.running || snipeBusy) {
        return res.status(409).json({ error: "Busy — wait for current job/snipe" });
    }
    const s = sniper();
    if (!s) {
        return res.status(400).json({ error: "No sniper wallet — import one on the Pairs tab" });
    }
    syncOpenPositionsFromStore();
    const token = (req.body?.token || "").trim();
    const sellAll = !!req.body?.all;
    const targets = [];
    if (sellAll) {
        targets.push(...openPositions.values());
    } else if (token && chain.isEvmAddress(token)) {
        const pos = openPositions.get(token.toLowerCase());
        if (pos) targets.push(pos);
        else {
            // Sell even if not in snipe history (token still on wallet)
            targets.push({
                token,
                symbol: req.body?.symbol || "?",
                walletIndex: store.wallets.indexOf(s),
                costEth: 0,
                snipeIds: [],
                entryMcap: chain.NOXA_STARTING_MC_ETH,
            });
        }
    } else {
        return res.status(400).json({ error: "Pass token or { all: true }" });
    }
    if (!targets.length) {
        return res.status(400).json({ error: "No open holdings to sell" });
    }

    res.json({ ok: true, started: true, count: targets.length });
    job.running = true;
    job.type = "sell";
    job.startedAt = Date.now();
    job.progress = { done: 0, total: targets.length, label: "sniper sell" };
    broadcast({ type: "job_start", job: publicJob() });
    try {
        const out = [];
        for (const pos of targets) {
            if (snipeBusy) await chain.sleep(500);
            const r = await exitOpenPosition(pos, sellAll ? "manual sell all" : "manual sell");
            out.push(r);
            job.progress.done += 1;
            broadcast({ type: "job_progress", job: publicJob() });
        }
        job.result = out;
        pushLog(`Sniper sell done · ${out.filter((x) => x.ok).length}/${out.length} ok`, "ok");
    } catch (e) {
        pushLog(`Sniper sell failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});

app.post("/api/snipe", async (req, res) => {
    if (job.running || snipeBusy) {
        return res.status(409).json({ error: "Busy — wait for current job/snipe" });
    }
    if (!sniper()) {
        return res.status(400).json({
            error: "No sniper wallet — import or create one on the Pairs tab first",
        });
    }
    const token = req.body?.token;
    const amountEth = Number(req.body?.amountEth ?? store.snipeConfig?.amountEth ?? 0.01);
    const walletIndex = store.wallets.indexOf(sniper());
    const takeProfitX = Number(
        req.body?.takeProfitX ?? store.snipeConfig?.takeProfitX ?? 2
    );
    const stopLossPct = Number(
        req.body?.stopLossPct ?? store.snipeConfig?.stopLossPct ?? 40
    );

    // Prefer cached meta
    const meta =
        pairsCache.tokens.find(
            (t) => t.address?.toLowerCase() === String(token || "").toLowerCase()
        ) || null;

    res.json({ ok: true, started: true, sniper: sniper().address });
    const record = await executeSnipe({
        token,
        amountEth,
        walletIndex,
        auto: false,
        takeProfitX,
        stopLossPct,
        meta,
    });
    broadcast({ type: "snipe_done", snipe: record?.ok != null ? publicSnipe(record) : record });
});


app.post("/api/snipe/stop", (req, res) => {
    store.snipeConfig = store.snipeConfig || {};
    store.snipeConfig.enabled = false;
    saveStore(store);
    snipeBusy = false;
    pushLog("🛑 Auto-snipe FORCE STOPPED", "err");
    broadcast({ type: "snipe_config", config: store.snipeConfig });
    res.json({ ok: true, config: store.snipeConfig });
});

/** Recall leftover ETH from sniper → funder (does not sell tokens). */
app.post("/api/sniper/recall", async (req, res) => {
    if (job.running) return res.status(409).json({ error: "Job already running" });
    const f = funder();
    const s = sniper();
    if (!f) return res.status(400).json({ error: "No funder" });
    if (!s) return res.status(400).json({ error: "No sniper wallet" });

    store.snipeConfig = store.snipeConfig || {};
    store.snipeConfig.enabled = false;
    saveStore(store);

    setJob({
        running: true,
        type: "recall",
        logs: [],
        result: null,
        progress: { done: 0, total: 1, label: "recall sniper" },
    });
    pushLog(`Recalling sniper ETH ${s.address} → funder ${f.address}`, "info");
    res.json({ ok: true, job: publicJob(), sniper: s.address, funder: f.address });

    try {
        const results = await chain.recallEth(
            [
                {
                    address: s.address,
                    private_key: s.private_key,
                    name: "Sniper",
                },
            ],
            f.address,
            {
                unwrapWeth: true,
                gasReserveEth: Number(req.body?.gasReserveEth ?? 0.0002),
                onProgress: (ev) => {
                    if (ev.type === "recalled") {
                        pushLog(
                            `✅ sniper → funder ${ev.amountEth} ETH · ${EXPLORER}/tx/${ev.hash}`,
                            "ok"
                        );
                    } else if (ev.type === "skip") {
                        pushLog(`skip sniper: ${ev.reason}`, "info");
                    } else if (ev.type === "error") {
                        pushLog(`❌ sniper recall: ${ev.error}`, "err");
                    }
                },
            }
        );
        job.result = results;
    } catch (e) {
        pushLog(`Sniper recall failed: ${e.message}`, "err");
        job.result = { error: e.message };
    } finally {
        job.running = false;
        broadcast({ type: "job_done", job: publicJob() });
    }
});


function requireTxbotHost(_req, res, next) {
    if (!IS_TXBOT_HOST) {
        return res.status(404).json({
            error: "TX Bot runs on its own host — npm run txbot → http://localhost:3849",
        });
    }
    next();
}

// --- TX Booster (dedicated host only — npm run txbot) ---
app.get("/api/txbot/status", requireTxbotHost, (_req, res) => {
    res.json(txBooster.status());
});

app.post("/api/txbot/configure", requireTxbotHost, (req, res) => {
    try {
        const status = txBooster.configure(req.body || {});
        res.json({ ok: true, status });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/txbot/start", requireTxbotHost, (req, res) => {
    try {
        const result = txBooster.start(req.body || {});
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/txbot/stop", requireTxbotHost, (_req, res) => {
    res.json(txBooster.stop());
});

// --- Volume booster (buy↔sell cycles for DEX volume — separate from TX count padder) ---
app.get("/api/volume/status", requireTxbotHost, (_req, res) => {
    res.json(volumeBooster.status());
});

app.post("/api/volume/configure", requireTxbotHost, (req, res) => {
    try {
        const status = volumeBooster.configure(req.body || {});
        res.json({ ok: true, status });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/volume/start", requireTxbotHost, (req, res) => {
    try {
        const result = volumeBooster.start(req.body || {});
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/volume/stop", requireTxbotHost, (_req, res) => {
    res.json(volumeBooster.stop());
});

// --- Trend booster (multi-wallet makers + volume for DexScreener) ---
app.get("/api/trend/status", requireTxbotHost, (_req, res) => {
    res.json(trendBooster.status());
});

app.post("/api/trend/configure", requireTxbotHost, (req, res) => {
    try {
        const status = trendBooster.configure(req.body || {});
        res.json({ ok: true, status });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/trend/start", requireTxbotHost, (req, res) => {
    try {
        const result = trendBooster.start(req.body || {});
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/trend/stop", requireTxbotHost, (_req, res) => {
    res.json(trendBooster.stop());
});

/** Copy buyer wallets (with keys) from bundler dashboard.json into txbot store as role=trend. */
app.post("/api/trend/import-buyers", requireTxbotHost, (req, res) => {
    try {
        const limit = Math.min(80, Math.max(2, Number(req.body?.limit) || 40));
        const dashPath = path.join(__dirname, "data", "dashboard.json");
        if (!fs.existsSync(dashPath)) {
            return res.status(400).json({ error: "dashboard.json not found on this host" });
        }
        const dash = JSON.parse(fs.readFileSync(dashPath, "utf8"));
        const buyers = (dash.wallets || []).filter((w) => {
            const role = String(w.role || "buyer").toLowerCase();
            if (role !== "buyer") return false;
            const pk = w.private_key || w.privateKey;
            return pk && chain.isEvmPrivateKey(pk) && chain.isEvmAddress(w.address);
        });
        if (!buyers.length) {
            return res.status(400).json({ error: "No buyer wallets with keys in dashboard.json" });
        }
        const existing = new Set(
            (store.wallets || []).map((w) => String(w.address || "").toLowerCase())
        );
        let added = 0;
        for (const b of buyers) {
            if (added >= limit) break;
            const addr = String(b.address).toLowerCase();
            if (existing.has(addr)) {
                // upgrade role to trend if already present as buyer
                const hit = store.wallets.find(
                    (w) => String(w.address || "").toLowerCase() === addr
                );
                if (hit && hit.role === "buyer") hit.role = "trend";
                continue;
            }
            store.wallets.push({
                name: b.name || `Trend ${added + 1}`,
                address: b.address,
                private_key: b.private_key || b.privateKey,
                role: "trend",
                buyAmountEth: 0,
            });
            existing.add(addr);
            added++;
        }
        store.trendBot = {
            ...(store.trendBot || {}),
            token: store.trendBot?.token || store.lastToken || store.volumeBot?.token || "",
        };
        saveStore(store);
        const pool = trendBooster.listTrendWallets();
        res.json({
            ok: true,
            added,
            poolSize: pool.length,
            status: trendBooster.status(),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

/** Fund N trend wallets from funder with equal micro ETH for cycles. */
app.post("/api/trend/fund", requireTxbotHost, async (req, res) => {
    try {
        const perWalletEth = Math.min(
            0.05,
            Math.max(0.002, Number(req.body?.perWalletEth) || 0.008)
        );
        const maxWallets = Math.min(60, Math.max(2, Number(req.body?.maxWallets) || 30));
        const funder = (store.wallets || []).find((w) => w.role === "funder");
        if (!funder?.private_key && !funder?.privateKey) {
            return res.status(400).json({ error: "No funder wallet on TX host" });
        }
        const pool = trendBooster.listTrendWallets().slice(0, maxWallets);
        if (pool.length < 2) {
            return res.status(400).json({ error: "Import trend wallets first" });
        }
        const results = [];
        for (const { wallet: w } of pool) {
            const bal = Number(await chain.getWalletBalance(w.address));
            if (bal >= perWalletEth * 0.85) {
                results.push({ address: w.address, skipped: true, bal });
                continue;
            }
            const need = Math.max(0, perWalletEth - bal);
            if (need < 0.001) {
                results.push({ address: w.address, skipped: true, bal });
                continue;
            }
            const tx = await chain.transferEth(
                { private_key: funder.private_key || funder.privateKey, address: funder.address },
                w.address,
                need
            );
            results.push({
                address: w.address,
                name: w.name,
                eth: need,
                hash: tx.hash || null,
                error: tx.error || null,
            });
            await chain.sleep(400);
        }
        res.json({ ok: true, perWalletEth, funded: results.filter((r) => r.hash).length, results });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- Chart market-maker (inventory sell high / buy dips) ---
app.get("/api/mm/status", requireTxbotHost, (_req, res) => {
    res.json(mmBooster.status());
});

/** Live funder + MM wallet ETH/token balances for the Chart MM panel. */
app.get("/api/mm/overview", requireTxbotHost, async (req, res) => {
    try {
        const token =
            String(req.query.token || store.mmBot?.token || store.lastToken || "").trim() ||
            "0x8E0821112f5b63a5939eAeeBaF251eB7958081b6";
        const wantTokens = String(req.query.tokens || "1") !== "0";
        const all = store.wallets || [];
        const funder = all.find((w) => String(w.role || "").toLowerCase() === "funder");
        const txbot = all.find((w) => String(w.role || "").toLowerCase() === "txbot");
        const mmList = all
            .map((w, index) => ({ w, index }))
            .filter(({ w }) => {
                const role = String(w.role || "").toLowerCase();
                return role === "mm" || role === "trend" || role === "buyer";
            });

        const withTimeout = (p, ms, fallback) =>
            Promise.race([
                p,
                new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
            ]);

        async function ethOf(addr, fallback, ms = 2000) {
            if (!addr) return fallback ?? null;
            try {
                const n = Number(
                    await withTimeout(chain.getWalletBalance(addr), ms, null)
                );
                return Number.isFinite(n) ? n : fallback ?? null;
            } catch (_) {
                return fallback ?? null;
            }
        }

        // Prefer cache so the page loads instantly; short live probe for funder only.
        const funderCached =
            funder?.lastBalance != null ? Number(funder.lastBalance) : null;
        const funderKey = String(funder?.address || "").toLowerCase();
        const funderFromMem = balanceCache.has(funderKey)
            ? Number(balanceCache.get(funderKey).bal)
            : null;
        const funderEth =
            funderFromMem != null
                ? funderFromMem
                : funder?.address
                  ? await ethOf(funder.address, funderCached, 2500)
                  : null;
        const txbotEth =
            txbot?.lastBalance != null ? Number(txbot.lastBalance) : null;

        let decimals = 18;
        let priceUsd = null;
        if (wantTokens && chain.isEvmAddress(token)) {
            try {
                const info = await withTimeout(chain.getTokenInfo(token), 6000, null);
                if (info?.token?.decimals != null) decimals = Number(info.token.decimals);
            } catch (_) {}
            try {
                const { readTokenPriceUsd } = require("./mm-booster");
                const info = await withTimeout(readTokenPriceUsd(token), 6000, null);
                priceUsd = info?.priceUsd ?? null;
            } catch (_) {}
        }

        const rows = [];
        let totalEth = 0;
        let totalTok = 0;
        const concurrency = wantTokens ? 12 : 40;

        for (let i = 0; i < mmList.length; i += concurrency) {
            const chunk = mmList.slice(i, i + concurrency);
            const part = await Promise.all(
                chunk.map(async ({ w, index }) => {
                    const cached =
                        w.lastBalance != null ? Number(w.lastBalance) : null;
                    const key = String(w.address || "").toLowerCase();
                    const fromCache = balanceCache.has(key)
                        ? balanceCache.get(key).bal
                        : null;
                    const eth =
                        fromCache != null
                            ? Number(fromCache)
                            : cached;

                    let tok = null;
                    let tokRaw = "0";
                    if (wantTokens && chain.isEvmAddress(token) && w.address) {
                        try {
                            const raw = await withTimeout(
                                chain.getTokenBalanceRaw(w.address, token, {
                                    decimals,
                                }),
                                10000,
                                null
                            );
                            if (raw && raw.balance != null) {
                                const bal = raw.balance || 0n;
                                tok = Number(
                                    ethers.formatUnits(bal, raw.decimals ?? decimals)
                                );
                                tokRaw = bal.toString();
                            }
                        } catch (_) {}
                    }
                    return {
                        index,
                        name: w.name || `Wallet ${index}`,
                        address: w.address,
                        role: w.role || "mm",
                        eth,
                        token: tok,
                        tokenRaw: tokRaw,
                    };
                })
            );
            for (const r of part) {
                if (r.eth != null) totalEth += r.eth;
                if (r.token != null) totalTok += r.token;
                rows.push(r);
            }
        }
        rows.sort((a, b) => (b.token || 0) - (a.token || 0) || (b.eth || 0) - (a.eth || 0));

        const tokWorthUsd = priceUsd != null ? totalTok * priceUsd : null;
        const fmtTok = (n) => {
            if (n == null || !Number.isFinite(n)) return "—";
            if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
            if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
            if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
            return n.toFixed(0);
        };

        res.json({
            ok: true,
            token,
            priceUsd,
            funder: funder
                ? {
                      address: funder.address,
                      name: funder.name || "Funder",
                      eth: funderEth,
                      ethLabel:
                          funderEth != null ? `${funderEth.toFixed(5)} ETH` : "—",
                  }
                : null,
            txbot: txbot
                ? {
                      address: txbot.address,
                      name: txbot.name || "TX Bot",
                      eth: txbotEth,
                      ethLabel:
                          txbotEth != null ? `${txbotEth.toFixed(5)} ETH` : "—",
                  }
                : null,
            summary: {
                walletCount: rows.length,
                totalEth,
                totalEthLabel: `${totalEth.toFixed(5)} ETH`,
                totalToken: totalTok,
                totalTokenLabel: fmtTok(totalTok),
                tokWorthUsd,
                tokWorthUsdLabel:
                    tokWorthUsd != null
                        ? `$${Math.round(tokWorthUsd).toLocaleString()}`
                        : "—",
                tokensLoaded: wantTokens,
            },
            wallets: rows,
            status: mmBooster.status(),
            at: Date.now(),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/mm/configure", requireTxbotHost, (req, res) => {
    try {
        const status = mmBooster.configure(req.body || {});
        res.json({ ok: true, status });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/mm/start", requireTxbotHost, async (req, res) => {
    try {
        const result = await mmBooster.start(req.body || {});
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/mm/stop", requireTxbotHost, (_req, res) => {
    res.json(mmBooster.stop());
});

app.post("/api/mm/import-buyers", requireTxbotHost, (req, res) => {
    try {
        const limit = Math.min(80, Math.max(2, Number(req.body?.limit) || 78));
        const dashPath = path.join(__dirname, "data", "dashboard.json");
        if (!fs.existsSync(dashPath)) {
            return res.status(400).json({ error: "dashboard.json not found on this host" });
        }
        const dash = JSON.parse(fs.readFileSync(dashPath, "utf8"));
        const buyers = (dash.wallets || []).filter((w) => {
            const role = String(w.role || "buyer").toLowerCase();
            if (role !== "buyer") return false;
            const pk = w.private_key || w.privateKey;
            return pk && chain.isEvmPrivateKey(pk) && chain.isEvmAddress(w.address);
        });
        if (!buyers.length) {
            return res.status(400).json({ error: "No buyer wallets with keys in dashboard.json" });
        }
        const existing = new Set(
            (store.wallets || []).map((w) => String(w.address || "").toLowerCase())
        );
        let added = 0;
        let updated = 0;
        for (const b of buyers) {
            if (added + updated >= limit && !existing.has(String(b.address).toLowerCase())) {
                continue;
            }
            const addr = String(b.address).toLowerCase();
            if (existing.has(addr)) {
                const hit = store.wallets.find(
                    (w) => String(w.address || "").toLowerCase() === addr
                );
                if (hit) {
                    hit.role = "mm";
                    if (!hit.private_key && !hit.privateKey) {
                        hit.private_key = b.private_key || b.privateKey;
                    }
                    updated++;
                }
                continue;
            }
            if (added >= limit) continue;
            store.wallets.push({
                name: b.name || `MM ${added + 1}`,
                address: b.address,
                private_key: b.private_key || b.privateKey,
                role: "mm",
                buyAmountEth: Number(b.buyAmountEth || 0) || 0,
            });
            existing.add(addr);
            added++;
        }
        store.mmBot = {
            ...(store.mmBot || {}),
            token:
                store.mmBot?.token ||
                store.lastToken ||
                "0x8E0821112f5b63a5939eAeeBaF251eB7958081b6",
        };
        saveStore(store);
        const pool = mmBooster.listMmWallets();
        res.json({
            ok: true,
            added,
            updated,
            poolSize: pool.length,
            status: mmBooster.status(),
            opsPrep: mmBooster.status().opsPrep,
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

let mmFundBusy = false;

app.post("/api/mm/fund", requireTxbotHost, async (req, res) => {
    if (mmFundBusy) {
        return res.status(409).json({ error: "Funding already in progress — watch the log" });
    }
    mmFundBusy = true;
    const withTimeout = (p, ms, label) =>
        Promise.race([
            p,
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error(`timeout ${ms}ms · ${label}`)), ms)
            ),
        ]);
    try {
        const perWalletEth = Math.min(
            0.05,
            Math.max(0.002, Number(req.body?.perWalletEth) || 0.01)
        );
        const maxWallets = Math.min(60, Math.max(1, Number(req.body?.maxWallets) || 20));
        const leaveEth = Math.max(0.002, Number(req.body?.leaveEth) || 0.01);
        const funder = (store.wallets || []).find((w) => w.role === "funder");
        if (!funder?.private_key && !funder?.privateKey) {
            return res.status(400).json({ error: "No funder wallet on TX host" });
        }
        const pool = mmBooster.listMmWallets().slice(0, maxWallets);
        if (pool.length < 1) {
            return res.status(400).json({ error: "Import MM buyers first" });
        }

        const log = (text, kind = "info") => {
            if (typeof mmBooster.log === "function") mmBooster.log(text, kind);
            else
                broadcast({
                    type: "mm_log",
                    entry: { at: new Date().toISOString(), text, kind },
                });
        };

        // Fast path: use cached balances to decide who needs funds (no 20 slow RPCs)
        const needs = [];
        for (let i = 0; i < pool.length; i++) {
            const { wallet: w } = pool[i];
            const key = String(w.address || "").toLowerCase();
            const cached = balanceCache.has(key)
                ? Number(balanceCache.get(key).bal)
                : w.lastBalance != null
                  ? Number(w.lastBalance)
                  : null;
            const bal = cached != null && Number.isFinite(cached) ? cached : 0;
            if (bal >= perWalletEth * 0.85) continue;
            const need = Math.max(0, perWalletEth - bal);
            if (need < 0.001) continue;
            needs.push({ w, index: i, bal, need, label: w.name || `${w.address.slice(0, 6)}…` });
        }

        let funderBal = Number(
            await withTimeout(chain.getWalletBalance(funder.address), 8000, "funder bal")
        );
        const funderStart = funderBal;
        log(
            `💸 FUND FAST · ${needs.length} need top-up (of ${pool.length}) × up to ${perWalletEth} ETH · funder ${funderBal.toFixed(5)} ETH`,
            "ok"
        );
        if (!needs.length) {
            log(`💸 FUND done · everyone already funded`, "ok");
            return res.json({
                ok: true,
                funded: 0,
                fundedEth: 0,
                skipped: pool.length,
                errors: 0,
                funderBalBefore: funderStart,
                funderBalAfter: funderBal,
                results: [],
                status: mmBooster.status(),
            });
        }

        // One nonce stream — fire sends without waiting for confirmations
        let nonce = await chain.provider.getTransactionCount(funder.address, "pending");
        const results = [];
        let funded = 0;
        let fundedEth = 0;
        let skipped = pool.length - needs.length;
        let errors = 0;

        for (let i = 0; i < needs.length; i++) {
            const { w, bal, need, label } = needs[i];
            if (funderBal - need < leaveEth) {
                log(
                    `🛑 funder low · ${funderBal.toFixed(5)} left · stop (funded ${funded}/${needs.length})`,
                    "warn"
                );
                break;
            }
            try {
                const tx = await withTimeout(
                    chain.transferEth(
                        {
                            private_key: funder.private_key || funder.privateKey,
                            address: funder.address,
                        },
                        w.address,
                        need,
                        nonce
                    ),
                    20000,
                    `send ${label}`
                );
                nonce += 1;
                if (tx?.hash) {
                    funded++;
                    fundedEth += need;
                    funderBal -= need;
                    // optimistic cache so UI updates immediately
                    try {
                        const key = String(w.address).toLowerCase();
                        balanceCache.set(key, {
                            bal: bal + need,
                            at: Date.now(),
                        });
                        w.lastBalance = bal + need;
                    } catch (_) {}
                    results.push({
                        address: w.address,
                        name: w.name,
                        eth: need,
                        balBefore: bal,
                        hash: tx.hash,
                        nonce: nonce - 1,
                    });
                    log(
                        `✅ ${i + 1}/${needs.length} ${label} +${need.toFixed(5)} ETH · ${String(tx.hash).slice(0, 14)}…`,
                        "ok"
                    );
                } else {
                    errors++;
                    log(`❌ ${label}: no hash`, "err");
                }
            } catch (e) {
                errors++;
                const msg = e.message || String(e);
                results.push({ address: w.address, name: w.name, eth: need, error: msg });
                log(`❌ ${label}: ${msg.slice(0, 140)}`, "err");
                // refresh nonce after failure
                try {
                    nonce = await chain.provider.getTransactionCount(
                        funder.address,
                        "pending"
                    );
                } catch (_) {
                    nonce += 1;
                }
            }
            await chain.sleep(120);
        }

        let funderAfter = funderBal;
        try {
            funderAfter = Number(
                await withTimeout(chain.getWalletBalance(funder.address), 5000, "funder after")
            );
            const fk = String(funder.address).toLowerCase();
            balanceCache.set(fk, { bal: funderAfter, at: Date.now() });
            funder.lastBalance = funderAfter;
        } catch (_) {}
        try {
            saveStore(store);
        } catch (_) {}

        log(
            `💸 FUND done · broadcast ${funded} txs · ${fundedEth.toFixed(5)} ETH · skip ${skipped} · err ${errors} · funder ~${funderAfter.toFixed(5)} (confirms in background)`,
            "ok"
        );
        broadcast({
            type: "mm_fund_done",
            funded,
            fundedEth,
            skipped,
            errors,
            funderStart,
            funderAfter,
            status: mmBooster.status(),
        });
        kickBalanceRefresh();
        res.json({
            ok: true,
            perWalletEth,
            maxWallets,
            leaveEth,
            funded,
            fundedEth,
            skipped,
            errors,
            funderBalBefore: funderStart,
            funderBalAfter: funderAfter,
            results,
            status: mmBooster.status(),
        });
    } catch (e) {
        try {
            mmBooster.log(`❌ FUND error: ${e.message}`, "err");
        } catch (_) {}
        res.status(400).json({ error: e.message });
    } finally {
        mmFundBusy = false;
    }
});

app.post("/api/txbot/wallet/create", requireTxbotHost, (req, res) => {
    try {
        // Only one active txbot — demote prior txbots to buyer, never touch funder/sniper
        for (const x of store.wallets) {
            if (x.role === "txbot") {
                if (/^funder$/i.test(x.name || "")) x.role = "funder";
                else if (/^sniper$/i.test(x.name || "")) x.role = "sniper";
                else x.role = "buyer";
            }
        }
        const w = chain.generateWallet();
        const pk = w.privateKey || w.private_key;
        if (!pk || !chain.isEvmPrivateKey(pk)) {
            return res.status(500).json({ error: "Failed to generate private key" });
        }
        const entry = {
            name: req.body?.name || "TX Bot",
            address: w.address,
            private_key: pk.startsWith("0x") ? pk : `0x${pk}`,
            role: "txbot",
            buyAmountEth: 0,
        };
        store.wallets.push(entry);
        const index = store.wallets.length - 1;
        store.txBot = { ...(store.txBot || {}), walletIndex: index };
        saveStore(store);
        txBooster.configure({ walletIndex: index });
        kickBalanceRefresh();
        res.json({
            ok: true,
            index,
            address: entry.address,
            status: txBooster.status(),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/txbot/wallet/import", requireTxbotHost, (req, res) => {
    try {
        const pk = String(req.body?.privateKey || req.body?.private_key || "").trim();
        if (!chain.isEvmPrivateKey(pk)) {
            return res.status(400).json({ error: "Invalid private key" });
        }
        for (const x of store.wallets) {
            if (x.role === "txbot") {
                if (/^funder$/i.test(x.name || "")) x.role = "funder";
                else if (/^sniper$/i.test(x.name || "")) x.role = "sniper";
                else x.role = "buyer";
            }
        }
        const w = chain.generateWallet(pk);
        const normalizedPk = (w.privateKey || w.private_key || pk);
        const pkOut = String(normalizedPk).startsWith("0x")
            ? String(normalizedPk)
            : `0x${normalizedPk}`;
        const existing = store.wallets.findIndex(
            (x) => String(x.address).toLowerCase() === String(w.address).toLowerCase()
        );
        let index;
        if (existing >= 0) {
            store.wallets[existing].role = "txbot";
            store.wallets[existing].name = req.body?.name || store.wallets[existing].name || "TX Bot";
            store.wallets[existing].private_key = pkOut;
            index = existing;
        } else {
            store.wallets.push({
                name: req.body?.name || "TX Bot",
                address: w.address,
                private_key: pkOut,
                role: "txbot",
                buyAmountEth: 0,
            });
            index = store.wallets.length - 1;
        }
        store.txBot = { ...(store.txBot || {}), walletIndex: index };
        saveStore(store);
        txBooster.configure({ walletIndex: index });
        kickBalanceRefresh();
        res.json({
            ok: true,
            index,
            address: store.wallets[index].address,
            status: txBooster.status(),
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/txbot/fund", requireTxbotHost, async (req, res) => {
    try {
        const f = funder();
        if (!f) {
            return res.status(400).json({
                error: "No funder in txbot store — import funder PK on this host, or send ETH to the TX bot address manually",
            });
        }
        const status = txBooster.status();
        const idx = status.walletIndex;
        const w = store.wallets[idx];
        if (!w || w.role !== "txbot") {
            return res.status(400).json({ error: "Create/import TX bot wallet first" });
        }
        const amountEth = String(req.body?.amountEth || "0.002");
        const amount = Number(amountEth);
        if (!(amount > 0) || amount > 0.2) {
            return res.status(400).json({ error: "Fund 0 < amount ≤ 0.2 ETH" });
        }
        if (job.running) return res.status(409).json({ error: "Job already running" });

        setJob({
            running: true,
            type: "txbot_fund",
            logs: [],
            result: null,
            progress: { done: 0, total: 1, label: "funding txbot" },
        });
        pushLog(`Funding TX bot ${w.address.slice(0, 10)}… with ${amountEth} ETH`, "info");
        res.json({ ok: true, job: publicJob() });

        try {
            const tx = await chain.transferEth(
                { private_key: f.private_key },
                w.address,
                ethers.parseEther(amountEth)
            );
            await chain.waitTx(tx);
            const explorerBase = "https://robinhoodchain.blockscout.com/tx/";
            pushLog(`✅ funded · ${explorerBase}${tx.hash}`, "ok");
            job.result = { hash: tx.hash };
            kickBalanceRefresh();
        } catch (e) {
            pushLog(`Fund failed: ${e.message}`, "err");
            job.result = { error: e.message };
        } finally {
            job.running = false;
            broadcast({ type: "job_done", job: publicJob() });
        }
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post("/api/txbot/funder/import", requireTxbotHost, (req, res) => {
    try {
        const pk = String(req.body?.privateKey || req.body?.private_key || "").trim();
        if (!chain.isEvmPrivateKey(pk)) {
            return res.status(400).json({ error: "Invalid private key" });
        }
        const w = chain.generateWallet(pk);
        const pkOut = String(w.privateKey || w.private_key || pk).startsWith("0x")
            ? String(w.privateKey || w.private_key || pk)
            : `0x${w.privateKey || w.private_key || pk}`;
        for (const x of store.wallets) {
            if (x.role === "funder") x.role = "buyer";
        }
        const existing = store.wallets.findIndex(
            (x) => String(x.address).toLowerCase() === String(w.address).toLowerCase()
        );
        if (existing >= 0) {
            store.wallets[existing].role = "funder";
            store.wallets[existing].name = "Funder";
            store.wallets[existing].private_key = pkOut;
        } else {
            store.wallets.unshift({
                name: "Funder",
                address: w.address,
                private_key: pkOut,
                role: "funder",
                buyAmountEth: 0,
            });
        }
        // Fix txbot walletIndex after unshift
        const ti = store.wallets.findIndex((x) => x.role === "txbot");
        if (ti >= 0) {
            store.txBot = { ...(store.txBot || {}), walletIndex: ti };
            txBooster.configure({ walletIndex: ti });
        }
        saveStore(store);
        kickBalanceRefresh();
        res.json({ ok: true, address: w.address });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});


app.listen(PORT, () => {
    const label = IS_SNIPER_HOST
        ? "SNIPER"
        : IS_TXBOT_HOST
          ? "TXBOT"
          : "BUNDLER";
    console.log(
        `NOXA ${label} → http://localhost:${PORT} · store ${path.basename(STORE_FILE)}`
    );
    // Bundler never auto-snipes. Sniper host PRESERVES enabled/autoSell across restarts.
    if (store.snipeConfig && (IS_BUNDLER_HOST || IS_TXBOT_HOST)) {
        store.snipeConfig.enabled = false;
        store.snipeConfig.autoSell = false;
        saveStore(store);
    }

    if (IS_TXBOT_HOST) {
        console.log(
            "TX Bot mode · bundler :3847 · sniper :3848 · TX pad + Volume buy↔sell"
        );
        kickBalanceRefresh();
        return;
    }

    if (IS_BUNDLER_HOST) {
        console.log(
            "Bundler mode · sniper `npm run sniper` :3848 · txbot `npm run txbot` :3849"
        );
        // Free the RPC for wallet balances — no pairs poll / exit monitor here
        kickBalanceRefresh();
        return;
    }

    // --- Sniper host only below ---
    kickBalanceRefresh();
    const cfg = store.snipeConfig || {};
    let migrated = false;
    if (Number(cfg.maxOpenPositions || 0) <= 5) {
        cfg.maxOpenPositions = 40;
        migrated = true;
    }
    if (Number(cfg.maxAgeSec || 0) <= 8) {
        cfg.maxAgeSec = 30;
        migrated = true;
    }
    // Profitable defaults — always ensure auto-exits ON and tighter risk
    {
        const before = JSON.stringify(cfg);
        if (cfg.autoSell !== true) cfg.autoSell = true;
        if (Number(cfg.amountEth || 0) > 0.01) cfg.amountEth = 0.003;
        if (Number(cfg.takeProfitX || 0) > 2.2) cfg.takeProfitX = 1.5;
        if (!cfg.takeProfitX) cfg.takeProfitX = 1.5;
        if (!cfg.takeProfit2X) cfg.takeProfit2X = 2.5;
        if (cfg.partialSellPct == null) cfg.partialSellPct = 60;
        if (Number(cfg.stopLossPct || 0) > 30) cfg.stopLossPct = 25;
        if (!cfg.stopLossPct) cfg.stopLossPct = 25;
        if (Number(cfg.trailPct || 0) > 22) cfg.trailPct = 18;
        if (!cfg.trailPct) cfg.trailPct = 18;
        if (Number(cfg.maxOpenPositions || 0) > 20) cfg.maxOpenPositions = 12;
        if (Number(cfg.maxOpenPositions || 0) <= 0) cfg.maxOpenPositions = 12;
        if (Number(cfg.maxInitialBuyEth || 0) > 0.5) cfg.maxInitialBuyEth = 0.35;
        // First-block sniping: don't buy tokens older than ~8s (was 12 — still too late)
        if (cfg.fastMaxAgeSec == null || Number(cfg.fastMaxAgeSec) > 8) {
            cfg.fastMaxAgeSec = 8;
        }
        // Keep maxAgeSec as UI ceiling; fast path uses min(maxAge, fastMaxAge)
        if (Number(cfg.maxAgeSec || 0) < 12) cfg.maxAgeSec = 30;
        cfg.cooldownMs = Math.min(Number(cfg.cooldownMs || 1500), 300);
        // Skip serials by default — spray was bleeding on chronic rugs
        if (cfg.skipSerialCreators == null) cfg.skipSerialCreators = true;
        if (cfg.skipRugged == null) cfg.skipRugged = true;
        if (cfg.exitOnDevSell == null) cfg.exitOnDevSell = true;
        if (cfg.sellGasReserveEth == null) cfg.sellGasReserveEth = 0.0004;
        if (cfg.skipLowAthSerials == null) cfg.skipLowAthSerials = true;
        if (cfg.minCreatorAthEth == null) cfg.minCreatorAthEth = 2;
        if (cfg.skipNoSocials == null) cfg.skipNoSocials = true;
        // Buy as soon as pool is tradable (create swap = 1). Waiting for 2+ made us late.
        if (cfg.minPoolSwapsBeforeBuy == null || Number(cfg.minPoolSwapsBeforeBuy) > 1) {
            cfg.minPoolSwapsBeforeBuy = 1;
        }
        // Quality hunt defaults — parse all, buy few
        if (cfg.qualityMode == null) cfg.qualityMode = true;
        if (cfg.requireDevBuy == null) cfg.requireDevBuy = true;
        if (cfg.requireSocials == null) cfg.requireSocials = true;
        if (cfg.skipDuplicateNames == null) cfg.skipDuplicateNames = true;
        if (cfg.skipRecycledSocials == null) cfg.skipRecycledSocials = true;
        if (cfg.minNarrativeScore == null) cfg.minNarrativeScore = 3;
        if (cfg.minQualityScore == null) cfg.minQualityScore = 6;
        if (cfg.minDevBuyEth == null) cfg.minDevBuyEth = 0.001;
        if (cfg.maxDevBuyEth == null) cfg.maxDevBuyEth = 0.35;
        if (cfg.moonbagHoldX == null) cfg.moonbagHoldX = 5;
        if (!Array.isArray(cfg.tpLadder) || !cfg.tpLadder.length) {
            cfg.tpLadder = [
                { x: 1.0, pct: 15 },
                { x: 2.0, pct: 20 },
                { x: 3.0, pct: 25 },
                { x: 5.0, pct: 0 },
            ];
        }
        if (cfg.qualityMode) {
            cfg.skipSerialCreators = true;
            cfg.skipNoSocials = true;
            if (Number(cfg.maxOpenPositions || 0) > 12) cfg.maxOpenPositions = 8;
        }
        if (JSON.stringify(cfg) !== before) migrated = true;
    }
    if (migrated) {
        store.snipeConfig = cfg;
        saveStore(store);
    }
    Promise.resolve()
        .then(() => repairFakeSoldSnipes())
        .then((repaired) => {
            const synced = syncOpenPositionsFromStore();
            console.log(
                `Snipe exit monitor · auto-sell ${store.snipeConfig?.autoSell ? "ON" : "OFF"} · ${synced.count} open bag(s) · repaired ${repaired} · sniper ${sniper()?.address || "none"}`
            );
        })
        .catch((e) =>
            console.log("Snipe repair failed:", e.message || e)
        );
    chain
        .listNewestTokens({ limit: 60, lookbackBlocks: 1200 })
        .then((listed) => {
            const tokens = listed.tokens || [];
            ingestCreators(tokens);
            const enriched = enrichPairsWithCreator(tokens).sort((a, b) => {
                const ab = Number(a.createdAtBlock || 0);
                const bb = Number(b.createdAtBlock || 0);
                if (bb !== ab) return bb - ab;
                return (
                    new Date(b.createdAt || 0).getTime() -
                    new Date(a.createdAt || 0).getTime()
                );
            });
            pairsCache.tokens = enriched;
            pairsCache.updatedAt = Date.now();
            pairsCache.source = listed.source;
            pairsCache.feedNote = listed.feedNote;
            pairsCache.freshestAgeSec = listed.freshestAgeSec;
            for (const t of tokens) pairsCache.seen.add((t.address || "").toLowerCase());
            console.log(
                `Pairs feed seeded · ${tokens.length} tokens · source ${listed.source} · freshest ${listed.freshestAgeSec != null ? listed.freshestAgeSec + "s" : "?"} · ${creatorIndex.size} creators`
            );
            broadcast({
                type: "pairs",
                tokens: enriched.slice(0, 60),
                updatedAt: pairsCache.updatedAt,
                source: pairsCache.source,
                feedNote: pairsCache.feedNote,
                freshestAgeSec: pairsCache.freshestAgeSec,
            });
        })
        .catch((e) => console.log("Pairs seed failed:", e.message));
    // Board refresh (logos / enrich) — not the primary snipe trigger
    setInterval(pollPairs, 2500);
    setInterval(monitorPositions, 2500);
    // Rug guard — faster than TP/SL so creator dumps get priority
    setInterval(() => {
        watchDevSells().catch(() => {});
    }, 800);
    // PRIMARY sniper path: scan factory logs every ~400ms (near block-time)
    setInterval(() => {
        scanNewLaunches().catch(() => {});
    }, 400);
    // Also react on new blocks when the provider emits them
    try {
        chain.provider.on("block", (bn) => {
            if (typeof bn === "number" && bn > lastLaunchBlock - 2) {
                scanNewLaunches().catch(() => {});
            }
        });
        console.log("Sniper block listener ON");
    } catch (e) {
        console.warn("Sniper block listener unavailable:", e.message || e);
    }
    console.log(
        `Sniper FAST · block-scan 400ms · exitOnDevSell ${store.snipeConfig?.exitOnDevSell !== false ? "ON" : "OFF"} · sell-gas ${store.snipeConfig?.sellGasReserveEth ?? 0.0004} · fastMaxAge ${store.snipeConfig?.fastMaxAgeSec ?? 12}s`
    );
});
