/**
 * ApeStore (Robinhood) dry simulator — NO real txs / NO ETH spent.
 *
 * Covers:
 *  1) chain config + ping
 *  2) live token lookup
 *  3) SignalR heartbeat + /api/transaction buy signature
 *  4) dry buy (signature + estimateGas)
 *  5) dry launch (POST /api/token → deployToken estimate, no broadcast)
 *  6) CPMM fee math for launch → helper buys → dump (1% ApeStore fee)
 *
 *   node scripts/apestore-sim.js
 *   APESTORE_LIVE_BUY=1 node scripts/apestore-sim.js   # still dry unless APESTORE_SEND=1
 */
const { ethers } = require("ethers");
const ape = require("../launchpads/apestore");

const PASS = [];
const FAIL = [];
const WARN = [];

function ok(name, detail = "") {
    PASS.push(name);
    console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
}
function bad(name, err) {
    FAIL.push({ name, err: String(err) });
    console.error(`  ✗ ${name} — ${err}`);
}
function warn(name, detail) {
    WARN.push({ name, detail: String(detail) });
    console.warn(`  ⚠ ${name} — ${detail}`);
}
function section(t) {
    console.log(`\n== ${t} ==`);
}

async function main() {
    console.log("ApeStore Robinhood simulator (dry — no txs)\n");

    section("1) Config / ping");
    const ping = await ape.ping();
    if (!ping.ok) throw new Error(ping.error || "ping failed");
    ok(
        "ping",
        `block ${ping.block} · router ${ping.router?.slice(0, 10)}… · v30 ${ping.v30?.slice(0, 10)}…`
    );
    const cfg = await ape.refreshConfig(true);
    if (!(cfg.ApeRouters || []).length) throw new Error("no ApeRouters");
    ok("refreshConfig", `RouterVersion2=${cfg.RouterVersion2} Active=${cfg.Active}`);

    section("2) Live token list + detail");
    const axios = require("axios");
    const { data: list } = await axios.get("https://ape.store/api/tokens?chain=4663", {
        headers: {
            accept: "application/json",
            "User-Agent": "Mozilla/5.0",
            Origin: "https://ape.store",
        },
        timeout: 20000,
    });
    const items = list.items || [];
    if (!items.length) throw new Error("no robinhood tokens on ape.store");
    const sample = items.find((t) => !t.isDead && t.protocol === 30) || items[0];
    ok(
        "tokens",
        `${items.length} listed · sample $${sample.symbol} ${sample.address} id=${sample.id} protocol=${sample.protocol}`
    );
    const info = await ape.getTokenInfo(sample.address);
    const meta = info.token || info;
    if (meta.id == null) throw new Error("token detail missing id");
    ok("getTokenInfo", `id=${meta.id} router=${meta.router} chain=${meta.chain}`);

    section("3) SignalR + buy signature");
    const key = await ape.ensureSessionKey(true);
    if (!key) throw new Error("no heartbeat key");
    ok("Heartbeat", String(key).slice(0, 12) + "…");

    const buyer = ethers.Wallet.createRandom();
    const amountWei = ethers.parseEther("0.01");
    let buySigOk = false;
    try {
        const sig = await ape.getSignature({
            wallet: buyer.address,
            amountWei,
            tokenId: meta.id,
        });
        if (!sig || !sig.startsWith("0x") || sig.length < 130) {
            throw new Error(`bad signature ${sig}`);
        }
        ok("buy signature", `${sig.slice(0, 20)}… (${sig.length} chars)`);
        buySigOk = true;
    } catch (e) {
        // ape.store /api/transaction has been returning empty HTTP 500 from
        // datacenter IPs even with a valid Heartbeat key + correct payload.
        warn("buy signature", e.message || e);
        warn(
            "buy note",
            "Launch path can still be dry-tested. Live buy needs /api/transaction to return a sig."
        );
    }

    section("4) Dry buy (no broadcast)");
    if (!buySigOk) {
        warn("dry buy", "skipped — no trade signature from ape.store");
    } else {
        const fundedHint = process.env.APESTORE_TEST_PK || null;
        const buyWallet = fundedHint
            ? { private_key: fundedHint }
            : { private_key: buyer.privateKey };

        const dryBuy = await ape.buy(buyWallet, 0.01, sample.address, {
            dryRun: true,
            waitForReceipt: false,
        });
        ok(
            "dry buy built",
            `router ${dryBuy.router} · sig ok · calldata ${dryBuy.calldata?.length} chars`
        );
        if (dryBuy.estimateGas) {
            ok("estimateGas buy", dryBuy.estimateGas);
        } else {
            warn(
                "estimateGas buy",
                dryBuy.staticError || "no gas estimate (expected if wallet unfunded)"
            );
            if (
                dryBuy.staticError &&
                /signature|invalid|unauthorized|forbidden/i.test(dryBuy.staticError) &&
                !/fund|balance|gas|ether/i.test(dryBuy.staticError)
            ) {
                bad("buy signature rejected on-chain", dryBuy.staticError);
            } else {
                ok(
                    "buy path not signature-rejected",
                    "failure looks like funds/gas, not bad sig format"
                );
            }
        }
    }

    section("5) Dry launch (sign create, do NOT deploy)");
    const creator = ethers.Wallet.createRandom();
    const sym = `SIM${Date.now().toString(36).slice(-4).toUpperCase()}`;
    try {
        const dryLaunch = await ape.launchToken(
            { private_key: creator.privateKey },
            {
                name: `Sim ${sym}`,
                symbol: sym,
                buyEth: 0.02,
                description: "noxa dry simulator — not deployed",
                dryRun: true,
                estimateTimeoutMs: 8000,
            }
        );
        if (!dryLaunch.dryRun || dryLaunch.apeId == null || !dryLaunch.signature) {
            throw new Error(
                `dry launch incomplete: ${JSON.stringify(dryLaunch).slice(0, 200)}`
            );
        }
        ok(
            "create signature",
            `apeId=${dryLaunch.apeId} · v30 ${dryLaunch.router?.slice(0, 10)}… · value ${dryLaunch.valueEth} ETH`
        );
        if (dryLaunch.estimateGas) {
            ok("estimateGas deployToken", dryLaunch.estimateGas);
        } else {
            warn(
                "estimateGas deployToken",
                dryLaunch.staticError || "expected without funded creator"
            );
            if (
                dryLaunch.staticError &&
                /signature|invalid|unauthorized|ECDSA|not authorized/i.test(
                    dryLaunch.staticError
                ) &&
                !/fund|balance|gas|ether|insufficient|timeout/i.test(
                    dryLaunch.staticError
                )
            ) {
                bad("launch signature rejected", dryLaunch.staticError);
            } else {
                ok(
                    "launch path signed OK",
                    "create API returned id+sig; on-chain estimate skipped/timed out"
                );
            }
        }
    } catch (e) {
        const msg = String(e.message || e);
        if (/429|rate/i.test(msg)) {
            warn(
                "dry launch",
                "ape.store rate-limited create API (HTTP 429) — earlier runs already proved create+sig works"
            );
        } else {
            bad("dry launch", msg);
        }
    }

    section("6) Launch → organic buys → dump math (1% fee CPMM)");
    // Same model as pnl-accuracy-sim, ApeStore fee = 100 bps
    function makePool({ ethReserve, tokenReserve, feeBps = 100 }) {
        let x = ethReserve;
        let y = tokenReserve;
        const feeMul = 1 - feeBps / 10000;
        return {
            buy(ethIn) {
                const e = ethIn * feeMul;
                const dy = (y * e) / (x + e);
                x += ethIn;
                y -= dy;
                return dy;
            },
            quoteSell(tokIn) {
                const t = tokIn * feeMul;
                return (x * t) / (y + t);
            },
            snap() {
                return { x, y };
            },
            load(s) {
                x = s.x;
                y = s.y;
            },
        };
    }
    const pool = makePool({ ethReserve: 8, tokenReserve: 1_000_000_000, feeBps: 100 });
    const creatorBuy = 0.05;
    const helperBuys = [0.015, 0.02, 0.025, 0.03, 0.04];
    const bags = [];
    bags.push({ name: "creator", cost: creatorBuy, tokens: pool.buy(creatorBuy) });
    for (let i = 0; i < helperBuys.length; i++) {
        bags.push({
            name: `helper${i + 1}`,
            cost: helperBuys[i],
            tokens: pool.buy(helperBuys[i]),
        });
    }
    const cost = bags.reduce((a, b) => a + b.cost, 0);
    const alone = bags.reduce((a, b) => a + pool.quoteSell(b.tokens), 0);
    const allTok = bags.reduce((a, b) => a + b.tokens, 0);
    const dump = pool.quoteSell(allTok);
    const haircut = ((alone - dump) / alone) * 100;
    ok(
        "ApeStore 1% launch sim",
        `spent ${cost.toFixed(4)} · alone ${alone.toFixed(5)} · dump ${dump.toFixed(5)} · haircut ${haircut.toFixed(2)}% · PnL dump ${(dump - cost).toFixed(5)} ETH`
    );

    // organic wash burn
    const s = pool.snap();
    let burned = 0;
    for (let i = 0; i < 10; i++) {
        const tok = pool.buy(0.03);
        // sell exact tokens back via mutating — approximate with quote on clone
        const p2 = makePool({ ethReserve: pool.snap().x, tokenReserve: pool.snap().y, feeBps: 100 });
        // actually pool already bought; sell on same pool
        const before = pool.snap().x;
        // manual sell
        {
            const feeMul = 0.99;
            const t = tok * feeMul;
            const dx = (pool.snap().x * t) / (pool.snap().y + t);
            // mutate via buy path inverse — use load after quoteSell style
            const cur = pool.snap();
            const tokEff = tok * 0.99;
            const dx2 = (cur.x * tokEff) / (cur.y + tokEff);
            pool.load({ x: cur.x - dx2, y: cur.y + tok });
            burned += 0.03 - dx2;
        }
        void before;
        void p2;
    }
    ok(
        "organic volume cost",
        `10×0.03 ETH washes burned ~${burned.toFixed(5)} ETH (~${((burned / 0.3) * 100).toFixed(1)}%)`
    );

    console.log("\n========== SUMMARY ==========");
    console.log(`PASS ${PASS.length}  WARN ${WARN.length}  FAIL ${FAIL.length}`);
    if (WARN.length) {
        for (const w of WARN) console.warn(` - warn ${w.name}: ${w.detail}`);
    }
    console.log(
        "Dry paths hit live ape.store APIs. No ETH broadcast."
    );
    if (FAIL.length) {
        for (const f of FAIL) console.error(` - ${f.name}: ${f.err}`);
        process.exit(1);
    }
    console.log(
        "\nLaunch dry-run OK if create signature + estimateGas passed above."
    );
    console.log(
        "Buy dry-run needs /api/transaction (currently often HTTP 500 from servers)."
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
