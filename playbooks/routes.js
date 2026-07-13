/**
 * Mission Control + Playbooks HTTP routes
 */
const mission = require("../mission/risk");
const playbooks = require("./index");
const airdrop = require("../airdrop/engine");
const holders = require("../collectors/evm-holders");
const arm = require("../lib/evm-arm");
const moneyDesk = require("../money-desk");

function ourAddresses(dash) {
    return (dash?.wallets || [])
        .map((w) => String(w.address || "").toLowerCase())
        .filter(Boolean);
}

function mountMissionRoutes(app, { chain, getDashStore } = {}) {
    app.get("/api/mission", async (req, res) => {
        try {
            const dash = getDashStore ? getDashStore() : null;
            const token =
                req.query.token ||
                dash?.lastToken ||
                null;
            let tape = null;
            let holdersSnap = null;
            let exitRadar = null;
            let money = null;

            if (token && chain.isEvmAddress(token)) {
                try {
                    const live = await chain.resolveLiveMarketCap(token, null, {});
                    tape = {
                        mcapUsd: live?.mcapUsd,
                        priceUsd: live?.priceUsd,
                        symbol: live?.symbol,
                        supply: live?.supply,
                    };
                    if (live?.mcapUsd) {
                        mission.noteMcap(token, live.mcapUsd, {
                            isEntry: !mission.load().entryMcapUsd[
                                String(token).toLowerCase()
                            ],
                        });
                    }
                } catch (_) {}
                holdersSnap = holders.listHolders(token, {
                    limit: 30,
                    ourSet: ourAddresses(dash),
                });
                try {
                    const swaps = await chain.fetchRecentSwaps(token, {
                        limit: 60,
                    });
                    const own = new Set(ourAddresses(dash));
                    const now = Math.floor(Date.now() / 1000);
                    const foreignBuys = (swaps || []).filter(
                        (s) =>
                            s.side === "buy" &&
                            s.ethAmount >= 0.02 &&
                            (!s.timestamp || s.timestamp >= now - 180) &&
                            !(
                                s.trader &&
                                own.has(String(s.trader).toLowerCase())
                            )
                    );
                    const flowEth = foreignBuys.reduce(
                        (a, s) => a + Number(s.ethAmount || 0),
                        0
                    );
                    exitRadar = {
                        hot: flowEth >= 0.02,
                        flowEth,
                        buys: foreignBuys.slice(0, 8),
                    };
                } catch (_) {}
            }

            try {
                if (dash && moneyDesk.ensureMoneyDesk) {
                    const md = moneyDesk.ensureMoneyDesk(dash);
                    money = {
                        killPaused: !!md.killSwitch?.paused,
                        capital: md.capital || null,
                    };
                }
            } catch (_) {}

            const railsCheck = token
                ? mission.checkRails(token, {
                      mcapUsd: tape?.mcapUsd,
                  })
                : null;

            // Sticky realistic P&L from last sell preview if present
            const sellPrev = dash?.lastSellPreview || null;
            const stickyPnl = sellPrev
                ? {
                      worthDumpUsd: sellPrev.totalWorthDumpUsd,
                      profitDumpUsd: sellPrev.totalProfitDumpUsd,
                      costUsd: sellPrev.totalCostUsd,
                      label: "realistic full exit",
                  }
                : null;

            res.json({
                ok: true,
                token: token || null,
                tape,
                holders: holdersSnap
                    ? {
                          usPct: holdersSnap.usPct,
                          themPct: holdersSnap.themPct,
                          holderCount: holdersSnap.holderCount,
                          updatedAt: holdersSnap.updatedAt,
                      }
                    : null,
                exitRadar,
                stickyPnl,
                rails: railsCheck,
                money,
                crmCount: Object.keys(airdrop.getCrm() || {}).length,
                playbooks: playbooks.listRuns().slice(0, 5),
                evmArmLive: arm.evmArmLive(),
                ctas: [
                    { id: "support", label: "Support", tab: "trade" },
                    { id: "peel", label: "Sell into flow", tab: "trade" },
                    { id: "airdrop", label: "Airdrop", tab: "airdrop" },
                    { id: "kill", label: "Kill", tab: "trade" },
                ],
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get("/api/mission/rails", (_req, res) => {
        res.json({ ok: true, ...mission.load() });
    });

    app.post("/api/mission/rails", (req, res) => {
        const rails = mission.setRails(req.body || {});
        res.json({ ok: true, rails });
    });

    app.post("/api/mission/check", (req, res) => {
        const { token, mcapUsd, supportEth } = req.body || {};
        res.json({
            ok: true,
            ...mission.checkRails(token, { mcapUsd, supportEth }),
        });
    });

    // ── Playbooks ────────────────────────────────────────────
    app.get("/api/playbooks", (_req, res) => {
        res.json({
            ok: true,
            templates: playbooks.listTemplates(),
            runs: playbooks.listRuns().slice(0, 20),
        });
    });

    app.post("/api/playbooks/start", (req, res) => {
        try {
            const body = req.body || {};
            if (!body.templateId) {
                return res.status(400).json({ error: "templateId required" });
            }
            const run = playbooks.startRun({
                templateId: body.templateId,
                token: body.token,
                competitorToken: body.competitorToken,
                armedLive: body.armedLive === true,
            });
            res.json({
                ok: true,
                run,
                hint: "Playbook queued — Betty advances steps; airdrop/guard still need ARM LIVE for money paths",
            });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get("/api/playbooks/:id", (req, res) => {
        const run = playbooks.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: "not found" });
        res.json({ ok: true, run });
    });

    app.post("/api/playbooks/stop", (req, res) => {
        const run = playbooks.stopRun(req.body?.id);
        res.json({ ok: true, run });
    });

    // Whale / dump alerts from recent tape
    app.get("/api/alerts/whales/:token", async (req, res) => {
        try {
            const token = req.params.token;
            if (!chain.isEvmAddress(token || "")) {
                return res.status(400).json({ error: "invalid token" });
            }
            const minEth = Number(req.query.minEth || 0.1);
            const dash = getDashStore ? getDashStore() : null;
            const own = new Set(ourAddresses(dash));
            const swaps = await chain.fetchRecentSwaps(token, { limit: 100 });
            const crm = airdrop.getCrm();
            const alerts = [];
            for (const s of swaps || []) {
                const eth = Number(s.ethAmount || 0);
                if (eth < minEth) continue;
                const trader = String(s.trader || "").toLowerCase();
                if (trader && own.has(trader)) continue;
                const tag = crm[trader]?.tag;
                alerts.push({
                    side: s.side,
                    eth,
                    trader,
                    ts: s.timestamp,
                    crmTag: tag || null,
                    kind:
                        s.side === "sell"
                            ? "whale_dump"
                            : eth >= 0.5
                              ? "whale_buy"
                              : "size_buy",
                });
            }
            res.json({ ok: true, alerts: alerts.slice(0, 30) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

module.exports = { mountMissionRoutes };
