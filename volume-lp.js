/**
 * Self-LP helpers for volume rebate.
 * Mint a tight Uniswap V3 position around spot, then collect fees after wash swaps
 * so most of the 1% pool fee comes back to the same wallet.
 */
const { ethers } = require("ethers");
const chain = require("./blockchain");

const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const WETH = chain.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POOL_FEE = 10000; // NOXA Fun default
const TICK_SPACING = 200;
const MAX_UINT128 = (1n << 128n) - 1n;

const NPM_ABI = [
    "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)",
    "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
    "function factory() view returns (address)",
    "function burn(uint256 tokenId)",
    "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256 amount0, uint256 amount1)",
];

const POOL_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
];

const FACTORY_ABI = [
    "function getPool(address,address,uint24) view returns (address)",
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const WETH_ABI = [
    "function deposit() payable",
    "function withdraw(uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];

function alignTick(tick, spacing) {
    const t = Number(tick);
    const s = Number(spacing);
    // Uniswap: round toward -∞ onto spacing multiples
    let c = Math.floor(t / s) * s;
    if (c < -887200) c = -887200;
    if (c > 887200) c = 887200;
    return c;
}

function centeredRange(tick, widthSteps = 6) {
    const mid = alignTick(tick, TICK_SPACING);
    const w = Math.max(1, Number(widthSteps) || 2) * TICK_SPACING;
    let lo = mid - w;
    let hi = mid + w;
    // Ensure current tick is strictly inside (lo, hi)
    if (tick <= lo) lo = alignTick(tick - TICK_SPACING, TICK_SPACING);
    if (tick >= hi) hi = alignTick(tick + TICK_SPACING, TICK_SPACING) + TICK_SPACING;
    if (lo < -887200) lo = -887200;
    if (hi > 887200) hi = 887200;
    if (hi <= lo) hi = lo + TICK_SPACING;
    return { tickLower: lo, tickUpper: hi };
}

async function getPool(token) {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, chain.provider);
    const t = ethers.getAddress(token);
    const w = ethers.getAddress(WETH);
    const [a, b] = t.toLowerCase() < w.toLowerCase() ? [t, w] : [w, t];
    const poolAddr = await factory.getPool(a, b, POOL_FEE);
    if (!poolAddr || poolAddr === ethers.ZeroAddress) {
        throw new Error("No 1% pool for token — only NOXA Fun pools supported");
    }
    const pool = new ethers.Contract(poolAddr, POOL_ABI, chain.provider);
    const slot0 = await pool.slot0();
    return {
        address: poolAddr,
        token0: await pool.token0(),
        token1: await pool.token1(),
        fee: Number(await pool.fee()),
        tick: Number(slot0.tick),
        sqrtPriceX96: slot0.sqrtPriceX96,
        liquidity: await pool.liquidity(),
    };
}

async function ensureApprove(wallet, token, spender, amount) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const cur = await c.allowance(wallet.address, spender);
    if (cur >= amount) return null;
    const tx = await c.approve(spender, ethers.MaxUint256);
    await tx.wait();
    return tx.hash;
}

function txFeeOverrides(feeData, gasLimit) {
    const o = { gasLimit };
    if (feeData?.maxFeePerGas != null) {
        o.maxFeePerGas = feeData.maxFeePerGas;
        o.maxPriorityFeePerGas =
            feeData.maxPriorityFeePerGas != null ? feeData.maxPriorityFeePerGas : 0n;
    }
    return o;
}

/** True if current pool tick is strictly inside [tickLower, tickUpper). */
async function isPositionInRange(tokenId) {
    const npm = new ethers.Contract(NPM, NPM_ABI, chain.provider);
    const pos = await npm.positions(BigInt(tokenId));
    if (!(pos.liquidity > 0n)) return { inRange: false, dead: true, pos: null, tick: null };
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, chain.provider);
    const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
    const pool = new ethers.Contract(poolAddr, POOL_ABI, chain.provider);
    const slot0 = await pool.slot0();
    const tick = Number(slot0.tick);
    const lo = Number(pos.tickLower);
    const hi = Number(pos.tickUpper);
    const inRange = tick >= lo && tick < hi;
    // Near edge → refresh soon (within 1 spacing)
    const nearEdge =
        inRange && (tick - lo <= TICK_SPACING || hi - tick <= TICK_SPACING);
    return { inRange, nearEdge, dead: false, tick, tickLower: lo, tickUpper: hi, pos, poolAddr };
}

/** Our L / active pool L — fee capture ≈ this fraction of swap fees while in range. */
async function getLpShare(tokenId) {
    const status = await isPositionInRange(tokenId);
    if (status.dead || !status.poolAddr) {
        return { share: 0, ourLiq: 0n, poolLiq: 0n, inRange: false, dead: true };
    }
    const pool = new ethers.Contract(status.poolAddr, POOL_ABI, chain.provider);
    const poolLiq = await pool.liquidity();
    const ourLiq = status.pos.liquidity;
    const share =
        poolLiq > 0n && status.inRange ? Number(ourLiq) / Number(poolLiq) : 0;
    return {
        share,
        ourLiq,
        poolLiq,
        inRange: status.inRange,
        dead: false,
        tick: status.tick,
        tickLower: status.tickLower,
        tickUpper: status.tickUpper,
        poolAddr: status.poolAddr,
    };
}

async function closePosition(wallet, tokenId, feeData) {
    const npm = new ethers.Contract(NPM, NPM_ABI, wallet);
    const id = BigInt(tokenId);
    const pos = await npm.positions(id);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    if (pos.liquidity > 0n) {
        const dec = await npm.decreaseLiquidity(
            {
                tokenId: id,
                liquidity: pos.liquidity,
                amount0Min: 0n,
                amount1Min: 0n,
                deadline,
            },
            txFeeOverrides(feeData, 350000n)
        );
        await dec.wait();
    }
    const col = await npm.collect(
        {
            tokenId: id,
            recipient: wallet.address,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
        },
        txFeeOverrides(feeData, 400000n)
    );
    await col.wait();
    try {
        const burn = await npm.burn(id, txFeeOverrides(feeData, 120000n));
        await burn.wait();
    } catch (_) {
        // some forks allow collect-only; burn optional
    }
    // Unwrap WETH so next mint can re-wrap cleanly
    const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
    const wbal = await weth.balanceOf(wallet.address);
    if (wbal > ethers.parseEther("0.0002")) {
        try {
            const u = await weth.withdraw(wbal, txFeeOverrides(feeData, 60000n));
            await u.wait();
        } catch (_) {}
    }
    return true;
}

/**
 * Seed a tight LP around spot so wash swaps rebate fees to this wallet.
 * lpEth: total ETH budget for the position (half may buy tokens first).
 * refreshIfNeeded: close+remint when out of range or near edge.
 */
async function seedBalancesForMint(wallet, pk, token, pool, lpEth, feeData) {
    const a0c = new ethers.Contract(pool.token0, ERC20_ABI, wallet);
    const a1c = new ethers.Contract(pool.token1, ERC20_ABI, wallet);
    let a0 = await a0c.balanceOf(wallet.address);
    let a1 = await a1c.balanceOf(wallet.address);
    // After close/refresh we already hold both sides — don't buy again
    const minSide = ethers.parseEther("0.001");
    if (a0 > minSide && a1 > minSide) return;

    const balEth = await chain.provider.getBalance(wallet.address);
    const need = ethers.parseEther(String(Math.min(lpEth, 0.08)));
    const gasPad = ethers.parseEther("0.004");
    if (balEth < need + gasPad) {
        throw new Error(
            `Need ~${lpEth} ETH + gas for self-LP (have ${ethers.formatEther(balEth)})`
        );
    }
    const buyEth = Math.max(0.002, Math.round(lpEth * 0.45 * 1e6) / 1e6);
    const buyTx = await chain.buy(
        { private_key: pk, address: wallet.address },
        buyEth,
        token,
        {
            skipQuote: true,
            skipMulticall: true,
            clamp: true,
            gasLimit: 220000n,
            useProvidedFees: !!feeData,
            feeData: feeData || undefined,
            priorityMultiplier: 1,
            preflight: true,
            reserveSellGas: false,
            gasCost: ethers.parseEther("0.0002"),
        }
    );
    if (buyTx?.error) throw new Error(`LP seed buy failed: ${buyTx.error}`);
    await chain.provider.waitForTransaction(buyTx.hash, 1, 120000);

    const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
    const ethLeft = Number(
        ethers.formatEther(await chain.provider.getBalance(wallet.address))
    );
    const wrapEth = Math.min(lpEth * 0.5, Math.max(0.002, ethLeft - 0.004));
    if (wrapEth > 0.0005) {
        const tx = await weth.deposit({
            value: ethers.parseEther(String(Math.round(wrapEth * 1e6) / 1e6)),
            ...txFeeOverrides(feeData, 60000n),
        });
        await tx.wait();
    }
}

async function mintAmounts(wallet, pool) {
    let amount0 = await new ethers.Contract(pool.token0, ERC20_ABI, wallet).balanceOf(
        wallet.address
    );
    let amount1 = await new ethers.Contract(pool.token1, ERC20_ABI, wallet).balanceOf(
        wallet.address
    );
    const keep = ethers.parseEther("0.0005");
    if (pool.token0.toLowerCase() === WETH.toLowerCase() && amount0 > keep) {
        amount0 = amount0 - keep;
    }
    if (pool.token1.toLowerCase() === WETH.toLowerCase() && amount1 > keep) {
        amount1 = amount1 - keep;
    }
    return { amount0, amount1 };
}

/**
 * Seed a tight LP around spot so wash swaps rebate fees to this wallet.
 * Target: dominate in-range L (locker is full-range — tight band + enough capital wins).
 */
async function ensureSelfLp(walletData, token, options = {}) {
    const pk = walletData.private_key || walletData.privateKey;
    const wallet = new ethers.Wallet(pk, chain.provider);
    const lpEth = Number(options.lpEth || 0.25);
    // Tight default (2 steps) — more L per ETH vs locker full-range
    const widthSteps = Number(options.widthSteps || 2);
    const existingId = options.tokenId != null ? BigInt(options.tokenId) : null;
    const feeData = options.feeData || null;
    const forceRefresh = options.forceRefresh === true;
    const minShare = Number(options.minShare != null ? options.minShare : 0.55);

    const pool = await getPool(token);
    const { tickLower, tickUpper } = centeredRange(pool.tick, widthSteps);
    const npm = new ethers.Contract(NPM, NPM_ABI, wallet);

    if (existingId != null && existingId > 0n) {
        try {
            const status = await isPositionInRange(existingId);
            if (!status.dead && status.inRange && !status.nearEdge && !forceRefresh) {
                const shareInfo = await getLpShare(existingId);
                // Reuse only if share is healthy; otherwise remint tighter/deeper
                if (shareInfo.share >= minShare * 0.85) {
                    return {
                        tokenId: existingId.toString(),
                        tickLower: status.tickLower,
                        tickUpper: status.tickUpper,
                        liquidity: status.pos.liquidity.toString(),
                        pool: status.poolAddr,
                        reused: true,
                        refreshed: false,
                        tick: status.tick,
                        share: shareInfo.share,
                    };
                }
            }
            if (!status.dead) {
                await closePosition(wallet, existingId, feeData);
            }
        } catch (_) {
            // fall through to fresh mint
        }
    }

    await seedBalancesForMint(wallet, pk, token, pool, lpEth, feeData);

    let { amount0, amount1 } = await mintAmounts(wallet, pool);
    if (!(amount0 > 0n) || !(amount1 > 0n)) {
        throw new Error(
            `Self-LP needs both sides (amt0=${amount0} amt1=${amount1}) — try more lpEth`
        );
    }

    await ensureApprove(wallet, pool.token0, NPM, amount0);
    await ensureApprove(wallet, pool.token1, NPM, amount1);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const mintParams = {
        token0: pool.token0,
        token1: pool.token1,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: wallet.address,
        deadline,
    };

    const mintTx = await npm.mint(mintParams, txFeeOverrides(feeData, 650000n));
    const receipt = await mintTx.wait();

    let tokenId = null;
    const npmIface = new ethers.Interface([
        "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
        "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    ]);
    for (const log of receipt.logs || []) {
        if (String(log.address).toLowerCase() !== NPM.toLowerCase()) continue;
        try {
            const parsed = npmIface.parseLog(log);
            if (parsed?.name === "IncreaseLiquidity" || parsed?.name === "Transfer") {
                tokenId = parsed.args.tokenId ?? parsed.args[0];
            }
        } catch (_) {}
    }
    if (tokenId == null) {
        throw new Error("mint succeeded but could not parse tokenId — check wallet NFTs");
    }

    const pos = await npm.positions(tokenId);
    let share = 0;
    try {
        const s = await getLpShare(tokenId);
        share = s.share;
    } catch (_) {}

    return {
        tokenId: tokenId.toString(),
        tickLower,
        tickUpper,
        liquidity: pos.liquidity.toString(),
        pool: pool.address,
        mintHash: mintTx.hash,
        reused: false,
        refreshed: existingId != null,
        tick: pool.tick,
        share,
    };
}

async function collectLpFees(walletData, tokenId, options = {}) {
    const pk = walletData.private_key || walletData.privateKey;
    const wallet = new ethers.Wallet(pk, chain.provider);
    const npm = new ethers.Contract(NPM, NPM_ABI, wallet);
    const id = BigInt(tokenId);
    const feeData = options.feeData || null;
    const unwrap = options.unwrap !== false;

    const ethBefore = await chain.provider.getBalance(wallet.address);
    const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
    const wethBefore = await weth.balanceOf(wallet.address);

    // NPM collect does a zero-burn + pool collect — needs ~236k+ on this chain
    const tx = await npm.collect(
        {
            tokenId: id,
            recipient: wallet.address,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
        },
        txFeeOverrides(feeData, 400000n)
    );
    await tx.wait();

    let unwrapped = 0n;
    if (unwrap) {
        const wethBal = await weth.balanceOf(wallet.address);
        // Only unwrap if meaningful — skip dust unwrap txs
        if (wethBal > ethers.parseEther("0.00005")) {
            try {
                const u = await weth.withdraw(wethBal, txFeeOverrides(feeData, 55000n));
                await u.wait();
                unwrapped = wethBal;
            } catch (_) {}
        }
    }

    const ethAfter = await chain.provider.getBalance(wallet.address);
    const delta = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
    const wethAfter = await weth.balanceOf(wallet.address);
    const wethDelta = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
    return {
        hash: tx.hash,
        ethOut: Number(ethers.formatEther(delta)),
        wethOut: Number(ethers.formatEther(wethDelta + unwrapped)),
    };
}

module.exports = {
    NPM,
    FACTORY,
    POOL_FEE,
    TICK_SPACING,
    getPool,
    ensureSelfLp,
    collectLpFees,
    isPositionInRange,
    getLpShare,
    closePosition,
    centeredRange,
};
