#!/usr/bin/env bash
# Keep the NOXA sniper host alive on :3848.
# Usage:  ./scripts/keep-sniper.sh
# Or:     npm run sniper:keep
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${SNIPER_LOG:-/tmp/noxa-sniper.log}"
PORT="${SNIPER_PORT:-3848}"

echo "[keep-sniper] project=$ROOT port=$PORT log=$LOG"
echo "[keep-sniper] open http://127.0.0.1:${PORT}"

while true; do
  # Free the port if a dead/orphan listener is stuck
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "[keep-sniper] $(date '+%H:%M:%S') port $PORT already in use — assuming healthy"
    # If something else owns it, wait and recheck
    sleep 5
    if curl -sf --connect-timeout 2 "http://127.0.0.1:${PORT}/api/snipe/config" >/dev/null; then
      sleep 10
      continue
    fi
    echo "[keep-sniper] port up but API dead — killing listener"
    PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      # shellcheck disable=SC2086
      kill $PIDS 2>/dev/null || true
    fi
    sleep 1
  fi

  echo "[keep-sniper] $(date '+%H:%M:%S') starting sniper-server.js …"
  # Run in foreground of this loop so we restart on crash/exit
  node sniper-server.js >>"$LOG" 2>&1 || true
  code=$?
  echo "[keep-sniper] $(date '+%H:%M:%S') sniper exited code=$code — restarting in 2s"
  sleep 2
done
