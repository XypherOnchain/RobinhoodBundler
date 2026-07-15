/**
 * Privacy bridge — ChangeNOW + Across with mandatory key persistence (B2/S1/S2).
 *
 * Default anti-InsightX / Bubblemaps fund path:
 *   1) Persist unique Base (+ optional RH) legs BEFORE any pay
 *   2) Unique ChangeNOW order: eth → ethbase per Base leg
 *   3) Pay CN from mainnet vault
 *   4) Across Base → unique RH buyer (depositor ≠ recipient; no shared treasury edge)
 *
 * Shared-treasury / hop-only funding is refused by analyzeFundingLinkage + fund gate.
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { ethers } = require("ethers");
const safety = require("./wallet-safety");
const jobLog = require("./job-log");

const ZERO = "0x0000000000000000000000000000000000000000";
const ACROSS = process.env.ACROSS_API_URL || "https://app.across.to/api";
const CN_API = process.env.CHANGENOW_API_URL || "https://api.changenow.io";
const RH = 4663;
const BASE = 8453;
const ETH = 1;

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const MAINNET_RPC =
  process.env.MAINNET_RPC_URL ||
  process.env.ETH_RPC_URL ||
  "https://ethereum.publicnode.com";
const RH_RPC =
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, BASE);
const mainnetProvider = new ethers.JsonRpcProvider(MAINNET_RPC, ETH);
const rhProvider = new ethers.JsonRpcProvider(RH_RPC, RH);

function cnKey() {
  return process.env.CHANGENOW_API_KEY || "";
}

function resolveVaultPk(overridePk) {
  return (
    overridePk ||
    process.env.MAINNET_VAULT_PK ||
    process.env.PRIVACY_VAULT_PK ||
    process.env.ETH_VAULT_PK ||
    process.env.FUNDER_PRIVATE_KEY ||
    ""
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acrossQuote(o) {
  const amountWei =
    o.amountWei != null
      ? BigInt(o.amountWei)
      : ethers.parseEther(String(o.amountEth || 0));
  const params = new URLSearchParams({
    tradeType: "exactInput",
    amount: amountWei.toString(),
    inputToken: ZERO,
    originChainId: String(o.originChainId || BASE),
    outputToken: ZERO,
    destinationChainId: String(o.destinationChainId || RH),
    depositor: ethers.getAddress(o.depositor),
    recipient: ethers.getAddress(o.recipient),
  });
  const { data } = await axios.get(`${ACROSS}/swap/approval?${params}`, {
    timeout: 30000,
  });
  if (!data?.swapTx?.to) {
    throw new Error(data?.message || data?.error || "across quote failed");
  }
  return {
    ...data,
    amountWei: amountWei.toString(),
    expectedOutEth: Number(
      ethers.formatEther(BigInt(data.expectedOutputAmount || 0))
    ),
    minOutEth: Number(ethers.formatEther(BigInt(data.minOutputAmount || 0))),
  };
}

/**
 * Generate N unique Base+RH wallet pairs, PERSIST keys, then return legs file path.
 * Call this BEFORE creating ChangeNOW orders.
 */
function prepareCleanLegs(n, jobId, meta = {}) {
  const count = Math.min(64, Math.max(1, Number(n) || 1));
  const id = jobId || `clean-${Date.now()}`;
  const legs = [];
  for (let i = 0; i < count; i++) {
    const baseW = ethers.Wallet.createRandom();
    const rhW = ethers.Wallet.createRandom();
    const buyer = Array.isArray(meta.buyers) ? meta.buyers[i] : null;
    legs.push({
      name: buyer?.name || `P${i + 1}`,
      address: baseW.address,
      privateKey: baseW.privateKey,
      baseAddress: baseW.address,
      basePk: baseW.privateKey,
      rhAddress: rhW.address,
      rhPk: rhW.privateKey,
      // Across recipient on RH = existing buyer (unique ancestry from Base leg)
      buyerAddress: buyer?.address || null,
      amountEth: buyer?.amountEth != null ? Number(buyer.amountEth) : null,
      meta: { buyerName: buyer?.name || null },
    });
  }
  const saved = safety.persistLegsBeforePay(id, legs, {
    purpose: "anti-bubblemaps / InsightX clean funding legs",
  });
  jobLog.appendJobEvent(id, {
    type: "legs_persisted",
    count: saved.count,
    path: saved.path,
    checksum: saved.checksum,
  });
  return {
    jobId: id,
    ...saved,
    legs: legs.map((l) => ({
      name: l.name,
      baseAddress: l.baseAddress,
      rhAddress: l.rhAddress,
      buyerAddress: l.buyerAddress,
      amountEth: l.amountEth,
    })),
  };
}

async function changeNowEstimate(amountEth, from = "eth", to = "ethbase") {
  const { data } = await axios.get(
    `${CN_API}/v1/exchange-amount/${amountEth}/${from}_${to}`,
    { timeout: 20000 }
  );
  return {
    from,
    to,
    amountIn: Number(amountEth),
    estimatedOut: Number(data.estimatedAmount || 0),
    speed: data.transactionSpeedForecast || null,
    warning: data.warningMessage || null,
  };
}

async function createChangeNowOrder({
  amountEth,
  toAddress,
  refundAddress,
  from = "eth",
  to = "ethbase",
}) {
  const key = cnKey();
  if (!key) throw new Error("CHANGENOW_API_KEY not set");
  // Destination must be a Base leg we control (keys on disk)
  safety.assertCanSendTo(toAddress, { requireControlled: true });
  const { data } = await axios.post(
    `${CN_API}/v1/transactions/${key}`,
    {
      from,
      to,
      amount: Number(Number(amountEth).toFixed(8)),
      address: ethers.getAddress(toAddress),
      refundAddress: refundAddress
        ? ethers.getAddress(refundAddress)
        : undefined,
      flow: "standard",
      type: "direct",
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );
  return {
    id: data.id,
    status: data.status,
    payinAddress: data.payinAddress,
    payinExtraId: data.payinExtraId || null,
    from,
    to,
    amountFrom: data.amountFrom || amountEth,
    amountTo: data.amountTo || null,
    payoutAddress: data.payoutAddress || toAddress,
    trackUrl: data.id ? `https://changenow.io/exchange/txs/${data.id}` : null,
    raw: data,
  };
}

async function changeNowStatus(id) {
  const key = cnKey();
  if (!key) throw new Error("CHANGENOW_API_KEY not set");
  const { data } = await axios.get(`${CN_API}/v1/transactions/${id}/${key}`, {
    timeout: 20000,
  });
  return data;
}

/**
 * Pay ChangeNOW payin from mainnet vault. Payin is external (allowExternal).
 */
async function payChangeNowFromVault({
  payinAddress,
  amountEth,
  vaultPk,
}) {
  const pk = resolveVaultPk(vaultPk);
  if (!pk) {
    throw new Error(
      "MAINNET_VAULT_PK (or PRIVACY_VAULT_PK) required to pay ChangeNOW — refuse shared RH treasury hops"
    );
  }
  safety.assertCanSendTo(payinAddress, { allowExternal: true });
  const wallet = new ethers.Wallet(pk, mainnetProvider);
  const value = ethers.parseEther(String(Number(amountEth).toFixed(8)));
  const bal = await mainnetProvider.getBalance(wallet.address);
  if (bal < value) {
    throw new Error(
      `Mainnet vault underfunded: have ${ethers.formatEther(bal)} need ${ethers.formatEther(value)} ETH at ${wallet.address}`
    );
  }
  const tx = await wallet.sendTransaction({
    to: ethers.getAddress(payinAddress),
    value,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`ChangeNOW payin failed: ${tx.hash}`);
  }
  return {
    hash: tx.hash,
    from: wallet.address,
    to: payinAddress,
    amountEth: Number(amountEth),
    explorer: `https://etherscan.io/tx/${tx.hash}`,
  };
}

/**
 * Across Base → RH using a per-leg Base key (unique depositor — anti-cluster).
 */
async function acrossBridgeFromBaseLeg({
  basePk,
  amountEth,
  recipient,
  leaveGasEth = 0.00008,
}) {
  if (!basePk) throw new Error("acrossBridgeFromBaseLeg: basePk required");
  // RH buyer is a store wallet we control; Across spoke is the on-chain source.
  safety.assertCanSendTo(recipient, { requireControlled: false });
  const wallet = new ethers.Wallet(basePk, baseProvider);
  const bal = await baseProvider.getBalance(wallet.address);
  const leave = ethers.parseEther(String(leaveGasEth));
  let amountWei =
    amountEth != null
      ? ethers.parseEther(String(amountEth))
      : bal > leave
        ? bal - leave
        : bal;
  if (amountWei <= 0n) {
    throw new Error(`Base leg ${wallet.address} has no ETH to bridge`);
  }
  if (bal < amountWei + leave && bal > leave) {
    amountWei = bal - leave;
  }
  if (bal < amountWei) {
    throw new Error(
      `Base leg underfunded: have ${ethers.formatEther(bal)} need ≥ ${ethers.formatEther(amountWei)}`
    );
  }

  const quote = await acrossQuote({
    amountWei,
    depositor: wallet.address,
    recipient,
    originChainId: BASE,
    destinationChainId: RH,
  });

  for (const a of quote.approvalTxns || []) {
    const atx = await wallet.sendTransaction({
      to: a.to,
      data: a.data,
      value: a.value ? BigInt(a.value) : 0n,
      chainId: BASE,
    });
    await atx.wait();
  }

  const tx = await wallet.sendTransaction({
    to: quote.swapTx.to,
    data: quote.swapTx.data || "0x",
    value: BigInt(quote.swapTx.value || 0),
    chainId: Number(quote.swapTx.chainId || BASE),
    gasLimit: quote.swapTx.gas ? BigInt(quote.swapTx.gas) : undefined,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`Across bridge reverted: ${tx.hash}`);
  }
  return {
    hash: tx.hash,
    depositor: wallet.address,
    recipient: ethers.getAddress(recipient),
    amountWei: amountWei.toString(),
    expectedOutEth: quote.expectedOutEth,
    explorer: `https://basescan.org/tx/${tx.hash}`,
    quote,
  };
}

function preflightCleanCycle(legsFile) {
  return safety.assertLegsReadyForPay(legsFile);
}

function loadLegs(legsFile) {
  safety.assertLegsReadyForPay(legsFile);
  return JSON.parse(fs.readFileSync(legsFile, "utf8"));
}

/**
 * Pad RH need → CN mainnet send (CN fee + Across fee + Base gas).
 */
function padCnAmountEth(needRhEth) {
  const need = Math.max(0, Number(needRhEth) || 0);
  // ~4% slip/fees + 0.001 Base/Across buffer
  return Math.round((need * 1.04 + 0.001) * 1e6) / 1e6;
}

/**
 * Hard gate: shared treasury / hop-only funding recreates InsightX/Bubblemaps edges.
 * Returns { ok, refuse, code, message, warnings }.
 */
function analyzeFundingLinkage(wallets, options = {}) {
  const buyers = (wallets || []).filter(
    (w) =>
      String(w.role || "buyer").toLowerCase() === "buyer" ||
      /^C-\d+/i.test(w.name || "") ||
      /^W\d/i.test(w.name || "")
  );
  const warnings = [];
  const mode = String(options.mode || options.fundingMode || "").toLowerCase();
  const privacyBreak =
    options.privacyBreak === true ||
    mode === "changenow" ||
    mode === "clean" ||
    mode === "privacy";
  const hops = Number(options.hops ?? 0);
  const sharedTreasuryPath =
    options.sharedTreasury === true ||
    mode === "hops" ||
    mode === "hop" ||
    mode === "distributors" ||
    mode === "treasury" ||
    (mode === "" && options.assumeHops !== false && !privacyBreak);

  warnings.push({
    code: "router_no_unlink",
    severity: "info",
    message:
      "Router transfers (1inch/Uni) do NOT clear Bubblemaps/InsightX history. Only unique funding ancestry does.",
  });

  if (buyers.length >= 2 && sharedTreasuryPath) {
    warnings.push({
      code: "shared_treasury_edge",
      severity: "error",
      message: `REFUSE: ${buyers.length} buyers funded from one treasury/hop tree recreates InsightX/Bubblemaps cluster. Use ChangeNOW clean fund (unique Base legs → Across → each buyer).`,
    });
  } else if (buyers.length >= 4 && !privacyBreak) {
    warnings.push({
      code: "shared_treasury_risk",
      severity: "error",
      message: `REFUSE: ${buyers.length} buyers without ChangeNOW privacy break — shared treasury edge will cluster. Default fund = ChangeNOW.`,
    });
  }

  if (!privacyBreak && hops > 0 && hops < 2 && buyers.length >= 2) {
    warnings.push({
      code: "weak_hops",
      severity: "error",
      message:
        "REFUSE: hop-only funding is not an InsightX/Bubblemaps unlink. Use ChangeNOW clean legs.",
    });
  }

  if (!privacyBreak && buyers.length >= 2) {
    warnings.push({
      code: "no_privacy_break",
      severity: "error",
      message:
        "REFUSE: no ChangeNOW privacy break. Default Send cash uses ChangeNOW → Across, not hops.",
    });
  }

  if (privacyBreak && !cnKey()) {
    warnings.push({
      code: "changenow_key_missing",
      severity: "error",
      message: "CHANGENOW_API_KEY not set — cannot run default clean fund.",
    });
  }

  if (
    privacyBreak &&
    options.vaultPk !== "skip" &&
    !resolveVaultPk(options.vaultPk)
  ) {
    warnings.push({
      code: "vault_pk_missing",
      severity: "warn",
      message:
        "No mainnet vault PK in env — Send cash will use the dashboard funder key on Ethereum mainnet to pay ChangeNOW (same PK, different chain).",
    });
  }

  const errors = warnings.filter((w) => w.severity === "error");
  return {
    buyerCount: buyers.length,
    mode: privacyBreak ? "changenow" : mode || "hops",
    privacyBreak: !!privacyBreak,
    ok: errors.length === 0,
    refuse: errors.length > 0,
    code: errors[0]?.code || null,
    message: errors[0]?.message || null,
    warnings,
  };
}

/**
 * Refuse shared-treasury fund paths. Call before hop disperse.
 */
function assertCleanFundRequired(wallets, options = {}) {
  const analysis = analyzeFundingLinkage(wallets, {
    ...options,
    privacyBreak: false,
    sharedTreasury: true,
    mode: options.mode || "hops",
  });
  if (analysis.refuse || !analysis.ok) {
    const err = new Error(
      analysis.message ||
        "REFUSE: shared treasury / hop funding blocked (InsightX/Bubblemaps)"
    );
    err.code = analysis.code || "shared_treasury_edge";
    err.analysis = analysis;
    throw err;
  }
  return analysis;
}

async function waitChangeNowFinished(id, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45 * 60 * 1000);
  const pollMs = Number(options.pollMs || 15000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (options.shouldAbort?.()) throw new Error("aborted");
    const st = await changeNowStatus(id);
    const status = String(st.status || "").toLowerCase();
    if (options.onProgress) {
      await options.onProgress({ type: "cn_status", id, status, raw: st });
    }
    if (status === "finished" || status === "completed") return st;
    if (
      status === "failed" ||
      status === "refunded" ||
      status === "expired"
    ) {
      throw new Error(`ChangeNOW ${id} ended as ${status}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`ChangeNOW ${id} timeout after ${timeoutMs}ms`);
}

async function waitBaseBalance(address, minEth, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45 * 60 * 1000);
  const pollMs = Number(options.pollMs || 12000);
  const minWei = ethers.parseEther(String(minEth));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (options.shouldAbort?.()) throw new Error("aborted");
    const bal = await baseProvider.getBalance(address);
    if (options.onProgress) {
      await options.onProgress({
        type: "base_bal",
        address,
        balEth: Number(ethers.formatEther(bal)),
      });
    }
    if (bal >= minWei) return bal;
    await sleep(pollMs);
  }
  throw new Error(
    `Base ${address} never reached ${minEth} ETH within timeout`
  );
}

/**
 * End-to-end clean fund for buyer list.
 * buyers: [{ name, address, amountEth }]
 */
async function runCleanFundCycle(buyers, options = {}) {
  const list = (buyers || []).filter(
    (b) => b?.address && Number(b.amountEth || b.buyAmountEth) > 0
  );
  if (!list.length) throw new Error("No buyers to clean-fund");
  if (!cnKey()) throw new Error("CHANGENOW_API_KEY not set");
  const vaultPk = resolveVaultPk(options.vaultPk);
  if (!vaultPk) {
    throw new Error(
      "MAINNET_VAULT_PK required for ChangeNOW clean fund — hop funding is refused"
    );
  }

  const jobId = options.jobId || `clean-fund-${Date.now()}`;
  const prepared = prepareCleanLegs(
    list.length,
    jobId,
    {
      buyers: list.map((b) => ({
        name: b.name,
        address: b.address,
        amountEth: Number(b.amountEth || b.buyAmountEth),
      })),
    }
  );
  preflightCleanCycle(prepared.path);
  const disk = loadLegs(prepared.path);
  const onProgress = options.onProgress || (async () => {});
  const shouldAbort = options.shouldAbort || (() => false);
  const refundAddress =
    options.refundAddress ||
    (() => {
      try {
        return new ethers.Wallet(vaultPk).address;
      } catch {
        return null;
      }
    })();

  const results = [];
  for (let i = 0; i < disk.legs.length; i++) {
    if (shouldAbort()) break;
    const leg = disk.legs[i];
    const buyer = list[i];
    const needRh = Number(buyer.amountEth || buyer.buyAmountEth);
    const cnAmount = padCnAmountEth(needRh);
    const row = {
      name: buyer.name || leg.name,
      buyerAddress: buyer.address,
      baseAddress: leg.baseAddress,
      amountEth: needRh,
      cnAmountEth: cnAmount,
      ok: false,
    };

    try {
      await onProgress({
        type: "leg_start",
        index: i,
        name: row.name,
        buyerAddress: row.buyerAddress,
        baseAddress: row.baseAddress,
        cnAmountEth: cnAmount,
      });

      // Keys already on disk — create CN order to THIS Base leg only
      const order = await createChangeNowOrder({
        amountEth: cnAmount,
        toAddress: leg.baseAddress,
        refundAddress,
      });
      row.cnId = order.id;
      row.payinAddress = order.payinAddress;
      await onProgress({
        type: "cn_created",
        name: row.name,
        id: order.id,
        payin: order.payinAddress,
        trackUrl: order.trackUrl,
      });

      const pay = await payChangeNowFromVault({
        payinAddress: order.payinAddress,
        amountEth: cnAmount,
        vaultPk,
      });
      row.payHash = pay.hash;
      await onProgress({
        type: "cn_paid",
        name: row.name,
        hash: pay.hash,
        explorer: pay.explorer,
      });

      await waitChangeNowFinished(order.id, {
        shouldAbort,
        onProgress,
        timeoutMs: options.cnTimeoutMs,
      });
      await onProgress({ type: "cn_finished", name: row.name, id: order.id });

      // Wait until Base has most of expected payout (use ~70% of need as floor)
      const minBase = Math.max(needRh * 0.7, 0.0005);
      await waitBaseBalance(leg.baseAddress, minBase, {
        shouldAbort,
        onProgress,
        timeoutMs: options.baseTimeoutMs,
      });

      const bridge = await acrossBridgeFromBaseLeg({
        basePk: leg.basePk,
        recipient: buyer.address,
        // bridge almost all Base balance minus gas
        amountEth: null,
      });
      row.acrossHash = bridge.hash;
      row.expectedOutEth = bridge.expectedOutEth;
      row.ok = true;
      await onProgress({
        type: "across_done",
        name: row.name,
        hash: bridge.hash,
        recipient: buyer.address,
        explorer: bridge.explorer,
      });

      jobLog.appendJobEvent(jobId, {
        type: "leg_complete",
        name: row.name,
        buyer: buyer.address,
        cnId: order.id,
        acrossHash: bridge.hash,
      });
    } catch (e) {
      row.error = e.message;
      await onProgress({
        type: "error",
        name: row.name,
        error: e.message,
      });
      jobLog.appendJobEvent(jobId, {
        type: "leg_error",
        name: row.name,
        error: e.message,
      });
    }
    results.push(row);
  }

  const okN = results.filter((r) => r.ok).length;
  return {
    jobId,
    legsFile: prepared.path,
    checksum: prepared.checksum,
    ok: okN,
    total: results.length,
    results,
  };
}

module.exports = {
  prepareCleanLegs,
  createChangeNowOrder,
  changeNowEstimate,
  changeNowStatus,
  payChangeNowFromVault,
  acrossBridgeFromBaseLeg,
  preflightCleanCycle,
  loadLegs,
  acrossQuote,
  analyzeFundingLinkage,
  assertCleanFundRequired,
  runCleanFundCycle,
  padCnAmountEth,
  resolveVaultPk,
  cnKey,
  RH,
  BASE,
  ETH,
  ACROSS,
};
