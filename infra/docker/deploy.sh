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
export HAWA_BUILD_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"

echo "=== Hawa Creative OS production deployment ($([[ $APPLY == 1 ]] && echo apply || echo pre-flight)) ==="

# 1. Prerequisites
command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: docker compose is required"; exit 1; }

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
(cd "$ROOT_DIR" && python3 infra/security/security_scan.py --self-test >/dev/null && python3 infra/security/security_scan.py >/dev/null) && echo "✓ secret gate"
(cd "$ROOT_DIR" && python3 scripts/validate_pack.py >/dev/null) && echo "✓ blueprint pack"
# Plaintext credential material on this host outside git: listed, and refused when readable by others
bash "${ROOT_DIR}/infra/security/local_state_audit.sh"

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

# 6. Versioned schema upgrades (idempotent; checksums of applied files are verified)
(cd "$ROOT_DIR" && DATABASE_URL="postgresql://hawa_owner:${POSTGRES_PASSWORD}@127.0.0.1:54332/hawa" npx tsx packages/db/src/upgrade.ts)
echo "✓ schema upgrades applied or verified"

# 7. Build and start
"${COMPOSE[@]}" --env-file "$INTERP_FILE" build core worker desk
"${COMPOSE[@]}" --env-file "$INTERP_FILE" up -d
# nginx.conf is bind-mounted: compose does not recreate nginx when only the file changed, so reload it explicitly.
"${COMPOSE[@]}" --env-file "$INTERP_FILE" exec -T nginx nginx -s reload >/dev/null 2>&1 && echo "✓ nginx configuration reloaded" || echo "! nginx reload skipped (container not running yet?)"
echo "✓ containers started"

# 8. Verify health truthfully (dependencies, not just HTTP 200)
for i in $(seq 1 30); do
  if HEALTH="$(curl -fsS -m 5 http://127.0.0.1:8080/v1/health 2>/dev/null)"; then break; fi
  sleep 2
done
[[ -n "${HEALTH:-}" ]] || { echo "ERROR: core health did not answer within 60 s"; exit 1; }
echo "$HEALTH" | python3 -c '
import json,sys
h=json.load(sys.stdin); d=h.get("dependencies",{})
bad=[k for k,v in d.items() if v in ("unauthorized","unreachable","disconnected","read_only","outage")]
print("health:", h.get("status"), json.dumps(d))
if bad: print("ERROR: unhealthy dependencies:", bad); sys.exit(1)
'
WORKER="$(docker exec hawa-production-worker-1 node -e "fetch('http://localhost:9080/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true)"
echo "worker: ${WORKER:-unavailable}"
echo ""
echo "=== Deployment complete. Next: requeue dead-lettered commands if any (POST /v1/system/outbox/requeue as administrator) ==="
