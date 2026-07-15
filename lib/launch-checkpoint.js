/**
 * Launch checkpoint state machine (postmortem L2/L4/L9)
 * States: idle → creating → created → buyup_pending → buyup_partial → buyup_done | failed
 */
const fs = require("fs");
const path = require("path");

const CP_DIR = path.join(__dirname, "..", "data", "checkpoints");

function ensure() {
  fs.mkdirSync(CP_DIR, { recursive: true });
}

function cpPath(projectId) {
  ensure();
  const id = String(projectId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(CP_DIR, `launch-${id}.json`);
}

function defaultCheckpoint(projectId) {
  return {
    projectId: projectId || "default",
    status: "idle",
    token: null,
    createTx: null,
    launchpad: null,
    symbol: null,
    name: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
    buyMode: null,
    buyers: [], // { name, address, status: pending|ok|fail, hash?, error? }
    openDone: false,
    organicDone: false,
    note: "",
  };
}

function loadCheckpoint(projectId) {
  const p = cpPath(projectId);
  try {
    return { ...defaultCheckpoint(projectId), ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {
    return defaultCheckpoint(projectId);
  }
}

function saveCheckpoint(cp) {
  cp.updatedAt = new Date().toISOString();
  const p = cpPath(cp.projectId);
  fs.writeFileSync(p, JSON.stringify(cp, null, 2));
  return cp;
}

function markCreating(projectId, meta = {}) {
  const cp = loadCheckpoint(projectId);
  cp.status = "creating";
  Object.assign(cp, meta);
  return saveCheckpoint(cp);
}

function markCreated(projectId, { token, createTx, launchpad, name, symbol, buyers }) {
  const cp = loadCheckpoint(projectId);
  cp.status = "created";
  cp.token = token;
  cp.createTx = createTx;
  cp.launchpad = launchpad;
  cp.name = name || cp.name;
  cp.symbol = symbol || cp.symbol;
  cp.createdAt = new Date().toISOString();
  if (Array.isArray(buyers)) {
    cp.buyers = buyers.map((b) => ({
      name: b.name,
      address: b.address,
      buyAmountEth: b.buyAmountEth,
      delaySec: b.delaySec || 0,
      tranche: b.tranche || null,
      status: "pending",
      hash: null,
      error: null,
    }));
  }
  cp.status = cp.buyers?.length ? "buyup_pending" : "buyup_done";
  return saveCheckpoint(cp);
}

function markBuyerResult(projectId, address, { ok, hash, error }) {
  const cp = loadCheckpoint(projectId);
  const addr = String(address || "").toLowerCase();
  const row = (cp.buyers || []).find(
    (b) => String(b.address || "").toLowerCase() === addr
  );
  if (row) {
    row.status = ok ? "ok" : "fail";
    row.hash = hash || row.hash;
    row.error = error || null;
  }
  const pending = (cp.buyers || []).filter((b) => b.status === "pending").length;
  const okN = (cp.buyers || []).filter((b) => b.status === "ok").length;
  const failN = (cp.buyers || []).filter((b) => b.status === "fail").length;
  if (pending === 0 && (cp.buyers || []).length) {
    cp.status = failN && okN ? "buyup_partial" : failN ? "failed" : "buyup_done";
  } else if (okN || failN) {
    cp.status = "buyup_partial";
  }
  return saveCheckpoint(cp);
}

function pendingBuyers(projectId) {
  const cp = loadCheckpoint(projectId);
  return (cp.buyers || []).filter((b) => b.status === "pending" || b.status === "fail");
}

function isLaunchComplete(projectId, { minOkRatio = 0.9 } = {}) {
  const cp = loadCheckpoint(projectId);
  if (!cp.buyers?.length) return cp.status === "created" || cp.status === "buyup_done";
  const ok = cp.buyers.filter((b) => b.status === "ok").length;
  return ok / cp.buyers.length >= minOkRatio;
}

function markFailed(projectId, note) {
  const cp = loadCheckpoint(projectId);
  cp.status = "failed";
  cp.note = note || cp.note;
  return saveCheckpoint(cp);
}

module.exports = {
  loadCheckpoint,
  saveCheckpoint,
  markCreating,
  markCreated,
  markBuyerResult,
  pendingBuyers,
  isLaunchComplete,
  markFailed,
  cpPath,
};
