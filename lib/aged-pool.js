/**
 * Aged wallet pool — park unlinked EOAs, then drip first on-chain activity
 * so creation/first-seen times don't cluster (InsightX / Bubblemaps).
 *
 * Flow:
 *   1) generateAndPark(N) — create keys NOW, persist to data/aged-pool.json (0600)
 *   2) startDrip() — over hours/days, fund+season ONE wallet at a time with jitter
 *   3) claimReady(n) — pull ready wallets into a launch as buyers
 *
 * Keys are ALWAYS written before any funding (same rule as ChangeNOW legs).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const safety = require("./wallet-safety");
const jobLog = require("./job-log");
const tenant = require("./tenant-context");

function DATA_DIR() {
  return tenant.getDataDir();
}
function POOL_FILE() {
  return path.join(DATA_DIR(), "aged-pool.json");
}
function POOL_BACKUP_DIR() {
  return path.join(DATA_DIR(), "aged-pool-backups");
}

function ensure() {
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  fs.mkdirSync(POOL_BACKUP_DIR(), { recursive: true });
}

function emptyPool() {
  return {
    version: 1,
    updatedAt: null,
    config: {
      // Default: ~200 wallets over ~14 days → ~100 min average gap
      dripIntervalMinSec: 45 * 60,
      dripIntervalMaxSec: 150 * 60,
      seasonBudgetEth: 0.006,
      seasonIntensity: "light",
      fundingMode: "offline", // offline | funder_unique | changenow
      armed: false,
      targetCount: 200,
    },
    stats: {
      parked: 0,
      aging: 0,
      ready: 0,
      claimed: 0,
      failed: 0,
    },
    drip: {
      running: false,
      nextAt: null,
      lastWalletId: null,
      lastError: null,
    },
    wallets: [],
  };
}

function loadPool() {
  ensure();
  try {
    const j = JSON.parse(fs.readFileSync(POOL_FILE(), "utf8"));
    if (!Array.isArray(j.wallets)) j.wallets = [];
    if (!j.config) j.config = emptyPool().config;
    if (!j.drip) j.drip = emptyPool().drip;
    if (!j.stats) j.stats = emptyPool().stats;
    return j;
  } catch {
    return emptyPool();
  }
}

function recomputeStats(pool) {
  const s = { parked: 0, aging: 0, ready: 0, claimed: 0, failed: 0 };
  for (const w of pool.wallets || []) {
    const st = String(w.status || "parked");
    if (s[st] != null) s[st]++;
    else if (st === "seasoning") s.aging++;
  }
  pool.stats = s;
  return s;
}

function savePool(pool) {
  ensure();
  recomputeStats(pool);
  pool.updatedAt = new Date().toISOString();
  const tmp = POOL_FILE() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pool, null, 2));
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (_) {}
  fs.renameSync(tmp, POOL_FILE());
  try {
    fs.chmodSync(POOL_FILE(), 0o600);
  } catch (_) {}
  try {
    const bak = path.join(
      POOL_BACKUP_DIR(),
      `aged-pool-${pool.updatedAt.replace(/[:.]/g, "-")}.json`
    );
    fs.copyFileSync(POOL_FILE(), bak);
    fs.chmodSync(bak, 0o600);
    const files = fs
      .readdirSync(POOL_BACKUP_DIR())
      .filter((f) => f.startsWith("aged-pool-"))
      .sort();
    while (files.length > 20) {
      const old = files.shift();
      try {
        fs.unlinkSync(path.join(POOL_BACKUP_DIR(), old));
      } catch (_) {}
    }
  } catch (_) {}
  return pool;
}

function publicWallet(w) {
  return {
    id: w.id,
    name: w.name,
    address: w.address,
    status: w.status,
    createdAt: w.createdAt,
    firstSeenAt: w.firstSeenAt || null,
    seasonedAt: w.seasonedAt || null,
    claimedAt: w.claimedAt || null,
    seasonTxCount: w.seasonTxCount || 0,
    scheduledAgeAt: w.scheduledAgeAt || null,
    error: w.error || null,
  };
}

function publicPool(pool) {
  const p = pool || loadPool();
  recomputeStats(p);
  return {
    updatedAt: p.updatedAt,
    config: { ...p.config },
    stats: { ...p.stats },
    drip: {
      running: !!p.drip?.running,
      nextAt: p.drip?.nextAt || null,
      lastWalletId: p.drip?.lastWalletId || null,
      lastError: p.drip?.lastError || null,
      armed: !!p.config?.armed,
    },
    total: (p.wallets || []).length,
    checksum: checksum(),
    wallets: (p.wallets || []).map(publicWallet),
  };
}

/**
 * Generate N fresh EOAs and park them offline (keys on disk BEFORE any use).
 */
function generateAndPark(count, options = {}) {
  const n = Math.min(500, Math.max(1, Number(count) || 1));
  const pool = loadPool();
  const batchId = options.batchId || `park-${Date.now()}`;
  const now = Date.now();
  const spreadMs = Number(options.createdSpreadMs ?? 6 * 60 * 60 * 1000);
  const created = [];

  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom();
    const seq = pool.wallets.length + 1;
    const id = `A${String(seq).padStart(4, "0")}`;
    const offset = Math.floor(Math.random() * spreadMs);
    const row = {
      id,
      name: options.namePrefix ? `${options.namePrefix}${seq}` : id,
      address: w.address,
      privateKey: w.privateKey,
      status: "parked",
      batchId,
      createdAt: new Date(now - spreadMs + offset).toISOString(),
      parkedAt: new Date().toISOString(),
      scheduledAgeAt: null,
      firstSeenAt: null,
      seasonedAt: null,
      claimedAt: null,
      seasonTxCount: 0,
      error: null,
      meta: {},
    };
    safety.registerControlledAddress(row.address, POOL_FILE(), {
      poolId: row.id,
      status: "parked",
    });
    pool.wallets.push(row);
    created.push(publicWallet(row));
  }

  const legs = [];
  for (let i = 0; i < n; i++) {
    const full = pool.wallets[pool.wallets.length - n + i];
    legs.push({
      name: full.name,
      address: full.address,
      privateKey: full.privateKey,
    });
  }
  const legsSaved = safety.persistLegsBeforePay(`aged-${batchId}`, legs, {
    purpose: "aged wallet pool park — keys before any funding",
  });

  savePool(pool);
  jobLog.appendJobEvent(`aged-pool-${batchId}`, {
    type: "parked",
    count: n,
    poolFile: POOL_FILE(),
    legsFile: legsSaved.path,
    checksum: legsSaved.checksum,
  });

  return {
    ok: true,
    batchId,
    count: n,
    poolFile: POOL_FILE(),
    legsFile: legsSaved.path,
    checksum: legsSaved.checksum,
    stats: pool.stats,
    created,
  };
}

function updateConfig(patch = {}) {
  const pool = loadPool();
  pool.config = { ...pool.config, ...patch };
  if (patch.armed === false) {
    pool.drip.running = false;
  }
  savePool(pool);
  return publicPool(pool);
}

function scheduleNext(pool, fromMs = Date.now()) {
  const min = Math.max(60, Number(pool.config.dripIntervalMinSec || 2700));
  const max = Math.max(min, Number(pool.config.dripIntervalMaxSec || 9000));
  const sec = min + Math.random() * (max - min);
  pool.drip.nextAt = new Date(fromMs + sec * 1000).toISOString();
  return pool.drip.nextAt;
}

function startDrip(options = {}) {
  const pool = loadPool();
  if (options.config) {
    pool.config = { ...pool.config, ...options.config };
  }
  pool.config.armed = true;
  pool.drip.running = true;
  pool.drip.lastError = null;
  const soonMin = Number(options.firstDelaySec ?? 120);
  const soonMax = Number(options.firstDelayMaxSec ?? 600);
  const sec = soonMin + Math.random() * Math.max(0, soonMax - soonMin);
  pool.drip.nextAt = new Date(Date.now() + sec * 1000).toISOString();
  savePool(pool);
  jobLog.appendJobEvent("aged-pool-drip", {
    type: "drip_started",
    nextAt: pool.drip.nextAt,
    config: {
      fundingMode: pool.config.fundingMode,
      intervalMinSec: pool.config.dripIntervalMinSec,
      intervalMaxSec: pool.config.dripIntervalMaxSec,
      seasonBudgetEth: pool.config.seasonBudgetEth,
    },
  });
  return publicPool(pool);
}

function stopDrip() {
  const pool = loadPool();
  pool.config.armed = false;
  pool.drip.running = false;
  pool.drip.nextAt = null;
  savePool(pool);
  jobLog.appendJobEvent("aged-pool-drip", { type: "drip_stopped" });
  return publicPool(pool);
}

function nextParkedWallet(pool) {
  return (pool.wallets || []).find((w) => w.status === "parked");
}

function checkoutForAging() {
  const pool = loadPool();
  if (!pool.config.armed || !pool.drip.running) {
    return { due: false, reason: "drip not armed" };
  }
  if (pool.drip.nextAt && Date.parse(pool.drip.nextAt) > Date.now()) {
    return { due: false, reason: "waiting", nextAt: pool.drip.nextAt };
  }
  const w = nextParkedWallet(pool);
  if (!w) {
    pool.drip.running = false;
    pool.drip.nextAt = null;
    pool.drip.lastError = null;
    savePool(pool);
    return { due: false, reason: "no parked wallets left", done: true };
  }
  w.status = "aging";
  w.scheduledAgeAt = new Date().toISOString();
  pool.drip.lastWalletId = w.id;
  savePool(pool);
  return {
    due: true,
    wallet: {
      id: w.id,
      name: w.name,
      address: w.address,
      private_key: w.privateKey,
      privateKey: w.privateKey,
    },
    config: { ...pool.config },
  };
}

function markAged(walletId, result = {}) {
  const pool = loadPool();
  const w = pool.wallets.find((x) => x.id === walletId);
  if (!w) throw new Error(`wallet ${walletId} not in pool`);
  if (result.ok === false) {
    w.status = "failed";
    w.error = result.error || "aging failed";
  } else {
    w.status = "ready";
    w.firstSeenAt = result.firstSeenAt || new Date().toISOString();
    w.seasonedAt = result.seasonedAt || new Date().toISOString();
    w.seasonTxCount = Number(result.seasonTxCount || 0);
    w.error = null;
  }
  scheduleNext(pool);
  pool.drip.lastError = result.ok === false ? w.error : null;
  savePool(pool);
  jobLog.appendJobEvent("aged-pool-drip", {
    type: result.ok === false ? "age_failed" : "age_ok",
    walletId,
    address: w.address,
    nextAt: pool.drip.nextAt,
    error: w.error,
  });
  return publicWallet(w);
}

function reclaimFailedToPark(walletId) {
  const pool = loadPool();
  const w = pool.wallets.find((x) => x.id === walletId);
  if (!w) throw new Error(`wallet ${walletId} not in pool`);
  w.status = "parked";
  w.error = null;
  savePool(pool);
  return publicWallet(w);
}

function claimReady(count = 1, options = {}) {
  const n = Math.min(200, Math.max(1, Number(count) || 1));
  const pool = loadPool();
  const ready = pool.wallets.filter((w) => w.status === "ready");
  if (!ready.length) {
    throw new Error("No ready aged wallets — park + drip first");
  }
  const take = ready.slice(0, n);
  const claimed = [];
  const now = new Date().toISOString();
  for (const w of take) {
    w.status = "claimed";
    w.claimedAt = now;
    claimed.push({
      name: options.namePrefix
        ? `${options.namePrefix}${claimed.length + 1}`
        : w.name,
      address: w.address,
      private_key: w.privateKey,
      privateKey: w.privateKey,
      role: "buyer",
      seasoned: true,
      seasonTxCount: w.seasonTxCount || 0,
      seasonedAt: w.seasonedAt,
      agedPoolId: w.id,
      firstSeenAt: w.firstSeenAt,
      buyAmountEth: null,
      delaySec: 0,
    });
  }
  savePool(pool);
  jobLog.appendJobEvent("aged-pool-claim", {
    type: "claimed",
    count: claimed.length,
    ids: take.map((w) => w.id),
  });
  return {
    ok: true,
    count: claimed.length,
    remainingReady: pool.stats.ready,
    wallets: claimed,
  };
}

function checksum() {
  ensure();
  if (!fs.existsSync(POOL_FILE())) return null;
  const buf = fs.readFileSync(POOL_FILE());
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

module.exports = {
  get POOL_FILE() { return POOL_FILE(); },
  loadPool,
  savePool,
  publicPool,
  generateAndPark,
  updateConfig,
  startDrip,
  stopDrip,
  checkoutForAging,
  markAged,
  reclaimFailedToPark,
  claimReady,
  checksum,
  recomputeStats,
};
