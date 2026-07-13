/**
 * Express routes for Betty automation + price guards.
 * Mounted from server.js when bundler host.
 */
const bettyStore = require("./store");
const { PATTERNS, buildServerWaypoints } = require("./patterns");
const arm = require("../lib/evm-arm");

function mountBettyRoutes(app, { chain } = {}) {
    app.get("/api/betty/patterns", (_req, res) => {
        res.json({ ok: true, patterns: PATTERNS });
    });

    app.get("/api/automation", (req, res) => {
        const store = bettyStore.load();
        let jobs = store.automationJobs || [];
        const mint = req.query.mint || req.query.token;
        if (mint) {
            const m = String(mint).toLowerCase();
            jobs = jobs.filter((j) => String(j.mint || "").toLowerCase() === m);
        }
        res.json({
            ok: true,
            jobs,
            events: (store.automationEvents || []).slice(0, 50),
            evmArmLive: arm.evmArmLive(),
        });
    });

    app.post("/api/automation", (req, res) => {
        const body = req.body || {};
        let jobType = String(body.jobType || body.job_type || "").toLowerCase();
        if (jobType === "volume_bot" || jobType === "volume_mirror") {
            return res.status(400).json({
                error: "volume bots are excluded from this build",
            });
        }
        if (jobType === "comment_bot") {
            return res.status(400).json({ error: "comment_bot not supported on EVM" });
        }
        if (!["chart_pattern", "bump_bot"].includes(jobType)) {
            return res.status(400).json({
                error: "jobType must be chart_pattern or bump_bot",
            });
        }
        const mint = body.mint || body.token;
        if (!mint || (chain && !chain.isEvmAddress(mint))) {
            return res.status(400).json({ error: "valid mint/token required" });
        }

        let config = body.config || {};
        if (jobType === "chart_pattern" && body.patternId) {
            const built = buildServerWaypoints({
                patternId: body.patternId,
                durationMin: body.durationMin || config.durationMin || 30,
                ethPerTrade: body.ethPerTrade || config.ethPerTrade || 0.005,
            });
            config = {
                ...config,
                patternId: built.pattern.id,
                waypoints: config.waypoints?.length
                    ? config.waypoints
                    : built.waypoints,
                loop: !!config.loop,
                rotation: config.rotation || body.rotation || "sequential",
            };
        }
        if (
            jobType === "chart_pattern" &&
            (!Array.isArray(config.waypoints) || !config.waypoints.length)
        ) {
            return res.status(400).json({ error: "chart_pattern needs waypoints or patternId" });
        }

        const id = bettyStore.nanoid();
        const armedLive = body.armedLive === true || body.armed_live === 1 || body.armedLive === 1
            ? 1
            : 0;

        const job = {
            id,
            jobType,
            mint,
            chain: "robinhood",
            status: "running",
            armedLive,
            config,
            progress: {
                step: 0,
                buys: 0,
                sells: 0,
                nextAt: Date.now(),
                lastAction: "queued",
                fails: 0,
            },
            error: null,
            createdAt: new Date().toISOString(),
        };

        bettyStore.mutate((s) => {
            // Stop other running chart jobs on same mint (one pattern at a time)
            for (const j of s.automationJobs || []) {
                if (
                    j.status === "running" &&
                    String(j.mint).toLowerCase() === String(mint).toLowerCase() &&
                    j.jobType === jobType
                ) {
                    j.status = "stopped";
                    j.error = "replaced by newer job";
                }
            }
            s.automationJobs = s.automationJobs || [];
            s.automationJobs.unshift(job);
            s.automationJobs = s.automationJobs.slice(0, 100);
            bettyStore.pushEvent(
                s,
                id,
                "created",
                {
                    jobType,
                    armedLive,
                    waypoints: config.waypoints?.length || 0,
                    simulate: !arm.automationLive(job),
                },
                null,
                !arm.automationLive(job)
            );
            return s;
        });

        res.json({
            id,
            ok: true,
            job,
            simulated: !arm.automationLive(job),
            hint: arm.evmArmLive()
                ? armedLive
                    ? "LIVE — real trades will fire"
                    : "Dry-run until you set armedLive=1 (chart) and EVM_ARM_LIVE"
                : "Dry-run: set EVM_ARM_LIVE=true for real trades",
        });
    });

    app.patch("/api/automation/:id", (req, res) => {
        const id = req.params.id;
        const body = req.body || {};
        let found = null;
        bettyStore.mutate((s) => {
            const j = (s.automationJobs || []).find((x) => x.id === id);
            if (!j) return s;
            found = j;
            if (body.status) j.status = String(body.status);
            if (body.armedLive != null || body.armed_live != null) {
                j.armedLive =
                    body.armedLive === true ||
                    body.armedLive === 1 ||
                    body.armed_live === 1
                        ? 1
                        : 0;
            }
            if (body.config && typeof body.config === "object") {
                j.config = { ...j.config, ...body.config };
            }
            return s;
        });
        if (!found) return res.status(404).json({ error: "job not found" });
        res.json({ ok: true, job: found });
    });

    app.delete("/api/automation/:id", (req, res) => {
        bettyStore.mutate((s) => {
            const j = (s.automationJobs || []).find((x) => x.id === req.params.id);
            if (j) {
                j.status = "stopped";
                j.error = "stopped by user";
            }
            return s;
        });
        res.json({ ok: true });
    });

    // Price guards
    app.get("/api/price-guards", (req, res) => {
        const store = bettyStore.load();
        let guards = store.priceGuards || [];
        const token = req.query.token;
        if (token) {
            const t = String(token).toLowerCase();
            guards = guards.filter(
                (g) => String(g.token || "").toLowerCase() === t
            );
        }
        res.json({ ok: true, guards, tape: store.tape || {} });
    });

    app.post("/api/price-guards", (req, res) => {
        const body = req.body || {};
        const token = body.token;
        if (!token || (chain && !chain.isEvmAddress(token))) {
            return res.status(400).json({ error: "valid token required" });
        }
        const id = bettyStore.nanoid();
        const guard = {
            id,
            token,
            enabled: body.enabled !== false,
            stopLossUsd:
                body.stopLossUsd != null ? Number(body.stopLossUsd) : null,
            takeProfitUsd:
                body.takeProfitUsd != null ? Number(body.takeProfitUsd) : null,
            mcapTriggerUsd:
                body.mcapTriggerUsd != null ? Number(body.mcapTriggerUsd) : null,
            sellPct: Math.min(100, Math.max(1, Number(body.sellPct || 100))),
            createdAt: new Date().toISOString(),
        };
        if (
            guard.stopLossUsd == null &&
            guard.takeProfitUsd == null &&
            guard.mcapTriggerUsd == null
        ) {
            return res.status(400).json({
                error: "set at least one of stopLossUsd, takeProfitUsd, mcapTriggerUsd",
            });
        }
        bettyStore.mutate((s) => {
            // Disable prior guards on same token
            for (const g of s.priceGuards || []) {
                if (
                    String(g.token).toLowerCase() === String(token).toLowerCase() &&
                    g.enabled
                ) {
                    g.enabled = false;
                    g.disarmReason = "replaced";
                }
            }
            s.priceGuards = s.priceGuards || [];
            s.priceGuards.unshift(guard);
            s.priceGuards = s.priceGuards.slice(0, 50);
            return s;
        });
        res.json({
            ok: true,
            guard,
            hint: arm.evmArmLive()
                ? "Guard armed — auto-sell needs EVM_ARM_LIVE (set)"
                : "Guard saved but auto-sell blocked until EVM_ARM_LIVE=true",
        });
    });

    app.delete("/api/price-guards/:id", (req, res) => {
        bettyStore.mutate((s) => {
            const g = (s.priceGuards || []).find((x) => x.id === req.params.id);
            if (g) {
                g.enabled = false;
                g.disarmReason = "deleted";
            }
            return s;
        });
        res.json({ ok: true });
    });
}

module.exports = { mountBettyRoutes };
