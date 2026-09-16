#!/usr/bin/env bash
# Hawa watchdog: starts Docker and the stack after a login or reboot, checks core and worker health,
# and tells the operator on Telegram when something is wrong (once per 30 minutes) and when it recovers.
#
#   bash infra/ops/watchdog.sh              # one pass (what the launch agent runs every 5 minutes)
#   bash infra/ops/watchdog.sh --status     # print the assessment only, never alert
#   bash infra/ops/watchdog.sh --announce   # send "watchdog armed" once (proves alerts reach you)
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
PROD="$ROOT/infra/docker/.env.production"; STATE_DIR="$HOME/.hawa/watchdog"; mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
STATE="$STATE_DIR/state"; COOLDOWN=1800; NOW="$(date +%s)"; MODE="${1:-}"
COMPOSE=(docker compose -f "$ROOT/infra/docker/docker-compose.prod.yml" -f "$ROOT/infra/docker/canva-release.override.yml" --env-file "$ROOT/infra/docker/.env")
last_status=""; last_alert=0; [[ -f "$STATE" ]] && source "$STATE"
save() { printf 'last_status=%q\nlast_alert=%q\n' "$1" "$2" > "$STATE"; }
notify() {
  local token chat; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2-)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" || true
}
if [[ "$MODE" == "--announce" ]]; then notify "🟢 Hawa watchdog armed on $(hostname -s): health every 5 min, self-start after login, nightly backup 03:30."; echo "announced"; exit 0; fi

problems=()
# 1. Docker daemon (Docker Desktop is not set to auto-start; the agent runs at login and starts it)
if ! docker info >/dev/null 2>&1; then
  [[ "$MODE" == "--status" ]] || open -ga Docker 2>/dev/null || true
  for _ in $(seq 1 36); do docker info >/dev/null 2>&1 && break; sleep 5; done
  docker info >/dev/null 2>&1 || problems+=("Docker is not running and could not be started")
fi
# 2. Stack containers
if [[ ${#problems[@]} -eq 0 ]]; then
  running="$(docker ps --filter name=hawa-production- --filter status=running --format '{{.Names}}' | wc -l | tr -d ' ')"
  if [[ "$running" -lt 6 ]]; then
    if [[ "$MODE" != "--status" ]]; then
      export HAWA_BUILD_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
      "${COMPOSE[@]}" up -d --no-build >/dev/null 2>&1 || problems+=("compose up failed")
      sleep 20
      running="$(docker ps --filter name=hawa-production- --filter status=running --format '{{.Names}}' | wc -l | tr -d ' ')"
    fi
    [[ "$running" -ge 6 ]] || problems+=("only ${running}/6 containers running")
  fi
fi
# 3. Core and worker health
core="$(curl -fsS -m 10 http://127.0.0.1:8080/v1/health 2>/dev/null || true)"
if [[ -z "$core" ]]; then problems+=("core health does not answer on 127.0.0.1:8080")
else
  summary="$(printf '%s' "$core" | python3 -c 'import json,sys
h=json.load(sys.stdin); d=h.get("dependencies",{}); bad={k:v for k,v in d.items() if v in ("unauthorized","unreachable","disconnected","read_only","outage","degraded","billing_exhausted")}
print(h.get("status","?")+("" if not bad else " "+json.dumps(bad)))' 2>/dev/null || echo "unparseable")"
  [[ "$summary" == healthy* ]] || problems+=("core ${summary}")
fi
worker="$(docker exec hawa-production-worker-1 node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
if [[ -z "$worker" ]]; then problems+=("worker health does not answer")
else
  wsum="$(printf '%s' "$worker" | python3 -c 'import json,sys; h=json.load(sys.stdin); print(h.get("status","?"), json.dumps(h.get("outbox",{})))' 2>/dev/null || echo "unparseable")"
  [[ "$wsum" == healthy* ]] || problems+=("worker ${wsum}")
fi

# 4. Disk and backup freshness (a full disk or a stale backup is an outage in waiting)
used="$(df -P "$ROOT" | awk 'NR==2{gsub("%","",$5); print $5}')"
[[ "${used:-0}" -lt 90 ]] || problems+=("disk ${used}% used")
newest="$(ls -t "$ROOT"/infra/backup/snapshots/hawa_*.dump 2>/dev/null | head -1 || true)"
if [[ -n "$newest" ]]; then
  age=$(( NOW - $(stat -f '%m' "$newest" 2>/dev/null || stat -c '%Y' "$newest") ))
  [[ "$age" -lt $((26 * 3600)) ]] || problems+=("newest backup is $((age / 3600)) h old")
else
  problems+=("no nightly backup found in infra/backup/snapshots")
fi

if [[ ${#problems[@]} -eq 0 ]]; then
  echo "healthy"
  [[ "$MODE" == "--status" ]] && exit 0
  [[ -n "$last_status" && "$last_status" != "healthy" ]] && notify "✅ Hawa recovered: core and worker healthy again ($(date '+%H:%M'))."
  save healthy "$last_alert"; exit 0
fi
msg="$(printf '%s; ' "${problems[@]}")"; echo "PROBLEM: $msg"
[[ "$MODE" == "--status" ]] && exit 1
if (( NOW - last_alert >= COOLDOWN )); then notify "🔴 Hawa needs attention ($(date '+%H:%M')): ${msg}"; last_alert="$NOW"; fi
save problem "$last_alert"; exit 1
