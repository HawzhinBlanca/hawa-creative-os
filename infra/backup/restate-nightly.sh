#!/usr/bin/env bash
# Nightly Restate backup (architecture programme 2.6, ADR-034, PHASE2_DESIGN.md section 2.6). Once
# Restate owns the request lifecycle its volume holds live state (object state, journals, delayed
# reminders, idempotency keys, the worker registrations) and is as important as Postgres.
#
#   bash infra/backup/restate-nightly.sh     # one backup; nightly_backup.sh runs it first when HAWA_RESTATE_BACKUP=on
#   bash infra/backup/restate-nightly.sh --recover   # only undo what a cut-off run left (the watchdog runs it)
#
# What it does, in order:
#   1. Throws the office's Telegram kill switch through Core's API (POST /v1/ingress/channels/telegram/toggle,
#      which answers only once Postgres holds the switch), so no new update is handed to Restate. A
#      switch the office had already thrown is left as it was, and not released at the end.
#   2. Waits until sys_invocation shows no running invocation, or HAWA_RESTATE_DRAIN_SECONDS (300).
#   3. Stops the Restate container (a clean shutdown flushes RocksDB) and tars its data volume through a
#      helper container of Restate's own image (read-only mount, no network, never pulled).
#   4. Starts Restate, waits until it is healthy and serves the worker's services (TaskWorkflow), and
#      releases the kill switch. The archive is encrypted and copied only then, so Restate is down for
#      the tar alone.
#   5. Writes restate_<STAMP>.tar[.enc] (+ .sha256) to the nightly archive, with the dump's cipher and
#      retention (HAWA_BACKUP_ARCHIVE_KEYFILE, HAWA_BACKUP_ARCHIVE_KEEP), and a line in backup.log with
#      the duration, the drain, the downtime and the volume's size.
#
# Messages that arrive while the switch is thrown wait in Telegram: Core's poller (and the worker's)
# asks Telegram for nothing while it is thrown, and an update already handed to ChatInbox is retried
# until intake is back; nothing is refused to the sender (infra/backup/README.md, with the code).
#
# When the drain times out it goes on: stopping Restate is durable (a running invocation resumes from
# its journal after the start, as after any restart or the chaos suite's Restate kills), and a night
# without a backup because one design ran long would be worse. The log line says drain=timeout.
#
# Every path puts things back: on an error, a timeout or a signal (INT, TERM, HUP) the exit handler
# starts Restate if this run stopped it and releases the switch if this run threw it. If Restate does
# not come back, or the switch cannot be released, it says so loudly (stderr, backup.log, the
# operator's Telegram chat) and exits 3; any other failure exits 1 with the service as it was. A run
# killed outright (SIGKILL) leaves HAWA_RESTATE_BACKUP_STATE behind; the watchdog leaves Restate alone
# while a run is alive, and once its process is gone runs --recover within 5 minutes, which undoes what
# it had done (infra/ops/watchdog.sh). Without that the office's intake would stay off until the next night.
#
# Every name, port and path can be pointed elsewhere, which the chaos restore drill does (it backs up
# the hawa-chaos stack with this script) and packages/testkit/test/restate-nightly.test.ts does with
# Docker stubbed:
#   HAWA_RESTATE_PROJECT (hawa-production), HAWA_RESTATE_CONTAINER (<project>-restate-1),
#   HAWA_RESTATE_CORE_CONTAINER (<project>-core-1), HAWA_RESTATE_CORE_URL (Core as seen inside its
#   container, http://127.0.0.1:3001), HAWA_RESTATE_CORE_AUTH_VAR (the container's variable holding an
#   operator token, HAWA_BEARER_TOKEN; read inside the container, never on this host),
#   HAWA_RESTATE_DATA_PATH (/restate-data), HAWA_RESTATE_REQUIRED_SERVICE (TaskWorkflow),
#   HAWA_RESTATE_DRAIN_SECONDS, HAWA_RESTATE_SETTLE_SECONDS, HAWA_RESTATE_HEALTH_SECONDS,
#   HAWA_RESTATE_POLL_SECONDS, HAWA_RESTATE_STOP_TIMEOUT, HAWA_RESTATE_RELEASE_ATTEMPTS,
#   HAWA_RESTATE_RELEASE_WAIT_SECONDS, HAWA_RESTATE_BACKUP_STATE, and the nightly's HAWA_BACKUP_SNAPSHOT_DIR,
#   HAWA_BACKUP_ARCHIVE_DEST, HAWA_BACKUP_ARCHIVE_KEEP, HAWA_BACKUP_ARCHIVE_KEYFILE, HAWA_BACKUP_NOTIFY_ENV,
#   HAWA_BACKUP_STAMP (the night's stamp, so the archive pairs with the dump).
#
# Container commands are docker stop/start on the container, not `docker compose stop restate`: compose
# needs both production files, the env file and the build stamp to resolve the project, and stop/start
# of the existing container is what it would do.
set -euo pipefail; umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
DIR="${HAWA_BACKUP_SNAPSHOT_DIR:-$ROOT/infra/backup/snapshots}"; mkdir -p "$DIR"; chmod 700 "$DIR"
LOG="$DIR/backup.log"; PROD="${HAWA_BACKUP_NOTIFY_ENV:-$ROOT/infra/docker/.env.production}"
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
ARCHIVE_KEEP="${HAWA_BACKUP_ARCHIVE_KEEP:-14}"
ARCHIVE_KEYFILE="${HAWA_BACKUP_ARCHIVE_KEYFILE:-}"
STAMP="${HAWA_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
MODE="${1:-}"; [[ -z "$MODE" || "$MODE" == --recover ]] || { echo "usage: restate-nightly.sh [--recover]" >&2; exit 2; }
PROJECT="${HAWA_RESTATE_PROJECT:-hawa-production}"
RESTATE="${HAWA_RESTATE_CONTAINER:-${PROJECT}-restate-1}"
CORE="${HAWA_RESTATE_CORE_CONTAINER:-${PROJECT}-core-1}"
CORE_URL="${HAWA_RESTATE_CORE_URL:-http://127.0.0.1:3001}"
AUTH_VAR="${HAWA_RESTATE_CORE_AUTH_VAR:-HAWA_BEARER_TOKEN}"
DATA_PATH="${HAWA_RESTATE_DATA_PATH:-/restate-data}"
SERVICE="${HAWA_RESTATE_REQUIRED_SERVICE:-TaskWorkflow}"
DRAIN_S="${HAWA_RESTATE_DRAIN_SECONDS:-300}"
# The worker's poller reads the switch from Postgres at most every 5 s, and an update it had already
# taken from Telegram is handed on within that time: wait that long before counting the drain.
SETTLE_S="${HAWA_RESTATE_SETTLE_SECONDS:-10}"
HEALTH_S="${HAWA_RESTATE_HEALTH_SECONDS:-180}"
POLL_S="${HAWA_RESTATE_POLL_SECONDS:-5}"
STOP_TIMEOUT="${HAWA_RESTATE_STOP_TIMEOUT:-60}"
RELEASE_ATTEMPTS="${HAWA_RESTATE_RELEASE_ATTEMPTS:-12}"
RELEASE_WAIT="${HAWA_RESTATE_RELEASE_WAIT_SECONDS:-10}"
STATE="${HAWA_RESTATE_BACKUP_STATE:-$HOME/.hawa/restate-backup.state}"

# What this run has done that must be undone, and how it ended. The exit handler reads these.
SWITCH_OURS=0      # this run threw the kill switch (or adopted a cut-off run's)
RESTATE_OURS=0     # this run stopped Restate (or adopted a cut-off run's) and has not seen it back
RESTATE_DOWN=0     # Restate did not come back
SWITCH_STUCK=0     # the switch could not be released
FINISHED=0; FAIL_MSG=""; RECOVERED=""
WORK=""; PART=""; BG=""; NAP=""

log_line() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
notify() { # Telegram, operator chat; values read at call time, never logged
  local token chat; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2- || true)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1 || true)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" || true
}
now() { date +%s; }
# Sleeps and long commands run in the background and are waited for: bash runs a trap only between
# commands, so a signal during a 60 s `docker stop` or a long tar would otherwise wait for it to end.
nap() { sleep "$1" & NAP=$!; wait "$NAP" 2>/dev/null || true; NAP=""; }
in_bg() { local rc=0; "$@" & BG=$!; wait "$BG" || rc=$?; BG=""; return "$rc"; }

fail() { FAIL_MSG="$1"; echo "restate backup: $1" >&2; exit 1; }
on_signal() { FAIL_MSG="stopped by signal $1"; echo "restate backup: stopped by signal $1" >&2; exit "$2"; }

# This run's record of what it changed, for a run that is killed outright (and for the watchdog).
write_state() {
  mkdir -p "$(dirname "$STATE")"
  printf 'pid=%s\nstamp=%s\nswitch=%s\nrestate=%s\ncontainer=%s\n' "$$" "$STAMP" "$SWITCH_OURS" "$RESTATE_OURS" "$RESTATE" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}
state_field() { sed -nE "s/^$1=([A-Za-z0-9_.:-]*)$/\1/p" "$STATE" 2>/dev/null | head -1; }
state_is_mine() { [[ -f "$STATE" && "$(state_field pid)" == "$$" ]]; }

# Core's API from inside the Core container: the operator token never leaves it. Prints
# "<HTTP status> <body>", or "0 <why>" when Core could not be reached.
CORE_JS='const [method, route, body] = process.argv.slice(1);
const token = process.env[process.env.RB_AUTH_VAR || "HAWA_BEARER_TOKEN"];
if (!token) { console.log("0 no operator token in this container"); process.exit(0); }
fetch(process.env.RB_BASE + route, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body || undefined, signal: AbortSignal.timeout(20000) })
  .then(async (r) => console.log(r.status + " " + (await r.text()).replace(/\s+/g, " ").slice(0, 400)))
  .catch((e) => console.log("0 " + String((e && e.message) || e).slice(0, 200)));'
core_api() {
  docker exec -e "RB_BASE=$CORE_URL" -e "RB_AUTH_VAR=$AUTH_VAR" "$CORE" node -e "$CORE_JS" "$1" "$2" "${3:-}" 2>/dev/null || echo "0 docker exec into $CORE failed"
}
# thrown | released | unknown
switch_state() {
  local out; out="$(core_api GET /v1/ingress/status)"
  case "$out" in
    "200 "*'"telegram":true'*) echo released ;;
    "200 "*'"telegram":false'*) echo thrown ;;
    *) echo unknown ;;
  esac
}
set_switch() { # thrown | released; succeeds once Core (and so Postgres) confirms it
  local enabled active out
  if [[ "$1" == thrown ]]; then enabled=false; active=true; else enabled=true; active=false; fi
  out="$(core_api POST /v1/ingress/channels/telegram/toggle "{\"enabled\":$enabled}")"
  [[ "$out" == "200 "*"\"killSwitchActive\":$active"* ]]
}
ensure_released() {
  local i=1
  while (( i <= RELEASE_ATTEMPTS )); do
    if set_switch released; then SWITCH_OURS=0; write_state; return 0; fi
    (( i < RELEASE_ATTEMPTS )) && nap "$RELEASE_WAIT"
    i=$((i + 1))
  done
  SWITCH_STUCK=1; return 1
}

restate_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$RESTATE" 2>/dev/null || true)" == true ]]; }
restate_health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$RESTATE" 2>/dev/null || echo missing; }
restate_started_at() { docker inspect -f '{{.State.StartedAt}}' "$RESTATE" 2>/dev/null || echo unknown; }
# The admin API from inside the Restate container: production publishes no admin port.
restate_admin() { docker exec "$RESTATE" curl -fsS -m 15 -H 'content-type: application/json' -H 'accept: application/json' "$@"; }
running_invocations() { # a count, or ? when Restate did not answer
  local out n
  out="$(restate_admin -X POST --data "{\"query\":\"SELECT count(*) AS n FROM sys_invocation WHERE status = 'running'\"}" http://127.0.0.1:9070/query 2>/dev/null || true)"
  n="$(printf '%s' "$out" | sed -nE 's/.*"n":([0-9]+).*/\1/p' | head -1)"
  echo "${n:-?}"
}
# Restate keeps the worker registrations in its volume; a volume that came back without them (as on
# 2026-09-17, when it was recreated) dead-letters every request while its health looks fine.
serves_workers() { restate_admin "http://127.0.0.1:9070/services/$SERVICE" >/dev/null 2>&1; }
ensure_restate() { # started, healthy and serving the worker's services; RESTATE_DOWN=1 when not
  local attempt deadline
  for attempt in 1 2; do
    if ! restate_running; then in_bg docker start "$RESTATE" >/dev/null 2>&1 || true
    elif [[ "$attempt" == 2 && "$(restate_health)" != healthy ]]; then in_bg docker restart -t 30 "$RESTATE" >/dev/null 2>&1 || true
    fi
    deadline=$(( $(now) + HEALTH_S ))
    while :; do
      if [[ "$(restate_health)" == healthy ]] && serves_workers; then RESTATE_OURS=0; write_state; return 0; fi
      (( $(now) >= deadline )) && break
      nap "$POLL_S"
    done
  done
  RESTATE_DOWN=1; return 1
}

on_exit() {
  local rc=$? msg
  # Finish putting things back whatever arrives now; a second signal or a failing check must not cut
  # this short.
  trap '' INT TERM HUP; trap - ERR; set +e
  # A command still running in the background (docker stop, the tar): its docker client first, which
  # passes the signal on to its container.
  if [[ -n "$BG" ]]; then pkill -TERM -P "$BG" 2>/dev/null; kill "$BG" 2>/dev/null; fi
  if [[ -n "$NAP" ]]; then kill "$NAP" 2>/dev/null || true; fi
  if [[ "$RESTATE_OURS" == 1 && "$RESTATE_DOWN" == 0 ]]; then ensure_restate || true; fi
  if [[ "$SWITCH_OURS" == 1 && "$SWITCH_STUCK" == 0 ]]; then ensure_released || true; fi
  if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi
  if [[ -n "$PART" ]]; then rm -f "$PART"; fi
  if [[ "$RESTATE_DOWN" == 1 || "$SWITCH_STUCK" == 1 ]]; then
    rc=3
    {
      echo "################################################################################"
      [[ "$RESTATE_DOWN" == 1 ]] && echo "# RESTATE IS DOWN: it did not come back after the nightly backup ($RESTATE)."
      [[ "$RESTATE_DOWN" == 1 ]] && echo "#   Start it: docker start $RESTATE; check it serves $SERVICE; re-register the live worker if not (infra/docker/README.md)."
      [[ "$SWITCH_STUCK" == 1 ]] && echo "# TELEGRAM INTAKE IS STILL SWITCHED OFF: the kill switch this backup threw could not be released."
      [[ "$SWITCH_STUCK" == 1 ]] && echo "#   Release it in the Desk (Settings, intake) or: POST /v1/ingress/channels/telegram/toggle {\"enabled\":true}."
      echo "################################################################################"
    } >&2
  fi
  if [[ "$FINISHED" != 1 ]]; then
    [[ -n "$FAIL_MSG" ]] || FAIL_MSG="stopped unexpectedly (exit $rc)"
    [[ "$rc" != 0 ]] || rc=1
    msg="$FAIL_MSG"
    [[ "$RESTATE_DOWN" == 1 ]] && msg="$msg; Restate did not come back"
    [[ "$SWITCH_STUCK" == 1 ]] && msg="$msg; Telegram intake is still switched off"
    log_line "RESTATE FAIL ${STAMP}: ${msg} (restate=$([[ "$RESTATE_DOWN" == 1 ]] && echo DOWN || echo running) kill_switch=$([[ "$SWITCH_STUCK" == 1 ]] && echo STILL_THROWN || echo as_found))"
    notify "🔴 Hawa nightly Restate backup FAILED (${STAMP}): ${msg}. $([[ "$RESTATE_DOWN" == 1 ]] && echo "Restate is DOWN: requests cannot move until it is started." || echo "Restate is running.") $([[ "$SWITCH_STUCK" == 1 ]] && echo "Telegram intake is still switched off: messages wait in Telegram until it is released." || true)"
  fi
  # The record stays while something this run changed is still changed, so the next run undoes it.
  if state_is_mine && [[ "$SWITCH_OURS" == 0 && "$RESTATE_OURS" == 0 && "$RESTATE_DOWN" == 0 ]]; then rm -f "$STATE"; fi
  exit "$rc"
}
trap on_exit EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP
trap 'fail "stopped unexpectedly at line $LINENO"' ERR

[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "HAWA_BACKUP_STAMP must look like 20260925T013000Z"
[[ "$ARCHIVE_KEEP" =~ ^[0-9]+$ && "$ARCHIVE_KEEP" -ge 1 ]] || fail "HAWA_BACKUP_ARCHIVE_KEEP must be a whole number of at least 1"
for v in DRAIN_S SETTLE_S HEALTH_S STOP_TIMEOUT RELEASE_ATTEMPTS; do [[ "${!v}" =~ ^[0-9]+$ ]] || fail "$v must be a whole number of seconds"; done

# 0. A run that was killed outright left its record: undo what it had done before anything else.
if [[ -f "$STATE" ]]; then
  prev_pid="$(state_field pid)"
  if [[ -n "$prev_pid" && "$prev_pid" != "$$" ]] && ps -p "$prev_pid" -o command= 2>/dev/null | grep -q 'restate-nightly'; then
    fail "another Restate backup is running (pid ${prev_pid})"
  fi
  prev_stamp="$(state_field stamp)"
  if [[ "$(state_field container)" == "$RESTATE" ]]; then
    [[ "$(state_field restate)" == 1 ]] && RESTATE_OURS=1 && RECOVERED="restate"
    [[ "$(state_field switch)" == 1 ]] && SWITCH_OURS=1 && RECOVERED="${RECOVERED:+$RECOVERED,}kill_switch"
  fi
  write_state
  if [[ -n "$RECOVERED" ]]; then
    log_line "RESTATE RECOVER ${STAMP}: the run of ${prev_stamp:-?} was cut off; putting back: ${RECOVERED}"
    if [[ "$RESTATE_OURS" == 1 ]]; then ensure_restate || fail "Restate, stopped by the cut-off run of ${prev_stamp:-?}, did not come back"; fi
    if [[ "$SWITCH_OURS" == 1 ]]; then ensure_released || fail "the kill switch thrown by the cut-off run of ${prev_stamp:-?} could not be released"; fi
    notify "🟠 The Restate backup of ${prev_stamp:-?} was cut off before it finished; $([[ "$MODE" == --recover ]] && echo "the watchdog" || echo "tonight's run") put back: ${RECOVERED}."
  fi
fi
if [[ "$MODE" == --recover ]]; then
  FINISHED=1
  [[ -n "$RECOVERED" ]] && log_line "RESTATE RECOVERED ${STAMP}: ${RECOVERED}"
  exit 0
fi

# 1. Before touching anything: the passphrase, Restate, its volume, and Core's answer about the switch.
if [[ -n "$ARCHIVE_KEYFILE" && ! -r "$ARCHIVE_KEYFILE" ]]; then
  fail "archive passphrase file $ARCHIVE_KEYFILE is not readable; refusing to write an unencrypted off-host copy"
fi
restate_running || fail "Restate ($RESTATE) is not running; nothing was stopped or archived"
VOL="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$DATA_PATH\"}}{{.Name}}{{end}}{{end}}" "$RESTATE" 2>/dev/null || true)"
IMG="$(docker inspect -f '{{.Config.Image}}' "$RESTATE" 2>/dev/null || true)"
[[ -n "$VOL" ]] || fail "$RESTATE has no named volume at $DATA_PATH"
[[ -n "$IMG" ]] || fail "could not read the image of $RESTATE"
if [[ "$ARCHIVE_DEST" != gs://* ]]; then
  { mkdir -p "$ARCHIVE_DEST" && chmod 700 "$ARCHIVE_DEST"; } || fail "could not prepare the archive (${ARCHIVE_DEST/#$HOME/~})"
  # Left by a run cut off while it wrote (a run takes minutes).
  find "$ARCHIVE_DEST" -maxdepth 1 -name 'restate_*.part' -mmin +120 -delete 2>/dev/null || true
fi
WORK="$(mktemp -d "$DIR/.restate_${STAMP}.XXXXXX")"
FOUND="$(switch_state)"
[[ "$FOUND" != unknown ]] || fail "Core did not answer about the Telegram kill switch ($CORE); nothing was stopped or archived"
START_S="$(now)"

# 2. The kill switch. Marked ours before the call: a signal during it still releases it (releasing a
#    switch that did not move changes nothing).
if [[ "$FOUND" == thrown ]]; then
  SWITCH_NOTE="found_thrown"
else
  SWITCH_OURS=1; write_state
  set_switch thrown || fail "Core did not throw the Telegram kill switch; Restate was not stopped"
  SWITCH_NOTE="thrown"
fi
nap "$SETTLE_S"

# 3. The drain.
DRAIN_START="$(now)"; DRAIN="clean"; RUNNING_LEFT=0
DEADLINE=$(( DRAIN_START + DRAIN_S ))
while :; do
  RUNNING_LEFT="$(running_invocations)"
  [[ "$RUNNING_LEFT" == 0 ]] && break
  if (( $(now) >= DEADLINE )); then DRAIN="timeout"; break; fi
  nap "$POLL_S"
done
DRAIN_SECS=$(( $(now) - DRAIN_START ))

# 4. Stop. Marked ours first: whatever happens from here, the exit handler starts it again.
STARTED_BEFORE="$(restate_started_at)"
RESTATE_OURS=1; write_state
DOWN_START="$(now)"
in_bg docker stop -t "$STOP_TIMEOUT" "$RESTATE" >/dev/null 2>&1 || fail "Restate did not stop (docker stop failed); nothing was archived"
! restate_running || fail "Restate is still running after docker stop; a live volume is not archived"

# 5. The volume, read by a helper container while Restate is stopped.
VOLUME_BYTES="$(docker run --rm --pull never --network none -v "$VOL:/data:ro" --entrypoint du "$IMG" -sb /data 2>/dev/null | awk 'NR==1 {print $1}' || true)"
[[ "$VOLUME_BYTES" =~ ^[0-9]+$ ]] || VOLUME_BYTES="?"
tar_volume() { docker run --rm --pull never --network none -v "$VOL:/data:ro" --entrypoint tar "$IMG" --numeric-owner -C /data -cf - . > "$1"; }
in_bg tar_volume "$WORK/restate.tar" || fail "could not archive the Restate volume (tar failed); no archive was written"
# Someone else (the watchdog, an operator) starting Restate while tar read it makes a torn copy.
if restate_running || [[ "$(restate_started_at)" != "$STARTED_BEFORE" ]]; then
  fail "Restate was started while its volume was being archived; the archive was discarded"
fi
tar -tf "$WORK/restate.tar" > "$WORK/list" 2>/dev/null || fail "the Restate archive does not read back"
[[ -s "$WORK/list" ]] || fail "the Restate archive is empty"
TAR_BYTES="$(wc -c < "$WORK/restate.tar" | tr -d ' ')"

# 6. Back up, then intake back on.
ensure_restate || true
DOWN_SECS=$(( $(now) - DOWN_START ))
if [[ "$SWITCH_OURS" == 1 ]]; then ensure_released || true; fi

# 7. The archive copy (Restate is serving again). Same cipher as the dump, checked by decrypting it.
PLAIN_SHA="$(shasum -a 256 "$WORK/restate.tar" | cut -d' ' -f1)"
NAME="restate_${STAMP}.tar"; [[ -n "$ARCHIVE_KEYFILE" ]] && NAME="$NAME.enc"
if [[ -n "$ARCHIVE_KEYFILE" ]]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -in "$WORK/restate.tar" -out "$WORK/$NAME" -pass "file:$ARCHIVE_KEYFILE" \
    || fail "could not encrypt the Restate archive"
  [[ "$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$WORK/$NAME" -pass "file:$ARCHIVE_KEYFILE" | shasum -a 256 | cut -d' ' -f1)" == "$PLAIN_SHA" ]] \
    || fail "the encrypted Restate archive does not decrypt back to the volume's tar"
  rm -f "$WORK/restate.tar"
else
  mv -f "$WORK/restate.tar" "$WORK/$NAME"
fi
ARCHIVE_SHA="$(shasum -a 256 "$WORK/$NAME" | cut -d' ' -f1)"; echo "$ARCHIVE_SHA" > "$WORK/$NAME.sha256"
ARCHIVE_BYTES="$(wc -c < "$WORK/$NAME" | tr -d ' ')"
if [[ "$ARCHIVE_DEST" == gs://* ]]; then
  if ! command -v gsutil >/dev/null 2>&1 || ! gsutil cp "$WORK/$NAME" "$WORK/$NAME.sha256" "$ARCHIVE_DEST/" >/dev/null 2>&1; then
    fail "could not upload the Restate archive to $ARCHIVE_DEST"
  fi
else
  PART="$ARCHIVE_DEST/$NAME.part"
  cp "$WORK/$NAME" "$PART" || fail "could not copy the Restate archive to ${ARCHIVE_DEST/#$HOME/~}"
  [[ "$(shasum -a 256 "$PART" | cut -d' ' -f1)" == "$ARCHIVE_SHA" ]] || fail "the copied Restate archive does not match its checksum"
  cp "$WORK/$NAME.sha256" "$ARCHIVE_DEST/$NAME.sha256" && mv -f "$PART" "$ARCHIVE_DEST/$NAME" || fail "could not name the Restate archive"
  PART=""
  # Retention: the newest HAWA_BACKUP_ARCHIVE_KEEP, as for the dumps.
  { ls -1t "$ARCHIVE_DEST"/restate_*.tar "$ARCHIVE_DEST"/restate_*.tar.enc 2>/dev/null || true; } | tail -n +$((ARCHIVE_KEEP + 1)) | while read -r old; do
    rm -f "$old" "$old.sha256"
  done
fi

# 8. Restate or intake still not back is the one outcome that must never pass quietly.
if [[ "$RESTATE_DOWN" == 1 || "$SWITCH_STUCK" == 1 ]]; then FAIL_MSG="the archive ${NAME} was written"; exit 3; fi

TOTAL_S=$(( $(now) - START_S ))
log_line "RESTATE OK ${STAMP} total_s=${TOTAL_S} drain=${DRAIN} running_left=${RUNNING_LEFT} drain_s=${DRAIN_SECS} down_s=${DOWN_SECS} volume_bytes=${VOLUME_BYTES} tar_bytes=${TAR_BYTES} archive_bytes=${ARCHIVE_BYTES} sha256=${ARCHIVE_SHA:0:16} kill_switch=${SWITCH_NOTE}${RECOVERED:+ recovered=$RECOVERED} archive=${NAME}"
FINISHED=1
echo "✓ Restate backup ${NAME} (${ARCHIVE_BYTES} bytes; volume ${VOLUME_BYTES} bytes): drain ${DRAIN} after ${DRAIN_SECS} s, Restate down ${DOWN_SECS} s, total ${TOTAL_S} s, kill switch ${SWITCH_NOTE}"
