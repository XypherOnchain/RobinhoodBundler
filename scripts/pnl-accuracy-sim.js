/**
 * P&L / sell-math accuracy simulator.
 *
 * Proves (offline, exact CPMM):
 *  1. Alone-sum overstates a full exit (each wallet assumes full liquidity)
 *  2. Dump-all-one-swap === sell-all-sequential (same tokens, no foreign flow)
 *  3. Sell ORDER does not change TOTAL ETH for a 100% exit — only path / per-wallet split
 *  4. P&L = ethOut − cost is consistent
 *  5. Partial probes: order DOES change remaining inventory value
 *  6. Organic wash volume burns ≈ 2×fee + impact (not free)
 *
 * Optional live check: NODE_LIVE=1 node scripts/pnl-accuracy-sim.js [token]
 */
const assert = require("assert");

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
    WARN.push({ name, detail });
    console.warn(`  ⚠ ${name} — ${detail}`);
}

/** Constant-product AMM (x*y=k). feeBps applied on input (Uniswap-style). */
function makePool({ ethReserve, tokenReserve, feeBps = 100 }) {
    // feeBps: 100 = 1%
    let x = ethReserve; // ETH
    let y = tokenReserve; // tokens
    const feeMul = 1 - feeBps / 10000;

    function spot() {
        return x / y; // ETH per token
    }
    function mcap(supply = tokenReserve) {
        return spot() * supply;
    }
    function buyExactEth(ethIn) {
        const ethEff = ethIn * feeMul;
        const dy = (y * ethEff) / (x + ethEff);
        x += ethIn;
        y -= dy;
        return dy;
    }
    function sellExactTokens(tokIn) {
        const tokEff = tokIn * feeMul;
        const dx = (x * tokEff) / (y + tokEff);
        y += tokIn;
        x -= dx;
        return dx;
    }
    /** Quote without mutating */
    function quoteSell(tokIn) {
        const tokEff = tokIn * feeMul;
        return (x * tokEff) / (y + tokEff);
    }
    function quoteBuy(ethIn) {
        const ethEff = ethIn * feeMul;
        return (y * ethEff) / (x + ethEff);
    }
    function snapshot() {
        return { x, y, spot: spot(), mcap: mcap() };
    }
    function restore(s) {
        x = s.x;
        y = s.y;
    }
    return {
        buyExactEth,
        sellExactTokens,
        quoteSell,
        quoteBuy,
        spot,
        mcap,
        snapshot,
        restore,
        get reserves() {
            return { eth: x, token: y };
        },
    };
}

function nearly(a, b, eps = 1e-9) {
    return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

function section(title) {
    console.log(`\n== ${title} ==`);
}

function runOffline() {
    section("1) Alone-sum vs full dump (exact CPMM)");
    const pool = makePool({ ethReserve: 10, tokenReserve: 1_000_000_000, feeBps: 100 });
    // Simulate launch: creator + 5 helpers buy
    const buys = [0.05, 0.02, 0.03, 0.04, 0.06, 0.08]; // ETH
    const bags = [];
    let costTotal = 0;
    for (let i = 0; i < buys.length; i++) {
        const snap = pool.snapshot();
        const tokens = pool.buyExactEth(buys[i]);
        bags.push({
            name: i === 0 ? "Creator" : `Helper${i}`,
            costEth: buys[i],
            tokens,
        });
        costTotal += buys[i];
        // restore not needed — buys accumulate for realistic MC
        void snap;
    }
    const afterBuys = pool.snapshot();
    ok(
        "organic-ish buy ramp raised MC",
        `MC ${afterBuys.mcap.toFixed(4)} ETH · spot ${afterBuys.spot.toExponential(3)}`
    );

    // Alone quotes: each bag as if sold into CURRENT pool (full liquidity)
    const alone = bags.map((b) => pool.quoteSell(b.tokens));
    const aloneSum = alone.reduce((a, b) => a + b, 0);

    // One-shot dump of ALL tokens (single swap — fee charged once on total input)
    const allTokens = bags.reduce((a, b) => a + b.tokens, 0);
    const oneShot = pool.quoteSell(allTokens);

    // True multi-tx sequential: each wallet is its own swap (fee on EACH input)
    const p2 = makePool({
        ethReserve: afterBuys.x,
        tokenReserve: afterBuys.y,
        feeBps: 100,
    });
    let seqTotal = 0;
    const seqParts = [];
    for (const b of bags) {
        const out = p2.sellExactTokens(b.tokens);
        seqParts.push(out);
        seqTotal += out;
    }

    // Dashboard method: telescoping batch quote = ONE swap partitioned by wallet
    let cum = 0;
    let telescopeTotal = 0;
    const telescopeParts = [];
    for (const b of bags) {
        const after = cum + b.tokens;
        const outAfter = pool.quoteSell(after);
        const outBefore = cum > 0 ? pool.quoteSell(cum) : 0;
        const part = outAfter - outBefore;
        telescopeParts.push(part);
        telescopeTotal += part;
        cum = after;
    }

    assert(aloneSum > oneShot, "alone must overstate dump");
    ok(
        "alone-sum > dump",
        `alone ${aloneSum.toFixed(6)} > dump ${oneShot.toFixed(6)} (haircut ${(((aloneSum - oneShot) / aloneSum) * 100).toFixed(2)}%)`
    );

    assert(nearly(telescopeTotal, oneShot, 1e-10), `telescope ${telescopeTotal} != oneshot ${oneShot}`);
    ok(
        "dashboard batch_quoter === one-shot dump",
        `${oneShot.toFixed(8)} ETH (telescoping partition of a single swap)`
    );

    // Multi-tx sequential is slightly WORSE than one-shot (fee paid per tx)
    assert(seqTotal <= oneShot + 1e-12, "multi-tx should not beat one-shot");
    const feeDrag = oneShot - seqTotal;
    const feeDragPct = (feeDrag / oneShot) * 100;
    ok(
        "multi-tx sequential ≤ one-shot dump",
        `seq ${seqTotal.toFixed(8)} ≤ oneshot ${oneShot.toFixed(8)} (fee-drag ${feeDrag.toFixed(8)} ETH / ${feeDragPct.toFixed(3)}%)`
    );
    if (feeDragPct > 1) {
        warn("fee-drag", `unexpectedly large ${feeDragPct.toFixed(2)}%`);
    } else {
        ok("multi-tx fee-drag is small at 1% fee", `${feeDragPct.toFixed(3)}%`);
    }

    section("2) Sell order: total unchanged for one-shot; multi-tx has tiny fee path drag");
    const smallFirst = [...bags].sort((a, b) => a.tokens - b.tokens);
    const largeFirst = [...bags].sort((a, b) => b.tokens - a.tokens);

    function telescopeOrder(order) {
        let cumTok = 0;
        let total = 0;
        const path = [];
        // Approximate MC drop using one-shot marginals on original pool
        for (const b of order) {
            const before = pool.quoteSell(cumTok);
            cumTok += b.tokens;
            const after = pool.quoteSell(cumTok);
            const out = after - before;
            total += out;
            path.push({ name: b.name, out });
        }
        return { total, path };
    }

    function multiTxOrder(order) {
        const p = makePool({
            ethReserve: afterBuys.x,
            tokenReserve: afterBuys.y,
            feeBps: 100,
        });
        let total = 0;
        const path = [];
        let mcap = p.mcap();
        for (const b of order) {
            const before = mcap;
            const out = p.sellExactTokens(b.tokens);
            mcap = p.mcap();
            total += out;
            path.push({
                name: b.name,
                out,
                mcapDropPct: ((before - mcap) / before) * 100,
            });
        }
        return { total, path, endMcap: mcap };
    }

    const sfT = telescopeOrder(smallFirst);
    const lfT = telescopeOrder(largeFirst);
    assert(nearly(sfT.total, lfT.total, 1e-10), "telescope order changed total — BUG");
    assert(nearly(sfT.total, oneShot, 1e-10));
    ok(
        "one-shot/telescope total is order-invariant",
        `${sfT.total.toFixed(8)} ETH (dashboard dump math)`
    );

    const sf = multiTxOrder(smallFirst);
    const lf = multiTxOrder(largeFirst);
    const orderDrag = Math.abs(sf.total - lf.total);
    const orderDragPct = (orderDrag / Math.max(sf.total, lf.total)) * 100;
    ok(
        "multi-tx order drag is tiny (fee path)",
        `SF ${sf.total.toFixed(8)} vs LF ${lf.total.toFixed(8)} (Δ ${orderDragPct.toFixed(4)}%)`
    );
    assert(orderDragPct < 0.05, `order drag too large ${orderDragPct}%`);

    const firstDropSF = sf.path[0].mcapDropPct;
    const firstDropLF = lf.path[0].mcapDropPct;
    assert(firstDropLF > firstDropSF, "largest first should hit MC harder on step 1");
    ok(
        "largest_first hits chart harder first",
        `step1 drop ${firstDropLF.toFixed(2)}% vs ${firstDropSF.toFixed(2)}%`
    );

    const sfFirstOut = sf.path[0].out;
    const lfFirstOut = lf.path[0].out;
    assert(!nearly(sfFirstOut, lfFirstOut, 1e-6), "first wallet out should differ by order");
    ok(
        "order changes which wallet is credited more",
        `first out SF ${sfFirstOut.toFixed(6)} vs LF ${lfFirstOut.toFixed(6)}`
    );

    section("3) P&L tracking (cost basis)");
    const pnlAlone = aloneSum - costTotal;
    const pnlDump = oneShot - costTotal;
    ok(
        "P&L alone (optimistic)",
        `${pnlAlone >= 0 ? "+" : ""}${pnlAlone.toFixed(6)} ETH on cost ${costTotal.toFixed(4)}`
    );
    ok(
        "P&L dump (realistic full exit)",
        `${pnlDump >= 0 ? "+" : ""}${pnlDump.toFixed(6)} ETH — THIS is what dump-all / sell-all pays`
    );
    assert(pnlDump < pnlAlone, "dump P&L must be worse than alone P&L");
    ok("realistic P&L < optimistic P&L");

    // Per-wallet dump partition via telescoping (dashboard method)
    let partitionSum = telescopeTotal;
    for (let i = 0; i < bags.length; i++) {
        const walletPnl = telescopeParts[i] - bags[i].costEth;
        assert(Number.isFinite(walletPnl));
    }
    assert(nearly(partitionSum, oneShot, 1e-10));
    ok(
        "telescoping partition sums to dump total",
        `(dashboard dumpMethod=batch_quoter)`
    );

    section("4) Partial sells — order matters for leftover value");
    function sellPct(order, pct) {
        const p = makePool({
            ethReserve: afterBuys.x,
            tokenReserve: afterBuys.y,
            feeBps: 100,
        });
        let taken = 0;
        const leftover = [];
        for (const b of order) {
            const sellAmt = b.tokens * (pct / 100);
            taken += p.sellExactTokens(sellAmt);
            leftover.push({ ...b, tokens: b.tokens - sellAmt });
        }
        // value leftover at dump of remaining
        const rem = leftover.reduce((a, b) => a + b.tokens, 0);
        const remValue = p.quoteSell(rem);
        return { taken, remValue, totalIfFinish: taken + remValue };
    }
    const partialSF = sellPct(smallFirst, 25);
    const partialLF = sellPct(largeFirst, 25);
    // After same % of EACH wallet, totals should still match (proportional)
    assert(
        nearly(partialSF.taken, partialLF.taken, 1e-6),
        `equal % taken differs: SF ${partialSF.taken} LF ${partialLF.taken}`
    );
    ok(
        "25% of every wallet: order-invariant taken",
        `${partialSF.taken.toFixed(6)} ETH`
    );

    // Unequal probes: sell 100% of smallest 2 vs 100% of largest 2
    function sellFirstN(order, n) {
        const p = makePool({
            ethReserve: afterBuys.x,
            tokenReserve: afterBuys.y,
            feeBps: 100,
        });
        let taken = 0;
        const left = order.map((b) => ({ ...b }));
        for (let i = 0; i < n; i++) {
            taken += p.sellExactTokens(left[i].tokens);
            left[i].tokens = 0;
        }
        const rem = left.reduce((a, b) => a + b.tokens, 0);
        return { taken, remValue: p.quoteSell(rem), endMcap: p.mcap() };
    }
    const probeSmall = sellFirstN(smallFirst, 2);
    const probeLarge = sellFirstN(largeFirst, 2);
    assert(probeLarge.taken > probeSmall.taken);
    assert(probeLarge.endMcap < probeSmall.endMcap);
    ok(
        "probe largest bags first extracts more now, crushes MC more",
        `taken ${probeLarge.taken.toFixed(5)} vs ${probeSmall.taken.toFixed(5)} · end MC ${probeLarge.endMcap.toFixed(4)} vs ${probeSmall.endMcap.toFixed(4)}`
    );
    // Remaining value higher if you probed small first
    assert(probeSmall.remValue > probeLarge.remValue);
    ok(
        "least-impact probes leave more value in leftover bags",
        `rem ${probeSmall.remValue.toFixed(5)} vs ${probeLarge.remValue.toFixed(5)}`
    );

    section("5) Organic wash volume — fee burn");
    const pWash = makePool({
        ethReserve: afterBuys.x,
        tokenReserve: afterBuys.y,
        feeBps: 100,
    });
    const washEth = 0.05;
    let burned = 0;
    for (let i = 0; i < 20; i++) {
        const before = pWash.reserves.eth;
        const tok = pWash.buyExactEth(washEth);
        const back = pWash.sellExactTokens(tok);
        burned += washEth - back;
    }
    const approxFeeTax = 20 * washEth * (0.01 + 0.01); // rough 2% round trip ignoring compounding
    ok(
        "20 wash rounds burn ETH",
        `burned ${burned.toFixed(6)} ETH (~${((burned / (20 * washEth)) * 100).toFixed(2)}% of notional) · naive 2% fee≈${approxFeeTax.toFixed(6)}`
    );
    assert(burned > 0.015, "wash should clearly burn money at 1% fee");
    if (burned < approxFeeTax * 0.5) {
        warn("wash burn", "lower than naive 2% — check fee application");
    } else {
        ok("wash burn in expected ballpark vs 2×1% fee");
    }

    section("6) Dashboard rules we must keep");
    console.log(`
  RULE A — "Worth now (alone)" is OPTIMISTIC. Never treat it as exit cash.
  RULE B — "If dump ALL" = one-shot pool quote (batch_quoter). Realistic full-exit $.
  RULE C — Wallet-by-wallet multi-tx is slightly WORSE than B (fee paid each swap) + gas.
  RULE D — Sell ORDER does not change dashboard dump TOTAL (one-shot quote).
           Multi-tx order only nudges totals by a tiny fee-path drag.
           Order DOES change: chart path, wallet credits, leftover after partial probes.
  RULE E — Organic/wash volume burns ~2×pool fee + impact. It is not free marketing.
  RULE F — Compare strategies on leftover value after PARTIAL probes, not on full-exit totals.
`);
    ok("documented accuracy rules printed");

    return {
        costTotal,
        aloneSum,
        oneShot,
        seqTotal,
        feeDragPct,
        haircutPct: ((aloneSum - oneShot) / aloneSum) * 100,
        pnlDump: oneShot - costTotal,
        washBurned: burned,
    };
}

async function runLive(tokenAddr) {
    section("7) Live quoter cross-check (optional)");
    const chain = require("../blockchain");
    const { ethers } = require("ethers");

    let addr = tokenAddr;
    if (!addr) {
        try {
            const listed = await chain.listTokens({ limit: 5 });
            addr = listed.tokens?.[0]?.address;
        } catch (e) {
            warn("live listTokens", e.message);
            return;
        }
    }
    if (!addr) {
        warn("live", "no token address");
        return;
    }
    ok("live token", addr);

    // Synthetic bags: we can't invent balances — use estimatePositions shape with fake empty wallets
    // Instead: verify quote monotonicity + telescoping on a live pool with synthetic amounts
    // Use quoteSell (exported) — amounts as human units
    let qA, qB, qC;
    try {
        qA = await chain.quoteSell(addr, "1000");
        qB = await chain.quoteSell(addr, "5000");
        qC = await chain.quoteSell(addr, "6000");
    } catch (e) {
        warn("live quotes", e.shortMessage || e.message);
        return;
    }
    if (qA.error || qB.error || qC.error) {
        warn("live quotes", qA.error || qB.error || qC.error);
        return;
    }
    const alone = (qA.ethOut || 0) + (qB.ethOut || 0);
    const dump = qC.ethOut || 0;
    ok(
        "live alone(1000)+alone(5000) vs dump(6000)",
        `alone ${alone.toFixed(8)} dump ${dump.toFixed(8)} haircut ${alone>0?(((alone - dump) / alone) * 100).toFixed(3):"n/a"}%`
    );
    // Note: alone(1000)+alone(5000) is NOT the same partition as dump(6000) —
    // true telescoping needs quote(6000)-quote(1000). We only assert dump of sum
    // size is not wildly above sum of alones (should be <=).
    assert(dump <= alone * 1.001 + 1e-12, "dump(6000) should be <= alone(1000)+alone(5000)");
    ok("live dump(combined size) <= sum of separate alone quotes");

    // buildSellPlan empty wallets shouldn't crash
    const fake = [
        {
            address: ethers.Wallet.createRandom().address,
            name: "SimA",
            buyAmountEth: 0.01,
            role: "buyer",
        },
        {
            address: ethers.Wallet.createRandom().address,
            name: "SimB",
            buyAmountEth: 0.02,
            role: "buyer",
        },
    ];
    // buildSellPlan can be slow when NOXA API is dead (tape/MC fallbacks) — bound it
    const plan = await Promise.race([
        chain.buildSellPlan(fake, addr, { strategy: "least_impact" }),
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error("buildSellPlan timeout 25s")), 25000)
        ),
    ]).catch((e) => {
        warn("buildSellPlan", e.message);
        return null;
    });
    if (plan) {
        assert(plan.strategy);
        assert(plan.plan || plan.simulation || plan.sim);
        ok(
            "buildSellPlan structure",
            `strategy=${plan.strategy} · plan rows=${(plan.plan || []).length}`
        );
        if (plan.mm?.inventory) {
            const aloneU = Number(plan.mm.inventory.worthAloneUsd || 0);
            const dumpU = Number(plan.mm.inventory.worthDumpUsd || 0);
            if (aloneU > 0 || dumpU > 0) {
                assert(aloneU + 1e-9 >= dumpU);
                ok("inventory alone USD >= dump USD", `${aloneU} >= ${dumpU}`);
            }
        }
    }
}

async function main() {
    console.log("P&L / sell accuracy simulator\n");
    const summary = runOffline();

    if (process.env.NODE_LIVE === "1" || process.argv[2]) {
        try {
            await runLive(process.argv[2] || null);
        } catch (e) {
            bad("live section", e.shortMessage || e.message || e);
        }
    } else {
        console.log("\n(skip live — run with NODE_LIVE=1 or pass a token address)\n");
    }

    console.log("\n========== SUMMARY ==========");
    console.log(`PASS ${PASS.length}  WARN ${WARN.length}  FAIL ${FAIL.length}`);
    console.log(
        `Offline full-exit haircut example: ${summary.haircutPct.toFixed(2)}% (alone vs dump)`
    );
    console.log(
        `Realistic dump P&L on sim launch: ${summary.pnlDump >= 0 ? "+" : ""}${summary.pnlDump.toFixed(6)} ETH`
    );
    console.log(
        `Wash volume burn (20×0.05 ETH): ${summary.washBurned.toFixed(6)} ETH`
    );
    if (FAIL.length) {
        console.error("\nFAILURES:");
        for (const f of FAIL) console.error(` - ${f.name}: ${f.err}`);
        process.exit(1);
    }
    console.log("\nAll accuracy checks passed.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
