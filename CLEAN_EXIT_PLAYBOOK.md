# Clean exit vs launch funding (B7)

These are **different** playbooks. Mixing them caused the CPO cluster + ChangeNOW custody failure.

## Launch funding (before create)

Goal: buyers look unlinked on Bubblemaps.

1. Generate buyer wallets → keys in `dashboard.json`
2. Prefer **≥2 privacy hops** from bank → buyers  
   OR prepare ChangeNOW clean legs via **Prepare clean legs** (keys written to `data/legs/` **first**)
3. Run **Check Bubblemaps risk**
4. Fund only after keys are on disk
5. Create with **Hybrid** (open 8 + organic) + Uni fallback ON
6. If SSH dies after create → **Resume incomplete buyup**

## Clean exit (after you’re already clustered)

Goal: sell inventory / relocate capital — **not** “erase Bubblemaps history.”

1. Routers (1inch/Uni) **do not unlink** ancestry
2. Dump → vault on ETH is fine for cashing out
3. If using ChangeNOW again for a **new** bag:
   - `POST /api/privacy/prepare-legs` first
   - `POST /api/privacy/preflight` must pass
   - Only then create CN orders / pay
4. Record vault composition (sell proceeds vs swept pre-existing ETH) in Money Desk

## Never

- Pay a freshly generated address before keys are on disk
- Paste private keys / root passwords / API keys into chat
- Treat swept gas ETH as trading profit
