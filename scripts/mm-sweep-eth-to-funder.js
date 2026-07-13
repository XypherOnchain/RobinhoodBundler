/**
 * One-shot: sweep leftover ETH from MM/buyer wallets → funder.
 * Does NOT sell token bags (imported inventory — dumping would nuke the chart).
 *
 *   node scripts/mm-sweep-eth-to-funder.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const chain = require("../blockchain");
const { ethers } = require("ethers");

const MIN_SEND = 0.0004;

function pkOf(w) {
    const pk = w?.private_key || w?.privateKey;
    return pk ? String(pk) : null;
}

async function gasPadEth() {
    const feeData = await chain.provider.getFeeData();
    let maxFee =
        feeData.maxFeePerGas ||
        feeData.gasPrice ||
        ethers.parseUnits("2", "gwei");
    // transferEth uses up to ~150k gas on this chain
    const gasLimit = 160000n;
    const pad = Number(ethers.formatEther(gasLimit * maxFee));
    // headroom — RPC fee estimates run hot
    return Math.max(0.00035, pad * 1.35);
}

async function main() {
    const store = JSON.parse(
        fs.readFileSync(path.join(ROOT, "data/dashboard.json"), "utf8")
    );
    const funder = (store.wallets || []).find(
        (w) => String(w.role || "").toLowerCase() === "funder"
    );
    if (!funder || !pkOf(funder) || !chain.isEvmAddress(funder.address)) {
        throw new Error("No funder with key in dashboard.json");
    }

    const pool = (store.wallets || []).filter((w) => {
        const role = String(w.role || "").toLowerCase();
        if (!["buyer", "mm", "trend"].includes(role)) return false;
        const pk = pkOf(w);
        return pk && chain.isEvmPrivateKey(pk) && chain.isEvmAddress(w.address);
    });

    const leave = await gasPadEth();
    const funderBefore = Number(await chain.getWalletBalance(funder.address));
    console.log(
        `Funder ${funder.address} · ${funderBefore.toFixed(5)} ETH · sweeping ${pool.length} wallets · gas pad ${leave.toFixed(5)} ETH`
    );

    let swept = 0;
    let sweptEth = 0;
    let skipped = 0;
    let errors = 0;

    for (const w of pool) {
        const label = w.name || w.address.slice(0, 8);
        try {
            const bal = Number(await chain.getWalletBalance(w.address));
            let send = bal - leave;
            // floor to 6 dp so parseEther is happy
            send = Math.floor(send * 1e6) / 1e6;
            if (!(send >= MIN_SEND)) {
                skipped++;
                continue;
            }
            // final safety: never send more than bal - leave
            if (send + leave > bal + 1e-12) {
                send = Math.floor((bal - leave) * 1e6) / 1e6;
            }
            if (!(send >= MIN_SEND)) {
                skipped++;
                continue;
            }
            const tx = await chain.transferEth(
                { private_key: pkOf(w), address: w.address },
                funder.address,
                send
            );
            if (tx?.hash) {
                swept++;
                sweptEth += send;
                console.log(
                    `✅ ${label} ${send.toFixed(5)} ETH → funder · ${String(tx.hash).slice(0, 14)}…`
                );
            } else {
                errors++;
                console.log(`❌ ${label}: no hash`, tx?.error || "");
            }
            await chain.sleep(300);
        } catch (e) {
            // one retry with a fatter pad if gas estimate was wrong
            const msg = e.shortMessage || e.message || String(e);
            if (/insufficient funds/i.test(msg)) {
                try {
                    const bal = Number(await chain.getWalletBalance(w.address));
                    let send = Math.floor((bal - leave * 1.6) * 1e6) / 1e6;
                    if (send >= MIN_SEND) {
                        const tx = await chain.transferEth(
                            { private_key: pkOf(w), address: w.address },
                            funder.address,
                            send
                        );
                        if (tx?.hash) {
                            swept++;
                            sweptEth += send;
                            console.log(
                                `✅ ${label} ${send.toFixed(5)} ETH → funder (retry) · ${String(tx.hash).slice(0, 14)}…`
                            );
                            await chain.sleep(300);
                            continue;
                        }
                    }
                } catch (e2) {
                    errors++;
                    console.log(`❌ ${label}: ${e2.shortMessage || e2.message}`);
                    continue;
                }
            }
            errors++;
            console.log(`❌ ${label}: ${msg}`);
        }
    }

    await chain.sleep(3000);
    const funderAfter = Number(await chain.getWalletBalance(funder.address));
    console.log(
        `\nDone · swept ${swept} wallets · ${sweptEth.toFixed(5)} ETH broadcast · skip ${skipped} · err ${errors}`
    );
    console.log(
        `Funder ${funderBefore.toFixed(5)} → ${funderAfter.toFixed(5)} ETH`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
