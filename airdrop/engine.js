/**
 * Simple airdrop engine — score top holders + most-active traders, batch ERC-20 sends.
 * No smart-money / arm deps. Preview returns FULL recipient list.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const holders = require("../collectors/evm-holders");
const tenant = require("../lib/tenant-context");

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function jobFile() {
  return path.join(tenant.getDataDir(), "airdrop-jobs.json");
}

function emptyJobs() {
  return { jobs: [], updatedAt: null };
}

function loadJobs() {
  try {
    return { ...emptyJobs(), ...JSON.parse(fs.readFileSync(jobFile(), "utf8")) };
  } catch {
    return emptyJobs();
  }
}

function saveJobs(store) {
  const dir = tenant.getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  store.updatedAt = new Date().toISOString();
  const f = jobFile();
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (_) {}
  fs.renameSync(tmp, f);
}

function allocateAmounts(list, opts = {}) {
  const mode = opts.mode || "fixed";
  const decimals = Number(opts.decimals ?? 18);
  const recipients = list.map((r) => ({ ...r }));

  if (mode === "fixed") {
    const each = ethers.parseUnits(String(opts.amountEach || "1"), decimals);
    return recipients.map((r) => ({
      ...r,
      amountWei: each.toString(),
      amountHuman: String(opts.amountEach || "1"),
    }));
  }

  const total = ethers.parseUnits(String(opts.totalAmount || "100"), decimals);
  if (mode === "split") {
    const n = BigInt(Math.max(1, recipients.length));
    const each = total / n;
    return recipients.map((r) => ({
      ...r,
      amountWei: each.toString(),
      amountHuman: ethers.formatUnits(each, decimals),
    }));
  }

  // tiered
  const n = recipients.length;
  const t1 = Math.max(1, Math.floor(n * 0.2));
  const t2 = Math.max(t1 + 1, Math.floor(n * 0.5));
  const weights = recipients.map((_, i) => (i < t1 ? 3 : i < t2 ? 2 : 1));
  const sumW = weights.reduce((a, b) => a + b, 0);
  return recipients.map((r, i) => {
    const amt = (total * BigInt(weights[i])) / BigInt(sumW);
    return {
      ...r,
      amountWei: amt.toString(),
      amountHuman: ethers.formatUnits(amt, decimals),
    };
  });
}

/**
 * Build ranked list: top holders by balance + most-active by buys/vol.
 */
function buildList(sourceToken, opts = {}) {
  const exclude = new Set(
    (opts.exclude || []).map((a) => String(a).toLowerCase()).filter(Boolean)
  );
  const limit = Math.min(500, Math.max(1, Number(opts.limit || 200)));
  const wantTop = opts.includeTop !== false;
  const wantActive = opts.includeActive !== false;
  const minBuys = Number(opts.minBuys ?? 0);
  const minVolEth = Number(opts.minVolEth ?? 0);

  const state = holders.load(sourceToken);
  const supply = BigInt(state.totalSupply || "0");
  const byAddr = new Map();

  if (wantTop) {
    const ranked = Object.entries(state.holders || {})
      .map(([address, bal]) => {
        const balance = BigInt(bal || "0");
        const pct =
          supply > 0n ? Number((balance * 10000n) / supply) / 100 : 0;
        return { address, balance: bal, pct };
      })
      .filter((r) => !exclude.has(r.address) && BigInt(r.balance || "0") > 0n)
      .sort((a, b) =>
        BigInt(a.balance) === BigInt(b.balance)
          ? 0
          : BigInt(a.balance) > BigInt(b.balance)
            ? -1
            : 1
      );
    for (const r of ranked) {
      byAddr.set(r.address, {
        address: r.address,
        balance: r.balance,
        pct: r.pct,
        holding: true,
        buys: 0,
        sells: 0,
        volEth: 0,
        lastTs: 0,
        score: 10 + r.pct * 2,
        reasons: ["top-holder"],
      });
    }
  }

  if (wantActive) {
    const scored = holders.scoreAirdropTargets(sourceToken, {
      exclude: [...exclude],
      minVolEth,
      minBuys,
      limit: Math.max(limit * 2, 100),
    });
    for (const r of scored) {
      if (exclude.has(r.address)) continue;
      const prev = byAddr.get(r.address);
      if (prev) {
        prev.buys = r.buys;
        prev.sells = r.sells;
        prev.volEth = r.volEth;
        prev.lastTs = r.lastTs;
        prev.score = (prev.score || 0) + r.score;
        if (!prev.reasons.includes("active")) prev.reasons.push("active");
        byAddr.set(r.address, prev);
      } else {
        byAddr.set(r.address, {
          address: r.address,
          balance: r.balance || "0",
          pct: 0,
          holding: !!r.holding,
          buys: r.buys,
          sells: r.sells,
          volEth: r.volEth,
          lastTs: r.lastTs,
          score: r.score,
          reasons: ["active"],
        });
      }
    }
  }

  return [...byAddr.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function preview(provider, opts = {}) {
  const sourceToken = ethers.getAddress(opts.sourceToken || opts.token);
  const token = ethers.getAddress(opts.airdropToken || opts.sendToken || opts.token);
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  let decimals = 18;
  let symbol = "TOKEN";
  try {
    decimals = Number(await c.decimals());
  } catch (_) {}
  try {
    symbol = await c.symbol();
  } catch (_) {}

  const list = buildList(sourceToken, opts);
  const allocated = allocateAmounts(list, { ...opts, decimals });
  const totalWei = allocated.reduce((a, r) => a + BigInt(r.amountWei || "0"), 0n);

  let senderBal = null;
  if (opts.senderAddress) {
    try {
      senderBal = (await c.balanceOf(opts.senderAddress)).toString();
    } catch (_) {}
  }

  return {
    sourceToken,
    token,
    symbol,
    decimals,
    recipients: allocated, // FULL list — UI must show all
    count: allocated.length,
    totalWei: totalWei.toString(),
    totalHuman: ethers.formatUnits(totalWei, decimals),
    senderAddress: opts.senderAddress || null,
    senderBalance: senderBal,
    senderOk: senderBal == null || BigInt(senderBal) >= totalWei,
    mode: opts.mode || "fixed",
  };
}

async function startJob(provider, wallet, previewData, opts = {}) {
  const store = loadJobs();
  const id = crypto.randomBytes(8).toString("hex");
  // Live when user confirms (armedLive). Optional kill-switch: AIRDROP_LIVE=0
  const liveAllowed = process.env.AIRDROP_LIVE !== "0";
  const simulate = !(liveAllowed && opts.armedLive === true);
  const job = {
    id,
    token: previewData.token,
    symbol: previewData.symbol,
    status: "running",
    simulate,
    armedLive: !!opts.armedLive,
    sender: wallet.address,
    total: previewData.count,
    done: 0,
    ok: 0,
    fail: 0,
    results: [],
    createdAt: new Date().toISOString(),
    error: null,
  };
  store.jobs.unshift(job);
  store.jobs = store.jobs.slice(0, 40);
  saveJobs(store);

  const concurrency = Math.min(6, Math.max(1, Number(opts.concurrency || 3)));
  const delayMs = Math.max(50, Number(opts.delayMs || 250));
  const tokenContract = new ethers.Contract(previewData.token, ERC20_ABI, wallet);
  const queue = [...previewData.recipients];
  let idx = 0;

  async function one(rec) {
    const to = ethers.getAddress(rec.address);
    const amount = BigInt(rec.amountWei);
    if (simulate) {
      return { address: to, amountWei: amount.toString(), simulated: true, ok: true };
    }
    const tx = await tokenContract.transfer(to, amount);
    try {
      await tx.wait(1);
    } catch (_) {}
    return {
      address: to,
      amountWei: amount.toString(),
      hash: tx.hash,
      ok: true,
      simulated: false,
    };
  }

  (async () => {
    while (idx < queue.length) {
      const batch = [];
      while (batch.length < concurrency && idx < queue.length) {
        batch.push(queue[idx++]);
      }
      const settled = await Promise.all(
        batch.map(async (rec) => {
          try {
            return await one(rec);
          } catch (e) {
            return {
              address: rec.address,
              amountWei: rec.amountWei,
              ok: false,
              error: e.shortMessage || e.message,
            };
          }
        })
      );
      const s = loadJobs();
      const j = s.jobs.find((x) => x.id === id);
      if (!j || j.status === "stopped") break;
      for (const r of settled) {
        j.done++;
        if (r.ok) j.ok++;
        else j.fail++;
        j.results.push(r);
      }
      j.results = j.results.slice(-800);
      saveJobs(s);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    const s2 = loadJobs();
    const j2 = s2.jobs.find((x) => x.id === id);
    if (j2 && j2.status === "running") {
      j2.status = "completed";
      j2.finishedAt = new Date().toISOString();
      saveJobs(s2);
    }
  })().catch((e) => {
    const s = loadJobs();
    const j = s.jobs.find((x) => x.id === id);
    if (j) {
      j.status = "failed";
      j.error = e.message;
      saveJobs(s);
    }
  });

  return { id, simulate, job };
}

function stopJob(id) {
  const store = loadJobs();
  const j = store.jobs.find((x) => x.id === id);
  if (j && j.status === "running") {
    j.status = "stopped";
    j.finishedAt = new Date().toISOString();
    saveJobs(store);
  }
  return j;
}

function getJob(id) {
  return loadJobs().jobs.find((x) => x.id === id) || null;
}

function listJobs() {
  return loadJobs().jobs || [];
}

module.exports = {
  preview,
  startJob,
  stopJob,
  getJob,
  listJobs,
  buildList,
  allocateAmounts,
};
