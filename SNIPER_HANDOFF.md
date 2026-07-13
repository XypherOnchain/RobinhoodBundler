# Sniper bot handoff (for a new agent)

**Do not touch the bundler/TX bot on :3847 unless the user asks.**  
Work only on the **sniper host** (`:3848`) and related files.

## How to run

```bash
cd /Users/andrewjayyosi/Downloads/noxa-robinhood-bot
npm run sniper   # → http://localhost:3848 · store data/sniper.json
```

Bundler (separate process, leave alone):

```bash
npm run bundler  # → http://localhost:3847 · store data/dashboard.json
```

Entry: `sniper-server.js` sets `DASHBOARD_MODE=sniper`, `PORT=3848`, `ENABLE_SNIPER=1`, then loads `server.js`.

## Key files

| Path | Role |
|------|------|
| `sniper-server.js` | Sniper process entry |
| `server.js` | Pairs poll, auto-snipe, exits, APIs (sniper host only for pairs) |
| `blockchain.js` | `fetchOnChainLaunches`, `listNewestTokens`, `snipeBuy`, logos |
| `public/sniper.html` | **Dedicated** sniper UI (served as `/` on :3848) |
| `public/index.html` | Bundler UI only (no pairs tab) |
| `data/sniper.json` | Sniper wallet + `snipeConfig` |

## Current live state (as of handoff)

- UI: http://localhost:3848 → `sniper.html` (title **NOXA Sniper**)
- Feed: on-chain factory + API merge (`chain+api`), ~60 pairs, poll ~3s
- Incremental `getLogs` + meta/block caches to avoid RPC 429s
- Logos: IPFS via Cloudflare; backfill via `enrichPairLogos()`; placeholder until indexed
- Fresh rows: green highlight (`pair-fresh` / `freshAddrs` SSE)

### Sniper wallet

- Address: `0x58e4B4596AF90aF419122dAD34657eF915D1237d`
- Role: `sniper` in `data/sniper.json`
- Balance was ~0.11 ETH (verify live)

### Profitable defaults in `snipeConfig`

```json
{
  "enabled": false,
  "autoSell": true,
  "amountEth": 0.003,
  "takeProfitX": 1.5,
  "takeProfit2X": 2.5,
  "partialSellPct": 60,
  "stopLossPct": 25,
  "trailPct": 18,
  "maxAgeSec": 120,
  "maxInitialBuyEth": 0.35,
  "maxOpenPositions": 12,
  "cooldownMs": 800,
  "skipSerialCreators": true
}
```

- **Auto-snipe OFF** until user arms it (Save strategy with Auto-snipe ON)
- **Auto-exits ON** (TP1 bank 60% @ 1.5×, TP2 2.5×, trail 18%, SL −25%)
- Up to **3** auto-snipes per poll tick; skip serial creators; skip fat creator buys &gt; 0.35 ETH
- Sniper host **preserves** `enabled` across restarts (bundler host still forces off)

## Important APIs

- `GET /api/state`, `GET /api/pairs`, `GET /api/events` (SSE)
- `POST /api/snipe`, `/api/snipe/config`, `/api/snipe/stop`
- `POST /api/sniper/sell`, `/api/sniper/portfolio`, `/api/sniper/reset`, `/api/sniper/fund`, `/api/sniper/recall`
- Wallet create/import with `role: "sniper"`

## Known gaps / next work

1. Brand-new chain tokens often lack logos until NOXA/IPFS indexes them
2. On-chain rows start with `initialBuyEth=0` until API merge — filter weaker for seconds
3. No mempool / block-0 listener (poll-based only)
4. Exit MC: prefers API, falls back to Uniswap quoter via `resolveLiveMarketCap` when API 404s
5. Public RPC rate limits if poll + enrichment too aggressive
6. `sniper.html` still contains leftover bundler JS stubs (guarded with `if($(...))`) — can trim later

## Fix (2026-07-09): open bags / PnL / `t is not defined`

**Symptoms:** UI showed no open trades / broken PnL; console `t is not defined`; exits logged SL with no sell tx / profit.

**Causes:**
1. `renderSnipeHistory` referenced undefined `t` → crashed portfolio/history render
2. `snipeBuy` returned `ok` on broadcast without waiting for receipt — many buys **reverted** (`status=0`) but were treated as fills
3. Exit monitor then saw 0 tokens → fake `sold` + `−100%` PnL with no `sellHash`

**Fixes:**
- UI: history row uses `s.token` (not `t`); portfolio load isolated from render crashes
- `snipeBuy` waits for receipt + verifies token balance before `ok`
- Exit path demotes reverted buys instead of fake full losses; repair on boot demotes historical fakes
- Portfolio open bags = on-chain balance only; realized PnL requires `sellHash`

Hard-refresh http://127.0.0.1:3848 after restart.

## Factory / chain constants

- Chain ID: 4663 (Robinhood)
- Launch factory: `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB`
- Topic: `0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a`
- RPC: `https://rpc.mainnet.chain.robinhood.com`

## User intent

Build a **profitable** sniper: track every new pair with images when possible, tight filters, auto-exits. Keep sniper dashboard **separate** from bundler/TX bot.
