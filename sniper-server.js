/**
 * Dedicated sniper / pairs host — keep OFF while bundling.
 *
 *   npm run sniper          → http://localhost:3848
 *
 * Uses data/sniper.json (separate from the bundler dashboard.json).
 * Import the sniper wallet here; do not run this at the same time as
 * heavy bundler funding if you share one public RPC (rate limits).
 */
process.env.DASHBOARD_MODE = "sniper";
process.env.PORT = process.env.SNIPER_PORT || process.env.PORT || "3848";
process.env.ENABLE_SNIPER = "1";

require("./server.js");
