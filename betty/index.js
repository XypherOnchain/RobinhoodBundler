/**
 * Betty — full agent supervisor for Express/JSON NOXA bundler.
 * Ported from stealth-bundler Betty (EVM paths only).
 * EXCLUDES: volume_bot, volume_mirror, TX bot, Solana, comment_bot.
 *
 * Includes: chart_pattern, bump_bot, price guards + auto-sell,
 * tape collector, balance-sync, funding/seasoning/launch-readiness, watchdog.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const http = require("http");
const { ethers } = require("ethers");
const bettyStore = require("./store");
const { PATTERNS, buildServerWaypoints } = require("./patterns");
const arm = require("../lib/evm-arm");
const walletCrypto = require("../lib/wallet-crypto");

const ROOT = path.join(__dirname, "..");
const DASHBOARD_FILE = path.join(ROOT, "data", "dashboard.json");
const PORT = Number(process.env.BETTY_STATUS_PORT || 3850);
const chain = require(path.join(ROOT, "blockchain.js"));

const liveArmChecked = new Set(); // latent arm guard per chart job

function readDashboard() {
    try {
        const raw = JSON.parse(fs.readFileSync(DASHBOARD_FILE, "utf8"));
        return walletCrypto.walkDecrypt(raw);
    } catch (e) {
        return null;
    }
}

function buyerWallets(dash) {
    return (dash?.wallets || []).filter((w) => {
        const role = String(w.role || "buyer").toLowerCase();
        if (role !== "buyer") return false;
        if (/^(sniper|tx\s*bot|funder)$/i.test(String(w.name || "").trim())) return false;
        return !!w.private_key && !!w.address;
    });
}

function pickBuyer(buyers, step, rotation) {
    if (!buyers.length) return null;
    const rot = String(rotation || "sequential").toLowerCase();
    if (rot === "random") return buyers[Math.floor(Math.random() * buyers.length)];
    return buyers[step % buyers.length];
}

function setAgent(store, name, msg) {
    store.agentStatus = store.agentStatus || {};
    store.agentStatus[name] = { lastMsg: msg, at: new Date().toISOString() };
    console.log(`[betty:${name}] ${msg}`);
}

// ── Tape collector (price feed for guards) ───────────────────────────
async function collectTape(token) {
    if (!chain.isEvmAddress(token || "")) return null;
    try {
        const live = await chain.resolveLiveMarketCap(token, null, {});
        const priceNative = Number(live?.priceEth || 0);
        const ethUsd = Number(live?.ethUsd || (await chain.getEthUsdPrice()));
        const supply = Number(live?.supply || 0);
        const priceUsd = Number(live?.priceUsd || priceNative * ethUsd);
        const mcapUsd = Number(live?.mcapUsd || priceUsd * supply);
        return {
            token: ethers.getAddress(token),
            priceNative,
            ethUsd,
            priceUsd,
            supply,
            mcapUsd,
            at: new Date().toISOString(),
        };
    } catch (e) {
        return { error: e.message, at: new Date().toISOString() };
    }
}

async function agentTapeCollector() {
    const dash = readDashboard();
    const tokens = new Set();
    if (dash?.lastToken) tokens.add(String(dash.lastToken).toLowerCase());
    const pre = bettyStore.load();
    for (const g of pre.priceGuards || []) {
        if (g.enabled && g.token) tokens.add(String(g.token).toLowerCase());
    }
    for (const j of pre.automationJobs || []) {
        if (j.status === "running" && j.mint) tokens.add(String(j.mint).toLowerCase());
    }
    const snaps = {};
    let n = 0;
    for (const t of tokens) {
        const snap = await collectTape(t);
        if (snap && !snap.error) {
            snaps[t] = snap;
            n++;
        } else if (snap?.error) {
            snaps[t] = { error: snap.error, at: snap.at };
        }
    }
    bettyStore.mutate((s) => {
        s.tape = { ...(s.tape || {}), ...snaps };
        setAgent(s, "tape", `priced ${n}/${tokens.size} tokens`);
        return s;
    });
}

async function agentPostLaunchGuards() {
    const store = bettyStore.load();
    const guards = (store.priceGuards || []).filter((g) => g.enabled);
    if (!guards.length) {
        bettyStore.mutate((s) => {
            setAgent(s, "post-launch", "no armed guards");
            return s;
        });
        return;
    }
    let fired = 0;
    for (const guard of guards) {
        const key = String(guard.token || "").toLowerCase();
        const tape = store.tape?.[key];
        if (!tape || tape.priceUsd == null) continue;
        const priceUsd = Number(tape.priceUsd);
        const mcapUsd = Number(tape.mcapUsd || 0);
        let breach = null;
        if (guard.stopLossUsd != null && priceUsd <= Number(guard.stopLossUsd)) {
            breach = `STOP LOSS $${priceUsd.toFixed(8)} ≤ $${guard.stopLossUsd}`;
        } else if (
            guard.takeProfitUsd != null &&
            priceUsd >= Number(guard.takeProfitUsd)
        ) {
            breach = `TAKE PROFIT $${priceUsd.toFixed(8)} ≥ $${guard.takeProfitUsd}`;
        } else if (
            guard.mcapTriggerUsd != null &&
            mcapUsd > 0 &&
            mcapUsd >= Number(guard.mcapTriggerUsd)
        ) {
            breach = `MCAP $${mcapUsd.toFixed(0)} ≥ $${guard.mcapTriggerUsd}`;
        }
        if (!breach) continue;
        fired++;
        console.log(`[betty:post-launch] ${breach}`);
        await executeGuardSell(guard, breach);
    }
    bettyStore.mutate((s) => {
        setAgent(s, "post-launch", `checked ${guards.length} · fired ${fired}`);
        return s;
    });
}

// ── Price guards + executor sell ─────────────────────────────────────
async function executeGuardSell(guard, reason) {
    if (!arm.evmArmLive()) {
        bettyStore.mutate((s) => {
            bettyStore.pushAlert(s, "guard", `BLOCKED (EVM_ARM_LIVE off): ${reason}`);
            return s;
        });
        return { blocked: true };
    }
    const dash = readDashboard();
    const buyers = buyerWallets(dash);
    const token = guard.token;
    const sellPct = Math.min(100, Math.max(1, Number(guard.sellPct || 100)));
    if (!buyers.length) return { error: "no buyer wallets" };

    const results = [];
    let ok = 0;
    let fail = 0;
    for (const w of buyers) {
        try {
            const raw = await chain.getTokenBalanceRaw(w.address, token);
            if (!raw?.balance || raw.balance === 0n) {
                results.push({ address: w.address, skipped: true });
                continue;
            }
            const batch = await chain.multiSell(
                [
                    {
                        private_key: w.private_key,
                        address: w.address,
                        name: w.name,
                    },
                ],
                token,
                { percent: sellPct, fast: true }
            );
            const r = Array.isArray(batch) ? batch[0] : batch;
            if (r?.error) {
                fail++;
                results.push({ address: w.address, error: r.error });
            } else {
                ok++;
                results.push({
                    address: w.address,
                    hash: r?.hash || r?.txHash,
                });
            }
        } catch (e) {
            fail++;
            results.push({ address: w.address, error: e.message });
        }
    }

    bettyStore.mutate((s) => {
        bettyStore.pushAlert(
            s,
            "auto-sell",
            `${reason} · ${ok} ok / ${fail} fail · ${sellPct}%`
        );
        const shouldDisarm = ok > 0 && (fail === 0 || sellPct < 100);
        if (shouldDisarm) {
            for (const g of s.priceGuards || []) {
                if (
                    String(g.token || "").toLowerCase() ===
                        String(token).toLowerCase() &&
                    g.id === guard.id
                ) {
                    g.enabled = false;
                    g.disarmedAt = new Date().toISOString();
                    g.disarmReason = reason;
                }
            }
        }
        s.actions = s.actions || [];
        s.actions.unshift({
            type: "sell_tokens_evm",
            token,
            sellPct,
            ok,
            fail,
            reason,
            at: new Date().toISOString(),
        });
        s.actions = s.actions.slice(0, 200);
        return s;
    });
    return { ok, fail, results };
}

// ── Chart pattern + bump automation ──────────────────────────────────
async function doBuy(wallet, token, ethAmount, simulate) {
    if (simulate) {
        return { simulated: true, ethAmount };
    }
    const r = await chain.buy(
        { private_key: wallet.private_key, address: wallet.address },
        ethAmount,
        token,
        { reserveSellGas: true, clamp: true }
    );
    return r;
}

async function doSell(wallet, token, sellPct, simulate) {
    if (simulate) {
        return { simulated: true, sellPct };
    }
    const results = await chain.multiSell(
        [
            {
                private_key: wallet.private_key,
                address: wallet.address,
                name: wallet.name,
            },
        ],
        token,
        { percent: sellPct, fast: true }
    );
    const r = Array.isArray(results) ? results[0] : results;
    return r || { error: "sell failed" };
}

async function tickJob(job, dash) {
    const buyers = buyerWallets(dash);
    const simulate = !arm.automationLive(job);
    const cfg = job.config || {};
    const p = job.progress || {
        step: 0,
        buys: 0,
        sells: 0,
        nextAt: 0,
        lastAction: "",
        fails: 0,
    };

    if (job.status !== "running") return;

    // Latent arm: skip first live tick after process start for armed chart jobs
    if (
        !simulate &&
        (job.jobType === "chart_pattern") &&
        Number(job.armedLive) === 1 &&
        !liveArmChecked.has(job.id)
    ) {
        liveArmChecked.add(job.id);
        bettyStore.mutate((s) => {
            bettyStore.pushEvent(
                s,
                job.id,
                "latent_arm",
                { msg: "first live tick skipped for confirmation window" },
                null,
                false
            );
            return s;
        });
        p.nextAt = Date.now() + 5000;
        job.progress = p;
        return;
    }

    if (p.nextAt && Date.now() < p.nextAt) return;

    if (job.jobType === "bump_bot") {
        if (cfg.maxTicks != null && p.step >= Number(cfg.maxTicks)) {
            job.status = "completed";
            job.progress = p;
            return;
        }
        const w = pickBuyer(buyers, p.step, cfg.rotation);
        if (!w) {
            job.status = "failed";
            job.error = "no buyer wallets";
            return;
        }
        const eth = Number(cfg.solPerBump || cfg.ethPerBump || 0.002);
        try {
            const r = await doBuy(w, job.mint, eth, simulate);
            bettyStore.mutate((s) => {
                bettyStore.pushEvent(
                    s,
                    job.id,
                    "buy",
                    { eth, address: w.address, error: r?.error, simulated: simulate },
                    r?.hash || r?.txHash,
                    simulate
                );
                return s;
            });
            if (r?.error) p.fails = (p.fails || 0) + 1;
            else p.buys++;
            p.lastAction = `bump buy ${eth} ETH`;
            p.step++;
            const min = Number(cfg.intervalSec?.min ?? cfg.intervalMin ?? 30);
            const max = Number(cfg.intervalSec?.max ?? cfg.intervalMax ?? 90);
            const delay = min + Math.random() * Math.max(0, max - min);
            p.nextAt = Date.now() + delay * 1000;
            if (cfg.maxFails != null && p.fails >= Number(cfg.maxFails)) {
                job.status = "failed";
                job.error = "maxFails reached";
            }
        } catch (e) {
            p.fails++;
            p.lastAction = e.message;
            p.nextAt = Date.now() + 15000;
        }
        job.progress = p;
        return;
    }

    if (job.jobType === "chart_pattern") {
        const waypoints = Array.isArray(cfg.waypoints) ? cfg.waypoints : [];
        if (!waypoints.length) {
            job.status = "failed";
            job.error = "no waypoints";
            return;
        }
        if (p.step >= waypoints.length) {
            if (cfg.loop) p.step = 0;
            else {
                job.status = "completed";
                bettyStore.mutate((s) => {
                    bettyStore.pushEvent(s, job.id, "complete", { steps: p.step }, null, simulate);
                    return s;
                });
                job.progress = p;
                return;
            }
        }
        const wp = waypoints[p.step];
        const w = pickBuyer(buyers, p.step, cfg.rotation);
        if (!w) {
            job.status = "failed";
            job.error = "no buyer wallets";
            return;
        }
        try {
            if (wp.action === "sell") {
                const pct = Number(wp.sellPct || 25);
                const r = await doSell(w, job.mint, pct, simulate);
                bettyStore.mutate((s) => {
                    bettyStore.pushEvent(
                        s,
                        job.id,
                        "sell",
                        {
                            sellPct: pct,
                            address: w.address,
                            error: r?.error,
                            simulated: simulate,
                        },
                        r?.hash || r?.txHash,
                        simulate
                    );
                    return s;
                });
                if (r?.error) p.fails++;
                else p.sells++;
                p.lastAction = `sell ${pct}%`;
            } else {
                const eth = Number(wp.sol || 0.005);
                const r = await doBuy(w, job.mint, eth, simulate);
                bettyStore.mutate((s) => {
                    bettyStore.pushEvent(
                        s,
                        job.id,
                        "buy",
                        {
                            eth,
                            address: w.address,
                            error: r?.error,
                            simulated: simulate,
                        },
                        r?.hash || r?.txHash,
                        simulate
                    );
                    return s;
                });
                if (r?.error) p.fails++;
                else p.buys++;
                p.lastAction = `buy ${eth} ETH`;
            }
            p.step++;
            p.nextAt = Date.now() + Math.max(1, Number(wp.delaySec || 5)) * 1000;
        } catch (e) {
            p.fails++;
            p.lastAction = e.message;
            p.nextAt = Date.now() + 10000;
        }
        job.progress = p;
    }
}

async function agentAutomation() {
    const dash = readDashboard();
    const snap = bettyStore.load();
    const runningIds = (snap.automationJobs || [])
        .filter((j) => j.status === "running")
        .map((j) => j.id);

    for (const id of runningIds) {
        const fresh = bettyStore.load();
        const job = (fresh.automationJobs || []).find((j) => j.id === id);
        if (!job || job.status !== "running") continue;
        await tickJob(job, dash);
        bettyStore.mutate((s) => {
            const cur = (s.automationJobs || []).find((j) => j.id === id);
            if (!cur) return s;
            cur.status = job.status;
            cur.progress = job.progress;
            cur.error = job.error;
            return s;
        });
    }

    bettyStore.mutate((s) => {
        const n = (s.automationJobs || []).filter((j) => j.status === "running")
            .length;
        setAgent(
            s,
            "automation",
            `${n} running · EVM_ARM_LIVE=${arm.evmArmLive()}`
        );
        return s;
    });
}

async function agentBalanceSync() {
    const dash = readDashboard();
    if (!dash?.wallets?.length) {
        bettyStore.mutate((s) => {
            setAgent(s, "balance-sync", "no wallets");
            return s;
        });
        return;
    }
    const sample = dash.wallets
        .filter((w) =>
            ["funder", "dev", "buyer", "creator"].includes(
                String(w.role || "").toLowerCase()
            )
        )
        .slice(0, 20);
    let ok = 0;
    let funderBal = null;
    for (const w of sample) {
        if (!w.address) continue;
        try {
            const bal = await chain.getWalletBalance(w.address);
            ok++;
            if (String(w.role).toLowerCase() === "funder") funderBal = bal;
        } catch (_) {}
    }
    bettyStore.mutate((s) => {
        setAgent(
            s,
            "balance-sync",
            `checked ${ok}/${sample.length}` +
                (funderBal != null
                    ? ` · funder ${Number(funderBal).toFixed(4)} ETH`
                    : "")
        );
        return s;
    });
}

async function agentLaunchReadiness() {
    const dash = readDashboard();
    const issues = [];
    const funder = (dash?.wallets || []).find((w) => w.role === "funder");
    const dev = (dash?.wallets || []).find(
        (w) => w.role === "dev" || w.role === "creator"
    );
    const buyers = (dash?.wallets || []).filter(
        (w) => w.role === "buyer" && Number(w.buyAmountEth) > 0
    );
    const pad = String(dash?.launchpad || "noxa").toLowerCase();
    if (!funder?.address) issues.push("no funder");
    if (!dev?.address) issues.push("no creator");
    if (!buyers.length) issues.push("no planned buyers");
    if (!dash?.lastPlan) issues.push("no buy plan");
    if (!["noxa", "koa", "apestore", "ape"].includes(pad)) issues.push("unknown pad");
    if (pad === "koa" && !process.env.KOA_FACTORY_ADDRESS_ROBINHOOD) {
        issues.push("KOA factory env missing");
    }
    bettyStore.mutate((s) => {
        if (issues.length) {
            setAgent(
                s,
                "launch-readiness",
                `NOT READY [${pad}]: ${issues.join(", ")}`
            );
        } else {
            setAgent(
                s,
                "launch-readiness",
                `READY · ${pad} · ${buyers.length} buyers · plan ok`
            );
        }
        return s;
    });
}

async function agentFundingMonitor() {
    const dash = readDashboard();
    const funder = (dash?.wallets || []).find((w) => w.role === "funder");
    const buyers = (dash?.wallets || []).filter((w) => w.role === "buyer");
    let low = 0;
    let funded = 0;
    for (const w of buyers.slice(0, 30)) {
        try {
            const bal = Number(await chain.getWalletBalance(w.address));
            if (bal >= 0.001) funded++;
            else if (Number(w.buyAmountEth) > 0) low++;
        } catch (_) {}
    }
    let funderEth = null;
    if (funder?.address) {
        try {
            funderEth = Number(await chain.getWalletBalance(funder.address));
        } catch (_) {}
    }
    bettyStore.mutate((s) => {
        setAgent(
            s,
            "funding-monitor",
            `buyers funded ${funded} · unfunded planned ${low}` +
                (funderEth != null ? ` · funder ${funderEth.toFixed(4)}` : "")
        );
        if (funderEth != null && funderEth < 0.01 && low > 0) {
            bettyStore.pushAlert(s, "funding", "treasury low vs unfunded buyers");
        }
        return s;
    });
}

async function agentSeasoningMonitor() {
    const dash = readDashboard();
    const buyers = (dash?.wallets || []).filter((w) => w.role === "buyer");
    const seasoned = buyers.filter((w) => w.seasoned || w.seasonedAt).length;
    bettyStore.mutate((s) => {
        setAgent(
            s,
            "seasoning-monitor",
            `${seasoned}/${buyers.length} buyers marked seasoned`
        );
        return s;
    });
}

async function agentWatchdog() {
    try {
        const ok = await new Promise((resolve) => {
            const req = http.get("http://127.0.0.1:3847/api/launchpad", (res) => {
                resolve(res.statusCode < 500);
            });
            req.on("error", () => resolve(false));
            req.setTimeout(4000, () => {
                req.destroy();
                resolve(false);
            });
        });
        bettyStore.mutate((s) => {
            if (ok) setAgent(s, "watchdog", "bundler healthy");
            else {
                setAgent(s, "watchdog", "bundler unreachable");
                bettyStore.pushAlert(s, "watchdog", "bundler unreachable");
            }
            return s;
        });
    } catch (e) {
        bettyStore.mutate((s) => {
            setAgent(s, "watchdog", e.message);
            return s;
        });
    }
}

async function tick() {
    await agentWatchdog().catch((e) => console.error("watchdog", e.message));
    await agentTapeCollector().catch((e) => console.error("tape", e.message));
    await agentBalanceSync().catch((e) => console.error("balance", e.message));
    await agentFundingMonitor().catch((e) => console.error("funding", e.message));
    await agentSeasoningMonitor().catch((e) => console.error("season", e.message));
    await agentLaunchReadiness().catch((e) => console.error("ready", e.message));
    await agentPostLaunchGuards().catch((e) => console.error("guards", e.message));
    await agentAutomation().catch((e) => console.error("auto", e.message));
}

// Faster loop for automation (10s) + slower full tick
const AUTO_MS = Number(process.env.BETTY_AUTO_MS || 10000);
const FULL_MS = Number(process.env.BETTY_INTERVAL_MS || 30000);

const server = http.createServer((req, res) => {
    const url = req.url || "/";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/api/betty/status") || url === "/") {
        const store = bettyStore.load();
        res.end(
            JSON.stringify(
                {
                    ok: true,
                    startedAt: process.env.BETTY_STARTED || null,
                    evmArmLive: arm.evmArmLive(),
                    patterns: PATTERNS.map((p) => ({
                        id: p.id,
                        name: p.name,
                        desc: p.desc,
                        direction: p.direction,
                    })),
                    agents: store.agentStatus,
                    jobs: (store.automationJobs || []).slice(0, 20),
                    guards: store.priceGuards || [],
                    alerts: (store.alerts || []).slice(0, 20),
                    events: (store.automationEvents || []).slice(0, 30),
                    tape: store.tape,
                },
                null,
                2
            )
        );
        return;
    }
    if (url.startsWith("/api/betty/patterns")) {
        res.end(JSON.stringify({ ok: true, patterns: PATTERNS }));
        return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
});

process.env.BETTY_STARTED = new Date().toISOString();
server.listen(PORT, "127.0.0.1", () => {
    console.log(
        `[betty] full supervisor on 127.0.0.1:${PORT} · auto ${AUTO_MS}ms · full ${FULL_MS}ms · EVM_ARM_LIVE=${arm.evmArmLive()}`
    );
});

tick();
setInterval(() => {
    agentAutomation().catch((e) => console.error(e.message));
    agentPostLaunchGuards().catch((e) => console.error(e.message));
    agentTapeCollector().catch((e) => console.error(e.message));
}, AUTO_MS);
setInterval(tick, FULL_MS);

module.exports = {
    PATTERNS,
    buildServerWaypoints,
    bettyStore,
    collectTape,
};
