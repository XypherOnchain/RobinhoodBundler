# Safety rules (postmortem S1–S5)

1. **No outbound value** to an address whose key is not registered on disk (`lib/wallet-safety.js`).
2. ChangeNOW / Across clean cycles: **persist legs → verify file → then pay**.
3. Hop funding already persists hop keys before ETH moves — keep that invariant.
4. Job events go to `data/jobs/*.jsonl` (no private keys in logs).
5. Launch checkpoints live in `data/checkpoints/launch-*.json` for resume after disconnect.
6. Rotate any secrets that were ever pasted into chat (VPS root, ChangeNOW, 1inch, Telegram).
7. Prefer SSH keys over root password on the VPS; do not reboot mid-recovery jobs.
