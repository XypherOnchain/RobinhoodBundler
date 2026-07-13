/**
 * Chart pattern presets — ported from stealth ChartPatterns.tsx
 * Normalized curves [t, priceNorm]; waypoints become buy/sell steps.
 */

const PATTERNS = [
    {
        id: "organic-pump",
        name: "Organic Pump",
        desc: "Gradual climb with natural dips",
        direction: "up",
        points: [
            [0, 0], [0.05, 0.08], [0.1, 0.15], [0.15, 0.12], [0.2, 0.22],
            [0.25, 0.28], [0.3, 0.25], [0.35, 0.35], [0.4, 0.42], [0.45, 0.38],
            [0.5, 0.48], [0.55, 0.55], [0.6, 0.52], [0.65, 0.62], [0.7, 0.7],
            [0.75, 0.68], [0.8, 0.78], [0.85, 0.82], [0.9, 0.88], [0.95, 0.92], [1, 1],
        ],
    },
    {
        id: "staircase",
        name: "Staircase",
        desc: "Step up, consolidate, repeat",
        direction: "up",
        points: [
            [0, 0], [0.05, 0.2], [0.1, 0.22], [0.15, 0.2], [0.2, 0.22],
            [0.25, 0.45], [0.3, 0.47], [0.35, 0.44], [0.4, 0.46],
            [0.45, 0.65], [0.5, 0.67], [0.55, 0.64], [0.6, 0.66],
            [0.65, 0.82], [0.7, 0.84], [0.75, 0.81], [0.8, 0.83],
            [0.85, 0.95], [0.9, 0.97], [0.95, 0.96], [1, 1],
        ],
    },
    {
        id: "v-recovery",
        name: "V Recovery",
        desc: "Dip then sharp bounce back",
        direction: "mixed",
        points: [
            [0, 0.8], [0.05, 0.7], [0.1, 0.55], [0.15, 0.4], [0.2, 0.25],
            [0.25, 0.15], [0.3, 0.05], [0.35, 0], [0.4, 0.05],
            [0.45, 0.15], [0.5, 0.28], [0.55, 0.4], [0.6, 0.52],
            [0.65, 0.6], [0.7, 0.7], [0.75, 0.78], [0.8, 0.85],
            [0.85, 0.9], [0.9, 0.95], [0.95, 0.98], [1, 1],
        ],
    },
    {
        id: "slow-bleed",
        name: "Slow Bleed",
        desc: "Gentle controlled decline",
        direction: "down",
        points: [
            [0, 1], [0.05, 0.96], [0.1, 0.92], [0.15, 0.9], [0.2, 0.85],
            [0.25, 0.82], [0.3, 0.78], [0.35, 0.76], [0.4, 0.7],
            [0.45, 0.65], [0.5, 0.6], [0.55, 0.55], [0.6, 0.5],
            [0.65, 0.45], [0.7, 0.38], [0.75, 0.3], [0.8, 0.25],
            [0.85, 0.18], [0.9, 0.12], [0.95, 0.06], [1, 0],
        ],
    },
    {
        id: "sawtooth",
        name: "Sawtooth",
        desc: "Repeating pump/dip cycles",
        direction: "mixed",
        points: [
            [0, 0.1], [0.05, 0.35], [0.1, 0.15], [0.15, 0.45], [0.2, 0.2],
            [0.25, 0.5], [0.3, 0.25], [0.35, 0.55], [0.4, 0.3],
            [0.45, 0.6], [0.5, 0.35], [0.55, 0.65], [0.6, 0.4],
            [0.65, 0.7], [0.7, 0.5], [0.75, 0.78], [0.8, 0.55],
            [0.85, 0.85], [0.9, 0.65], [0.95, 0.9], [1, 0.75],
        ],
    },
    {
        id: "accumulation",
        name: "Accumulation",
        desc: "Flat with micro dips — quiet support",
        direction: "mixed",
        points: [
            [0, 0.5], [0.05, 0.48], [0.1, 0.45], [0.15, 0.47], [0.2, 0.43],
            [0.25, 0.46], [0.3, 0.42], [0.35, 0.45], [0.4, 0.41],
            [0.45, 0.44], [0.5, 0.4], [0.55, 0.43], [0.6, 0.42],
            [0.65, 0.45], [0.7, 0.48], [0.75, 0.5], [0.8, 0.52],
            [0.85, 0.55], [0.9, 0.58], [0.95, 0.62], [1, 0.65],
        ],
    },
    {
        id: "breakout",
        name: "Breakout",
        desc: "Flat consolidation then explosive pump",
        direction: "up",
        points: [
            [0, 0.05], [0.05, 0.06], [0.1, 0.04], [0.15, 0.07], [0.2, 0.05],
            [0.25, 0.06], [0.3, 0.05], [0.35, 0.07], [0.4, 0.06],
            [0.45, 0.08], [0.5, 0.07], [0.55, 0.1], [0.6, 0.12],
            [0.65, 0.18], [0.7, 0.3], [0.75, 0.45], [0.8, 0.6],
            [0.85, 0.72], [0.9, 0.82], [0.95, 0.92], [1, 1],
        ],
    },
    {
        id: "double-bottom",
        name: "Double Bottom",
        desc: "W shape — classic reversal / support",
        direction: "mixed",
        points: [
            [0, 0.8], [0.05, 0.65], [0.1, 0.45], [0.15, 0.25], [0.2, 0.1],
            [0.25, 0.05], [0.3, 0.15], [0.35, 0.3], [0.4, 0.45],
            [0.45, 0.55], [0.5, 0.5], [0.55, 0.4], [0.6, 0.25],
            [0.65, 0.1], [0.7, 0.05], [0.75, 0.2], [0.8, 0.4],
            [0.85, 0.6], [0.9, 0.78], [0.95, 0.9], [1, 1],
        ],
    },
];

function getPattern(id) {
    return PATTERNS.find((p) => p.id === id) || PATTERNS[0];
}

/**
 * Build visualization waypoints then convert to server {action, sol|sellPct, delaySec}.
 */
function buildServerWaypoints(opts = {}) {
    const pattern = getPattern(opts.patternId || "organic-pump");
    const durationMin = Math.max(1, Number(opts.durationMin || 30));
    const ethPerTrade = Math.max(0.0001, Number(opts.ethPerTrade || 0.005));
    const totalMs = durationMin * 60 * 1000;
    const pts = pattern.points;
    const visual = [];

    for (let i = 1; i < pts.length; i++) {
        const [prevX, prevY] = pts[i - 1];
        const [curX, curY] = pts[i];
        const delta = curY - prevY;
        if (Math.abs(delta) < 0.01) continue;
        visual.push({
            timeOffset: curX * totalMs,
            action: delta > 0 ? "buy" : "sell",
            solAmount: ethPerTrade * Math.min(Math.abs(delta) * 5, 2),
            targetPriceNorm: curY,
        });
    }

    let prevMs = 0;
    const waypoints = visual.map((wp) => {
        const delaySec = Math.max(1, Math.round((wp.timeOffset - prevMs) / 1000));
        prevMs = wp.timeOffset;
        if (wp.action === "buy") {
            return {
                action: "buy",
                sol: Number(wp.solAmount.toFixed(6)),
                delaySec,
            };
        }
        const sellPct = Math.min(Math.round(wp.solAmount * 200), 100);
        return {
            action: "sell",
            sellPct: Math.max(5, sellPct),
            delaySec,
        };
    });

    return { pattern, waypoints, visual };
}

module.exports = { PATTERNS, getPattern, buildServerWaypoints };
