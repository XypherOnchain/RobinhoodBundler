/**
 * AES-256-GCM wallet encryption — ported from stealth-bundler src/wallets/encrypt.ts
 * Format on disk: enc:v1:<ivHex>:<authTagHex>:<cipherHex>
 *
 * Enable with WALLET_ENCRYPTION_KEY = 64 hex chars (32 bytes).
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require("crypto");

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

function getKey() {
    const hex = process.env.WALLET_ENCRYPTION_KEY || "";
    if (!hex) return null;
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) {
        throw new Error(
            "WALLET_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
        );
    }
    return key;
}

function isEncrypted(text) {
    return typeof text === "string" && text.startsWith(PREFIX);
}

function encrypt(text) {
    const key = getKey();
    if (!key) return text;
    if (text == null || text === "") return text;
    if (isEncrypted(text)) return text;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    let encrypted = cipher.update(String(text), "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

function decrypt(text) {
    if (text == null || text === "") return text;
    if (!isEncrypted(text)) return text;
    const key = getKey();
    if (!key) {
        throw new Error(
            "Encrypted wallet found but WALLET_ENCRYPTION_KEY is not set"
        );
    }
    const body = text.slice(PREFIX.length);
    const parts = body.split(":");
    if (parts.length !== 3) throw new Error("Corrupt encrypted key blob");
    const [ivHex, authTagHex, encrypted] = parts;
    const decipher = crypto.createDecipheriv(
        ALGO,
        key,
        Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}

function walkEncrypt(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(walkEncrypt);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (
            (k === "private_key" || k === "privateKey") &&
            typeof v === "string" &&
            v
        ) {
            out[k] = encrypt(v);
        } else if (v && typeof v === "object") {
            out[k] = walkEncrypt(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

function walkDecrypt(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(walkDecrypt);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (
            (k === "private_key" || k === "privateKey") &&
            typeof v === "string" &&
            v
        ) {
            out[k] = decrypt(v);
        } else if (v && typeof v === "object") {
            out[k] = walkDecrypt(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

function enabled() {
    return Boolean(getKey());
}

module.exports = {
    encrypt,
    decrypt,
    walkEncrypt,
    walkDecrypt,
    isEncrypted,
    enabled,
    getKey,
};
