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

# Master admission release gate and evidence attestation check
bash "${ROOT_DIR}/scripts/enforce_release_gate.sh" --skip-tests >/dev/null
echo "✓ master release gate and evidence attestation verified"

if [[ $APPLY == 0 ]]; then
  echo ""
  echo "Pre-flight complete. Apply with: bash infra/docker/deploy.sh --apply"
  exit 0
fi

# 5. Backup before anything changes
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$INTERP_FILE" | cut -d= -f2-)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077   # dumps hold briefs, chat ids and sealed tokens: owner-only from the first byte
BACKUP_DIR="${ROOT_DIR}/infra/backup/snapshots"; mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d postgres
until docker exec hawa-production-postgres-1 pg_isready -U hawa_owner -d hawa >/dev/null 2>&1; do sleep 1; done
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" hawa-production-postgres-1 pg_dump -U hawa_owner hawa > "${BACKUP_DIR}/hawa_${STAMP}.sql"
echo "✓ backup written: infra/backup/snapshots/hawa_${STAMP}.sql ($(wc -c < "${BACKUP_DIR}/hawa_${STAMP}.sql") bytes)"

# Archive older snapshots off checkout to prevent disk exhaustion
ARCHIVE_DIR="${HAWA_BACKUP_ARCHIVE_DIR:-$HOME/.hawa/snapshots_archive}"
mkdir -p "$ARCHIVE_DIR" && chmod 700 "$ARCHIVE_DIR"
ls -1t "$BACKUP_DIR"/hawa_*.sql 2>/dev/null | tail -n +15 | while read -r old; do
  cp "$old" "$ARCHIVE_DIR/" 2>/dev/null || true
  rm -f "$old"
done

# 6. Versioned schema upgrades (idempotent; checksums of applied files are verified)
(cd "$ROOT_DIR" && DATABASE_URL="postgresql://hawa_owner:${POSTGRES_PASSWORD}@127.0.0.1:54332/hawa" npx tsx packages/db/src/upgrade.ts)
echo "✓ schema upgrades applied or verified"

# 7. Build and start
"${COMPOSE[@]}" --env-file "$INTERP_FILE" build core worker desk
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d
# nginx.conf is bind-mounted: compose does not recreate nginx when only the file changed, so reload it explicitly.
"${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx nginx -s reload >/dev/null 2>&1 && echo "✓ nginx configuration reloaded" || echo "! nginx reload skipped (container not running yet?)"
echo "✓ containers started"

# 7b. Register the worker's services with Restate. Its registry lives in the restate_data volume, and
# nothing else creates it: after that volume was recreated on 2026-09-17, every task failed with
# "service 'TaskWorkflow' not found" for 23 hours. The worker serves HTTP/1.1. Registering the same
# endpoint again changes nothing; if its handlers changed, the forced retry records a new revision.
REGISTER_WORKER='
const post = (force) => fetch("http://restate:9070/deployments", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ uri: "http://worker:9080", use_http_11: true, force }) });
(async () => {
  for (let i = 0; i < 30; i++) {
    try {
      let r = await post(false);
      if (!r.ok) r = await post(true);
      if (r.ok) {
        const names = ((await (await fetch("http://restate:9070/services")).json()).services || []).map((s) => s.name);
        if (names.includes("TaskWorkflow") && names.includes("TaskService")) { console.log("✓ restate holds the worker services: " + names.join(", ")); process.exit(0); }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error("ERROR: the worker could not be registered with Restate; tasks would fail with service not found");
  process.exit(1);
})();'
docker exec hawa-production-core-1 node -e "$REGISTER_WORKER" || exit 1

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
WORKER="$(docker exec hawa-production-worker-1 node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "worker: ${WORKER:-unavailable}"
echo ""
echo "=== Deployment complete. Next: requeue dead-lettered commands if any (POST /v1/system/outbox/requeue as administrator) ==="
