#!/usr/bin/env bash
# Hawa watchdog: starts Docker and the stack after a login or reboot, checks core and worker health,
# and tells the operator on Telegram when something is wrong and when it recovers. A new or changed
# problem is sent at once; the same problems again at most once per 30 minutes (ADR-158: one cooldown
# for everything hid the 2026-09-30 Postgres outage behind an alert sent nine minutes before it).
# It runs on the production host: a Mac (launch agent, infra/ops/install_launch_agents.sh) or a Linux
# server (systemd timer, infra/ops/install_systemd_units.sh). On a host marked standby or retired
# (infra/ops/host_lib.sh, ADR-141) it never starts anything, and reports production containers running there.
# A disk short of space is cleaned first (Hawa's own old backups and build cache, disk_cleanup.sh); what
# is left is reported every 6 hours, with how much of it is Hawa's, so it is not mistaken for an outage.
# It reads the stack's own logs since its last pass: Postgres crash recovery and Restate's "severe lag"
# (the Docker VM stalling, which came before both Postgres crashes) are alerted as problems.
#
# Production runs from ~/.hawa/current (ADR-158): the compose files, credentials, backups and build
# stamp it uses are that release's, whichever checkout this script itself was started from.
#
#   bash infra/ops/watchdog.sh              # one pass (what the launch agent runs every 5 minutes)
#   bash infra/ops/watchdog.sh --status     # print the assessment only, never alert
#   bash infra/ops/watchdog.sh --announce   # send "watchdog armed" once (proves alerts reach you)
#   bash infra/ops/watchdog.sh --notify TEXT # send TEXT to the operator and nothing else (ADR-240)
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$ROOT/infra/ops/host_lib.sh"
source "$ROOT/infra/ops/release_lib.sh"
# The release production runs (ADR-158), or this checkout on a host not yet switched over.
DEPLOY_ROOT="$(hawa_deployed_root "$ROOT")"; cd "$DEPLOY_ROOT"
# Every line the watchdog writes starts with the UTC time: its log is read after an outage.
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
# HAWA_WATCHDOG_ENV_FILE points the alerts at another file: the tests use it, so a run of the test suite in
# this checkout never reads production's Telegram credential (2026-09-28: a test logged it).
PROD="${HAWA_WATCHDOG_ENV_FILE:-$DEPLOY_ROOT/infra/docker/.env.production}"; STATE_DIR="$HOME/.hawa/watchdog"; mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
STATE="$STATE_DIR/state"; COOLDOWN=1800; NOW="$(date +%s)"; MODE="${1:-}"
COMPOSE=(docker compose -f "$DEPLOY_ROOT/infra/docker/docker-compose.prod.yml" -f "$DEPLOY_ROOT/infra/docker/canva-release.override.yml" --env-file "$DEPLOY_ROOT/infra/docker/.env")
# alerted: the operator has been told about the problem now under way, so its end is announced too
# (a problem that cleared before any alert was sent ends quietly). alerted_other: what the last red
# alert named, so its recovery is announced even while the disk is still short. alert_key: the same,
# with its numbers left out, to tell a new or changed problem from a repeat. disk_was_full: the disk
# counts as short until it has 5 GiB more than the alert threshold, so it does not flap.
# last_pass: when the previous pass read the logs, so each pass reads only what is new.
last_status=""; last_alert=0; last_disk_alert=0; last_cleanup=0; last_msg=""; alerted=0; alerted_other=""; disk_was_full=0
alert_key=""; last_pass=0
[[ -f "$STATE" ]] && source "$STATE"
save() {
  printf 'last_status=%q\nlast_alert=%q\nlast_disk_alert=%q\nlast_cleanup=%q\nlast_msg=%q\nalerted=%q\nalerted_other=%q\ndisk_was_full=%q\nalert_key=%q\nlast_pass=%q\n' \
    "$1" "$last_alert" "$last_disk_alert" "$last_cleanup" "$last_msg" "$alerted" "$alerted_other" "$disk_was_full" "$alert_key" "$NOW" > "$STATE"
}
# Succeeds only when Telegram took the message (an HTTP 2xx answer). Any answer, or none, used to count
# as sent: a refused token, a rate limit, or Telegram or this host's connection being down (the 2026-10-02
# outage) marked the alert sent, the 30-minute cooldown held back the next try, and the log said nothing.
# Now the pass logs "ALERT NOT SENT" and its caller does not start the cooldown, so the next pass tries
# again; the problem still counts as alerted, so its recovery is announced once Telegram takes messages.
# The token is never printed: curl's own messages are discarded, only its exit status is kept.
notify() {
  # `|| true`: under set -e and pipefail a missing file or line ended the whole pass here (exit 2), as
  # nightly_backup.sh's notify already guards against.
  local token chat rc=0; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2- || true)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1 || true)"
  if [[ -z "$token" || -z "$chat" ]]; then say "ALERT NOT SENT: no TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USERS in ${PROD}"; return 1; fi
  curl -fsS -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" != 0 ]]; then say "ALERT NOT SENT: Telegram did not take it (curl exit ${rc}); the next pass tries again"; return 1; fi
}
# ADR-240: `--notify <text>` sends one message to the operator through this same path and does nothing
# else; the nightly live canary (infra/ops/live_canary.sh) reports a failed night with it.
if [[ "$MODE" == "--notify" ]]; then
  [[ -n "${2:-}" ]] || { echo "watchdog.sh --notify needs the message" >&2; exit 64; }
  notify "$2" || exit 1
  say "notified the operator"; exit 0
fi
# What a problem list is, without its numbers: "only 5/6 stack containers" and "only 4/6" are the same
# problem, "core degraded" and "Postgres crashed" are not.
problem_key() { printf '%s' "$1" | sed -E 's/[0-9]+([.:][0-9]+)*/#/g'; }
# A red alert goes out when the problems differ from what the last one named, or when the same ones
# have lasted another 30 minutes since it.
alert_due() { [[ "$(problem_key "$1")" != "$alert_key" ]] || (( NOW - last_alert >= COOLDOWN )); }

# ADR-141: on a standby or retired host production runs elsewhere. This pass never starts Docker or a
# hawa-production container, never touches Restate (the recovery below can start it), and checks one
# thing: that no production container runs here, since two live hosts would poll the same Telegram bot.
HOST_ROLE_RC=0; HOST_ROLE="$(hawa_host_role)" || HOST_ROLE_RC=$?
if [[ "$HOST_ROLE_RC" != 0 || "$HOST_ROLE" != production ]]; then
  where="$(hawa_host_role_source)"
  if [[ "$MODE" == "--announce" ]]; then
    notify "🟢 Hawa watchdog on $(hostname -s): this host is ${HOST_ROLE} (${where}). It never starts production here, and reports production containers running here." || exit 1
    say "announced"; exit 0
  fi
  role_problems=()
  [[ "$HOST_ROLE_RC" == 0 ]] || role_problems+=("unrecognised host role '${HOST_ROLE}' in ${where} (production, standby or retired): the watchdog starts nothing until it is fixed")
  here=""
  if docker info >/dev/null 2>&1; then
    here="$( { docker ps --filter name=hawa-production- --filter status=running --format '{{.Names}}' 2>/dev/null || true; } | tr '\n' ' ' | sed 's/ *$//')"
  fi
  [[ -z "$here" ]] || role_problems+=("this ${HOST_ROLE} host is running production containers (${here}); stop them here, since two live hosts poll the same Telegram bot")
  if [[ ${#role_problems[@]} -eq 0 ]]; then
    say "${HOST_ROLE} host (${where}): production runs elsewhere; nothing was started"
    [[ "$MODE" == "--status" ]] && exit 0
    if [[ "$alerted" == 1 ]] && ! notify "✅ Hawa ($(hostname -s), ${HOST_ROLE} host): back to normal ($(date '+%H:%M')). It was: ${last_msg:-a problem}"; then
      save healthy; exit 0   # the recovery notice is tried again at the next pass
    fi
    last_msg=""; alerted=0; alerted_other=""; alert_key=""; save healthy; exit 0
  fi
  msg="$(printf '%s; ' "${role_problems[@]}")"; say "PROBLEM: ${msg%; }"
  [[ "$MODE" == "--status" ]] && exit 1
  last_msg="${msg%; }"
  if alert_due "${msg%; }"; then
    if notify "🔴 Hawa ($(hostname -s), ${HOST_ROLE} host) needs attention ($(date '+%H:%M')): ${msg%; }."; then
      last_alert="$NOW"; alert_key="$(problem_key "${msg%; }")"
    fi
    alerted=1; alerted_other="${msg%; }"
  fi
  save problem; exit 1
fi
if [[ "$MODE" == "--announce" ]]; then notify "🟢 Hawa watchdog armed on $(hostname -s): health every 5 min, self-start after login or boot, nightly backup 03:30." || exit 1; say "announced"; exit 0; fi

# The worker Telegram poller (Phase 2.1). With HAWA_TELEGRAM_POLLER=worker Core does not poll, and a
# colour whose poller was off, never started or failing left every check green while no client message
# was read (ADR-129, Phase 4 operations finding 3). Core's health says who is meant to poll; each running
# colour says what its poller does (mode, and background when it is on).
worker_poller_state() {
  python3 -c 'import json,sys
h=json.load(sys.stdin); p=h.get("telegramPoller") or {}
m=str(p.get("mode","off"))
print(m+(":"+str(p.get("background")) if m=="on" else ""))' 2>/dev/null || echo unknown
}
core_poller_owner() {
  python3 -c 'import json,sys; v=json.load(sys.stdin).get("telegramPoller"); print(v if v in ("core","worker") else "")' 2>/dev/null || true
}
telegram_poller_problem() {
  if [[ "${1:-}" == worker && "${2:-0}" -eq 0 ]]; then
    echo "HAWA_TELEGRAM_POLLER=worker but no worker colour is polling Telegram, and Core does not poll: client messages are not being read"
  fi
  return 0
}
# What the stack's own logs say since the last pass (ADR-158). Both Postgres crashes (2026-09-29 09:11,
# 2026-09-30 07:26) followed minutes of Restate "Severe lag … detected in failure detector internal
# timer" (the Docker VM stalling), and Postgres then ran crash recovery with every client refused.
# $1 is the Postgres log and $2 Restate's, as `docker logs` prints them; one problem per line out.
log_problems() {
  local pg="$1" restate="$2" n longest
  n="$(printf '%s\n' "$pg" | grep -cE 'terminating any other active server processes|database system was interrupted|all server processes terminated; reinitializing|was terminated by signal' || true)"
  if [[ "${n:-0}" -gt 0 ]]; then
    echo "Postgres crashed and ran crash recovery since the last check (${n} log lines; clients were refused meanwhile): the Docker VM is short of memory or stalled; stop test, chaos and build work on this host"
  fi
  n="$(printf '%s\n' "$restate" | grep -c 'Severe lag' || true)"
  if [[ "${n:-0}" -gt 0 ]]; then
    longest="$(printf '%s\n' "$restate" | sed -nE 's/.*Severe lag \(([0-9]+)(\.[0-9]+)?s\).*/\1/p' | sort -n | tail -1 || true)"
    echo "Restate reported severe lag ${n} times since the last check (longest ${longest:-?} s): the Docker VM is overloaded or stalling, which came before both Postgres crashes; stop test, chaos and build work on this host"
  fi
  return 0
}

# The nightly Restate backup (infra/backup/restate_nightly.py, ADR-053/054) pauses Telegram intake and
# stops Restate for the length of a cold copy. While that run holds the archive lock, starting Restate
# (step 2) would tear its archive: the pass is skipped. A run killed outright (launchd's SIGKILL, a
# reboot) runs no cleanup; its run record says what it changed, and --recover puts that back here
# rather than at the next night's run (ADR-127, ported from studio-v2 4eb16341).
backup_problem_restate=""
rb_rc=0
if [[ "$MODE" == "--status" ]]; then
  rb_out="$(python3 "$DEPLOY_ROOT/infra/backup/restate_nightly.py" --recovery-status 2>&1)" || rb_rc=$?
  [[ $rb_rc == 2 ]] && backup_problem_restate="a cut-off Restate backup left Restate or intake to put back (the next pass does it)"
else
  rb_out="$(python3 "$DEPLOY_ROOT/infra/backup/restate_nightly.py" --recover 2>&1)" || rb_rc=$?
  if [[ $rb_rc == 0 && "$rb_out" == recovered:* ]]; then
    say "the nightly Restate backup was cut off; ${rb_out}"
    notify "🟠 The nightly Restate backup was cut off before it finished; the watchdog put back: ${rb_out#recovered: }." || true
  fi
fi
if [[ $rb_rc == 75 ]]; then say "the nightly Restate backup is running; this pass is skipped"; exit 0; fi
# backup_holds_lock: recovery failed while a backup still holds the archive lock (a run stuck for over
# two hours). Step 2 then starts every other container but never Restate, which would tear the copy.
backup_holds_lock=0
if [[ $rb_rc != 0 && $rb_rc != 2 ]]; then
  backup_problem_restate="${rb_out:-Restate backup recovery failed}"
  rs_rc=0; python3 "$DEPLOY_ROOT/infra/backup/restate_nightly.py" --recovery-status >/dev/null 2>&1 || rs_rc=$?
  [[ $rs_rc != 75 ]] || backup_holds_lock=1
fi

problems=()
# 1. Docker daemon. On a Mac, Docker Desktop is not set to auto-start: the agent runs at login and
#    opens it. On Linux, Docker Engine is a systemd service started at boot; this unprivileged pass only
#    reads its state (systemctl is-active docker), waits while it is starting, and reports otherwise.
docker_up=1
if ! docker info >/dev/null 2>&1; then
  if [[ "$HAWA_HOST_OS" == Linux ]]; then
    docker_state="$(systemctl is-active docker 2>/dev/null || true)"; docker_state="${docker_state:-unknown}"
    if [[ "$docker_state" == activating || "$docker_state" == reloading ]]; then
      for _ in $(seq 1 36); do docker info >/dev/null 2>&1 && break; sleep 5; done
    fi
    if ! docker info >/dev/null 2>&1; then
      docker_up=0
      if [[ "$docker_state" == active ]]; then
        problems+=("docker.service is active but this user cannot reach Docker (is it in the docker group?)")
      else
        problems+=("Docker is not running: docker.service is ${docker_state} (start it with sudo systemctl start docker; systemctl enable docker starts it at boot)")
      fi
    fi
  else
    [[ "$MODE" == "--status" ]] || open -ga Docker 2>/dev/null || true
    for _ in $(seq 1 36); do docker info >/dev/null 2>&1 && break; sleep 5; done
    docker info >/dev/null 2>&1 || { docker_up=0; problems+=("Docker is not running and could not be started"); }
  fi
fi
# 2. Stack containers: the six stack services by name, at least one worker, and the vector log
#    shipper (stack_containers.sh says why each is matched by name). Only deploy.sh creates a worker
#    colour; a colour it removed must stay removed.
running_names() { docker ps --filter name=hawa-production- --filter status=running --format '{{.Names}}' 2>/dev/null || true; }
source "$ROOT/infra/ops/stack_containers.sh"
# A deploy holding the deploy lock (infra/ops/deploy_lock.py, ADR-240) recreates containers itself.
# Starting the one it is replacing ran a second compose beside its `up -d`: two runs creating the same
# container, a name conflict that stops the deploy half-way, or containers left "Created" (2026-09-18).
# Only a deploy counts: the canary and the nightly backup hold the same lock and change no container.
deploy_applying() {
  local holder
  holder="$(python3 "$ROOT/infra/ops/deploy_lock.py" --holder 2>/dev/null)" || return 1
  [[ "$holder" == *deploy.sh* ]]
}
# Step 2 depends only on Docker. A Restate backup that could not be put back is reported (below) but
# no longer stops the restart: it used to be counted before this step, and a record the office must
# release by hand then kept every stopped container down, unreported, until it cleared.
if [[ "$docker_up" == 1 ]]; then
  running="$(count_stack)"; workers="$(count_workers)"
  if [[ "$running" -lt "$STACK_SIZE" || "$workers" -lt 1 ]] || ! vector_running; then
    if [[ "$MODE" != "--status" ]] && deploy_applying; then
      # Left to the deploy; what is still missing once it had time to finish is reported as usual.
      say "a deploy holds the deploy lock: its containers are left to it this pass"
      sleep 30
      running="$(count_stack)"; workers="$(count_workers)"
    elif [[ "$MODE" != "--status" ]]; then
      # The deployed release's commit (ADR-158), not whatever branch a checkout happens to be on.
      export HAWA_BUILD_COMMIT="$(git -C "$DEPLOY_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
      # Existing containers first, exactly as they were deployed. `up` then only creates what is
      # missing and never recreates a running one: this checkout can be ahead of the deploy (merged,
      # its gate not yet passed), and on 2026-09-23 `up -d` rebuilt Core from the newer compose file
      # while the deploy that would have migrated for it had stopped at its test gate.
      # While a stuck backup holds the archive lock, the stopped containers are started by name and
      # Restate is left out (a bare `compose start` or `up` starts every service, and `up core` starts
      # Restate as Core's dependency, hence --no-deps).
      up_args=(up -d --no-build --no-recreate)
      if [[ "$backup_holds_lock" == 1 ]]; then
        up_args+=(--no-deps); for service in "${STACK_SERVICES[@]}" vector; do [[ "$service" == restate ]] || up_args+=("$service"); done
        for name in $( { docker ps -a --filter name=hawa-production- --filter status=exited --filter status=created --format '{{.Names}}' 2>/dev/null || true; } | grep -E "$STACK_NAME|$VECTOR_NAME" | grep -vx 'hawa-production-restate-1' || true); do
          docker start "$name" >/dev/null 2>&1 || true
        done
      else
        "${COMPOSE[@]}" start >/dev/null 2>&1 || true
      fi
      # The worker colours sit behind a compose profile, which `start` and `up` leave alone: start the
      # worker containers that exist (a deploy removes a colour once it has drained).
      for name in $( { docker ps -a --filter name=hawa-production-worker --filter status=exited --filter status=created --format '{{.Names}}' 2>/dev/null || true; } | grep -E "$WORKER_NAME" || true); do
        docker start "$name" >/dev/null 2>&1 || true
      done
      sleep 10
      running="$(count_stack)"
      if [[ "$running" -lt "$STACK_SIZE" ]] || ! vector_running; then
        "${COMPOSE[@]}" "${up_args[@]}" >/dev/null 2>&1 || problems+=("compose up failed")
      fi
      sleep 20
      running="$(count_stack)"; workers="$(count_workers)"
    fi
    [[ "$running" -ge "$STACK_SIZE" ]] || problems+=("only ${running}/${STACK_SIZE} stack containers running (down: $(missing_stack))")
    vector_running || problems+=("vector is not running: container logs are not reaching ~/.hawa/logs")
    [[ "$workers" -ge 1 ]] || problems+=("no worker container is running (run infra/docker/deploy.sh --apply to start one)")
  fi
  # 2b. Postgres crash recovery and Restate's severe lag, from their logs since the last pass (at most
  #     the last 10 minutes on a first pass).
  since="$last_pass"; [[ "$since" =~ ^[0-9]+$ && "$since" -gt 0 && "$since" -le "$NOW" ]] || since=$((NOW - 600))
  pg_log="$(docker logs --since "$since" hawa-production-postgres-1 2>&1 || true)"
  restate_log="$(docker logs --since "$since" hawa-production-restate-1 2>&1 || true)"
  while IFS= read -r line; do [[ -z "$line" ]] || problems+=("$line"); done < <(log_problems "$pg_log" "$restate_log")
fi
[[ -z "$backup_problem_restate" ]] || problems=("$backup_problem_restate" ${problems[@]+"${problems[@]}"})
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
# "unverified" is not a failure: in production Core reports Canva and the model provider unverified until
# a scheduled probe has answered (e981e59f, ADR-100), and its status is then "degraded" with nothing
# broken. Alerting on that alone would page the office every 30 minutes; it is shown, not alerted.
# "disabled" is the paid probe switched off (HAWA_BILLING_PROBE_ENABLED, ADR-158): nothing to verify.
# The funnel is "in_progress" while a recent brief has no draft yet; a real stall is "stalled", with
# its own alert (apps/core/src/services/funnel-monitor.ts), and is still reported.
ok={"connected","writable","unconfigured","active","idle","in_progress","CLOSED","healthy","unverified","disabled"}
others={k:v for k,v in d.items() if not isinstance(v,(int,float)) and v not in ok}
unverified=sorted(k for k,v in d.items() if v=="unverified")
status=h.get("status","?")
if status=="degraded" and not bad and not others and unverified: status="healthy (unverified: "+", ".join(unverified)+")"
print(status+("" if not bad else " "+json.dumps(bad)))' 2>/dev/null || echo "unparseable")"
  [[ "$summary" == healthy* ]] || problems+=("core ${summary}")
fi
# Every running worker colour answers for itself. One of them must be running the outbox: "live" (or
# "taking_over" for the minute after a deploy); a colour draining is "standby". A worker from before
# blue/green reports no colour and always runs it.
# The Telegram poller: when Core says the worker polls, one running colour must be polling (or taking
# over); a degraded colour names its poller problem (telegramPoller.problem).
outbox_runners=0; workers_seen=0; pollers=0
core_owner="$(printf '%s' "${core:-}" | core_poller_owner)"
for name in $(running_names | grep -E "$WORKER_NAME" || true); do
  workers_seen=$((workers_seen + 1))
  worker="$(docker exec "$name" node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
  label="${name#hawa-production-}"; label="${label%-1}"
  if [[ -z "$worker" ]]; then problems+=("${label} health does not answer"); continue; fi
  wsum="$(printf '%s' "$worker" | python3 -c 'import json,sys; h=json.load(sys.stdin); p=(h.get("telegramPoller") or {}).get("problem"); print(h.get("status","?"), h.get("background","always"), json.dumps(h.get("outbox",{}))+(" telegram poller: "+str(p) if p else ""))' 2>/dev/null || echo "unparseable")"
  [[ "$wsum" == healthy* ]] || problems+=("${label} ${wsum}")
  case "$wsum" in *" live "*|*" always "*|*" taking_over "*) outbox_runners=$((outbox_runners + 1)) ;; esac
  case "$(printf '%s' "$worker" | worker_poller_state)" in on:live|on:always|on:taking_over) pollers=$((pollers + 1)) ;; esac
done
if [[ "$workers_seen" -eq 0 ]]; then
  # Already reported by the container check when it ran.
  [[ "${workers:-unchecked}" == 0 ]] || problems+=("worker health does not answer (no worker running)")
elif [[ "$outbox_runners" -eq 0 ]]; then problems+=("no worker is running the outbox (Restate names no live worker, or cannot be reached)")
fi
if [[ "$workers_seen" -gt 0 ]]; then
  poller_problem="$(telegram_poller_problem "$core_owner" "$pollers")"
  [[ -z "$poller_problem" ]] || problems+=("$poller_problem")
fi

# 4. Disk and backup freshness (a full disk or a stale backup is an outage in waiting). Measured in free
#    space, not percent (ADR-158): on this 1 TB disk 90% still left 96 GiB, and the percentage alert
#    wrote over a thousand lines about a disk that was fine. Below HAWA_DISK_CLEAN_GIB (40) free Hawa
#    cleans up after itself, at most hourly; below HAWA_DISK_ALERT_GIB (25) what is left is reported.
DISK_CLEAN_GIB="${HAWA_DISK_CLEAN_GIB:-40}"; DISK_ALERT_GIB="${HAWA_DISK_ALERT_GIB:-25}"; DISK_URGENT_GIB="${HAWA_DISK_URGENT_GIB:-10}"
disk_free_gib() { df -Pk "$DEPLOY_ROOT" | awk 'NR==2{printf "%d\n", $4/1048576}'; }
disk_used_pct() { df -P "$DEPLOY_ROOT" | awk 'NR==2{gsub("%","",$5); print $5}'; }
free_gib="$(disk_free_gib)"; [[ "$free_gib" =~ ^[0-9]+$ ]] || free_gib=9999
if [[ "$free_gib" -lt "$DISK_CLEAN_GIB" && "$MODE" != "--status" ]] && (( NOW - last_cleanup >= 3600 )); then
  mkdir -p "$HOME/.hawa/logs"
  { date -u +%FT%TZ; bash "$DEPLOY_ROOT/infra/ops/disk_cleanup.sh"; } >> "$HOME/.hawa/logs/disk_cleanup.log" 2>&1 || true
  last_cleanup="$NOW"; free_gib="$(disk_free_gib)"; [[ "$free_gib" =~ ^[0-9]+$ ]] || free_gib=9999
fi
disk_full=0
if [[ "$free_gib" -lt "$DISK_ALERT_GIB" ]] || [[ "$disk_was_full" == 1 && "$free_gib" -lt $((DISK_ALERT_GIB + 5)) ]]; then disk_full=1; fi
backup_problem="$(python3 "$ROOT/infra/backup/backup_status.py" --snapshots "$DEPLOY_ROOT/infra/backup/snapshots" 2>/dev/null)" \
  || problems+=("${backup_problem:-nightly backup status unavailable}")

if [[ ${#problems[@]} -eq 0 && "$disk_full" -eq 0 ]]; then
  say "healthy"
  [[ "$MODE" == "--status" ]] && exit 0
  # The outside service alerts when these pings stop (host_lib.sh, hawa_heartbeat).
  hawa_heartbeat "$PROD" || say "the outside heartbeat could not be reached"
  if [[ "$alerted" == 1 ]] && ! notify "✅ Hawa is back to normal ($(date '+%H:%M')). It was: ${last_msg:-a problem}"; then
    disk_was_full=0; save healthy; exit 0   # the recovery notice is tried again at the next pass
  fi
  last_msg=""; alerted=0; alerted_other=""; alert_key=""; disk_was_full=0; save healthy; exit 0
fi

if [[ "$disk_full" -eq 1 ]]; then
  used="$(disk_used_pct)"
  # macOS df prints 12Gi, GNU df 12G.
  free="$(df -h "$DEPLOY_ROOT" | awk 'NR==2{print $4}' | sed -E 's/Ti$/ TB/; s/Gi$/ GB/; s/Mi$/ MB/; s/([0-9])T$/\1 TB/; s/([0-9])G$/\1 GB/; s/([0-9])M$/\1 MB/')"
  # Both sources may fail (Docker down, no archive folder yet): the alert still goes, with "?".
  # The trailing slash follows the link a release has to the shared backups (ADR-158).
  backups="$( { du -sch "$DEPLOY_ROOT/infra/backup/snapshots/" "$HOME/.hawa/snapshots_archive" 2>/dev/null || true; } | tail -1 | cut -f1 | tr -d ' ' | sed -E 's/G$/ GB/; s/M$/ MB/')"
  cache="$( { docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null || true; } | awk '/^Build Cache/{print $3}' | sed -E 's/([0-9])([KMGT]B)$/\1 \2/')"
  # The file store (ADR-035): client photos and design sources, deleted only by the collector.
  files="$( { du -sh "${HAWA_BLOBS_DIR:-$HOME/.hawa/blobs}" 2>/dev/null || true; } | cut -f1 | tr -d ' ' | sed -E 's/G$/ GB/; s/M$/ MB/; s/K$/ KB/')"
  if [[ "$HAWA_HOST_OS" == Darwin ]]; then where_hint="System Settings, General, Storage"; else where_hint="sudo du -xh --max-depth=2 / | sort -h | tail shows where it went"; fi
  disk_msg="The production host's disk has ${free} free (${used}% used; the alert is below ${DISK_ALERT_GIB} GB). Hawa has already cleaned up after itself: its backups take ${backups:-?}, its stored pictures and design files ${files:-0} and Docker's build cache ${cache:-?}. The rest is other files on this host, so please free some space (${where_hint})."
fi
if [[ ${#problems[@]} -eq 0 ]]; then
  # Only the disk: a reminder every 6 hours, hourly below 10 GiB, instead of every 30 minutes.
  say "PROBLEM: disk ${free_gib} GiB free"
  [[ "$MODE" == "--status" ]] && exit 1
  if [[ -n "$alerted_other" ]]; then
    # What the last red alert named has cleared; without this the next word would be hours away.
    if notify "✅ Back to normal apart from the disk ($(date '+%H:%M')). It was: ${alerted_other}. The disk still has only ${free} free."; then alerted_other=""; alert_key=""; fi
  fi
  last_msg="disk ${free_gib} GiB free"; disk_was_full=1
  every=21600; [[ "$free_gib" -ge "$DISK_URGENT_GIB" ]] || every=3600
  if (( NOW - last_disk_alert >= every )); then
    notify "💾 ${disk_msg} Next reminder in $(( every / 3600 )) h." && last_disk_alert="$NOW"; alerted=1
  fi
  save problem; exit 1
fi
msg="$(printf '%s; ' "${problems[@]}")"; say "PROBLEM: $msg"
[[ "$MODE" == "--status" ]] && exit 1
last_msg="${msg%; }${disk_msg:+; disk ${free_gib} GiB free}"; disk_was_full="$disk_full"
if alert_due "${msg%; }"; then
  if notify "🔴 Hawa needs attention ($(date '+%H:%M')): ${msg%; }.${disk_msg:+ Also: ${disk_msg}}"; then
    last_alert="$NOW"; alert_key="$(problem_key "${msg%; }")"
    [[ -z "${disk_msg:-}" ]] || last_disk_alert="$NOW"
  fi
  alerted=1; alerted_other="${msg%; }"
fi
save problem; exit 1
