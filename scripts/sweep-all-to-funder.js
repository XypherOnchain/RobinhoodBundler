/**
 * Sweep leftover ETH (+ unwrap WETH) from helper / creator / hop wallets → bank (funder).
 * Then audit every known address so nothing meaningful is left unaccounted for.
 *
 * On the VPS (recommended):
 *   cd /opt/noxa && node scripts/sweep-all-to-funder.js
 *
 * Options:
 *   --include-dev          also sweep creator (dev) wallets (default: on)
 *   --no-dev               skip creator wallets
 *   --include-sniper       also sweep sniper wallet
 *   --include-txbot        also sweep txbot wallets
 *   --gas-reserve=0.00055  ETH left on each source for fees (default 0.00055)
 *   --dust=0.0007          below this = skip / accounted dust (can't pay gas)
 *   --dry-run              list balances only, send nothing
 */
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const chain = require("../blockchain");

const STORE = path.join(ROOT, "data/dashboard.json");
const DUST_DEFAULT = 0.0007;
const GAS_RESERVE_DEFAULT = 0.00055;

async function estimateGasReserveEth() {
    try {
        const feeData = await chain.provider.getFeeData();
        let maxFee =
            feeData.maxFeePerGas ||
            feeData.gasPrice ||
            ethers.parseUnits("2", "gwei");
        const gasLimit = 160000n;
        const pad = Number(ethers.formatEther(gasLimit * maxFee));
        // headroom — this chain's fee estimates run hot
        return Math.max(GAS_RESERVE_DEFAULT, pad * 1.5);
    } catch {
        return GAS_RESERVE_DEFAULT;
    }
}

function argFlag(name) {
    return process.argv.includes(name);
}
function argVal(name, fallback) {
    const hit = process.argv.find((a) => a.startsWith(`${name}=`));
    if (!hit) return fallback;
    return hit.slice(name.length + 1);
}

function pkOf(w) {
    return w?.private_key || w?.privateKey || null;
}

function roleOf(w) {
    return String(w?.role || "buyer").toLowerCase();
}

function loadStore() {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
}

async function bal(addr) {
    try {
        return Number(await chain.getWalletBalance(addr));
    } catch {
        return null;
    }
}

function fmt(n, dp = 5) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toFixed(dp);
}

async function main() {
    const dry = argFlag("--dry-run");
    const includeDev = !argFlag("--no-dev"); // default ON
    const includeSniper = argFlag("--include-sniper");
    const includeTxbot = argFlag("--include-txbot");
    const gasOverride = argVal("--gas-reserve", null);
    const gasReserveEth = gasOverride != null
        ? Number(gasOverride)
        : await estimateGasReserveEth();
    const dustEth = Math.max(
        Number(argVal("--dust", DUST_DEFAULT)),
        gasReserveEth + 0.00015
    );

    const store = loadStore();
    const wallets = store.wallets || [];
    const funder = wallets.find((w) => roleOf(w) === "funder");
    if (!funder || !chain.isEvmAddress(funder.address)) {
        throw new Error("No funder wallet in data/dashboard.json");
    }

    const roles = new Set(["buyer", "distributor"]);
    if (includeDev) roles.add("dev");
    if (includeSniper) roles.add("sniper");
    if (includeTxbot) roles.add("txbot");

    const sources = wallets.filter((w) => {
        if (!roles.has(roleOf(w))) return false;
        if (!pkOf(w) || !chain.isEvmAddress(w.address)) return false;
        if (w.address.toLowerCase() === funder.address.toLowerCase()) return false;
        return true;
    });

    const hops = (store.hopVault || []).filter((h) => {
        if (!h?.privateKey || !h?.address) return false;
        if (h.recovered) return false;
        return true;
    });

    console.log("=== Sweep all ETH → bank ===");
    console.log(`Bank (funder): ${funder.address}`);
    console.log(`Roles: ${[...roles].join(", ")}`);
    console.log(`Sources: ${sources.length} wallets + ${hops.length} hop(s)`);
    console.log(`Gas reserve / wallet: ${gasReserveEth} ETH · dust threshold: ${dustEth} ETH`);
    if (dry) console.log("DRY RUN — no sends");

    const funderBefore = await bal(funder.address);
    console.log(`Bank before: ${fmt(funderBefore)} ETH`);

    // Pre-scan
    let preTotal = 0;
    const preRows = [];
    for (const w of sources) {
        const b = await bal(w.address);
        const n = Number(b) || 0;
        preTotal += n;
        if (n >= dustEth) {
            preRows.push({
                kind: "wallet",
                name: w.name || roleOf(w),
                role: roleOf(w),
                address: w.address,
                eth: n,
                pk: pkOf(w),
            });
        }
    }
    for (const h of hops) {
        const b = await bal(h.address);
        const n = Number(b) || 0;
        preTotal += n;
        if (n >= dustEth) {
            preRows.push({
                kind: "hop",
                name: `hop${h.step || ""}→${h.destName || h.dest || ""}`,
                role: "hop",
                address: h.address,
                eth: n,
                pk: h.privateKey,
                hop: h,
            });
        }
    }
    console.log(`\nPre-sweep: ${preRows.length} addresses with ≥ ${dustEth} ETH`);
    console.log(`Sum on sources (incl. dust): ${fmt(preTotal)} ETH`);
    for (const r of preRows.slice(0, 20)) {
        console.log(`  ${r.role.padEnd(12)} ${fmt(r.eth)}  ${r.name}  ${r.address}`);
    }
    if (preRows.length > 20) console.log(`  … +${preRows.length - 20} more`);

    if (dry) {
        console.log("\nDry run complete. Re-run without --dry-run to send.");
        return;
    }
    if (!preRows.length) {
        console.log("\nNothing above dust to sweep.");
    } else {
        console.log("\nSweeping (unwrap WETH + send ETH)…");
        const results = await chain.recallEth(
            preRows.map((r) => ({
                address: r.address,
                private_key: r.pk,
                name: r.name,
            })),
            funder.address,
            {
                unwrapWeth: true,
                gasReserveEth,
                waitForConfirm: true,
                delayMsMin: 400,
                delayMsMax: 900,
                onProgress: (ev) => {
                    if (ev.type === "unwrapping") {
                        console.log(`  unwrap ${ev.amount} WETH @ ${ev.wallet}`);
                    } else if (ev.type === "recalling") {
                        console.log(`  ← ${ev.name || ev.wallet}: ${ev.amountEth} ETH`);
                    } else if (ev.type === "recalled") {
                        console.log(`  ✅ ${ev.amountEth} ETH · ${ev.hash}`);
                    } else if (ev.type === "skip") {
                        console.log(`  skip ${ev.wallet} (${ev.reason || "dust"})`);
                    } else if (ev.type === "error" || ev.type === "unwrap_error") {
                        console.log(`  ❌ ${ev.wallet}: ${ev.error}`);
                    }
                },
            }
        );

        // Mark recovered hops
        let hopMarked = 0;
        for (const r of preRows.filter((x) => x.kind === "hop")) {
            const ok = results.find(
                (x) =>
                    String(x.address || "").toLowerCase() ===
                        String(r.address).toLowerCase() && x.hash
            );
            if (ok && r.hop) {
                r.hop.recovered = true;
                r.hop.recoveredAt = new Date().toISOString();
                r.hop.status = "recovered";
                r.hop.recoverTx = ok.hash;
                hopMarked++;
            }
        }
        if (hopMarked) {
            fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
            console.log(`Marked ${hopMarked} hop(s) recovered in store`);
        }

        const okN = results.filter((r) => r.hash).length;
        const errN = results.filter((r) => r.error).length;
        const claimed = results
            .filter((r) => r.hash)
            .reduce((s, r) => s + Number(r.amountEth || 0), 0);
        console.log(`\nSweep txs: ${okN} ok · ${errN} err · claimed ~${fmt(claimed)} ETH`);
    }

    // ── Final audit ──────────────────────────────────────────────
    console.log("\n=== Final audit (every known key) ===");
    await new Promise((r) => setTimeout(r, 1500));
    const funderAfter = await bal(funder.address);
    const gained = (funderAfter || 0) - (funderBefore || 0);
    console.log(`Bank after:  ${fmt(funderAfter)} ETH  (${gained >= 0 ? "+" : ""}${fmt(gained)} ETH)`);

    const leftovers = [];
    let dustSum = 0;
    let leakSum = 0;

    const auditList = [
        ...wallets
            .filter((w) => roleOf(w) !== "funder" && pkOf(w) && chain.isEvmAddress(w.address))
            .map((w) => ({
                label: `${roleOf(w)} · ${w.name || w.address.slice(0, 10)}`,
                address: w.address,
                role: roleOf(w),
            })),
        ...(store.hopVault || [])
            .filter((h) => h?.address && h?.privateKey && !h.recovered)
            .map((h) => ({
                label: `hop · ${h.address.slice(0, 10)}`,
                address: h.address,
                role: "hop",
            })),
    ];

    // de-dupe by address
    const seen = new Set();
    for (const row of auditList) {
        const key = row.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // skip roles we intentionally did not sweep
        if (!includeSniper && row.role === "sniper") continue;
        if (!includeTxbot && (row.role === "txbot" || row.role === "mm" || row.role === "trend")) continue;

        const b = await bal(row.address);
        const n = Number(b) || 0;
        if (n <= 0) continue;
        if (n < dustEth) {
            dustSum += n;
            continue;
        }
        leakSum += n;
        leftovers.push({ ...row, eth: n });
    }

    if (leftovers.length) {
        console.log(`\n⚠️  UNACCOUNTED (≥ ${dustEth} ETH) — ${leftovers.length} wallet(s):`);
        for (const L of leftovers) {
            console.log(`  ${fmt(L.eth)} ETH  ${L.label}  ${L.address}`);
        }
        console.log(`Leak sum: ${fmt(leakSum)} ETH`);
        process.exitCode = 2;
    } else {
        console.log(`\n✅ No unaccounted ETH above dust (${dustEth}).`);
        console.log(`Accounted gas dust left on sources: ${fmt(dustSum)} ETH (intentional).`);
    }

    console.log("\nDone.");
}

main().catch((e) => {
    console.error("FATAL:", e.shortMessage || e.message || e);
    process.exit(1);
});
