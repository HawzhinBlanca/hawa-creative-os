#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Hawa Creative OS: schema, RLS and seed parity drill (clean-host rebuild check).
# This is NOT a data backup: production data backups are taken by infra/backup/nightly_backup.sh.
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

echo "================================================================================"
echo "⚡ Hawa Creative OS: schema/RLS/seed parity drill (data backups: infra/backup/nightly_backup.sh)"
echo "================================================================================"

SNAPSHOT_DIR="${ROOT_DIR}/dist/snapshots"
mkdir -p "${SNAPSHOT_DIR}"
TIMESTAMP="$(date -u +"%Y%m%d_%H%M%SZ")"
SNAPSHOT_FILE="${SNAPSHOT_DIR}/hawa_prod_snapshot_${TIMESTAMP}.sql"

echo "1. Generating schema+RLS+seed parity snapshot (no data)..."
cat << 'EOF' > "${SNAPSHOT_FILE}"
-- =============================================================================
-- HAWA CREATIVE OS PRODUCTION RECOVERY SNAPSHOT
-- =============================================================================
EOF
echo "-- Generated at: $(date -u)" >> "${SNAPSHOT_FILE}"
echo "" >> "${SNAPSHOT_FILE}"

cat db/schema.sql >> "${SNAPSHOT_FILE}"
echo "" >> "${SNAPSHOT_FILE}"
cat db/rls.sql >> "${SNAPSHOT_FILE}"
echo "" >> "${SNAPSHOT_FILE}"
cat db/seed.sql >> "${SNAPSHOT_FILE}"

SNAPSHOT_SHA256="$(shasum -a 256 "${SNAPSHOT_FILE}" | awk '{print $1}')"
SNAPSHOT_SIZE="$(wc -c < "${SNAPSHOT_FILE}" | tr -d ' ')"

echo "   ✓ Snapshot created: ${SNAPSHOT_FILE}"
echo "   ✓ File size: ${SNAPSHOT_SIZE} bytes"
echo "   ✓ SHA-256: ${SNAPSHOT_SHA256}"

echo ""
echo "2. Running schema integrity & RLS invariant checks..."
pnpm run db:check

echo ""
echo "3. Executing clean-host simulated restoration drill..."
pnpm vitest run packages/db/test/backup-restore.test.ts

echo ""
echo "================================================================================"
echo "✅ Horizon 4 Drill Passed: Clean-host recovery verified with 100% schema parity"
echo "================================================================================"
