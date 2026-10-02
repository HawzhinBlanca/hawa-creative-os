#!/usr/bin/env bash
# Hawa Creative OS production deployment.
#
#   bash infra/docker/deploy.sh            # pre-flight only: configuration, gates, migrations dry check
#   bash infra/docker/deploy.sh --apply    # pre-flight, backup, migrate, build, start, verify health
#
# Never fabricates configuration: both infra/docker/.env.production (container variables) and
# infra/docker/.env (compose interpolation values) must exist and contain no placeholder values.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# The SHA-256 tool and the host role, chosen per host (ADR-141).
source "${ROOT_DIR}/infra/ops/host_lib.sh"
COMPOSE=(docker compose -f "${SCRIPT_DIR}/docker-compose.prod.yml")
[[ -f "${SCRIPT_DIR}/canva-release.override.yml" ]] && COMPOSE+=(-f "${SCRIPT_DIR}/canva-release.override.yml")
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
# Blue/green worker (architecture programme 0.1, ADR-034): the decisions are made by
# scripts/restate-bluegreen.ts (unit-tested); Restate's admin port is not published, so its calls
# are made by node inside the running Core container.
CORE_CONTAINER="hawa-production-core-1"
LEGACY_WORKER_CONTAINER="hawa-production-worker-1"
bluegreen() { (cd "$ROOT_DIR" && npx tsx scripts/restate-bluegreen.ts "$@" --via-container "$CORE_CONTAINER"); }
core_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$CORE_CONTAINER" 2>/dev/null || true)" == "true" ]]; }
# Stops and removes the container of a colour whose Restate deployment has drained and been deleted.
# Its deployment is already gone, so a container that will not stop is reported, not fatal: the deploy
# goes on to its health check, and the watchdog and the next deploy see the leftover.
stop_worker_slot() {
  local ok=1
  case "$1" in
    blue|green) "${COMPOSE[@]}" --env-file "$INTERP_FILE" rm -sf "worker-$1" >/dev/null 2>&1 || ok=0 ;;
    # The single `worker` service of every deploy before blue/green; it is no longer in the compose file.
    legacy) docker stop "$LEGACY_WORKER_CONTAINER" >/dev/null 2>&1 || true; docker rm "$LEGACY_WORKER_CONTAINER" >/dev/null 2>&1 || true ;;
  esac
  if [[ $ok == 1 ]]; then echo "✓ stopped the drained ${1} worker"; else echo "! the ${1} worker's Restate deployment was deleted but its container could not be removed; remove it by hand (infra/docker/README.md)"; fi
}
# Reads finish-drains output: stops what was deleted, reports what is still draining or kept.
report_drains() {
  local line slot
  while IFS= read -r line; do
    case "$line" in
      deleted=*) stop_worker_slot "${line#deleted=}" ;;
      draining=*) slot="${line#draining=}"
        echo "! the ${slot%%:*} worker still has ${slot#*:} invocation(s) pinned to it and keeps running; new work already goes to the live colour, and the next deploy finishes this drain first" ;;
      kept=*) slot="${line#kept=}"
        echo "! the ${slot%%:*} worker's deployment was kept and its container keeps running: ${slot#*:}" ;;
    esac
  done <<< "$1"
}
# A drain an earlier deploy left running is finished before this deploy replaces anything: the colour
# it drains is the one this deploy would replace, and replacing it with invocations still pinned to it
# would replay them on new code. A drained colour is removed; if the idle colour has not drained, stop.
PREVIOUS_DRAINS_DONE=0
finish_previous_drains() {
  local out rc=0
  out="$(bluegreen finish-drains --wait-seconds "${HAWA_PREVIOUS_DRAIN_WAIT_SECONDS:-600}" --require-drained "$1")" || rc=$?
  report_drains "$out"
  if [[ $rc == 3 ]]; then
    echo "ERROR: a worker from an earlier deploy is still registered with Restate ($(tr '\n' ' ' <<< "$out")), so no worker was changed: replacing the ${1} colour now would replay what is pinned to it on new code, and the old single worker runs its outbox with no colour gate."
    echo "       draining=<colour>:<n>: n invocations are still pinned to it. Running ones finish by themselves; a paused one never does: resume or cancel it (restate invocations list --status paused, then resume or cancel; or the Restate UI). Then deploy again."
    echo "       kept=<colour>:<reason>: a service is still routed to it, or its delete failed; see infra/docker/README.md."
    exit 1
  fi
  [[ $rc == 0 ]] || { echo "ERROR: could not read Restate's deployments (exit ${rc}); no worker was changed"; exit 1; }
  PREVIOUS_DRAINS_DONE=1
}
# The first blue/green deploy leaves the old single `worker` running, with no outbox gate, until what is
# pinned to it finishes. A paused or retrying invocation would keep it there indefinitely, beside the
# new colour's outbox consumer; so that deploy waits until there are none.
refuse_stuck_legacy() {
  [[ "$(sed -n 's/^live=//p' <<< "$1")" == "legacy" ]] || return 0
  local stuck; stuck="$(sed -n 's/^live_stuck=//p' <<< "$1")"
  [[ "$stuck" == "0" ]] && return 0
  echo "ERROR: the old single worker has ${stuck:-an unknown number of} paused or backing-off invocation(s) pinned to it. It would keep running its outbox, with no colour gate, until they finish, beside the new colour's. Resume or cancel them first (restate invocations list --status paused; the Restate UI), then deploy again. No worker was changed."
  exit 1
}
# Who asks Telegram for updates: the live worker colour, which hands each update to its chat's
# ChatInbox (Phase 2.1). Core has no poller since stage 2 of ADR-135, so Core's value is no longer held
# back while a new colour registers (ADR-129 finding 1): there is nothing to hand over.
# The value as the worker reads it (apps/worker/src/lifecycle/telegram-poller.ts).
telegram_poller_of() {
  if [[ "$(tr -d '[:space:]' <<< "${1:-}" | tr '[:upper:]' '[:lower:]')" == worker ]]; then echo worker; else echo core; fi
}
# ADR-135: HAWA_TELEGRAM_POLLER must be worker. Core no longer polls, so with any other value the new
# worker colours would not poll either and nobody would read client messages; a rollback to Core's
# poller would also start requests on the old path, which the owner ruled out. $1 is the value as
# compose interpolates it. Refused before any backup or change, in pre-flight too.
refuse_retired_poller() {
  [[ "$(telegram_poller_of "${1:-}")" == worker ]] && return 0
  echo "ERROR: HAWA_TELEGRAM_POLLER is '${1:-}', not worker. Core no longer polls Telegram (ADR-135): with this value nobody would read client messages. Set HAWA_TELEGRAM_POLLER=worker in infra/docker/.env; to roll back a broken worker poller, deploy the previous release. Nothing was changed."
  exit 1
}
# The image compose builds for a service, as verify_built_image resolves it.
compose_image_ref() {
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" --profile worker config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s).services[process.argv[1]];if(!v?.image)process.exit(2);process.stdout.write(v.image)})' "$1"
}
# The services a built worker image hosts, read from the image itself, without network: every build
# since Phase 2.1 has apps/worker/dist/services.js. "unknown" when it has no list or cannot be read.
image_hosts() {
  local ref hosts
  ref="$(compose_image_ref "$1" 2>/dev/null)" || { echo unknown; return 0; }
  hosts="$(docker run --rm --pull never --network none --entrypoint node "$ref" -e "import('/app/apps/worker/dist/services.js').then(m=>console.log((m.WORKER_SERVICE_NAMES||[]).join(','))).catch(()=>console.log(''))" 2>/dev/null)" || hosts=""
  if [[ "$hosts" =~ ^[A-Za-z][A-Za-z0-9_]*(,[A-Za-z][A-Za-z0-9_]*)*$ ]]; then echo "$hosts"; else echo unknown; fi
}
# Before step 7: a worker build that does not host every service Restate routes to the worker is
# refused while Core, the Desk and the worker still run the previous build. register's own --hosts
# check in 7b came after step 7 had replaced Core and the Desk (Phase 4 review of ADR-129).
refuse_split_worker_build() {
  local hosts out rc=0
  hosts="$(image_hosts "$1")"
  out="$(bluegreen check-hosts --hosts "$hosts" 2>&1)" || rc=$?
  if [[ $rc != 0 ]]; then
    echo "ERROR: $(tr '\n' ' ' <<< "$out")Nothing was started: Core, the Desk and the worker still run the previous build."
    exit 1
  fi
  echo "✓ the new worker build hosts every service Restate routes to the worker (${hosts})"
}
# The services the new colour's build hosts, from its /ready (listed since Phase 2.1), for register's
# check that it hosts everything Restate already routes to the worker (ADR-129, finding 2).
idle_hosts() {
  local hosts
  hosts="$(docker exec "hawa-production-worker-$1-1" node -e "fetch('http://localhost:9080/ready').then(r=>r.json()).then(j=>console.log(Array.isArray(j.services)?j.services.join(','):'')).catch(()=>console.log(''))" 2>/dev/null)" || hosts=""
  if [[ "$hosts" =~ ^[A-Za-z][A-Za-z0-9_]*(,[A-Za-z][A-Za-z0-9_]*)*$ ]]; then echo "$hosts"; else echo unknown; fi
}
# HAWA_WORKER_TOKEN is shared by Core and every worker colour, and a colour still draining keeps the
# value it was created with. A changed token therefore needs the old value as HAWA_WORKER_TOKEN_PREVIOUS
# until nothing runs with it any more (ADR-129, finding 4; docs/25_OPERATIONS_RUNBOOK.md). Values are
# compared in memory and never printed.
env_file_value() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<< "$v")"
}
container_env() {
  local env
  env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null)" || return 0
  printf '%s' "$(sed -n "s/^$2=//p" <<< "$env" | tail -1 | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
}
check_worker_token_rotation() {
  local current previous name held stale=() previous_used=0
  current="$(env_file_value HAWA_WORKER_TOKEN)"; previous="$(env_file_value HAWA_WORKER_TOKEN_PREVIOUS)"
  if [[ -n "$previous" && "$previous" == "$current" ]]; then
    echo "ERROR: HAWA_WORKER_TOKEN_PREVIOUS is the same as HAWA_WORKER_TOKEN in .env.production; set it to the value being replaced, or remove it. No container was changed."
    exit 1
  fi
  for name in $(docker ps --filter name=hawa-production- --filter status=running --format '{{.Names}}' 2>/dev/null | grep -E '^hawa-production-(core|worker(-blue|-green)?)-1$' || true); do
    held="$(container_env "$name" HAWA_WORKER_TOKEN)"
    [[ -n "$held" ]] || continue
    if [[ -n "$previous" && "$held" == "$previous" && "$name" != "$CORE_CONTAINER" ]]; then previous_used=1; fi
    [[ "$held" == "$current" || ( -n "$previous" && "$held" == "$previous" ) ]] || stale+=("${name#hawa-production-}")
  done
  if (( ${#stale[@]} )); then
    local list; list="$(IFS=,; echo "${stale[*]%-1}")"; list="${list//,/, }"
    echo "ERROR: ${list} run(s) with a HAWA_WORKER_TOKEN that is neither HAWA_WORKER_TOKEN nor HAWA_WORKER_TOKEN_PREVIOUS in .env.production. A colour still draining keeps its token, so a rotation first deploys with the old value as HAWA_WORKER_TOKEN_PREVIOUS, and removes it only once no worker runs with it (docs/25_OPERATIONS_RUNBOOK.md, Credential rotation). No container was changed."
    exit 1
  fi
  if [[ -n "$previous" && $previous_used == 0 ]]; then
    echo "NOTE: no running worker uses HAWA_WORKER_TOKEN_PREVIOUS any more; remove it from .env.production and deploy again to finish the rotation."
  fi
  return 0
}
# vector.yaml is a single-file bind mount like nginx.conf: compose does not recreate vector when only the
# file changed, and vector runs without --watch-config, so a changed pipeline never reached the running
# shipper (ADR-129, finding 6). The file is validated in a one-off container (bound from the candidate
# runtime copy) before anything starts. The runtime copy is rewritten in place, so the running vector
# already sees the new bytes but has not read them: it is restarted when vector.yaml changed, and when
# what it sees is not the deployed file (a mount pinned to a file that is gone), recreated if a restart
# does not fix that.
vector_seen() { "${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T vector sha256sum /etc/vector/vector.yaml 2>/dev/null | cut -d' ' -f1 || true; }
validate_vector_config() {
  HAWA_RUNTIME_DIR="$CANDIDATE_RUNTIME" "${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T vector validate --no-environment /etc/vector/vector.yaml >/dev/null 2>&1 \
    || { echo "ERROR: infra/docker/vector.yaml fails vector validate; nothing was started with it"; exit 1; }
}
apply_vector_config() {
  if [[ "$VECTOR_CHANGED" == 0 && "$(vector_seen)" == "$VECTOR_WANT" ]]; then echo "✓ vector runs the deployed vector.yaml (unchanged)"; return 0; fi
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" restart vector >/dev/null
  if [[ "$(vector_seen)" == "$VECTOR_WANT" ]]; then echo "✓ vector restarted onto the deployed vector.yaml"; return 0; fi
  echo "! vector does not see the deployed vector.yaml after a restart; recreating it"
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d --no-deps --force-recreate vector >/dev/null
  [[ "$(vector_seen)" == "$VECTOR_WANT" ]] || { echo "ERROR: vector does not see the deployed vector.yaml even after it was recreated"; exit 1; }
  echo "✓ vector recreated onto the deployed vector.yaml"
}
# ADR-141: only a production host deploys. A standby host (being prepared for a cutover) and a retired
# one (production moved away) refuse --apply before anything is changed: two live hosts would poll the
# same Telegram bot. Pre-flight still runs there (the rehearsal needs it) and records no volume stamp.
# $1 is the role hawa_host_role printed, $2 its exit status.
HOST_ROLE="production"
refuse_inactive_host() {
  local role="$1" rc="${2:-0}" where
  where="$(hawa_host_role_source)"
  if [[ "$rc" != 0 ]]; then
    echo "ERROR: unrecognised host role '${role}' in ${where}; expected production, standby or retired (infra/ops/host_lib.sh). Nothing was changed." >&2
    exit 1
  fi
  [[ "$role" == production ]] && return 0
  if [[ "$APPLY" == 1 ]]; then
    echo "ERROR: this host is marked ${role} (${where}): production runs on another host, and two live hosts would poll the same Telegram bot. Refusing to deploy; nothing was changed. To make this host production again, remove the marker (runbooks/10_backup_restore.md, Moving production to another host)." >&2
    exit 1
  fi
  echo "NOTE: this host is marked ${role} (${where}): pre-flight only, and no volume stamp is recorded."
}
# Durability of an external volume: it must exist, and its creation time must be the one recorded for
# this host. The stamps are host-local (ADR-141), in ${HAWA_VOLUME_STAMP_DIR:-~/.hawa/volume-stamps}:
# they were tracked in git with one Mac's times, so every other host refused to deploy. A host that
# still has the old repository file (infra/docker/.<kind>_volume_created, now untracked) adopts its
# value once. With no stamp at all the time is recorded and the deploy goes on, as before; on a standby
# or retired host nothing is recorded.
# $1 volume, $2 label (Postgres, Restate), $3 host-local stamp file, $4 legacy repository stamp file,
# $5 1 to record a missing stamp.
check_volume_stamp() {
  local volume="$1" label="$2" stamp="$3" legacy="$4" record="${5:-1}" created expected="" lower
  lower="$(tr '[:upper:]' '[:lower:]' <<< "$label")"
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "ERROR: ${label} volume '$volume' does not exist! Refusing to start or recreate." >&2
    exit 1
  fi
  created="$(docker volume inspect "$volume" --format '{{.CreatedAt}}')"
  if [[ -f "$stamp" ]]; then
    expected="$(tr -d '[:space:]' < "$stamp")"
  elif [[ -f "$legacy" ]]; then
    expected="$(tr -d '[:space:]' < "$legacy")"
    if [[ "$record" == 1 ]]; then
      mkdir -p "$(dirname "$stamp")" && chmod 700 "$(dirname "$stamp")"
      printf '%s\n' "$expected" > "$stamp" && chmod 600 "$stamp"
      echo "✓ ${lower} volume stamp adopted once from ${legacy#"$ROOT_DIR"/} into ${stamp} (ADR-141); the repository file is no longer read"
    fi
  fi
  if [[ -n "$expected" ]]; then
    if [[ "$created" != "$expected" ]]; then
      echo "ERROR: ${label} volume creation timestamp changed! Expected: '$expected', Got: '$created'. Refusing deployment to prevent data loss." >&2
      exit 1
    fi
  elif [[ "$record" == 1 ]]; then
    mkdir -p "$(dirname "$stamp")" && chmod 700 "$(dirname "$stamp")"
    printf '%s\n' "$created" > "$stamp" && chmod 600 "$stamp"
    echo "✓ ${lower} volume stamp recorded for this host in ${stamp}"
  else
    echo "NOTE: no ${lower} volume stamp for this host, and none recorded (host role ${HOST_ROLE})"
  fi
  echo "✓ ${lower} volume '$volume' verified (created at ${created})"
}
# The running build must be able to say which commit it is (GET /v1/system/cutover/status).
# Unstamped deployments are strictly refused.
if [[ -n "${HAWA_BUILD_COMMIT+x}" ]]; then
  BUILD_COMMIT="$HAWA_BUILD_COMMIT"
else
  BUILD_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
fi
if [[ -z "$BUILD_COMMIT" || "$BUILD_COMMIT" == "unknown" ]]; then
  echo "ERROR: HAWA_BUILD_COMMIT is unknown or unset. Unstamped deployments are strictly refused." >&2
  exit 1
fi
CHECKOUT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
if [[ ! "$BUILD_COMMIT" =~ ^[0-9a-f]{40}$ || "$BUILD_COMMIT" != "$CHECKOUT_COMMIT" ]]; then
  echo "ERROR: HAWA_BUILD_COMMIT must equal this checkout's HEAD (${CHECKOUT_COMMIT:-unknown}); refusing a mislabeled deployment." >&2
  exit 1
fi
export HAWA_BUILD_COMMIT="$BUILD_COMMIT"
# A deployment never drops a release someone else put live (release_lib.sh, hawa_deploy_keeps_live).
if [[ "${HAWA_RELEASE_DIRS:-on}" != off ]]; then
  source "${ROOT_DIR}/infra/ops/release_lib.sh"
  hawa_deploy_keeps_live "$ROOT_DIR" "$BUILD_COMMIT" || exit 1
fi

# Compose tags are mutable. Inspect the just-built image itself before starting Core/Desk or
# switching Restate to a new worker. The deployment receipt will later record these image IDs.
verify_built_image() {
  local service="$1" ref label image_id
  ref="$("${COMPOSE[@]}" --env-file "$INTERP_FILE" --profile worker config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const v=JSON.parse(s).services[process.argv[1]];if(!v?.image)process.exit(2);process.stdout.write(v.image)})' "$service")" \
    || { echo "ERROR: could not resolve the built ${service} image reference" >&2; exit 1; }
  image_id="$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)"
  label="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref" 2>/dev/null || true)"
  if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ || "$label" != "$BUILD_COMMIT" ]]; then
    echo "ERROR: ${service} image ${ref} has identity ${image_id:-missing} and revision ${label:-missing}; expected revision ${BUILD_COMMIT}." >&2
    exit 1
  fi
  echo "✓ ${service} image ${image_id} carries checkout revision ${label}"
}

# Enforce clean working tree (Step 2: No uncommitted deployments)
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain 2>/dev/null)" ]]; then
  if [[ "${ALLOW_DIRTY_DEPLOY:-0}" != "1" ]]; then
    echo "ERROR: Working tree has uncommitted modifications! Refusing deployment from dirty checkout." >&2
    echo "Commit your changes or stash them before deploying." >&2
    git -C "$ROOT_DIR" status --short >&2
    exit 1
  fi
fi

echo "=== Hawa Creative OS production deployment ($([[ $APPLY == 1 ]] && echo apply || echo pre-flight)) ==="
echo "Build stamp: ${HAWA_BUILD_COMMIT}"
HOST_ROLE_RC=0; HOST_ROLE="$(hawa_host_role)" || HOST_ROLE_RC=$?
refuse_inactive_host "$HOST_ROLE" "$HOST_ROLE_RC"
# ADR-240: an applying deploy holds the deploy lock (infra/ops/deploy_lock.py) for its whole run, the
# release's own run included (the lock is inherited). It waits for a nightly live canary in progress
# (HAWA_DEPLOY_LOCK_WAIT seconds, 1800 by default), and the canary never starts while a deploy holds it.
# The script runs again from the top under the lock.
if [[ "$APPLY" == 1 && "${HAWA_DEPLOY_LOCK_HELD:-}" != 1 ]]; then
  exec python3 "${ROOT_DIR}/infra/ops/deploy_lock.py" --wait "${HAWA_DEPLOY_LOCK_WAIT:-1800}" -- bash "${BASH_SOURCE[0]}" "$@"
fi

# 0. The release directory (ADR-158). Production never runs from the checkout this was started in (on
# 2026-09-30 that was /Users/hawzhin/Hawdesign, on another tool's branch): the commit gets its own
# detached worktree, ~/.hawa/releases/<commit>, linked to the host-local files in ~/.hawa/shared,
# installed and built there, and this script continues from that copy. Everything below, pre-flight
# included, reads that release's files; step 7 points ~/.hawa/current at it just before its containers
# start. HAWA_RELEASE_DIRS=off runs from this checkout as before (a host not yet switched over).
source "${ROOT_DIR}/infra/ops/release_lib.sh"
if [[ "${HAWA_RELEASE_DIRS:-on}" != off ]]; then
  python3 "${ROOT_DIR}/infra/ops/prepare_service_boundaries.py" --directory "$(hawa_shared_dir)/infra/docker" || exit 1
  RUNTIME_SHARED="$(hawa_shared_dir)"
  RELEASE_DIR="$(hawa_release_prepare "$ROOT_DIR" "$BUILD_COMMIT")" || exit 1
  hawa_release_install "$RELEASE_DIR" || exit 1
  if [[ "$(hawa_physical "$ROOT_DIR")" != "$(hawa_physical "$RELEASE_DIR")" ]]; then
    echo "✓ release directory ${RELEASE_DIR} (from ${ROOT_DIR}); continuing there"
    exec bash "${RELEASE_DIR}/infra/docker/deploy.sh" "$@"
  fi
  echo "✓ running from release directory ${RELEASE_DIR}"
else
  # The office proof is written into this checkout, and copied from here into the runtime directory.
  python3 "${ROOT_DIR}/infra/ops/prepare_service_boundaries.py" --directory "${ROOT_DIR}/infra/docker" || exit 1
  RUNTIME_SHARED="$ROOT_DIR"
  echo "NOTE: HAWA_RELEASE_DIRS=off: running from ${ROOT_DIR} itself, not a release directory"
fi

# 1. Prerequisites
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose is required"; exit 1; }

# 1b/1c. Volume durability: each external volume must exist and keep the creation time recorded for
# this host (check_volume_stamp).
VOLUME_STAMP_DIR="${HAWA_VOLUME_STAMP_DIR:-${HOME}/.hawa/volume-stamps}"
RECORD_STAMPS=1; [[ "$HOST_ROLE" == production ]] || RECORD_STAMPS=0
check_volume_stamp hawa-production_postgres_data Postgres "${VOLUME_STAMP_DIR}/hawa-production_postgres_data.created" "${SCRIPT_DIR}/.postgres_volume_created" "$RECORD_STAMPS"
check_volume_stamp hawa-production_restate_data Restate "${VOLUME_STAMP_DIR}/hawa-production_restate_data.created" "${SCRIPT_DIR}/.restate_volume_created" "$RECORD_STAMPS"


# 2. Configuration must exist and must be real
ENV_FILE="${SCRIPT_DIR}/.env.production"
INTERP_FILE="${SCRIPT_DIR}/.env"
for f in "$ENV_FILE" "$INTERP_FILE"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f is missing. Copy the matching .example file and fill in real values; this script never invents configuration."
    exit 1
  fi
  if grep -qE "REPLACE_WITH|replace_with" "$f"; then
    echo "ERROR: $f still contains placeholder values:"; grep -nE "REPLACE_WITH|replace_with" "$f" | sed -E 's/=.*/=…/'
    exit 1
  fi
done
for key in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET HAWA_ACTION_HMAC_SECRET HAWA_ADMIN_KEY HAWA_BEARER_TOKEN CANVA_TOKEN_ENCRYPTION_KEY ANTHROPIC_API_KEY; do
  grep -qE "^${key}=.{8,}" "$ENV_FILE" || { echo "ERROR: ${key} is not set in .env.production"; exit 1; }
  [[ "$(grep -cE "^${key}=" "$ENV_FILE")" == "1" ]] || { echo "ERROR: ${key} appears more than once in .env.production (the last line wins silently)"; exit 1; }
done
for key in POSTGRES_PASSWORD DATABASE_URL; do
  grep -qE "^${key}=.{8,}" "$INTERP_FILE" || { echo "ERROR: ${key} is not set in infra/docker/.env"; exit 1; }
done
echo "✓ configuration present, no placeholders, no duplicate credential lines"

# 2b. The cut-out service's model files (ADR-032) live on the host, outside the repository, and are
# mounted read-only. The service refuses a file whose sha256 differs from the one pinned in compose.
MODELS_DIR="${HAWA_MODELS_DIR:-${HOME}/.hawa/models}"
for model in BiRefNet-portrait-epoch_150.onnx face_detection_yunet_2023mar.onnx; do
  [[ -s "${MODELS_DIR}/${model}" ]] || { echo "ERROR: ${MODELS_DIR}/${model} is missing (see adrs/032_photo_cutouts_and_request_ledger.md)"; exit 1; }
done
echo "✓ cut-out model files present in ${MODELS_DIR}"

# The value compose itself interpolates: the shell's, else infra/docker/.env's, else the default.
# Reading only the shell would let the directory made here, or the port probed below, drift from the
# ones the containers get when .env sets them. A leading ${HOME} or $HOME in .env is expanded as compose does.
compose_value() {
  local v="${!1:-}"
  [[ -n "$v" ]] || v="$(grep -E "^$1=" "$INTERP_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"
  case "$v" in '${HOME}'*) v="${HOME}${v#'${HOME}'}" ;; '$HOME'*) v="${HOME}${v#'$HOME'}" ;; esac
  printf '%s' "${v:-$2}"
}
node --import tsx "${ROOT_DIR}/scripts/check_office_access.ts" "$ENV_FILE" "$(compose_value HAWA_BIND_IP 127.0.0.1)"
# 2c. The content-addressed file store (ADR-035) is a host directory bind-mounted into Core, both worker
# colours (read-only) and nginx (read-only). It is created here, before any container starts, with the
# marker the store requires: Docker would otherwise create a missing mount source itself, and the store
# refuses a directory without the marker, so a mount that went wrong cannot fill an empty directory.
# Files are 0444 and directories 0755, which nginx's own user needs to read them.
BLOBS_DIR="$(compose_value HAWA_BLOBS_DIR "${HOME}/.hawa/blobs")"
# The files compose binds into nginx, vector and postgres (ADR-158, addendum 3): a real directory, never
# switched or pruned, rewritten in place from this release just before `up -d` (hawa_runtime_sync). The
# candidate beside it holds the same files for the one-off checks, so a broken file never reaches it.
export HAWA_RUNTIME_DIR; HAWA_RUNTIME_DIR="$(compose_value HAWA_RUNTIME_DIR "${HOME}/.hawa/runtime")"
CANDIDATE_RUNTIME="${HAWA_RUNTIME_DIR}.candidate"
ensure_blob_store() {
  install -d -m 0755 "$1" "$1/sha256" "$1/tmp"
  if [[ ! -f "$1/.hawa-blob-store" ]]; then
    printf 'sha256-v1\n' > "$1/.hawa-blob-store.new" && chmod 0644 "$1/.hawa-blob-store.new" && mv -f "$1/.hawa-blob-store.new" "$1/.hawa-blob-store"
  fi
  [[ "$(cat "$1/.hawa-blob-store")" == "sha256-v1" ]] || { echo "ERROR: $1/.hawa-blob-store is not a sha256-v1 store marker"; return 1; }
}
# After the stack is up: nginx must not serve /_blobs/ to anyone (it is `internal`, reached only by
# Core's X-Accel-Redirect after Core has authorised the request), and Core must see the store.
check_blob_store_private() {
  local code port
  port="$(compose_value HAWA_PORT 8080)"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${port}/_blobs/.hawa-blob-store" || true)"
  [[ "$code" == 404 ]] || { echo "ERROR: /_blobs/ answered ${code:-nothing} to a direct request; it must be internal to nginx (infra/docker/nginx.conf)"; return 1; }
  docker exec "$CORE_CONTAINER" test -f /var/lib/hawa/blobs/.hawa-blob-store \
    || { echo "ERROR: Core does not see the file store at /var/lib/hawa/blobs (the bind mount of ${BLOBS_DIR})"; return 1; }
  echo "✓ file store mounted in Core, and /_blobs/ is not reachable from outside"
}

# 3. Compose topology with the real interpolation file
"${COMPOSE[@]}" --env-file "$INTERP_FILE" config --quiet
echo "✓ compose topology valid"
# 3b. Only the worker polls Telegram (ADR-135).
refuse_retired_poller "$(compose_value HAWA_TELEGRAM_POLLER worker)"
echo "✓ Telegram is polled by the worker"

# 4. Repository gates
(cd "$ROOT_DIR" && python3 infra/security/security_scan.py --self-test >/dev/null && python3 infra/security/security_scan.py >/dev/null)
echo "✓ secret gate"
(cd "$ROOT_DIR" && python3 scripts/validate_pack.py >/dev/null)
echo "✓ blueprint pack"
# Plaintext credential material on this host outside git: listed, and refused when readable by others
bash "${ROOT_DIR}/infra/security/local_state_audit.sh"

# Engineering release preflight; product admission is evaluated on deployed artifacts later.
bash "${ROOT_DIR}/scripts/enforce_release_gate.sh"
echo "✓ engineering release preflight verified; product admission remains separate"

# Where the worker would go (read-only; needs the running Core container to reach Restate).
if core_running; then
  if PLAN="$(bluegreen plan 2>&1)"; then echo "✓ worker: $(tr '\n' ' ' <<< "$PLAN")"; else echo "! could not read the live worker colour: ${PLAN}"; fi
fi

if [[ $APPLY == 0 ]]; then
  echo ""
  echo "Pre-flight complete. Apply with: bash infra/docker/deploy.sh --apply"
  exit 0
fi

# 4b. An earlier deploy's drain is finished first (see finish_previous_drains). Core must be running to
# reach Restate; on a stack that is down this happens in 7b instead.
PLAN_IDLE=""
if core_running; then
  PLAN="$(bluegreen plan)" || { echo "ERROR: could not read the live worker colour from Restate"; exit 1; }
  refuse_stuck_legacy "$PLAN"
  PLAN_IDLE="$(sed -n 's/^idle=//p' <<< "$PLAN")"
  finish_previous_drains "$PLAN_IDLE"
fi
# 4c. A changed worker token needs its previous value while any worker still runs with it (ADR-129).
check_worker_token_rotation

ensure_blob_store "$BLOBS_DIR" || exit 1
echo "✓ file store ready at ${BLOBS_DIR}"

# 5. Backup before anything changes
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$INTERP_FILE" | cut -d= -f2-)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077   # dumps hold briefs, chat ids and sealed tokens: owner-only from the first byte
BACKUP_DIR="${ROOT_DIR}/infra/backup/snapshots"; mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
# --no-recreate: start Postgres if it is down, but never replace it here. A changed definition (a new
# command, or new bind paths into ~/.hawa/runtime, whose files are replaced only in step 7) is applied by
# the full `up -d` after the switch; recreating it here started it before current existed, and Docker
# made the missing init files as empty directories (2026-09-30).
# A container created before its bind sources exist gets empty directories in their place, and keeps
# them: the files the runtime directory does not have yet are copied first (only those; the rest are
# replaced in step 7 once checked).
hawa_runtime_sync "$ROOT_DIR" "$HAWA_RUNTIME_DIR" "$RUNTIME_SHARED" missing >/dev/null \
  || { echo "ERROR: could not seed ${HAWA_RUNTIME_DIR} with the files compose binds; nothing was started"; exit 1; }
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d --no-recreate postgres
until docker exec hawa-production-postgres-1 pg_isready -U hawa_owner -d hawa >/dev/null 2>&1; do sleep 1; done
# Custom format with zstd's long-distance matching: a dump repeats the same images many times, so it
# is about 40 MB instead of 550 MB of plain SQL, in a second instead of thirteen. Restore it with
# pg_restore (docs/25_OPERATIONS_RUNBOOK.md, Backups). disk_cleanup.sh keeps the newest ten.
# It is written as .partial and takes its name only once checked: a dump that failed used to keep its
# name, and the next cleanup counted it as one of the ten and removed a good one to make room.
BACKUP="${BACKUP_DIR}/predeploy_${STAMP}.dump"; PARTIAL="${BACKUP}.partial"
backup_failed() { rm -f "$PARTIAL" "$BACKUP.sha256"; echo "ERROR: $1"; exit 1; }
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" hawa-production-postgres-1 pg_dump -U hawa_owner -Fc --compress=zstd:long hawa > "$PARTIAL" \
  || backup_failed "pg_dump did not finish"
BACKUP_BYTES="$(wc -c < "$PARTIAL" | tr -d ' ')"
[[ "$BACKUP_BYTES" -gt 100000 ]] || backup_failed "the backup is only ${BACKUP_BYTES} bytes"
docker exec -i hawa-production-postgres-1 pg_restore --list < "$PARTIAL" >/dev/null \
  || backup_failed "the backup's table of contents cannot be read"
{ "${HAWA_SHA256[@]}" "$PARTIAL" | awk '{print $1}' > "$BACKUP.sha256" && mv -f "$PARTIAL" "$BACKUP"; } \
  || backup_failed "the backup could not be recorded"
echo "✓ backup written: infra/backup/snapshots/predeploy_${STAMP}.dump (${BACKUP_BYTES} bytes)"

# 6. Versioned schema upgrades (idempotent; checksums of applied files are verified)
(cd "$ROOT_DIR" && DATABASE_URL="postgresql://hawa_owner:${POSTGRES_PASSWORD}@127.0.0.1:54332/hawa" npx tsx packages/db/src/upgrade.ts)
echo "✓ schema upgrades applied or verified"
# Rotation follows the qualified source gate, completed prior drains and the backup/migrations.
if [[ "${HAWA_RELEASE_DIRS:-on}" != off ]]; then
  hawa_release_prune_unsafe "$ROOT_DIR" 74618004243affaa91fc50795490e175a545dc2a || exit 1
fi

# 7. Build and start everything but the worker. Its two colours are behind the `worker` compose
# profile, so the `up -d` below never creates, recreates or stops either; 7b deploys the worker.
# The idle colour's image is built here too when 4b could name the colour, so a worker build that fails
# (no registry, say) stops the deploy before Core is replaced next to the old worker (ADR-129).
BUILD_SERVICES=(core desk cutout)
[[ -z "$PLAN_IDLE" ]] || BUILD_SERVICES+=("worker-${PLAN_IDLE}")
"${COMPOSE[@]}" --env-file "$INTERP_FILE" build "${BUILD_SERVICES[@]}"
verify_built_image core
verify_built_image desk
[[ -z "$PLAN_IDLE" ]] || verify_built_image "worker-${PLAN_IDLE}"
[[ -z "$PLAN_IDLE" ]] || refuse_split_worker_build "worker-${PLAN_IDLE}"
# The cut-out engine's own tests, run in the image that ships, against the pinned model.
docker run --rm --memory 12g -e HAWA_MODELS_DIR=/models -v "${MODELS_DIR}:/models:ro" \
  -v "${ROOT_DIR}/services/cutout/tests:/app/tests:ro" hawa-cutout:1 python -m unittest discover -s /app/tests -q \
  || { echo "ERROR: the cut-out service's tests failed in its image"; exit 1; }
echo "✓ cut-out engine tests passed in the shipped image"
# The files compose binds (ADR-158, addendum 3). This release's nginx.conf, vector.yaml and init files,
# with the office proof prepare_service_boundaries.py wrote, are copied into a fresh candidate directory
# laid out like ~/.hawa/runtime, and checked there by one-off containers of the same images with the same
# mounts (HAWA_RUNTIME_DIR points them at the candidate): nginx -t, with the proof it includes, and vector
# validate. Only then are those exact bytes copied into ~/.hawa/runtime, in place, just before `up -d`.
stage_runtime_candidate() {
  case "$CANDIDATE_RUNTIME" in *.candidate) rm -rf "$CANDIDATE_RUNTIME" ;; esac
  hawa_runtime_sync "$ROOT_DIR" "$CANDIDATE_RUNTIME" "$RUNTIME_SHARED" >/dev/null \
    || { echo "ERROR: could not stage the files compose binds (the office proof comes from ${RUNTIME_SHARED}/infra/docker/.office-proxy-header.conf); nothing was started"; exit 1; }
  HAWA_RUNTIME_DIR="$CANDIDATE_RUNTIME" "${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T nginx nginx -t >/dev/null 2>&1 \
    || { echo "ERROR: infra/docker/nginx.conf (with the office proof) fails nginx -t; nothing was started with it"; exit 1; }
}
stage_runtime_candidate
validate_vector_config
# ADR-183: separate worker identities, after the gates, the backup and the migrations.
BOUNDARY_DIR="${ROOT_DIR}/infra/docker"
[[ "${HAWA_RELEASE_DIRS:-on}" == off ]] || BOUNDARY_DIR="$(hawa_shared_dir)/infra/docker"
python3 "${ROOT_DIR}/infra/ops/prepare_service_boundaries.py" --directory "$BOUNDARY_DIR" --rotate-design || exit 1
(cd "$ROOT_DIR" && DATABASE_URL="postgresql://hawa_owner:${POSTGRES_PASSWORD}@127.0.0.1:54332/hawa" npx tsx scripts/provision_worker_database.ts "${SCRIPT_DIR}/.env.worker-db" --production) || exit 1
: > "$BOUNDARY_DIR/.worker-identity-v2"
chmod 600 "$BOUNDARY_DIR/.worker-identity-v2"
# That preparation may have rewritten the office proof: nginx must get the proof Core will expect, checked.
if ! cmp -s "${RUNTIME_SHARED}/infra/docker/.office-proxy-header.conf" "${CANDIDATE_RUNTIME}/infra/docker/.office-proxy-header.conf"; then
  echo "! the office proof changed while the service boundaries were prepared; checking nginx with the new one"
  stage_runtime_candidate
fi
RUNTIME_CHANGED="$(hawa_runtime_sync "$CANDIDATE_RUNTIME" "$HAWA_RUNTIME_DIR" "$CANDIDATE_RUNTIME")" \
  || { echo "ERROR: could not copy the checked files into ${HAWA_RUNTIME_DIR}; nothing was started with them"; exit 1; }
rm -rf "$CANDIDATE_RUNTIME"
echo "✓ ${HAWA_RUNTIME_DIR} holds this release's bound files$([[ -n "$RUNTIME_CHANGED" ]] && printf ' (changed: %s)' "$(sed 's/^changed //' <<< "$RUNTIME_CHANGED" | tr '\n' ' ' | sed 's/ $//')")"
VECTOR_CHANGED=0; grep -qx 'changed infra/docker/vector.yaml' <<< "$RUNTIME_CHANGED" && VECTOR_CHANGED=1
VECTOR_WANT="$("${HAWA_SHA256[@]}" "${HAWA_RUNTIME_DIR}/infra/docker/vector.yaml" | cut -d' ' -f1)"
# ADR-183's live-mount check, against what nginx binds: the runtime copies. nginx is reloaded after up -d
# only once it sees both files and passes nginx -t inside; otherwise restarted, then recreated (a mount
# pinned to a replaced inode), and the deploy stops if it still does not see them (infra/ops/nginx_reload.sh).
NGINX_WANT="$("${HAWA_SHA256[@]}" "${HAWA_RUNTIME_DIR}/infra/docker/nginx.conf" | cut -d' ' -f1)"
OFFICE_PROOF_WANT="$("${HAWA_SHA256[@]}" "${HAWA_RUNTIME_DIR}/infra/docker/.office-proxy-header.conf" | cut -d' ' -f1)"
source "${ROOT_DIR}/infra/ops/nginx_reload.sh"
# ADR-158: from here production is this release. ~/.hawa/current is switched in one rename, so the
# watchdog and the launch agents run this release's scripts from their next run on; ~/.hawa/previous
# names the release before it (the rollback: deploy that one). No container binds through it.
if [[ "${HAWA_RELEASE_DIRS:-on}" != off ]]; then
  hawa_release_activate "$ROOT_DIR" || { echo "ERROR: could not point $(hawa_current_link) at ${ROOT_DIR}; nothing was started"; exit 1; }
  echo "✓ $(hawa_current_link) -> ${ROOT_DIR}"
fi
# The first deploy with the runtime directory recreates nginx, vector and postgres once: their bind
# sources change from ~/.hawa/current/... to ~/.hawa/runtime/... (runbooks/PRODUCTION_RELEASE_DIRECTORIES.md).
HAWA_TELEGRAM_POLLER=worker "${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d
hawa_nginx_reload || exit 1
apply_vector_config
echo "✓ containers started"

# 7b. The worker, blue/green (architecture programme 0.1, ADR-034). Restate pins each invocation to the
# deployment that started it, and a deployment is an address. This step used to replace the one worker
# container behind http://worker:9080 and re-register it with a force:true fallback, so a design in
# flight replayed on the new code (RT0016). Now the new build goes to the colour that is not live, at
# its own address. Registering it (force:false, no fallback) sends new work there, while invocations
# already running finish on the old colour. Once nothing is pinned to the old deployment it is deleted
# and its container stopped; a drain still running at the timeout is left running and reported, and
# the next deploy finishes it first (4b). The registry lives in the restate_data volume and nothing
# else creates it (after that volume was recreated on 2026-09-17, every task failed with "service
# 'TaskWorkflow' not found" for 23 hours), so a Restate that holds no worker at all gets blue. The first
# deploy after this change drains the single `worker` service the same way.
PLAN="$(bluegreen plan)" || { echo "ERROR: could not read the live worker colour from Restate"; exit 1; }
LIVE="$(sed -n 's/^live=//p' <<< "$PLAN")"; IDLE="$(sed -n 's/^idle=//p' <<< "$PLAN")"
echo "worker: live colour ${LIVE}, deploying to ${IDLE}"
refuse_stuck_legacy "$PLAN"
[[ $PREVIOUS_DRAINS_DONE == 1 ]] || finish_previous_drains "$IDLE"
if [[ "$IDLE" != "$PLAN_IDLE" ]]; then
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" build "worker-${IDLE}"
  verify_built_image "worker-${IDLE}"
fi
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d --no-deps --force-recreate "worker-${IDLE}"
# Core's health, dependency by dependency (not just HTTP 200). A dependency Core reaches over the
# internet (Telegram, Canva, the model provider) reading 'unreachable' is usually this Mac's own
# connection dropping for a moment, not the release: it is asked again for up to a minute, and if the
# internet is still out the deploy ends with a warning, because the new release is already live and
# failing here would roll nothing back. Every other bad value (a credential refused, Postgres or
# Restate not connected, a circuit open) still fails the deploy once the retries are spent.
verify_core_health() {
  local attempt rc=0 i
  local attempts="${HAWA_HEALTH_ATTEMPTS:-6}"
  for attempt in $(seq 1 "$attempts"); do
    HEALTH=""
    for i in $(seq 1 30); do
      if HEALTH="$(curl -fsS -m 5 http://127.0.0.1:8080/v1/health 2>/dev/null)"; then break; fi
      HEALTH=""
      sleep 2
    done
    [[ -n "${HEALTH:-}" ]] || { echo "ERROR: core health did not answer within 60 s"; return 1; }
    rc=0
    echo "$HEALTH" | python3 -c '
import json,sys
h=json.load(sys.stdin); d=h.get("dependencies",{})
external={"telegramApi","canva","modelProvider"}
bad=[k for k,v in d.items() if v in ("unauthorized","unreachable","disconnected","read_only","outage","unregistered")]
print("health:", h.get("status"), json.dumps(d))
if not bad: sys.exit(0)
offline=[k for k in bad if k in external and d[k]=="unreachable"]
sys.exit(3 if offline==bad else 1)
' || rc=$?
    [[ $rc == 0 ]] && return 0
    [[ $attempt == "$attempts" ]] && break
    echo "! health not clean yet (attempt ${attempt} of ${attempts}); asking again in 10 s"
    sleep 10
  done
  if [[ $rc == 3 ]]; then
    echo "! WARNING: only internet services are unreachable (above). The release is live; check this Mac's internet connection."
    return 0
  fi
  echo "ERROR: unhealthy dependencies (above)"
  return 1
}

# The new colour is removed only when Restate holds no deployment at its address. A registration can be
# accepted even when its answer was lost or the check after it failed, and then Restate already sends
# new work to this container: removing it would leave every task pointing at a container that is gone,
# and the old colour's outbox would stand down too. So Restate is asked, and anything but "holds
# nothing there" keeps both colours running and stops the deploy for a person.
abandon_idle() {
  local held rc=0
  held="$(bluegreen removable "$IDLE" 2>&1)" || rc=$?
  if [[ $rc == 0 ]]; then
    "${COMPOSE[@]}" --env-file "$INTERP_FILE" rm -sf "worker-${IDLE}" >/dev/null 2>&1 || true
    echo "ERROR: $1 Restate holds no deployment at the new ${IDLE} worker's address, so it was removed; what Restate routes to the live worker (${LIVE}) was not changed."
  else
    echo "ERROR: $1 Restate holds a deployment at the new ${IDLE} worker's address, or could not say ($(tr '\n' ' ' <<< "$held")), so it may already send work there: the ${IDLE} worker was NOT removed, and the ${LIVE} worker was not drained. Both keep running. Check where each service goes (GET /services on Restate's admin API) and finish by hand: infra/docker/README.md, 'A switch that did not complete'."
  fi
  exit 1
}
for i in $(seq 1 30); do
  docker exec "hawa-production-worker-${IDLE}-1" node -e "fetch('http://localhost:9080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && break
  [[ $i == 30 ]] && abandon_idle "the new ${IDLE} worker did not become healthy within 60 s."
  sleep 2
done
# Exit 2 is a refusal, 4 a switch Restate accepted but that did not move every service; abandon_idle
# asks Restate again either way before it removes anything.
# --hosts: register refuses, before sending anything, a build that does not host every service Restate
# already routes to the worker (a rollback below the build that added one; ADR-129).
REGISTERED="$(bluegreen register "$IDLE" --hosts "$(idle_hosts "$IDLE")")" || abandon_idle "Restate did not complete the switch to the new ${IDLE} worker (its reason is above)."
echo "✓ restate sends new work to the ${IDLE} worker ($(sed -n 's/^deployment=//p' <<< "$REGISTERED"))"
# Not a failure when it times out: new work already goes to the new colour.
if DRAINS="$(bluegreen finish-drains --wait-seconds "${HAWA_DRAIN_TIMEOUT_SECONDS:-900}")"; then
  report_drains "$DRAINS"
else
  echo "! could not finish the drain of the ${LIVE} worker; it keeps running, and the next deploy finishes it first"
fi

# 8. Verify health truthfully (dependencies, not just HTTP 200)
verify_core_health || exit 1
WORKER="$(docker exec "hawa-production-worker-${IDLE}-1" node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "worker: ${WORKER:-unavailable}"
CUTOUT="$(docker exec hawa-production-core-1 node -e "fetch('http://cutout:8090/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "cutout: ${CUTOUT:-unavailable}"
check_blob_store_private || exit 1

# Record what actually started, not what mutable Compose tags or the source candidate suggest.
# The versioned upgrader wrote this row in the same transaction as the schema change. Read it back
# from PostgreSQL, then compare its hash with the source file in the receipt builder.
MIGRATION_ROW="$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" hawa-production-postgres-1 \
  psql -X -qAt -F '|' -U hawa_owner -d hawa \
  -c 'SELECT name, sha256 FROM hawa.schema_upgrades ORDER BY name DESC LIMIT 1' 2>/dev/null)" \
  || { echo "ERROR: could not read the applied schema migration; deployment is not admitted." >&2; exit 1; }
IFS='|' read -r MIGRATION_NAME MIGRATION_SHA256 <<< "$MIGRATION_ROW"
RECEIPT_DIR="${ROOT_DIR}/infra/backup/release-receipts"
mkdir -p "$RECEIPT_DIR"; chmod 700 "$RECEIPT_DIR"
RECEIPT="${RECEIPT_DIR}/deploy_${STAMP}_${BUILD_COMMIT:0:12}.json"
printf '%s' "$HEALTH" | (cd "$ROOT_DIR" && npx tsx scripts/record_deployment_receipt.ts "$BUILD_COMMIT" "$IDLE" "$RECEIPT" "$MIGRATION_NAME" "$MIGRATION_SHA256") \
  || { echo "ERROR: could not verify and record the deployed image identities; deployment is not admitted." >&2; exit 1; }

# 9. Hawa's own disk use: older pre-deploy dumps, Docker's build cache (a full disk is an outage).
bash "${ROOT_DIR}/infra/ops/disk_cleanup.sh" | sed 's/^/disk: /' || echo "! disk cleanup did not finish (the deploy itself succeeded)"
# Old releases: current, previous and the newest HAWA_RELEASES_KEEP (5) stay for a rollback (ADR-158), and
# so does any release a container's bind mount may still use (addendum 3).
if [[ "${HAWA_RELEASE_DIRS:-on}" != off ]]; then
  hawa_release_prune | sed 's/^/releases: /' || echo "! pruning old releases did not finish (the deploy itself succeeded)"
fi
echo ""
echo "=== Deployment complete. Next: requeue dead-lettered commands if any (POST /v1/system/outbox/requeue as administrator with {\"all\":true}). Uncertain Telegram sends stay dead-lettered and are listed as keptUncertain: check the requester's chat, and requeue one only if it did not arrive, by id with \"confirmUncertainReplay\":true ==="
