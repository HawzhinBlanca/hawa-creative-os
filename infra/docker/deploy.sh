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
stop_worker_slot() {
  case "$1" in
    blue|green) "${COMPOSE[@]}" --env-file "$INTERP_FILE" rm -sf "worker-$1" >/dev/null ;;
    # The single `worker` service of every deploy before blue/green; it is no longer in the compose file.
    legacy) docker stop "$LEGACY_WORKER_CONTAINER" >/dev/null 2>&1 || true; docker rm "$LEGACY_WORKER_CONTAINER" >/dev/null 2>&1 || true ;;
  esac
  echo "✓ stopped the drained ${1} worker"
}
# Reads finish-drains output: stops what was deleted, reports what is still draining.
report_drains() {
  local line slot
  while IFS= read -r line; do
    case "$line" in
      deleted=*) stop_worker_slot "${line#deleted=}" ;;
      draining=*) slot="${line#draining=}"
        echo "! the ${slot%%:*} worker still has ${slot#*:} invocation(s) pinned to it and keeps running; new work already goes to the live colour, and the next deploy finishes this drain first" ;;
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
    echo "ERROR: the ${1} worker still runs invocations from an earlier deploy ($(tr '\n' ' ' <<< "$out")). Replacing it now would replay them on new code, so no worker was changed. Deploy again once they finish (Restate UI, or SELECT * FROM sys_invocation WHERE status <> 'completed')."
    exit 1
  fi
  [[ $rc == 0 ]] || { echo "ERROR: could not read Restate's deployments (exit ${rc}); no worker was changed"; exit 1; }
  PREVIOUS_DRAINS_DONE=1
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
export HAWA_BUILD_COMMIT="$BUILD_COMMIT"

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

# 1. Prerequisites
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose is required"; exit 1; }

# 1b. Postgres volume durability verification: volume must exist and creation timestamp must match
VOLUME_NAME="hawa-production_postgres_data"
VOLUME_STAMP_FILE="${SCRIPT_DIR}/.postgres_volume_created"
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
  echo "ERROR: Postgres volume '$VOLUME_NAME' does not exist! Refusing to start or recreate." >&2
  exit 1
fi
VOLUME_CREATED="$(docker volume inspect "$VOLUME_NAME" --format '{{.CreatedAt}}')"
if [[ -f "$VOLUME_STAMP_FILE" ]]; then
  EXPECTED_STAMP="$(tr -d '[:space:]' < "$VOLUME_STAMP_FILE")"
  if [[ "$VOLUME_CREATED" != "$EXPECTED_STAMP" ]]; then
    echo "ERROR: Postgres volume creation timestamp changed! Expected: '$EXPECTED_STAMP', Got: '$VOLUME_CREATED'. Refusing deployment to prevent data loss." >&2
    exit 1
  fi
else
  echo "$VOLUME_CREATED" > "$VOLUME_STAMP_FILE"
fi
echo "✓ postgres volume '$VOLUME_NAME' verified (created at ${VOLUME_CREATED})"

# 1c. Restate volume durability verification: volume must exist and creation timestamp must match
RESTATE_VOLUME_NAME="hawa-production_restate_data"
RESTATE_VOLUME_STAMP_FILE="${SCRIPT_DIR}/.restate_volume_created"
if ! docker volume inspect "$RESTATE_VOLUME_NAME" >/dev/null 2>&1; then
  echo "ERROR: Restate volume '$RESTATE_VOLUME_NAME' does not exist! Refusing to start or recreate." >&2
  exit 1
fi
RESTATE_VOLUME_CREATED="$(docker volume inspect "$RESTATE_VOLUME_NAME" --format '{{.CreatedAt}}')"
if [[ -f "$RESTATE_VOLUME_STAMP_FILE" ]]; then
  EXPECTED_RESTATE_STAMP="$(tr -d '[:space:]' < "$RESTATE_VOLUME_STAMP_FILE")"
  if [[ "$RESTATE_VOLUME_CREATED" != "$EXPECTED_RESTATE_STAMP" ]]; then
    echo "ERROR: Restate volume creation timestamp changed! Expected: '$EXPECTED_RESTATE_STAMP', Got: '$RESTATE_VOLUME_CREATED'. Refusing deployment to prevent data loss." >&2
    exit 1
  fi
else
  echo "$RESTATE_VOLUME_CREATED" > "$RESTATE_VOLUME_STAMP_FILE"
fi
echo "✓ restate volume '$RESTATE_VOLUME_NAME' verified (created at ${RESTATE_VOLUME_CREATED})"


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

# 3. Compose topology with the real interpolation file
"${COMPOSE[@]}" --env-file "$INTERP_FILE" config --quiet
echo "✓ compose topology valid"

# 4. Repository gates
(cd "$ROOT_DIR" && python3 infra/security/security_scan.py --self-test >/dev/null && python3 infra/security/security_scan.py >/dev/null)
echo "✓ secret gate"
(cd "$ROOT_DIR" && python3 scripts/validate_pack.py >/dev/null)
echo "✓ blueprint pack"
# Plaintext credential material on this host outside git: listed, and refused when readable by others
bash "${ROOT_DIR}/infra/security/local_state_audit.sh"

# Master admission release gate and evidence attestation check (full test execution required)
bash "${ROOT_DIR}/scripts/enforce_release_gate.sh"
echo "✓ master release gate and evidence attestation verified"

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
if core_running; then
  PLAN="$(bluegreen plan)" || { echo "ERROR: could not read the live worker colour from Restate"; exit 1; }
  finish_previous_drains "$(sed -n 's/^idle=//p' <<< "$PLAN")"
fi

# 5. Backup before anything changes
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$INTERP_FILE" | cut -d= -f2-)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077   # dumps hold briefs, chat ids and sealed tokens: owner-only from the first byte
BACKUP_DIR="${ROOT_DIR}/infra/backup/snapshots"; mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d postgres
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
{ shasum -a 256 "$PARTIAL" | awk '{print $1}' > "$BACKUP.sha256" && mv -f "$PARTIAL" "$BACKUP"; } \
  || backup_failed "the backup could not be recorded"
echo "✓ backup written: infra/backup/snapshots/predeploy_${STAMP}.dump (${BACKUP_BYTES} bytes)"

# 6. Versioned schema upgrades (idempotent; checksums of applied files are verified)
(cd "$ROOT_DIR" && DATABASE_URL="postgresql://hawa_owner:${POSTGRES_PASSWORD}@127.0.0.1:54332/hawa" npx tsx packages/db/src/upgrade.ts)
echo "✓ schema upgrades applied or verified"

# 7. Build and start everything but the worker. Its two colours are behind the `worker` compose
# profile, so the `up -d` below never creates, recreates or stops either; 7b deploys the worker.
"${COMPOSE[@]}" --env-file "$INTERP_FILE" build core desk cutout
# The cut-out engine's own tests, run in the image that ships, against the pinned model.
docker run --rm --memory 12g -e HAWA_MODELS_DIR=/models -v "${MODELS_DIR}:/models:ro" \
  -v "${ROOT_DIR}/services/cutout/tests:/app/tests:ro" hawa-cutout:1 python -m unittest discover -s /app/tests -q \
  || { echo "ERROR: the cut-out service's tests failed in its image"; exit 1; }
echo "✓ cut-out engine tests passed in the shipped image"
# nginx.conf is a single-file bind mount. Compose does not recreate nginx when only the file changed,
# and on Docker Desktop a running container keeps the copy git replaced: a reload reads nothing new and
# `nginx -t` inside finds no file. On 2026-09-24 the judge-token masking deployed this way was not live
# until nginx was restarted. The new file is checked first in a one-off container (it mounts the file
# afresh), so a broken file never replaces a working one; then nginx is reloaded if it sees the new
# file, or restarted so that it binds it, and must see it afterwards.
NGINX_WANT="$(shasum -a 256 "${SCRIPT_DIR}/nginx.conf" | cut -d' ' -f1)"
nginx_seen() { "${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx sha256sum /etc/nginx/nginx.conf 2>/dev/null | cut -d' ' -f1 || true; }
"${COMPOSE[@]}" --env-file "$INTERP_FILE" run --rm --no-deps -T nginx nginx -t >/dev/null 2>&1 \
  || { echo "ERROR: infra/docker/nginx.conf fails nginx -t; nothing was started with it"; exit 1; }
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d
if [[ "$(nginx_seen)" == "$NGINX_WANT" ]]; then
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx nginx -s reload >/dev/null && echo "✓ nginx configuration reloaded"
else
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" restart nginx >/dev/null
  [[ "$(nginx_seen)" == "$NGINX_WANT" ]] || { echo "ERROR: nginx does not see the deployed nginx.conf even after a restart"; exit 1; }
  echo "✓ nginx restarted onto the new configuration"
fi
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
[[ $PREVIOUS_DRAINS_DONE == 1 ]] || finish_previous_drains "$IDLE"
"${COMPOSE[@]}" --env-file "$INTERP_FILE" build "worker-${IDLE}"
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d --no-deps --force-recreate "worker-${IDLE}"
abandon_idle() {
  "${COMPOSE[@]}" --env-file "$INTERP_FILE" rm -sf "worker-${IDLE}" >/dev/null 2>&1 || true
  echo "ERROR: $1 The new ${IDLE} worker was removed; the live worker (${LIVE}) was not touched."
  exit 1
}
for i in $(seq 1 30); do
  docker exec "hawa-production-worker-${IDLE}-1" node -e "fetch('http://localhost:9080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && break
  [[ $i == 30 ]] && abandon_idle "the new ${IDLE} worker did not become healthy within 60 s."
  sleep 2
done
REGISTERED="$(bluegreen register "$IDLE")" || abandon_idle "Restate did not register the new ${IDLE} worker (its reason is above)."
echo "✓ restate sends new work to the ${IDLE} worker ($(sed -n 's/^deployment=//p' <<< "$REGISTERED"))"
# Not a failure when it times out: new work already goes to the new colour.
if DRAINS="$(bluegreen finish-drains --wait-seconds "${HAWA_DRAIN_TIMEOUT_SECONDS:-900}")"; then
  report_drains "$DRAINS"
else
  echo "! could not finish the drain of the ${LIVE} worker; it keeps running, and the next deploy finishes it first"
fi

# 8. Verify health truthfully (dependencies, not just HTTP 200)
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS -m 5 http://127.0.0.1:8080/v1/health 2>/dev/null)"; then break; fi
  sleep 2
done
[[ -n "${HEALTH:-}" ]] || { echo "ERROR: core health did not answer within 60 s"; exit 1; }
echo "$HEALTH" | python3 -c '
import json,sys
h=json.load(sys.stdin); d=h.get("dependencies",{})
bad=[k for k,v in d.items() if v in ("unauthorized","unreachable","disconnected","read_only","outage","unregistered")]
print("health:", h.get("status"), json.dumps(d))
if bad: print("ERROR: unhealthy dependencies:", bad); sys.exit(1)
'
WORKER="$(docker exec "hawa-production-worker-${IDLE}-1" node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "worker: ${WORKER:-unavailable}"
CUTOUT="$(docker exec hawa-production-core-1 node -e "fetch('http://cutout:8090/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "cutout: ${CUTOUT:-unavailable}"

# 9. Hawa's own disk use: older pre-deploy dumps, Docker's build cache (a full disk is an outage).
bash "${ROOT_DIR}/infra/ops/disk_cleanup.sh" | sed 's/^/disk: /' || echo "! disk cleanup did not finish (the deploy itself succeeded)"
echo ""
echo "=== Deployment complete. Next: requeue dead-lettered commands if any (POST /v1/system/outbox/requeue as administrator with {\"all\":true}). Uncertain Telegram sends stay dead-lettered and are listed as keptUncertain: check the requester's chat, and requeue one only if it did not arrive, by id with \"confirmUncertainReplay\":true ==="
