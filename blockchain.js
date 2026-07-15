const axios = require("axios");
const { ethers } = require("ethers");
const { HttpsProxyAgent } = require("https-proxy-agent");

const dotenv = require("dotenv");
dotenv.config();

const proxyUrl = process.env.PROXY_URL;

// Robinhood Chain (NOXA Fun) — https://fun.noxa.fi/robinhood
const CHAIN_ID = 4663;
const RPC_URL =
    process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const API_URL =
    process.env.NOXA_API_URL ||
    "https://awk00kk00gskkw0o8kc488kg.notoriouslywrong.com";
const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
// NOXA launch factory on Robinhood — source of truth for brand-new pairs
const LAUNCH_FACTORY =
    process.env.NOXA_LAUNCH_FACTORY ||
    "0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB";
// topic0 of the TokenCreated-style event (token, creator, factory/pool indexed)
const LAUNCH_CREATED_TOPIC =
    "0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a";
const DEFAULT_POOL_FEE = 10000; // 1% — NOXA default on Robinhood
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 100); // 1%

/** Liquidity-driven auto-slippage (ported from stealth-bundler). */
function autoSlippageBps(liquidityUsd) {
    const n = Number(liquidityUsd) || 0;
    if (n >= 100_000) return 300;
    if (n >= 50_000) return 500;
    if (n >= 10_000) return 700;
    return 1000;
}
const ROUTER_CONTRACT_ADDRESS = ROUTER;
// Extra ETH left on each buyer so buy txs can pay gas (value + gas)
const BUYER_GAS_BUFFER_ETH = Number(process.env.BUYER_GAS_BUFFER_ETH || 0.002);
const HOP_GAS_RESERVE_ETH = Number(process.env.HOP_GAS_RESERVE_ETH || 0.0005);

// NOXA Robinhood launch defaults
const NOXA_DEFAULT_SUPPLY = 1_000_000_000; // 1B
const NOXA_STARTING_MC_ETH = 1.36; // from initialTick -204200
const NOXA_MAX_WALLET_BPS = 200; // 2%
const NOXA_BONDING_TARGET_ETH = 4.2;
// Soft cap for bundler wallet count (create / plan / apply)
const MAX_BUNDLE_WALLETS = Number(process.env.MAX_BUNDLE_WALLETS || 500);

// ETH/USD for MC display (cached). Override with ETH_USD_PRICE env if needed.
let _ethUsdCache = { price: Number(process.env.ETH_USD_PRICE) || 0, at: 0 };
const ETH_USD_CACHE_MS = 60_000;

async function getEthUsdPrice() {
    if (
        _ethUsdCache.price > 0 &&
        Date.now() - _ethUsdCache.at < ETH_USD_CACHE_MS
    ) {
        return _ethUsdCache.price;
    }
    if (Number(process.env.ETH_USD_PRICE) > 0) {
        _ethUsdCache = {
            price: Number(process.env.ETH_USD_PRICE),
            at: Date.now(),
        };
        return _ethUsdCache.price;
    }
    try {
        const r = await axios.get(
            "https://api.coingecko.com/api/v3/simple/price",
            {
                params: { ids: "ethereum", vs_currencies: "usd" },
                timeout: 8000,
            }
        );
        const price = Number(r.data?.ethereum?.usd || 0);
        if (price > 0) {
            _ethUsdCache = { price, at: Date.now() };
            return price;
        }
    } catch (_) {}
    // Fallback so UI still shows something readable if oracle is down
    return _ethUsdCache.price > 0 ? _ethUsdCache.price : 3500;
}

function ethToUsd(eth, ethUsd) {
    const n = Number(eth);
    const px = Number(ethUsd || 0);
    if (!Number.isFinite(n) || !(px > 0)) return null;
    return n * px;
}

function formatUsd(n, digits = 0) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    let body;
    if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(2)}M`;
    else if (abs >= 10_000) body = Math.round(abs).toLocaleString("en-US");
    else if (abs >= 1000) body = abs.toFixed(0);
    else if (abs >= 1) body = abs.toFixed(digits || 2);
    else body = abs.toFixed(Math.max(digits || 2, 2));
    return `${sign}$${body}`;
}

/** Signed P&L style: +$12.34 / -$5.00 */
function formatUsdSigned(n, digits = 2) {
    if (n == null || !Number.isFinite(n)) return "—";
    if (n > 0) return `+${formatUsd(n, digits)}`;
    return formatUsd(n, digits);
}


/**
 * Parse total supply into human token units.
 * NOXA may return wei ("1e27" for 1B@18dec) OR human ("1000000000").
 * Long digit strings (>18 chars) are always treated as wei.
 */
function parseTokenSupply(tokenLike, decimals = 18) {
    const t = tokenLike?.token || tokenLike || {};
    const raw = t.supply ?? t.totalSupply ?? tokenLike?.supply ?? tokenLike?.totalSupply;
    if (raw == null || raw === "") return NOXA_DEFAULT_SUPPLY;
    const asStr = String(raw).trim().split(".")[0];
    const dec = Number(decimals) || 18;

    // Wei: very long integer (1B * 1e18 = 28 digits)
    if (/^\d+$/.test(asStr) && asStr.length > 18) {
        try {
            const formatted = Number(ethers.formatUnits(asStr, dec));
            if (Number.isFinite(formatted) && formatted > 0) return formatted;
        } catch (_) {}
    }

    const asNum = Number(asStr);
    // Human-readable supply (1e6 .. 1e15) — typical memecoin ranges
    if (Number.isFinite(asNum) && asNum >= 1e6 && asNum <= 1e15) {
        return asNum;
    }

    // Fallback: try formatUnits anyway
    try {
        const formatted = Number(ethers.formatUnits(asStr, dec));
        if (Number.isFinite(formatted) && formatted >= 1) return formatted;
    } catch (_) {}

    return Number.isFinite(asNum) && asNum > 0 ? asNum : NOXA_DEFAULT_SUPPLY;
}

/** Sync MC from API fields only (may be stale). Prefer resolveLiveMarketCap for plans. */
function resolveMarketCapEth(tokenLike) {
    const t = tokenLike?.token || tokenLike || {};
    const apiMc = Number(t.marketCapEth || tokenLike?.marketCapEth || 0);
    const priceEth = Number(t.priceEth || tokenLike?.priceEth || 0);
    const decimals = Number(t.decimals ?? tokenLike?.decimals ?? 18);
    const supply = parseTokenSupply(tokenLike, decimals);
    const fdv = priceEth > 0 && supply > 0 ? priceEth * supply : 0;
    // If API MC and price*supply disagree wildly, prefer FDV from price
    if (apiMc > 0 && fdv > 0) {
        const ratio = apiMc / fdv;
        if (ratio > 0.5 && ratio < 2) return apiMc;
        // price*supply more consistent with itself when API MC is stale/wrong units
        return fdv;
    }
    if (apiMc > 0) return apiMc;
    return fdv;
}

/**
 * Live market cap from Uniswap quoter (spot sample × supply).
 * API marketCapEth on NOXA can lag badly — never trust it alone for the ladder.
 */
async function resolveLiveMarketCap(tokenAddress, tokenInfo, options = {}) {
    const info =
        tokenInfo ||
        (await resolveTokenInfo(tokenAddress, {
            fee: options.fee,
            pairedToken: options.pairedToken,
        }));
    const t = info.token || info;
    const decimals = Number(t.decimals ?? 18);
    const supply = parseTokenSupply(info, decimals);
    const ethUsd = Number(options.ethUsd) || (await getEthUsdPrice());
    const apiMcapEth = Number(t.marketCapEth || 0);
    const apiPriceEth = Number(t.priceEth || 0);

    let priceEth = 0;
    let mcapEth = 0;
    let source = "api";
    let sampleTokens = 0;
    let sampleEthOut = 0;

    // Sample ~0.1% of supply (or 1M tokens), capped so quote stays cheap
    const sampleHuman = Math.min(
        Math.max(supply * 0.001, 1_000),
        Math.min(supply * 0.01, 5_000_000)
    );
    try {
        const q = await quoteSell(tokenAddress, String(sampleHuman), {
            fee: options.fee ?? resolvePoolFee(info),
        });
        if (q.ethOut > 0 && sampleHuman > 0) {
            sampleTokens = sampleHuman;
            sampleEthOut = q.ethOut;
            priceEth = q.ethOut / sampleHuman;
            mcapEth = priceEth * supply;
            source = "quoter";
        }
    } catch (_) {}

    // Fallback chain: API MC → price*supply
    if (!(mcapEth > 0)) {
        mcapEth = resolveMarketCapEth(info);
        priceEth = supply > 0 ? mcapEth / supply : apiPriceEth;
        source = apiMcapEth > 0 ? "api" : "fdv";
    } else if (apiMcapEth > 0) {
        // If API is within 25% of live, keep noting both
        const drift = Math.abs(mcapEth - apiMcapEth) / mcapEth;
        if (drift > 0.25) source = "quoter"; // API stale — use live
    }

    const mcapUsd = ethToUsd(mcapEth, ethUsd) || 0;
    return {
        supply,
        decimals,
        priceEth,
        priceUsd: ethToUsd(priceEth, ethUsd),
        mcapEth,
        mcapUsd,
        mcapEthLabel: `${mcapEth.toFixed(4)} ETH`,
        mcapUsdLabel: formatUsd(mcapUsd, 0),
        apiMcapEth,
        apiMcapUsd: ethToUsd(apiMcapEth, ethUsd),
        apiMcapUsdLabel: formatUsd(ethToUsd(apiMcapEth, ethUsd), 0),
        source,
        sampleTokens,
        sampleEthOut,
        ethUsd,
        symbol: t.symbol || "TOKEN",
        note:
            source === "quoter"
                ? `Live MC from Uniswap quote (${formatUsd(mcapUsd, 0)}). API showed ${formatUsd(ethToUsd(apiMcapEth, ethUsd), 0)} — ignored if stale.`
                : `MC from ${source}.`,
    };
}


// Uniswap V3 SwapRouter02-style ABI (matches NOXA frontend)
const ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
    "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
    "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
    "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
    "function refundETH() payable",
];

const QUOTER_ABI = [
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
];

const WETH_ABI = [
    "function deposit() payable",
    "function withdraw(uint256 wad)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
    staticNetwork: true,
});

// On-chain launch feed caches — avoid re-hitting RPC for the same tokens every poll
const _launchMetaCache = new Map(); // address -> { name, symbol, decimals, supply, at }
const _launchBlockTs = new Map(); // blockNumber -> timestamp
let _launchCursor = { lastBlock: 0, tokens: [] }; // incremental getLogs
let _feeDataCache = { data: null, at: 0 };
const FEE_DATA_CACHE_MS = 2000;

async function getCachedFeeData(force = false) {
    if (
        !force &&
        _feeDataCache.data &&
        Date.now() - _feeDataCache.at < FEE_DATA_CACHE_MS
    ) {
        return _feeDataCache.data;
    }
    const data = await provider.getFeeData();
    _feeDataCache = { data, at: Date.now() };
    return data;
}

/**
 * Robinhood RPC often returns maxPriorityFeePerGas = 0n.
 * `0n ?? fallback` keeps 0 (nullish only), so tips were stuck at 0.
 */
function resolveEip1559Fees(feeData, priorityMultiplier = 1) {
    const mult = Math.max(1, Number(priorityMultiplier) || 1);
    const minTip = ethers.parseUnits(
        String(process.env.MIN_PRIORITY_FEE_GWEI || "0.05"),
        "gwei"
    );
    let tip =
        feeData?.maxPriorityFeePerGas != null &&
        feeData.maxPriorityFeePerGas > 0n
            ? feeData.maxPriorityFeePerGas
            : feeData?.gasPrice != null && feeData.gasPrice > 0n
              ? feeData.gasPrice / 4n
              : minTip;
    if (tip < minTip) tip = minTip;
    let maxFee =
        feeData?.maxFeePerGas != null && feeData.maxFeePerGas > 0n
            ? feeData.maxFeePerGas
            : feeData?.gasPrice != null && feeData.gasPrice > 0n
              ? feeData.gasPrice
              : tip * 2n;
    if (mult > 1) {
        const m = BigInt(Math.round(mult * 100));
        tip = (tip * m) / 100n;
        maxFee = (maxFee * m) / 100n;
    }
    if (maxFee < tip) maxFee = tip * 2n;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
}

/** Serialize sends per wallet so fire-and-forget snipes don't collide on nonce. */
const _walletSendQueues = new Map();
function withWalletSendLock(address, fn) {
    const key = String(address || "").toLowerCase();
    const prev = _walletSendQueues.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const next = prev.then(() => gate, () => gate);
    _walletSendQueues.set(key, next);
    return (async () => {
        await prev.catch(() => {});
        try {
            return await fn();
        } finally {
            release();
            if (_walletSendQueues.get(key) === next) _walletSendQueues.delete(key);
        }
    })();
}

/**
 * Ultra-fast launch scan: getLogs only — no name/symbol/API.
 * Used by the block listener so we can fire a buy in the same/next block.
 */
async function fetchLaunchEventsFast(options = {}) {
    const lookback = Math.min(40, Math.max(1, Number(options.lookbackBlocks || 4)));
    const latest =
        options.toBlock != null
            ? Number(options.toBlock)
            : await provider.getBlockNumber();
    const fromBlock =
        options.fromBlock != null
            ? Math.max(0, Number(options.fromBlock))
            : Math.max(0, latest - lookback);
    let logs = [];
    try {
        logs = await provider.getLogs({
            address: LAUNCH_FACTORY,
            fromBlock,
            toBlock: latest,
            topics: [LAUNCH_CREATED_TOPIC],
        });
    } catch (e) {
        return { tokens: [], latestBlock: latest, error: e.message };
    }
    const seen = new Set();
    const tokens = [];
    // Newest first
    for (const log of logs.slice().reverse()) {
        try {
            const token = ethers.getAddress("0x" + log.topics[1].slice(26));
            const key = token.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const creator = ethers.getAddress("0x" + log.topics[2].slice(26));
            const meta = _launchMetaCache.get(key);
            const ts = _launchBlockTs.get(log.blockNumber);
            const nowSec = Math.floor(Date.now() / 1000);
            const ageBlocks = Math.max(0, latest - log.blockNumber);
            // Timestamps are filled async — until then approximate age from block delta (~1s/block on RH)
            const ageSec =
                ts != null
                    ? Math.max(0, nowSec - ts)
                    : ageBlocks;
            tokens.push({
                address: token,
                creator,
                createdAtBlock: log.blockNumber,
                createdAt: ts ? new Date(ts * 1000).toISOString() : null,
                ageSec,
                ageBlocks,
                symbol: meta?.symbol || "???",
                name: meta?.name || "Unknown",
                pairedToken: WETH,
                poolFee: DEFAULT_POOL_FEE,
                marketCapEth: NOXA_STARTING_MC_ETH,
                initialBuyEth: 0,
                source: "chain-fast",
                txHash: log.transactionHash || null,
            });
        } catch (_) {}
    }
    // Opportunistically cache block timestamps (don't block return)
    const needTs = [
        ...new Set(
            tokens
                .map((t) => t.createdAtBlock)
                .filter((bn) => bn && !_launchBlockTs.has(bn))
        ),
    ].slice(0, 8);
    if (needTs.length) {
        setImmediate(() => {
            mapPool(needTs, 4, async (bn) => {
                try {
                    const blk = await provider.getBlock(bn);
                    if (blk?.timestamp) _launchBlockTs.set(bn, Number(blk.timestamp));
                } catch (_) {}
            }).catch(() => {});
        });
    }
    return { tokens, latestBlock: latest, fromBlock };
}

const routerIface = new ethers.Interface(ROUTER_ABI);

function apiHeaders() {
    return {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        Origin: "https://fun.noxa.fi",
        Referer: "https://fun.noxa.fi/robinhood",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
}

function axiosConfig(extra = {}) {
    const cfg = {
        headers: apiHeaders(),
        timeout: 10000,
        ...extra,
    };
    if (proxyUrl) {
        cfg.httpsAgent = new HttpsProxyAgent(proxyUrl);
    }
    return cfg;
}

function applySlippage(amountOut, slippageBps = DEFAULT_SLIPPAGE_BPS) {
    return (amountOut * BigInt(10000 - slippageBps)) / 10000n;
}

async function quoteExactInput(tokenIn, tokenOut, amountIn, fee) {
    const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
    });
    return result[0];
}

async function ensureAllowance(wallet, tokenAddress, spender, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const current = await token.allowance(wallet.address, spender);
    if (current >= amount) {
        return null;
    }
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
    return tx;
}

function isHttp404(err) {
    return (
        err?.response?.status === 404 ||
        /status code 404/i.test(String(err?.message || ""))
    );
}

/** Synthetic token info when NOXA API hasn't indexed a brand-new launch yet. */
function syntheticTokenInfo(overrides = {}) {
    const poolFee = overrides.poolFee ?? DEFAULT_POOL_FEE;
    const pairedToken = overrides.pairedToken || WETH;
    const decimals = overrides.decimals ?? 18;
    return {
        token: {
            address: overrides.address || null,
            name: overrides.name || "Unknown",
            symbol: overrides.symbol || "???",
            decimals,
            poolFee,
            pairedToken,
            marketCapEth: overrides.marketCapEth ?? NOXA_STARTING_MC_ETH,
            supply: overrides.supply || String(NOXA_DEFAULT_SUPPLY),
        },
        poolFee,
        pairedToken,
        source: "synthetic",
    };
}

/**
 * Fetch token metadata from NOXA API.
 * Brand-new on-chain launches often 404 for minutes — pass `{ optional: true }`
 * to get null instead of throwing, or use resolveTokenInfo().
 */
async function getTokenInfo(tokenAddress, options = {}) {
    try {
        const r = await axios.get(
            `${API_URL}/v1/robinhood/token/${tokenAddress}`,
            axiosConfig()
        );
        return r.data;
    } catch (e) {
        if (options.optional && isHttp404(e)) return null;
        throw e;
    }
}

/**
 * Resolve pool fee / paired token for swaps. Prefers caller meta, then API,
 * then NOXA launch defaults (so snipes don't die on API 404).
 */
async function resolveTokenInfo(tokenAddress, options = {}) {
    if (options.tokenInfo) return options.tokenInfo;
    try {
        const fromApi = await getTokenInfo(tokenAddress, { optional: true });
        if (fromApi) return fromApi;
    } catch (_) {
        // API down / DNS dead / non-NOXA token — fall through to on-chain defaults
    }
    return syntheticTokenInfo({
        address: tokenAddress,
        poolFee: options.fee ?? options.poolFee,
        pairedToken: options.pairedToken,
        decimals: options.decimals,
        symbol: options.symbol,
        name: options.name,
        marketCapEth: options.marketCapEth,
    });
}

/**
 * List newest NOXA Robinhood tokens (API default order is newest-first).
 */
async function listTokens(options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options.limit || 40)));
    const offset = Math.max(0, Number(options.offset || 0));
    // Prefer /newest when available (same lag as list today, but correct path)
    const path =
        options.newest === true
            ? `/v1/robinhood/tokens/newest`
            : `/v1/robinhood/tokens`;
    const [r, ethUsd] = await Promise.all([
        axios
            .get(`${API_URL}${path}`, {
                ...axiosConfig(),
                params:
                    options.newest === true
                        ? { limit }
                        : { limit, offset },
            })
            .catch(async () => {
                if (options.newest === true) {
                    return axios.get(`${API_URL}/v1/robinhood/tokens`, {
                        ...axiosConfig(),
                        params: { limit, offset: 0 },
                    });
                }
                throw new Error("tokens API failed");
            }),
        getEthUsdPrice(),
    ]);
    const tokens = (r.data?.tokens || []).map((t) =>
        normalizeListedToken(t, ethUsd)
    );
    tokens.sort(
        (a, b) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime()
    );
    return {
        tokens,
        ethUsd,
        source: "api",
        pagination: r.data?.pagination || { limit, offset, total: tokens.length },
    };
}

/**
 * Live launches from the on-chain factory. NOXA's /tokens API can lag ~1h+;
 * this is what the sniper feed should use for "newest on top".
 */
async function fetchOnChainLaunches(options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options.limit || 60)));
    const lookbackBlocks = Math.min(
        4000,
        Math.max(150, Number(options.lookbackBlocks || 900))
    );
    const ethUsd = options.ethUsd || (await getEthUsdPrice());
    const latest = await provider.getBlockNumber();

    // Incremental: only scan new blocks after first warm poll
    let fromBlock;
    if (_launchCursor.lastBlock > 0 && latest >= _launchCursor.lastBlock) {
        fromBlock = Math.max(0, _launchCursor.lastBlock);
    } else {
        fromBlock = Math.max(0, latest - lookbackBlocks);
    }
    // Always overlap 2 blocks to avoid missing edge
    if (_launchCursor.lastBlock > 0) {
        fromBlock = Math.max(0, fromBlock - 2);
    }

    let logs = [];
    try {
        logs = await provider.getLogs({
            address: LAUNCH_FACTORY,
            fromBlock,
            toBlock: latest,
            topics: [LAUNCH_CREATED_TOPIC],
        });
    } catch (e) {
        // On 429 / range, return cached board rather than empty
        if (_launchCursor.tokens.length) {
            return {
                tokens: _launchCursor.tokens.slice(0, limit),
                ethUsd,
                source: "chain-cache",
                latestBlock: latest,
                freshestAgeSec: _launchCursor.tokens[0]?.ageSec ?? null,
                apiLagHint: "Using cached on-chain launches (RPC busy)",
            };
        }
        throw e;
    }

    _launchCursor.lastBlock = latest + 1;

    const ordered = logs.slice().reverse();
    const seenNew = new Set();
    const picked = [];
    for (const log of ordered) {
        try {
            const token = ethers.getAddress("0x" + log.topics[1].slice(26));
            const key = token.toLowerCase();
            if (seenNew.has(key)) continue;
            seenNew.add(key);
            const creator = ethers.getAddress("0x" + log.topics[2].slice(26));
            picked.push({ token, creator, blockNumber: log.blockNumber, log });
        } catch (_) {}
    }

    // Merge with existing cursor tokens (keep newest)
    const byAddr = new Map();
    for (const t of _launchCursor.tokens) {
        byAddr.set(String(t.address || "").toLowerCase(), t);
    }

    // Resolve block timestamps (cached)
    const needBlocks = [
        ...new Set(
            picked
                .map((p) => p.blockNumber)
                .filter((bn) => !_launchBlockTs.has(bn))
        ),
    ];
    if (needBlocks.length) {
        await mapPool(needBlocks, 6, async (bn) => {
            try {
                const blk = await provider.getBlock(bn);
                if (blk?.timestamp) _launchBlockTs.set(bn, Number(blk.timestamp));
            } catch (_) {}
        });
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // Only fetch name/symbol for tokens not in meta cache
    const needMeta = picked.filter(
        (p) => !_launchMetaCache.has(p.token.toLowerCase())
    );
    if (needMeta.length) {
        await mapPool(needMeta, 6, async (item) => {
            let name = "Unknown";
            let symbol = "???";
            try {
                const c = new ethers.Contract(
                    item.token,
                    [
                        "function name() view returns (string)",
                        "function symbol() view returns (string)",
                    ],
                    provider
                );
                const [n, s] = await Promise.all([
                    c.name().catch(() => "Unknown"),
                    c.symbol().catch(() => "???"),
                ]);
                name = n;
                symbol = s;
            } catch (_) {}
            _launchMetaCache.set(item.token.toLowerCase(), {
                name,
                symbol,
                decimals: 18,
                supply: String(NOXA_DEFAULT_SUPPLY),
                at: Date.now(),
            });
        });
    }

    for (const item of picked) {
        const key = item.token.toLowerCase();
        const meta = _launchMetaCache.get(key) || {
            name: "Unknown",
            symbol: "???",
            decimals: 18,
            supply: String(NOXA_DEFAULT_SUPPLY),
        };
        const ts = _launchBlockTs.get(item.blockNumber);
        const createdAt = ts ? new Date(ts * 1000).toISOString() : null;
        const ageSec = ts != null ? Math.max(0, nowSec - ts) : null;
        const marketCapEth = NOXA_STARTING_MC_ETH;
        const marketCapUsd = ethToUsd(marketCapEth, ethUsd);
        const prev = byAddr.get(key);
        byAddr.set(key, {
            address: item.token,
            name: meta.name,
            symbol: meta.symbol,
            creator: item.creator,
            feeWallet: prev?.feeWallet ?? null,
            pairedToken: WETH,
            poolFee: DEFAULT_POOL_FEE,
            poolFeePct: (DEFAULT_POOL_FEE / 10000) * 100,
            supply: meta.supply,
            decimals: meta.decimals,
            logo: prev?.logo ?? null,
            logoUrl: prev?.logoUrl ?? null,
            description: prev?.description || "",
            twitter: prev?.twitter || "",
            telegram: prev?.telegram || "",
            website: prev?.website || "",
            discord: prev?.discord || "",
            createdAt,
            createdAtBlock: item.blockNumber,
            ageSec,
            priceEth: prev?.priceEth || 0,
            priceUsd: prev?.priceUsd ?? ethToUsd(0, ethUsd),
            marketCapEth: prev?.marketCapEth || marketCapEth,
            marketCapUsd: prev?.marketCapUsd || marketCapUsd,
            marketCapUsdLabel:
                prev?.marketCapUsdLabel || formatUsd(marketCapUsd),
            athMarketCapEth: prev?.athMarketCapEth || marketCapEth,
            athMarketCapUsd: prev?.athMarketCapUsd || marketCapUsd,
            athMarketCapUsdLabel:
                prev?.athMarketCapUsdLabel || formatUsd(marketCapUsd),
            athAt: prev?.athAt || null,
            volume24hEth: prev?.volume24hEth || 0,
            volume1hEth: prev?.volume1hEth || 0,
            netBuyAmountEth: prev?.netBuyAmountEth || 0,
            initialBuyEth: prev?.initialBuyEth || 0,
            organicBuyEth: prev?.organicBuyEth || 0,
            officialPool: prev?.officialPool || null,
            startingMcEth: NOXA_STARTING_MC_ETH,
            startingMcUsd: ethToUsd(NOXA_STARTING_MC_ETH, ethUsd),
            ethUsd: ethUsd || null,
            mcVsStartX:
                (prev?.marketCapEth || marketCapEth) / NOXA_STARTING_MC_ETH,
            signals: prev?.signals || [],
            noxaUrl: `https://fun.noxa.fi/robinhood/${item.token}`,
            explorerUrl: `https://robinhoodchain.blockscout.com/token/${item.token}`,
            creatorExplorerUrl: `https://robinhoodchain.blockscout.com/address/${item.creator}`,
            source: "chain",
            isNew: ageSec != null && ageSec < 120,
        });
    }

    // Refresh ages on cached rows
    for (const t of byAddr.values()) {
        if (t.createdAtBlock && _launchBlockTs.has(t.createdAtBlock)) {
            const ts = _launchBlockTs.get(t.createdAtBlock);
            t.ageSec = Math.max(0, nowSec - ts);
            t.isNew = t.ageSec < 120;
        }
    }

    const rows = [...byAddr.values()].sort(
        (a, b) =>
            (b.createdAtBlock || 0) - (a.createdAtBlock || 0) ||
            new Date(b.createdAt || 0).getTime() -
                new Date(a.createdAt || 0).getTime()
    );
    // Cap memory
    _launchCursor.tokens = rows.slice(0, 150);
    if (_launchMetaCache.size > 400) {
        const keys = [..._launchMetaCache.keys()].slice(0, 100);
        for (const k of keys) _launchMetaCache.delete(k);
    }

    const freshestAge = rows[0]?.ageSec;
    return {
        tokens: rows.slice(0, limit),
        ethUsd,
        source: "chain",
        latestBlock: latest,
        freshestAgeSec: freshestAge ?? null,
        apiLagHint:
            freshestAge != null && freshestAge < 120
                ? null
                : "On-chain feed active — API index may be stale",
    };
}

/**
 * Newest launches for the sniper board: on-chain first, API as fill-in.
 */
async function listNewestTokens(options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options.limit || 60)));
    const ethUsd = await getEthUsdPrice();
    let chainResult = { tokens: [], source: "chain", ethUsd };
    try {
        // Hard timeout so a slow RPC never blocks the sniper board on lagged API
        chainResult = await Promise.race([
            fetchOnChainLaunches({
                limit,
                lookbackBlocks: options.lookbackBlocks || 900,
                ethUsd,
            }),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error("on-chain feed timeout")), 8000)
            ),
        ]);
    } catch (e) {
        console.warn("on-chain launch feed failed:", e.message || e);
    }

    // If chain gave us fresh launches, use them (optionally pad with API)
    const chainTokens = chainResult.tokens || [];
    const freshest = chainTokens[0]?.ageSec;
    if (chainTokens.length && freshest != null && freshest < 3600) {
        // Merge logos / richer fields from API by address, then pad missing rows
        try {
            const api = await Promise.race([
                listTokens({ limit: Math.max(limit, 60), newest: true }),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error("api merge timeout")), 2500)
                ),
            ]);
            const byAddr = new Map(
                (api.tokens || []).map((t) => [
                    String(t.address || "").toLowerCase(),
                    t,
                ])
            );
            for (let i = 0; i < chainTokens.length; i++) {
                const key = String(chainTokens[i].address || "").toLowerCase();
                const apiTok = byAddr.get(key);
                if (!apiTok) continue;
                if (!chainTokens[i].logoUrl && apiTok.logoUrl) {
                    chainTokens[i].logo = apiTok.logo || chainTokens[i].logo;
                    chainTokens[i].logoUrl = apiTok.logoUrl;
                }
                if (!chainTokens[i].logo && apiTok.logo) {
                    chainTokens[i].logo = apiTok.logo;
                    chainTokens[i].logoUrl =
                        apiTok.logoUrl || resolveMediaUrl(apiTok.logo);
                }
                // Copy trade-critical fields the chain path doesn't have yet
                for (const k of [
                    "twitter",
                    "telegram",
                    "website",
                    "discord",
                    "description",
                    "initialBuyEth",
                    "organicBuyEth",
                    "netBuyAmountEth",
                    "volume1hEth",
                    "volume24hEth",
                    "athMarketCapEth",
                    "athMarketCapUsd",
                    "athMarketCapUsdLabel",
                    "signals",
                ]) {
                    if (
                        (chainTokens[i][k] == null ||
                            chainTokens[i][k] === "" ||
                            chainTokens[i][k] === 0 ||
                            (Array.isArray(chainTokens[i][k]) &&
                                !chainTokens[i][k].length)) &&
                        apiTok[k] != null &&
                        apiTok[k] !== ""
                    ) {
                        chainTokens[i][k] = apiTok[k];
                    }
                }
                // Prefer API MC when chain still has launch default
                if (
                    Number(apiTok.marketCapEth || 0) > 0 &&
                    (!chainTokens[i].marketCapEth ||
                        Math.abs(
                            Number(chainTokens[i].marketCapEth) -
                                NOXA_STARTING_MC_ETH
                        ) < 1e-9)
                ) {
                    chainTokens[i].marketCapEth = apiTok.marketCapEth;
                    chainTokens[i].marketCapUsd = apiTok.marketCapUsd;
                    chainTokens[i].marketCapUsdLabel = apiTok.marketCapUsdLabel;
                    chainTokens[i].priceEth = apiTok.priceEth;
                    chainTokens[i].mcVsStartX =
                        Number(apiTok.marketCapEth) / NOXA_STARTING_MC_ETH;
                }
            }
            const have = new Set(
                chainTokens.map((t) => String(t.address || "").toLowerCase())
            );
            for (const t of api.tokens || []) {
                if (chainTokens.length >= limit) break;
                const key = String(t.address || "").toLowerCase();
                if (!have.has(key)) {
                    chainTokens.push({ ...t, source: t.source || "api" });
                    have.add(key);
                }
            }
        } catch (_) {}
        chainTokens.sort(
            (a, b) =>
                (b.createdAtBlock || 0) - (a.createdAtBlock || 0) ||
                new Date(b.createdAt || 0).getTime() -
                    new Date(a.createdAt || 0).getTime()
        );
        return {
            tokens: chainTokens.slice(0, limit),
            ethUsd,
            source: "chain+api",
            freshestAgeSec: freshest,
            latestBlock: chainResult.latestBlock,
            feedNote:
                freshest < 180
                    ? `Live on-chain · newest ${freshest}s ago`
                    : `On-chain · newest ${Math.round(freshest / 60)}m ago`,
        };
    }

    // Fallback: API only (may be lagged)
    const api = await listTokens({ limit, newest: true });
    const age = api.tokens[0]?.ageSec;
    return {
        tokens: api.tokens,
        ethUsd: api.ethUsd,
        source: "api",
        freshestAgeSec: age ?? null,
        feedNote:
            age != null && age > 600
                ? `⚠️ NOXA API lagging ~${Math.round(age / 60)}m — on-chain feed unavailable`
                : "API feed",
    };
}

function resolveMediaUrl(uri) {
    if (!uri) return null;
    const s = String(uri).trim();
    if (!s) return null;
    const gateways = [
        "https://cloudflare-ipfs.com/ipfs/",
        "https://ipfs.io/ipfs/",
        "https://gateway.pinata.cloud/ipfs/",
    ];
    const toIpfs = (cidPath) => {
        const cid = String(cidPath || "")
            .replace(/^ipfs\//, "")
            .replace(/^\/+/, "");
        if (!cid) return null;
        // Prefer Cloudflare — usually faster than ipfs.io for browser <img>
        return gateways[0] + cid;
    };
    if (s.startsWith("ipfs://")) return toIpfs(s.slice(7));
    if (s.startsWith("https://") || s.startsWith("http://")) {
        // Rewrite slow/dead ipfs.io links to Cloudflare
        const m = s.match(/https?:\/\/ipfs\.io\/ipfs\/(.+)/i);
        if (m) return toIpfs(m[1]);
        return s;
    }
    if (s.startsWith("Qm") || s.startsWith("bafy") || s.startsWith("bafk")) {
        return toIpfs(s);
    }
    return s;
}

function normalizeSocialKey(url) {
    if (!url || typeof url !== "string") return "";
    try {
        const u = url.trim().toLowerCase().replace(/\/+$/, "");
        // Collapse x.com / twitter.com handles
        const m = u.match(/(?:twitter\.com|x\.com)\/(@?[\w]+)/i);
        if (m) return `x:${m[1].replace(/^@/, "")}`;
        const tg = u.match(/(?:t\.me|telegram\.me)\/([\w+]+)/i);
        if (tg) return `tg:${tg[1]}`;
        return u.replace(/^https?:\/\//, "").replace(/^www\./, "");
    } catch (_) {
        return String(url).toLowerCase().slice(0, 80);
    }
}

function normalizeNameKey(nameOrSymbol) {
    return String(nameOrSymbol || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 32);
}

/** Rough narrative quality — real name/desc vs spam ticker clones. */
function narrativeQuality(t) {
    const name = String(t.name || "").trim();
    const symbol = String(t.symbol || "").trim();
    const desc = String(t.description || "").trim();
    const reasons = [];
    let score = 0;
    if (desc.length >= 40) {
        score += 2;
        reasons.push("desc");
    } else if (desc.length >= 12) {
        score += 1;
        reasons.push("short_desc");
    }
    if (t.website) {
        score += 2;
        reasons.push("web");
    }
    if (t.twitter) {
        score += 1;
        reasons.push("x");
    }
    if (t.telegram) {
        score += 1;
        reasons.push("tg");
    }
    // Prefer human names over random hex / ??? / single letters
    if (name && name.length >= 4 && !/^0x/i.test(name) && name !== "Unknown") {
        score += 1;
        reasons.push("name");
    }
    if (symbol && symbol.length >= 2 && symbol !== "???" && !/^0x/i.test(symbol)) {
        score += 1;
        reasons.push("ticker");
    }
    // Penalize ultra-generic spam patterns
    if (/^(test|coin|token|inu|pepe|trump)\d*$/i.test(symbol)) score -= 1;
    return { score, reasons, ok: score >= 3 };
}

function buildTradeSignals(t, initialBuyEth, marketCapEth, athMarketCapEth) {
    const flags = [];
    const feeWallet = (t.feeWallet || "").toLowerCase();
    const creator = (t.creator || "").toLowerCase();
    if (feeWallet && creator && feeWallet === creator) {
        flags.push({ id: "fee_is_dev", label: "Fee→dev", tone: "warn" });
    }
    if (initialBuyEth >= 0.2) {
        flags.push({
            id: "fat_dev_buy",
            label: `Dev buy ${initialBuyEth.toFixed(2)}Ξ`,
            tone: "bad",
        });
    } else if (initialBuyEth > 0 && initialBuyEth < 0.05) {
        flags.push({
            id: "small_dev_buy",
            label: `Dev buy ${initialBuyEth.toFixed(3)}Ξ`,
            tone: "ok",
        });
    } else if (initialBuyEth > 0) {
        flags.push({
            id: "dev_buy",
            label: `Dev buy ${initialBuyEth.toFixed(3)}Ξ`,
            tone: "ok",
        });
    } else if (initialBuyEth === 0) {
        flags.push({ id: "no_dev_buy", label: "No dev buy", tone: "warn" });
    }
    if (!t.twitter && !t.telegram && !t.website) {
        flags.push({ id: "no_socials", label: "No socials", tone: "warn" });
    }
    if (t.twitter) flags.push({ id: "twitter", label: "X", tone: "info" });
    if (t.telegram) flags.push({ id: "tg", label: "TG", tone: "info" });
    if (t.website) flags.push({ id: "web", label: "Web", tone: "info" });
    const narr = narrativeQuality(t);
    if (narr.ok) {
        flags.push({
            id: "good_narrative",
            label: `Narrative ${narr.score}`,
            tone: "ok",
        });
    } else if (t.source === "api" || t.description || t.website) {
        flags.push({
            id: "weak_narrative",
            label: "Weak narrative",
            tone: "warn",
        });
    }
    const athX =
        marketCapEth > 0 && athMarketCapEth > 0
            ? athMarketCapEth / marketCapEth
            : null;
    if (athX != null && athX > 1.15) {
        flags.push({
            id: "off_ath",
            label: `ATH ${athX.toFixed(2)}x`,
            tone: "warn",
        });
    }
    const startMc = NOXA_STARTING_MC_ETH;
    if (marketCapEth > 0 && marketCapEth < startMc * 1.05) {
        flags.push({ id: "near_start", label: "Near start MC", tone: "ok" });
    }
    return flags;
}

function normalizeListedToken(t, ethUsd = 0) {
    const address = t.address;
    const createdAt = t.createdAtTime || t.created_at || null;
    const ageSec = createdAt
        ? Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 1000)
        : null;
    let initialBuyEth = 0;
    try {
        initialBuyEth = Number(
            ethers.formatEther(BigInt(t.initialBuyAmount || "0"))
        );
    } catch (_) {
        initialBuyEth = Number(t.initialBuyAmount || 0) / 1e18 || 0;
    }
    const marketCapEth = Number(t.marketCapEth || 0);
    const athMarketCapEth = Number(t.athMarketCapEth || 0);
    const netBuyAmountEth = Number(t.netBuyAmountEth || 0);
    const logoUrl = resolveMediaUrl(t.logo);
    const px = Number(ethUsd || _ethUsdCache.price || 0);
    const marketCapUsd = ethToUsd(marketCapEth, px);
    const athMarketCapUsd = ethToUsd(athMarketCapEth, px);
    const startingMcUsd = ethToUsd(NOXA_STARTING_MC_ETH, px);
    return {
        address,
        name: t.name,
        symbol: t.symbol,
        creator: t.creator,
        feeWallet: t.feeWallet || null,
        pairedToken: t.pairedToken || WETH,
        poolFee: t.poolFee ?? DEFAULT_POOL_FEE,
        poolFeePct: ((t.poolFee ?? DEFAULT_POOL_FEE) / 10000) * 100,
        supply: t.supply || t.totalSupply,
        decimals: t.decimals ?? 18,
        logo: t.logo,
        logoUrl,
        description: t.description || "",
        twitter: t.twitter || "",
        telegram: t.telegram || "",
        website: t.website || "",
        discord: t.discord || "",
        createdAt,
        createdAtBlock: t.createdAtBlock,
        ageSec,
        priceEth: Number(t.priceEth || 0),
        priceUsd: ethToUsd(Number(t.priceEth || 0), px),
        marketCapEth,
        marketCapUsd,
        marketCapUsdLabel: formatUsd(marketCapUsd),
        athMarketCapEth,
        athMarketCapUsd,
        athMarketCapUsdLabel: formatUsd(athMarketCapUsd),
        athAt: t.athAt || null,
        volume24hEth: Number(t.volume24hEth || 0),
        volume1hEth: Number(t.volume1hEth || 0),
        netBuyAmountEth,
        initialBuyEth,
        // organic flow after creator buy (rough)
        organicBuyEth: Math.max(0, netBuyAmountEth - initialBuyEth),
        officialPool: t.officialPool,
        startingMcEth: NOXA_STARTING_MC_ETH,
        startingMcUsd,
        ethUsd: px || null,
        mcVsStartX:
            marketCapEth > 0 ? marketCapEth / NOXA_STARTING_MC_ETH : null,
        signals: buildTradeSignals(
            t,
            initialBuyEth,
            marketCapEth,
            athMarketCapEth
        ),
        noxaUrl: `https://fun.noxa.fi/robinhood/${address}`,
        explorerUrl: `https://robinhoodchain.blockscout.com/token/${address}`,
        creatorExplorerUrl: t.creator
            ? `https://robinhoodchain.blockscout.com/address/${t.creator}`
            : null,
    };
}

/**
 * Scan recent NOXA pages and return launches by this creator.
 */
async function getCreatorLaunches(creatorAddress, options = {}) {
    const creator = String(creatorAddress || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(creator)) {
        throw new Error("Invalid creator address");
    }
    const maxPages = Math.min(10, Math.max(1, Number(options.maxPages || 5)));
    const pageSize = 100;
    const launches = [];
    let totalIndexed = 0;
    for (let page = 0; page < maxPages; page++) {
        const { tokens, pagination } = await listTokens({
            limit: pageSize,
            offset: page * pageSize,
        });
        totalIndexed += tokens.length;
        for (const t of tokens) {
            if ((t.creator || "").toLowerCase() === creator) {
                launches.push(t);
            }
        }
        const total = pagination?.total || 0;
        if ((page + 1) * pageSize >= total || tokens.length < pageSize) break;
    }
    launches.sort(
        (a, b) =>
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime()
    );
    const aths = launches.map((l) => l.athMarketCapEth || 0);
    const bestAth = aths.length ? Math.max(...aths) : 0;
    const avgAth = aths.length
        ? aths.reduce((s, x) => s + x, 0) / aths.length
        : 0;
    const ethUsd = launches[0]?.ethUsd || (await getEthUsdPrice());
    return {
        creator,
        scanned: totalIndexed,
        launchCount: launches.length,
        bestAthMcEth: bestAth,
        avgAthMcEth: avgAth,
        bestAthMcUsd: ethToUsd(bestAth, ethUsd),
        avgAthMcUsd: ethToUsd(avgAth, ethUsd),
        bestAthMcUsdLabel: formatUsd(ethToUsd(bestAth, ethUsd)),
        avgAthMcUsdLabel: formatUsd(ethToUsd(avgAth, ethUsd)),
        ethUsd,
        serialLauncher: launches.length >= 3,
        launches: launches.slice(0, 30),
        explorerUrl: `https://robinhoodchain.blockscout.com/address/${creator}`,
    };
}

/**
 * Live tradability check via estimateGas (this RPC's historical eth_call is unreliable).
 */
async function estimateBuyReady(tokenAddress, amountEth, options = {}) {
    const fee = options.fee ?? DEFAULT_POOL_FEE;
    const pairedToken = options.pairedToken || WETH;
    const from =
        options.walletAddress ||
        "0x58e4B4596AF90aF419122dAD34657eF915D1237d";
    const amountIn = ethers.parseEther(String(amountEth || 0.005));
    const data = routerIface.encodeFunctionData("exactInputSingle", [
        {
            tokenIn: pairedToken,
            tokenOut: tokenAddress,
            fee,
            recipient: from,
            amountIn,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
        },
    ]);
    try {
        const gas = await provider.estimateGas({
            to: ROUTER_CONTRACT_ADDRESS,
            from,
            data,
            value: amountIn,
        });
        return { ok: true, gas: gas.toString() };
    } catch (e) {
        return {
            ok: false,
            error: e.shortMessage || e.reason || e.message || "estimateGas failed",
        };
    }
}

const UNISWAP_V3_SWAP_TOPIC =
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
let _uniFactoryAddr = null;
async function getUniFactoryAddress() {
    if (_uniFactoryAddr) return _uniFactoryAddr;
    const router = new ethers.Contract(
        ROUTER,
        ["function factory() view returns (address)"],
        provider
    );
    _uniFactoryAddr = await router.factory();
    return _uniFactoryAddr;
}

/**
 * NOXA launches often reject the first external buys until someone else
 * successfully swaps. Create-tx includes 1 Swap (dev buy) — wait for >1.
 */
async function countPoolSwaps(tokenAddress, options = {}) {
    const fee = options.fee ?? DEFAULT_POOL_FEE;
    const pairedToken = options.pairedToken || WETH;
    const lookback = Math.min(200, Math.max(5, Number(options.lookbackBlocks || 80)));
    try {
        const factoryAddr = await getUniFactoryAddress();
        const factory = new ethers.Contract(
            factoryAddr,
            [
                "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
            ],
            provider
        );
        const pool = await factory.getPool(pairedToken, tokenAddress, fee);
        if (!pool || pool === ethers.ZeroAddress) {
            return { ok: false, swaps: 0, error: "no pool" };
        }
        const latest = await provider.getBlockNumber();
        const fromBlock =
            options.fromBlock != null
                ? Number(options.fromBlock)
                : Math.max(0, latest - lookback);
        const logs = await provider.getLogs({
            address: pool,
            fromBlock,
            toBlock: latest,
            topics: [UNISWAP_V3_SWAP_TOPIC],
        });
        return { ok: true, swaps: logs.length, pool, latest };
    } catch (e) {
        return {
            ok: false,
            swaps: 0,
            error: e.shortMessage || e.message || "swap count failed",
        };
    }
}

/**
 * Fast snipe buy from a single wallet. Retries briefly if pool/quote isn't ready yet.
 * Does NOT require NOXA API indexing — uses fee/pairedToken from options or launch defaults.
 * Waits for receipt + token balance — never reports ok on a reverted broadcast.
 */
async function snipeBuy(walletData, amountEth, tokenAddress, options = {}) {
    const waitForFill = options.waitForFill !== false; // false = fire-and-forget (true sniper speed)
    const retries = Number(options.retries ?? (waitForFill ? 8 : 3));
    const retryDelayMs = Number(options.retryDelayMs ?? (waitForFill ? 400 : 120));
    const fee = options.fee ?? options.poolFee ?? DEFAULT_POOL_FEE;
    const pairedToken = options.pairedToken || WETH;
    const wallet = new ethers.Wallet(walletData.private_key, provider);
    // One fee snapshot for the whole attempt loop
    let feeData = options.feeData || null;
    try {
        if (!feeData) feeData = await getCachedFeeData();
    } catch (_) {}
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
        try {
            // First attempts: direct exactInputSingle (fastest). Later: multicall fallback.
            const useSkipMulticall =
                options.skipMulticall === false
                    ? false
                    : options.skipMulticall === true
                      ? true
                      : i < (waitForFill ? 2 : 3);
            const tx = await buy(walletData, amountEth, tokenAddress, {
                ...options,
                fee,
                pairedToken,
                feeData: feeData || undefined,
                clamp: options.clamp !== false,
                requireQuote: false,
                skipQuote: options.skipQuote !== false,
                skipMulticall: useSkipMulticall,
                // Aggressive tip so we land in the next block
                priorityMultiplier:
                    options.priorityMultiplier || (waitForFill ? 1.5 : 2.5),
                // Robinhood bots win with legacy gasPrice; EIP-1559 tip from RPC is often 0
                legacyGas:
                    options.legacyGas != null
                        ? options.legacyGas
                        : !waitForFill,
                preflight: options.preflight !== false,
                reserveSellGas: options.reserveSellGas !== false,
                sellGasReserveEth:
                    options.sellGasReserveEth != null
                        ? options.sellGasReserveEth
                        : undefined,
            });
            if (tx?.error) {
                lastErr = tx.error;
                // Preflight fail = not tradable yet / honeypot — brief wait then retry
                if (String(lastErr).startsWith("preflight:")) {
                    await sleep(Math.max(retryDelayMs, 250));
                } else {
                    await sleep(retryDelayMs);
                }
                continue;
            }
            if (!tx?.hash) {
                lastErr = "no tx hash";
                await sleep(retryDelayMs);
                continue;
            }
            // Fast path: broadcast = success for entry speed; confirm in background
            if (!waitForFill) {
                const onFill = typeof options.onFillResult === "function"
                    ? options.onFillResult
                    : null;
                const attempt = i + 1;
                const maxAttempts = retries;
                setImmediate(() => {
                    waitTx(tx, 1)
                        .then(async (receipt) => {
                            if (!receipt || receipt.status !== 1) {
                                console.warn(`snipe fill failed/reverted: ${tx.hash}`);
                                // One automatic retry after revert — many NOXA tokens
                                // reject the first external buys then open a few blocks later.
                                if (attempt < maxAttempts) {
                                    try {
                                        await sleep(350);
                                        const retry = await snipeBuy(
                                            walletData,
                                            amountEth,
                                            tokenAddress,
                                            {
                                                ...options,
                                                waitForFill: true,
                                                retries: Math.max(1, maxAttempts - attempt),
                                                retryDelayMs: 300,
                                                legacyGas: true,
                                                preflight: true,
                                                skipMulticall: false,
                                                priorityMultiplier:
                                                    (options.priorityMultiplier || 2.75) * 1.15,
                                            }
                                        );
                                        if (retry?.ok && onFill) {
                                            onFill({
                                                ok: true,
                                                hash: retry.hash,
                                                tokensRaw: retry.tokensRaw,
                                                retried: true,
                                            });
                                            return;
                                        }
                                        if (onFill) {
                                            onFill({
                                                ok: false,
                                                hash: tx.hash,
                                                reason: retry?.error || "reverted",
                                                retried: true,
                                            });
                                        }
                                        return;
                                    } catch (e) {
                                        if (onFill) {
                                            onFill({
                                                ok: false,
                                                hash: tx.hash,
                                                reason: e.message || "reverted",
                                                retried: true,
                                            });
                                        }
                                        return;
                                    }
                                }
                                if (onFill) {
                                    onFill({
                                        ok: false,
                                        hash: tx.hash,
                                        reason: "reverted",
                                    });
                                }
                                return;
                            }
                            try {
                                const { balance } = await getTokenBalanceRaw(
                                    wallet.address,
                                    tokenAddress
                                );
                                if (!(balance > 0n)) {
                                    console.warn(`snipe confirmed but 0 tokens: ${tx.hash}`);
                                    if (onFill) {
                                        onFill({
                                            ok: false,
                                            hash: tx.hash,
                                            reason: "zero_tokens",
                                        });
                                    }
                                    return;
                                }
                                if (onFill) {
                                    onFill({
                                        ok: true,
                                        hash: tx.hash,
                                        tokensRaw: balance.toString(),
                                    });
                                }
                            } catch (e) {
                                if (onFill) {
                                    onFill({
                                        ok: false,
                                        hash: tx.hash,
                                        reason: e.message || "balance_check_failed",
                                    });
                                }
                            }
                        })
                        .catch((e) => {
                            if (onFill) {
                                onFill({
                                    ok: false,
                                    hash: tx.hash,
                                    reason: e.message || "confirm_failed",
                                });
                            }
                        });
                });
                return {
                    ok: true,
                    hash: tx.hash,
                    attempt: i + 1,
                    pending: true,
                };
            }
            // Confirm on-chain — broadcast ≠ fill
            let receipt;
            try {
                receipt = await waitTx(tx, 1);
            } catch (e) {
                lastErr = e.shortMessage || e.message || "tx not confirmed";
                await sleep(retryDelayMs);
                continue;
            }
            if (!receipt || receipt.status !== 1) {
                lastErr = `tx reverted: ${tx.hash}`;
                await sleep(retryDelayMs);
                continue;
            }
            // Verify tokens actually landed (honeypot / fee-on-transfer / wrong pool)
            await sleep(150);
            const { balance } = await getTokenBalanceRaw(
                wallet.address,
                tokenAddress
            );
            if (!(balance > 0n)) {
                lastErr = `confirmed but 0 tokens (${tx.hash})`;
                await sleep(retryDelayMs);
                continue;
            }
            return {
                ok: true,
                hash: tx.hash,
                attempt: i + 1,
                tokensRaw: balance.toString(),
            };
        } catch (e) {
            lastErr = e.shortMessage || e.message;
            if (isHttp404(e) && i >= 1) {
                options.tokenInfo =
                    options.tokenInfo ||
                    syntheticTokenInfo({
                        address: tokenAddress,
                        poolFee: fee,
                        pairedToken,
                        symbol: options.symbol,
                        name: options.name,
                    });
            }
            await sleep(retryDelayMs);
        }
    }
    return { ok: false, error: lastErr || "snipe failed" };
}

function resolvePoolFee(tokenInfo) {
    const fee = tokenInfo?.token?.poolFee ?? tokenInfo?.poolFee;
    return fee != null ? Number(fee) : DEFAULT_POOL_FEE;
}

function resolvePairedToken(tokenInfo) {
    return (
        tokenInfo?.token?.pairedToken ||
        tokenInfo?.pairedToken ||
        WETH
    );
}

/**
 * Estimate gas cost for a buy (gasLimit * maxFee), with a small safety pad.
 */
async function estimateBuyGasCost(gasLimit = 500000n) {
    const feeData = await provider.getFeeData();
    const gasPrice =
        feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("5", "gwei");
    const pad = ethers.parseEther("0.00005");
    return gasLimit * gasPrice + pad;
}

/**
 * Estimate gas needed to sell later (swap + unwrap + optional approve).
 * Used so sniper buys never drain the wallet below exit-capable ETH.
 */
async function estimateSellGasCost({
    gasLimit = 450000n,
    includeApprove = true,
} = {}) {
    const feeData = await provider.getFeeData();
    const gasPrice =
        feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("5", "gwei");
    const approveGas = includeApprove ? 60000n : 0n;
    const pad = ethers.parseEther("0.00008");
    return (gasLimit + approveGas) * gasPrice + pad;
}

/**
 * Detect creator/dev sells in a swap list.
 * Returns matching sell swaps (newest first) above minEth.
 */
function detectCreatorSells(
    swaps,
    creatorAddress,
    { minEth = 0.001, sinceTs = 0 } = {}
) {
    const creator = String(creatorAddress || "").toLowerCase();
    if (!creator || creator.length < 10) return [];
    const since = Number(sinceTs || 0);
    return (swaps || [])
        .filter((s) => {
            if (String(s.side || "").toLowerCase() !== "sell") return false;
            if (!(Number(s.ethAmount || 0) >= Number(minEth))) return false;
            if (since && s.timestamp && Number(s.timestamp) < since - 2) return false;
            const trader = String(s.trader || "").toLowerCase();
            return trader === creator;
        })
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}

/**
 * Buy token with native ETH via Uniswap V3 exactInputSingle (WETH -> token).
 * amount is ETH amount as a decimal string/number (e.g. "0.01").
 * If the wallet can't cover amount + gas, clamps the buy down (unless clamp=false).
 *
 * Fast-path options for burst multi-buy:
 *   tokenInfo, fee, pairedToken, feeData, gasCost — skip repeated RPC/API calls
 *   skipQuote — use minOut=0 (faster; rely on slippage tolerance of pool)
 *   priorityMultiplier — bump tip for faster inclusion
 */
async function buy(walletData, amount, tokenAddress, options = {}) {
    const wallet = new ethers.Wallet(walletData.private_key, provider);
    const tokenInfo = await resolveTokenInfo(tokenAddress, options);
    if (tokenInfo?.source === "synthetic") {
        console.log(
            `buy: NOXA API missing ${tokenAddress.slice(0, 10)}… — using fee ${options.fee ?? DEFAULT_POOL_FEE} / WETH`
        );
    }
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const pairedToken = options.pairedToken ?? resolvePairedToken(tokenInfo);
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const gasLimit = options.gasLimit ?? 500000n;
    const allowClamp = options.clamp !== false;
    const skipQuote = options.skipQuote === true;

    let amountIn = parseEthAmount(amount);
    const bal =
        options.balance != null
            ? BigInt(options.balance)
            : await provider.getBalance(wallet.address);
    const gasCost =
        options.gasCost != null
            ? BigInt(options.gasCost)
            : await estimateBuyGasCost(gasLimit);
    // Sniper path: leave enough ETH to sell later. Bundler buys opt out (reserveSellGas:false).
    let sellReserve = 0n;
    if (options.sellGasReserve != null) {
        sellReserve = BigInt(options.sellGasReserve);
    } else if (options.sellGasReserveEth != null) {
        sellReserve = ethers.parseEther(String(options.sellGasReserveEth));
    } else if (options.reserveSellGas === true) {
        try {
            sellReserve = await estimateSellGasCost();
        } catch (_) {
            sellReserve = ethers.parseEther("0.00035");
        }
    }
    const reserveTotal = gasCost + sellReserve;
    const needed = amountIn + reserveTotal;

    if (bal < needed) {
        const maxSpend = bal > reserveTotal ? bal - reserveTotal : 0n;
        if (maxSpend <= 0n) {
            return {
                error: `insufficient funds: have ${ethers.formatEther(bal)} ETH, need ~${ethers.formatEther(needed)} (buy ${amount} + buy-gas + sell-gas reserve)`,
            };
        }
        if (!allowClamp) {
            return {
                error: `insufficient funds: have ${ethers.formatEther(bal)} ETH, need ~${ethers.formatEther(needed)} (buy + gas + sell reserve). Re-fund with gas buffer.`,
            };
        }
        console.log(
            `Clamping buy ${ethers.formatEther(amountIn)} → ${ethers.formatEther(maxSpend)} ETH (leave buy-gas + sell-gas ${ethers.formatEther(sellReserve)})`
        );
        amountIn = maxSpend;
    }

    let amountOutMinimum = 0n;

    if (!skipQuote) {
        try {
            const quoted = await quoteExactInput(
                pairedToken,
                tokenAddress,
                amountIn,
                fee
            );
            amountOutMinimum = applySlippage(quoted, slippageBps);
            console.log(
                "quote amountOut:",
                ethers.formatEther(quoted),
                "minOut:",
                ethers.formatEther(amountOutMinimum)
            );
        } catch (error) {
            console.log("Quote failed, using minOut=0:", error.message);
            if (options.requireQuote) {
                return { error: "Quote failed: " + error.message };
            }
        }
    }

    const swapParams = {
        tokenIn: pairedToken,
        tokenOut: tokenAddress,
        fee,
        recipient: wallet.address,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
    };
    // Direct exactInputSingle skips multicall wrapper (~5-15k gas saved).
    // Multicall kept as default for normal buys (deadline + NOXA UI parity).
    let data;
    if (options.skipMulticall) {
        data = routerIface.encodeFunctionData("exactInputSingle", [swapParams]);
    } else {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
        const swapData = routerIface.encodeFunctionData("exactInputSingle", [
            swapParams,
        ]);
        data = routerIface.encodeFunctionData("multicall", [
            deadline,
            [swapData],
        ]);
    }

    const feeData = options.feeData || (await getCachedFeeData());
    const priorityMult = Number(options.priorityMultiplier || 1);
    const tx = {
        to: ROUTER_CONTRACT_ADDRESS,
        value: amountIn,
        data,
        chainId: CHAIN_ID,
        gasLimit,
    };

    // Prefer legacy type-0 on sniper path — competing bots on Robinhood use gasPrice
    // and EIP-1559 tips from this RPC are often stuck at 0.
    if (options.legacyGas === true && feeData.gasPrice) {
        const mult = BigInt(Math.round(Math.max(1, priorityMult) * 100));
        let gp = (feeData.gasPrice * mult) / 100n;
        const floor = ethers.parseUnits(
            String(process.env.MIN_GAS_PRICE_GWEI || "0.1"),
            "gwei"
        );
        if (gp < floor) gp = floor;
        tx.gasPrice = gp;
        tx.type = 0;
    } else if (options.useProvidedFees === true && feeData.maxFeePerGas != null) {
        // Volume / cheap padder: use exact tip+maxFee (tip may be 0) — don't bump via resolveEip1559Fees
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas =
            feeData.maxPriorityFeePerGas != null ? feeData.maxPriorityFeePerGas : 0n;
        tx.type = 2;
    } else if (feeData.maxFeePerGas || feeData.gasPrice) {
        const fees = resolveEip1559Fees(feeData, priorityMult);
        tx.maxFeePerGas = fees.maxFeePerGas;
        tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
        tx.type = 2;
    }

    if (options.nonce != null) {
        tx.nonce = options.nonce;
    }

    // Skip doomed buys (honeypot / not tradable yet) before spending gas
    if (options.preflight !== false) {
        try {
            await provider.estimateGas({
                to: tx.to,
                from: wallet.address,
                data: tx.data,
                value: tx.value,
            });
        } catch (e) {
            const msg = e.shortMessage || e.reason || e.message || "estimateGas failed";
            return { error: `preflight: ${msg}` };
        }
    }

    const sentTx = await withWalletSendLock(wallet.address, () =>
        wallet.sendTransaction(tx)
    );
    console.log(`Buy sent: ${EXPLORER_TX}${sentTx.hash}`);
    return sentTx;
}

/**
 * Sell token for native ETH via Uniswap V3 exactInputSingle + unwrapWETH9.
 * amount is token amount as a decimal string/number.
 *
 * Fast-path options (used by multiSell):
 *   quoted / amountOutMinimum — skip duplicate quoter RPC
 *   feeData — reuse one fee snapshot for the whole sell batch
 *   priorityMultiplier — bump tip so sells land in the next block (default 1.5)
 *   skipQuote — fire with minOut=0 (max speed / dump mode)
 */
async function sell(walletData, amount, tokenAddress, options = {}) {
    const wallet = new ethers.Wallet(walletData.private_key, provider);
    const tokenInfo = await resolveTokenInfo(tokenAddress, options);
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const pairedToken =
        options.pairedToken ?? resolvePairedToken(tokenInfo);
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    let decimals = Number(tokenInfo?.token?.decimals ?? 18);
    if (tokenInfo?.source === "synthetic") {
        try {
            const c = new ethers.Contract(
                tokenAddress,
                ["function decimals() view returns (uint8)"],
                provider
            );
            decimals = Number(await c.decimals());
        } catch (_) {}
    }

    const amountIn = ethers.parseUnits(amount.toString(), decimals);

    await ensureAllowance(wallet, tokenAddress, ROUTER, amountIn);

    let amountOutMinimum = 0n;
    if (options.amountOutMinimum != null) {
        amountOutMinimum = BigInt(options.amountOutMinimum);
    } else if (options.quoted != null && !options.skipQuote) {
        amountOutMinimum = applySlippage(BigInt(options.quoted), slippageBps);
    } else if (!options.skipQuote) {
        try {
            const quoted = await quoteExactInput(
                tokenAddress,
                pairedToken,
                amountIn,
                fee
            );
            amountOutMinimum = applySlippage(quoted, slippageBps);
            console.log(
                "quote amountOut (WETH):",
                ethers.formatEther(quoted),
                "minOut:",
                ethers.formatEther(amountOutMinimum)
            );
        } catch (error) {
            console.log("Quote failed, using minOut=0:", error.message);
            if (options.requireQuote) {
                return { error: "Quote failed: " + error.message };
            }
        }
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // Send WETH to router address (0x02 sentinel) then unwrap to wallet — same as NOXA UI
    const ROUTER_ETH_RECIPIENT = "0x0000000000000000000000000000000000000002";
    const swapData = routerIface.encodeFunctionData("exactInputSingle", [
        {
            tokenIn: tokenAddress,
            tokenOut: pairedToken,
            fee,
            recipient: ROUTER_ETH_RECIPIENT,
            amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96: 0n,
        },
    ]);
    const unwrapData = routerIface.encodeFunctionData("unwrapWETH9", [
        amountOutMinimum,
        wallet.address,
    ]);

    const data = routerIface.encodeFunctionData("multicall", [
        deadline,
        [swapData, unwrapData],
    ]);

    const feeData = options.feeData || (await provider.getFeeData());
    // Bump tip so sells land faster than default RPC suggestions
    const priorityMult = Number(
        options.priorityMultiplier != null ? options.priorityMultiplier : 1.5
    );
    const tx = {
        to: ROUTER_CONTRACT_ADDRESS,
        value: 0n,
        data,
        chainId: CHAIN_ID,
        gasLimit: options.gasLimit ?? 450000n,
    };

    if (options.useProvidedFees === true && feeData.maxFeePerGas != null) {
        tx.maxFeePerGas = feeData.maxFeePerGas;
        tx.maxPriorityFeePerGas =
            feeData.maxPriorityFeePerGas != null ? feeData.maxPriorityFeePerGas : 0n;
        tx.type = 2;
    } else {
        const fees = resolveEip1559Fees(feeData, priorityMult);
        tx.maxFeePerGas = fees.maxFeePerGas;
        tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
        tx.type = 2;
    }

    if (options.nonce != null) tx.nonce = options.nonce;

    const sentTx = await withWalletSendLock(wallet.address, () =>
        wallet.sendTransaction(tx)
    );
    console.log(`Sell sent: ${EXPLORER_TX}${sentTx.hash}`);
    return sentTx;
}

/** Run async work over items with a concurrency limit (keeps RPC responsive at 100+ wallets). */
async function mapPool(items, concurrency, fn) {
    const list = Array.from(items);
    const results = new Array(list.length);
    let next = 0;
    const workers = Array.from(
        { length: Math.min(concurrency, Math.max(1, list.length)) },
        async () => {
            while (next < list.length) {
                const i = next++;
                results[i] = await fn(list[i], i);
            }
        }
    );
    await Promise.all(workers);
    return results;
}

async function getWalletBalance(wallet_address) {
    const balance = await provider.getBalance(wallet_address);
    return ethers.formatEther(balance);
}

async function getTokenBalance(wallet_address, tokenAddress) {
    const tokenContract = new ethers.Contract(
        tokenAddress,
        ERC20_ABI,
        provider
    );
    const tokenBalance = await tokenContract.balanceOf(wallet_address);
    let decimals = 18;
    try {
        decimals = Number(await tokenContract.decimals());
    } catch (_) {}
    return ethers.formatUnits(tokenBalance, decimals);
}

async function getTokenBalanceRaw(wallet_address, tokenAddress, options = {}) {
    const tokenContract = new ethers.Contract(
        tokenAddress,
        ERC20_ABI,
        provider
    );
    const balance = await tokenContract.balanceOf(wallet_address);
    let decimals = options.decimals != null ? Number(options.decimals) : null;
    if (decimals == null) {
        decimals = 18;
        try {
            decimals = Number(await tokenContract.decimals());
        } catch (_) {}
    }
    return { balance, decimals };
}

/**
 * Quote selling `amount` tokens (decimal string/number or "max" with wallet).
 * Returns ETH out estimates + fee/impact vs a tiny reference trade.
 */
async function quoteSell(tokenAddress, amountTokens, options = {}) {
    const tokenInfo = await resolveTokenInfo(tokenAddress, options);
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const pairedToken =
        options.pairedToken ?? resolvePairedToken(tokenInfo);
    let decimals = Number(tokenInfo?.token?.decimals ?? 18);
    if (tokenInfo?.source === "synthetic") {
        try {
            const c = new ethers.Contract(
                tokenAddress,
                ["function decimals() view returns (uint8)"],
                provider
            );
            decimals = Number(await c.decimals());
        } catch (_) {}
    }
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const poolFeeBps = fee / 100; // Uniswap fee is in hundredths of a bip (10000 = 1%)

    const amountIn =
        typeof amountTokens === "bigint"
            ? amountTokens
            : ethers.parseUnits(String(amountTokens), decimals);

    if (amountIn <= 0n) {
        return {
            amountIn: "0",
            ethOut: 0,
            ethOutMin: 0,
            poolFeeBps,
            error: "zero amount",
        };
    }

    let quoted;
    try {
        quoted = await quoteExactInput(
            tokenAddress,
            pairedToken,
            amountIn,
            fee
        );
    } catch (e) {
        return {
            amountIn: ethers.formatUnits(amountIn, decimals),
            ethOut: 0,
            ethOutMin: 0,
            poolFeeBps,
            error: e.shortMessage || e.message,
        };
    }

    const ethOut = Number(ethers.formatEther(quoted));
    const ethOutMin = Number(
        ethers.formatEther(applySlippage(quoted, slippageBps))
    );

    // Spot estimate: quote a tiny sample and scale (ignores impact)
    let spotEth = null;
    let priceImpactPct = null;
    try {
        const sample = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
        const sampleOut = await quoteExactInput(
            tokenAddress,
            pairedToken,
            sample,
            fee
        );
        const scale = Number(amountIn) / Number(sample);
        spotEth = Number(ethers.formatEther(sampleOut)) * scale;
        if (spotEth > 0) {
            priceImpactPct = ((spotEth - ethOut) / spotEth) * 100;
            if (priceImpactPct < 0) priceImpactPct = 0;
        }
    } catch (_) {}

    return {
        amountIn: ethers.formatUnits(amountIn, decimals),
        amountInWei: amountIn.toString(),
        ethOut,
        ethOutMin,
        spotEth,
        priceImpactPct,
        poolFeeBps,
        poolFeePct: poolFeeBps / 100,
        slippageBps,
        fee,
        decimals,
        symbol: tokenInfo?.token?.symbol || tokenInfo?.symbol || "TOKEN",
    };
}

/**
 * Build per-wallet positions + P&L for a token.
 * costEth = buyAmountEth spent (basis). profit = quotedEthOut - costEth.
 * Also estimates sequential sell-all impact (each quote after prior size).
 */
async function estimatePositions(wallets, tokenAddress, options = {}) {
    const tokenInfo = options.tokenInfo || (await resolveTokenInfo(tokenAddress, options));
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const pairedToken = resolvePairedToken(tokenInfo);
    const decimals = Number(tokenInfo?.token?.decimals ?? 18);
    const symbol =
        tokenInfo?.token?.symbol || tokenInfo?.symbol || "TOKEN";
    const poolFeeBps = fee / 100;
    const concurrency = Math.min(
        20,
        Math.max(4, Number(options.concurrency || 12))
    );

    // Parallel balance reads — biggest win at 100+ wallets
    const balances = await mapPool(wallets, concurrency, async (w) => {
        try {
            const { balance } = await getTokenBalanceRaw(w.address, tokenAddress);
            return balance;
        } catch (_) {
            return 0n;
        }
    });

    // Parallel per-wallet alone quotes (only wallets that hold tokens)
    const aloneQuotes = await mapPool(wallets, concurrency, async (w, i) => {
        const balance = balances[i];
        if (!(balance > 0n)) {
            return { ethOut: 0, ethOutMin: 0, priceImpactPct: null, quoteError: null };
        }
        try {
            const q = await quoteSell(tokenAddress, balance, {
                fee,
                slippageBps: options.slippageBps,
            });
            return {
                ethOut: q.ethOut || 0,
                ethOutMin: q.ethOutMin || 0,
                priceImpactPct: q.priceImpactPct,
                quoteError: q.error || null,
            };
        } catch (e) {
            return {
                ethOut: 0,
                ethOutMin: 0,
                priceImpactPct: null,
                quoteError: e.shortMessage || e.message,
            };
        }
    });

    const rows = [];
    let totalCost = 0;
    let totalTokens = 0n;
    let totalEthAlone = 0;
    let cumulativeSold = 0n;
    let totalEthSequential = 0;

    // Dump path must stay sequential (order-dependent), but reuse alone quote as fallback
    for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i];
        const addr = w.address;
        const balance = balances[i] || 0n;
        const costEth = Number(w.buyAmountEth ?? w.costEth ?? 0) || 0;
        const alone = aloneQuotes[i] || {};
        let ethOut = alone.ethOut || 0;
        let ethOutMin = alone.ethOutMin || 0;
        let priceImpactPct = alone.priceImpactPct;
        let quoteError = alone.quoteError;

        let ethOutIfDump = ethOut;
        if (balance > 0n) {
            try {
                const after = cumulativeSold + balance;
                const outAfter = await quoteExactInput(
                    tokenAddress,
                    pairedToken,
                    after,
                    fee
                );
                let outBefore = 0n;
                if (cumulativeSold > 0n) {
                    outBefore = await quoteExactInput(
                        tokenAddress,
                        pairedToken,
                        cumulativeSold,
                        fee
                    );
                }
                ethOutIfDump = Number(
                    ethers.formatEther(outAfter - outBefore)
                );
                cumulativeSold = after;
                totalEthSequential += ethOutIfDump;
            } catch (_) {
                totalEthSequential += ethOut;
                cumulativeSold += balance;
            }
        }

        const profitAlone = ethOut - costEth;
        const profitDump = ethOutIfDump - costEth;
        const pctAlone = costEth > 0 ? (profitAlone / costEth) * 100 : null;
        const pctDump = costEth > 0 ? (profitDump / costEth) * 100 : null;

        totalCost += costEth;
        totalTokens += balance;
        totalEthAlone += ethOut;

        rows.push({
            name: w.name || addr,
            address: addr,
            role: w.role || "buyer",
            tokens: Number(ethers.formatUnits(balance, decimals)),
            tokensRaw: balance.toString(),
            tokenBalanceRaw: balance.toString(),
            costEth,
            realizedProfitEth: Number(w.realizedProfitEth || 0) || 0,
            realizedEthOut: Number(w.realizedEthOut || 0) || 0,
            ethOut,
            ethOutMin,
            ethOutIfDump,
            profitEth: profitAlone,
            profitPct: pctAlone,
            profitIfDumpEth: profitDump,
            profitIfDumpPct: pctDump,
            priceImpactPct,
            quoteError,
            hasTokens: balance > 0n,
        });
    }

    const ethUsd = await getEthUsdPrice();
    const toUsd = (eth) => ethToUsd(Number(eth) || 0, ethUsd);
    for (const r of rows) {
        r.costUsd = toUsd(r.costEth);
        r.worthUsd = toUsd(r.ethOut);
        r.worthIfDumpUsd = toUsd(r.ethOutIfDump);
        r.profitUsd = toUsd(r.profitEth);
        r.profitIfDumpUsd = toUsd(r.profitIfDumpEth);
        r.costUsdLabel = formatUsd(r.costUsd, 2);
        r.worthUsdLabel = formatUsd(r.worthUsd, 2);
        r.profitUsdLabel = formatUsdSigned(r.profitUsd, 2);
        r.worthIfDumpUsdLabel = formatUsd(r.worthIfDumpUsd, 2);
    }

    const totalProfitAlone = totalEthAlone - totalCost;
    const totalProfitDump = totalEthSequential - totalCost;
    const dumpImpactEth = totalEthAlone - totalEthSequential;
    const dumpImpactPct =
        totalEthAlone > 0 ? (dumpImpactEth / totalEthAlone) * 100 : 0;

    return {
        token: tokenAddress,
        symbol,
        decimals,
        poolFeeBps,
        poolFeePct: poolFeeBps / 100,
        slippageBps: options.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
        ethUsd,
        rows,
        summary: {
            wallets: rows.length,
            withTokens: rows.filter((r) => r.hasTokens).length,
            totalTokens: Number(ethers.formatUnits(totalTokens, decimals)),
            totalCostEth: totalCost,
            totalEthOutAlone: totalEthAlone,
            totalEthOutIfDump: totalEthSequential,
            // Dump total = Uniswap quote of ALL tokens as one swap (not multi-tx sequential).
            // Per-wallet ethOutIfDump is a partition of that batch quote in wallet order.
            dumpMethod: "batch_quoter",
            totalProfitAlone,
            totalProfitIfDump: totalProfitDump,
            dumpImpactEth,
            dumpImpactPct,
            totalProfitPctAlone:
                totalCost > 0 ? (totalProfitAlone / totalCost) * 100 : null,
            totalProfitPctDump:
                totalCost > 0 ? (totalProfitDump / totalCost) * 100 : null,
            ethUsd,
            totalCostUsd: toUsd(totalCost),
            totalWorthAloneUsd: toUsd(totalEthAlone),
            totalWorthDumpUsd: toUsd(totalEthSequential),
            totalProfitAloneUsd: toUsd(totalProfitAlone),
            totalProfitDumpUsd: toUsd(totalProfitDump),
            dumpImpactUsd: toUsd(dumpImpactEth),
            totalCostUsdLabel: formatUsd(toUsd(totalCost), 2),
            totalWorthAloneUsdLabel: formatUsd(toUsd(totalEthAlone), 2),
            totalWorthDumpUsdLabel: formatUsd(toUsd(totalEthSequential), 2),
            totalProfitAloneUsdLabel: formatUsdSigned(toUsd(totalProfitAlone), 2),
            totalProfitDumpUsdLabel: formatUsdSigned(toUsd(totalProfitDump), 2),
        },
    };
}

function median(nums) {
    if (!nums.length) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sum(nums) {
    return nums.reduce((a, b) => a + b, 0);
}

/**
 * Fetch recent swaps for a token (NOXA API). Used by tape + mid-bundle interference guard.
 */
async function fetchRecentSwaps(tokenAddress, { limit = 80 } = {}) {
    const addr = String(tokenAddress || "").toLowerCase();
    try {
        const r = await axios.get(
            `${API_URL}/v1/robinhood/token/${addr}/swaps`,
            { ...axiosConfig(), params: { limit } }
        );
        const swaps = Array.isArray(r.data?.swaps) ? r.data.swaps : [];
        return swaps.map((s) => ({
            side: String(s.side || "").toLowerCase(),
            ethAmount: Number(s.ethAmount || 0),
            trader: String(s.trader || s.sender || s.from || "").toLowerCase(),
            timestamp: Number(s.timestamp || 0),
            txHash: s.txHash || s.hash || null,
            priceEth: Number(s.priceEth || 0),
        }));
    } catch (_) {
        return [];
    }
}

/**
 * Foreign buys since `sinceTs` that are not from our wallet set.
 */
function detectForeignBuys(swaps, ownSet, sinceTs, { minEth = 0.005 } = {}) {
    const own = ownSet instanceof Set ? ownSet : new Set(ownSet || []);
    const since = Number(sinceTs || 0);
    return (swaps || []).filter((s) => {
        if (s.side !== "buy") return false;
        if (!(s.ethAmount >= Number(minEth))) return false;
        if (s.timestamp && s.timestamp < since - 2) return false; // small clock skew
        if (!s.trader) return true; // unknown trader — treat as foreign
        return !own.has(s.trader);
    });
}

/**
 * Analyze live tape (swaps + OHLC) for sell timing — MM-style signals.
 */
async function analyzeMarketTape(tokenAddress) {
    const addr = String(tokenAddress || "").toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    const [detailRes, ohlcRes, swapsRes] = await Promise.all([
        axios
            .get(`${API_URL}/v1/robinhood/token/${addr}`, axiosConfig())
            .then((r) => r.data)
            .catch(() => null),
        axios
            .get(`${API_URL}/v1/robinhood/token/${addr}/ohlc`, {
                ...axiosConfig(),
                params: { interval: "1m" },
            })
            .then((r) => r.data)
            .catch(() => null),
        axios
            .get(`${API_URL}/v1/robinhood/token/${addr}/swaps`, {
                ...axiosConfig(),
                params: { limit: 100 },
            })
            .then((r) => r.data)
            .catch(() => null),
    ]);

    const token = detailRes?.token || {};
    const pool = detailRes?.pool || {};
    const recentSwaps = Array.isArray(swapsRes?.swaps)
        ? swapsRes.swaps
        : Array.isArray(detailRes?.recentSwaps)
          ? detailRes.recentSwaps
          : [];

    const candles = Array.isArray(ohlcRes?.candles) ? ohlcRes.candles : [];
    const lastCandles = candles.slice(-30);
    const last5 = lastCandles.slice(-5);
    const prev5 = lastCandles.slice(-10, -5);

    const priceNow = Number(token.priceEth || pool.priceEth || 0);
    const price5mAgo = last5.length ? Number(last5[0]?.open || priceNow) : priceNow;
    const priceChange5mPct =
        price5mAgo > 0 ? ((priceNow - price5mAgo) / price5mAgo) * 100 : 0;

    const volLast5 = sum(last5.map((c) => Number(c.volumeEth || 0)));
    const volPrev5 = sum(prev5.map((c) => Number(c.volumeEth || 0)));
    const volumeAccel =
        volPrev5 > 0 ? ((volLast5 - volPrev5) / volPrev5) * 100 : volLast5 > 0 ? 100 : 0;

    const windowSec = 180;
    const recent = recentSwaps.filter((s) => now - Number(s.timestamp || 0) <= windowSec);
    const buys = recent.filter((s) => String(s.side || "").toLowerCase() === "buy");
    const sells = recent.filter((s) => String(s.side || "").toLowerCase() === "sell");
    const buyVol = sum(buys.map((s) => Number(s.ethAmount || 0)));
    const sellVol = sum(sells.map((s) => Number(s.ethAmount || 0)));
    const netFlowEth = buyVol - sellVol;
    const flowBias =
        buyVol + sellVol > 0 ? ((buyVol - sellVol) / (buyVol + sellVol)) * 100 : 0;

    const tradeSizes = recent
        .map((s) => Number(s.ethAmount || 0))
        .filter((n) => n > 0);
    const medSize = median(tradeSizes);
    const largeTrades = tradeSizes.filter((n) => n >= Math.max(medSize * 3, 0.05));
    const largeBuyCount = buys.filter(
        (s) => Number(s.ethAmount || 0) >= Math.max(medSize * 3, 0.05)
    ).length;
    const largeSellCount = sells.filter(
        (s) => Number(s.ethAmount || 0) >= Math.max(medSize * 3, 0.05)
    ).length;

    // Momentum from last candles
    let greenStreak = 0;
    let redStreak = 0;
    for (let i = lastCandles.length - 1; i >= 0; i--) {
        const c = lastCandles[i];
        const up = Number(c.close) >= Number(c.open);
        if (i === lastCandles.length - 1) {
            if (up) greenStreak = 1;
            else redStreak = 1;
            continue;
        }
        if (greenStreak && up) greenStreak++;
        else if (redStreak && !up) redStreak++;
        else break;
    }

    const signals = [];
    let score = 50; // 0 = dump now, 100 = hold / ride

    if (priceChange5mPct >= 8) {
        score += 12;
        signals.push({
            type: "pump",
            severity: "bull",
            text: `Price up ${priceChange5mPct.toFixed(1)}% over ~5m — momentum still hot.`,
        });
    } else if (priceChange5mPct <= -8) {
        score -= 18;
        signals.push({
            type: "dump",
            severity: "bear",
            text: `Price down ${Math.abs(priceChange5mPct).toFixed(1)}% over ~5m — bleeding.`,
        });
    }

    if (volumeAccel >= 40) {
        score += 8;
        signals.push({
            type: "volume_surge",
            severity: "bull",
            text: `Volume accelerating (+${volumeAccel.toFixed(0)}% vs prior 5m).`,
        });
    } else if (volumeAccel <= -35) {
        score -= 14;
        signals.push({
            type: "volume_fade",
            severity: "bear",
            text: `Volume fading (${volumeAccel.toFixed(0)}% vs prior 5m) — exit window opening.`,
        });
    }

    if (flowBias >= 35) {
        score += 10;
        signals.push({
            type: "buy_pressure",
            severity: "bull",
            text: `Strong buy pressure last 3m (bias ${flowBias.toFixed(0)}%, net +${netFlowEth.toFixed(4)} ETH).`,
        });
    } else if (flowBias <= -35) {
        score -= 16;
        signals.push({
            type: "sell_pressure",
            severity: "bear",
            text: `Sell pressure last 3m (bias ${flowBias.toFixed(0)}%, net ${netFlowEth.toFixed(4)} ETH).`,
        });
    }

    if (largeSellCount >= 2 && largeSellCount > largeBuyCount) {
        score -= 12;
        signals.push({
            type: "whale_exit",
            severity: "bear",
            text: `${largeSellCount} large sells vs ${largeBuyCount} large buys — smart money exiting.`,
        });
    } else if (largeBuyCount >= 2 && largeBuyCount > largeSellCount) {
        score += 8;
        signals.push({
            type: "whale_entry",
            severity: "bull",
            text: `${largeBuyCount} large buys hitting tape — ride with them briefly.`,
        });
    }

    if (greenStreak >= 3) {
        score += 6;
        signals.push({
            type: "candle_streak",
            severity: "bull",
            text: `${greenStreak} green 1m candles in a row.`,
        });
    } else if (redStreak >= 3) {
        score -= 10;
        signals.push({
            type: "candle_streak",
            severity: "bear",
            text: `${redStreak} red 1m candles in a row.`,
        });
    }

    // Peak detection: last candle lower high after run-up
    if (last5.length >= 3) {
        const highs = last5.map((c) => Number(c.high || 0));
        const peak = Math.max(...highs);
        const lastHigh = highs[highs.length - 1];
        if (peak > 0 && lastHigh < peak * 0.97 && priceChange5mPct > 3) {
            score -= 8;
            signals.push({
                type: "local_top",
                severity: "warn",
                text: "Price rolling over from local high — classic distribution zone.",
            });
        }
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    let regime = "chop";
    let action = "Scale out carefully — no clear edge.";
    let urgency = "medium";

    if (score >= 72) {
        regime = "pump";
        action =
            "Ride the pump. Sell smallest wallets first (probe), hold big bags until volume fades.";
        urgency = "low";
    } else if (score >= 58) {
        regime = "bid_support";
        action = "Mild bid support. Start trimming mid-size wallets; keep largest for a push.";
        urgency = "medium";
    } else if (score <= 28) {
        regime = "dump";
        action =
            "Dump regime. Sell largest wallets first to front-run cascade, then clear the rest.";
        urgency = "critical";
    } else if (score <= 42) {
        regime = "distribution";
        action =
            "Distribution / volume fade. Exit now in size order (largest first) before liquidity thins.";
        urgency = "high";
    } else {
        regime = "chop";
        action = "Choppy tape. Probe with small wallets, then decide on size.";
        urgency = "medium";
    }

    return {
        tokenAddress: addr,
        fetchedAt: new Date().toISOString(),
        priceEth: priceNow,
        marketCapEth: Number(token.marketCapEth || 0),
        volume24hEth: Number(token.volume24hEth || 0),
        priceChange5mPct,
        volumeLast5mEth: volLast5,
        volumePrev5mEth: volPrev5,
        volumeAccelPct: volumeAccel,
        flow: {
            windowSec,
            buys: buys.length,
            sells: sells.length,
            buyVolEth: buyVol,
            sellVolEth: sellVol,
            netFlowEth,
            flowBiasPct: flowBias,
            largeBuys: largeBuyCount,
            largeSells: largeSellCount,
            medianTradeEth: medSize,
        },
        candles: {
            interval: ohlcRes?.interval || "1m",
            count: lastCandles.length,
            greenStreak,
            redStreak,
            last: lastCandles.slice(-8).map((c) => ({
                t: c.timestamp,
                o: Number(c.open),
                h: Number(c.high),
                l: Number(c.low),
                c: Number(c.close),
                v: Number(c.volumeEth || 0),
            })),
        },
        recentTape: recent.slice(0, 20).map((s) => ({
            side: s.side,
            eth: Number(s.ethAmount || 0),
            priceEth: Number(s.priceEth || 0),
            trader: s.trader,
            ts: s.timestamp,
            ageSec: Math.max(0, now - Number(s.timestamp || 0)),
        })),
        score,
        regime,
        urgency,
        action,
        signals,
        name: token.name || null,
        symbol: token.symbol || null,
    };
}

/**
 * Re-quote sells in a specific wallet order so each row's ETH out / MC
 * reflects prior sells in that order (not store order).
 */
async function simulateSequentialSells(orderedRows, tokenAddress, options = {}) {
    const tokenInfo = options.tokenInfo || (await getTokenInfo(tokenAddress));
    const t = tokenInfo.token || tokenInfo;
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const paired = resolvePairedToken(tokenInfo);
    const decimals = Number(t.decimals ?? 18);
    const supply = parseTokenSupply(tokenInfo, decimals);
    const ethUsd = options.ethUsd || (await getEthUsdPrice());
    // Prefer caller-provided live MC (quoter); fall back to API
    let mcapEth =
        Number(options.mcapEth) > 0
            ? Number(options.mcapEth)
            : resolveMarketCapEth(tokenInfo);
    const mcapStartEth = mcapEth;
    const mcapStartUsd = ethToUsd(mcapStartEth, ethUsd);

    let cumSold = 0n;
    let cumEth = 0;
    let cumCost = 0;
    const steps = [];

    for (let i = 0; i < orderedRows.length; i++) {
        const r = orderedRows[i];
        let bal = 0n;
        try {
            if (r.tokensRaw != null) {
                bal = BigInt(r.tokensRaw);
            } else {
                const got = await getTokenBalanceRaw(r.address, tokenAddress);
                bal = got.balance;
            }
        } catch (_) {
            bal = 0n;
        }
        if (!(bal > 0n)) {
            steps.push({
                ...r,
                order: i + 1,
                ethOutSeq: 0,
                mcapBeforeEth: mcapEth,
                mcapAfterEth: mcapEth,
                mcapBeforeUsd: ethToUsd(mcapEth, ethUsd),
                mcapAfterUsd: ethToUsd(mcapEth, ethUsd),
                mcapDropPct: 0,
                skipped: true,
            });
            continue;
        }

        const mcapBefore = mcapEth;
        let ethOutSeq = Number(r.ethOut || 0);
        try {
            const after = cumSold + bal;
            const outAfter = await quoteExactInput(
                tokenAddress,
                paired,
                after,
                fee
            );
            let outBefore = 0n;
            if (cumSold > 0n) {
                outBefore = await quoteExactInput(
                    tokenAddress,
                    paired,
                    cumSold,
                    fee
                );
            }
            ethOutSeq = Number(ethers.formatEther(outAfter - outBefore));
            cumSold = after;
        } catch (_) {
            // keep alone quote fallback
        }

        // NOXA bonding MC: selling removes ~ethOut from curve MC (API MC is in ETH).
        // USD MC = mcapEth * ethUsd — always derive USD from ETH MC, never invent a separate USD curve.
        if (ethOutSeq > 0 && mcapEth > 0) {
            mcapEth = Math.max(0.01, mcapEth - ethOutSeq);
        }
        const cost = Number(r.costEth || 0);
        cumEth += ethOutSeq;
        cumCost += cost;
        const alone = Number(r.ethOut || 0);
        const impactVsAlone =
            alone > 0 ? ((alone - ethOutSeq) / alone) * 100 : 0;

        steps.push({
            order: i + 1,
            label: r.name,
            name: r.name,
            address: r.address,
            role: r.role,
            tokenBalance: r.tokens,
            tokenBalanceRaw: bal.toString(),
            costEth: cost,
            ethOutAlone: alone,
            ethOutSeq,
            ethOutIfDump: ethOutSeq,
            profitAlone: alone - cost,
            profitSeq: ethOutSeq - cost,
            profitIfDump: ethOutSeq - cost,
            profitPct: cost > 0 ? ((alone - cost) / cost) * 100 : null,
            profitPctSeq: cost > 0 ? ((ethOutSeq - cost) / cost) * 100 : null,
            impactVsAlonePct: impactVsAlone,
            mcapBeforeEth: mcapBefore,
            mcapAfterEth: mcapEth,
            mcapBeforeUsd: ethToUsd(mcapBefore, ethUsd),
            mcapAfterUsd: ethToUsd(mcapEth, ethUsd),
            mcapDropPct:
                mcapBefore > 0
                    ? ((mcapBefore - mcapEth) / mcapBefore) * 100
                    : 0,
            cumulativeEthOut: cumEth,
            cumulativeProfit: cumEth - cumCost,
            shareOfExitPct: 0, // filled after
        });
    }

    const totalSeq = cumEth;
    for (const s of steps) {
        s.shareOfExitPct = totalSeq > 0 ? (s.ethOutSeq / totalSeq) * 100 : 0;
    }

    const aloneTotal = orderedRows.reduce(
        (a, r) => a + Number(r.ethOut || 0),
        0
    );
    return {
        steps,
        summary: {
            mcapStartEth,
            mcapStartUsd,
            mcapEndEth: mcapEth,
            mcapEndUsd: ethToUsd(mcapEth, ethUsd),
            mcapDropPct:
                mcapStartEth > 0
                    ? ((mcapStartEth - mcapEth) / mcapStartEth) * 100
                    : 0,
            totalEthOutAlone: aloneTotal,
            totalEthOutSequential: totalSeq,
            // Same as estimatePositions: telescoping batch quote in plan order
            dumpMethod: "batch_quoter_plan_order",
            dumpImpactEth: aloneTotal - totalSeq,
            dumpImpactPct:
                aloneTotal > 0 ? ((aloneTotal - totalSeq) / aloneTotal) * 100 : 0,
            totalCost: cumCost,
            totalProfitSequential: cumEth - cumCost,
            ethUsd,
            supply,
        },
    };
}

/**
 * MM cockpit: timing, dip support size, path toward a USD MC target.
 */
function buildMarketMakeAdvice(tape, sim, options = {}) {
    const targetUsd = Number(options.targetMcapUsd || 1_000_000);
    const ethUsd = sim.summary.ethUsd || 0;
    const mcapNowUsd = sim.summary.mcapStartUsd || 0;
    const mcapNowEth = sim.summary.mcapStartEth || 0;
    const steps = sim.steps || [];
    const tips = [];
    const playbook = [];

    // --- When volume slows / good time to sell ---
    let sellTiming = "hold_probe";
    let sellTimingLabel = "Hold / probe — no clear exit window yet";
    if (tape.urgency === "critical" || tape.regime === "dump") {
        sellTiming = "sell_now_fast";
        sellTimingLabel = "SELL NOW (fast) — dump / critical tape";
        playbook.push({
            priority: 1,
            action: "parallel_exit",
            text: "Hit Sell by plan / Sell all immediately — cascade risk.",
        });
    } else if (
        tape.regime === "distribution" ||
        (tape.volumeAccelPct <= -35 && tape.score < 55)
    ) {
        sellTiming = "scale_out_now";
        sellTimingLabel = "Scale out NOW — volume fading / distribution";
        playbook.push({
            priority: 1,
            action: "largest_first",
            text: "Volume dying — sell largest wallets first before liquidity thins.",
        });
    } else if (tape.regime === "pump" && tape.volumeAccelPct > 20) {
        sellTiming = "ride_trim";
        sellTimingLabel = "Ride pump — trim small probes only";
        playbook.push({
            priority: 1,
            action: "smallest_first",
            text: "Momentum hot — sell 1–2 small wallets as probes; hold size.",
        });
    } else if (tape.regime === "bid_support") {
        sellTiming = "trim_into_bids";
        sellTimingLabel = "Trim into bids — mild support";
        playbook.push({
            priority: 1,
            action: "mid_trim",
            text: "Bids absorbing — take mid-size profits; keep largest for a push.",
        });
    }

    // --- Dip support: how much we can buy the dip with without nuking MC ---
    // Aim to spend ~0.5–1.5% of current MC in ETH as support, capped by remaining bags.
    const supportBudgetEth = Math.min(
        Math.max(mcapNowEth * 0.008, 0.02),
        mcapNowEth * 0.02,
        Number(sim.summary.totalEthOutSequential || 0) * 0.15
    );
    const dipSupport = {
        recommendedBuyEth: Math.round(supportBudgetEth * 1e4) / 1e4,
        when:
            tape.regime === "dump" || tape.priceChange5mPct <= -8
                ? "active_dip"
                : tape.regime === "chop" && tape.volumeAccelPct < 0
                  ? "watch_for_dip"
                  : "not_yet",
        note:
            tape.regime === "dump"
                ? "Dip is live — a small support buy can refill bids, but don't catch a knife with size."
                : "Save ~" +
                  supportBudgetEth.toFixed(3) +
                  " ETH of dry powder (from profits) to buy a 8–15% dip and help the bounce.",
    };
    if (dipSupport.when === "active_dip") {
        playbook.push({
            priority: 2,
            action: "buy_dip",
            text: `Consider ~${dipSupport.recommendedBuyEth} ETH support buy into the dip (not full stack).`,
        });
    }

    // --- Path to target MC ($1M default) ---
    const multipleNeeded =
        mcapNowUsd > 0 ? targetUsd / mcapNowUsd : null;
    const ethNeededApprox =
        ethUsd > 0 && mcapNowEth > 0
            ? Math.max(0, targetUsd / ethUsd - mcapNowEth)
            : null;
    // Rough: external buy flow needed ≈ ΔMC (bonding-style)
    const pathToTarget = {
        targetMcapUsd: targetUsd,
        currentMcapUsd: mcapNowUsd,
        currentMcapEth: mcapNowEth,
        multipleNeeded:
            multipleNeeded != null ? Math.round(multipleNeeded * 100) / 100 : null,
        externalBuyEthNeeded:
            ethNeededApprox != null
                ? Math.round(ethNeededApprox * 1000) / 1000
                : null,
        reachable:
            multipleNeeded != null && multipleNeeded < 50
                ? multipleNeeded < 8
                    ? "plausible_with_flow"
                    : "needs_strong_narrative"
                : "far",
        advice:
            multipleNeeded == null
                ? "Need live MC to project path."
                : multipleNeeded <= 1
                  ? "Already at/above target — prioritize harvesting, not pumping."
                  : multipleNeeded <= 3
                    ? `Need ~${multipleNeeded.toFixed(1)}× from here (~${(ethNeededApprox || 0).toFixed(2)} ETH of net buy flow). Trim into strength; support shallow dips.`
                    : multipleNeeded <= 10
                      ? `Long shot (~${multipleNeeded.toFixed(1)}×). Keep most inventory; only probe-sell; use dip support to extend the run.`
                      : `Very far from $${(targetUsd / 1e6).toFixed(1)}M. Focus on not dumping the chart — tiny probes only.`,
    };

    // --- How much we can sell without killing the run ---
    // Hard cap: safe trim must NOT clip the chart. Keep cumulative MC drop tiny.
    const softDropPct =
        tape.urgency === "critical" || tape.regime === "dump"
            ? 100
            : tape.regime === "pump"
              ? 2.5
              : tape.regime === "bid_support"
                ? 3.5
                : 3;
    let safePrefix = 0;
    let safeEth = 0;
    for (const s of steps) {
        const dropFromStart =
            mcapNowEth > 0
                ? ((mcapNowEth - s.mcapAfterEth) / mcapNowEth) * 100
                : 0;
        if (dropFromStart > softDropPct) break;
        safePrefix++;
        safeEth = s.cumulativeEthOut;
    }
    const inventory = {
        walletsWithBags: steps.filter((s) => !s.skipped).length,
        sellAllSequentialEth: sim.summary.totalEthOutSequential,
        sellAllAloneEth: sim.summary.totalEthOutAlone,
        dumpHaircutPct: sim.summary.dumpImpactPct,
        mcapAfterFullDumpEth: sim.summary.mcapEndEth,
        mcapAfterFullDumpUsd: sim.summary.mcapEndUsd,
        safeTrimWallets: safePrefix,
        safeTrimEth: Math.round(safeEth * 1e5) / 1e5,
        safeTrimMcapDropPct: softDropPct,
        ethUsd,
        // USD view (what the UI should show)
        costUsd: ethToUsd(sim.summary.totalCost || 0, ethUsd),
        worthAloneUsd: ethToUsd(sim.summary.totalEthOutAlone || 0, ethUsd),
        worthDumpUsd: ethToUsd(sim.summary.totalEthOutSequential || 0, ethUsd),
        profitAloneUsd: ethToUsd(
            (sim.summary.totalEthOutAlone || 0) - (sim.summary.totalCost || 0),
            ethUsd
        ),
        profitDumpUsd: ethToUsd(sim.summary.totalProfitSequential || 0, ethUsd),
        safeTrimUsd: ethToUsd(safeEth, ethUsd),
        dumpHaircutUsd: ethToUsd(sim.summary.dumpImpactEth || 0, ethUsd),
        note: `Safe trim: first ${safePrefix} wallet(s) ≈ ${formatUsd(ethToUsd(safeEth, ethUsd), 0)} — keeps modeled MC drop ≤${softDropPct}%.`,
    };

    // Plain-English sell guide for pumps / dumps
    const sellGuide = {
        headline: sellTimingLabel,
        whenToSell:
            sellTiming === "sell_now_fast"
                ? "Sell now — tape is dumping / critical."
                : sellTiming === "scale_out_now"
                  ? "Volume fading — start scaling out before liquidity dies."
                  : sellTiming === "ride_trim"
                    ? "Big pump — take partial profits on small wallets; hold size."
                    : sellTiming === "trim_into_bids"
                      ? "Bids are catching — trim mid-size into strength."
                      : "No clear pump exit yet — probe tiny, wait for volume.",
        howMuchNowUsd: inventory.safeTrimUsd,
        howMuchNowWallets: safePrefix,
        howMuchNowPct: softDropPct,
        ifDumpAllUsd: inventory.worthDumpUsd,
        ifDumpAllProfitUsd: inventory.profitDumpUsd,
        ifSoldAloneUsd: inventory.worthAloneUsd,
        ifSoldAloneProfitUsd: inventory.profitAloneUsd,
        haircutUsd: inventory.dumpHaircutUsd,
        haircutPct: inventory.dumpHaircutPct,
        tip:
            sellTiming === "ride_trim"
                ? `On this pump: sell ~${formatUsd(inventory.safeTrimUsd, 0)} first (${safePrefix} wallets), watch if MC holds, then sell more.`
                : sellTiming === "sell_now_fast"
                  ? `Dump risk: exit fast. Realistic if you sell everything now: ~${formatUsd(inventory.worthDumpUsd, 0)} (not the alone-sum ${formatUsd(inventory.worthAloneUsd, 0)}).`
                  : `Realistic full exit today ≈ ${formatUsd(inventory.worthDumpUsd, 0)} profit ${formatUsdSigned(inventory.profitDumpUsd, 0)}. Alone-quotes look higher but ignore your own impact.`,
    };

    tips.push(tape.action);
    tips.push(sellTimingLabel);
    tips.push(pathToTarget.advice);
    tips.push(inventory.note);
    tips.push(sellGuide.tip);
    if (sim.summary.dumpImpactPct > 5) {
        tips.push(
            `Dump ALL now ≈ ${formatUsd(inventory.worthDumpUsd, 0)} out (alone-sum ${formatUsd(inventory.worthAloneUsd, 0)} — impact haircut ${sim.summary.dumpImpactPct.toFixed(0)}%). MC ${formatUsd(sim.summary.mcapStartUsd)} → ${formatUsd(sim.summary.mcapEndUsd)}.`
        );
    }
    if (tape.volumeAccelPct < -35) {
        tips.push("Volume dying — finish trims soon; late sells get worse fills.");
    }
    if (tape.flow?.netFlowEth < -0.05) {
        tips.push("Net sellers on tape — prioritize speed over perfect price.");
    }
    if (tape.flow?.netFlowEth > 0.05 && tape.regime === "pump") {
        tips.push("Bids still absorbing — don't full-exit the largest wallet yet.");
    }

    return {
        sellTiming,
        sellTimingLabel,
        sellGuide,
        dipSupport,
        pathToTarget,
        inventory,
        playbook: playbook.sort((a, b) => a.priority - b.priority),
        tips,
        softDropPct,
    };
}

/**
 * Project bag value / profit at higher market caps (USD).
 *
 * CORRECT scaling (must stay consistent with the "now" row):
 *   worthAlone(at MC) = aloneNow × (targetMC / MC_now)
 *   worthDump(at MC)  = dumpNow  × (targetMC / MC_now)
 *
 * Do NOT mix alone×multiple with a shrinking haircut — that made dump $ grow
 * faster than MC (e.g. 1.93× MC → 3.6× dump), which is wrong.
 */
function buildProfitLadder(positionsSummary, simSummary, options = {}) {
    const ethUsd = Number(simSummary.ethUsd || positionsSummary.ethUsd || 0);
    const costUsd =
        Number(positionsSummary.totalCostUsd) ||
        ethToUsd(positionsSummary.totalCostEth || simSummary.totalCost || 0, ethUsd) ||
        0;
    const aloneNow =
        Number(positionsSummary.totalWorthAloneUsd) ||
        ethToUsd(positionsSummary.totalEthOutAlone || simSummary.totalEthOutAlone || 0, ethUsd) ||
        0;
    const dumpNow =
        Number(positionsSummary.totalWorthDumpUsd) ||
        ethToUsd(
            positionsSummary.totalEthOutIfDump ||
                simSummary.totalEthOutSequential ||
                0,
            ethUsd
        ) ||
        0;
    const mcapNow = Number(simSummary.mcapStartUsd || 0);
    const haircutPct =
        aloneNow > 0 && dumpNow >= 0
            ? Math.max(0, ((aloneNow - dumpNow) / aloneNow) * 100)
            : Number(simSummary.dumpImpactPct || 0);
    // Default ladder rungs — skip anything below current MC in the loop
    const targets = Array.isArray(options.targetsUsd)
        ? options.targetsUsd
        : [5_000, 10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000, 1_000_000];

    function harvestPlan(multiple) {
        if (multiple < 1.5) return { harvestPct: 8, holdPct: 92, action: "tiny_probe" };
        if (multiple < 3) return { harvestPct: 15, holdPct: 85, action: "light_trim" };
        if (multiple < 8) return { harvestPct: 30, holdPct: 70, action: "scale_out" };
        if (multiple < 20) return { harvestPct: 50, holdPct: 50, action: "bank_half" };
        if (multiple < 50) return { harvestPct: 70, holdPct: 30, action: "heavy_harvest" };
        return { harvestPct: 85, holdPct: 15, action: "mostly_exit" };
    }

    function makeRung(target, multiple, isCurrent) {
        const worthAlone = aloneNow * multiple;
        // Same relative dump haircut as today — dump scales 1:1 with MC multiple
        const worthDump = (dumpNow > 0 ? dumpNow : aloneNow) * multiple;
        const profitAlone = worthAlone - costUsd;
        const profitDump = worthDump - costUsd;
        const { harvestPct, holdPct, action } = isCurrent
            ? { harvestPct: 10, holdPct: 90, action: "now" }
            : harvestPlan(multiple);
        const harvestUsd = worthDump * (harvestPct / 100);
        const holdUsd = worthDump * (holdPct / 100);
        return {
            mcapUsd: target,
            mcapUsdLabel: formatUsd(target, 0),
            multiple: Math.round(multiple * 100) / 100,
            isCurrent: Boolean(isCurrent),
            worthAloneUsd: worthAlone,
            worthDumpUsd: worthDump,
            profitAloneUsd: profitAlone,
            profitDumpUsd: profitDump,
            worthAloneUsdLabel: formatUsd(worthAlone, 0),
            worthDumpUsdLabel: formatUsd(worthDump, 0),
            profitAloneUsdLabel: formatUsdSigned(profitAlone, 0),
            profitDumpUsdLabel: formatUsdSigned(profitDump, 0),
            harvestPct,
            holdPct,
            harvestUsd,
            holdUsd,
            harvestUsdLabel: formatUsd(harvestUsd, 0),
            holdUsdLabel: formatUsd(holdUsd, 0),
            action,
            note: isCurrent
                ? `You are here · dump-all ≈ ${formatUsd(worthDump, 0)} (alone-sum ${formatUsd(worthAlone, 0)}, haircut ${haircutPct.toFixed(0)}%). Probe only.`
                : `At ${formatUsd(target, 0)} MC (${multiple.toFixed(2)}×): dump-all ≈ ${formatUsd(worthDump, 0)} · profit ≈ ${formatUsdSigned(profitDump, 0)}. Bank ~${harvestPct}% (≈${formatUsd(harvestUsd, 0)}), hold ~${holdPct}%.`,
        };
    }

    const rungs = [];
    if (mcapNow > 0 && (aloneNow > 0 || dumpNow > 0)) {
        rungs.push(makeRung(mcapNow, 1, true));
    }
    for (const target of targets) {
        if (!(mcapNow > 0) || !(aloneNow > 0 || dumpNow > 0)) continue;
        const multiple = target / mcapNow;
        if (multiple < 1.05) continue; // skip targets at/under current (already have "now")
        rungs.push(makeRung(target, multiple, false));
    }

    return {
        costUsd,
        costUsdLabel: formatUsd(costUsd, 0),
        aloneNowUsd: aloneNow,
        aloneNowUsdLabel: formatUsd(aloneNow, 0),
        dumpNowUsd: dumpNow,
        dumpNowUsdLabel: formatUsd(dumpNow, 0),
        mcapNowUsd: mcapNow,
        mcapNowUsdLabel: formatUsd(mcapNow, 0),
        haircutPct,
        ethUsd,
        method:
            "Dump worth = today's dump-all $ × (target MC ÷ current MC). Alone = today's alone-sum × same multiple. Same haircut % at every rung. Estimate only — rebuild for live quotes.",
        rungs,
    };
}

/**
 * Recommend least-impact probe sells.
 * Re-quotes the ACTUAL token amount (balance * %) so USD / MC hit are not linear guesses.
 * Profit uses proportional cost basis: costEth * (sellPercent/100).
 */
async function buildSellTheseNow(planRows, inventory, sellTiming, options = {}) {
    const tokenAddress = options.tokenAddress;
    const ethUsd = Number(options.ethUsd || inventory.ethUsd || 0);
    const mcapStartEth = Number(options.mcapStartEth || 0);
    const fee = options.fee;
    const maxCumDrop =
        sellTiming === "sell_now_fast"
            ? 100
            : sellTiming === "scale_out_now"
              ? 8
              : sellTiming === "ride_trim"
                ? 2.0
                : 2.5;
    const maxPerWalletDrop =
        sellTiming === "sell_now_fast"
            ? 100
            : sellTiming === "ride_trim"
              ? 0.8
              : 1.0;
    const maxWallets =
        sellTiming === "sell_now_fast"
            ? Math.max(1, Number(inventory.safeTrimWallets || 5))
            : 5;

    const list = [];
    let cumDrop = 0;
    let totalUsd = 0;
    let totalProfit = 0;
    let mcapEth = mcapStartEth > 0 ? mcapStartEth : 0;
    const mcapStartForCum = mcapEth;

    for (const p of planRows || []) {
        if (list.length >= maxWallets) break;
        const balRaw = BigInt(p.tokenBalanceRaw || p.tokensRaw || "0");
        if (!(balRaw > 0n)) continue;
        // Skip wallets with no / unknown cost (sniper dust, txbot, mis-roled)
        const costCheck = Number(p.costEth || 0);
        if (!(costCheck > 0)) continue;

        // Start from plan suggested %, then refine with real quote + MC budget
        let sellPercent = Math.min(
            100,
            Math.max(5, Number(p.suggestedPercent) || 10)
        );

        // Cap by per-wallet MC budget using full-bag drop as upper bound
        const fullDropHint = Math.max(0.01, Number(p.mcapDropPct || 0));
        if (fullDropHint > maxPerWalletDrop && sellTiming !== "sell_now_fast") {
            sellPercent = Math.max(
                5,
                Math.min(
                    sellPercent,
                    Math.floor((maxPerWalletDrop / fullDropHint) * 100)
                )
            );
        }
        const room = maxCumDrop - cumDrop;
        if (room <= 0.05 && sellTiming !== "sell_now_fast") break;
        if (fullDropHint * (sellPercent / 100) > room && sellTiming !== "sell_now_fast") {
            sellPercent = Math.max(
                5,
                Math.min(sellPercent, Math.floor((room / fullDropHint) * 100))
            );
        }
        if (sellPercent < 5) break;

        const amountIn = (balRaw * BigInt(sellPercent)) / 100n;
        if (!(amountIn > 0n)) continue;

        let ethOut = Number(p.ethOutSeq || p.ethOutAlone || p.ethOut || 0) * (sellPercent / 100);
        // Prefer live quoter for the exact partial size
        if (tokenAddress) {
            try {
                const q = await quoteSell(tokenAddress, amountIn, { fee });
                if (q.ethOut > 0) ethOut = q.ethOut;
            } catch (_) {}
        }

        const costFull = Number(p.costEth || 0);
        const costPart = costFull * (sellPercent / 100);
        const profitEth = ethOut - costPart;
        const getUsd = ethToUsd(ethOut, ethUsd) ?? 0;
        const profitUsd = ethToUsd(profitEth, ethUsd) ?? 0;
        const costUsd = ethToUsd(costPart, ethUsd) ?? 0;

        // MC drop from this probe: bonding ΔMC ≈ ethOut (API MC is ETH-denominated)
        let mcapDropPct = 0;
        let mcapAfterEth = mcapEth;
        if (mcapEth > 0 && ethOut > 0) {
            mcapAfterEth = Math.max(0.01, mcapEth - ethOut);
            mcapDropPct = ((mcapEth - mcapAfterEth) / mcapEth) * 100;
        } else if (fullDropHint > 0) {
            mcapDropPct = fullDropHint * (sellPercent / 100);
        }

        // If real quote still exceeds MC budget, shrink and re-quote once
        if (
            sellTiming !== "sell_now_fast" &&
            mcapDropPct > Math.min(maxPerWalletDrop, room) &&
            mcapDropPct > 0
        ) {
            const targetDrop = Math.min(maxPerWalletDrop, room);
            const prevPct = sellPercent;
            const shrink = Math.max(
                5,
                Math.min(100, Math.floor((targetDrop / mcapDropPct) * prevPct))
            );
            if (shrink < prevPct) {
                sellPercent = shrink;
                const amount2 = (balRaw * BigInt(sellPercent)) / 100n;
                if (tokenAddress && amount2 > 0n) {
                    try {
                        const q2 = await quoteSell(tokenAddress, amount2, { fee });
                        if (q2.ethOut > 0) ethOut = q2.ethOut;
                        else ethOut = ethOut * (shrink / prevPct);
                    } catch (_) {
                        ethOut = ethOut * (shrink / prevPct);
                    }
                } else {
                    ethOut = ethOut * (shrink / prevPct);
                }
                if (mcapEth > 0 && ethOut > 0) {
                    mcapAfterEth = Math.max(0.01, mcapEth - ethOut);
                    mcapDropPct = ((mcapEth - mcapAfterEth) / mcapEth) * 100;
                }
            }
        }

        const costPartFinal = costFull * (sellPercent / 100);
        const profitEthFinal = ethOut - costPartFinal;
        const getUsdFinal = ethToUsd(ethOut, ethUsd) ?? 0;
        const profitUsdFinal = ethToUsd(profitEthFinal, ethUsd) ?? 0;
        const costUsdFinal = ethToUsd(costPartFinal, ethUsd) ?? 0;

        if (mcapEth > 0 && ethOut > 0) {
            mcapEth = Math.max(0.01, mcapEth - ethOut);
        }
        cumDrop += mcapDropPct;
        totalUsd += getUsdFinal;
        totalProfit += profitUsdFinal;

        list.push({
            order: list.length + 1,
            label: p.label,
            address: p.address,
            sellPercent,
            getEth: ethOut,
            getUsd: getUsdFinal,
            getUsdLabel: formatUsd(getUsdFinal, 2),
            costUsd: costUsdFinal,
            costUsdLabel: formatUsd(costUsdFinal, 2),
            profitUsd: profitUsdFinal,
            profitUsdLabel: formatUsdSigned(profitUsdFinal, 2),
            profitPct:
                costPartFinal > 0
                    ? (profitEthFinal / costPartFinal) * 100
                    : null,
            mcapDropPct: Math.round(mcapDropPct * 100) / 100,
            mcapAfterUsd: ethToUsd(mcapEth, ethUsd),
            mcapAfterUsdLabel: formatUsd(ethToUsd(mcapEth, ethUsd), 0),
            fullBagWorthUsd: p.worthAloneUsd ?? p.worthUsd,
            quoted: Boolean(tokenAddress),
            why: `Sell ${sellPercent}% only · get ${formatUsd(getUsdFinal, 2)} · −${mcapDropPct.toFixed(2)}% MC (cum −${cumDrop.toFixed(2)}%)`,
        });

        if (cumDrop >= maxCumDrop && sellTiming !== "sell_now_fast") break;
    }

    let headline = `Sell these ${list.length} wallets first (least chart impact)`;
    if (sellTiming === "sell_now_fast") {
        headline = `URGENT — sell these ${list.length} now, then keep going`;
    } else if (sellTiming === "ride_trim") {
        headline = `Pump trim — partial sells only (≤${maxCumDrop}% MC)`;
    }

    return {
        headline,
        wallets: list,
        count: list.length,
        totalUsd,
        totalProfitUsd: totalProfit,
        totalUsdLabel: formatUsd(totalUsd, 0),
        totalProfitUsdLabel: formatUsdSigned(totalProfit, 0),
        cumulativeMcapDropPct: mcapStartForCum > 0 && mcapEth >= 0
            ? Math.round(((mcapStartForCum - mcapEth) / mcapStartForCum) * 10000) / 100
            : Math.round(cumDrop * 100) / 100,
        maxCumulativeMcapDropPct: maxCumDrop,
        mcapStartUsd: ethToUsd(mcapStartEth, ethUsd),
        mcapStartUsdLabel: formatUsd(ethToUsd(mcapStartEth, ethUsd), 0),
        ethUsd,
        instruction:
            list.length === 0
                ? "No safe probe — bags are too large vs MC. Wait for higher MC or sell a tiny % manually."
                : `Each button sells ONLY the listed %. Amounts are live Uniswap quotes. Total ≈ ${formatUsd(totalUsd, 0)} · profit ~${formatUsdSigned(totalProfit, 0)} · modeled MC ${formatUsd(ethToUsd(mcapStartEth, ethUsd), 0)} → hit ≈ −${cumDrop.toFixed(2)}% (cap ${maxCumDrop}%).`,
    };
}

/**
 * Build ranked sell plan: which wallets to sell first + market timing.
 * Re-quotes in plan order so MC / ETH-out after each sell is accurate.
 */
async function buildSellPlan(wallets, tokenAddress, options = {}) {
    const strategyOpt = String(options.strategy || "auto").toLowerCase();
    const targetMcapUsd = Number(options.targetMcapUsd || 1_000_000);
    const [positions, tape, tokenInfo, ethUsd] = await Promise.all([
        estimatePositions(wallets, tokenAddress, options),
        analyzeMarketTape(tokenAddress).catch(() => ({
            score: 50,
            regime: "unknown",
            urgency: "normal",
            action: "hold_probe",
            signals: ["tape unavailable — using defaults"],
        })),
        resolveTokenInfo(tokenAddress, options),
        getEthUsdPrice(),
    ]);
    const liveMc = await resolveLiveMarketCap(tokenAddress, tokenInfo, { ethUsd });
    // Holdings from position rows (already fetched)
    const heldTokens = (positions.rows || []).reduce(
        (a, r) => a + Number(r.tokens || 0),
        0
    );
    const heldPct =
        liveMc.supply > 0 ? (heldTokens / liveMc.supply) * 100 : 0;
    const holdings = {
        supply: liveMc.supply,
        supplyLabel:
            liveMc.supply >= 1e9
                ? `${(liveMc.supply / 1e9).toFixed(2)}B`
                : liveMc.supply >= 1e6
                  ? `${(liveMc.supply / 1e6).toFixed(2)}M`
                  : String(Math.round(liveMc.supply)),
        heldTokens,
        heldTokensLabel:
            heldTokens >= 1e6
                ? `${(heldTokens / 1e6).toFixed(2)}M`
                : heldTokens.toLocaleString(undefined, { maximumFractionDigits: 0 }),
        heldPctSupply: Math.round(heldPct * 1000) / 1000,
        heldPctLabel: `${heldPct.toFixed(2)}%`,
        walletsWithTokens: (positions.summary || {}).withTokens || 0,
        spotWorthUsd: ethToUsd(heldTokens * liveMc.priceEth, ethUsd),
        spotWorthUsdLabel: formatUsd(
            ethToUsd(heldTokens * liveMc.priceEth, ethUsd),
            0
        ),
        mcap: liveMc,
    };

    let strategy = strategyOpt;
    if (strategy === "auto") {
        // Default: least chart impact (smallest bags first) — maximize run longevity
        if (tape.urgency === "critical" || tape.regime === "dump") {
            strategy = "largest_first"; // exit size fast when dumping
        } else {
            strategy = "least_impact";
        }
    }
    if (strategy === "least_impact") strategy = "smallest_first";

    const INFRA_ROLES = new Set(["sniper", "txbot", "funder", "distributor"]);
    const rows = (positions.rows || [])
        .filter((r) => r.hasTokens)
        .filter((r) => !INFRA_ROLES.has(String(r.role || "buyer").toLowerCase()))
        .filter((r) => Number(r.costEth || 0) > 0)
        .map((r) => ({ ...r }));

    const strategyLabel = {
        largest_first: "Largest bags first (fast exit into a dump)",
        smallest_first: "Least impact first (small wallets — protect the chart)",
        least_impact: "Least impact first (small wallets — protect the chart)",
        best_pnl_first: "Best P&L first (lock winners while tape holds)",
        worst_pnl_first: "Worst P&L first (cut losers, keep winners)",
    };

    rows.sort((a, b) => {
        if (strategy === "largest_first") {
            return (b.ethOut || 0) - (a.ethOut || 0);
        }
        if (strategy === "smallest_first") {
            return (a.ethOut || 0) - (b.ethOut || 0);
        }
        if (strategy === "best_pnl_first") {
            return (b.profitPct || -Infinity) - (a.profitPct || -Infinity);
        }
        if (strategy === "worst_pnl_first") {
            return (a.profitPct || Infinity) - (b.profitPct || Infinity);
        }
        return (b.ethOut || 0) - (a.ethOut || 0);
    });

    // Accurate sequential impact IN PLAN ORDER — use LIVE quoter MC
    const sim = await simulateSequentialSells(rows, tokenAddress, {
        tokenInfo,
        ethUsd,
        mcapEth: liveMc.mcapEth,
    });
    // Ensure summary MC USD matches live (override any stale)
    sim.summary.mcapStartEth = liveMc.mcapEth;
    sim.summary.mcapStartUsd = liveMc.mcapUsd;
    sim.summary.mcapSource = liveMc.source;
    sim.summary.supply = liveMc.supply;
    sim.summary.priceEth = liveMc.priceEth;
    const mm = buildMarketMakeAdvice(tape, sim, { targetMcapUsd });

    const plan = sim.steps.map((s, i) => {
        const reasonParts = [];
        if (strategy === "largest_first") {
            reasonParts.push(
                `#${i + 1} by size (${Number(s.ethOutSeq || 0).toFixed(5)} ETH seq)`
            );
        } else if (strategy === "smallest_first") {
            reasonParts.push(
                `Least impact #${i + 1} (−${Number(s.mcapDropPct || 0).toFixed(1)}% MC)`
            );
        } else if (strategy === "best_pnl_first") {
            reasonParts.push(
                `Lock ${s.profitPct != null ? s.profitPct.toFixed(1) + "%" : "n/a"} winner`
            );
        } else {
            reasonParts.push(
                `Cut ${s.profitPct != null ? s.profitPct.toFixed(1) + "%" : "n/a"} bag`
            );
        }
        if (s.mcapDropPct > 0.5) {
            reasonParts.push(
                `MC ${formatUsd(s.mcapBeforeUsd)}→${formatUsd(s.mcapAfterUsd)} (−${s.mcapDropPct.toFixed(2)}%)`
            );
        }
        if (i === 0 && tape.urgency === "critical") {
            reasonParts.push("URGENT — hit this first");
        }
        if (
            i === sim.steps.length - 1 &&
            strategy === "smallest_first" &&
            tape.regime === "pump"
        ) {
            reasonParts.push("Hold longest — biggest bag rides momentum");
        }
        if (i < mm.inventory.safeTrimWallets) {
            reasonParts.push("SELL NOW — safe trim");
        }

        return {
            order: s.order,
            label: s.label || s.name,
            address: s.address,
            role: s.role,
            tokenBalance: s.tokenBalance,
            costEth: s.costEth,
            costUsd: ethToUsd(s.costEth || 0, ethUsd),
            ethOutAlone: s.ethOutAlone,
            ethOutIfDump: s.ethOutSeq,
            ethOutSeq: s.ethOutSeq,
            // Primary P&L = alone quote (what THIS wallet gets if sold by itself).
            // Dump/seq = worse fill if everything exits in plan order (batch partition).
            worthUsd: ethToUsd(s.ethOutAlone || 0, ethUsd),
            worthAloneUsd: ethToUsd(s.ethOutAlone || 0, ethUsd),
            worthDumpUsd: ethToUsd(s.ethOutSeq || 0, ethUsd),
            profitAlone: s.profitAlone,
            profitIfDump: s.profitSeq,
            profitUsd: ethToUsd(s.profitAlone || 0, ethUsd),
            profitAloneUsd: ethToUsd(s.profitAlone || 0, ethUsd),
            profitDumpUsd: ethToUsd(s.profitSeq || 0, ethUsd),
            tokensRaw: s.tokenBalanceRaw,
            tokenBalanceRaw: s.tokenBalanceRaw,
            profitPct: s.profitPct,
            profitPctIfDump: s.profitPctSeq,
            impactVsAlonePct: s.impactVsAlonePct,
            mcapBeforeEth: s.mcapBeforeEth,
            mcapAfterEth: s.mcapAfterEth,
            mcapBeforeUsd: s.mcapBeforeUsd,
            mcapAfterUsd: s.mcapAfterUsd,
            mcapBeforeUsdLabel: formatUsd(s.mcapBeforeUsd),
            mcapAfterUsdLabel: formatUsd(s.mcapAfterUsd),
            worthUsdLabel: formatUsd(ethToUsd(s.ethOutAlone || 0, ethUsd), 2),
            worthDumpUsdLabel: formatUsd(ethToUsd(s.ethOutSeq || 0, ethUsd), 2),
            profitUsdLabel: formatUsdSigned(ethToUsd(s.profitAlone || 0, ethUsd), 2),
            profitDumpUsdLabel: formatUsdSigned(ethToUsd(s.profitSeq || 0, ethUsd), 2),
            costUsdLabel: formatUsd(ethToUsd(s.costEth || 0, ethUsd), 2),
            mcapDropPct: s.mcapDropPct,
            shareOfExitPct: s.shareOfExitPct,
            cumulativeEthOut: s.cumulativeEthOut,
            cumulativeUsdOut: ethToUsd(s.cumulativeEthOut || 0, ethUsd),
            cumulativeProfit: s.cumulativeProfit,
            cumulativeProfitUsd: ethToUsd(s.cumulativeProfit || 0, ethUsd),
            reason: reasonParts.join(" · "),
            suggestedPercent: (() => {
                const drop = Number(s.mcapDropPct || 0);
                // Target ~1% MC hit per probe wallet; never default to 100% on a chart-protect plan
                const targetDrop =
                    tape.urgency === "critical"
                        ? 100
                        : mm.sellTiming === "ride_trim"
                          ? 0.8
                          : 1.0;
                if (tape.urgency === "critical") return 100;
                if (drop <= 0.01) return 25;
                const scaled = Math.max(
                    5,
                    Math.min(100, Math.floor((targetDrop / drop) * 100))
                );
                if (mm.sellTiming === "ride_trim") return Math.min(scaled, 25);
                if (tape.urgency === "high") return Math.min(Math.max(scaled, 25), 50);
                if (i < mm.inventory.safeTrimWallets) return Math.min(scaled, 30);
                return Math.min(scaled, 20);
            })(),
            inSafeTrim: i < mm.inventory.safeTrimWallets,
            sellNow: i < mm.inventory.safeTrimWallets,
        };
    });

    const profitLadder = buildProfitLadder(
        {
            ...positions.summary,
            totalEthOutIfDump: sim.summary.totalEthOutSequential,
            totalWorthDumpUsd: ethToUsd(
                sim.summary.totalEthOutSequential || 0,
                ethUsd
            ),
            totalWorthAloneUsd: ethToUsd(
                sim.summary.totalEthOutAlone || 0,
                ethUsd
            ),
            totalCostUsd: ethToUsd(sim.summary.totalCost || 0, ethUsd),
        },
        sim.summary,
        { targetsUsd: options.ladderTargetsUsd }
    );
    const sellTheseNow = await buildSellTheseNow(plan, mm.inventory, mm.sellTiming, {
        tokenAddress,
        ethUsd,
        mcapStartEth: sim.summary.mcapStartEth,
        fee: resolvePoolFee(tokenInfo),
    });
    // Keep inventory.safeTrimUsd aligned with actual probe $ (not full-bag cumulative)
    if (mm.inventory) {
        mm.inventory.safeTrimUsd = sellTheseNow.totalUsd;
        mm.inventory.safeTrimWallets = sellTheseNow.count;
        mm.inventory.safeTrimMcapDropPct = sellTheseNow.cumulativeMcapDropPct;
        mm.inventory.note = `Safe trim: ${sellTheseNow.count} wallet(s) ≈ ${sellTheseNow.totalUsdLabel} at listed % — modeled MC drop ≤${sellTheseNow.maxCumulativeMcapDropPct}%.`;
    }
    // sellGuide was built from full-bag soft-trim — overwrite with real probe quotes
    if (mm.sellGuide) {
        mm.sellGuide.howMuchNowUsd = sellTheseNow.totalUsd;
        mm.sellGuide.howMuchNowWallets = sellTheseNow.count;
        mm.sellGuide.howMuchNowPct = sellTheseNow.cumulativeMcapDropPct;
        if (mm.sellTiming === "ride_trim") {
            mm.sellGuide.tip = `On this pump: sell ~${sellTheseNow.totalUsdLabel} first (${sellTheseNow.count} wallets at listed %), watch if MC holds, then sell more.`;
        } else if (mm.sellTiming !== "sell_now_fast") {
            mm.sellGuide.tip = `Safe probes now ≈ ${sellTheseNow.totalUsdLabel} across ${sellTheseNow.count} wallet(s) (listed % only — not full bags). Realistic full exit today ≈ ${formatUsd(mm.inventory.worthDumpUsd, 0)}.`;
        }
    }
    // Fix checklist item that may have been built earlier with stale full-bag $
    const maximize = {
        title: "Maximize profit checklist",
        items: [
            {
                id: "least_impact",
                text: "Sell smallest wallets first — least MC damage, keep big bags for higher MC.",
            },
            {
                id: "safe_trim",
                text: `Now: sell ${sellTheseNow.count} wallets ≈ ${sellTheseNow.totalUsdLabel} at the listed % only (not full bags).`,
            },
            {
                id: "ladder",
                text: "As MC rises, follow the profit ladder — bank more % at each rung, never dump 100% early.",
            },
            {
                id: "dont_full_dump",
                text: `Full dump today ≈ ${formatUsd(mm.inventory.worthDumpUsd, 0)} vs alone ${formatUsd(mm.inventory.worthAloneUsd, 0)} — avoid unless tape is dying.`,
            },
            {
                id: "pump_rule",
                text: "On pumps: trim 10–30% into strength; hold runners until volume fades.",
            },
            {
                id: "dump_rule",
                text: "On dumps / volume death: flip to largest-first / Sell all — speed > perfect price.",
            },
        ],
    };

    return {
        strategy,
        strategyLabel: strategyLabel[strategy] || strategy,
        strategyRequested: strategyOpt,
        tape,
        positions: {
            ...positions.summary,
            totalEthOutIfDump: sim.summary.totalEthOutSequential,
            dumpImpactEth: sim.summary.dumpImpactEth,
            dumpImpactPct: sim.summary.dumpImpactPct,
            totalProfitIfDump: sim.summary.totalProfitSequential,
        },
        simulation: sim.summary,
        marketMake: mm,
        holdings,
        liveMarketCap: liveMc,
        plan,
        sellTheseNow,
        profitLadder,
        maximize,
        tips: mm.tips,
        noxaUrl: `https://fun.noxa.fi/robinhood/${String(tokenAddress).toLowerCase()}`,
        executeHint: {
            mode:
                tape.urgency === "critical" || mm.sellTiming === "sell_now_fast"
                    ? "parallel"
                    : "sequential",
            delayMs:
                tape.urgency === "critical"
                    ? 0
                    : tape.regime === "pump"
                      ? 400
                      : 150,
            percentDefault: 100,
            order: plan.map((p) => p.address),
            safeTrimCount: mm.inventory.safeTrimWallets,
            sellTheseAddresses: sellTheseNow.wallets.map((w) => w.address),
        },
    };
}

/**
 * Sell token balances from multiple wallets.
 * mode: "sequential" (default) or "parallel" (near-simultaneous, not one chain tx).
 * percent: 1-100 of each wallet's balance (default 100).
 * walletOrder: optional address[] to sell in a specific order (sell plan).
 */
async function multiSell(wallets, tokenAddress, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const mode = options.mode === "parallel" ? "parallel" : "sequential";
    const percent = Math.min(100, Math.max(1, Number(options.percent ?? 100)));
    const delayMs = Number(options.delayMs ?? 0);
    // Fast by default: unlock as soon as the swap is broadcast (don't sit on receipt)
    const waitForReceipt = options.waitForReceipt === true;
    const fast = options.fast !== false;
    const results = [];

    let ordered = [...wallets];
    if (Array.isArray(options.walletOrder) && options.walletOrder.length) {
        const byAddr = new Map(
            wallets.map((w) => [
                String(w.address || new ethers.Wallet(w.private_key).address).toLowerCase(),
                w,
            ])
        );
        const seen = new Set();
        ordered = [];
        for (const a of options.walletOrder) {
            const key = String(a || "").toLowerCase();
            if (byAddr.has(key) && !seen.has(key)) {
                ordered.push(byAddr.get(key));
                seen.add(key);
            }
        }
        for (const w of wallets) {
            const key = String(
                w.address || new ethers.Wallet(w.private_key).address
            ).toLowerCase();
            if (!seen.has(key)) ordered.push(w);
        }
    }

    const tokenInfo = await resolveTokenInfo(tokenAddress, {
        tokenInfo: options.tokenInfo,
        fee: options.fee,
        pairedToken: options.pairedToken,
    });
    let decimals = Number(tokenInfo?.token?.decimals ?? 18);
    if (tokenInfo?.source === "synthetic") {
        try {
            const c = new ethers.Contract(
                tokenAddress,
                ["function decimals() view returns (uint8)"],
                provider
            );
            decimals = Number(await c.decimals());
        } catch (_) {}
    }
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const pairedToken =
        options.pairedToken ?? resolvePairedToken(tokenInfo);

    // One fee snapshot for the whole batch — huge RPC savings vs per-wallet getFeeData
    let sharedFeeData = options.feeData || null;
    try {
        if (!sharedFeeData) sharedFeeData = await provider.getFeeData();
    } catch (_) {}

    const sellOptsBase = {
        ...(options.sellOptions || {}),
        fee,
        pairedToken,
        tokenInfo,
        feeData:
            sharedFeeData ||
            options.feeData ||
            options.sellOptions?.feeData ||
            undefined,
        priorityMultiplier:
            options.priorityMultiplier ??
            options.sellOptions?.priorityMultiplier ??
            (fast ? 1.75 : 1.5),
        skipQuote: !!options.skipQuote || !!options.sellOptions?.skipQuote,
    };

    async function sellOne(w, index) {
        const addr = w.address || new ethers.Wallet(w.private_key).address;
        const { balance } = await getTokenBalanceRaw(addr, tokenAddress);
        if (balance <= 0n) {
            onProgress({ type: "skip", wallet: addr, reason: "no tokens" });
            return { wallet: addr, skipped: true, reason: "no tokens" };
        }

        const amountIn = (balance * BigInt(Math.floor(percent))) / 100n;
        if (amountIn <= 0n) {
            return { wallet: addr, skipped: true, reason: "amount too small" };
        }

        const amountHuman = ethers.formatUnits(amountIn, decimals);
        let quotedEth = null;
        let quotedRaw = null;
        if (!sellOptsBase.skipQuote) {
            try {
                const q = await quoteExactInput(
                    tokenAddress,
                    pairedToken,
                    amountIn,
                    fee
                );
                quotedRaw = q;
                quotedEth = Number(ethers.formatEther(q));
            } catch (_) {}
        }

        onProgress({
            type: "selling",
            wallet: addr,
            name: w.name,
            amount: amountHuman,
            quotedEth,
            index,
        });

        try {
            const tx = await sell(
                { private_key: w.private_key },
                amountHuman,
                tokenAddress,
                {
                    ...sellOptsBase,
                    // Reuse the quote we already fetched — no second quoter round-trip
                    quoted: quotedRaw != null ? quotedRaw : sellOptsBase.quoted,
                }
            );
            if (tx?.error) {
                onProgress({ type: "error", wallet: addr, error: tx.error });
                return { wallet: addr, error: tx.error, quotedEth };
            }
            // Mark sold as soon as the tx is in the mempool — don't block the next click
            onProgress({
                type: "sold",
                wallet: addr,
                hash: tx.hash,
                amount: amountHuman,
                quotedEth,
                pending: !waitForReceipt,
            });
            if (waitForReceipt) {
                try {
                    await waitTx(tx);
                } catch (_) {}
                onProgress({
                    type: "confirmed",
                    wallet: addr,
                    hash: tx.hash,
                });
            } else {
                // Confirm in background — never blocks the next sell
                waitTx(tx)
                    .then(() =>
                        onProgress({
                            type: "confirmed",
                            wallet: addr,
                            hash: tx.hash,
                        })
                    )
                    .catch(() => {});
            }
            return {
                wallet: addr,
                hash: tx.hash,
                amount: amountHuman,
                quotedEth,
            };
        } catch (e) {
            const err = e.shortMessage || e.message;
            onProgress({ type: "error", wallet: addr, error: err });
            return { wallet: addr, error: err, quotedEth };
        }
    }

    if (mode === "parallel") {
        onProgress({ type: "mode", mode: "parallel", count: ordered.length });
        // Cap concurrency so RPC doesn't 429, but still fire several at once
        const conc = Math.min(
            Number(options.concurrency) || (fast ? 8 : 4),
            ordered.length || 1
        );
        const settled = await mapPool(ordered, conc, (w, i) => sellOne(w, i));
        results.push(...settled);
    } else {
        onProgress({ type: "mode", mode: "sequential", count: ordered.length });
        for (let i = 0; i < ordered.length; i++) {
            results.push(await sellOne(ordered[i], i));
            if (i < ordered.length - 1 && delayMs > 0) {
                onProgress({ type: "waiting", delayMs });
                await sleep(delayMs);
            }
        }
    }

    return results;
}

function isEvmAddress(txt) {
    if (typeof txt !== "string" || !txt.startsWith("0x") || txt.length !== 42) {
        return false;
    }

    const hexPattern = /^0x[0-9a-fA-F]{40}$/;
    if (!hexPattern.test(txt)) {
        return false;
    }

    return true;
}

function isEvmPrivateKey(txt) {
    if (txt.startsWith("0x")) {
        txt = txt.slice(2);
    }

    if (typeof txt !== "string" || txt.length !== 64) {
        return false;
    }

    const hexPattern = /^[0-9a-fA-F]{64}$/;
    if (!hexPattern.test(txt)) {
        return false;
    }

    return true;
}

function shortenAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function generateWallet(pkey) {
    if (pkey) {
        const wallet = new ethers.Wallet(pkey);
        return wallet;
    } else {
        const newPrivateKey = ethers.Wallet.createRandom().privateKey;
        const wallet = new ethers.Wallet(newPrivateKey);
        return wallet;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function parseEthAmount(amount) {
    if (typeof amount === "bigint") return amount;
    if (typeof amount === "number") {
        if (!Number.isFinite(amount) || amount < 0) {
            throw new Error("invalid ETH amount");
        }
        if (amount === 0) return 0n;
        // Avoid "too many decimals for format" from float dust
        return ethers.parseEther(amount.toFixed(8).replace(/\.?0+$/, "") || "0");
    }
    const s = String(amount || "0").trim();
    if (!s || s === "0") return 0n;
    // Cap decimal places if a long float-string sneaks in
    if (s.includes(".")) {
        const [whole, frac = ""] = s.split(".");
        return ethers.parseEther(`${whole}.${frac.slice(0, 18)}`);
    }
    return ethers.parseEther(s);
}

/** Pull a useful message out of ethers UNKNOWN_ERROR / coalesce wrappers. */
function formatTxError(e) {
    if (!e) return "unknown error";
    const parts = [];
    const push = (s) => {
        const t = String(s || "").trim();
        if (t && !parts.includes(t)) parts.push(t);
    };
    push(e.shortMessage);
    push(e.reason);
    push(e.info?.error?.message);
    push(e.error?.message);
    push(e.error?.data?.message);
    push(typeof e.error === "string" ? e.error : null);
    if (e.code) push(`code=${e.code}`);
    const msg = parts.filter(Boolean).join(" · ") || e.message || String(e);
    // Common case: RPC rejects for balance but ethers only says "could not coalesce"
    if (/coalesce/i.test(msg) && /insufficient|funds|balance|overshot/i.test(msg)) {
        return msg;
    }
    if (/coalesce/i.test(msg)) {
        const nested =
            e.info?.error?.message ||
            e.error?.message ||
            e.error?.data ||
            e.data?.message ||
            null;
        if (nested) return `RPC rejected tx: ${nested}`;
        return `RPC rejected tx (ethers: could not coalesce) — often insufficient funds or nonce/fee issue`;
    }
    return msg;
}

async function transferEth(walletData, to, amount, nonce) {
    const wallet = new ethers.Wallet(walletData.private_key, provider);
    const value =
        typeof amount === "bigint" ? amount : parseEthAmount(amount);
    if (!to || !ethers.isAddress(to)) {
        throw new Error(`Invalid transfer destination: ${to}`);
    }
    const toChecksum = ethers.getAddress(to);
    const bal = await provider.getBalance(wallet.address);
    const feeData = await provider.getFeeData();
    // Robinhood / some RPCs reject gasLimit 21000 as "intrinsic gas too low"
    // even for plain transfers — estimate and floor high enough.
    const MIN_TRANSFER_GAS = 100000n;
    let gasLimit = MIN_TRANSFER_GAS;
    try {
        const estimated = await wallet.estimateGas({
            to: toChecksum,
            value,
        });
        // +50% headroom, never below floor
        const bumped = (estimated * 150n) / 100n;
        gasLimit = bumped > MIN_TRANSFER_GAS ? bumped : MIN_TRANSFER_GAS;
    } catch (_) {
        gasLimit = 150000n;
    }

    let maxFee =
        feeData.maxFeePerGas ||
        feeData.gasPrice ||
        ethers.parseUnits("5", "gwei");
    let tip =
        feeData.maxPriorityFeePerGas ??
        ethers.parseUnits("2", "gwei");
    if (tip <= 0n) tip = ethers.parseUnits("2", "gwei");
    if (maxFee < tip) maxFee = tip * 2n;
    // Floor fees — "intrinsic gas too low" can also mean fee/gas product too small
    const minFee = ethers.parseUnits("2", "gwei");
    if (maxFee < minFee) maxFee = minFee;
    if (tip < minFee) tip = minFee;

    const gasCost = gasLimit * maxFee;
    if (bal < value + gasCost) {
        throw new Error(
            `insufficient funds: have ${ethers.formatEther(bal)} ETH, need ~${ethers.formatEther(value + gasCost)} (value ${ethers.formatEther(value)} + gas)`
        );
    }
    const tx = {
        to: toChecksum,
        value,
        chainId: CHAIN_ID,
        gasLimit,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
        type: 2,
    };
    if (nonce !== undefined && nonce !== null) {
        tx.nonce = nonce;
    }
    let sentTx;
    try {
        sentTx = await wallet.sendTransaction(tx);
    } catch (e) {
        throw new Error(formatTxError(e));
    }
    // Ensure the node actually knows about this hash
    const seen = await provider.getTransaction(sentTx.hash);
    if (!seen) {
        console.warn("RPC did not return tx immediately:", sentTx.hash);
    }
    return sentTx;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function randomInt(min, max) {
    return Math.floor(randomBetween(min, max + 1));
}

/**
 * Build a shuffled list of organic-looking on-chain activities.
 * intensity: "light" | "medium" | "heavy"
 */
function buildSeasoningPlan(intensity = "medium") {
    const profile =
        intensity === "light"
            ? { wraps: [1, 2], unwraps: [1, 2], transfers: [1, 2], approves: [1, 1] }
            : intensity === "heavy"
              ? { wraps: [2, 4], unwraps: [2, 3], transfers: [3, 5], approves: [1, 2] }
              : { wraps: [2, 3], unwraps: [1, 2], transfers: [2, 4], approves: [1, 2] };

    const activities = [];
    for (let i = 0; i < randomInt(...profile.wraps); i++) {
        activities.push({
            type: "wrap",
            eth: Number(randomBetween(0.0002, 0.0012).toFixed(6)),
        });
    }
    for (let i = 0; i < randomInt(...profile.unwraps); i++) {
        activities.push({ type: "unwrap", fraction: randomBetween(0.4, 1) });
    }
    for (let i = 0; i < randomInt(...profile.transfers); i++) {
        activities.push({
            type: "transfer",
            eth: Number(randomBetween(0.00005, 0.00035).toFixed(6)),
        });
    }
    for (let i = 0; i < randomInt(...profile.approves); i++) {
        activities.push({
            type: "approve",
            amount: Math.random() > 0.5 ? "max" : "small",
        });
    }
    return shuffle(activities);
}

/**
 * Season a wallet so it has real tx history (wrap/unwrap/transfer/approve)
 * instead of looking brand-new. Requires the wallet to already hold ETH.
 */
async function seasonWallet(walletData, options = {}) {
    const {
        intensity = "medium",
        returnAddress = null,
        delayMsMin = 800,
        delayMsMax = 3500,
        onProgress = () => {},
    } = options;

    const wallet = new ethers.Wallet(walletData.private_key, provider);
    const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
    const plan = buildSeasoningPlan(intensity);
    const txs = [];
    const dustSink =
        returnAddress ||
        ethers.Wallet.createRandom().address;

    onProgress({
        type: "plan",
        address: wallet.address,
        activities: plan.length,
        plan: plan.map((a) => a.type),
    });

    for (const activity of plan) {
        try {
            const bal = await provider.getBalance(wallet.address);
            const gasReserve = ethers.parseEther("0.0004");

            if (activity.type === "wrap") {
                const want = parseEthAmount(activity.eth);
                const spendable = bal > gasReserve ? bal - gasReserve : 0n;
                const amount = want < spendable ? want : spendable;
                if (amount <= 0n) {
                    onProgress({ type: "skip", activity: "wrap", reason: "low balance" });
                    continue;
                }
                onProgress({
                    type: "activity",
                    activity: "wrap",
                    amount: ethers.formatEther(amount),
                });
                const tx = await weth.deposit({ value: amount });
                await tx.wait();
                txs.push({ type: "wrap", hash: tx.hash });
                onProgress({ type: "done", activity: "wrap", hash: tx.hash });
            } else if (activity.type === "unwrap") {
                const wBal = await weth.balanceOf(wallet.address);
                if (wBal <= 0n) {
                    onProgress({ type: "skip", activity: "unwrap", reason: "no weth" });
                    continue;
                }
                const amount =
                    (wBal * BigInt(Math.floor(activity.fraction * 1000))) / 1000n;
                if (amount <= 0n) continue;
                onProgress({
                    type: "activity",
                    activity: "unwrap",
                    amount: ethers.formatEther(amount),
                });
                const tx = await weth.withdraw(amount);
                await tx.wait();
                txs.push({ type: "unwrap", hash: tx.hash });
                onProgress({ type: "done", activity: "unwrap", hash: tx.hash });
            } else if (activity.type === "transfer") {
                const want = parseEthAmount(activity.eth);
                const spendable = bal > gasReserve ? bal - gasReserve : 0n;
                const amount = want < spendable ? want : spendable / 20n;
                if (amount <= 0n) {
                    onProgress({ type: "skip", activity: "transfer", reason: "low balance" });
                    continue;
                }
                onProgress({
                    type: "activity",
                    activity: "transfer",
                    to: dustSink,
                    amount: ethers.formatEther(amount),
                });
                const tx = await transferEth(
                    { private_key: walletData.private_key },
                    dustSink,
                    amount
                );
                await tx.wait();
                txs.push({ type: "transfer", hash: tx.hash, to: dustSink });
                onProgress({ type: "done", activity: "transfer", hash: tx.hash });
            } else if (activity.type === "approve") {
                const amount =
                    activity.amount === "max"
                        ? ethers.MaxUint256
                        : ethers.parseEther("0.05");
                onProgress({ type: "activity", activity: "approve", spender: ROUTER });
                const tx = await weth.approve(ROUTER, amount);
                await tx.wait();
                txs.push({ type: "approve", hash: tx.hash });
                onProgress({ type: "done", activity: "approve", hash: tx.hash });
            }

            await sleep(randomBetween(delayMsMin, delayMsMax));
        } catch (e) {
            onProgress({
                type: "error",
                activity: activity.type,
                error: e.shortMessage || e.message,
            });
        }
    }

    // Leave a little WETH or unwrap leftovers so the wallet isn't empty of activity tokens
    try {
        const wBal = await weth.balanceOf(wallet.address);
        if (wBal > 0n && Math.random() > 0.35) {
            const tx = await weth.withdraw(wBal);
            await tx.wait();
            txs.push({ type: "unwrap", hash: tx.hash });
            onProgress({ type: "done", activity: "final-unwrap", hash: tx.hash });
        }
    } catch (_) {}

    onProgress({
        type: "seasoned",
        address: wallet.address,
        txCount: txs.length,
    });

    return {
        address: wallet.address,
        txCount: txs.length,
        txs,
        plan: plan.map((a) => a.type),
    };
}

/**
 * Fund + season multiple buyer wallets from a funder.
 * Sends a small seasoning budget, runs organic txs, optionally recalls leftover ETH.
 */
async function seasonWallets(funderWallet, buyerWallets, options = {}) {
    const {
        budgetEth = 0.008,
        intensity = "medium",
        recallLeftover = true,
        minKeepEth = 0.0003,
        delayBetweenWalletsMs = [2000, 6000],
        onProgress = () => {},
    } = options;

    const results = [];
    const returnAddress = funderWallet.address || null;

    for (let i = 0; i < buyerWallets.length; i++) {
        const buyer = buyerWallets[i];
        onProgress({
            type: "wallet_start",
            index: i,
            total: buyerWallets.length,
            address: buyer.address,
            name: buyer.name,
        });

        try {
            const bal = await provider.getBalance(buyer.address);
            const budget = parseEthAmount(budgetEth);
            const need = budget > bal ? budget - bal : 0n;

            if (need > 0n) {
                onProgress({
                    type: "funding",
                    address: buyer.address,
                    amount: ethers.formatEther(need),
                });
                const fundTx = await transferEth(
                    { private_key: funderWallet.private_key },
                    buyer.address,
                    need
                );
                await fundTx.wait();
                onProgress({
                    type: "funded",
                    address: buyer.address,
                    hash: fundTx.hash,
                });
                await sleep(randomBetween(600, 1800));
            }

            const result = await seasonWallet(
                { private_key: buyer.private_key },
                {
                    intensity,
                    returnAddress,
                    onProgress: (ev) =>
                        onProgress({ ...ev, wallet: buyer.address, name: buyer.name }),
                }
            );

            if (recallLeftover && returnAddress) {
                const after = await provider.getBalance(buyer.address);
                const keep = parseEthAmount(minKeepEth);
                const gasPad = ethers.parseEther("0.00025");
                if (after > keep + gasPad) {
                    const sendBack = after - keep - gasPad;
                    onProgress({
                        type: "recalling",
                        address: buyer.address,
                        amount: ethers.formatEther(sendBack),
                    });
                    const backTx = await transferEth(
                        { private_key: buyer.private_key },
                        returnAddress,
                        sendBack
                    );
                    await backTx.wait();
                    result.txs.push({ type: "recall", hash: backTx.hash });
                    result.txCount += 1;
                    onProgress({
                        type: "recalled",
                        address: buyer.address,
                        hash: backTx.hash,
                    });
                }
            }

            results.push({ ...result, ok: true, name: buyer.name });
            onProgress({
                type: "wallet_done",
                address: buyer.address,
                txCount: result.txCount,
            });
        } catch (e) {
            const err = e.shortMessage || e.message;
            results.push({
                address: buyer.address,
                name: buyer.name,
                ok: false,
                error: err,
                txCount: 0,
            });
            onProgress({
                type: "wallet_error",
                address: buyer.address,
                error: err,
            });
        }

        if (i < buyerWallets.length - 1) {
            await sleep(
                randomBetween(delayBetweenWalletsMs[0], delayBetweenWalletsMs[1])
            );
        }
    }

    return results;
}

/**
 * Fund destination wallets via throwaway hop wallets so buyers are not
 * all directly linked to the main funder on bubble maps.
 *
 * Flow per destination (default hops=2):
 *   main -> hop1 -> hop2 -> destination
 *
 * options:
 *   hops (default 2)
 *   delayMsMin / delayMsMax between hops (default 8s-25s)
 *   gasReserveEth left on each hop for fees (default 0.00015)
 *   waitForConfirm (default true)
 *   onProgress(event) callback
 *   shuffle (default true) randomize funding order
 */
async function disperseWithHops(funderWalletData, destinations, options = {}) {
    const hops = Math.max(1, Number(options.hops ?? 2));
    const delayMsMin = Number(options.delayMsMin ?? 8000);
    const delayMsMax = Number(options.delayMsMax ?? 25000);
    const gasReserveEth = Number(options.gasReserveEth ?? HOP_GAS_RESERVE_ETH);
    const buyerGasBufferEth = Number(
        options.buyerGasBufferEth ?? BUYER_GAS_BUFFER_ETH
    );
    const waitForConfirm = options.waitForConfirm !== false;
    const onProgress = options.onProgress || (() => {});
    const onHopCreated = options.onHopCreated || (() => {});
    const shuffle = options.shuffle !== false;

    const gasReserve = parseEthAmount(gasReserveEth);
    const buyerGasBuffer = parseEthAmount(buyerGasBufferEth);
    let targets = destinations.map((d) => ({
        address: d.address,
        amountEth: d.amountEth,
        name: d.name || d.address,
    }));

    if (shuffle) {
        targets = targets
            .map((t) => ({ t, r: Math.random() }))
            .sort((a, b) => a.r - b.r)
            .map((x) => x.t);
    }

    const results = [];

    for (const dest of targets) {
        if (!dest.address || !ethers.isAddress(dest.address)) {
            throw new Error(`Invalid funding destination: ${dest.address}`);
        }
        const destChecksum = ethers.getAddress(dest.address);
        const amountWei = parseEthAmount(dest.amountEth);
        // Funder sends: buy amount + buyer gas buffer + hop gas reserves
        const totalFromFunder =
            amountWei + buyerGasBuffer + gasReserve * BigInt(hops);

        const hopWallets = [];
        for (let i = 0; i < hops; i++) {
            hopWallets.push(generateWallet());
        }

        // Persist hop keys BEFORE any ETH moves — recovery if mid-chain fails
        const hopRecords = hopWallets.map((h, i) => ({
            address: h.address,
            privateKey: h.privateKey,
            step: i,
            dest: destChecksum,
            destName: dest.name,
            createdAt: new Date().toISOString(),
            status: "pending",
        }));
        try {
            onHopCreated({
                dest: destChecksum,
                name: dest.name,
                amountEth: dest.amountEth,
                hops: hopRecords,
            });
        } catch (e) {
            throw new Error(
                `Refusing to fund — could not persist hop keys: ${e.message}`
            );
        }

        onProgress({
            type: "start",
            dest: destChecksum,
            name: dest.name,
            amountEth: dest.amountEth,
            fundedEth: ethers.formatEther(totalFromFunder),
            buyerGasBufferEth,
            hops: hopWallets.map((h) => h.address),
        });

        try {
            // Step 1: funder -> hop0
            let fromKey = funderWalletData.private_key;
            let toAddress = hopWallets[0].address;
            let sendAmount = totalFromFunder;

            let tx = await transferEth(
                { private_key: fromKey },
                toAddress,
                sendAmount
            );
            if (waitForConfirm) await waitTx(tx);
            hopRecords[0].status = "funded";
            hopRecords[0].fundedTx = tx.hash;
            onProgress({
                type: "hop",
                step: 0,
                from: "funder",
                to: toAddress,
                hash: tx.hash,
                dest: destChecksum,
            });

            await sleep(randomBetween(delayMsMin, delayMsMax));

            // Intermediate hops: hop[i] -> hop[i+1]
            for (let i = 0; i < hops - 1; i++) {
                fromKey = hopWallets[i].privateKey;
                toAddress = hopWallets[i + 1].address;
                // leave gasReserve on current hop
                const bal = await provider.getBalance(hopWallets[i].address);
                sendAmount = bal > gasReserve ? bal - gasReserve : 0n;
                if (sendAmount <= 0n) {
                    throw new Error(
                        `Hop ${i} has insufficient balance after gas reserve`
                    );
                }
                tx = await transferEth({ private_key: fromKey }, toAddress, sendAmount);
                if (waitForConfirm) await waitTx(tx);
                hopRecords[i].status = "forwarded";
                hopRecords[i + 1].status = "funded";
                hopRecords[i + 1].fundedTx = tx.hash;
                onProgress({
                    type: "hop",
                    step: i + 1,
                    from: hopWallets[i].address,
                    to: toAddress,
                    hash: tx.hash,
                    dest: destChecksum,
                });
                await sleep(randomBetween(delayMsMin, delayMsMax));
            }

            // Final hop -> destination (checksummed buyer only)
            const last = hopWallets[hops - 1];
            fromKey = last.privateKey;
            const lastBal = await provider.getBalance(last.address);
            sendAmount = lastBal > gasReserve ? lastBal - gasReserve : 0n;
            if (sendAmount <= 0n) {
                throw new Error("Final hop has insufficient balance after gas reserve");
            }
            tx = await transferEth({ private_key: fromKey }, destChecksum, sendAmount);
            if (waitForConfirm) await waitTx(tx);
            hopRecords[hops - 1].status = "delivered";
            onProgress({
                type: "done",
                dest: destChecksum,
                name: dest.name,
                hash: tx.hash,
                receivedWei: sendAmount.toString(),
            });

            results.push({
                dest: destChecksum,
                name: dest.name,
                hops: hopRecords,
                finalTx: tx.hash,
                receivedWei: sendAmount.toString(),
                ok: true,
            });
        } catch (e) {
            const errMsg = formatTxError(e);
            onProgress({
                type: "error",
                dest: destChecksum,
                name: dest.name,
                error: errMsg,
                hops: hopRecords,
            });
            results.push({
                dest: destChecksum,
                name: dest.name,
                hops: hopRecords,
                error: errMsg,
                ok: false,
            });
            // Continue other destinations — stuck hops remain recoverable via persisted keys
            continue;
        }

        // Delay before next destination
        if (targets.indexOf(dest) < targets.length - 1) {
            await sleep(randomBetween(delayMsMin, delayMsMax));
        }
    }

    return results;
}

/**
 * Multi-wallet buy.
 *   - "burst" (default): fire buys in tight waves (no delays)
 *   - "sequential": honor per-wallet delaySec
 *   - "organic": slow staggered buys; on foreign buy → soft-sell (10–20% MC dip
 *     max), wait until tape is quiet, then resume buying up
 *
 * Interference guard (burst): between waves, poll recent swaps. If a non-ours
 * wallet buys in, policies:
 *   - log: warn and continue
 *   - bump: raise priority tip and continue
 *   - pause: stop remaining waves
 *   - react: emergency-sell wallets that already bought, then continue remaining
 */
async function multiBuy(wallets, tokenAddress, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const shouldAbort = options.shouldAbort || (() => false);
    const mode =
        options.mode === "sequential"
            ? "sequential"
            : options.mode === "organic"
              ? "organic"
              : options.mode === "parallel"
                ? "burst"
                : options.mode || "burst";
    const concurrency = Math.min(
        16,
        Math.max(6, Number(options.concurrency || 12))
    );
    const results = [];
    let priorityMultiplier =
        options.priorityMultiplier ??
        (mode === "burst" ? 1.35 : mode === "organic" ? 1.05 : 1);

    const tapeGuard =
        options.tapeGuard !== false &&
        (mode === "burst" || mode === "organic");
    const foreignPolicy = String(
        options.foreignBuyPolicy || (mode === "organic" ? "organic" : "react")
    ).toLowerCase();
    const foreignMinEth = Number(options.foreignMinEth ?? 0.008);
    // Organic chart-safe soft sell: clamp dip to 10–20% of live MC
    const organicMaxDipPct = Math.min(
        0.2,
        Math.max(0.1, Number(options.organicMaxDipPct ?? 0.15))
    );
    const organicSellPct = Math.min(
        50,
        Math.max(8, Number(options.organicSellPct ?? 25))
    );
    const organicQuietSec = Math.max(
        4,
        Number(options.organicQuietSec ?? 12)
    );
    const organicPaceSec = Math.max(2, Number(options.organicPaceSec ?? 10));
    const organicPaceJitterSec = Math.max(
        0,
        Number(options.organicPaceJitterSec ?? 6)
    );
    const organicPollMs = Math.max(
        1500,
        Number(options.organicPollMs ?? 2500)
    );

    const tokenInfo = await getTokenInfo(tokenAddress);
    const fee = options.fee ?? resolvePoolFee(tokenInfo);
    const pairedToken = resolvePairedToken(tokenInfo);
    const feeData = await provider.getFeeData();
    const gasLimit = options.buyOptions?.gasLimit ?? 500000n;
    const gasCost = await estimateBuyGasCost(gasLimit);
    const burstSlippage =
        options.slippageBps ??
        (mode === "burst"
            ? Math.max(DEFAULT_SLIPPAGE_BPS, 500)
            : DEFAULT_SLIPPAGE_BPS);

    const eligible = [];
    for (const w of wallets) {
        const amount = w.buyAmountEth ?? w.amountEth ?? options.defaultAmountEth;
        if (amount == null || Number(amount) <= 0) {
            results.push({
                wallet: w.address || w.name,
                skipped: true,
                reason: "no buy amount",
            });
            continue;
        }
        eligible.push({ ...w, _amount: amount });
    }

    const ownSet = new Set(
        eligible.map((w) =>
            String(
                w.address || new ethers.Wallet(w.private_key).address
            ).toLowerCase()
        )
    );

    let guardSinceTs = Math.floor(Date.now() / 1000) - 3;
    try {
        const baseline = await fetchRecentSwaps(tokenAddress, { limit: 40 });
        const maxTs = baseline.reduce((m, s) => Math.max(m, s.timestamp || 0), 0);
        if (maxTs > 0) guardSinceTs = maxTs;
    } catch (_) {}

    onProgress({
        type: "mode",
        mode,
        count: eligible.length,
        concurrency: mode === "burst" ? concurrency : 1,
        slippageBps: burstSlippage,
        priorityMultiplier,
        tapeGuard,
        foreignBuyPolicy: foreignPolicy,
        organicMaxDipPct:
            mode === "organic" ? organicMaxDipPct : undefined,
        organicPaceSec: mode === "organic" ? organicPaceSec : undefined,
        organicQuietSec: mode === "organic" ? organicQuietSec : undefined,
    });

    async function buyOne(w, index) {
        const addr = w.address || new ethers.Wallet(w.private_key).address;
        const maxAttempts = Math.max(
            1,
            Number(options.retries ?? (mode === "burst" ? 3 : 2))
        );
        let amount = Number(w._amount);
        let tipMult = priorityMultiplier;
        let slipBps = burstSlippage;
        let lastErr = null;
        let clampedFrom = null;

        onProgress({
            type: "buying",
            wallet: addr,
            name: w.name,
            amountEth: amount,
            index,
        });

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (shouldAbort()) {
                return {
                    wallet: addr,
                    name: w.name,
                    skipped: true,
                    reason: "aborted",
                };
            }
            try {
                // Fresh balance each attempt; reuse shared gasCost unless last fail was gas-related
                const bal = await Promise.race([
                    provider.getBalance(addr),
                    new Promise((_, rej) =>
                        setTimeout(
                            () => rej(new Error("balance RPC timeout")),
                            6000
                        )
                    ),
                ]);
                let liveGasCost = gasCost;
                if (attempt > 1 && /gas|insufficient|funds|balance/i.test(String(lastErr || ""))) {
                    try {
                        liveGasCost = await estimateBuyGasCost(gasLimit);
                        liveGasCost = (liveGasCost * 120n) / 100n;
                    } catch (_) {
                        liveGasCost = (gasCost * 130n) / 100n;
                    }
                } else {
                    // Shared estimate + 15% pad — avoids 78× getFeeData stampede
                    liveGasCost = (gasCost * 115n) / 100n;
                }

                if (bal < liveGasCost) {
                    lastErr = `wallet nearly empty (${ethers.formatEther(bal)} ETH) — need gas buffer`;
                    onProgress({
                        type: "error",
                        wallet: addr,
                        error: lastErr,
                        attempt,
                    });
                    break; // re-fund required — retry won't help
                }

                const want = parseEthAmount(amount);
                if (bal < want + liveGasCost) {
                    // Plan B: shrink buy so value + gas fits
                    const maxSpend = bal > liveGasCost ? bal - liveGasCost : 0n;
                    if (maxSpend <= 0n) {
                        lastErr = `insufficient funds for gas`;
                        break;
                    }
                    const shrunk = Number(ethers.formatEther(maxSpend));
                    // Extra 3% haircut so tip bumps don't strand the tx
                    const safer = Math.floor(shrunk * 0.97 * 1e6) / 1e6;
                    if (safer <= 0) {
                        lastErr = `insufficient funds after gas reserve`;
                        break;
                    }
                    clampedFrom = amount;
                    amount = safer;
                    onProgress({
                        type: "warn",
                        wallet: addr,
                        msg: `gas tight — clamp buy ${clampedFrom} → ${amount} ETH (attempt ${attempt}/${maxAttempts})`,
                        attempt,
                    });
                }

                const buyTimeoutMs = Math.max(
                    8000,
                    Number(options.buyTimeoutMs || 20000)
                );
                const tx = await Promise.race([
                    buy(
                        { private_key: w.private_key },
                        amount,
                        tokenAddress,
                        {
                            ...(options.buyOptions || {}),
                            tokenInfo,
                            fee,
                            pairedToken,
                            feeData,
                            gasCost: liveGasCost,
                            balance: bal,
                            gasLimit,
                            slippageBps: slipBps,
                            skipQuote:
                                mode === "burst" || options.skipQuote === true,
                            requireQuote: false,
                            clamp: true,
                            priorityMultiplier: tipMult,
                        }
                    ),
                    new Promise((_, rej) =>
                        setTimeout(
                            () =>
                                rej(
                                    new Error(
                                        `buy timeout after ${buyTimeoutMs}ms (RPC hung)`
                                    )
                                ),
                            buyTimeoutMs
                        )
                    ),
                ]);
                if (tx?.error) {
                    lastErr = tx.error;
                    throw new Error(tx.error);
                }
                onProgress({
                    type: "bought",
                    wallet: addr,
                    name: w.name,
                    hash: tx.hash,
                    amountEth: amount,
                    attempt,
                    clamped: clampedFrom != null,
                });
                return {
                    wallet: addr,
                    name: w.name,
                    hash: tx.hash,
                    amountEth: amount,
                    attempt,
                    clampedFrom,
                };
            } catch (e) {
                lastErr = e.shortMessage || e.message || String(e);
                const low = String(lastErr).toLowerCase();
                const isGas =
                    /insufficient|funds|gas|intrinsic|overshot|balance/i.test(
                        low
                    );
                const isTransient =
                    /nonce|replacement|timeout|429|rate|network|econnreset|server error|coalesce|already known/i.test(
                        low
                    );
                const isSlip =
                    /slippage|too little|stf|price|execution reverted/i.test(
                        low
                    );

                onProgress({
                    type: "retry",
                    wallet: addr,
                    name: w.name,
                    error: lastErr,
                    attempt,
                    maxAttempts,
                    next:
                        attempt < maxAttempts
                            ? isGas
                                ? "shrink_buy"
                                : isSlip
                                  ? "widen_slip+tip"
                                  : "bump_tip"
                            : "give_up",
                });

                if (attempt >= maxAttempts) break;

                if (isGas) {
                    // Shrink another ~6% and leave more for gas
                    amount = Math.floor(amount * 0.94 * 1e6) / 1e6;
                    tipMult = Math.min(2.5, tipMult * 1.1);
                } else if (isSlip) {
                    slipBps = Math.min(2500, Math.round(slipBps * 1.35));
                    tipMult = Math.min(2.5, tipMult * 1.2);
                } else if (isTransient) {
                    tipMult = Math.min(2.5, tipMult * 1.25);
                } else {
                    // Unknown — mild shrink + tip bump
                    amount = Math.floor(amount * 0.97 * 1e6) / 1e6;
                    tipMult = Math.min(2.5, tipMult * 1.15);
                }
                if (amount <= 0) break;
                await sleep(250 + attempt * 200);
            }
        }

        onProgress({ type: "error", wallet: addr, error: lastErr });
        return {
            wallet: addr,
            name: w.name,
            error: lastErr || "buy failed",
            attempts: maxAttempts,
        };
    }

    async function runInterferenceGuard(waveEndIndex) {
        if (!tapeGuard) return "continue";
        if (shouldAbort()) return "pause";
        try {
            const swaps = await fetchRecentSwaps(tokenAddress, { limit: 60 });
            const foreign = detectForeignBuys(swaps, ownSet, guardSinceTs, {
                minEth: foreignMinEth,
            });
            const maxTs = swaps.reduce(
                (m, s) => Math.max(m, s.timestamp || 0),
                0
            );
            if (maxTs > guardSinceTs) guardSinceTs = maxTs;
            if (!foreign.length) return "continue";

            const biggest = foreign
                .slice()
                .sort((a, b) => b.ethAmount - a.ethAmount)[0];
            onProgress({
                type: "foreign_buy",
                count: foreign.length,
                ethTotal: foreign.reduce((a, s) => a + s.ethAmount, 0),
                biggest,
                waveCompleted: waveEndIndex,
                policy: foreignPolicy,
                swaps: foreign.slice(0, 8),
            });

            let action = foreignPolicy;
            if (typeof options.onForeignBuy === "function") {
                const override = await options.onForeignBuy({
                    foreign,
                    biggest,
                    resultsSoFar: results.slice(),
                    waveCompleted: waveEndIndex,
                    remaining: eligible.length - waveEndIndex,
                });
                if (override) action = override;
            }

            if (action === "pause" || action === "abort" || action === "stop") {
                onProgress({
                    type: "guard_action",
                    action: "pause",
                    msg: "Paused remaining buys after foreign wallet entered",
                });
                return "pause";
            }

            if (
                action === "react" ||
                action === "dump" ||
                action === "dump_resume"
            ) {
                const bought = results.filter((r) => r.hash);
                onProgress({
                    type: "guard_action",
                    action: "react",
                    msg: `Dumping ${bought.length} filled wallet(s) into their buy, then continuing`,
                    sellCount: bought.length,
                });
                if (typeof options.reactSell === "function" && bought.length) {
                    try {
                        await options.reactSell(bought);
                        onProgress({
                            type: "guard_action",
                            action: "react_done",
                            msg: "React sell finished — resuming remaining buys with higher tip",
                        });
                    } catch (e) {
                        onProgress({
                            type: "guard_action",
                            action: "react_error",
                            msg: e.message || String(e),
                        });
                    }
                }
                priorityMultiplier = Math.min(2.5, priorityMultiplier * 1.3);
                return "continue";
            }

            if (action === "bump") {
                priorityMultiplier = Math.min(2.5, priorityMultiplier * 1.25);
                onProgress({
                    type: "guard_action",
                    action: "bump",
                    msg: `Raising priority tip to ×${priorityMultiplier.toFixed(2)} and continuing`,
                    priorityMultiplier,
                });
                return "continue";
            }

            onProgress({
                type: "guard_action",
                action: "log",
                msg: "Foreign buy logged — continuing burst",
            });
            return "continue";
        } catch (e) {
            onProgress({
                type: "warn",
                wallet: "tape",
                msg: `Interference check failed: ${e.message || e}`,
            });
            return "continue";
        }
    }

    /** Map filled buy results → eligible wallet objects (for soft sells). */
    function filledWalletsFromResults() {
        const byAddr = new Map();
        for (const w of eligible) {
            const a = String(
                w.address || new ethers.Wallet(w.private_key).address
            ).toLowerCase();
            byAddr.set(a, w);
        }
        const out = [];
        const seen = new Set();
        for (const r of results) {
            if (!r?.hash) continue;
            const a = String(r.wallet || "").toLowerCase();
            if (!a || seen.has(a) || !byAddr.has(a)) continue;
            seen.add(a);
            out.push(byAddr.get(a));
        }
        return out;
    }

    /**
     * Soft-sell into foreign demand without nuking the chart.
     * Caps estimated ETH out at organicMaxDipPct (10–20%) of live MC.
     */
    async function softSellIntoForeign(reason = "foreign buy") {
        const filled = filledWalletsFromResults();
        if (!filled.length) {
            onProgress({
                type: "organic_soft_sell",
                skipped: true,
                msg: "No filled bags to soft-sell yet",
            });
            return { soldEthEst: 0, dropPct: 0 };
        }

        let mcBefore = null;
        try {
            mcBefore = await resolveLiveMarketCap(tokenAddress, tokenInfo);
        } catch (_) {}
        const mcapEth = Number(mcBefore?.mcapEth || 0);
        const ethBudget =
            mcapEth > 0 ? mcapEth * organicMaxDipPct : null;

        onProgress({
            type: "organic_soft_sell",
            reason,
            wallets: filled.length,
            mcapEth,
            mcapUsd: mcBefore?.mcapUsd,
            maxDipPct: organicMaxDipPct * 100,
            ethBudget,
            sellPctPerWallet: organicSellPct,
            msg: `Soft-selling into ${reason} · target ≤${(organicMaxDipPct * 100).toFixed(0)}% MC dip`,
        });

        let soldEthEst = 0;
        // Largest bags first — fewer wallets, cleaner chart
        const ranked = [];
        for (const w of filled) {
            const addr =
                w.address || new ethers.Wallet(w.private_key).address;
            try {
                const { balance } = await getTokenBalanceRaw(
                    addr,
                    tokenAddress
                );
                if (balance > 0n) {
                    ranked.push({ w, addr, balance });
                }
            } catch (_) {}
        }
        ranked.sort((a, b) => (a.balance < b.balance ? 1 : -1));

        for (const row of ranked) {
            if (shouldAbort()) break;
            if (ethBudget != null && soldEthEst >= ethBudget * 0.92) break;

            let usePct = organicSellPct;
            let ethOutEst = 0;
            try {
                const amountIn =
                    (row.balance * BigInt(Math.floor(usePct))) / 100n;
                if (amountIn > 0n) {
                    const q = await quoteSell(
                        tokenAddress,
                        ethers.formatUnits(amountIn, tokenInfo?.token?.decimals ?? 18),
                        { fee, pairedToken }
                    );
                    ethOutEst = Number(q.ethOut || 0);
                }
            } catch (_) {}

            if (
                ethBudget != null &&
                ethOutEst > 0 &&
                soldEthEst + ethOutEst > ethBudget * 1.12
            ) {
                const remain = Math.max(0, ethBudget - soldEthEst);
                usePct = Math.max(
                    5,
                    Math.floor(organicSellPct * (remain / ethOutEst))
                );
                if (usePct < 5 || remain <= 0) break;
                ethOutEst = ethOutEst * (usePct / organicSellPct);
            }

            try {
                const sellRes = await multiSell([row.w], tokenAddress, {
                    mode: "sequential",
                    percent: usePct,
                    fast: true,
                    waitForReceipt: false,
                    skipQuote: false,
                    tokenInfo,
                    fee,
                    pairedToken,
                    onProgress: (sev) => {
                        if (sev.type === "sold") {
                            onProgress({
                                type: "organic_sold",
                                wallet: sev.wallet,
                                name: sev.name,
                                hash: sev.hash,
                                percent: usePct,
                            });
                        } else if (sev.type === "error") {
                            onProgress({
                                type: "warn",
                                wallet: sev.wallet,
                                msg: `soft-sell failed: ${sev.error}`,
                            });
                        }
                    },
                });
                const ok = sellRes.some((r) => r.hash);
                if (ok) soldEthEst += ethOutEst || 0;
            } catch (e) {
                onProgress({
                    type: "warn",
                    wallet: row.addr,
                    msg: `soft-sell error: ${e.message || e}`,
                });
            }
        }

        let mcAfter = null;
        try {
            mcAfter = await resolveLiveMarketCap(tokenAddress, tokenInfo);
        } catch (_) {}
        const dropPct =
            mcapEth > 0 && mcAfter?.mcapEth > 0
                ? ((mcapEth - mcAfter.mcapEth) / mcapEth) * 100
                : ethBudget > 0
                  ? (soldEthEst / (mcapEth || soldEthEst)) * 100
                  : 0;

        onProgress({
            type: "organic_soft_sell_done",
            soldEthEst,
            mcapBeforeEth: mcapEth,
            mcapAfterEth: mcAfter?.mcapEth,
            dropPct,
            msg: `Soft-sell done · ~${soldEthEst.toFixed(4)} ETH out · chart dip ~${dropPct.toFixed(1)}% (cap ${(organicMaxDipPct * 100).toFixed(0)}%)`,
        });
        return { soldEthEst, dropPct, mcBefore, mcAfter };
    }

    async function pollForeignNow() {
        if (!tapeGuard) return [];
        try {
            const swaps = await fetchRecentSwaps(tokenAddress, { limit: 60 });
            const foreign = detectForeignBuys(swaps, ownSet, guardSinceTs, {
                minEth: foreignMinEth,
            });
            const maxTs = swaps.reduce(
                (m, s) => Math.max(m, s.timestamp || 0),
                0
            );
            if (maxTs > guardSinceTs) guardSinceTs = maxTs;
            return foreign;
        } catch (_) {
            return [];
        }
    }

    /** Wait until no foreign buys for organicQuietSec; soft-sell once per episode. */
    async function waitForQuietTape() {
        let lastForeignAt = Date.now();
        let softSoldThisEpisode = false;
        onProgress({
            type: "organic_wait_quiet",
            quietSec: organicQuietSec,
            msg: `Waiting for outsiders to leave (~${organicQuietSec}s quiet)…`,
        });

        while (!shouldAbort()) {
            const foreign = await pollForeignNow();
            if (foreign.length) {
                lastForeignAt = Date.now();
                const biggest = foreign
                    .slice()
                    .sort((a, b) => b.ethAmount - a.ethAmount)[0];
                onProgress({
                    type: "foreign_buy",
                    count: foreign.length,
                    ethTotal: foreign.reduce((a, s) => a + s.ethAmount, 0),
                    biggest,
                    policy: "organic",
                    swaps: foreign.slice(0, 8),
                });
                if (!softSoldThisEpisode) {
                    await softSellIntoForeign("foreign buy");
                    softSoldThisEpisode = true;
                }
            } else if (Date.now() - lastForeignAt >= organicQuietSec * 1000) {
                onProgress({
                    type: "organic_resume",
                    msg: "Tape quiet — resuming organic buys",
                });
                return;
            }
            await sleep(organicPollMs);
        }
    }

    /** Sleep `sec` while watching tape; interrupt on foreign buy. */
    async function pacedWait(sec) {
        const end = Date.now() + Math.max(0, sec) * 1000;
        while (!shouldAbort() && Date.now() < end) {
            const foreign = await pollForeignNow();
            if (foreign.length) return "foreign";
            const left = end - Date.now();
            await sleep(Math.min(organicPollMs, Math.max(200, left)));
        }
        return shouldAbort() ? "abort" : "ok";
    }

    if (mode === "organic") {
        onProgress({
            type: "wave",
            from: 1,
            to: eligible.length,
            total: eligible.length,
            inflight: 1,
            msg: `organic · ${eligible.length} wallets · ~${organicPaceSec}s pace · soft-sell ≤${(organicMaxDipPct * 100).toFixed(0)}% MC dips`,
        });

        for (let i = 0; i < eligible.length; i++) {
            if (shouldAbort()) {
                onProgress({
                    type: "aborted",
                    at: i,
                    total: eligible.length,
                    msg: "Organic buy aborted",
                });
                break;
            }

            // Pre-buy tape check
            const preForeign = await pollForeignNow();
            if (preForeign.length) {
                const biggest = preForeign
                    .slice()
                    .sort((a, b) => b.ethAmount - a.ethAmount)[0];
                onProgress({
                    type: "foreign_buy",
                    count: preForeign.length,
                    ethTotal: preForeign.reduce((a, s) => a + s.ethAmount, 0),
                    biggest,
                    policy: "organic",
                    swaps: preForeign.slice(0, 8),
                });
                onProgress({
                    type: "guard_action",
                    action: "organic_pause",
                    msg: "Foreign buy — pausing buys, soft-selling into them",
                });
                await waitForQuietTape();
            }

            if (i > 0) {
                const jitter =
                    organicPaceJitterSec > 0
                        ? (Math.random() * 2 - 1) * organicPaceJitterSec
                        : 0;
                const planDelay = Number(
                    eligible[i].delaySec ?? options.defaultDelaySec ?? 0
                );
                const waitSec = Math.max(
                    2,
                    Math.max(organicPaceSec + jitter, planDelay)
                );
                onProgress({
                    type: "waiting",
                    wallet: eligible[i].address || eligible[i].name,
                    delaySec: Math.round(waitSec * 10) / 10,
                    organic: true,
                });
                const waitResult = await pacedWait(waitSec);
                if (waitResult === "abort") break;
                if (waitResult === "foreign") {
                    onProgress({
                        type: "guard_action",
                        action: "organic_pause",
                        msg: "Foreign buy mid-pace — soft-sell then wait quiet",
                    });
                    await waitForQuietTape();
                }
            }

            results.push(await buyOne(eligible[i], i));

            // Light post-buy check (catch snipes that landed with us)
            if (i < eligible.length - 1) {
                const postForeign = await pollForeignNow();
                if (postForeign.length) {
                    onProgress({
                        type: "guard_action",
                        action: "organic_pause",
                        msg: "Foreign buy after our fill — soft-sell into them",
                    });
                    await waitForQuietTape();
                }
            }
        }
    } else if (mode === "burst") {
        // Continuous pipeline (not giant Promise.all waves).
        // Public Robinhood RPC dies if we open 78 sendTransaction calls at once —
        // keep `inflight` capped and start the next wallet as soon as one finishes.
        const inflight = Math.min(16, Math.max(6, concurrency));
        const staggerMs = Math.max(0, Number(options.staggerMs ?? 35));
        onProgress({
            type: "wave",
            from: 1,
            to: eligible.length,
            total: eligible.length,
            inflight,
            msg: `pipeline · ${eligible.length} wallets · ${inflight} in-flight max`,
        });

        const slotResults = new Array(eligible.length);
        let nextIdx = 0;
        let completed = 0;
        let pausedRest = false;

        async function worker() {
            while (true) {
                if (shouldAbort() || pausedRest) return;
                const i = nextIdx++;
                if (i >= eligible.length) return;
                if (staggerMs > 0 && i > 0) await sleep(staggerMs);
                slotResults[i] = await buyOne(eligible[i], i);
                completed++;
                // Light tape check every `inflight` completions (not between giant waves)
                if (
                    tapeGuard &&
                    !pausedRest &&
                    completed % Math.max(inflight, 8) === 0 &&
                    completed < eligible.length
                ) {
                    const decision = await runInterferenceGuard(completed);
                    if (decision === "pause") {
                        pausedRest = true;
                        return;
                    }
                }
            }
        }

        const workers = Array.from(
            { length: Math.min(inflight, eligible.length) },
            () => worker()
        );
        await Promise.all(workers);

        for (let i = 0; i < eligible.length; i++) {
            if (slotResults[i]) {
                results.push(slotResults[i]);
            } else {
                results.push({
                    wallet: eligible[i].address || eligible[i].name,
                    skipped: true,
                    reason: pausedRest
                        ? "paused — foreign buy"
                        : shouldAbort()
                          ? "aborted"
                          : "not started",
                });
            }
        }
        if (shouldAbort()) {
            onProgress({
                type: "aborted",
                at: completed,
                total: eligible.length,
                msg: "Buy aborted — remaining wallets skipped",
            });
        }
    } else {
        for (let i = 0; i < eligible.length; i++) {
            if (shouldAbort()) {
                onProgress({
                    type: "aborted",
                    at: i,
                    total: eligible.length,
                    msg: "Buy aborted",
                });
                break;
            }
            const w = eligible[i];
            const delaySec = Number(w.delaySec ?? options.defaultDelaySec ?? 0);
            if (i > 0 && delaySec > 0) {
                onProgress({
                    type: "waiting",
                    wallet: w.address || w.name,
                    delaySec,
                });
                await sleep(delaySec * 1000);
            } else if (i === 0 && Number(w.initialDelaySec || 0) > 0) {
                await sleep(Number(w.initialDelaySec) * 1000);
            }
            results.push(await buyOne(w, i));
        }
    }

    return results;
}


async function waitTx(tx, confirms = 1) {
    if (!tx?.hash) {
        throw new Error("No transaction hash to wait for");
    }
    let receipt;
    try {
        receipt = await tx.wait(confirms);
    } catch (err) {
        // Fallback: poll receipt in case provider wait() flakes
        for (let i = 0; i < 30; i++) {
            receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt) break;
            await sleep(2000);
        }
        if (!receipt) {
            throw new Error(
                `tx not confirmed: ${tx.hash} (${err.shortMessage || err.message})`
            );
        }
    }
    if (!receipt) {
        throw new Error(`tx not confirmed: ${tx.hash}`);
    }
    if (receipt.status === 0) {
        throw new Error(`tx reverted: ${tx.hash}`);
    }
    return receipt;
}

async function getNonce(wallet_address) {
    const nonce = await provider.getTransactionCount(wallet_address);
    return nonce;
}

function formatTokenAmount(n) {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
    if (n >= 1) return n.toFixed(2);
    return n.toPrecision(3);
}

/**
 * Build a ramp buy plan: wallet 1 buys least, last buys most.
 * Default sizes by % of supply (start ~0.4% → end ~1.2%), then scale to totalEth.
 * Estimates tokens from live price (and optional quoter for a few sizes).
 */
async function buildBuyPlan(tokenAddress, totalEth, walletCount, options = {}) {
    const requested = Math.max(1, Math.floor(Number(walletCount) || 1));
    if (requested > MAX_BUNDLE_WALLETS) {
        throw new Error(
            `Wallet count ${requested} exceeds max ${MAX_BUNDLE_WALLETS}`
        );
    }
    const n = requested;
    const total = Number(totalEth);
    if (!Number.isFinite(total) || total <= 0) {
        throw new Error("Invalid total ETH");
    }

    const info = options.tokenInfo || (await resolveTokenInfo(tokenAddress, options));
    const t = info.token || info;
    const supply = parseTokenSupply(info, t.decimals ?? 18);
    const priceEth = Number(t.priceEth) || 0;
    const mcapEth = resolveMarketCapEth(info);
    const ethUsd = await getEthUsdPrice();
    const mcapUsd = ethToUsd(mcapEth, ethUsd);
    const maxWalletTokens = (supply * NOXA_MAX_WALLET_BPS) / 10000;
    const maxWalletPct = NOXA_MAX_WALLET_BPS / 100;
    const fee = Number(t.poolFee ?? DEFAULT_POOL_FEE);
    const paired = t.pairedToken || WETH;

    // Supply-% ramp = relative SHAPE only (not clamped to on-chain max-wallet).
    // User can set e.g. 0.4 → 3 to make the last wallets ~7.5× the first.
    const startPct = Math.max(0.05, Number(options.startPctSupply ?? 0.4));
    let endPct = Number(
        options.endPctSupply ?? Math.max(startPct * 2.5, startPct + 0.5)
    );
    endPct = Math.max(startPct, endPct);
    // Soft ceiling so typos don't explode — not the 2% max-wallet rule
    const SHAPE_MAX = 10;
    if (startPct > SHAPE_MAX) {
        throw new Error(`Start % shape max is ${SHAPE_MAX}`);
    }
    if (endPct > SHAPE_MAX) {
        throw new Error(`End % shape max is ${SHAPE_MAX}`);
    }

    const targetPcts = Array.from({ length: n }, (_, i) => {
        if (n === 1) return startPct;
        return startPct + ((endPct - startPct) * i) / (n - 1);
    });

    // Relative weights from the ramp — distribute 100% of user's Total ETH
    const weights = targetPcts.map((p) => Math.max(p, 0.01));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    let amounts = weights.map((w) => (total * w) / weightSum);

    // What that ramp would cost at current price (info only — never overrides budget)
    let idealEth = targetPcts.map((pct) => {
        if (!(priceEth > 0) || !(supply > 0)) return 0;
        return (supply * (pct / 100)) * priceEth;
    });
    const idealTotal = idealEth.reduce((a, b) => a + b, 0);

    const warnings = [];
    if (idealTotal > 0) {
        const ratio = total / idealTotal;
        if (ratio < 0.85) {
            warnings.push(
                `At current price, a ${startPct}%→${endPct}% supply ramp would need ~${idealTotal.toFixed(4)} ETH. Your ${total} ETH is ~${(ratio * 100).toFixed(0)}% of that — bags will be smaller than the target shape %.`
            );
        } else if (ratio > 1.25) {
            // Informational only — full budget is still allocated.
            warnings.push(
                `Info (not an error): at today’s spot price, a literal 0.4%→2% of supply would only cost ~${idealTotal.toFixed(4)} ETH. You’re spending the full ${total} ETH anyway — split by the ramp shape. Rising-MC % is in the table; ignore this if no wallet is flagged over 2%.`
            );
        }
    }

    // Round to 6 decimals and fix last wallet so sum == Total ETH
    const rounded = amounts.map((a) => Math.floor(a * 1e6) / 1e6);
    const sumRounded = rounded.reduce((a, b) => a + b, 0);
    if (n > 0) {
        rounded[n - 1] =
            Math.round((total - (sumRounded - rounded[n - 1])) * 1e6) / 1e6;
        if (rounded[n - 1] < 0) rounded[n - 1] = 0;
    }

    /**
     * Simulate rising MC across the buy sequence.
     * Spot price alone overstates late-wallet % (MC goes up as we buy).
     * 1) Prefer cumulative Uniswap quoter diffs (accurate for pool impact)
     * 2) Else bonding-style: tokens ≈ supply * ln((M+eth)/M), then M += eth
     */
    const simulateImpact = options.simulateImpact !== false;
    const useQuoter =
        simulateImpact &&
        options.useQuoter !== false &&
        n <= Number(options.quoterMaxWallets ?? 50) &&
        priceEth > 0;

    let simMcap = mcapEth > 0 ? mcapEth : priceEth > 0 ? priceEth * supply : 0;
    let cumEthIn = 0;
    let prevCumTokens = 0;
    let impactMode = "spot";

    const rows = [];
    for (let i = 0; i < n; i++) {
        const eth = rounded[i];
        let tokensEst = 0;
        let quoted = false;
        let priceEthAtBuy = priceEth;

        if (simulateImpact && useQuoter) {
            try {
                cumEthIn += eth;
                const cumOut = await quoteExactInput(
                    paired,
                    tokenAddress,
                    ethers.parseEther(String(cumEthIn)),
                    fee
                );
                const cumTokens = Number(
                    ethers.formatUnits(cumOut, t.decimals ?? 18)
                );
                tokensEst = Math.max(0, cumTokens - prevCumTokens);
                prevCumTokens = cumTokens;
                quoted = true;
                impactMode = "quoter_cumulative";
                if (tokensEst > 0 && eth > 0) {
                    priceEthAtBuy = eth / tokensEst;
                }
            } catch (_) {
                // fall through to mcap model for this wallet
            }
        }

        if (!quoted && simulateImpact && simMcap > 0 && supply > 0 && eth > 0) {
            // Integral of price = mcap/supply as mcap rises by eth spent
            tokensEst = supply * Math.log((simMcap + eth) / simMcap);
            priceEthAtBuy = simMcap / supply;
            simMcap += eth;
            impactMode = impactMode === "quoter_cumulative" ? impactMode : "mcap_sequence";
        } else if (!quoted) {
            tokensEst = priceEth > 0 ? eth / priceEth : 0;
            if (simulateImpact && eth > 0) simMcap += eth;
        } else if (simulateImpact && eth > 0) {
            // Keep mcap tracker roughly in sync even when quoter path succeeded
            simMcap += eth;
        }

        const pctSupply = supply > 0 ? (tokensEst / supply) * 100 : 0;
        const overMax = tokensEst > maxWalletTokens;
        const baseDelay = Number(options.baseDelaySec ?? 15);
        const delaySec =
            i === 0
                ? 0
                : Math.min(Number(options.maxDelaySec ?? 120), baseDelay * i);
        rows.push({
            index: i + 1,
            eth,
            tokensEst,
            pctSupply,
            targetPctSupply: targetPcts[i],
            overMax,
            quoted,
            priceEthAtBuy,
            delaySec,
        });
    }

    const over = rows.filter((r) => r.overMax).map((r) => r.index);
    if (over.length) {
        warnings.push(
            `${over.length} wallet(s) estimated above ~${maxWalletPct}% max-wallet after sequential impact (e.g. #${over.slice(0, 5).join(", ")}${over.length > 5 ? "…" : ""}). Early buys are the risk — add wallets or flatten/lower Total ETH.`
        );
    }
    if (simulateImpact && rows.length >= 2) {
        const first = rows[0].pctSupply;
        const last = rows[rows.length - 1].pctSupply;
        if (first > 0 && last >= 0 && last < first * 0.85) {
            warnings.push(
                `Impact model (${impactMode}): wallet #1 ~${first.toFixed(3)}% → last ~${last.toFixed(3)}% of supply (same ETH buys less as MC rises).`
            );
        }
    }

    if (rows[0] && idealTotal > 0 && rows[0].pctSupply + 1e-9 < startPct * 0.5) {
        warnings.push(
            `Wallet #1 is only ~${rows[0].pctSupply.toFixed(3)}% of supply (ramp shape aimed at ${startPct}%). Raise Total ETH if you want bigger early buys.`
        );
    }

    const plannedTotal = Math.round(rounded.reduce((a, b) => a + b, 0) * 1e6) / 1e6;

    return {
        token: {
            address: t.address || tokenAddress,
            name: t.name,
            symbol: t.symbol,
            supply,
            priceEth,
            mcapEth,
            mcapUsd,
            mcapUsdLabel: formatUsd(mcapUsd),
            ethUsd,
            poolFee: fee,
            maxWalletTokens,
            maxWalletPct,
            startingMcEth: NOXA_STARTING_MC_ETH,
            startingMcUsd: ethToUsd(NOXA_STARTING_MC_ETH, ethUsd),
            startingMcUsdLabel: formatUsd(ethToUsd(NOXA_STARTING_MC_ETH, ethUsd)),
            bondingTargetEth: NOXA_BONDING_TARGET_ETH,
        },
        totalEth: plannedTotal,
        budgetEth: total,
        walletCount: n,
        startPctSupply: startPct,
        endPctSupply: endPct,
        // Reference only — plan always uses full budgetEth
        suggestedTotalEth: idealTotal > 0 ? Math.round(idealTotal * 1e6) / 1e6 : null,
        usesFullBudget: true,
        impactMode,
        simulatedMcapEndEth: simMcap > 0 ? Math.round(simMcap * 1e6) / 1e6 : null,
        warnings,
        rows,
        totalTokensEst: rows.reduce((a, r) => a + r.tokensEst, 0),
        totalPctSupply: supply > 0
            ? (rows.reduce((a, r) => a + r.tokensEst, 0) / supply) * 100
            : 0,
    };
}

function suggestRampFromBudget(totalEth, walletCount) {
    const n = Math.max(1, Number(walletCount));
    const total = Number(totalEth);
    const weights = Array.from({ length: n }, (_, i) => i + 1);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const amounts = weights.map((w) => Math.floor((total * w) / weightSum * 1e6) / 1e6);
    const sum = amounts.reduce((a, b) => a + b, 0);
    amounts[n - 1] = Math.round((total - (sum - amounts[n - 1])) * 1e6) / 1e6;
    return amounts;
}



/**
 * Split totalEth across n wallets.
 * mode: "ramp" | "even" | "variance"
 * variancePct default 15 (±15% like stealth-bundler Houdini UI)
 */
function allocateSplits(totalEth, n, mode = "ramp", variancePct = 15) {
    const count = Math.max(1, Number(n));
    const total = Number(totalEth);
    if (!Number.isFinite(total) || total <= 0) throw new Error("Invalid total");

    let amounts = [];
    if (mode === "even") {
        const each = Math.floor((total / count) * 1e6) / 1e6;
        amounts = Array(count).fill(each);
    } else if (mode === "variance") {
        let remaining = total;
        for (let i = 0; i < count; i++) {
            if (i === count - 1) {
                amounts.push(Math.round(remaining * 1e6) / 1e6);
            } else {
                const base = total / count;
                const v = base * (variancePct / 100);
                const amt = Math.max(0.000001, base + (Math.random() * 2 - 1) * v);
                const clamped = Math.round(amt * 1e6) / 1e6;
                amounts.push(clamped);
                remaining -= clamped;
            }
        }
    } else {
        // ramp: 1..n weights
        const weights = Array.from({ length: count }, (_, i) => i + 1);
        const sum = weights.reduce((a, b) => a + b, 0);
        amounts = weights.map((w) => Math.floor((total * w) / sum * 1e6) / 1e6);
    }

    const s = amounts.reduce((a, b) => a + b, 0);
    amounts[count - 1] = Math.round((total - (s - amounts[count - 1])) * 1e6) / 1e6;
    return amounts;
}

/**
 * Pull ETH from source wallets back to destination (funder), leaving gasReserve.
 * Optionally unwraps leftover WETH first so seasoning leftovers come back too.
 */
async function recallEth(sources, toAddress, options = {}) {
    const onProgress = options.onProgress || (() => {});
    const gasReserveEth = Number(options.gasReserveEth ?? 0.0002);
    const gasReserve = parseEthAmount(gasReserveEth);
    const delayMsMin = Number(options.delayMsMin ?? 800);
    const delayMsMax = Number(options.delayMsMax ?? 2500);
    const unwrapWeth = options.unwrapWeth !== false;
    const results = [];

    if (!toAddress || !ethers.isAddress(toAddress)) {
        throw new Error(`Invalid recall destination: ${toAddress}`);
    }
    const toChecksum = ethers.getAddress(toAddress);

    for (const src of sources) {
        try {
            const wallet = new ethers.Wallet(src.private_key, provider);
            if (
                wallet.address.toLowerCase() === toChecksum.toLowerCase()
            ) {
                onProgress({
                    type: "skip",
                    wallet: src.address,
                    reason: "same as funder",
                });
                results.push({ address: src.address, skipped: true, reason: "same as funder" });
                continue;
            }

            if (unwrapWeth) {
                try {
                    const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
                    const wBal = await weth.balanceOf(src.address);
                    if (wBal > 0n) {
                        onProgress({
                            type: "unwrapping",
                            wallet: src.address,
                            amount: ethers.formatEther(wBal),
                        });
                        const uTx = await weth.withdraw(wBal);
                        if (options.waitForConfirm !== false) await uTx.wait();
                        onProgress({
                            type: "unwrapped",
                            wallet: src.address,
                            hash: uTx.hash,
                        });
                    }
                } catch (e) {
                    onProgress({
                        type: "unwrap_error",
                        wallet: src.address,
                        error: e.shortMessage || e.message,
                    });
                }
            }

            const bal = await provider.getBalance(src.address);
            const sendAmount = bal > gasReserve ? bal - gasReserve : 0n;
            if (sendAmount <= 0n) {
                onProgress({ type: "skip", wallet: src.address, reason: "dust" });
                results.push({ address: src.address, skipped: true });
                continue;
            }
            const amountEth = ethers.formatEther(sendAmount);
            onProgress({
                type: "recalling",
                wallet: src.address,
                name: src.name,
                amountWei: sendAmount.toString(),
                amountEth,
            });
            const balBefore = bal;
            const funderBefore = await provider.getBalance(toChecksum);
            const tx = await transferEth(
                { private_key: src.private_key },
                toChecksum,
                sendAmount
            );
            if (options.waitForConfirm !== false) {
                const receipt = await waitTx(tx);
                if (!receipt || receipt.status !== 1) {
                    throw new Error(`recall tx failed on-chain: ${tx.hash}`);
                }
            }

            // Verify funds actually left the buyer (catches dropped/fake hashes)
            await sleep(800);
            const balAfter = await provider.getBalance(src.address);
            if (balAfter >= balBefore) {
                throw new Error(
                    `recall did not move funds (tx ${tx.hash}) — balance still ${ethers.formatEther(balAfter)} ETH`
                );
            }
            const funderAfter = await provider.getBalance(toChecksum);
            if (funderAfter <= funderBefore) {
                throw new Error(
                    `recall left source but funder did not gain (tx ${tx.hash}) — check destination ${toChecksum}`
                );
            }

            onProgress({
                type: "recalled",
                wallet: src.address,
                name: src.name,
                hash: tx.hash,
                amountEth,
                to: toChecksum,
            });
            results.push({
                address: src.address,
                hash: tx.hash,
                amountWei: sendAmount.toString(),
                amountEth,
                to: toChecksum,
            });
            await sleep(randomBetween(delayMsMin, delayMsMax));
        } catch (e) {
            onProgress({ type: "error", wallet: src.address, error: e.shortMessage || e.message });
            results.push({ address: src.address, error: e.shortMessage || e.message });
        }
    }
    return results;
}


/**
 * Launch a NOXA token from a dedicated DEV/creator wallet.
 * Factory selector 0x686399cb — reverse-engineered from live create txs.
 * msg.value = initial creator buy (first pool swap).
 */
const NOXA_CREATE_SELECTOR = "0x686399cb";
const NOXA_TOKEN_CREATED_TOPIC =
    "0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a";

async function launchToken(walletData, params = {}) {
    const pk = walletData?.private_key || walletData?.privateKey;
    if (!pk || !isEvmPrivateKey(pk)) {
        return { error: "Invalid creator/dev private key" };
    }
    const name = String(params.name || "").trim();
    const symbol = String(params.symbol || "").trim();
    if (!name || !symbol) {
        return { error: "name and symbol required" };
    }
    const metadataURI = String(params.metadataURI || params.uri || "").trim();
    const description = String(params.description || "").trim();
    const twitter = String(params.twitter || params.x || "").trim();
    const telegram = String(params.telegram || params.tg || "").trim();
    const website = String(params.website || "").trim();
    const discord = String(params.discord || "").trim();
    const other = String(params.other || params.farcaster || "").trim();

    const wallet = new ethers.Wallet(pk, provider);
    const creator =
        params.creator && isEvmAddress(params.creator)
            ? ethers.getAddress(params.creator)
            : wallet.address;

    const buyEth = Math.max(0.001, Number(params.buyEth ?? params.devBuyEth ?? 0.01));
    const value = parseEthAmount(buyEth);
    const salt =
        params.salt && String(params.salt).startsWith("0x") && String(params.salt).length === 66
            ? String(params.salt)
            : ethers.hexlify(ethers.randomBytes(32));

    const coder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = coder.encode(
        [
            "tuple(string,string,string,string,tuple(string,string,string,string,string),address)",
            "uint256",
            "uint256",
            "bytes32",
        ],
        [
            [
                name,
                symbol,
                metadataURI,
                description,
                [twitter, telegram, website, discord, other],
                creator,
            ],
            BigInt(params.field1 ?? 0),
            BigInt(params.field2 ?? 0),
            salt,
        ]
    );
    const data = NOXA_CREATE_SELECTOR + encoded.slice(2);

    const bal = await provider.getBalance(wallet.address);
    const feeData = await provider.getFeeData();
    let maxFee =
        feeData.maxFeePerGas ||
        feeData.gasPrice ||
        ethers.parseUnits("2", "gwei");
    let tip = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
    if (tip <= 0n) tip = ethers.parseUnits("1", "gwei");
    if (maxFee < tip) maxFee = tip * 2n;
    const gasLimit = 2_500_000n;
    const gasCost = gasLimit * maxFee;
    if (bal < value + gasCost) {
        return {
            error: `dev wallet needs ~${ethers.formatEther(value + gasCost)} ETH (buy ${buyEth} + gas), has ${ethers.formatEther(bal)}`,
        };
    }

    let tx;
    try {
        tx = await wallet.sendTransaction({
            to: LAUNCH_FACTORY,
            data,
            value,
            gasLimit,
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: tip,
            type: 2,
            chainId: CHAIN_ID,
        });
    } catch (e) {
        return { error: formatTxError(e) };
    }

    let receipt = null;
    const start = Date.now();
    while (Date.now() - start < 120_000) {
        try {
            receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt && receipt.status != null) break;
        } catch (_) {}
        await sleep(1200);
    }
    if (!receipt) {
        return { error: "launch tx timeout", hash: tx.hash, pending: true };
    }
    if (receipt.status !== 1) {
        return { error: "launch tx reverted", hash: tx.hash };
    }

    let token = null;
    for (const log of receipt.logs || []) {
        if (
            String(log.address).toLowerCase() === String(LAUNCH_FACTORY).toLowerCase() &&
            String(log.topics?.[0]).toLowerCase() === NOXA_TOKEN_CREATED_TOPIC
        ) {
            token = ethers.getAddress("0x" + String(log.topics[1]).slice(26));
            break;
        }
    }
    if (!token) {
        return { error: "launch succeeded but TokenCreated not found", hash: tx.hash };
    }

    return {
        ok: true,
        hash: tx.hash,
        token,
        creator,
        name,
        symbol,
        buyEth,
        salt,
        explorer: `${EXPLORER_TX}${tx.hash}`,
        noxaUrl: `https://fun.noxa.fi/robinhood/${token}`,
    };
}

module.exports = {
    buy,
    sell,
    multiBuy,
    multiSell,
    quoteSell,
    estimatePositions,
    analyzeMarketTape,
    buildSellPlan,
    buildProfitLadder,
    buildSellTheseNow,
    parseTokenSupply,
    resolveMarketCapEth,
    resolveLiveMarketCap,
    listTokens,
    listNewestTokens,
    fetchOnChainLaunches,
    fetchLaunchEventsFast,
    getCachedFeeData,
    normalizeListedToken,
    normalizeSocialKey,
    normalizeNameKey,
    narrativeQuality,
    LAUNCH_FACTORY,
    resolveMediaUrl,
    getCreatorLaunches,
    snipeBuy,
    estimateBuyReady,
    countPoolSwaps,
    disperseWithHops,
    allocateSplits,
    recallEth,
    buildBuyPlan,
    suggestRampFromBudget,
    formatTokenAmount,
    autoSlippageBps,
    NOXA_DEFAULT_SUPPLY,
    NOXA_STARTING_MC_ETH,
    NOXA_MAX_WALLET_BPS,
    NOXA_BONDING_TARGET_ETH,
    MAX_BUNDLE_WALLETS,
    mapPool,
    getEthUsdPrice,
    CHAIN_ID,
    ethToUsd,
    launchToken,
    formatUsd,
    formatUsdSigned,
    getWalletBalance,
    getTokenBalance,
    getTokenBalanceRaw,
    isEvmAddress,
    isEvmPrivateKey,
    shortenAddress,
    generateWallet,
    transferEth,
    waitTx,
    getNonce,
    getTokenInfo,
    resolveTokenInfo,
    syntheticTokenInfo,
    sleep,
    seasonWallet,
    seasonWallets,
    buildSeasoningPlan,
    estimateBuyGasCost,
    estimateSellGasCost,
    detectCreatorSells,
    fetchRecentSwaps,
    BUYER_GAS_BUFFER_ETH,
    HOP_GAS_RESERVE_ETH,
    // NOXA / Robinhood constants for callers
    CHAIN_ID,
    WETH,
    ROUTER,
    QUOTER,
    API_URL,
    RPC_URL,
    DEFAULT_POOL_FEE,
    provider,
};
