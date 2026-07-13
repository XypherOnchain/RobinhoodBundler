/**
 * Holders + Airdrop + Exit radar + CRM routes
 */
const { ethers } = require("ethers");
const holders = require("../collectors/evm-holders");
const airdrop = require("./engine");
const arm = require("../lib/evm-arm");
const walletCrypto = require("../lib/wallet-crypto");

function ourAddresses(dashStore) {
    return (dashStore?.wallets || [])
        .map((w) => String(w.address || "").toLowerCase())
        .filter(Boolean);
}

function resolveSenderWallet(dash, senderAddress) {
    const addr = String(senderAddress || "").toLowerCase();
    const wallets = dash?.wallets || [];
    let w =
        (addr &&
            wallets.find(
                (x) => String(x.address || "").toLowerCase() === addr
            )) ||
        wallets.find((x) => x.role === "funder") ||
        null;
    if (!w?.private_key) return null;
    const pk = walletCrypto.decrypt(w.private_key);
    return { walletMeta: w, privateKey: pk };
}

function mountAirdropRoutes(app, { chain, getDashStore } = {}) {
    const provider = chain.provider;

    // ── Holders ──────────────────────────────────────────────
    app.post("/api/holders/enroll", async (req, res) => {
        try {
            const token = req.body?.token;
            if (!chain.isEvmAddress(token || "")) {
                return res.status(400).json({ error: "valid token required" });
            }
            holders.enroll(token);
            holders
                .scan(provider, token, { weth: chain.WETH })
                .catch((e) => console.warn("[holders] scan", e.message));
            if (typeof chain.fetchRecentSwaps === "function") {
                chain
                    .fetchRecentSwaps(token, { limit: 100 })
                    .then((swaps) => holders.mergeActivity(token, swaps))
                    .catch(() => {});
            }
            res.json({ ok: true, enrolled: ethers.getAddress(token) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post("/api/holders/scan", async (req, res) => {
        try {
            const token = req.body?.token;
            if (!chain.isEvmAddress(token || "")) {
                return res.status(400).json({ error: "valid token required" });
            }
            if (typeof chain.fetchRecentSwaps === "function") {
                const swaps = await chain.fetchRecentSwaps(token, {
                    limit: 120,
                });
                holders.mergeActivity(token, swaps);
            }
            const result = await holders.scan(provider, token, {
                weth: chain.WETH,
            });
            res.json({ ok: true, ...result });
        } catch (e) {
            res.status(500).json({ error: e.shortMessage || e.message });
        }
    });

    app.get("/api/holders/:token", (req, res) => {
        try {
            const token = req.params.token;
            if (!chain.isEvmAddress(token || "")) {
                return res.status(400).json({ error: "invalid token" });
            }
            const dash = getDashStore ? getDashStore() : null;
            const data = holders.listHolders(token, {
                limit: Number(req.query.limit || 100),
                ourSet: ourAddresses(dash),
            });
            res.json({ ok: true, ...data });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Airdrop ──────────────────────────────────────────────
    app.post("/api/airdrop/preview", async (req, res) => {
        try {
            const body = req.body || {};
            const sourceToken = body.sourceToken || body.token;
            if (!chain.isEvmAddress(sourceToken || "")) {
                return res.status(400).json({ error: "sourceToken required" });
            }
            const airdropToken =
                body.airdropToken || body.sendToken || body.token || sourceToken;
            if (!chain.isEvmAddress(airdropToken)) {
                return res.status(400).json({ error: "airdropToken invalid" });
            }

            if (typeof chain.fetchRecentSwaps === "function") {
                const swaps = await chain.fetchRecentSwaps(sourceToken, {
                    limit: 150,
                });
                holders.mergeActivity(sourceToken, swaps);
            }
            if (body.scan !== false) {
                await holders
                    .scan(provider, sourceToken, { weth: chain.WETH })
                    .catch(() => {});
            }

            const dash = getDashStore ? getDashStore() : null;
            const exclude = [
                ...ourAddresses(dash),
                ...(Array.isArray(body.exclude) ? body.exclude : []),
            ];
            let senderAddress = body.senderAddress || null;
            if (!senderAddress && dash) {
                const funder = (dash.wallets || []).find(
                    (w) => w.role === "funder"
                );
                senderAddress = funder?.address || null;
            }

            const maxRecipients = Math.min(
                500,
                Math.max(
                    1,
                    Number(
                        body.limit ||
                            process.env.AIRDROP_MAX_RECIPIENTS ||
                            50
                    )
                )
            );

            const prev = await airdrop.preview(provider, {
                sourceToken,
                airdropToken,
                token: airdropToken,
                senderAddress,
                mode: body.mode || "fixed",
                amountEach: body.amountEach || "1",
                totalAmount: body.totalAmount || "100",
                exclude,
                minVolEth: Number(body.minVolEth || 0),
                minBuys: Number(body.minBuys || 1),
                limit: maxRecipients,
                maxDumpRatio: Number(body.maxDumpRatio || 2),
                crmOnly: Array.isArray(body.crmOnly) ? body.crmOnly : null,
            });

            res.json({
                ok: true,
                ...prev,
                sample: (prev.recipients || []).slice(0, 8),
            });
        } catch (e) {
            res.status(500).json({ error: e.shortMessage || e.message });
        }
    });

    app.post("/api/airdrop/start", async (req, res) => {
        try {
            const body = req.body || {};
            if (!body.preview || !Array.isArray(body.preview.recipients)) {
                return res.status(400).json({
                    error: "pass preview object from /api/airdrop/preview",
                });
            }
            const dash = getDashStore ? getDashStore() : { wallets: [] };
            const senderAddr =
                body.senderAddress || body.preview.senderAddress || null;
            const resolved = resolveSenderWallet(dash, senderAddr);
            if (!resolved) {
                return res.status(400).json({
                    error: "sender wallet with private key not found (funder or senderAddress)",
                });
            }
            const wallet = new ethers.Wallet(resolved.privateKey, provider);
            const result = await airdrop.startJob(
                provider,
                wallet,
                body.preview,
                {
                    armedLive: body.armedLive === true,
                    concurrency: body.concurrency,
                    delayMs: body.delayMs,
                }
            );
            res.json({
                ok: true,
                ...result,
                hint: result.simulate
                    ? "Dry-run — set EVM_ARM_LIVE=true and armedLive for real transfers"
                    : "LIVE airdrop running",
            });
        } catch (e) {
            res.status(500).json({ error: e.shortMessage || e.message });
        }
    });

    app.get("/api/airdrop/jobs", (_req, res) => {
        res.json({ ok: true, jobs: airdrop.listJobs(), crm: airdrop.getCrm() });
    });

    app.get("/api/airdrop/jobs/:id", (req, res) => {
        const j = airdrop.getJob(req.params.id);
        if (!j) return res.status(404).json({ error: "not found" });
        res.json({ ok: true, job: j });
    });

    app.post("/api/airdrop/stop", (req, res) => {
        const j = airdrop.stopJob(req.body?.id);
        res.json({ ok: true, job: j });
    });

    app.post("/api/crm/tag", (req, res) => {
        const { address, tag } = req.body || {};
        if (!address || !tag) {
            return res
                .status(400)
                .json({ error: "address and tag required" });
        }
        const row = airdrop.tagCrm(address, tag, req.body.meta || {});
        res.json({ ok: true, row });
    });

    app.get("/api/crm", (_req, res) => {
        res.json({ ok: true, crm: airdrop.getCrm() });
    });

    // ── Exit liquidity radar ─────────────────────────────────
    app.get("/api/exit-radar/:token", async (req, res) => {
        try {
            const token = req.params.token;
            if (!chain.isEvmAddress(token || "")) {
                return res.status(400).json({ error: "invalid token" });
            }
            const minEth = Number(req.query.minEth || 0.02);
            const windowSec = Number(req.query.windowSec || 180);
            const dash = getDashStore ? getDashStore() : null;
            const own = new Set(ourAddresses(dash));
            const swaps = await chain.fetchRecentSwaps(token, { limit: 80 });
            const now = Math.floor(Date.now() / 1000);
            const cutoff = now - windowSec;
            const foreignBuys = (swaps || []).filter((s) => {
                if (s.side !== "buy") return false;
                if (!(s.ethAmount >= minEth)) return false;
                if (s.timestamp && s.timestamp < cutoff) return false;
                if (s.trader && own.has(String(s.trader).toLowerCase()))
                    return false;
                return true;
            });
            const flowEth = foreignBuys.reduce(
                (a, s) => a + Number(s.ethAmount || 0),
                0
            );
            const hot = flowEth >= minEth;
            res.json({
                ok: true,
                hot,
                flowEth,
                minEth,
                windowSec,
                buys: foreignBuys.slice(0, 20),
                message: hot
                    ? `EXIT LIQUIDITY: ${flowEth.toFixed(4)} ETH organic buys in ${windowSec}s`
                    : `Quiet — ${flowEth.toFixed(4)} ETH foreign buys in window`,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post("/api/exit-radar/peel", async (req, res) => {
        try {
            const token = req.body?.token;
            const percent = Math.min(
                100,
                Math.max(1, Number(req.body?.percent || 25))
            );
            if (!chain.isEvmAddress(token || "")) {
                return res.status(400).json({ error: "token required" });
            }
            res.json({
                ok: true,
                suggest: {
                    endpoint: "/api/sell",
                    body: {
                        token,
                        percent,
                        mode: "sequential",
                        delayMs: Number(req.body?.delayMs || 1500),
                        usePlan: true,
                    },
                },
                hint: "POST /api/sell with this body, or use Trade Stagger Exit",
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

module.exports = { mountAirdropRoutes };
