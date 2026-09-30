#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Hawa Creative OS: weekly static check of the repository's schema, RLS and seed files.
# It restores NO backup and reads NO production data: the monthly infra/backup/restore_drill.sh restores
# the newest nightly dump. Until ADR-158 this recorded itself in hawa.backup_drills as a "passed"
# clean-host recovery with 52 tables and 24 policies written into the script and an RPO of 0, which
# no restore had measured. It now records what it checked: drill_type static_schema_parity,
# restore_performed false, no target time or RPO, and the counts read from the files it checked.
# ==============================================================================

# pwd -P: started through ~/.hawa/current, the run stays on that release even if a deploy switches it (ADR-158).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${ROOT_DIR}"
# The SHA-256 tool and the host role, chosen per host (ADR-141).
source "${ROOT_DIR}/infra/ops/host_lib.sh"
# A standby or retired host runs no drill (ADR-141): production, and its database, live elsewhere.
HAWA_ROLE_NOW="$(hawa_host_role)" || { echo "unrecognised host role '${HAWA_ROLE_NOW}' in $(hawa_host_role_source) (production, standby or retired); no drill was run" >&2; exit 1; }
if [[ "$HAWA_ROLE_NOW" != production ]]; then
  echo "$(date -u +%FT%TZ) SKIP: this host is ${HAWA_ROLE_NOW} ($(hawa_host_role_source)); production runs elsewhere, no drill was run"
  exit 0
fi
PG="${HAWA_BACKUP_PG_CONTAINER:-hawa-production-postgres-1}"

echo "================================================================================"
echo "Hawa Creative OS: static schema/RLS/seed check (no backup is restored; data: restore_drill.sh)"
echo "================================================================================"

START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
START_SEC="$(date +%s)"
SNAPSHOT_FILE=""
SNAPSHOT_SHA256=""
SNAPSHOT_SIZE=0
# Counted from the files this run checks, never written in: CREATE TABLE in db/schema.sql and
# CREATE POLICY in db/rls.sql (the files a clean host is built from).
TABLES="$(grep -ciE '^[[:space:]]*CREATE TABLE' db/schema.sql || true)"
POLICIES="$(grep -ciE '^[[:space:]]*CREATE POLICY' db/rls.sql || true)"
[[ "$TABLES" =~ ^[0-9]+$ ]] || TABLES=0
[[ "$POLICIES" =~ ^[0-9]+$ ]] || POLICIES=0

record_drill() {
  local status="$1"
  local err_msg="${2:-}"
  local END_TS; END_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local RTO=$(( $(date +%s) - START_SEC ))
  err_msg="$(printf '%s' "$err_msg" | tr -cd 'A-Za-z0-9 ._:/()=-' | cut -c1-200)"
  if docker exec "$PG" pg_isready -U hawa_owner -d hawa >/dev/null 2>&1; then
    docker exec -i "$PG" psql -U hawa_owner -d hawa -v ON_ERROR_STOP=1 -q <<SQL || { echo "WARNING: could not record the check in hawa.backup_drills" >&2; return 0; }
INSERT INTO hawa.backup_drills (
  tenant_id, started_at, completed_at, target_timestamp, rpo_seconds, rto_seconds, status, evidence, performed_by
) VALUES (
  '00000000-0000-4000-a000-000000000001',
  '${START_TS}',
  '${END_TS}',
  NULL,
  NULL,
  ${RTO},
  '${status}',
  jsonb_build_object(
    'drill_type', 'static_schema_parity',
    'restore_performed', false,
    'scope', 'repository schema, RLS and seed files checked with pnpm db:check and packages/db/test/backup-restore.test.ts; no backup restored, no production data read',
    'snapshot_file', '${SNAPSHOT_FILE##*/}',
    'snapshot_sha256', '${SNAPSHOT_SHA256}',
    'snapshot_size_bytes', ${SNAPSHOT_SIZE},
    'tables_in_schema_file', ${TABLES},
    'policies_in_rls_file', ${POLICIES},
    'error', '${err_msg}'
  ),
  '00000000-0000-4000-b000-000000000001'
);
SQL
    echo "   Recorded in hawa.backup_drills as static_schema_parity (status: ${status}, no restore)"
  fi
}

trap 'record_drill "failed" "error on line $LINENO"' ERR

SNAPSHOT_DIR="${HAWA_DRILL_SNAPSHOT_DIR:-${ROOT_DIR}/dist/snapshots}"
mkdir -p "${SNAPSHOT_DIR}"
TIMESTAMP="$(date -u +"%Y%m%d_%H%M%SZ")"
SNAPSHOT_FILE="${SNAPSHOT_DIR}/hawa_schema_bundle_${TIMESTAMP}.sql"

echo "1. Bundling db/schema.sql, db/rls.sql and db/seed.sql (repository files, no data)..."
{
  echo "-- Hawa schema, RLS and seed bundle from the repository (no data), $(date -u)"
  echo ""
  cat db/schema.sql; echo ""; cat db/rls.sql; echo ""; cat db/seed.sql
} > "${SNAPSHOT_FILE}"
SNAPSHOT_SHA256="$("${HAWA_SHA256[@]}" "${SNAPSHOT_FILE}" | awk '{print $1}')"
SNAPSHOT_SIZE="$(wc -c < "${SNAPSHOT_FILE}" | tr -d ' ')"
echo "   ${SNAPSHOT_FILE} (${SNAPSHOT_SIZE} bytes, sha256 ${SNAPSHOT_SHA256}); ${TABLES} tables, ${POLICIES} policies in the files"

echo ""
echo "2. Schema integrity and RLS invariants (pnpm db:check)..."
pnpm run db:check

echo ""
echo "3. Static bundle checks (packages/db/test/backup-restore.test.ts; restores nothing)..."
pnpm vitest run packages/db/test/backup-restore.test.ts

echo ""
echo "4. Recording the result..."
trap - ERR
record_drill "passed"

echo ""
echo "================================================================================"
echo "Static check passed: the repository's schema, RLS and seed files are consistent."
echo "No backup was restored; the monthly restore drill (restore_drill.sh) proves the data."
echo "================================================================================"
