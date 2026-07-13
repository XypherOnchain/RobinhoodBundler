/**
 * Betty-lite — background agents adapted for our Express + JSON store.
 * Inspired by stealth-bundler Betty (balance-sync / launch-readiness / post-launch / watchdog)
 * without requiring SQLite or Next.js.
 *
 *   BETTY_LITE=1 node betty-lite.js
 *   # or via pm2 ecosystem
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { ethers } = require("ethers");

const PORT = Number(process.env.BETTY_STATUS_PORT || 3850);
const BUNDLER_URL = process.env.BUNDLER_URL || "http://127.0.0.1:3847";
const DATA_FILE = path.join(__dirname, "data", "dashboard.json");
const RPC =
    process.env.ROBINHOOD_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(RPC, 4663);

const state = {
    startedAt: new Date().toISOString(),
    lastTick: null,
    agents: {},
    alerts: [],
};

function log(agent, msg) {
    const line = `[betty:${agent}] ${msg}`;
    console.log(line);
    state.agents[agent] = {
        ...(state.agents[agent] || {}),
        lastMsg: msg,
        at: new Date().toISOString(),
    };
}

function alert(kind, msg) {
    state.alerts.unshift({ kind, msg, at: new Date().toISOString() });
    state.alerts = state.alerts.slice(0, 50);
    console.warn(`[betty:alert] ${kind}: ${msg}`);
}

function readStore() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

async function fetchJson(urlPath) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, BUNDLER_URL);
        const req = http.get(url, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body || "{}") });
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("error", reject);
        req.setTimeout(8000, () => {
            req.destroy();
            reject(new Error("timeout"));
        });
    });
}

/** balance-sync: sample funder + active buyers */
async function agentBalanceSync() {
    const store = readStore();
    if (!store?.wallets?.length) {
        log("balance-sync", "no wallets");
        return;
    }
    const sample = store.wallets
        .filter((w) => w.role === "funder" || w.role === "dev" || w.role === "buyer")
        .slice(0, 12);
    let ok = 0;
    for (const w of sample) {
        if (!w.address) continue;
        try {
            const bal = await provider.getBalance(w.address);
            w._bettyBal = Number(ethers.formatEther(bal));
            ok++;
        } catch (_) {}
    }
    const funder = store.wallets.find((w) => w.role === "funder");
    log(
        "balance-sync",
        `checked ${ok}/${sample.length}` +
            (funder?._bettyBal != null ? ` · funder ${funder._bettyBal.toFixed(4)} ETH` : "")
    );
}

/** launch-readiness: gates before go-live */
async function agentLaunchReadiness() {
    const store = readStore();
    if (!store) {
        log("launch-readiness", "store missing");
        return;
    }
    const funder = (store.wallets || []).find((w) => w.role === "funder");
    const dev = (store.wallets || []).find((w) => w.role === "dev");
    const buyers = (store.wallets || []).filter(
        (w) => w.role === "buyer" && Number(w.buyAmountEth) > 0
    );
    const issues = [];
    if (!funder?.address) issues.push("no funder");
    if (!dev?.address) issues.push("no creator");
    if (!buyers.length) issues.push("no planned buyers");
    if (!store.lastPlan) issues.push("no buy plan");
    if (issues.length) {
        log("launch-readiness", `NOT READY: ${issues.join(", ")}`);
    } else {
        log(
            "launch-readiness",
            `READY · ${buyers.length} buyers · pad ${store.launchpad || "noxa"}`
        );
    }
}

/** post-launch: watch lastToken presence + basic RPC ping */
async function agentPostLaunch() {
    const store = readStore();
    const token = store?.lastToken;
    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) {
        log("post-launch", "no live token");
        return;
    }
    try {
        const code = await provider.getCode(token);
        if (!code || code === "0x") {
            alert("post-launch", `Token ${token.slice(0, 10)}… has no code`);
        } else {
            log("post-launch", `watching ${token.slice(0, 10)}… ok`);
        }
    } catch (e) {
        alert("post-launch", e.message);
    }
}

/** watchdog: bundler HTTP health */
async function agentWatchdog() {
    try {
        const r = await fetchJson("/api/launchpad");
        if (r.status === 401) {
            log("watchdog", "bundler up (auth required)");
            return;
        }
        if (r.status >= 200 && r.status < 500) {
            log("watchdog", `bundler HTTP ${r.status} · pad ${r.data?.launchpad || "?"}`);
        } else {
            alert("watchdog", `bundler HTTP ${r.status}`);
        }
    } catch (e) {
        alert("watchdog", `bundler unreachable: ${e.message}`);
    }
}

async function tick() {
    state.lastTick = new Date().toISOString();
    await agentWatchdog().catch((e) => alert("watchdog", e.message));
    await agentBalanceSync().catch((e) => alert("balance-sync", e.message));
    await agentLaunchReadiness().catch((e) =>
        alert("launch-readiness", e.message)
    );
    await agentPostLaunch().catch((e) => alert("post-launch", e.message));
}

const INTERVAL = Number(process.env.BETTY_INTERVAL_MS || 30000);

const server = http.createServer((req, res) => {
    if (req.url === "/api/betty/status" || req.url === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...state }, null, 2));
        return;
    }
    res.writeHead(404);
    res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[betty-lite] status on 127.0.0.1:${PORT} · interval ${INTERVAL}ms`);
});

tick();
setInterval(tick, INTERVAL);
