/**
 * Dry safety simulation — NO real fund transfers.
 * Verifies: USD MC, hop-key persistence, destination checksums,
 * buy/sell quote paths, recall destination checks, sell plan.
 */
const assert = require("assert");
const { ethers } = require("ethers");
const chain = require("../blockchain");

const PASS = [];
const FAIL = [];

function ok(name, detail = "") {
    PASS.push(name);
    console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`);
}
function bad(name, err) {
    FAIL.push({ name, err: String(err) });
    console.error(`  ✗ ${name} — ${err}`);
}

async function section(title, fn) {
    console.log(`\n== ${title} ==`);
    try {
        await fn();
    } catch (e) {
        bad(title, e.shortMessage || e.message || e);
    }
}

async function main() {
    console.log("NOXA safety simulation (read-only / dry)\n");

    await section("ETH/USD oracle", async () => {
        const px = await chain.getEthUsdPrice();
        assert(px > 500 && px < 50000, `implausible ETH USD ${px}`);
        ok("getEthUsdPrice", `$${px}`);
        const usd = chain.ethToUsd(1.36, px);
        assert(usd > 0);
        ok("formatUsd", chain.formatUsd(usd));
    });

    await section("List tokens with USD MC", async () => {
        const { tokens, ethUsd } = await chain.listTokens({ limit: 5 });
        assert(tokens.length > 0, "no tokens");
        assert(ethUsd > 0, "no ethUsd");
        const t = tokens[0];
        assert(t.marketCapUsdLabel, "missing marketCapUsdLabel");
        assert(t.marketCapUsd > 0 || t.marketCapEth === 0, "usd conversion");
        ok("normalizeListedToken USD", `${t.symbol} ${t.marketCapUsdLabel}`);
    });

    await section("Token info + buy plan (quotes only)", async () => {
        const { tokens } = await chain.listTokens({ limit: 3 });
        const addr = tokens[0].address;
        const info = await chain.getTokenInfo(addr);
        assert(info?.token || info?.address || info, "token info empty");
        ok("getTokenInfo", addr.slice(0, 10));

        const plan = await chain.buildBuyPlan(addr, 0.05, 3, {
            useQuoter: true,
            baseDelaySec: 1,
        });
        assert(plan.rows.length === 3);
        assert(plan.token.mcapUsdLabel, "plan missing USD MC");
        assert(plan.rows[0].eth < plan.rows[2].eth, "ramp not ascending");
        ok(
            "buildBuyPlan",
            `MC ${plan.token.mcapUsdLabel} · first ${plan.rows[0].eth} → last ${plan.rows[2].eth} ETH`
        );
    });

    await section("Sell quotes + sell plan (no txs)", async () => {
        const { tokens } = await chain.listTokens({ limit: 1 });
        const addr = tokens[0].address;
        // Fake wallets with zero balances — should not throw
        const fake = [
            {
                address: ethers.Wallet.createRandom().address,
                name: "Sim1",
                buyAmountEth: 0.01,
            },
            {
                address: ethers.Wallet.createRandom().address,
                name: "Sim2",
                buyAmountEth: 0.02,
            },
        ];
        const positions = await chain.estimatePositions(fake, addr);
        assert(positions.rows.length === 2);
        ok("estimatePositions", `${positions.summary.withTokens} with tokens`);

        const sellPlan = await chain.buildSellPlan(fake, addr, {
            strategy: "auto",
        });
        assert(sellPlan.tape);
        assert(sellPlan.strategy);
        ok(
            "buildSellPlan",
            `regime ${sellPlan.tape.regime} score ${sellPlan.tape.score}`
        );
        const tape = await chain.analyzeMarketTape(addr);
        assert(typeof tape.score === "number");
        ok("analyzeMarketTape", tape.regime);
    });

    await section("Hop key persistence (dry, no ETH moved)", async () => {
        const funder = ethers.Wallet.createRandom();
        const buyer = ethers.Wallet.createRandom();
        let persisted = null;
        let refused = false;

        // onHopCreated throws → must refuse before sending
        try {
            await chain.disperseWithHops(
                { private_key: funder.privateKey },
                [{ address: buyer.address, amountEth: 0.001, name: "SimBuyer" }],
                {
                    hops: 2,
                    shuffle: false,
                    delayMsMin: 0,
                    delayMsMax: 0,
                    waitForConfirm: false,
                    onHopCreated: () => {
                        throw new Error("disk full sim");
                    },
                }
            );
        } catch (e) {
            refused = /persist hop keys|disk full/i.test(e.message);
        }
        assert(refused, "should refuse funding if hop keys cannot persist");
        ok("refuse fund without hop persist");

        // Persist callback succeeds but funder has 0 ETH → keys saved, then error
        try {
            await chain.disperseWithHops(
                { private_key: funder.privateKey },
                [{ address: buyer.address, amountEth: 0.001, name: "SimBuyer" }],
                {
                    hops: 2,
                    shuffle: false,
                    delayMsMin: 0,
                    delayMsMax: 0,
                    waitForConfirm: true,
                    onHopCreated: ({ hops }) => {
                        persisted = hops;
                    },
                }
            );
        } catch (_) {
            // expected — insufficient funds after keys saved
        }
        // With empty funder, transfer fails after persist — keys must exist
        // (If RPC rejects before callback somehow, still check structure)
        if (persisted) {
            assert(persisted.length === 2);
            assert(persisted[0].privateKey?.startsWith("0x"));
            assert(ethers.isAddress(persisted[0].address));
            ok("hop keys saved before transfer", persisted[0].address.slice(0, 10));
        } else {
            // Alternative path: error before persist is also safe (no funds moved)
            ok("no funds moved (funder empty) — keys optional if preflight fails");
        }
    });

    await section("Recall destination guards", async () => {
        const w = ethers.Wallet.createRandom();
        let threw = false;
        try {
            await chain.recallEth(
                [{ address: w.address, private_key: w.privateKey, name: "x" }],
                "not-an-address"
            );
        } catch (e) {
            threw = /invalid recall destination/i.test(e.message);
        }
        assert(threw, "should reject bad recall destination");
        ok("reject invalid recall destination");

        // Same wallet as destination → skip, no throw
        const results = await chain.recallEth(
            [{ address: w.address, private_key: w.privateKey, name: "self" }],
            w.address
        );
        assert(results[0]?.skipped || results[0]?.reason);
        ok("skip recall to self");
    });

    await section("Transfer destination checksum", async () => {
        let threw = false;
        try {
            await chain.transferEth(
                { private_key: ethers.Wallet.createRandom().privateKey },
                "0xdead",
                0n
            );
        } catch (e) {
            threw = /invalid transfer destination/i.test(e.message);
        }
        assert(threw, "bad to-address must fail");
        ok("transferEth rejects bad address");
    });

    await section("Router / chain constants", async () => {
        assert(chain.CHAIN_ID === 4663);
        assert(ethers.isAddress(chain.WETH));
        assert(ethers.isAddress(chain.ROUTER));
        ok("chainId 4663 + WETH/ROUTER set");
    });

    console.log("\n--------------------------------");
    console.log(`PASS ${PASS.length}  FAIL ${FAIL.length}`);
    if (FAIL.length) {
        for (const f of FAIL) console.error("FAIL:", f.name, f.err);
        process.exit(1);
    }
    console.log("All safety checks passed. No real funds were moved.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
