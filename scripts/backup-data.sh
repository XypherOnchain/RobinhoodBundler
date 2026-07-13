#!/usr/bin/env bash
# Backup wallet stores (private keys!) — keep this folder OFF cloud sync if possible.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${1:-$HOME/noxa-backups/noxa-data-$STAMP}"
mkdir -p "$DEST"
cp -a "$ROOT/data/." "$DEST/"
echo "Backed up data/ → $DEST"
ls -la "$DEST"
echo ""
echo "Keep this private. Do not commit or email it."
