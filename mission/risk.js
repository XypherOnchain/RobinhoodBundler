/**
 * Mission Control risk rails — max drawdown, support ETH cap, never-buy-above entry MC.
 */
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "mission.json");

function defaults() {
    return {
        rails: {
            maxDrawdownPct: 35, // from peak MC
            maxSupportEth: 0.15,
            neverBuyAboveEntryMc: true,
            killOnWhaleDumpEth: 0.5,
        },
        peakMcapUsd: {},
        entryMcapUsd: {},
        supportSpentEth: {},
        updatedAt: null,
    };
}

function load() {
    try {
        if (!fs.existsSync(DATA_FILE)) return defaults();
        return { ...defaults(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    } catch (_) {
        return defaults();
    }
}

function save(store) {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    store.updatedAt = new Date().toISOString();
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

function setRails(partial) {
    const s = load();
    s.rails = { ...s.rails, ...(partial || {}) };
    save(s);
    return s.rails;
}

function noteMcap(token, mcapUsd, { isEntry } = {}) {
    const t = String(token || "").toLowerCase();
    if (!t || !(mcapUsd > 0)) return load();
    const s = load();
    if (isEntry && s.entryMcapUsd[t] == null) s.entryMcapUsd[t] = mcapUsd;
    const peak = Number(s.peakMcapUsd[t] || 0);
    if (mcapUsd > peak) s.peakMcapUsd[t] = mcapUsd;
    save(s);
    return s;
}

function addSupportSpend(token, eth) {
    const t = String(token || "").toLowerCase();
    const s = load();
    s.supportSpentEth[t] = Number(s.supportSpentEth[t] || 0) + Number(eth || 0);
    save(s);
    return s.supportSpentEth[t];
}

/**
 * Evaluate whether a support buy / continue is allowed.
 */
function checkRails(token, { mcapUsd, supportEth } = {}) {
    const s = load();
    const t = String(token || "").toLowerCase();
    const rails = s.rails || defaults().rails;
    const violations = [];
    const peak = Number(s.peakMcapUsd[t] || 0);
    const entry = Number(s.entryMcapUsd[t] || 0);
    const spent = Number(s.supportSpentEth[t] || 0);
    const mc = Number(mcapUsd || 0);

    if (peak > 0 && mc > 0) {
        const dd = ((peak - mc) / peak) * 100;
        if (dd >= Number(rails.maxDrawdownPct || 35)) {
            violations.push({
                code: "max_drawdown",
                msg: `MC down ${dd.toFixed(1)}% from peak (rail ${rails.maxDrawdownPct}%)`,
            });
        }
    }
    if (supportEth != null) {
        const next = spent + Number(supportEth || 0);
        if (next > Number(rails.maxSupportEth || 0.15)) {
            violations.push({
                code: "max_support",
                msg: `Support would be ${next.toFixed(4)} ETH (cap ${rails.maxSupportEth})`,
            });
        }
    }
    if (
        rails.neverBuyAboveEntryMc &&
        entry > 0 &&
        mc > entry * 1.02
    ) {
        violations.push({
            code: "above_entry_mc",
            msg: `MC $${Math.round(mc)} above entry $${Math.round(entry)} — no support buys`,
        });
    }

    return {
        ok: violations.length === 0,
        violations,
        rails,
        peakMcapUsd: peak || null,
        entryMcapUsd: entry || null,
        supportSpentEth: spent,
        drawdownPct:
            peak > 0 && mc > 0 ? ((peak - mc) / peak) * 100 : null,
    };
}

function snapshot(token, moneySummary) {
    const t = String(token || "").toLowerCase();
    const s = load();
    return {
        token: t || null,
        rails: s.rails,
        peakMcapUsd: t ? s.peakMcapUsd[t] || null : null,
        entryMcapUsd: t ? s.entryMcapUsd[t] || null : null,
        supportSpentEth: t ? s.supportSpentEth[t] || 0 : 0,
        pnl: moneySummary || null,
    };
}

module.exports = {
    load,
    save,
    setRails,
    noteMcap,
    addSupportSpend,
    checkRails,
    snapshot,
};
