# NOXA Bundler Dashboard — Full Feature Guide

**Scope:** Bundler host only (`DASHBOARD_MODE=bundler` / `npm run bundler` / port **3847** / `public/index.html`).

Sniper (`:3848`) and TX Bot (`:3849`) are separate processes. This document covers everything the bundler dashboard can do.

---

## Quick start flow

```
Import funder (shared across tabs)
  → Create / import Dev + Fund Dev (per tab)
  → Create buyers → (optional) Season wallets
  → Plan buys → Apply → Preview fund → Execute fund
  → Launch from Dev + Burst/Organic buy
     OR Step 4 buy on an existing token
  → Step 5: P&L → MM sell plan → per-wallet sells
  → Recall ETH / Force restart when done
```

Multi-token: use **Token 1 / Token 2 / + New** tabs. Funder stays shared; each tab owns its own Dev, buyers, token, and plans.

---

## 1. Architecture

### Process & entry

| Item | Value |
|------|-------|
| Entry | `server.js` |
| Start | `DASHBOARD_MODE=bundler PORT=3847 node server.js` or `npm run bundler` |
| Default port | **3847** |
| UI | `public/index.html` at `/` |
| Chain | Robinhood Chain |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Launchpad | `https://fun.noxa.fi/robinhood/{token}` |

### Host modes (same codebase)

| Mode | Port | Data file | Purpose |
|------|------|-----------|---------|
| **Bundler** | 3847 | `data/dashboard.json` | Launch, fund, buy, sell, projects |
| **Sniper** | 3848 | `data/sniper.json` | Pairs feed, auto-snipe |
| **TX Bot** | 3849 | `data/txbot.json` | Volume / trend / chart MM |

Bundler startup does **not** poll pairs or run sniper exit monitors (keeps RPC free for wallet balances).

### Auth & custody

- No login, API keys, or sessions on the Express app itself.
- Private keys live in plaintext in `data/dashboard.json`.
- Protect with localhost bind, SSH tunnel, and/or reverse-proxy basic auth (e.g. Caddy).
- Treat the host as full custody of every key in the store.

### Persistence

| File | Purpose |
|------|---------|
| `data/dashboard.json` | Primary store: wallets, projects, plans, sell history, hop vault |
| `data/dashboard.backup-pre-projects-*.json` | Auto backup before first multi-project migration |

On load, legacy flat stores migrate into **`projects.token1` + `projects.token2`** with `activeProjectId: "token1"`.

### Runtime (in memory)

| Object | Role |
|--------|------|
| `job` | Single global job — one at a time (`409` if busy) |
| `fundingPreview` | Scheduled fund jobs before execute (cleared on tab switch) |
| `balanceCache` | ~45s TTL; background refresh |
| `clients` | SSE subscribers |

### Project model

- **`store.projects`** — map of tabs (`token1`, `token2`, `token3`, …)
- **`store.activeProjectId`** — current tab
- **`store.infraWallets`** — shared: funder (+ optional sniper / txbot)
- Flat working set: `store.wallets = infra + active project wallets`
- On save: sync buyers/dev/plans/token/hops into the active project
- On switch: persist current tab, then hydrate the target project

**Per-project fields:** `id`, `label`, `status` (`draft` | `live` | `archived`), `token`, `wallets[]`, `lastPlan`, `lastSellPlan`, `lastSellPreview`, `lastBuyFailures[]`, `hopVault[]`

---

## 2. Wallet roles

| Role | Scope | Purpose |
|------|-------|---------|
| **`funder`** | Shared (infra) | Treasury — funds buyers, Dev, seasoning, hop dispersal |
| **`dev`** | Per tab | Creator wallet — launches the token |
| **`buyer`** | Per tab | Bundle buy wallets |
| **`distributor`** | Optional | 2-phase funding middlemen (API only; no UI) |
| **`sniper`** | Infra (optional) | Sniper wallet — use sniper host for real sniping |
| **`txbot`** | Infra | TX bot wallet — lives on `:3849` |

### Create — `POST /api/wallets/create`

Body: `{ count, role }` — `count` default 1, max `MAX_BUNDLE_WALLETS` (500).

Role rules:

- **Funder** — demotes any existing funder to buyer
- **Dev** — one Dev per tab; replaces prior Dev on that tab
- **Sniper** — removes prior sniper
- **Buyer** — auto-named `Buyer N`; default `delaySec` ramps on create

Aliases: `creator` / `deployer` → `dev`.

### Import — `POST /api/wallets/import`

Body: `{ privateKey, role, name? }`

Validates EVM key; rejects duplicates; same single-slot rules for funder / sniper / Dev.

### Export

| Endpoint | Purpose |
|----------|---------|
| `GET /api/wallets/export.csv?roles=all` | CSV of keys (UI: **Export keys CSV**) |
| `GET /api/wallets/:index/pk` | Single private key (UI: **Key**) |

CSV columns: `index`, `role`, `name`, `address`, `private_key`, `buyAmountEth`, `delaySec`, `seasoned`

### Edit / delete

| Endpoint | Purpose |
|----------|---------|
| `PATCH /api/wallets/:index` | `{ name?, buyAmountEth?, delaySec?, role? }` |
| `DELETE /api/wallets/:index` | Remove wallet |

### Clear buyers / Force restart — `POST /api/wallets/clear-buyers`

Active tab only:

- Removes **buyer** wallets
- Keeps funder, Dev, sniper, txbot
- Clears plan, sell plan/preview, token, buy failures, hop vault
- Sets project `status: "draft"`

UI: **Remove all buyers**, **Force restart** (double confirm). Other tabs are untouched.

### Recall ETH — `POST /api/recall`

- Default roles: `buyer`, `distributor`
- Unwraps WETH, sweeps ETH minus gas reserve → funder
- Body: `{ roles?, unwrapWeth?: true, gasReserveEth?: 0.0002 }`
- UI: **Recall ETH → funder** (Steps 1 & 5)

### Recover stuck hops

| Endpoint | Purpose |
|----------|---------|
| `GET /api/recover/hops` | List hop vault entries + balances |
| `POST /api/recover/hops` | Sweep hop keys → funder (`onlyPending?`, `gasReserveEth?`) |

### Fund Dev — `POST /api/dev/fund` (bundler-only)

- Body: `{ amountEth }` — clamped **0.005–5 ETH**, default **0.05**
- UI prompt default **~0.08 ETH**
- Sends from funder → Dev on the active tab

---

## 3. Multi-project tabs

### Defaults

- Migration creates **Token 1** + **Token 2**
- **+ New** creates `token{N}` (or timestamped id) as an empty draft

### Shared vs per-tab

| Shared | Per-tab |
|--------|---------|
| Funder | Dev wallet |
| Sniper / txbot (if present) | Buyer wallets |
| Global sell history (filterable) | Token / lastToken |
| | Plans, sell plans, buy failures, hop vault |
| | Project status & label |

### Tab API

| Method | Path | Body |
|--------|------|------|
| GET | `/api/projects` | — |
| POST | `/api/projects` | `{ label? }` |
| POST | `/api/projects/switch` | `{ projectId }` |
| PATCH | `/api/projects/:id` | `{ label?, status? }` |

Tab bar shows label, buyer count, and short token (or “no token”). If a job is running on another tab, a banner warns that the current view is read-only for that job.

---

## 4. Launch from Dev

Visible on **Steps 1 & 2** (`#stepLaunch`).

### Preconditions

1. Funder imported  
2. Dev created/imported and funded  
3. Buyers planned + funded (if buying after launch)

### UI fields

| Field | Default |
|-------|---------|
| Name / Symbol | required |
| Dev buy (ETH) | **0.02** (min 0.001; API max 2) |
| After launch | **Burst** or **Organic** |
| Buy right after | checked |
| Image URI, Twitter, Website, Telegram | optional |

Buttons: **Launch + buy** · **Launch only**

### API — `POST /api/launch`

```json
{
  "name": "My Token",
  "symbol": "TICKER",
  "metadataURI": "",
  "description": "",
  "twitter": "",
  "telegram": "",
  "website": "",
  "discord": "",
  "devBuyEth": 0.02,
  "buyAfter": true,
  "buyMode": "burst",
  "organicPaceSec": 10,
  "organicQuietSec": 12,
  "organicMaxDipPct": 0.15,
  "organicSellPct": 25,
  "foreignMinEth": 0.008,
  "concurrency": 12,
  "staggerMs": 35
}
```

### Flow

1. Job type `launch`
2. `launchToken(dev)` — factory create + creator buy in the same tx
3. Saves token; project → `live`
4. Optional post-buy via `multiBuy`:
   - **Burst** — fast pipeline; react policy available on launch path
   - **Organic** — paced buys + MC-capped soft-sells
5. SSE: `launched`, `job_done`

Why this exists: launching from the public launchpad gets sniped; waiting for them to dump costs time and chart quality. Dev launch + immediate buy keeps the first fills under your control.

---

## 5. Buy planning (Step 2)

### UI defaults

| Field | Default |
|-------|---------|
| Total ETH | **0.2** |
| # Wallets | **4** (UI max 500) |
| Start % shape | **0.4** |
| End % shape | **1.2** |
| Seconds between buys | **0** |

### Build plan — `POST /api/plan`

Body: `{ token, totalEth, walletCount, baseDelaySec?, startPctSupply?, endPctSupply? }`

Algorithm (`buildBuyPlan`):

- Splits **100% of Total ETH** across N wallets with a ramp shape (small → large)
- Start/end % are shape only (capped at 10% each for shaping)
- Simulates rising MC (quoter for N≤50, else bonding-style)
- Returns rows: `eth`, `delaySec`, `tokensEst`, warnings
- Persists `lastPlan` + `lastToken`

Also loads token meta via `GET /api/token/:address` (symbol, MC, supply, max wallet 2%).

### Apply plan — `POST /api/plan/apply`

- Creates missing buyers up to plan count
- Writes `buyAmountEth` + `delaySec`
- Renames `Buyer 1…N`
- Clears amounts on extra buyers beyond the plan

### Alternate allocator (API only)

`POST /api/allocate` — `{ totalEth, mode?: "ramp"|"even"|"variance", variancePct?, baseDelaySec? }` on **existing** buyers.

---

## 6. Funding (Step 3)

### Gas buffers

| Constant | Default | Meaning |
|----------|---------|---------|
| `BUYER_GAS_BUFFER_ETH` | **0.002** | Extra ETH per buyer beyond buy size |
| `HOP_GAS_RESERVE_ETH` | **0.0005** | Left on each hop wallet |

Each buyer is funded: **`buyAmountEth + BUYER_GAS_BUFFER_ETH`**

### Privacy hops

| Choice | Notes |
|--------|-------|
| **2** | Default / recommended |
| 1 | Weaker privacy, faster |
| 3 | Stronger, slower |

### Preview + execute (UI path)

1. **`POST /api/fund/preview`**
   - `{ hops?, useDistributors?: false, skipFunded?: true }`
   - Skips buyers already ≥ ~85% funded
   - Builds job list (funder → dest; optional distributor phase)

2. **`POST /api/fund/execute`**
   - Requires preview
   - `{ onlyRemaining?, hops? }`
   - Pause / resume / cancel mid-run
   - Saves hop keys to `hopVault` for recovery

### Controls

| Button | API |
|--------|-----|
| Preview | `/api/fund/preview` |
| Send funds | preview (if needed) + `/api/fund/execute` |
| Continue funding | rebuild preview (skip funded) + execute |
| Pause | `/api/fund/pause` |
| Resume | `/api/fund/resume` |
| Stop | `/api/fund/cancel` |

Pause finishes the current wallet, then holds.

### Legacy / advanced

- `POST /api/fund` — immediate disperse (UI uses preview/execute instead)
- `POST /api/distributors/create` — create middlemen for 2-phase funding (API only)

---

## 7. Seasoning (Step 1)

Makes buyer wallets look used before a bundle (not brand-new).

### UI

| Control | Default |
|---------|---------|
| Intensity | Medium (~8 txs) — also Light (~4), Heavy (~12) |
| Budget / wallet | **0.008 ETH** |
| Button | **Season wallets** |

### API — `POST /api/season`

```json
{
  "intensity": "medium",
  "budgetEth": 0.008,
  "recallLeftover": true,
  "onlyUnseasoned": true
}
```

Per wallet:

1. Fund from funder if balance &lt; budget  
2. Shuffled activity: wrap/unwrap WETH, dust transfers, WETH approve router  
3. Recall leftover → funder (keeps a tiny gas pad)  
4. Marks `seasoned: true`, `seasonTxCount`, `seasonedAt`

Job type: `season`.

---

## 8. Buy modes (Step 4)

### Modes

| Mode | Behavior |
|------|----------|
| **Burst** | Pipeline (~12 in-flight); all buyers fire fast |
| **Organic** | One-at-a-time paced buys; tape-aware soft-sells |
| **Sequential** | Honors per-wallet `delaySec` from the plan |

### Shared options

| Field | Default | Notes |
|-------|---------|-------|
| In-flight txs | **12** (6–16) | Burst only |
| Slippage % | **8** | Sent as `slippageBps` |
| If outsider buys in | **bump** | Burst only |
| Min foreign ETH | **0.008** | Ignore dust outsiders |

### Burst foreign-buy policies

| Policy | Behavior |
|--------|----------|
| **`bump`** | Raise priority tip, keep buying (default in UI) |
| **`log`** | Log only, keep buying |
| **`pause`** | Stop remaining buys |
| **`react`** | Dump filled wallets 100%, then continue |

### Organic options

| Field | Default | Range |
|-------|---------|-------|
| Pace (sec) | **10** | 2–120 (+ jitter) |
| Max chart dip % | **15** | **10–20** (hard clamp) |
| Quiet after (sec) | **12** | 4–120 |
| Soft-sell % / bag | **25** | 8–50 |

**Organic loop:**

1. Buy slowly (one wallet, paced gaps)  
2. Foreign buy detected → **pause** buys  
3. Soft-sell into them from filled bags (partial %, largest bags first)  
4. Cap estimated impact at max dip % of **live MC** (Uniswap quoter)  
5. Wait until tape is quiet for N seconds  
6. Resume buying up  

Organic forces `foreignBuyPolicy: "organic"` — no full dumps.

### API — `POST /api/buy`

```json
{
  "token": "0x…",
  "mode": "burst",
  "concurrency": 12,
  "slippageBps": 800,
  "priorityMultiplier": 1.6,
  "tapeGuard": true,
  "foreignBuyPolicy": "bump",
  "foreignMinEth": 0.008,
  "retries": 3,
  "buyTimeoutMs": 18000,
  "staggerMs": 35,
  "organicPaceSec": 10,
  "organicPaceJitterSec": 6,
  "organicQuietSec": 12,
  "organicMaxDipPct": 0.15,
  "organicSellPct": 25,
  "onlyFailed": false,
  "addresses": []
}
```

Also:

- **Retry failed** — `onlyFailed: true` using `lastBuyFailures`
- **Cancel** — `POST /api/buy/cancel` (also aborts launch+buy)
- Auto gas clamp: shrink buy ~3–6% and tip-bump on retries

---

## 9. Sell & MM advice (Step 5)

### Chart

- DexScreener embed (Robinhood): **Load chart** / **Reload**
- External: `https://dexscreener.com/robinhood/{token}`

### Live tape

`GET /api/tape/:address` — swaps, OHLC, flow, regime, urgency (`analyzeMarketTape`)

### Sell controls

| Field | Default |
|-------|---------|
| Bulk % | **100** |
| Mode | **parallel** or sequential |
| Sell order strategy | **auto** |
| Target MC $ | **1,000,000** |

**Strategies:** `auto`, `least_impact` / `smallest_first`, `largest_first`, `best_pnl_first`, `worst_pnl_first`

### What the sell plan gives you

- Profit maximizer headline + tape regime  
- Live MC, supply held, spent, dump-all worth  
- **Sell NOW (safe)** list with MC impact per row  
- Profit ladder toward target MC  
- Full exit order (sequential impact simulation)  
- Net flow / dump haircut guidance  

Sticky until Force restart or manual rebuild. Never auto-sells from the plan — you click.

### Sell APIs

| Endpoint | Purpose |
|----------|---------|
| `POST /api/sell/preview` | Position rows, alone vs dump quotes |
| `POST /api/sell/plan` | Full MM recommendations |
| `POST /api/sell` | Bulk sell (`percent`, `mode`, `walletOrder`, …) |
| `POST /api/sell/one` | Single wallet % sell |
| `POST /api/sell/history/clear` | Clear history |

Per-wallet UI buttons: **5 / 10 / 25 / 50 / 100%**.

### Sell history

- Up to **500** entries; last **80** in `/api/state`
- Running cumulative profit USD/ETH per token
- Table: when, wallet, %, got, cost, profit, running profit, tx link

---

## 10. Complete API reference (bundler)

### Core

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Dashboard UI |
| GET | `/api/state` | Full state (`?refresh=1` / `?balances=1`) |
| GET | `/api/events` | SSE stream |
| POST | `/api/balances/refresh` | Kick balance sweep |

### Projects

| Method | Path |
|--------|------|
| GET | `/api/projects` |
| POST | `/api/projects` |
| POST | `/api/projects/switch` |
| PATCH | `/api/projects/:id` |

### Wallets

| Method | Path |
|--------|------|
| POST | `/api/wallets/create` |
| POST | `/api/wallets/import` |
| PATCH | `/api/wallets/:index` |
| DELETE | `/api/wallets/:index` |
| POST | `/api/wallets/clear-buyers` |
| GET | `/api/wallets/export.csv` |
| GET | `/api/wallets/:index/pk` |

### Dev & launch

| Method | Path |
|--------|------|
| POST | `/api/dev/fund` |
| POST | `/api/launch` |

### Token intel

| Method | Path |
|--------|------|
| GET | `/api/token/:address` |
| GET | `/api/token/:address/intel` |
| GET | `/api/creator/:address` |
| GET | `/api/tape/:address` |

### Plan & fund

| Method | Path |
|--------|------|
| POST | `/api/plan` |
| POST | `/api/plan/apply` |
| POST | `/api/allocate` |
| POST | `/api/distributors/create` |
| POST | `/api/fund` |
| POST | `/api/fund/preview` |
| POST | `/api/fund/execute` |
| POST | `/api/fund/pause` |
| POST | `/api/fund/resume` |
| POST | `/api/fund/cancel` |

### Buy / season / recall

| Method | Path |
|--------|------|
| POST | `/api/buy` |
| POST | `/api/buy/cancel` |
| POST | `/api/season` |
| POST | `/api/recall` |
| GET | `/api/recover/hops` |
| POST | `/api/recover/hops` |

### Sell

| Method | Path |
|--------|------|
| POST | `/api/sell/preview` |
| POST | `/api/sell/plan` |
| POST | `/api/sell` |
| POST | `/api/sell/one` |
| POST | `/api/sell/history/clear` |

### Present but degraded / elsewhere

- Sniper routes (`/api/pairs`, `/api/snipe/*`, `/api/sniper/*`) — stubs or forced-off on bundler; use `:3848`
- TX / volume / trend / MM (`/api/txbot/*`, `/api/volume/*`, `/api/trend/*`, `/api/mm/*`) — **404** on bundler; use `:3849`

---

## 11. Jobs, SSE, logging

### Single job

Only one job at a time. Types: **`fund`**, **`buy`**, **`launch`**, **`season`**, **`sell`**, **`recall`**.

Carries: `running`, `type`, `logs[]` (cap 200; public last 80), `result`, `progress`, `pause` / `paused`, `abort`, `projectId`, `projectLabel`.

### SSE — `GET /api/events`

| Event | Meaning |
|-------|---------|
| `hello` | Initial job snapshot |
| `log` | New log line |
| `progress` | Progress bar update |
| `job_done` | Job finished |
| `balances` | Progressive balance updates |
| `funding_preview` | Preview ready |
| `fund_paused` | Funding paused |
| `wallets` | Wallet list changed (e.g. after season) |
| `launched` | Token created |
| `sell_history` | Sell ledger update |

Logs also go to stdout (visible in PM2).

### UI log panes

Buy → `#logBuy` · Fund → `#logFund` · Season → `#logSeason` · Sell/Recall → `#logSell` / `#logRecall` · Launch → `#logLaunch`

---

## 12. Safety & limits

| Limit | Value |
|-------|-------|
| Max buyers | **500** |
| Buy in-flight | **6–16** (default 12) |
| Buy retries | **1–6** (burst default 3) |
| Buy timeout | default **18s** (min 8s) |
| Organic MC dip | **10–20%** (default 15%) |
| Dev buy on launch | **0.001–2 ETH** |
| Dev fund | **0.005–5 ETH** |
| Privacy hops | **1–3** |
| Distributors | **1–10** |
| Sell history | **500** entries |
| Balance RPC | 6 parallel, ~40ms gap |
| Balance cache | ~45s |
| Job exclusivity | one at a time |
| Cancel / pause | finish current wallet, then stop/hold |
| Sniper on bundler | `enabled` + `autoSell` forced **false** at boot |
| Max wallet (NOXA) | **2%** of supply |

---

## 13. UI map (step by step)

Header: **1. Wallets → 2. Plan → 3. Fund → 4. Buy → 5. Sell**

Overview bar: funder, buyer count, budget ETH, token.

### Step 1 — Wallets

Import funder · Create/Import/Fund Dev · Create buyers · Remove buyers · Refresh balances · Export CSV · Recall ETH · Recover hops · Force restart · Season wallets · Launch card

### Step 2 — Plan (+ Launch)

Build plan · Save plan to wallets · Launch card still visible

### Step 3 — Fund

Preview · Send funds · Continue · Pause / Resume / Stop

### Step 4 — Buy

Mode (burst / organic / sequential) · Start · Retry failed · Cancel

### Step 5 — Sell / MM

DexScreener · Refresh P&L · Build recommendations · Per-wallet % sells · Sell history · Recall · Force restart

---

## 14. Other features

### Hop vault

Hop private keys saved during funding. Status: pending / delivered / recovered / empty. Recover sweeps stranded hops back to funder.

### Balance refresh

Auto ~every 25s on steps 1/2/4/5 when idle. SSE streams updates. `lastBalance` persisted so UI doesn’t blank after restart.

### Telegram

`npm run telegram` → separate `bot.js` using `data/wallets.json`. **Not** wired to the bundler dashboard. Launch form “Telegram” is on-chain metadata only.

### Deploy notes

- PM2 app: `noxa-bundler` on **3847**
- Tunnel: `ssh -L 3847:127.0.0.1:3847 …`
- Related: sniper `:3848`, txbot `:3849`

### Key `blockchain.js` pieces used by bundler

`generateWallet`, `buildBuyPlan`, `allocateSplits`, `disperseWithHops`, `multiBuy`, `multiSell`, `launchToken`, `seasonWallets`, `buildSellPlan`, `estimatePositions`, `analyzeMarketTape`, `recallEth`, `getTokenInfo`, `resolveLiveMarketCap`, `MAX_BUNDLE_WALLETS`, `BUYER_GAS_BUFFER_ETH`, `HOP_GAS_RESERVE_ETH`, `NOXA_*` constants

---

## 15. Money Desk (USD, plain English)

Top nav **Money** tab. Module: `money-desk.js`.

| Feature | Behavior |
|---------|----------|
| Treasury reserve lock | Min $ + min %; LP/marketing/gas/emergency set-asides; **blocks** fund/launch if broken |
| True net profit | Gross − gas − failed − infra − LP loss − marketing − slip + LP fees |
| Break-even MC | Deployed / recovered / held % → BE, 1.5×, 2×, 3× |
| Profit ladder | Approve → Turn on; MC rungs; no auto-sell until approved |
| Kill switch | Emergency stop + floors (funder, drawdown, daily loss, failed-tx) |
| Launch readiness | Checklist + 0–100 score; green-leaf runway; blocks launch if red |
| LP capital | Separate from operating capital (cannot fund buys) |
| Position sizing | Warns if requested > prudent vs liquidity |
| Exit simulator | Paper bag vs realistic partial/full exit |
| Portfolio risk | All tabs aggregated |
| Post-launch review | Saved report per project |
| RPC health | Latency on refresh |

**APIs:** `GET /api/money`, `POST /api/money/config`, `POST /api/money/expense`, `POST /api/money/kill`, `POST /api/money/ladder`, `POST /api/money/capital`, `POST /api/money/review`, `GET /api/money/rpc-health`

**Gates:** `/api/launch`, `/api/fund/execute`, `/api/buy` (kill switch)

---

## 16. Campaign factory & parallel jobs

**Files:** `job-queue.js`, `campaign-engine.js`

### Per-project job queue
- Multiple projects can run at once (`maxConcurrent`, default 3)
- Stages: `QUEUED → PREFLIGHT → FUNDING → LAUNCHING → BUYING → MONITORING → EXITING → RECALLING → COMPLETE`
- Monitoring one token does **not** block launching another
- Pause / resume whole queue

### Batch campaigns
| API | Purpose |
|-----|---------|
| `POST /api/campaigns` | Create 1–100 tests (optional parameter matrix) |
| `POST /api/campaigns/start` | Enqueue & run |
| `POST /api/campaigns/pause` | Pause |
| `POST /api/campaigns/resume` | Resume |
| `GET /api/campaigns` | List + command center |
| `GET /api/campaigns/:id` | Detail |
| `POST /api/campaigns/matrix` | Preview combo count |
| `GET /api/queue` | Live queue snapshot |

### Closed loop
Generate → fund → launch → buy → monitor (exit rules) → sell → recall to funder → score → rank → Bayesian next-config → next test.

Includes: capital recycle snapshot, shadow strategies (paper), ranking metrics, command-center KPIs (profit per ETH, win rate — not tx count).

**UI:** top nav **Campaigns**.

### Not fully built yet (scaffolded / next)
Exact NOXA curve simulator, sub-second WebSocket market service, synthetic agents, reusable wallet pool UI, full LP remove automation.

---

## Related dashboards (not this doc)

| Dashboard | Port | Use for |
|-----------|------|---------|
| Sniper | 3848 | New pairs, auto-snipe, sniper portfolio |
| TX Bot | 3849 | Tx count, volume, trend, automated chart MM |

---

*Generated from the live bundler codebase (`server.js`, `public/index.html`, `blockchain.js`). Update this file when adding major features.*
