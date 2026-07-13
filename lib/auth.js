/**
 * Dashboard auth — simplified port of stealth-bundler dashboard/lib/auth.ts
 * Single-operator login (DASHBOARD_USER / DASHBOARD_PASS) with HMAC session cookie.
 *
 * If DASHBOARD_PASS is unset, auth is disabled (back-compat for local/dev).
 */
const crypto = require("crypto");

const COOKIE_NAME = "rb_session";
const SESSION_HOURS = Number(process.env.SESSION_DURATION_HOURS || 24 * 7);

function requireAuthEnabled() {
    return Boolean(process.env.DASHBOARD_PASS);
}

function getSessionSecret() {
    const secret =
        process.env.SESSION_SECRET ||
        process.env.WALLET_ENCRYPTION_KEY ||
        "";
    if (!secret) {
        // Derive a process-local secret so sessions still work if only PASS is set
        if (!global.__rbSessionSecret) {
            global.__rbSessionSecret = crypto.randomBytes(32).toString("hex");
            console.warn(
                "[auth] SESSION_SECRET not set — using ephemeral secret (sessions reset on restart)"
            );
        }
        return global.__rbSessionSecret;
    }
    return secret;
}

function hashPassword(password, salt) {
    return crypto
        .scryptSync(password, Buffer.from(salt, "hex"), 64, {
            N: 16384,
            r: 8,
            p: 1,
        })
        .toString("hex");
}

function generateSalt() {
    return crypto.randomBytes(32).toString("hex");
}

function createSessionToken(payload) {
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString(
        "base64url"
    );
    const sig = crypto
        .createHmac("sha256", getSessionSecret())
        .update(payloadB64)
        .digest("base64url");
    return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
    try {
        const dotIdx = token.indexOf(".");
        if (dotIdx === -1) return null;
        const payloadB64 = token.slice(0, dotIdx);
        const sig = token.slice(dotIdx + 1);
        const expected = crypto
            .createHmac("sha256", getSessionSecret())
            .update(payloadB64)
            .digest("base64url");
        if (
            !crypto.timingSafeEqual(
                Buffer.from(sig),
                Buffer.from(expected)
            )
        ) {
            return null;
        }
        const payload = JSON.parse(
            Buffer.from(payloadB64, "base64url").toString()
        );
        if (payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

function parseCookies(req) {
    const header = req.headers?.cookie || "";
    const out = {};
    for (const part of header.split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (!k) continue;
        out[k] = decodeURIComponent(rest.join("=") || "");
    }
    return out;
}

function makeSessionCookie(token) {
    const maxAge = SESSION_HOURS * 3600;
    const parts = [
        `${COOKIE_NAME}=${token}`,
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        `Max-Age=${maxAge}`,
    ];
    if (process.env.NODE_ENV === "production") parts.push("Secure");
    return parts.join("; ");
}

function clearSessionCookie() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function getSession(req) {
    if (!requireAuthEnabled()) {
        return { userId: "local", username: "local", role: "admin", bypass: true };
    }
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (!token) return null;
    return verifySessionToken(token);
}

function login(username, password) {
    const expectedUser = process.env.DASHBOARD_USER || "admin";
    const expectedPass = process.env.DASHBOARD_PASS || "";
    if (!expectedPass) throw new Error("DASHBOARD_PASS not configured");
    if (username !== expectedUser || password !== expectedPass) {
        return null;
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
    const payload = {
        userId: "admin",
        username: expectedUser,
        role: "admin",
        exp,
    };
    return { token: createSessionToken(payload), payload };
}

function authMiddleware(req, res, next) {
    if (!requireAuthEnabled()) return next();

    const path = req.path || "";
    // Public auth endpoints + login page assets
    if (
        path === "/login.html" ||
        path === "/api/auth/login" ||
        path === "/api/auth/me" ||
        path === "/api/auth/logout" ||
        path.startsWith("/favicon")
    ) {
        return next();
    }

    const session = getSession(req);
    if (!session) {
        if (path.startsWith("/api/")) {
            return res.status(401).json({ error: "Unauthorized — login required" });
        }
        return res.redirect("/login.html");
    }
    req.session = session;
    return next();
}

module.exports = {
    COOKIE_NAME,
    requireAuthEnabled,
    hashPassword,
    generateSalt,
    createSessionToken,
    verifySessionToken,
    getSession,
    login,
    makeSessionCookie,
    clearSessionCookie,
    authMiddleware,
};
