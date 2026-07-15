/**
 * EVM holders indexer for Robinhood — Transfer logs + balanceOf.
 * Persists per-token JSON under data/holders/{token}.json
 * Adapted from stealth holders-tape.ts for Express/ethers.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const tenant = require("../lib/tenant-context");

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CHUNK = 4000n;
const DEFAULT_LOOKBACK = 120000n; // ~deeper default so older competitor CAs still resolve
const MAX_SCAN = 300000n;
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";

function DATA_DIR() {
  return path.join(tenant.getDataDir(), "holders");
}
function fileFor(token) {
  return path.join(DATA_DIR(), `${String(token).toLowerCase()}.json`);
}

const ERC20_MIN = [
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const MULTICALL_ABI = [
    "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
];

function emptyState(token) {
    return {
        token: String(token).toLowerCase(),
        lastBlock: 0,
        totalSupply: "0",
        holderCount: 0,
        holders: {}, // address -> balance wei string
        activity: {}, // address -> { buys, sells, volEth, lastTs }
        updatedAt: null,
        partial: false,
    };
}

function load(token) {
    try {
        const f = fileFor(token);
        if (!fs.existsSync(f)) return emptyState(token);
        return { ...emptyState(token), ...JSON.parse(fs.readFileSync(f, "utf8")) };
    } catch (_) {
        return emptyState(token);
    }
}

function save(state) {
    const dir = DATA_DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    state.holderCount = Object.keys(state.holders || {}).length;
    const f = fileFor(state.token);
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, f);
}

function enroll(token) {
    const t = ethers.getAddress(token);
    const state = load(t);
    if (!state.lastBlock) save(state);
    return load(t);
}

async function fetchBalances(provider, tokenAddr, addresses) {
    const out = new Map();
    const iface = new ethers.Interface(ERC20_MIN);
    const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
    const BATCH = 200;
    for (let i = 0; i < addresses.length; i += BATCH) {
        const chunk = addresses.slice(i, i + BATCH);
        try {
            const calls = chunk.map((addr) => ({
                target: tokenAddr,
                allowFailure: true,
                callData: iface.encodeFunctionData("balanceOf", [addr]),
            }));
            const results = await mc.aggregate3.staticCall(calls);
            chunk.forEach((addr, idx) => {
                const r = results[idx];
                if (r?.success && r.returnData && r.returnData !== "0x") {
                    try {
                        out.set(addr.toLowerCase(), iface.decodeFunctionResult("balanceOf", r.returnData)[0]);
                    } catch (_) {}
                }
            });
        } catch (_) {
            // Fallback: individual balanceOf
            const c = new ethers.Contract(tokenAddr, ERC20_MIN, provider);
            for (const addr of chunk) {
                try {
                    out.set(addr.toLowerCase(), await c.balanceOf(addr));
                } catch (_) {}
            }
        }
    }
    return out;
}

/**
 * Fast path: pull top holders from Blockscout (works for older / quiet tokens).
 */
async function importHoldersFromBlockscout(token, { pages = 4, pageSize = 50, replace = true } = {}) {
    const tokenAddr = ethers.getAddress(token);
    const state = load(tokenAddr);
    const nextHolders = replace ? {} : { ...(state.holders || {}) };
    let imported = 0;

    // Prefer v2 (skips contracts / LP / routers when flagged)
    let nextParams = null;
    for (let page = 1; page <= pages; page++) {
        let url = `${BLOCKSCOUT}/api/v2/tokens/${tokenAddr}/holders`;
        if (nextParams && typeof nextParams === "object") {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(nextParams)) {
                if (v != null) qs.set(k, String(v));
            }
            const q = qs.toString();
            if (q) url += `?${q}`;
        }
        let items = [];
        let next = null;
        try {
            const r = await fetch(url);
            const j = await r.json();
            items = Array.isArray(j?.items) ? j.items : [];
            next = j?.next_page_params || null;
        } catch (e) {
            console.warn("[holders] blockscout v2:", e.message);
            break;
        }
        if (!items.length) break;
        for (const it of items) {
            const addrObj = it.address || {};
            if (addrObj.is_contract) continue;
            const addr = String(addrObj.hash || "").toLowerCase();
            const val = String(it.value || "0");
            if (!addr.startsWith("0x") || addr === ZERO) continue;
            if (BigInt(val || "0") <= 0n) continue;
            nextHolders[addr] = val;
            imported++;
        }
        if (!next) break;
        nextParams = next;
    }

    // Fallback: classic API if v2 returned nothing
    if (!imported) {
        for (let page = 1; page <= pages; page++) {
            const url =
                `${BLOCKSCOUT}/api?module=token&action=getTokenHolders` +
                `&contractaddress=${tokenAddr}&page=${page}&offset=${pageSize}`;
            let rows = [];
            try {
                const r = await fetch(url);
                const j = await r.json();
                rows = Array.isArray(j?.result) ? j.result : [];
            } catch (e) {
                console.warn("[holders] blockscout:", e.message);
                break;
            }
            if (!rows.length) break;
            for (const row of rows) {
                const addr = String(row.address || row.Address || "").toLowerCase();
                const val = String(row.value || row.Value || "0");
                if (!addr.startsWith("0x") || addr === ZERO) continue;
                if (BigInt(val || "0") <= 0n) continue;
                nextHolders[addr] = val;
                imported++;
            }
            if (rows.length < pageSize) break;
        }
    }

    if (imported > 0 || replace) state.holders = nextHolders;

    try {
        const r2 = await fetch(`${BLOCKSCOUT}/api/v2/tokens/${tokenAddr}`);
        const j2 = await r2.json();
        if (j2?.total_supply) state.totalSupply = String(j2.total_supply);
    } catch (_) {}

    save(state);
    return {
        token: tokenAddr.toLowerCase(),
        imported,
        holderCount: Object.keys(state.holders || {}).length,
        totalSupply: state.totalSupply,
        source: "blockscout",
    };
}

/**
 * Drop contract addresses (LP / routers) — airdrops should go to EOAs only.
 */
async function filterEoaHolders(provider, token, { maxCheck = 300 } = {}) {
    const state = load(token);
    const entries = Object.entries(state.holders || {}).slice(0, maxCheck);
    if (!entries.length) return { kept: 0, dropped: 0 };
    const kept = {};
    let dropped = 0;
    const BATCH = 40;
    for (let i = 0; i < entries.length; i += BATCH) {
        const chunk = entries.slice(i, i + BATCH);
        const codes = await Promise.all(
            chunk.map(async ([addr]) => {
                try {
                    return [addr, await provider.getCode(addr)];
                } catch (_) {
                    return [addr, "0x"];
                }
            })
        );
        for (let j = 0; j < chunk.length; j++) {
            const [addr, bal] = chunk[j];
            const code = codes[j][1] || "0x";
            if (code && code !== "0x") {
                dropped++;
                continue;
            }
            kept[addr] = bal;
        }
    }
    // preserve any holders beyond maxCheck unchecked
    for (const [addr, bal] of Object.entries(state.holders || {}).slice(maxCheck)) {
        kept[addr] = bal;
    }
    state.holders = kept;
    save(state);
    return { kept: Object.keys(kept).length, dropped };
}

/**
 * Scan Transfer logs and refresh balances for touched addresses.
 * @param {import('ethers').Provider} provider
 * @param {string} token
 * @param {{ lookback?: bigint, weth?: string, exclude?: string[], force?: boolean }} opts
 */
async function scan(provider, token, opts = {}) {
    const tokenAddr = ethers.getAddress(token);
    const state = load(tokenAddr);
    const head = BigInt(await provider.getBlockNumber());
    const lookback = opts.lookback != null ? BigInt(opts.lookback) : DEFAULT_LOOKBACK;
    const force =
        opts.force === true ||
        !Object.keys(state.holders || {}).length ||
        !state.lastBlock;
    let from =
        !force && state.lastBlock > 0
            ? BigInt(state.lastBlock) + 1n
            : head > lookback
              ? head - lookback
              : 0n;
    let partial = !!state.partial;
    if (head >= from && head - from > MAX_SCAN) {
        from = head - MAX_SCAN;
        partial = true;
    }

    const excluded = new Set(
        [ZERO, (opts.weth || "").toLowerCase(), tokenAddr.toLowerCase()]
            .concat(opts.exclude || [])
            .map((a) => String(a || "").toLowerCase())
            .filter(Boolean)
    );

    const candidates = new Set();
    if (from <= head) {
        for (let b = from; b <= head; b += CHUNK + 1n) {
            const to = b + CHUNK > head ? head : b + CHUNK;
            let logs = [];
            try {
                logs = await provider.getLogs({
                    address: tokenAddr,
                    topics: [TRANSFER_TOPIC],
                    fromBlock: Number(b),
                    toBlock: Number(to),
                });
            } catch (e) {
                console.warn(`[holders] getLogs ${b}-${to}:`, e.message);
                continue;
            }
            for (const lg of logs) {
                const fromA = lg.topics[1]
                    ? ethers.getAddress("0x" + lg.topics[1].slice(26))
                    : null;
                const toA = lg.topics[2]
                    ? ethers.getAddress("0x" + lg.topics[2].slice(26))
                    : null;
                if (fromA && !excluded.has(fromA.toLowerCase()))
                    candidates.add(fromA);
                if (toA && !excluded.has(toA.toLowerCase())) candidates.add(toA);
            }
        }
    }

    const tokenContract = new ethers.Contract(tokenAddr, ERC20_MIN, provider);
    let totalSupply = 0n;
    try {
        totalSupply = await tokenContract.totalSupply();
    } catch (_) {}

    if (candidates.size > 0) {
        const balances = await fetchBalances(
            provider,
            tokenAddr,
            Array.from(candidates)
        );
        state.holders = state.holders || {};
        for (const [addr, bal] of balances) {
            if (bal > 0n) state.holders[addr] = bal.toString();
            else delete state.holders[addr];
        }
    }

    state.token = tokenAddr.toLowerCase();
    state.lastBlock = Number(head);
    state.totalSupply = totalSupply.toString();
    state.partial = partial;
    save(state);
    return {
        token: state.token,
        holderCount: Object.keys(state.holders).length,
        totalSupply: state.totalSupply,
        scannedTo: state.lastBlock,
        partial,
        touched: candidates.size,
    };
}

/** Merge swap activity from tape into holder state (for airdrop scoring). */
function mergeActivity(token, swaps = []) {
    const state = load(token);
    state.activity = state.activity || {};
    for (const s of swaps) {
        const addr = String(s.trader || "").toLowerCase();
        if (!addr || !addr.startsWith("0x")) continue;
        const row = state.activity[addr] || {
            buys: 0,
            sells: 0,
            volEth: 0,
            lastTs: 0,
        };
        if (s.side === "buy") row.buys++;
        else if (s.side === "sell") row.sells++;
        row.volEth += Number(s.ethAmount || 0);
        row.lastTs = Math.max(row.lastTs, Number(s.timestamp || 0));
        state.activity[addr] = row;
    }
    save(state);
    return state;
}

function listHolders(token, { limit = 100, ourSet = [] } = {}) {
    const state = load(token);
    const ours = new Set(
        (ourSet || []).map((a) => String(a).toLowerCase()).filter(Boolean)
    );
    const supply = BigInt(state.totalSupply || "0");
    const rows = Object.entries(state.holders || {})
        .map(([address, bal]) => {
            const balance = BigInt(bal || "0");
            const pct =
                supply > 0n
                    ? Number((balance * 10000n) / supply) / 100
                    : 0;
            const act = state.activity?.[address] || {};
            return {
                address,
                balance: bal,
                pct,
                isOurs: ours.has(address),
                buys: act.buys || 0,
                sells: act.sells || 0,
                volEth: act.volEth || 0,
                lastTs: act.lastTs || 0,
            };
        })
        .sort((a, b) => {
            const ba = BigInt(a.balance);
            const bb = BigInt(b.balance);
            return ba === bb ? 0 : ba > bb ? -1 : 1;
        })
        .slice(0, limit);

    const us = rows.filter((r) => r.isOurs);
    const them = rows.filter((r) => !r.isOurs);
    const usPct = us.reduce((a, r) => a + r.pct, 0);
    const themPct = them.reduce((a, r) => a + r.pct, 0);

    return {
        token: state.token,
        totalSupply: state.totalSupply,
        holderCount: state.holderCount,
        updatedAt: state.updatedAt,
        partial: state.partial,
        usPct,
        themPct,
        usCount: us.length,
        themCount: them.length,
        holders: rows,
        topThem: them.slice(0, 15),
    };
}

/** Score active traders for airdrop (buys-weighted, prefer non-dumpers). */
function scoreAirdropTargets(token, { exclude = [], minVolEth = 0, minBuys = 0, limit = 100 } = {}) {
    const state = load(token);
    const ex = new Set(
        (exclude || []).map((a) => String(a).toLowerCase())
    );
    const scored = [];
    const activity = state.activity || {};
    const holders = state.holders || {};

    const addrs = new Set([
        ...Object.keys(activity),
        ...Object.keys(holders),
    ]);
    for (const addr of addrs) {
        if (ex.has(addr)) continue;
        const act = activity[addr] || { buys: 0, sells: 0, volEth: 0, lastTs: 0 };
        const holding = !!holders[addr] && BigInt(holders[addr] || "0") > 0n;
        // Need either enough buys OR currently holding
        if (act.buys < minBuys && !holding) continue;
        if (act.volEth < minVolEth && act.buys < minBuys && !holding) continue;
        const dumpRatio =
            act.buys > 0 ? act.sells / act.buys : act.sells > 0 ? 2 : 0;
        const holdBonus = holding ? 1.5 : 1;
        // Base score so pure holders (no tape yet) still qualify
        const base = holding ? 4 : 0;
        const score =
            (base + act.buys * 3 + act.volEth * 10 - act.sells * 1.5) * holdBonus;
        if (score <= 0) continue;
        scored.push({
            address: addr,
            score,
            buys: act.buys,
            sells: act.sells,
            volEth: act.volEth,
            lastTs: act.lastTs,
            balance: holders[addr] || "0",
            dumpRatio,
            holding,
            source: "token",
        });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

module.exports = {
    enroll,
    scan,
    load,
    save,
    mergeActivity,
    listHolders,
    scoreAirdropTargets,
    importHoldersFromBlockscout,
    filterEoaHolders,
    TRANSFER_TOPIC,
    DEFAULT_LOOKBACK,
    MAX_SCAN,
    get DATA_DIR() {
        return DATA_DIR();
    },
};
