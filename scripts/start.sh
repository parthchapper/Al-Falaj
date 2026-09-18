#!/usr/bin/env bash
# Start the whole backend: Python mission worker + Node gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_PORT="${WORKER_PORT:-8811}"
GATEWAY_PORT="${GATEWAY_PORT:-8800}"

cleanup() {
  echo ""
  echo "[start] shutting down"
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "${GATEWAY_PID:-}" ]] && kill "$GATEWAY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- worker -----------------------------------------------------------------
cd "$ROOT/worker"
if [[ ! -d .venv ]]; then
  echo "[start] creating python venv"
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

echo "[start] mission worker  -> http://127.0.0.1:$WORKER_PORT"
WORKER_PORT="$WORKER_PORT" ./.venv/bin/python -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$WORKER_PORT" --log-level warning &
WORKER_PID=$!

# --- wait for the worker ----------------------------------------------------
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$WORKER_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

# --- gateway ----------------------------------------------------------------
cd "$ROOT/gateway"
if [[ ! -d node_modules ]]; then
  echo "[start] installing node dependencies"
  npm install --silent --no-audit --no-fund
fi

echo "[start] api gateway     -> http://127.0.0.1:$GATEWAY_PORT"
WORKER_URL="http://127.0.0.1:$WORKER_PORT" GATEWAY_PORT="$GATEWAY_PORT" node src/index.js &
GATEWAY_PID=$!

echo ""
echo "  REST      http://127.0.0.1:$GATEWAY_PORT/api"
echo "  WebSocket ws://127.0.0.1:$GATEWAY_PORT/ws/telemetry"
echo "  3D module http://127.0.0.1:$GATEWAY_PORT/map3d/index.js"
echo ""
echo "  Ctrl-C to stop."

wait -n "$WORKER_PID" "$GATEWAY_PID"
