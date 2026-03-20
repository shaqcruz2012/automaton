#!/usr/bin/env bash
set -uo pipefail

# ─── Inferred Analysis — Health Check ───────────────────
# Outputs JSON health status. Exit 0 = healthy, 1 = degraded.
# Works with both Docker and bare-metal deployments.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="/var/run/inferred-analysis"

# Load .env if present
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
HEALTHY=true

# ─── Check Functions ────────────────────────────────────

check_postgres() {
  if command -v pg_isready &>/dev/null; then
    if pg_isready -q 2>/dev/null; then
      echo '"ok"'
    else
      HEALTHY=false
      echo '"down"'
    fi
  elif curl -sf "$PAPERCLIP_URL/api/health" >/dev/null 2>&1; then
    # If Paperclip is up, Postgres must be reachable
    echo '"ok (inferred via paperclip)"'
  else
    HEALTHY=false
    echo '"unreachable"'
  fi
}

check_paperclip() {
  local status
  status=$(curl -sf -o /dev/null -w '%{http_code}' "$PAPERCLIP_URL/api/health" 2>/dev/null || echo "000")
  if [[ "$status" == "200" ]]; then
    echo '"ok"'
  else
    HEALTHY=false
    echo "\"down (HTTP $status)\""
  fi
}

check_daemon() {
  # Check via PID file (bare-metal) or process scan
  local pid=""
  if [[ -f "$PID_DIR/daemon.pid" ]]; then
    pid=$(cat "$PID_DIR/daemon.pid")
  else
    pid=$(pgrep -f "node.*agents/daemon.mjs" 2>/dev/null | head -1 || true)
  fi

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "\"ok (PID $pid)\""
  else
    HEALTHY=false
    echo '"not running"'
  fi
}

check_last_experiment() {
  local results_file="$PROJECT_DIR/agents/results.tsv"
  local outputs_dir="$PROJECT_DIR/agents/outputs"

  # Try results.tsv first
  if [[ -f "$results_file" ]]; then
    local last_mod
    last_mod=$(stat -c %Y "$results_file" 2>/dev/null || stat -f %m "$results_file" 2>/dev/null || echo "0")
    local now
    now=$(date +%s)
    local age=$(( now - last_mod ))

    if [[ $age -lt 3600 ]]; then
      echo "\"ok (${age}s ago)\""
    elif [[ $age -lt 7200 ]]; then
      echo "\"stale (${age}s ago)\""
    else
      HEALTHY=false
      echo "\"expired (${age}s ago)\""
    fi
    return
  fi

  # Try latest file in outputs dir
  if [[ -d "$outputs_dir" ]]; then
    local latest
    latest=$(find "$outputs_dir" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)
    if [[ -n "$latest" ]]; then
      local last_mod
      last_mod=$(echo "$latest" | cut -d' ' -f1 | cut -d'.' -f1)
      local now
      now=$(date +%s)
      local age=$(( now - last_mod ))
      echo "\"ok (${age}s ago)\""
      return
    fi
  fi

  echo '"no experiments found"'
}

# ─── Run Checks ─────────────────────────────────────────

pg_status=$(check_postgres)
pc_status=$(check_paperclip)
daemon_status=$(check_daemon)
experiment_status=$(check_last_experiment)
timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

if $HEALTHY; then
  overall='"healthy"'
else
  overall='"degraded"'
fi

# ─── Output JSON ────────────────────────────────────────

cat <<EOF
{
  "status": $overall,
  "timestamp": "$timestamp",
  "services": {
    "postgres": $pg_status,
    "paperclip": $pc_status,
    "daemon": $daemon_status
  },
  "last_experiment": $experiment_status
}
EOF

if $HEALTHY; then
  exit 0
else
  exit 1
fi
