/**
 * Money Desk — treasury lock, true P&L, break-even MC, profit ladder,
 * kill switch, launch readiness, exit simulator, portfolio risk, post-launch review.
 * All money figures prefer USD for the UI; ETH kept for on-chain math.
 */

function defaultMoneyDesk() {
    return {
        // 1. Treasury reserve lock
        treasury: {
            minReserveEth: 0.1,
            minReservePct: 25, // 25–40 recommended
            liquidityAllocationEth: 0, // set when you earmark real LP
            marketingBudgetEth: 0,
            emergencyBufferEth: 0.05,
            estimatedGasEth: 0.05, // overridden by live estimate when available
        },
        // 5. Kill switch
        killSwitch: {
            enabled: true,
            paused: false,
            pauseReason: "",
            maxProjectDrawdownPct: 30,
            maxDailyLossEth: 0.5,
            maxFailedTxSpendEth: 0.05,
            minFunderEth: 0.15,
            maxSaleImpactPct: 12,
            maxSupplyOwnedPct: 25,
            maxLiquidityDropPct: 40,
            maxQuoteDeviationPct: 10,
        },
        // 6. Launch readiness (checklist answers)
        readiness: {
            greenLeafActive: false,
            greenLeafExpiresAt: "", // ISO
            minRunwayHours: 48,
            websiteReady: false,
            socialsReady: false,
            promoScheduleConfirmed: false,
            callersConfirmed: false,
            minCommunityReached: false,
            metadataComplete: false,
            buyPlanApproved: false,
            exitPlanApproved: false,
            rpcHealthy: true,
            notes: "",
        },
        // 7. LP capital (kept separate from operating capital)
        lp: {
            ethAllocated: 0,
            tokenAllocated: 0,
            ownershipPct: 0,
            feesEarnedEth: 0,
            impermanentLossEth: 0,
            currentValueEth: 0,
            locked: false,
            unlockAt: "",
            minLiquidityEth: 0.2,
            notes: "",
        },
        // 4. Profit ladder (requires manual approval)
        ladder: {
            approved: false,
            active: false,
            trailProtectPct: 20,
            maxSellPctPerWindow: 8,
            minLiquidityEth: 0.15,
            rungs: [
                { id: "gas", atMcX: 1.4, recoverLabel: "Gas + launch costs", recoverPctOfDeployed: 0, recoverFixedEth: null, takeProfitPctOfBag: 0 },
                { id: "q1", atMcX: 2.0, recoverLabel: "25% of capital", recoverPctOfDeployed: 25, takeProfitPctOfBag: 0 },
                { id: "principal", atMcX: 3.0, recoverLabel: "Rest of principal", recoverPctOfDeployed: 75, takeProfitPctOfBag: 0 },
                { id: "p15a", atMcX: 5.0, recoverLabel: "15% profit", recoverPctOfDeployed: 0, takeProfitPctOfBag: 15 },
                { id: "p15b", atMcX: 8.0, recoverLabel: "Another 15% profit", recoverPctOfDeployed: 0, takeProfitPctOfBag: 15 },
            ],
            completedRungIds: [],
        },
        // Manual expense ledger (2. Net profit)
        expenses: [],
        // Daily loss tracker
        daily: {
            date: "",
            lossEth: 0,
            failedTxEth: 0,
        },
        // Project capital tracking (per active project id)
        projectCapital: {},
        // Reviews
        reviews: [],
    };
}

function ensureMoneyDesk(store) {
    if (!store.moneyDesk || typeof store.moneyDesk !== "object") {
        store.moneyDesk = defaultMoneyDesk();
        return store.moneyDesk;
    }
    const d = defaultMoneyDesk();
    for (const k of Object.keys(d)) {
        if (store.moneyDesk[k] == null) store.moneyDesk[k] = d[k];
        else if (
            typeof d[k] === "object" &&
            !Array.isArray(d[k]) &&
            typeof store.moneyDesk[k] === "object"
        ) {
            store.moneyDesk[k] = { ...d[k], ...store.moneyDesk[k] };
        }
    }
    if (!Array.isArray(store.moneyDesk.expenses)) store.moneyDesk.expenses = [];
    if (!Array.isArray(store.moneyDesk.reviews)) store.moneyDesk.reviews = [];
    if (!store.moneyDesk.projectCapital) store.moneyDesk.projectCapital = {};
    return store.moneyDesk;
}

function usd(eth, ethUsd) {
    const e = Number(eth) || 0;
    const p = Number(ethUsd) || 0;
    return e * p;
}

function fmtUsd(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
    if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
    return `${sign}$${abs.toFixed(2)}`;
}

function fmtEth(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 10) return `${v.toFixed(2)} ETH`;
    if (Math.abs(v) >= 1) return `${v.toFixed(3)} ETH`;
    return `${v.toFixed(4)} ETH`;
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function rollDaily(md) {
    const key = todayKey();
    if (!md.daily || md.daily.date !== key) {
        md.daily = { date: key, lossEth: 0, failedTxEth: 0 };
    }
    return md.daily;
}

/**
 * Expense categories for true net profit.
 */
const EXPENSE_CATEGORIES = [
    { id: "launch_tx", label: "Launch transaction" },
    { id: "failed_tx", label: "Failed transactions" },
    { id: "gas", label: "Gas & priority fees" },
    { id: "slippage", label: "Slippage losses" },
    { id: "token_create", label: "Token creation costs" },
    { id: "lp_deposit", label: "LP deposits" },
    { id: "lp_withdraw_loss", label: "LP withdrawal losses" },
    { id: "marketing", label: "Marketing" },
    { id: "bot_sub", label: "Bot subscriptions" },
    { id: "bridge", label: "Bridge costs" },
    { id: "other", label: "Other" },
];

const INCOME_CATEGORIES = [
    { id: "lp_fees", label: "LP fees earned" },
    { id: "trading", label: "Trading sells (auto)" },
];

function addExpense(md, entry) {
    const row = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: new Date().toISOString(),
        category: entry.category || "other",
        label: entry.label || entry.category || "Expense",
        eth: Number(entry.eth) || 0,
        usd: Number(entry.usd) || 0,
        projectId: entry.projectId || null,
        token: entry.token || null,
        note: entry.note || "",
        kind: entry.kind === "income" ? "income" : "expense",
    };
    md.expenses.push(row);
    if (md.expenses.length > 1000) md.expenses = md.expenses.slice(-1000);
    if (row.kind === "expense" && row.category === "failed_tx") {
        const d = rollDaily(md);
        d.failedTxEth += row.eth;
    }
    return row;
}

function sumExpenses(md, { projectId, token, kind } = {}) {
    let eth = 0;
    const byCat = {};
    for (const e of md.expenses || []) {
        if (kind && e.kind !== kind) continue;
        if (projectId && e.projectId && e.projectId !== projectId) continue;
        if (token && e.token && String(e.token).toLowerCase() !== String(token).toLowerCase())
            continue;
        const v = Number(e.eth) || 0;
        eth += e.kind === "income" ? -v : v; // net: expenses positive cost
        const k = e.category || "other";
        byCat[k] = (byCat[k] || 0) + (e.kind === "income" ? -v : v);
    }
    return { eth, byCat };
}

/**
 * 1. Treasury snapshot — what you can safely spend.
 * LP capital is NOT deployable operating capital.
 */
function buildTreasurySnapshot({
    funderBalanceEth,
    ethUsd,
    md,
    plannedDeployEth = 0,
    gasEstimateEth = null,
}) {
    const t = md.treasury || defaultMoneyDesk().treasury;
    const lp = md.lp || defaultMoneyDesk().lp;
    const funder = Math.max(0, Number(funderBalanceEth) || 0);
    const gas =
        gasEstimateEth != null
            ? Number(gasEstimateEth)
            : Number(t.estimatedGasEth) || 0;
    const minEth = Math.max(0, Number(t.minReserveEth) || 0);
    const minPct = Math.min(90, Math.max(0, Number(t.minReservePct) || 0));
    const protectedByPct = funder * (minPct / 100);
    const protectedReserve = Math.max(minEth, protectedByPct);
    const liquidity = Math.max(0, Number(t.liquidityAllocationEth) || 0);
    const marketing = Math.max(0, Number(t.marketingBudgetEth) || 0);
    const emergency = Math.max(0, Number(t.emergencyBufferEth) || 0);
    const lpLocked = Math.max(0, Number(lp.ethAllocated) || 0);

    const reserved =
        protectedReserve + liquidity + gas + marketing + emergency + lpLocked;
    const maxDeployable = Math.max(0, funder - reserved);
    const planned = Math.max(0, Number(plannedDeployEth) || 0);
    const margin = maxDeployable - planned;

    const breaksMinEth = funder - planned < minEth;
    const breaksMinPct =
        funder > 0 ? ((funder - planned) / funder) * 100 < minPct : false;
    const overDeploy = planned > maxDeployable + 1e-9;

    let status = "ok";
    let plainEnglish = "You have enough spare cash for this plan.";
    if (overDeploy || breaksMinEth || breaksMinPct) {
        status = "block";
        plainEnglish =
            "STOP — this plan would spend money you marked as untouchable (reserve / LP / marketing). Lower the buy size or raise the funder.";
    } else if (margin < maxDeployable * 0.05 && planned > 0) {
        status = "warn";
        plainEnglish =
            "Tight — almost no safety cushion left after this plan. Consider a smaller buy.";
    }

    return {
        ethUsd,
        funderEth: funder,
        funderUsd: usd(funder, ethUsd),
        protectedReserveEth: protectedReserve,
        protectedReserveUsd: usd(protectedReserve, ethUsd),
        protectedByMinEth: minEth,
        protectedByPctEth: protectedByPct,
        minReservePct: minPct,
        liquidityAllocationEth: liquidity,
        liquidityAllocationUsd: usd(liquidity, ethUsd),
        estimatedGasEth: gas,
        estimatedGasUsd: usd(gas, ethUsd),
        marketingBudgetEth: marketing,
        marketingBudgetUsd: usd(marketing, ethUsd),
        emergencyBufferEth: emergency,
        emergencyBufferUsd: usd(emergency, ethUsd),
        lpCapitalEth: lpLocked,
        lpCapitalUsd: usd(lpLocked, ethUsd),
        maxDeployableEth: maxDeployable,
        maxDeployableUsd: usd(maxDeployable, ethUsd),
        plannedDeployEth: planned,
        plannedDeployUsd: usd(planned, ethUsd),
        remainingMarginEth: margin,
        remainingMarginUsd: usd(margin, ethUsd),
        status,
        plainEnglish,
        labels: {
            funder: fmtUsd(usd(funder, ethUsd)),
            protected: fmtUsd(usd(protectedReserve, ethUsd)),
            liquidity: fmtUsd(usd(liquidity, ethUsd)),
            gas: fmtUsd(usd(gas, ethUsd)),
            marketing: fmtUsd(usd(marketing, ethUsd)),
            emergency: fmtUsd(usd(emergency, ethUsd)),
            lp: fmtUsd(usd(lpLocked, ethUsd)),
            maxDeployable: fmtUsd(usd(maxDeployable, ethUsd)),
            planned: fmtUsd(usd(planned, ethUsd)),
            margin: fmtUsd(usd(margin, ethUsd)),
        },
    };
}

/**
 * 2. True net profit from sells + expense ledger + LP fees.
 */
function buildNetProfit({ md, sellHistory = [], ethUsd, token = null }) {
    const sells = token
        ? sellHistory.filter(
              (e) =>
                  String(e.token || "").toLowerCase() ===
                  String(token).toLowerCase()
          )
        : sellHistory;
    const grossTradingEth = sells.reduce(
        (a, e) => a + Number(e.profitEth || 0),
        0
    );
    const grossOutEth = sells.reduce((a, e) => a + Number(e.ethOut || 0), 0);

    const exp = sumExpenses(md, { token, kind: "expense" });
    const income = (md.expenses || [])
        .filter((e) => e.kind === "income")
        .filter(
            (e) =>
                !token ||
                !e.token ||
                String(e.token).toLowerCase() === String(token).toLowerCase()
        );
    const lpFeesEth = income
        .filter((e) => e.category === "lp_fees")
        .reduce((a, e) => a + Number(e.eth || 0), 0);
    const otherIncomeEth = income
        .filter((e) => e.category !== "lp_fees")
        .reduce((a, e) => a + Number(e.eth || 0), 0);

    const by = exp.byCat || {};
    const gas = Number(by.gas || 0) + Number(by.launch_tx || 0);
    const failed = Number(by.failed_tx || 0);
    const infra =
        Number(by.bot_sub || 0) +
        Number(by.bridge || 0) +
        Number(by.token_create || 0) +
        Number(by.other || 0);
    const liqLoss =
        Number(by.lp_deposit || 0) + Number(by.lp_withdraw_loss || 0);
    const marketing = Number(by.marketing || 0);
    const slip = Number(by.slippage || 0);

    const trueNetEth =
        grossTradingEth -
        gas -
        failed -
        infra -
        liqLoss -
        marketing -
        slip +
        lpFeesEth +
        otherIncomeEth;

    return {
        ethUsd,
        grossTradingEth,
        grossTradingUsd: usd(grossTradingEth, ethUsd),
        grossOutEth,
        deductions: {
            gasEth: gas,
            gasUsd: usd(gas, ethUsd),
            failedTxEth: failed,
            failedTxUsd: usd(failed, ethUsd),
            infrastructureEth: infra,
            infrastructureUsd: usd(infra, ethUsd),
            liquidityLossEth: liqLoss,
            liquidityLossUsd: usd(liqLoss, ethUsd),
            marketingEth: marketing,
            marketingUsd: usd(marketing, ethUsd),
            slippageEth: slip,
            slippageUsd: usd(slip, ethUsd),
        },
        lpFeesEarnedEth: lpFeesEth,
        lpFeesEarnedUsd: usd(lpFeesEth, ethUsd),
        trueNetEth,
        trueNetUsd: usd(trueNetEth, ethUsd),
        plainEnglish:
            trueNetEth >= 0
                ? `After every cost, you are ahead about ${fmtUsd(usd(trueNetEth, ethUsd))}.`
                : `After every cost, you are down about ${fmtUsd(usd(Math.abs(trueNetEth), ethUsd))}. Wallet “profit” alone can lie.`,
        labels: {
            gross: fmtUsd(usd(grossTradingEth, ethUsd)),
            gas: fmtUsd(usd(gas, ethUsd)),
            failed: fmtUsd(usd(failed, ethUsd)),
            infra: fmtUsd(usd(infra, ethUsd)),
            liq: fmtUsd(usd(liqLoss, ethUsd)),
            marketing: fmtUsd(usd(marketing, ethUsd)),
            slip: fmtUsd(usd(slip, ethUsd)),
            lpFees: fmtUsd(usd(lpFeesEth, ethUsd)),
            net: fmtUsd(usd(trueNetEth, ethUsd)),
        },
        expenseCategories: EXPENSE_CATEGORIES,
        incomeCategories: INCOME_CATEGORIES,
        recentExpenses: (md.expenses || []).slice(-40).reverse(),
    };
}

/**
 * 3. Break-even market cap from capital deployed / recovered / remaining supply %.
 */
function buildBreakEven({
    capitalDeployedEth,
    capitalRecoveredEth,
    remainingSupplyPct,
    ethUsd,
    currentMcapUsd = null,
}) {
    const deployed = Math.max(0, Number(capitalDeployedEth) || 0);
    const recovered = Math.max(0, Number(capitalRecoveredEth) || 0);
    const atRisk = Math.max(0, deployed - recovered);
    const heldPct = Math.max(0.0001, Number(remainingSupplyPct) || 0); // percent 0–100
    const heldFrac = heldPct / 100;

    // If we hold H% of supply, break-even MC (USD) ≈ atRiskEth * ethUsd / H
    const beUsd =
        heldFrac > 0 && ethUsd > 0 ? (atRisk * ethUsd) / heldFrac : null;

    function rung(mult) {
        if (beUsd == null) return null;
        // For treasury return multiples on full deployed capital:
        // need recovered + remaining_value = deployed * mult
        // remaining_value = heldFrac * MC
        // MC = (deployed*mult - recovered) * ethUsd / heldFrac  (in USD if eth terms)
        const needEth = Math.max(0, deployed * mult - recovered);
        return (needEth * ethUsd) / heldFrac;
    }

    return {
        ethUsd,
        capitalDeployedEth: deployed,
        capitalDeployedUsd: usd(deployed, ethUsd),
        capitalRecoveredEth: recovered,
        capitalRecoveredUsd: usd(recovered, ethUsd),
        capitalAtRiskEth: atRisk,
        capitalAtRiskUsd: usd(atRisk, ethUsd),
        remainingSupplyPct: heldPct,
        breakEvenMcapUsd: beUsd,
        targets: {
            x1_25: rung(1.25),
            x1_5: rung(1.5),
            x2: rung(2),
            x3: rung(3),
        },
        currentMcapUsd,
        plainEnglish:
            beUsd == null
                ? "Need holdings % and capital numbers to compute break-even."
                : `You need about ${fmtUsd(beUsd)} market cap just to get your remaining money back. 2× treasury needs ~${fmtUsd(rung(2))}.`,
        labels: {
            deployed: fmtUsd(usd(deployed, ethUsd)),
            recovered: fmtUsd(usd(recovered, ethUsd)),
            atRisk: fmtUsd(usd(atRisk, ethUsd)),
            be: beUsd != null ? fmtUsd(beUsd) : "—",
            x15: rung(1.5) != null ? fmtUsd(rung(1.5)) : "—",
            x2: rung(2) != null ? fmtUsd(rung(2)) : "—",
            x3: rung(3) != null ? fmtUsd(rung(3)) : "—",
        },
    };
}

/**
 * 4. Profit ladder plan (advisory until approved + activated).
 */
function buildProfitLadder({ md, launchMcapUsd, currentMcapUsd, capitalDeployedEth, ethUsd }) {
    const ladder = md.ladder || defaultMoneyDesk().ladder;
    const launch = Number(launchMcapUsd) || 0;
    const current = Number(currentMcapUsd) || 0;
    const deployed = Number(capitalDeployedEth) || 0;
    const rungs = (ladder.rungs || []).map((r) => {
        const targetMc = launch > 0 ? launch * Number(r.atMcX || 1) : null;
        const hit = targetMc != null && current >= targetMc;
        const done = (ladder.completedRungIds || []).includes(r.id);
        let sellHint = "";
        if (r.recoverPctOfDeployed > 0) {
            sellHint = `Sell enough to bring back ~${fmtUsd(usd((deployed * r.recoverPctOfDeployed) / 100, ethUsd))} of your cash`;
        } else if (r.takeProfitPctOfBag > 0) {
            sellHint = `Take ~${r.takeProfitPctOfBag}% of remaining bag as profit`;
        } else if (r.recoverFixedEth != null) {
            sellHint = `Sell enough to cover ~${fmtUsd(usd(r.recoverFixedEth, ethUsd))} (gas/launch)`;
        } else {
            sellHint = r.recoverLabel || "Trim";
        }
        return {
            ...r,
            targetMcapUsd: targetMc,
            targetMcapLabel: targetMc != null ? fmtUsd(targetMc) : "—",
            hit,
            done,
            sellHint,
            status: done ? "done" : hit ? "ready" : "waiting",
        };
    });
    return {
        approved: !!ladder.approved,
        active: !!ladder.active,
        trailProtectPct: ladder.trailProtectPct,
        maxSellPctPerWindow: ladder.maxSellPctPerWindow,
        minLiquidityEth: ladder.minLiquidityEth,
        launchMcapUsd: launch,
        currentMcapUsd: current,
        rungs,
        plainEnglish: !ladder.approved
            ? "Ladder is OFF until you click Approve. Nothing sells automatically."
            : !ladder.active
              ? "Approved but not active — turn on when you want the bot to follow the steps."
              : "Ladder is ON — it will only sell within your max-% and liquidity rules.",
    };
}

/**
 * 5. Kill switch evaluation.
 */
function evaluateKillSwitch({
    md,
    funderBalanceEth,
    projectDrawdownPct = 0,
    saleImpactPct = 0,
    supplyOwnedPct = 0,
    liquidityDropPct = 0,
    quoteDeviationPct = 0,
}) {
    const ks = md.killSwitch || defaultMoneyDesk().killSwitch;
    if (!ks.enabled) {
        return {
            ok: true,
            paused: false,
            reasons: [],
            plainEnglish: "Safety brakes are turned off (not recommended).",
        };
    }
    if (ks.paused) {
        return {
            ok: false,
            paused: true,
            reasons: [ks.pauseReason || "Manually paused"],
            plainEnglish: `PAUSED: ${ks.pauseReason || "Safety stop is on."}`,
        };
    }
    const daily = rollDaily(md);
    const reasons = [];
    const funder = Number(funderBalanceEth) || 0;
    if (funder < Number(ks.minFunderEth || 0)) {
        reasons.push(
            `Funder below ${fmtEth(ks.minFunderEth)} floor (now ${fmtEth(funder)})`
        );
    }
    if (projectDrawdownPct >= Number(ks.maxProjectDrawdownPct || 100)) {
        reasons.push(
            `This project is down ${projectDrawdownPct.toFixed(0)}% (limit ${ks.maxProjectDrawdownPct}%)`
        );
    }
    if (daily.lossEth >= Number(ks.maxDailyLossEth || Infinity)) {
        reasons.push(
            `Daily loss ${fmtEth(daily.lossEth)} hit the ${fmtEth(ks.maxDailyLossEth)} cap`
        );
    }
    if (daily.failedTxEth >= Number(ks.maxFailedTxSpendEth || Infinity)) {
        reasons.push(
            `Failed-tx spend ${fmtEth(daily.failedTxEth)} over ${fmtEth(ks.maxFailedTxSpendEth)}`
        );
    }
    if (saleImpactPct > Number(ks.maxSaleImpactPct || 100)) {
        reasons.push(
            `This sale would move price ~${saleImpactPct.toFixed(1)}% (max ${ks.maxSaleImpactPct}%)`
        );
    }
    if (supplyOwnedPct > Number(ks.maxSupplyOwnedPct || 100)) {
        reasons.push(
            `You control ~${supplyOwnedPct.toFixed(1)}% of supply (max ${ks.maxSupplyOwnedPct}%)`
        );
    }
    if (liquidityDropPct >= Number(ks.maxLiquidityDropPct || 100)) {
        reasons.push(
            `Liquidity dropped ${liquidityDropPct.toFixed(0)}% (max ${ks.maxLiquidityDropPct}%)`
        );
    }
    if (quoteDeviationPct >= Number(ks.maxQuoteDeviationPct || 100)) {
        reasons.push(
            `Quote looks stale/off by ${quoteDeviationPct.toFixed(1)}%`
        );
    }
    return {
        ok: reasons.length === 0,
        paused: false,
        reasons,
        plainEnglish:
            reasons.length === 0
                ? "Safety brakes: clear."
                : `STOP — ${reasons[0]}`,
        config: ks,
        daily,
    };
}

/**
 * 6. Launch readiness score (0–100) with plain-English blockers.
 */
function buildLaunchReadiness({ md, treasury, kill, hasDev, buyersFunded, hasBuyPlan, hasExitPlan, ethUsd }) {
    const r = md.readiness || defaultMoneyDesk().readiness;
    const checks = [];

    function add(id, ok, label, detail, weight = 1, blocker = false) {
        checks.push({ id, ok: !!ok, label, detail, weight, blocker });
    }

    add(
        "treasury",
        treasury?.status === "ok" || treasury?.status === "warn",
        "Cash reserve OK",
        treasury?.plainEnglish || "",
        2,
        treasury?.status === "block"
    );
    add(
        "kill",
        kill?.ok !== false,
        "Safety brakes clear",
        kill?.plainEnglish || "",
        2,
        !kill?.ok
    );
    add("dev", hasDev, "Dev wallet ready", hasDev ? "Creator wallet set" : "Create/import Dev first", 1, true);
    add(
        "buyers",
        buyersFunded,
        "Buy wallets funded",
        buyersFunded ? "Buyers have ETH" : "Fund buyers before launch",
        2,
        true
    );
    add(
        "buyPlan",
        hasBuyPlan || r.buyPlanApproved,
        "Buy plan approved",
        "You know how much each wallet buys",
        1,
        true
    );
    add(
        "exitPlan",
        hasExitPlan || r.exitPlanApproved,
        "Exit plan approved",
        "You know when/how you'll sell",
        1,
        false
    );
    add(
        "metadata",
        r.metadataComplete,
        "Token name/image/socials filled",
        "Looks finished on the launchpad",
        1,
        false
    );
    add("website", r.websiteReady, "Website ready", "", 1, false);
    add("socials", r.socialsReady, "Social accounts ready", "", 1, false);
    add(
        "promo",
        r.promoScheduleConfirmed,
        "Team promo schedule confirmed",
        "Who posts what, and when",
        1,
        false
    );
    add("callers", r.callersConfirmed, "Callers / partners confirmed", "", 1, false);
    add(
        "community",
        r.minCommunityReached,
        "Minimum community size reached",
        "",
        1,
        false
    );
    add("rpc", r.rpcHealthy !== false, "Network / gas looks healthy", "", 1, false);

    // Green leaf runway
    let leafOk = true;
    let leafDetail = "No green-leaf timer set";
    if (r.greenLeafActive && r.greenLeafExpiresAt) {
        const exp = new Date(r.greenLeafExpiresAt).getTime();
        const hoursLeft = (exp - Date.now()) / 3600000;
        const need = Number(r.minRunwayHours) || 48;
        leafOk = hoursLeft >= need;
        leafDetail = leafOk
            ? `~${hoursLeft.toFixed(0)}h left on promo (need ≥${need}h)`
            : `DO NOT LAUNCH — promo ends in ~${Math.max(0, hoursLeft).toFixed(0)}h. Need ≥${need}h runway so the coin can climb rankings.`;
    } else if (r.greenLeafActive) {
        leafOk = false;
        leafDetail = "Green-leaf is on but no expiration time — set when it ends.";
    }
    add("greenLeaf", leafOk, "Promo / green-leaf runway", leafDetail, 3, !leafOk && r.greenLeafActive);

    const totalW = checks.reduce((a, c) => a + c.weight, 0);
    const gotW = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
    const score = totalW > 0 ? Math.round((gotW / totalW) * 100) : 0;
    const blockers = checks.filter((c) => c.blocker && !c.ok);
    const canLaunch = blockers.length === 0 && score >= 55;

    let verdict = "Ready enough to launch";
    let tone = "ok";
    if (!canLaunch) {
        tone = "block";
        verdict = blockers[0]?.detail || "Fix the red items before launching.";
    } else if (score < 75) {
        tone = "warn";
        verdict = "You can launch, but several checklist items are still open.";
    }

    return {
        score,
        canLaunch,
        tone,
        verdict,
        plainEnglish: verdict,
        checks,
        blockers,
        readiness: r,
        ethUsd,
    };
}

/**
 * 8. Dynamic position sizing advice.
 */
function buildPositionSizing({
    requestedEth,
    maxDeployableEth,
    availableLiquidityEth,
    currentMcapEth,
    targetOwnershipPct = 10,
    maxDrawdownPct = 30,
    ethUsd,
}) {
    const req = Math.max(0, Number(requestedEth) || 0);
    const maxDep = Math.max(0, Number(maxDeployableEth) || 0);
    const liq = Math.max(0, Number(availableLiquidityEth) || 0);
    const mcap = Math.max(0, Number(currentMcapEth) || 0);

    // Rough: don't take more than ~15% of pool liquidity or target ownership of MC
    const byLiq = liq > 0 ? liq * 0.15 : maxDep;
    const byOwn = mcap > 0 ? mcap * (Number(targetOwnershipPct) / 100) : maxDep;
    const byDd = maxDep * (1 - Number(maxDrawdownPct) / 200);
    const prudent = Math.max(0, Math.min(maxDep, byLiq || maxDep, byOwn || maxDep, byDd || maxDep));

    const ok = req <= prudent + 1e-9;
    return {
        requestedEth: req,
        requestedUsd: usd(req, ethUsd),
        maxPrudentEth: prudent,
        maxPrudentUsd: usd(prudent, ethUsd),
        maxDeployableEth: maxDep,
        availableLiquidityEth: liq,
        ok,
        plainEnglish: ok
            ? `Requested ${fmtUsd(usd(req, ethUsd))} looks within a careful size.`
            : `Warning: you asked for ${fmtUsd(usd(req, ethUsd))} but exit liquidity / treasury only safely supports about ${fmtUsd(usd(prudent, ethUsd))}. Shrink the plan.`,
        labels: {
            requested: fmtUsd(usd(req, ethUsd)),
            prudent: fmtUsd(usd(prudent, ethUsd)),
        },
    };
}

/**
 * 9. Exit simulator summary from sequential sell quotes.
 */
function buildExitSimulator({
    bagValueEth,
    exits, // { pct, ethOut, mcapAfter? }[]
    ethUsd,
}) {
    const bag = Number(bagValueEth) || 0;
    const rows = (exits || []).map((e) => {
        const out = Number(e.ethOut) || 0;
        const slip =
            bag > 0 && e.pct > 0
                ? Math.max(0, (1 - out / (bag * (e.pct / 100))) * 100)
                : 0;
        return {
            pct: e.pct,
            ethOut: out,
            usdOut: usd(out, ethUsd),
            slippagePct: slip,
            label: fmtUsd(usd(out, ethUsd)),
            note: e.note || "",
        };
    });
    const full = rows.find((r) => r.pct >= 100) || rows[rows.length - 1];
    const half = rows.find((r) => r.pct === 50);
    return {
        displayedBagEth: bag,
        displayedBagUsd: usd(bag, ethUsd),
        rows,
        plainEnglish:
            full && bag > 0
                ? `Wallets show ${fmtUsd(usd(bag, ethUsd))} but a full exit might only get ~${full.label} (about ${full.slippagePct.toFixed(0)}% haircut). Don’t treat paper value as cash.`
                : "Run a quote to see realistic exit values.",
        labels: {
            bag: fmtUsd(usd(bag, ethUsd)),
            half: half ? half.label : "—",
            full: full ? full.label : "—",
        },
    };
}

/**
 * 11. Portfolio-level risk across projects.
 */
function buildPortfolioRisk({
    funderEth,
    md,
    projects, // [{ id, label, deployedEth, recoveredEth, unrealizedEth, status }]
    ethUsd,
    maxOneTokenPct = 30,
    maxDeployedPct = 60,
}) {
    const treasury = buildTreasurySnapshot({
        funderBalanceEth: funderEth,
        ethUsd,
        md,
        plannedDeployEth: 0,
    });
    const deployed = projects.reduce((a, p) => a + Number(p.deployedEth || 0), 0);
    const recovered = projects.reduce((a, p) => a + Number(p.recoveredEth || 0), 0);
    const unrealized = projects.reduce((a, p) => a + Number(p.unrealizedEth || 0), 0);
    const net = buildNetProfit({
        md,
        sellHistory: [], // caller should pass full history via expenses+sells separately if needed
        ethUsd,
    });
    // Use expenses-only here; realized from project recovered is approximate
    const realizedEth = recovered; // simplified
    const funder = Number(funderEth) || 0;
    const protected = treasury.protectedReserveEth + treasury.lpCapitalEth;
    const available = treasury.maxDeployableEth;
    const deployedPct = funder > 0 ? (deployed / funder) * 100 : 0;
    let maxOnePct = 0;
    let maxOneLabel = "";
    for (const p of projects) {
        const pct = funder > 0 ? (Number(p.deployedEth || 0) / funder) * 100 : 0;
        if (pct > maxOnePct) {
            maxOnePct = pct;
            maxOneLabel = p.label || p.id;
        }
    }
    const warnings = [];
    if (maxOnePct > maxOneTokenPct) {
        warnings.push(
            `${maxOneLabel} is ${maxOnePct.toFixed(0)}% of treasury (limit ${maxOneTokenPct}%)`
        );
    }
    if (deployedPct > maxDeployedPct) {
        warnings.push(
            `${deployedPct.toFixed(0)}% of treasury is deployed (limit ${maxDeployedPct}%)`
        );
    }
    const live = projects.filter((p) => p.status === "live" && Number(p.deployedEth) > Number(p.recoveredEth));
    if (live.length > 1) {
        const principalPositive = projects.filter(
            (p) => Number(p.recoveredEth) >= Number(p.deployedEth) && Number(p.deployedEth) > 0
        );
        if (principalPositive.length < 1 && live.length >= 2) {
            warnings.push(
                "Two+ live launches before any is principal-positive — high correlated risk"
            );
        }
    }

    return {
        ethUsd,
        totalTreasuryEth: funder,
        totalTreasuryUsd: usd(funder, ethUsd),
        protectedReservesEth: protected,
        protectedReservesUsd: usd(protected, ethUsd),
        capitalDeployedEth: deployed,
        capitalDeployedUsd: usd(deployed, ethUsd),
        capitalAvailableEth: available,
        capitalAvailableUsd: usd(available, ethUsd),
        realizedProfitEth: realizedEth - deployed < 0 ? recovered - Math.min(recovered, deployed) : recovered - deployed,
        // clearer:
        capitalRecoveredEth: recovered,
        capitalRecoveredUsd: usd(recovered, ethUsd),
        unrealizedProfitEth: unrealized,
        unrealizedProfitUsd: usd(unrealized, ethUsd),
        maxCorrelatedExposurePct: maxOnePct,
        maxCorrelatedLabel: maxOneLabel,
        deployedPct,
        warnings,
        projects: projects.map((p) => ({
            ...p,
            deployedUsd: usd(p.deployedEth, ethUsd),
            recoveredUsd: usd(p.recoveredEth, ethUsd),
            unrealizedUsd: usd(p.unrealizedEth, ethUsd),
        })),
        plainEnglish:
            warnings.length > 0
                ? `Risk flags: ${warnings[0]}`
                : `Treasury ${fmtUsd(usd(funder, ethUsd))} · spare deployable ${fmtUsd(usd(available, ethUsd))}.`,
        labels: {
            treasury: fmtUsd(usd(funder, ethUsd)),
            protected: fmtUsd(usd(protected, ethUsd)),
            deployed: fmtUsd(usd(deployed, ethUsd)),
            available: fmtUsd(usd(available, ethUsd)),
            recovered: fmtUsd(usd(recovered, ethUsd)),
            unrealized: fmtUsd(usd(unrealized, ethUsd)),
        },
        trueNet: net,
    };
}

/**
 * 12. Post-launch review generator.
 */
function buildPostLaunchReview({
    project,
    md,
    sellHistory,
    ethUsd,
    capital,
    readiness,
    whatWorked = "",
    whatChange = "",
}) {
    const token = project?.token || "";
    const sells = (sellHistory || []).filter(
        (e) =>
            !token ||
            String(e.token || "").toLowerCase() === String(token).toLowerCase()
    );
    const net = buildNetProfit({ md, sellHistory: sells, ethUsd, token });
    const deployed = Number(capital?.deployedEth || 0);
    const recovered = Number(capital?.recoveredEth || 0);
    const review = {
        id: `rev-${Date.now()}`,
        at: new Date().toISOString(),
        projectId: project?.id,
        label: project?.label,
        token,
        initialTreasuryNote: capital?.initialTreasuryEth ?? null,
        totalDeployedEth: deployed,
        totalDeployedUsd: usd(deployed, ethUsd),
        capitalRecoveredEth: recovered,
        capitalRecoveredUsd: usd(recovered, ethUsd),
        trueNetEth: net.trueNetEth,
        trueNetUsd: net.trueNetUsd,
        gasAndFeesUsd: net.deductions.gasUsd,
        failedTxUsd: net.deductions.failedTxUsd,
        marketingUsd: net.deductions.marketingUsd,
        sellCount: sells.length,
        sellTimeline: sells.slice(-50).map((e) => ({
            at: e.at,
            name: e.name,
            ethOut: e.ethOut,
            profitUsd: e.profitUsd,
            hash: e.hash,
        })),
        greenLeafExpiresAt: readiness?.greenLeafExpiresAt || null,
        whatWorked: whatWorked || "",
        whatShouldChange: whatChange || "",
        plainEnglish: `Project ${project?.label || ""}: deployed ${fmtUsd(usd(deployed, ethUsd))}, recovered ${fmtUsd(usd(recovered, ethUsd))}, true net ${net.labels.net}.`,
    };
    return review;
}

function publicMoneyDeskConfig(md) {
    const d = ensureMoneyDesk({ moneyDesk: md });
    return {
        treasury: d.treasury,
        killSwitch: {
            enabled: d.killSwitch.enabled,
            paused: d.killSwitch.paused,
            pauseReason: d.killSwitch.pauseReason,
            maxProjectDrawdownPct: d.killSwitch.maxProjectDrawdownPct,
            maxDailyLossEth: d.killSwitch.maxDailyLossEth,
            maxFailedTxSpendEth: d.killSwitch.maxFailedTxSpendEth,
            minFunderEth: d.killSwitch.minFunderEth,
            maxSaleImpactPct: d.killSwitch.maxSaleImpactPct,
            maxSupplyOwnedPct: d.killSwitch.maxSupplyOwnedPct,
            maxLiquidityDropPct: d.killSwitch.maxLiquidityDropPct,
            maxQuoteDeviationPct: d.killSwitch.maxQuoteDeviationPct,
        },
        readiness: d.readiness,
        lp: d.lp,
        ladder: {
            approved: d.ladder.approved,
            active: d.ladder.active,
            trailProtectPct: d.ladder.trailProtectPct,
            maxSellPctPerWindow: d.ladder.maxSellPctPerWindow,
            minLiquidityEth: d.ladder.minLiquidityEth,
            rungs: d.ladder.rungs,
            completedRungIds: d.ladder.completedRungIds,
        },
    };
}

module.exports = {
    defaultMoneyDesk,
    ensureMoneyDesk,
    publicMoneyDeskConfig,
    usd,
    fmtUsd,
    fmtEth,
    EXPENSE_CATEGORIES,
    INCOME_CATEGORIES,
    addExpense,
    sumExpenses,
    rollDaily,
    buildTreasurySnapshot,
    buildNetProfit,
    buildBreakEven,
    buildProfitLadder,
    evaluateKillSwitch,
    buildLaunchReadiness,
    buildPositionSizing,
    buildExitSimulator,
    buildPortfolioRisk,
    buildPostLaunchReview,
};
