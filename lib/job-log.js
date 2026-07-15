/**
 * Structured job logs → data/jobs/*.jsonl (postmortem O2/O5)
 */
const fs = require("fs");
const path = require("path");
const tenant = require("./tenant-context");

function JOBS_DIR() {
  return path.join(tenant.getDataDir(), "jobs");
}

function ensure() {
  fs.mkdirSync(JOBS_DIR(), { recursive: true });
}

function jobPath(jobId) {
  ensure();
  const safe = String(jobId || "job").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(JOBS_DIR(), `${safe}.jsonl`);
}

function appendJobEvent(jobId, event) {
  ensure();
  const row = {
    t: new Date().toISOString(),
    jobId,
    ...event,
  };
  // Never write private keys into job logs
  if (row.privateKey) delete row.privateKey;
  if (row.private_key) delete row.private_key;
  if (row.basePk) delete row.basePk;
  if (row.rhPk) delete row.rhPk;
  fs.appendFileSync(jobPath(jobId), JSON.stringify(row) + "\n");
  return row;
}

function readJobEvents(jobId, limit = 500) {
  const p = jobPath(jobId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
}

function listJobs() {
  ensure();
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      id: f.replace(/\.jsonl$/, ""),
      file: path.join(JOBS_DIR(), f),
      mtime: fs.statSync(path.join(JOBS_DIR(), f)).mtime.toISOString(),
      size: fs.statSync(path.join(JOBS_DIR(), f)).size,
    }))
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

module.exports = {
  get JOBS_DIR() {
    return JOBS_DIR();
  },
  appendJobEvent,
  readJobEvents,
  listJobs,
  jobPath,
};
