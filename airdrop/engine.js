/**
 * Airdrop engine — score recipients + batch ERC-20 transfers on Robinhood.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const holders = require("../collectors/evm-holders");
const arm = require("../lib/evm-arm");

const DATA_DIR = path.join(__dirname, "..", "data");
const JOB_FILE = path.join(DATA_DIR, "airdrop.json");

const ERC20_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
];

function emptyJobs() {
    return { jobs: [], crm: {}, updatedAt: null };
}

function loadJobs() {
    try {
        if (!fs.existsSync(JOB_FILE)) return emptyJobs();
        return { ...emptyJobs(), ...JSON.parse(fs.readFileSync(JOB_FILE, "utf8")) };
    } catch (_) {
        return emptyJobs();
    }
}

function saveJobs(store) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    store.updatedAt = new Date().toISOString();
    const tmp = JOB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, JOB_FILE);
}

function nanoid() {
    return require("crypto").randomBytes(8).toString("hex");
}

/** Tag wallet in smart-money CRM */
function tagCrm(address, tag, meta = {}) {
    const store = loadJobs();
    const a = String(address).toLowerCase();
    store.crm[a] = {
        ...(store.crm[a] || {}),
        tag, // diamond | dump | whale | sniper | unknown
        ...meta,
        updatedAt: new Date().toISOString(),
    };
    saveJobs(store);
    return store.crm[a];
}

function getCrm() {
    return loadJobs().crm || {};
}

/**
 * Build recipient list from holders scoring + optional CRM boost.
 */
function buildList(token, opts = {}) {
    const {
        exclude = [],
        minVolEth = 0,
        minBuys = 1,
        limit = 50,
        preferHolding = true,
        maxDumpRatio = 2,
        crmOnly = null, // array of tags e.g. ["diamond","whale"]
    } = opts;
    let list = holders.scoreAirdropTargets(token, {
        exclude,
        minVolEth,
        minBuys,
        limit: limit * 3,
    });
    const crm = getCrm();
    list = list
        .filter((r) => r.dumpRatio <= maxDumpRatio)
        .map((r) => {
            const c = crm[r.address];
            let boost = 1;
            if (c?.tag === "diamond") boost = 2;
            if (c?.tag === "whale") boost = 1.75;
            if (c?.tag === "dump") boost = 0.25;
            if (preferHolding && r.holding) boost *= 1.25;
            return { ...r, score: r.score * boost, crmTag: c?.tag || null };
        })
        .filter((r) => r.score > 0)
        .filter((r) => {
            if (!crmOnly || !crmOnly.length) return true;
            return crmOnly.includes(r.crmTag);
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    return list;
}

function allocateAmounts(list, opts = {}) {
    const mode = opts.mode || "fixed"; // fixed | split | tiered
    const decimals = Number(opts.decimals ?? 18);
    const recipients = list.map((r) => ({ ...r }));

    if (mode === "fixed") {
        const each = ethers.parseUnits(String(opts.amountEach || "1"), decimals);
        return recipients.map((r) => ({
            ...r,
            amountWei: each.toString(),
            amountHuman: opts.amountEach || "1",
        }));
    }

    if (mode === "split") {
        const total = ethers.parseUnits(String(opts.totalAmount || "100"), decimals);
        const n = BigInt(Math.max(1, recipients.length));
        const each = total / n;
        return recipients.map((r) => ({
            ...r,
            amountWei: each.toString(),
            amountHuman: ethers.formatUnits(each, decimals),
        }));
    }

    // tiered: top 20% get 3x, mid 2x, rest 1x share of total
    const total = ethers.parseUnits(String(opts.totalAmount || "100"), decimals);
    const n = recipients.length;
    const t1 = Math.max(1, Math.floor(n * 0.2));
    const t2 = Math.max(t1 + 1, Math.floor(n * 0.5));
    const weights = recipients.map((_, i) => (i < t1 ? 3 : i < t2 ? 2 : 1));
    const sumW = weights.reduce((a, b) => a + b, 0);
    return recipients.map((r, i) => {
        const amt = (total * BigInt(weights[i])) / BigInt(sumW);
        return {
            ...r,
            amountWei: amt.toString(),
            amountHuman: ethers.formatUnits(amt, decimals),
        };
    });
}

async function preview(provider, opts = {}) {
    // Score activity from sourceToken (ours or competitor); transfer airdropToken.
    const sourceToken = ethers.getAddress(opts.sourceToken || opts.token);
    const token = ethers.getAddress(opts.airdropToken || opts.token);
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    let decimals = 18;
    let symbol = "TOKEN";
    try {
        decimals = Number(await c.decimals());
    } catch (_) {}
    try {
        symbol = await c.symbol();
    } catch (_) {}

    const list = buildList(sourceToken, opts);
    const allocated = allocateAmounts(list, { ...opts, decimals });
    const totalWei = allocated.reduce(
        (a, r) => a + BigInt(r.amountWei || "0"),
        0n
    );

    let senderBal = null;
    if (opts.senderAddress) {
        try {
            senderBal = (await c.balanceOf(opts.senderAddress)).toString();
        } catch (_) {}
    }

    return {
        sourceToken,
        token,
        symbol,
        decimals,
        recipients: allocated,
        count: allocated.length,
        totalWei: totalWei.toString(),
        totalHuman: ethers.formatUnits(totalWei, decimals),
        senderAddress: opts.senderAddress || null,
        senderBalance: senderBal,
        senderOk:
            senderBal == null || BigInt(senderBal) >= totalWei,
        evmArmLive: arm.evmArmLive(),
        mode: opts.mode || "fixed",
    };
}

/**
 * Execute airdrop job. Respects EVM_ARM_LIVE + opts.armedLive.
 */
async function startJob(provider, wallet, previewData, opts = {}) {
    const store = loadJobs();
    const id = nanoid();
    const simulate = !(arm.evmArmLive() && opts.armedLive === true);
    const job = {
        id,
        token: previewData.token,
        symbol: previewData.symbol,
        status: "running",
        simulate,
        armedLive: !!opts.armedLive,
        sender: wallet.address,
        total: previewData.count,
        done: 0,
        ok: 0,
        fail: 0,
        results: [],
        createdAt: new Date().toISOString(),
        error: null,
    };
    store.jobs.unshift(job);
    store.jobs = store.jobs.slice(0, 40);
    saveJobs(store);

    const concurrency = Math.min(6, Math.max(1, Number(opts.concurrency || 3)));
    const delayMs = Math.max(50, Number(opts.delayMs || 200));
    const tokenContract = new ethers.Contract(
        previewData.token,
        ERC20_ABI,
        wallet
    );

    const queue = [...previewData.recipients];
    let idx = 0;

    async function one(rec) {
        const to = ethers.getAddress(rec.address);
        const amount = BigInt(rec.amountWei);
        if (simulate) {
            return {
                address: to,
                amountWei: amount.toString(),
                simulated: true,
                ok: true,
            };
        }
        const tx = await tokenContract.transfer(to, amount);
        const hash = tx.hash;
        try {
            await tx.wait(1);
        } catch (_) {}
        return {
            address: to,
            amountWei: amount.toString(),
            hash,
            ok: true,
            simulated: false,
        };
    }

    (async () => {
        while (idx < queue.length) {
            const batch = [];
            while (batch.length < concurrency && idx < queue.length) {
                batch.push(queue[idx++]);
            }
            const settled = await Promise.all(
                batch.map(async (rec) => {
                    try {
                        return await one(rec);
                    } catch (e) {
                        return {
                            address: rec.address,
                            amountWei: rec.amountWei,
                            ok: false,
                            error: e.shortMessage || e.message,
                        };
                    }
                })
            );
            const s = loadJobs();
            const j = s.jobs.find((x) => x.id === id);
            if (!j || j.status === "stopped") break;
            for (const r of settled) {
                j.done++;
                if (r.ok) j.ok++;
                else j.fail++;
                j.results.push(r);
                // CRM: mark as airdropped
                const a = String(r.address).toLowerCase();
                s.crm[a] = {
                    ...(s.crm[a] || {}),
                    lastAirdropAt: new Date().toISOString(),
                    lastAirdropToken: previewData.token,
                    tag: s.crm[a]?.tag || "unknown",
                };
            }
            j.results = j.results.slice(-500);
            saveJobs(s);
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
        const s2 = loadJobs();
        const j2 = s2.jobs.find((x) => x.id === id);
        if (j2 && j2.status === "running") {
            j2.status = "completed";
            j2.finishedAt = new Date().toISOString();
            saveJobs(s2);
        }
    })().catch((e) => {
        const s = loadJobs();
        const j = s.jobs.find((x) => x.id === id);
        if (j) {
            j.status = "failed";
            j.error = e.message;
            saveJobs(s);
        }
    });

    return { id, simulate, job };
}

function stopJob(id) {
    const store = loadJobs();
    const j = store.jobs.find((x) => x.id === id);
    if (j && j.status === "running") {
        j.status = "stopped";
        j.finishedAt = new Date().toISOString();
        saveJobs(store);
    }
    return j;
}

function getJob(id) {
    return loadJobs().jobs.find((x) => x.id === id) || null;
}

function listJobs() {
    return loadJobs().jobs || [];
}

module.exports = {
    preview,
    startJob,
    stopJob,
    getJob,
    listJobs,
    buildList,
    allocateAmounts,
    tagCrm,
    getCrm,
    loadJobs,
};
