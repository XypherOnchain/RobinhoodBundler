/**
 * Dedicated TX Bot host — keep OFF the bundler process.
 *
 *   npm run txbot          → http://localhost:3849
 *
 * Uses data/txbot.json (separate from dashboard.json / sniper.json).
 * First run migrates the TX bot (+ funder) wallet from dashboard.json if needed.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const TXBOT_FILE = path.join(DATA_DIR, "txbot.json");
const DASH_FILE = path.join(DATA_DIR, "dashboard.json");

function migrateFromBundlerIfNeeded() {
    if (fs.existsSync(TXBOT_FILE)) return;
    if (!fs.existsSync(DASH_FILE)) return;
    try {
        const d = JSON.parse(fs.readFileSync(DASH_FILE, "utf8"));
        const wallets = [];
        const funder = (d.wallets || []).find((w) => w.role === "funder");
        const txbot = (d.wallets || []).find((w) => w.role === "txbot");
        if (funder) wallets.push({ ...funder });
        if (txbot) wallets.push({ ...txbot });
        if (!wallets.length) return;
        const walletIndex = wallets.findIndex((w) => w.role === "txbot");
        const store = {
            wallets,
            lastToken: d.lastToken || (d.txBot && d.txBot.token) || "",
            txBot: {
                token: "",
                speed: "medium",
                mode: "transfer",
                buyEth: "0.0000001",
                jitterBuy: true,
                walletIndex: walletIndex >= 0 ? walletIndex : null,
                ...(d.txBot || {}),
                walletIndex: walletIndex >= 0 ? walletIndex : null,
            },
        };
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(TXBOT_FILE, JSON.stringify(store, null, 2));
        console.log(
            `Migrated ${wallets.length} wallet(s) from dashboard.json → txbot.json`
        );
    } catch (e) {
        console.warn("TX bot migrate skipped:", e.message);
    }
}

migrateFromBundlerIfNeeded();

process.env.DASHBOARD_MODE = "txbot";
process.env.PORT = process.env.TXBOT_PORT || process.env.PORT || "3849";
process.env.ENABLE_TXBOT = "1";

require("./server.js");
