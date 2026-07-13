#!/usr/bin/env bash
# Copy app + data to a VPS. Usage:
#   ./scripts/push-to-server.sh user@YOUR_SERVER_IP
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 user@SERVER_IP"
  echo "Example: $0 root@203.0.113.10"
  exit 1
fi

REMOTE_DIR="${REMOTE_DIR:-/opt/noxa}"

echo "==> Backing up data locally first…"
bash "$ROOT/scripts/backup-data.sh"

echo "==> Creating $REMOTE_DIR on $TARGET…"
ssh "$TARGET" "sudo mkdir -p $REMOTE_DIR && sudo chown \$(whoami):\$(whoami) $REMOTE_DIR"

echo "==> Syncing app (code)…"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude '*.log' \
  --exclude 'data/' \
  "$ROOT/" "$TARGET:$REMOTE_DIR/"

echo "==> Syncing data/ (wallets — private keys)…"
rsync -avz "$ROOT/data/" "$TARGET:$REMOTE_DIR/data/"

echo "==> Done. Next, SSH in and run:"
echo "  ssh $TARGET"
echo "  cd $REMOTE_DIR && bash scripts/server-setup.sh"
