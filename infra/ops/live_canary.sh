#!/usr/bin/env bash
# The nightly live canary (ADR-240): plays a fixed conversation through production's Telegram request
# path as the canary chat (scripts/live_canary.ts) and alerts the operator when the bot got anything
# wrong. The launch agent design.hawa.live-canary runs it at 03:30 (infra/ops/install_launch_agents.sh).
#
#   bash infra/ops/live_canary.sh            # one night's run
#
# It never runs during a deploy (it holds the deploy lock, infra/ops/deploy_lock.py, and skips the night
# when a deploy has it), when the load average is above HAWA_CANARY_MAX_LOAD (10), or on a host that is
# not production; it waits up to HAWA_CANARY_BACKUP_WAIT seconds (2700) for the nightly backup, which
# stops Restate for its copy, to finish. Settings come from the deployed release's .env.production:
# HAWA_CANARY_CHAT_ID, HAWA_CANARY_CLIENT_ID, HAWA_CANARY_CLIENT_NAME (HAWA_CANARY_MAX_USD optional).
# With no HAWA_CANARY_CHAT_ID there the night is skipped quietly (not configured yet).
#
# Results: ~/.hawa/logs/canary/<UTC stamp>.json and .txt, and latest.json/latest.txt. A failed night,
# and a second skipped night in a row, are sent to the operator through the watchdog's alert path
# (watchdog.sh --notify).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$ROOT/infra/ops/host_lib.sh"
source "$ROOT/infra/ops/release_lib.sh"
DEPLOY_ROOT="$(hawa_deployed_root "$ROOT")"
OUT="${HAWA_CANARY_OUT_DIR:-$HOME/.hawa/logs/canary}"
PROD="${HAWA_CANARY_ENV_FILE:-$DEPLOY_ROOT/infra/docker/.env.production}"
MAX_LOAD="${HAWA_CANARY_MAX_LOAD:-10}"
BACKUP_WAIT="${HAWA_CANARY_BACKUP_WAIT:-2700}"
MAX_MINUTES="${HAWA_CANARY_MAX_MINUTES:-60}"
STAMP="${HAWA_CANARY_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
mkdir -p "$OUT"; chmod 700 "$OUT"

notify() { bash "$DEPLOY_ROOT/infra/ops/watchdog.sh" --notify "$1" >/dev/null 2>&1 || say "the operator could not be alerted"; }
previous_status() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("status",""))
except Exception: print("")' "$OUT/latest.json"; }
# A skipped night is recorded like any other; two in a row (other than "not configured") are alerted.
skip() {
  local reason="$1" quiet="${2:-}" before now
  before="$(previous_status)"; now="$(date -u +%FT%TZ)"
  python3 - "$OUT" "$STAMP" "$now" "$reason" <<'PY'
import json, os, sys
out, stamp, now, reason = sys.argv[1:5]
result = {"v": 1, "status": "skipped", "startedAt": now, "finishedAt": now, "mode": "unknown", "checks": [], "requests": [], "spentUsd": None, "reason": reason}
text = f"Hawa nightly canary SKIPPED {now}\nReason: {reason}\n"
for name, body in ((f"{stamp}.json", json.dumps(result, indent=2) + "\n"), (f"{stamp}.txt", text), ("latest.json", json.dumps(result, indent=2) + "\n"), ("latest.txt", text)):
    tmp = os.path.join(out, f".{name}.tmp")
    with open(tmp, "w") as f: f.write(body)
    os.chmod(tmp, 0o600); os.replace(tmp, os.path.join(out, name))
PY
  say "skipped: $reason"
  if [[ -z "$quiet" && "$before" == skipped ]]; then notify "🟠 Hawa nightly canary skipped two nights in a row ($(date '+%H:%M')): ${reason}."; fi
  exit 0
}

# 1. Production only.
HOST_ROLE_RC=0; HOST_ROLE="$(hawa_host_role)" || HOST_ROLE_RC=$?
[[ "$HOST_ROLE_RC" == 0 && "$HOST_ROLE" == production ]] || skip "this host is ${HOST_ROLE:-unknown}, not production" quiet

# 2. Never during a deploy: the rest runs under the deploy lock, or the night is skipped.
if [[ "${HAWA_DEPLOY_LOCK_HELD:-}" != 1 ]]; then
  rc=0; python3 "$ROOT/infra/ops/deploy_lock.py" --wait 0 -- bash "${BASH_SOURCE[0]}" "$@" || rc=$?
  [[ "$rc" != 75 ]] || skip "a deploy holds the deploy lock"
  exit "$rc"
fi

# 3. Configured?
setting() { { grep -E "^$1=" "$PROD" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
export HAWA_CANARY_CHAT_ID="$(setting HAWA_CANARY_CHAT_ID)" HAWA_CANARY_CLIENT_ID="$(setting HAWA_CANARY_CLIENT_ID)" \
  HAWA_CANARY_CLIENT_NAME="$(setting HAWA_CANARY_CLIENT_NAME)"
max_usd="$(setting HAWA_CANARY_MAX_USD)"; [[ -z "$max_usd" ]] || export HAWA_CANARY_MAX_USD="$max_usd"
[[ -n "$HAWA_CANARY_CHAT_ID" ]] || skip "HAWA_CANARY_CHAT_ID is not set in $PROD (not configured)" quiet

# 4. Not on a loaded host: the 1-minute load average, as uptime prints it on a Mac or Linux.
load="$(uptime | sed -nE 's/.*load averages?: *([0-9]+[.,]?[0-9]*).*/\1/p' | tr ',' '.')"
if [[ -n "$load" ]] && python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) > float(sys.argv[2]) else 1)' "$load" "$MAX_LOAD"; then
  skip "the load average is ${load}, above ${MAX_LOAD}"
fi

# 5. After the nightly backup, which stops Restate and pauses intake for its copy (also at 03:30).
waited=0
while pgrep -f 'infra/backup/(nightly_backup\.sh|restate_nightly\.py)' >/dev/null 2>&1; do
  (( waited < BACKUP_WAIT )) || skip "the nightly backup was still running after ${BACKUP_WAIT} s"
  (( waited > 0 )) || say "waiting for the nightly backup to finish"
  sleep 30; waited=$((waited + 30))
done
(( waited == 0 )) || sleep "${HAWA_CANARY_AFTER_BACKUP_SECONDS:-120}"

# 6. The run, bounded.
say "canary run ${STAMP} from ${DEPLOY_ROOT}"
if [[ -n "${HAWA_CANARY_RUN:-}" ]]; then RUN=(bash -c "$HAWA_CANARY_RUN" canary)   # tests only
else RUN=("$DEPLOY_ROOT/node_modules/.bin/tsx" "$DEPLOY_ROOT/scripts/live_canary.ts" --out "$OUT" --stamp "$STAMP"); fi
rc=0
( cd "$DEPLOY_ROOT" && exec "${RUN[@]}" ) & pid=$!
# HAWA_CANARY_MAX_MINUTES bounds the whole run; a run stopped by it is a failed night, and the requests
# it left open are withdrawn first thing next night (the canary's own leftover step).
( sleep $((MAX_MINUTES * 60)); kill -TERM "$pid" 2>/dev/null ) & guard=$!
wait "$pid" || rc=$?
pkill -P "$guard" 2>/dev/null || true; kill "$guard" 2>/dev/null || true; wait "$guard" 2>/dev/null || true
if [[ "$rc" == 0 ]]; then say "passed"; exit 0; fi

summary="$(head -c 600 "$OUT/$STAMP.txt" 2>/dev/null || true)"
[[ -n "$summary" ]] || summary="it stopped (exit ${rc}) before writing a result; see ~/.hawa/logs/design.hawa.live-canary.log"
say "FAILED (exit ${rc})"
notify "🔴 Hawa nightly canary failed ($(date '+%H:%M')). ${summary}
Details: ${OUT}/${STAMP}.txt"
exit 1
