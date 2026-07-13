/**
 * KOA launchpad adapter — Robinhood Chain (4663).
 * Ported from stealth-bundler Jay-Changes (src/launch/platforms/koa/*).
 *
 * Own Uniswap-V3 single-sided-LP factory:
 *   deployTokenDefault(name, symbol, feeRecipient) payable
 *   deployTokenDefaultWithBuy(..., buyAmountETH) payable
 *
 * Env:
 *   KOA_FACTORY_ADDRESS_ROBINHOOD  (default: live factory below)
 *   KOA_FEE_RECIPIENT              (platform fee wallet)
 */
const { ethers } = require("ethers");

const CHAIN_ID = 4663;
const DEFAULT_RPC =
    process.env.ROBINHOOD_RPC_URL ||
    process.env.KOA_RPC_URL ||
    "https://rpc.mainnet.chain.robinhood.com";

const DEFAULT_FACTORY = "0x8997DEA9597b9FBaC05Fc0810FD4DD2005760f0a";
const DEFAULT_FEE_RECIPIENT = "0xA872ea52a5388F74A22A600e395a770Ba5ff3eeE";
const EXPLORER = "https://robinhoodchain.blockscout.com";

const KOA_FACTORY_ABI = [
    "function deployTokenDefault(string name, string symbol, address feeRecipient) payable returns (address token, uint256 tokenId)",
    "function deployTokenDefaultWithBuy(string name, string symbol, address feeRecipient, uint256 buyAmountETH) payable returns (address token, uint256 tokenId, uint256 tokensReceived)",
    "function getFeeInfo() view returns (uint256 minimumFee, uint256 protocolFeeAmount, address feeRecipient)",
    "function getDefaultProfile() view returns (uint256 supply, int24 initialTick, uint24 poolFee, uint256 minimumFee)",
    "event TokenCreatedWithLocker(address tokenAddress, uint256 lpNftId, address deployer, string name, string symbol, uint256 supply, address recipient, uint256 recipientAmount, address lockerAddress, address feeRecipient)",
];

const provider = new ethers.JsonRpcProvider(DEFAULT_RPC, CHAIN_ID);

function isEvmAddress(txt) {
    return typeof txt === "string" && /^0x[0-9a-fA-F]{40}$/.test(txt);
}

function isEvmPrivateKey(txt) {
    if (typeof txt !== "string") return false;
    const h = txt.startsWith("0x") ? txt.slice(2) : txt;
    return /^[0-9a-fA-F]{64}$/.test(h);
}

function factoryAddress() {
    const a = process.env.KOA_FACTORY_ADDRESS_ROBINHOOD || DEFAULT_FACTORY;
    if (!isEvmAddress(a)) {
        throw new Error("KOA_FACTORY_ADDRESS_ROBINHOOD is invalid");
    }
    return ethers.getAddress(a);
}

function feeRecipient() {
    const a = process.env.KOA_FEE_RECIPIENT || DEFAULT_FEE_RECIPIENT;
    if (!isEvmAddress(a)) {
        throw new Error("KOA_FEE_RECIPIENT is invalid");
    }
    return ethers.getAddress(a);
}

async function readFactory() {
    const c = new ethers.Contract(factoryAddress(), KOA_FACTORY_ABI, provider);
    const [feeInfo, profile] = await Promise.all([
        c.getFeeInfo(),
        c.getDefaultProfile(),
    ]);
    return {
        minimumFeeWei: feeInfo.minimumFee ?? feeInfo[0],
        protocolFeeAmount: feeInfo.protocolFeeAmount ?? feeInfo[1],
        factoryFeeRecipient: feeInfo.feeRecipient ?? feeInfo[2],
        supply: profile.supply ?? profile[0],
        initialTick: Number(profile.initialTick ?? profile[1]),
        poolFee: Number(profile.poolFee ?? profile[2]),
    };
}

async function feeOverrides(options = {}) {
    const feeData = await provider.getFeeData();
    const tipBase =
        feeData.maxPriorityFeePerGas || ethers.parseUnits("0.01", "gwei");
    const maxBase = feeData.maxFeePerGas || ethers.parseUnits("0.05", "gwei");
    const mult = Number(options.priorityMultiplier || 1);
    const tip =
        mult > 1
            ? (tipBase * BigInt(Math.round(mult * 100))) / 100n
            : tipBase;
    const maxFee =
        mult > 1 ? (maxBase * BigInt(Math.round(mult * 100))) / 100n : maxBase;
    return {
        maxFeePerGas: maxFee > tip ? maxFee : tip + ethers.parseUnits("0.01", "gwei"),
        maxPriorityFeePerGas: tip,
        gasLimit: BigInt(options.gasLimit || 6_000_000),
    };
}

/**
 * Launch a KOA token. Dev buy is folded into msg.value (factory fee + buy).
 * Post-launch buys/sells use the shared Uniswap V3 path in blockchain.js.
 */
async function launchToken(walletData, options = {}) {
    if (!isEvmPrivateKey(walletData?.private_key || walletData?.privateKey)) {
        throw new Error("Invalid private key");
    }
    const name = String(options.name || "").trim();
    const symbol = String(options.symbol || "").trim();
    if (!name || !symbol) throw new Error("name and symbol required");

    const buyEth = Math.min(
        2,
        Math.max(0, Number(options.buyEth ?? options.devBuyEth ?? 0))
    );
    const pk = walletData.private_key || walletData.privateKey;
    const wallet = new ethers.Wallet(pk, provider);
    const factory = factoryAddress();
    const recipient = feeRecipient();
    const info = await readFactory();
    const buyWei = buyEth > 0 ? ethers.parseEther(String(buyEth)) : 0n;
    const value = info.minimumFeeWei + buyWei;
    const c = new ethers.Contract(factory, KOA_FACTORY_ABI, wallet);
    const fees = await feeOverrides(options);

    if (options.dryRun) {
        let estimateGas = null;
        let staticError = null;
        let simulatedToken = null;
        try {
            if (buyWei > 0n) {
                estimateGas = await c.deployTokenDefaultWithBuy.estimateGas(
                    name,
                    symbol,
                    recipient,
                    buyWei,
                    { value }
                );
                const sim = await c.deployTokenDefaultWithBuy.staticCall(
                    name,
                    symbol,
                    recipient,
                    buyWei,
                    { value }
                );
                simulatedToken = sim.token || sim[0];
            } else {
                estimateGas = await c.deployTokenDefault.estimateGas(
                    name,
                    symbol,
                    recipient,
                    { value }
                );
                const sim = await c.deployTokenDefault.staticCall(
                    name,
                    symbol,
                    recipient,
                    { value }
                );
                simulatedToken = sim.token || sim[0];
            }
            if (estimateGas != null) estimateGas = estimateGas.toString();
        } catch (e) {
            staticError = e.shortMessage || e.message || String(e);
        }
        return {
            dryRun: true,
            token: simulatedToken,
            factory,
            feeRecipient: recipient,
            minimumFeeEth: ethers.formatEther(info.minimumFeeWei),
            buyEth,
            valueEth: ethers.formatEther(value),
            poolFee: info.poolFee,
            estimateGas,
            staticError,
            launchpad: "koa",
            chainId: CHAIN_ID,
            note: "Simulated only — not broadcast",
        };
    }

    let tx;
    try {
        tx =
            buyWei > 0n
                ? await c.deployTokenDefaultWithBuy(
                      name,
                      symbol,
                      recipient,
                      buyWei,
                      { value, ...fees }
                  )
                : await c.deployTokenDefault(name, symbol, recipient, {
                      value,
                      ...fees,
                  });
    } catch (e) {
        return {
            error: e.shortMessage || e.message || String(e),
            hash: null,
            launchpad: "koa",
        };
    }

    const receipt = await tx.wait();
    if (receipt.status !== 1) {
        return {
            error: `KOA launch reverted: ${tx.hash}`,
            hash: tx.hash,
            launchpad: "koa",
        };
    }

    let token = null;
    let tokenId = null;
    for (const log of receipt.logs || []) {
        try {
            const parsed = c.interface.parseLog(log);
            if (parsed?.name === "TokenCreatedWithLocker") {
                token = parsed.args.tokenAddress || parsed.args[0];
                break;
            }
        } catch (_) {}
    }
    // Fallback: decode return data is not on receipt; try static from known pattern
    if (!token && receipt.logs?.length) {
        // last resort — look for any address-looking topic (unlikely needed)
    }

    return {
        token: token ? ethers.getAddress(token) : null,
        tokenId,
        hash: tx.hash,
        factory,
        feeRecipient: recipient,
        minimumFeeEth: ethers.formatEther(info.minimumFeeWei),
        buyEth,
        valueEth: ethers.formatEther(value),
        poolFee: info.poolFee,
        launchpad: "koa",
        chainId: CHAIN_ID,
        explorer: `${EXPLORER}/tx/${tx.hash}`,
        koaUrl: token
            ? `${EXPLORER}/token/${ethers.getAddress(token)}`
            : null,
        noxaUrl: token
            ? `${EXPLORER}/token/${ethers.getAddress(token)}`
            : null,
    };
}

async function ping() {
    try {
        const block = await provider.getBlockNumber();
        const info = await readFactory();
        return {
            ok: true,
            launchpad: "koa",
            chainId: CHAIN_ID,
            block,
            factory: factoryAddress(),
            feeRecipient: feeRecipient(),
            minimumFeeEth: ethers.formatEther(info.minimumFeeWei),
            poolFee: info.poolFee,
            supply: info.supply?.toString?.() || String(info.supply),
            rpc: DEFAULT_RPC,
        };
    } catch (e) {
        return { ok: false, launchpad: "koa", error: e.message };
    }
}

module.exports = {
    CHAIN_ID,
    provider,
    isEvmAddress,
    isEvmPrivateKey,
    factoryAddress,
    feeRecipient,
    readFactory,
    launchToken,
    ping,
    DEFAULT_FACTORY,
    DEFAULT_FEE_RECIPIENT,
};
