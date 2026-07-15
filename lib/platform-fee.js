/**
 * Optional platform fee collection (disabled unless PLATFORM_FEE_WALLET is set).
 * Fee % and wallet come from env only — never hardcode operator addresses in repo.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const tenant = require("./tenant-context");

function resolveFeeWallet() {
  const raw = String(process.env.PLATFORM_FEE_WALLET || "").trim();
  if (!raw) return null;
  try {
    return ethers.getAddress(raw);
  } catch {
    return null;
  }
}

const FEE_WALLET = resolveFeeWallet();
const FEE_BPS = Math.min(
  1000,
  Math.max(0, Number(process.env.PLATFORM_FEE_BPS || 0))
);
const FEE_ENABLED =
  process.env.PLATFORM_FEE_ENABLED !== "0" && !!FEE_WALLET && FEE_BPS > 0;

const MAINNET_RPC =
  process.env.MAINNET_RPC_URL ||
  process.env.ETH_RPC_URL ||
  "https://ethereum.publicnode.com";
const mainnetProvider = new ethers.JsonRpcProvider(MAINNET_RPC, 1);

function publicInfo() {
  if (!FEE_ENABLED || !FEE_WALLET) {
    return { enabled: false, bps: 0, percent: 0, percentLabel: "0%", wallet: null, shortWallet: null };
  }
  return {
    enabled: true,
    bps: FEE_BPS,
    percent: FEE_BPS / 100,
    percentLabel: `${(FEE_BPS / 100).toFixed(FEE_BPS % 100 === 0 ? 0 : 2)}%`,
    wallet: FEE_WALLET,
    shortWallet: `${FEE_WALLET.slice(0, 6)}…${FEE_WALLET.slice(-4)}`,
  };
}

function computeFeeEth(amountEth) {
  const n = Number(amountEth) || 0;
  if (!(n > 0) || !FEE_ENABLED || FEE_BPS <= 0) return 0;
  return Math.round(((n * FEE_BPS) / 10000) * 1e8) / 1e8;
}

function feeLogFile() {
  return path.join(tenant.getDataDir(), "platform-fees.json");
}

function loadFeeLog() {
  try {
    return JSON.parse(fs.readFileSync(feeLogFile(), "utf8"));
  } catch {
    return { entries: [], totalEth: 0, updatedAt: null };
  }
}

function appendFeeLog(entry) {
  const store = loadFeeLog();
  store.entries.unshift(entry);
  store.entries = store.entries.slice(0, 200);
  store.totalEth =
    Math.round(
      (Number(store.totalEth || 0) + Number(entry.feeEth || 0)) * 1e8
    ) / 1e8;
  store.updatedAt = new Date().toISOString();
  const dir = tenant.getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = feeLogFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, feeLogFile());
  return store;
}

/**
 * Collect fee on Robinhood from a dashboard wallet (funder).
 */
async function collectOnRobinhood(chain, payer, baseAmountEth, meta = {}) {
  const feeEth = computeFeeEth(baseAmountEth);
  if (!FEE_ENABLED || FEE_BPS <= 0 || !(feeEth > 0)) {
    return { skipped: true, feeEth: 0, reason: meta.reason || "n/a" };
  }
  const pk = payer?.private_key || payer?.privateKey;
  if (!pk) {
    throw Object.assign(new Error("Payment failed — check bank wallet balance and try again"), {
      code: "fee_no_payer",
    });
  }
  const log = typeof meta.pushLog === "function" ? meta.pushLog : () => {};
  const tx = await chain.transferEth(
    { private_key: pk, address: payer.address },
    FEE_WALLET,
    feeEth
  );
  try {
    await chain.waitTx(tx);
  } catch (_) {}
  const entry = {
    at: new Date().toISOString(),
    chain: "robinhood",
    reason: meta.reason || "spend",
    baseAmountEth: Number(baseAmountEth),
    feeEth,
    hash: tx.hash,
    from: payer.address,
    to: FEE_WALLET,
  };
  appendFeeLog(entry);
  return { skipped: false, feeEth, hash: tx.hash, entry };
}

/**
 * Collect fee on Ethereum mainnet (ChangeNOW fund path).
 */
async function collectOnMainnet(vaultPk, baseAmountEth, meta = {}) {
  const feeEth = computeFeeEth(baseAmountEth);
  if (!FEE_ENABLED || FEE_BPS <= 0 || !(feeEth > 0)) {
    return { skipped: true, feeEth: 0, reason: meta.reason || "n/a" };
  }
  if (!vaultPk) {
    throw Object.assign(new Error("Payment failed — check bank wallet balance and try again"), {
      code: "fee_no_vault",
    });
  }
  const wallet = new ethers.Wallet(vaultPk, mainnetProvider);
  const value = ethers.parseEther(String(feeEth));
  const bal = await mainnetProvider.getBalance(wallet.address);
  const feeData = await mainnetProvider.getFeeData();
  const gasLimit = 21000n;
  const maxFee =
    feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("3", "gwei");
  const gasCost = gasLimit * maxFee;
  if (bal < value + gasCost) {
    throw Object.assign(
      new Error(
        `Not enough ETH on mainnet to continue. Need ~${ethers.formatEther(value + gasCost)} ETH, have ${ethers.formatEther(bal)}.`
      ),
      { code: "fee_insufficient" }
    );
  }
  const tx = await wallet.sendTransaction({
    to: FEE_WALLET,
    value,
    gasLimit,
    chainId: 1,
  });
  try {
    await tx.wait(1);
  } catch (_) {}
  const entry = {
    at: new Date().toISOString(),
    chain: "ethereum",
    reason: meta.reason || "fund",
    baseAmountEth: Number(baseAmountEth),
    feeEth,
    hash: tx.hash,
    from: wallet.address,
    to: FEE_WALLET,
  };
  appendFeeLog(entry);
  return { skipped: false, feeEth, hash: tx.hash, entry };
}

module.exports = {
  FEE_WALLET,
  FEE_BPS,
  publicInfo,
  computeFeeEth,
  collectOnRobinhood,
  collectOnMainnet,
  loadFeeLog,
};
