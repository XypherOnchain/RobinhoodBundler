/**
 * Per-request tenant context (AsyncLocalStorage).
 * Isolates store / jobs / data dirs so multiple dashboard users can work
 * without sharing wallets — all PKs still live on THIS server under data/users/<id>/.
 */
const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs");
const path = require("path");

const als = new AsyncLocalStorage();
const ROOT_DATA = path.join(__dirname, "..", "data");
const USERS_ROOT = path.join(ROOT_DATA, "users");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function userDir(userId) {
  const id = String(userId || "anon").replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(USERS_ROOT, id);
  ensureDir(dir);
  ensureDir(path.join(dir, "legs"));
  ensureDir(path.join(dir, "jobs"));
  ensureDir(path.join(dir, "aged-pool-backups"));
  return dir;
}

function getContext() {
  return als.getStore() || null;
}

function getUserId() {
  return getContext()?.userId || null;
}

function getDataDir() {
  const ctx = getContext();
  if (ctx?.dataDir) return ctx.dataDir;
  return ROOT_DATA;
}

function getStoreFile(modeFile = "dashboard.json") {
  const ctx = getContext();
  if (ctx?.storeFile) return ctx.storeFile;
  return path.join(ROOT_DATA, modeFile);
}

function runWithTenant(ctx, fn) {
  return als.run(ctx, fn);
}

function runWithTenantAsync(ctx, fn) {
  return new Promise((resolve, reject) => {
    als.run(ctx, () => {
      Promise.resolve()
        .then(fn)
        .then(resolve)
        .catch(reject);
    });
  });
}

module.exports = {
  als,
  ROOT_DATA,
  USERS_ROOT,
  userDir,
  getContext,
  getUserId,
  getDataDir,
  getStoreFile,
  runWithTenant,
  runWithTenantAsync,
  ensureDir,
};
