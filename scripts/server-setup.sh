#!/usr/bin/env bash
# Run ON the VPS after push-to-server.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Node.js…"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> npm install…"
npm install --omit=dev

echo "==> pm2…"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

echo "==> Start bots…"
pm2 delete ecosystem.config.cjs 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
echo ""
echo "Enable boot start (run the command pm2 prints):"
pm2 startup || true

echo ""
echo "Bots listening locally on the server:"
echo "  bundler  http://127.0.0.1:3847"
echo "  sniper   http://127.0.0.1:3848"
echo "  txbot    http://127.0.0.1:3849"
echo ""
echo "From your Mac, tunnel in (safest — no public dashboards):"
echo "  ssh -N -L 3847:127.0.0.1:3847 -L 3848:127.0.0.1:3848 -L 3849:127.0.0.1:3849 USER@SERVER"
echo "Then open http://localhost:3847 on your Mac."
echo ""
echo "Or install Caddy + point a domain — see DEPLOY.md"
pm2 status
