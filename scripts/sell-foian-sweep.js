/**
 * Sell stuck Foian on sniper → sweep ETH to funder.
 *   node scripts/sell-foian-sweep.js
 */
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const chain = require("../blockchain");
const { ethers } = require("ethers");

const FOIAN = "0x3C5fc9c7226Af1A1779940A09E33d71E2C5D9a61";

function roundEth(n, dp = 6) {
    const f = 10 ** dp;
    return Math.floor(Number(n) * f + 1e-12) / f;
}

function loadJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function findRole(stores, role) {
    const want = String(role).toLowerCase();
    for (const store of stores) {
        const hit = (store?.wallets || []).find(
            (w) => String(w.role || "").toLowerCase() === want
        );
        if (hit && (hit.private_key || hit.privateKey)) return hit;
    }
    return null;
}

async function main() {
    const sn = loadJson("data/sniper.json");
    const dash = loadJson("data/dashboard.json");
    let txbot = null;
    try {
        txbot = loadJson("data/txbot.json");
    } catch (_) {}
    const stores = [sn, dash, txbot].filter(Boolean);

    const sniper = findRole(stores, "sniper");
    const funder = findRole(stores, "funder");
    if (!sniper) throw new Error("no sniper key");
    if (!funder) throw new Error("no funder key");
    const sniperPk = sniper.private_key || sniper.privateKey;

    const ethBefore = Number(await chain.getWalletBalance(sniper.address));
    const funderBefore = Number(await chain.getWalletBalance(funder.address));
    console.log("sniper ETH", ethBefore.toFixed(5), "funder ETH", funderBefore.toFixed(5));

    const raw = await chain.getTokenBalanceRaw(sniper.address, FOIAN);
    const bal = raw.balance || 0n;
    console.log("Foian bal", ethers.formatUnits(bal, raw.decimals || 18));

    if (bal > 0n) {
        let quote = null;
        try {
            quote = await chain.quoteSell(FOIAN, bal, {});
            console.log("quote ethOut", quote.ethOut);
        } catch (e) {
            console.log("quote failed", e.message);
        }
        const amountHuman = ethers.formatUnits(bal, raw.decimals || 18);
        console.log("selling 100% Foian…");
        const sellTx = await chain.sell(
            { private_key: sniperPk, address: sniper.address },
            amountHuman,
            FOIAN,
            {
                skipQuote: !quote,
                slippageBps: 2000,
                priorityMultiplier: 2.5,
                gasLimit: 350000n,
            }
        );
        if (sellTx?.error) throw new Error("sell failed: " + sellTx.error);
        console.log("sell hash", sellTx.hash);
        let receipt = null;
        for (let i = 0; i < 60; i++) {
            try {
                receipt = await chain.provider.getTransactionReceipt(sellTx.hash);
                if (receipt && receipt.status != null) break;
            } catch (_) {}
            await chain.sleep(1500);
        }
        console.log("sell status", receipt?.status);
        if (!receipt || receipt.status !== 1) throw new Error("sell not confirmed");
    } else {
        console.log("No Foian tokens — skip sell");
    }

    await chain.sleep(2000);
    console.log(
        "sniper ETH after sell",
        Number(await chain.getWalletBalance(sniper.address)).toFixed(5)
    );

    const feeData = await chain.provider.getFeeData();
    const maxFee =
        feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("2", "gwei");
    const leave = Math.max(0.0004, Number(ethers.formatEther(160000n * maxFee)) * 1.5);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const pad = leave * (1 + attempt * 0.4);
            const balNow = Number(await chain.getWalletBalance(sniper.address));
            const send = roundEth(balNow - pad, 6);
            if (send < 0.0005) {
                console.log("nothing meaningful to sweep");
                break;
            }
            console.log("sweeping", send, "ETH → funder");
            const tx = await chain.transferEth(
                { private_key: sniperPk, address: sniper.address },
                funder.address,
                send
            );
            console.log("sweep hash", tx.hash);
            break;
        } catch (e) {
            console.log("sweep attempt", attempt, "failed:", e.shortMessage || e.message);
            if (attempt === 2) throw e;
        }
    }

    await chain.sleep(3000);
    const sniperFinal = Number(await chain.getWalletBalance(sniper.address));
    const funderFinal = Number(await chain.getWalletBalance(funder.address));
    const foLeft = await chain.getTokenBalanceRaw(sniper.address, FOIAN);
    console.log("\nDONE");
    console.log("Foian left", ethers.formatUnits(foLeft.balance || 0n, foLeft.decimals || 18));
    console.log("sniper", ethBefore.toFixed(5), "→", sniperFinal.toFixed(5));
    console.log("funder", funderBefore.toFixed(5), "→", funderFinal.toFixed(5));

    for (const rec of sn.snipes || []) {
        if (String(rec.token || "").toLowerCase() !== FOIAN.toLowerCase()) continue;
        if (rec.partial) continue;
        rec.sold = true;
        rec.exitReason = "manual sweep · sell Foian → funder";
        rec.pnlUnknown = false;
    }
    fs.writeFileSync(path.join(ROOT, "data/sniper.json"), JSON.stringify(sn, null, 2));
    console.log("ledger patched");
}

main().catch((e) => {
    console.error("FAIL", e.shortMessage || e.message || e);
    process.exit(1);
});
