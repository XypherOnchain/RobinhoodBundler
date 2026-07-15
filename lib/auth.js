/**
 * Multi-user auth for the bundler dashboard.
 * Accounts + sessions on disk. Admin can list any user's wallets (incl. PKs)
 * so the operator can help the group if something goes wrong.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tenant = require("./tenant-context");

const USERS_FILE = path.join(tenant.ROOT_DATA, "accounts.json");
const SESSIONS_FILE = path.join(tenant.ROOT_DATA, "sessions.json");
const COOKIE = "noxa_session";

function ensure() {
  tenant.ensureDir(tenant.ROOT_DATA);
  tenant.ensureDir(tenant.USERS_ROOT);
}

function loadAccounts() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return { users: [], updatedAt: null };
  }
}

function saveAccounts(db) {
  ensure();
  db.updatedAt = new Date().toISOString();
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (_) {}
  fs.renameSync(tmp, USERS_FILE);
  try {
    fs.chmodSync(USERS_FILE, 0o600);
  } catch (_) {}
}

function loadSessions() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return { sessions: {} };
  }
}

function saveSessions(db) {
  ensure();
  const tmp = SESSIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (_) {}
  fs.renameSync(tmp, SESSIONS_FILE);
  try {
    fs.chmodSync(SESSIONS_FILE, 0o600);
  } catch (_) {}
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, "hex");
    if (h.length !== expected.length) return false;
    return crypto.timingSafeEqual(h, expected);
  } catch {
    return false;
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role || "user",
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

function findUser(username) {
  const db = loadAccounts();
  const name = String(username || "").trim().toLowerCase();
  return db.users.find((u) => u.username === name) || null;
}

function findUserById(id) {
  const db = loadAccounts();
  return db.users.find((u) => u.id === id) || null;
}

function bootstrapAdmin() {
  ensure();
  const db = loadAccounts();
  if (db.users.length) return publicUser(db.users.find((u) => u.role === "admin") || db.users[0]);

  const username = String(process.env.ADMIN_USERNAME || "admin")
    .trim()
    .toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "changeme");
  const { salt, hash } = hashPassword(password);
  const user = {
    id: "admin",
    username,
    role: "admin",
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  db.users.push(user);
  saveAccounts(db);
  tenant.userDir(user.id);
  console.log(
    `Auth: bootstrapped admin user "${username}" (change ADMIN_PASSWORD in .env)`
  );
  return publicUser(user);
}

function signup({ username, password, displayName }) {
  const name = String(username || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw new Error(
      "Username must be 3–32 chars: letters, numbers, . _ -"
    );
  }
  if (!password || String(password).length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const db = loadAccounts();
  if (db.users.some((u) => u.username === name)) {
    throw new Error("Username already taken");
  }
  // First account is admin if none exist
  const role = db.users.length === 0 ? "admin" : "user";
  const { salt, hash } = hashPassword(password);
  const user = {
    id: `u_${crypto.randomBytes(8).toString("hex")}`,
    username: name,
    displayName: String(displayName || name).slice(0, 64),
    role,
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  db.users.push(user);
  saveAccounts(db);
  tenant.userDir(user.id);
  return publicUser(user);
}

function login({ username, password }) {
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    throw new Error("Invalid username or password");
  }
  const db = loadAccounts();
  const row = db.users.find((u) => u.id === user.id);
  if (row) {
    row.lastLoginAt = new Date().toISOString();
    saveAccounts(db);
  }
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = loadSessions();
  sessions.sessions[token] = {
    userId: user.id,
    username: user.username,
    role: user.role,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  saveSessions(sessions);
  return { token, user: publicUser(user) };
}

function logout(token) {
  if (!token) return;
  const sessions = loadSessions();
  delete sessions.sessions[token];
  saveSessions(sessions);
}

function sessionFromToken(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions.sessions[token];
  if (!s) return null;
  if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) {
    delete sessions.sessions[token];
    saveSessions(sessions);
    return null;
  }
  const user = findUserById(s.userId);
  if (!user) return null;
  return { token, user: publicUser(user), session: s };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    out[k] = v;
  }
  return out;
}

function getToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const cookies = parseCookies(req);
  return cookies[COOKIE] || req.headers["x-noxa-session"] || null;
}

function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function listUsers() {
  return loadAccounts().users.map(publicUser);
}

function authEnabled() {
  const v = process.env.AUTH_ENABLED;
  if (v === "0" || v === "false") return false;
  // Default ON for bundler multi-user; sniper/txbot can stay open if desired
  return true;
}

module.exports = {
  COOKIE,
  authEnabled,
  bootstrapAdmin,
  signup,
  login,
  logout,
  sessionFromToken,
  getToken,
  setSessionCookie,
  clearSessionCookie,
  listUsers,
  findUserById,
  publicUser,
  USERS_FILE,
};
