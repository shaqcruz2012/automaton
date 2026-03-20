#!/usr/bin/env bash
set -euo pipefail

# ─── Inferred Analysis — Bare-Metal Startup ─────────────
# Starts all services without Docker. Intended for VPS / on-prem.
# Logs go to /var/log/inferred-analysis/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="/var/log/inferred-analysis"
PID_DIR="/var/run/inferred-analysis"

# Load .env if present
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"

# ─── Setup ───────────────────────────────────────────────

mkdir -p "$LOG_DIR" "$PID_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/start.log"
}

cleanup() {
  log "Shutting down..."
  for pidfile in "$PID_DIR"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "Stopped PID $pid ($(basename "$pidfile" .pid))"
    fi
    rm -f "$pidfile"
  done
  exit 0
}
trap cleanup SIGINT SIGTERM

# ─── 1. PostgreSQL ───────────────────────────────────────

log "Checking PostgreSQL..."
if command -v pg_isready &>/dev/null; then
  if ! pg_isready -q 2>/dev/null; then
    log "Starting PostgreSQL..."
    if command -v systemctl &>/dev/null; then
      sudo systemctl start postgresql
    elif command -v pg_ctl &>/dev/null; then
      pg_ctl start -D /var/lib/postgresql/data -l "$LOG_DIR/postgres.log"
    else
      log "ERROR: Cannot start PostgreSQL — no systemctl or pg_ctl found"
      exit 1
    fi
    sleep 2
  fi
  log "PostgreSQL is ready"
else
  log "WARNING: pg_isready not found — assuming PostgreSQL is managed externally"
fi

# ─── 2. Paperclip Server ────────────────────────────────

log "Starting Paperclip server..."
if command -v paperclip-server &>/dev/null; then
  SERVE_UI=true \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  DATABASE_URL="${DATABASE_URL:-postgres://paperclip:paperclip@localhost:5432/paperclip}" \
    paperclip-server \
    >> "$LOG_DIR/paperclip.log" 2>&1 &
  echo $! > "$PID_DIR/paperclip.pid"
  log "Paperclip started (PID $(cat "$PID_DIR/paperclip.pid"))"
else
  log "ERROR: paperclip-server binary not found in PATH"
  exit 1
fi

# Wait for Paperclip to be healthy
log "Waiting for Paperclip to become healthy..."
for i in $(seq 1 30); do
  if curl -sf "$PAPERCLIP_URL/api/health" >/dev/null 2>&1; then
    log "Paperclip is healthy"
    break
  fi
  if [[ $i -eq 30 ]]; then
    log "ERROR: Paperclip failed to start within 30s"
    exit 1
  fi
  sleep 1
done

# ─── 3. Bootstrap Org ───────────────────────────────────

log "Bootstrapping org chart..."
cd "$PROJECT_DIR"
node scripts/bootstrap-org.mjs "$PAPERCLIP_URL" >> "$LOG_DIR/bootstrap.log" 2>&1 || {
  log "WARNING: Org bootstrap returned non-zero (may already exist)"
}
log "Org bootstrap complete"

# ─── 4. Research Daemon ──────────────────────────────────

log "Starting research daemon..."
cd "$PROJECT_DIR"
node agents/daemon.mjs --paperclip-url "$PAPERCLIP_URL" \
  >> "$LOG_DIR/daemon.log" 2>&1 &
echo $! > "$PID_DIR/daemon.pid"
log "Daemon started (PID $(cat "$PID_DIR/daemon.pid"))"

# ─── 5. Notifier ────────────────────────────────────────

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  log "Starting notifier (Telegram, 15-min interval)..."
  cd "$PROJECT_DIR"
  node agents/notify.mjs --telegram --watch 900 \
    >> "$LOG_DIR/notifier.log" 2>&1 &
  echo $! > "$PID_DIR/notifier.pid"
  log "Notifier started (PID $(cat "$PID_DIR/notifier.pid"))"
else
  log "Skipping notifier — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set"
fi

# ─── Keep Alive ─────────────────────────────────────────

log "All services running. Waiting for signals..."
wait
