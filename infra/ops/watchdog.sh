#!/usr/bin/env bash
# Hawa watchdog: starts Docker and the stack after a login or reboot, checks core and worker health,
# and tells the operator on Telegram when something is wrong (once per 30 minutes) and when it recovers.
# A nearly full disk is cleaned first (Hawa's own old backups and build cache, disk_cleanup.sh); what
# is left is reported every 6 hours, with how much of it is Hawa's, so it is not mistaken for an outage.
#
#   bash infra/ops/watchdog.sh              # one pass (what the launch agent runs every 5 minutes)
#   bash infra/ops/watchdog.sh --status     # print the assessment only, never alert
#   bash infra/ops/watchdog.sh --announce   # send "watchdog armed" once (proves alerts reach you)
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
PROD="$ROOT/infra/docker/.env.production"; STATE_DIR="$HOME/.hawa/watchdog"; mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
STATE="$STATE_DIR/state"; COOLDOWN=1800; NOW="$(date +%s)"; MODE="${1:-}"
COMPOSE=(docker compose -f "$ROOT/infra/docker/docker-compose.prod.yml" -f "$ROOT/infra/docker/canva-release.override.yml" --env-file "$ROOT/infra/docker/.env")
# alerted: the operator has been told about the problem now under way, so its end is announced too
# (a problem that cleared before any alert was sent ends quietly). alerted_other: what the last red
# alert named, so its recovery is announced even while the disk is still full. disk_was_full: the
# disk counts as full until it drops below 88%, so a disk hovering at 89-90% does not flap.
last_status=""; last_alert=0; last_disk_alert=0; last_cleanup=0; last_msg=""; alerted=0; alerted_other=""; disk_was_full=0
[[ -f "$STATE" ]] && source "$STATE"
save() {
  printf 'last_status=%q\nlast_alert=%q\nlast_disk_alert=%q\nlast_cleanup=%q\nlast_msg=%q\nalerted=%q\nalerted_other=%q\ndisk_was_full=%q\n' \
    "$1" "$last_alert" "$last_disk_alert" "$last_cleanup" "$last_msg" "$alerted" "$alerted_other" "$disk_was_full" > "$STATE"
}
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
# 2. Stack containers: the six stack services by name, at least one worker, and the vector log
#    shipper (stack_containers.sh says why each is matched by name). Only deploy.sh creates a worker
#    colour; a colour it removed must stay removed.
running_names() { docker ps --filter name=hawa-production- --filter status=running --format '{{.Names}}' 2>/dev/null || true; }
source "$ROOT/infra/ops/stack_containers.sh"
if [[ ${#problems[@]} -eq 0 ]]; then
  running="$(count_stack)"; workers="$(count_workers)"
  if [[ "$running" -lt "$STACK_SIZE" || "$workers" -lt 1 ]] || ! vector_running; then
    if [[ "$MODE" != "--status" ]]; then
      export HAWA_BUILD_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
      # Existing containers first, exactly as they were deployed. `up` then only creates what is
      # missing and never recreates a running one: this checkout can be ahead of the deploy (merged,
      # its gate not yet passed), and on 2026-09-23 `up -d` rebuilt Core from the newer compose file
      # while the deploy that would have migrated for it had stopped at its test gate.
      "${COMPOSE[@]}" start >/dev/null 2>&1 || true
      # The worker colours sit behind a compose profile, which `start` and `up` leave alone: start the
      # worker containers that exist (a deploy removes a colour once it has drained).
      for name in $( { docker ps -a --filter name=hawa-production-worker --filter status=exited --filter status=created --format '{{.Names}}' 2>/dev/null || true; } | grep -E "$WORKER_NAME" || true); do
        docker start "$name" >/dev/null 2>&1 || true
      done
      sleep 10
      running="$(count_stack)"
      if [[ "$running" -lt "$STACK_SIZE" ]] || ! vector_running; then
        "${COMPOSE[@]}" up -d --no-build --no-recreate >/dev/null 2>&1 || problems+=("compose up failed")
      fi
      sleep 20
      running="$(count_stack)"; workers="$(count_workers)"
    fi
    [[ "$running" -ge "$STACK_SIZE" ]] || problems+=("only ${running}/${STACK_SIZE} stack containers running (down: $(missing_stack))")
    vector_running || problems+=("vector is not running: container logs are not reaching ~/.hawa/logs")
    [[ "$workers" -ge 1 ]] || problems+=("no worker container is running (run infra/docker/deploy.sh --apply to start one)")
  fi
fi
# 3. Core and worker health
core="$(curl -fsS -m 10 http://127.0.0.1:8080/v1/health 2>/dev/null || true)"
if [[ -z "$core" ]]; then problems+=("core health does not answer on 127.0.0.1:8080")
else
  summary="$(printf '%s' "$core" | python3 -c 'import json,sys
h=json.load(sys.stdin); d=h.get("dependencies",{}); bad={k:v for k,v in d.items() if v in ("unauthorized","unreachable","disconnected","read_only","outage","degraded","billing_exhausted")}
parked=d.get("parkedClientMessages",0)
if isinstance(parked,int) and parked>0: bad["parkedClientMessages"]=parked
# Restate pauses an invocation once its retries run out (about an hour); it then waits for a person
# (resume or cancel it in the Restate UI) and said nothing until health reported it.
paused=d.get("restatePausedInvocations",0)
if isinstance(paused,int) and paused>0: bad["restatePausedInvocations"]=paused
print(h.get("status","?")+("" if not bad else " "+json.dumps(bad)))' 2>/dev/null || echo "unparseable")"
  [[ "$summary" == healthy* ]] || problems+=("core ${summary}")
fi
# Every running worker colour answers for itself. One of them must be running the outbox: "live" (or
# "taking_over" for the minute after a deploy); a colour draining is "standby". A worker from before
# blue/green reports no colour and always runs it.
outbox_runners=0; workers_seen=0
for name in $(running_names | grep -E "$WORKER_NAME" || true); do
  workers_seen=$((workers_seen + 1))
  worker="$(docker exec "$name" node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
  label="${name#hawa-production-}"; label="${label%-1}"
  if [[ -z "$worker" ]]; then problems+=("${label} health does not answer"); continue; fi
  wsum="$(printf '%s' "$worker" | python3 -c 'import json,sys; h=json.load(sys.stdin); print(h.get("status","?"), h.get("background","always"), json.dumps(h.get("outbox",{})))' 2>/dev/null || echo "unparseable")"
  [[ "$wsum" == healthy* ]] || problems+=("${label} ${wsum}")
  case "$wsum" in *" live "*|*" always "*|*" taking_over "*) outbox_runners=$((outbox_runners + 1)) ;; esac
done
if [[ "$workers_seen" -eq 0 ]]; then
  # Already reported by the container check when it ran.
  [[ "${workers:-unchecked}" == 0 ]] || problems+=("worker health does not answer (no worker running)")
elif [[ "$outbox_runners" -eq 0 ]]; then problems+=("no worker is running the outbox (Restate names no live worker, or cannot be reached)")
fi

# 4. Disk and backup freshness (a full disk or a stale backup is an outage in waiting). From 88% Hawa
#    cleans up after itself, at most hourly; from 90% what is left is reported (below).
disk_used() { df -P "$ROOT" | awk 'NR==2{gsub("%","",$5); print $5}'; }
used="$(disk_used)"
if [[ "${used:-0}" -ge 88 && "$MODE" != "--status" ]] && (( NOW - last_cleanup >= 3600 )); then
  mkdir -p "$HOME/.hawa/logs"
  { date -u +%FT%TZ; bash "$ROOT/infra/ops/disk_cleanup.sh"; } >> "$HOME/.hawa/logs/disk_cleanup.log" 2>&1 || true
  last_cleanup="$NOW"; used="$(disk_used)"
fi
disk_full=0
if [[ "${used:-0}" -ge 90 ]] || [[ "$disk_was_full" == 1 && "${used:-0}" -ge 88 ]]; then disk_full=1; fi
backup_problem="$(python3 "$ROOT/infra/backup/backup_status.py" --snapshots "$ROOT/infra/backup/snapshots" 2>/dev/null)" \
  || problems+=("${backup_problem:-nightly backup status unavailable}")

if [[ ${#problems[@]} -eq 0 && "$disk_full" -eq 0 ]]; then
  echo "healthy"
  [[ "$MODE" == "--status" ]] && exit 0
  if [[ "$alerted" == 1 ]]; then
    notify "✅ Hawa is back to normal ($(date '+%H:%M')). It was: ${last_msg:-a problem}"
  fi
  last_msg=""; alerted=0; alerted_other=""; disk_was_full=0; save healthy; exit 0
fi

if [[ "$disk_full" -eq 1 ]]; then
  free="$(df -h "$ROOT" | awk 'NR==2{print $4}' | sed -E 's/Ti$/ TB/; s/Gi$/ GB/; s/Mi$/ MB/')"
  # Both sources may fail (Docker down, no archive folder yet): the alert still goes, with "?".
  backups="$( { du -sch "$ROOT/infra/backup/snapshots" "$HOME/.hawa/snapshots_archive" 2>/dev/null || true; } | tail -1 | cut -f1 | tr -d ' ' | sed -E 's/G$/ GB/; s/M$/ MB/')"
  cache="$( { docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null || true; } | awk '/^Build Cache/{print $3}' | sed -E 's/([0-9])([KMGT]B)$/\1 \2/')"
  # The file store (ADR-035): client photos and design sources, deleted only by the collector.
  files="$( { du -sh "${HAWA_BLOBS_DIR:-$HOME/.hawa/blobs}" 2>/dev/null || true; } | cut -f1 | tr -d ' ' | sed -E 's/G$/ GB/; s/M$/ MB/; s/K$/ KB/')"
  disk_msg="The Mac's disk is ${used}% full (${free} free). Hawa has already cleaned up after itself: its backups take ${backups:-?}, its stored pictures and design files ${files:-0} and Docker's build cache ${cache:-?}. The rest is other files on this Mac, so please free some space (System Settings, General, Storage)."
fi
if [[ ${#problems[@]} -eq 0 ]]; then
  # Only the disk: a reminder every 6 hours, hourly past 97%, instead of every 30 minutes.
  echo "PROBLEM: disk ${used}% used"
  [[ "$MODE" == "--status" ]] && exit 1
  if [[ -n "$alerted_other" ]]; then
    # What the last red alert named has cleared; without this the next word would be hours away.
    notify "✅ Back to normal apart from the disk ($(date '+%H:%M')). It was: ${alerted_other}. The disk is still ${used}% full."; alerted_other=""
  fi
  last_msg="disk ${used}% full"; disk_was_full=1
  every=21600; [[ "${used:-0}" -lt 97 ]] || every=3600
  if (( NOW - last_disk_alert >= every )); then
    notify "💾 ${disk_msg} Next reminder in $(( every / 3600 )) h."; last_disk_alert="$NOW"; alerted=1
  fi
  save problem; exit 1
fi
msg="$(printf '%s; ' "${problems[@]}")"; echo "PROBLEM: $msg"
[[ "$MODE" == "--status" ]] && exit 1
last_msg="${msg%; }${disk_msg:+; disk ${used}% full}"; disk_was_full="$disk_full"
if (( NOW - last_alert >= COOLDOWN )); then
  notify "🔴 Hawa needs attention ($(date '+%H:%M')): ${msg%; }.${disk_msg:+ Also: ${disk_msg}}"; last_alert="$NOW"
  alerted=1; alerted_other="${msg%; }"
  [[ -z "${disk_msg:-}" ]] || last_disk_alert="$NOW"
fi
save problem; exit 1
