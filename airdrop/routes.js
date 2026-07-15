/**
 * Simple airdrop + holders API for the bundler dashboard.
 */
const { ethers } = require("ethers");
const holders = require("../collectors/evm-holders");
const airdrop = require("./engine");

function ourAddresses(dashStore) {
  return (dashStore?.wallets || [])
    .map((w) => String(w.address || "").toLowerCase())
    .filter(Boolean);
}

function resolveSenderWallet(dash, senderAddress) {
  const addr = String(senderAddress || "").toLowerCase();
  const wallets = dash?.wallets || [];
  const w =
    (addr &&
      wallets.find((x) => String(x.address || "").toLowerCase() === addr)) ||
    wallets.find((x) => x.role === "funder") ||
    wallets.find((x) => x.role === "dev") ||
    null;
  const pk = w?.private_key || w?.privateKey;
  if (!pk) return null;
  return { walletMeta: w, privateKey: pk };
}

function mountAirdropRoutes(app, { chain, getDashStore } = {}) {
  const provider = chain.provider;

  app.post("/api/holders/scan", async (req, res) => {
    try {
      const token = req.body?.token;
      if (!chain.isEvmAddress(token || "")) {
        return res.status(400).json({ error: "Paste a valid token address (0x…)" });
      }
      const fromExplorer = await holders
        .importHoldersFromBlockscout(token, {
          pages: Number(req.body?.pages || 6),
          pageSize: 50,
        })
        .catch((e) => ({ error: e.message, holderCount: 0 }));
      if (typeof chain.fetchRecentSwaps === "function") {
        const swaps = await chain.fetchRecentSwaps(token, { limit: 150 });
        holders.mergeActivity(token, swaps);
      }
      const result = await holders.scan(provider, token, {
        weth: chain.WETH,
        force: req.body?.force !== false,
        lookback: req.body?.lookback || holders.MAX_SCAN,
      });
      res.json({ ok: true, ...result, blockscout: fromExplorer });
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
        limit: Math.min(500, Number(req.query.limit || 200)),
        ourSet: ourAddresses(dash),
      });
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/airdrop/preview", async (req, res) => {
    try {
      const body = req.body || {};
      const sourceToken = body.sourceToken || body.competitor || body.token;
      const airdropToken =
        body.airdropToken || body.sendToken || body.myToken || body.token;
      if (!chain.isEvmAddress(sourceToken || "")) {
        return res
          .status(400)
          .json({ error: "Paste a competitor coin address (source CA)" });
      }
      if (!chain.isEvmAddress(airdropToken || "")) {
        return res
          .status(400)
          .json({ error: "Paste YOUR token address to airdrop" });
      }

      const dash = getDashStore ? getDashStore() : null;
      const ours = ourAddresses(dash);
      const diagnostics = {
        swapsFetched: 0,
        holdersFound: 0,
        activityWallets: 0,
        hints: [],
      };

      // Fast: Blockscout top holders (works even when on-chain lookback is empty)
      try {
        const bs = await holders.importHoldersFromBlockscout(sourceToken, {
          pages: 6,
          pageSize: 50,
        });
        diagnostics.blockscout = bs.holderCount || 0;
        diagnostics.hints.push(`Blockscout holders: ${bs.holderCount || 0}`);
      } catch (e) {
        diagnostics.hints.push("blockscout: " + e.message);
      }

      // Scan competitor: Transfer holders + recent swap activity
      if (typeof chain.fetchRecentSwaps === "function") {
        const swaps = await chain.fetchRecentSwaps(sourceToken, { limit: 150 });
        diagnostics.swapsFetched = swaps.length;
        holders.mergeActivity(sourceToken, swaps);
      }
      if (body.scan !== false) {
        await holders
          .scan(provider, sourceToken, {
            weth: chain.WETH,
            force: true,
            lookback: holders.MAX_SCAN,
          })
          .catch((e) => diagnostics.hints.push("scan: " + e.message));
      }
      try {
        const eoa = await holders.filterEoaHolders(provider, sourceToken);
        diagnostics.eoaKept = eoa.kept;
        diagnostics.contractsDropped = eoa.dropped;
        if (eoa.dropped)
          diagnostics.hints.push(`Dropped ${eoa.dropped} contracts (LP/router)`);
      } catch (e) {
        diagnostics.hints.push("eoa filter: " + e.message);
      }
      const st = holders.load(sourceToken);
      diagnostics.holdersFound = Object.keys(st.holders || {}).length;
      diagnostics.activityWallets = Object.keys(st.activity || {}).length;

      let senderAddress =
        body.senderAddress ||
        (dash?.wallets || []).find((w) => w.role === "funder")?.address ||
        (dash?.wallets || []).find((w) => w.role === "dev")?.address ||
        null;

      const limit = Math.min(
        500,
        Math.max(1, Number(body.limit || body.max || 200))
      );

      const prev = await airdrop.preview(provider, {
        sourceToken,
        airdropToken,
        senderAddress,
        mode: body.mode || "fixed",
        amountEach: body.amountEach || "100",
        totalAmount: body.totalAmount || "10000",
        exclude: [...ours, ...(Array.isArray(body.exclude) ? body.exclude : [])],
        minVolEth: Number(body.minVolEth || 0),
        minBuys: Number(body.minBuys != null ? body.minBuys : 0),
        limit,
        includeTop: body.includeTop !== false,
        includeActive: body.includeActive !== false,
      });

      if (!prev.count) {
        diagnostics.hints.push(
          "No wallets found yet — try a busier competitor CA, or wait for the holder scan to finish."
        );
      }

      res.json({
        ok: true,
        ...prev,
        // Explicit: full list, not a sample
        recipients: prev.recipients,
        diagnostics,
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
          error: "Run Preview first, then Start",
        });
      }
      const dash = getDashStore ? getDashStore() : { wallets: [] };
      const senderAddr =
        body.senderAddress || body.preview.senderAddress || null;
      const resolved = resolveSenderWallet(dash, senderAddr);
      if (!resolved) {
        return res.status(400).json({
          error:
            "Need a funder/dev wallet with private key on this account to send the airdrop",
        });
      }
      const wallet = new ethers.Wallet(resolved.privateKey, provider);
      const result = await airdrop.startJob(provider, wallet, body.preview, {
        armedLive: body.armedLive === true,
        concurrency: body.concurrency,
        delayMs: body.delayMs,
      });
      res.json({
        ok: true,
        ...result,
        hint: result.simulate
          ? "Simulation only — check Confirm live, then Start again"
          : `LIVE airdrop started · ${body.preview.count} wallets`,
      });
    } catch (e) {
      res.status(500).json({ error: e.shortMessage || e.message });
    }
  });

  app.get("/api/airdrop/jobs", (_req, res) => {
    res.json({ ok: true, jobs: airdrop.listJobs() });
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
}

module.exports = { mountAirdropRoutes };
