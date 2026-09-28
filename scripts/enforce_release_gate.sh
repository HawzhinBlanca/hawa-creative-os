#!/usr/bin/env bash
# ==============================================================================
# Hawa Creative OS — Enforced Reproducible Release Gate (Task R11)
# Standards: FR-074, NFR-012, NFR-013, NFR-024, NFR-025
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Run evidence is local and ignored. The historical 2026-09-21 dossier stays
# tracked as an audit record; a new run must never overwrite it.
OUTPUT_DIR="${ROOT_DIR}/output/release-gate"
EVIDENCE_FILE="${OUTPUT_DIR}/RELEASE_GATE_EVIDENCE.json"
mkdir -p "${OUTPUT_DIR}"

TEST_REFUSAL=0
SKIP_TESTS=0
REQUIRE_ADMISSION=0

for arg in "$@"; do
  case "$arg" in
    --test-refusal)
      TEST_REFUSAL=1
      ;;
    --skip-tests)
      SKIP_TESTS=1
      ;;
    --require-admission)
      REQUIRE_ADMISSION=1
      ;;
    --help|-h)
      echo "Usage: $0 [--test-refusal] [--skip-tests] [--require-admission]"
      echo "  --test-refusal  Intentionally break a manifest flag to prove rejection"
      echo "  --skip-tests    Skip test suite execution; never qualifies engineering preflight"
      echo "  --require-admission  Refuse unless every current-candidate product gate is verified"
      exit 0
      ;;
  esac
done

echo "================================================================================"
echo "          HAWA CREATIVE OS — ENGINEERING RELEASE PREFLIGHT"
echo "================================================================================"
echo "Root Directory: ${ROOT_DIR}"
echo "Execution Mode: $([ "$TEST_REFUSAL" -eq 1 ] && echo "NEGATIVE CONTROL (Test Refusal)" || ([ "$REQUIRE_ADMISSION" -eq 1 ] && echo "STRICT ADMISSION" || echo "ENGINEERING PREFLIGHT"))"
echo "Timestamp:      $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "================================================================================"

if [ "$TEST_REFUSAL" -eq 1 ]; then
  echo "[REFUSAL DRILL] Testing Gate Refusal under corrupted release manifest..."
  # Outside the tree, removed on any exit: a copy in the repository root was left behind whenever
  # this drill failed part-way, which it always did on Linux (BSD-only `sed -i ''`).
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  TMP_MANIFEST="${TMP_DIR}/RELEASE_MANIFEST.corrupted.json"

  # Corrupt the manifest by flipping a mandatory flag to an unapproved state (portable: no sed -i)
  sed 's/"DESIGN_PIPELINE_V3": "off"/"DESIGN_PIPELINE_V3": "on"/' "${ROOT_DIR}/RELEASE_MANIFEST.json" > "${TMP_MANIFEST}"
  if cmp -s "${ROOT_DIR}/RELEASE_MANIFEST.json" "${TMP_MANIFEST}"; then
    echo "[REFUSAL DRILL FAILED] Could not corrupt the manifest: DESIGN_PIPELINE_V3 \"off\" not found."
    exit 1
  fi

  REFUSAL_OUTPUT=""
  REFUSAL_EXIT=0
  REFUSAL_OUTPUT=$(pnpm tsx "${ROOT_DIR}/scripts/verify_release_manifest.ts" "${TMP_MANIFEST}" 2>&1) || REFUSAL_EXIT=$?
  
  if [ "$REFUSAL_EXIT" -ne 0 ] && echo "$REFUSAL_OUTPUT" | grep -q "DESIGN_PIPELINE_V3 flag must be 'off'"; then
    echo "[REFUSAL DRILL PASSED] Gate strictly refused corrupted candidate (exit code: ${REFUSAL_EXIT}):"
    echo "  ${REFUSAL_OUTPUT}"
    echo "Refusal counterexample verified: source-manifest flag violation rejected."
    exit 0
  else
    echo "[REFUSAL DRILL FAILED] Gate admitted corrupted candidate or gave unexpected output!"
    echo "${REFUSAL_OUTPUT}"
    exit 1
  fi
fi

STAGE_STATUS=()
if [ -n "$(git -C "${ROOT_DIR}" status --porcelain)" ]; then
  echo "FATAL: release preflight requires a clean checkout before generated-file checks."
  exit 1
fi

# ------------------------------------------------------------------------------
# Stage 1: Exact TypeScript Typecheck
# ------------------------------------------------------------------------------
echo ""
echo "--> [Stage 1/8] Running static typecheck across all workspace packages..."
T_START=$(date +%s)
pnpm typecheck
T_END=$(date +%s)
STAGE_STATUS+=("typecheck:PASS ($((T_END - T_START))s)")
echo "    [PASS] Typecheck completed cleanly."

# ------------------------------------------------------------------------------
# Stage 2: Database Schema & Migration Consistency
# ------------------------------------------------------------------------------
echo ""
echo "--> [Stage 2/8] Checking database schema & migration integrity..."
T_START=$(date +%s)
pnpm run db:check
T_END=$(date +%s)
STAGE_STATUS+=("db_check:PASS ($((T_END - T_START))s)")
echo "    [PASS] Database migrations in strict chronological order."

# ------------------------------------------------------------------------------
# Stage 3: Pending migrations on production's newest dump (ADR-137)
# ------------------------------------------------------------------------------
# On 2026-09-28 a release passed every other stage and still refused every paid call in production:
# its migrations treated 79 historical records as "history incomplete" (ADR-133). No test database
# holds production-shaped history. This restores the newest production dump (deploy.sh's
# predeploy_*.dump or the nightly hawa_*.dump, both in infra/backup/snapshots of the checkout the
# gate runs from) into a scratch database on the TEST server, applies this candidate's migrations
# with deploy's upgrader, runs read-only invariants (spending history and admission for every tenant
# and client, the runtime role under RLS, NOT VALID constraints, schema parity with a fresh build) and
# drops the scratch databases. About 10 s. Skipped, with a message, only when no dump exists.
echo ""
echo "--> [Stage 3/8] Checking pending migrations against production's newest dump..."
T_START=$(date +%s)
PREDEPLOY_LOG="${OUTPUT_DIR}/PREDEPLOY_DUMP_CHECK.log"
PREDEPLOY_EXIT=0
HAWA_PREDEPLOY_SNAPSHOTS="${HAWA_PREDEPLOY_SNAPSHOTS:-${ROOT_DIR}/infra/backup/snapshots}" \
  pnpm exec tsx "${ROOT_DIR}/packages/db/src/predeploy-dump-check.ts" --json "${OUTPUT_DIR}/PREDEPLOY_DUMP_CHECK.json" \
  > "${PREDEPLOY_LOG}" 2>&1 || PREDEPLOY_EXIT=$?
T_END=$(date +%s)
if [ "$PREDEPLOY_EXIT" -eq 3 ]; then
  echo "    [SKIP] No production dump in ${HAWA_PREDEPLOY_SNAPSHOTS:-${ROOT_DIR}/infra/backup/snapshots}: the pending migrations were NOT checked against production's data."
  STAGE_STATUS+=("predeploy_dump_check:SKIPPED (no production dump)")
  PREDEPLOY_STAGE="skipped, no production dump"
elif [ "$PREDEPLOY_EXIT" -ne 0 ]; then
  echo "FATAL: the pending migrations break an invariant on production's newest dump. See ${PREDEPLOY_LOG}"
  grep -vE '^ Container ' "${PREDEPLOY_LOG}" | tail -n 30
  exit 1
else
  STAGE_STATUS+=("predeploy_dump_check:PASS ($((T_END - T_START))s)")
  PREDEPLOY_STAGE="passed"
  echo "    [PASS] Pending migrations hold every invariant on production's newest dump."
fi

# ------------------------------------------------------------------------------
# Stage 4: Security & Secret Leakage Scanner
# ------------------------------------------------------------------------------
echo ""
echo "--> [Stage 4/8] Running zero-leak secret scanner & self-test..."
T_START=$(date +%s)
python3 "${ROOT_DIR}/infra/security/security_scan.py" --self-test
python3 "${ROOT_DIR}/infra/security/security_scan.py"
T_END=$(date +%s)
STAGE_STATUS+=("security_scan:PASS ($((T_END - T_START))s)")
echo "    [PASS] Security scanner and self-test passed with 0 findings."

# ------------------------------------------------------------------------------
# Stage 5: Knowledge Pack & Blueprint Validation
# ------------------------------------------------------------------------------
echo ""
echo "--> [Stage 5/8] Validating knowledge pack and blueprint checksums..."
T_START=$(date +%s)
# Verify the committed manifest is current; do not quietly make it current.
#
# This stage used to run refresh_manifest.py, which rewrites MANIFEST.json and SHA256SUMS.txt in
# place. Stage 6 then refuses to certify a tree with uncommitted modifications — so the gate dirtied
# the tree it was about to demand be clean, and passed only when the manifest happened to be in sync
# already. Its verdict therefore depended on whether someone had committed a manifest moments
# before, not on the state of the release. Both "all seven stages passed" runs on 2026-09-21 were
# that coincidence.
#
# A gate checks; it does not repair. Regenerating into the working tree and comparing against HEAD
# tells us whether the committed manifest is stale, and the tree is put back either way. These two
# files are generated artifacts and are never hand-edited, so restoring them loses nothing.
#
# The comparison skips generated manifests' own entries to avoid circular
# checksums. The source-candidate release manifest is independently verified
# against source hashes and the recorded commit in Stage 6.
GATE_SUMS_BEFORE="$(grep -vE '  (MANIFEST|RELEASE_MANIFEST)\.json$|  SHA256SUMS\.txt$' "${ROOT_DIR}/SHA256SUMS.txt" | sort)"
python3 "${ROOT_DIR}/scripts/refresh_manifest.py"
GATE_SUMS_AFTER="$(grep -vE '  (MANIFEST|RELEASE_MANIFEST)\.json$|  SHA256SUMS\.txt$' "${ROOT_DIR}/SHA256SUMS.txt" | sort)"
git -C "${ROOT_DIR}" checkout -- MANIFEST.json SHA256SUMS.txt 2>/dev/null || true
if [ "${GATE_SUMS_BEFORE}" != "${GATE_SUMS_AFTER}" ]; then
  echo "FATAL: the committed manifest is stale — regenerating it changes the checksum of a tracked file."
  diff <(echo "${GATE_SUMS_BEFORE}") <(echo "${GATE_SUMS_AFTER}") | head -10
  echo "       Run: npx tsx scripts/generate_release_manifest.ts && python3 scripts/refresh_manifest.py"
  echo "       then commit MANIFEST.json, SHA256SUMS.txt and RELEASE_MANIFEST.json, and re-run this gate."
  exit 1
fi
python3 "${ROOT_DIR}/scripts/validate_pack.py"
T_END=$(date +%s)
STAGE_STATUS+=("pack_validation:PASS ($((T_END - T_START))s)")
echo "    [PASS] Pack validation completed."

# ------------------------------------------------------------------------------
# Stage 6: Cryptographic Release Manifest Verification
# ------------------------------------------------------------------------------
echo ""
echo "--> [Stage 6/8] Verifying source-candidate manifest invariants..."
T_START=$(date +%s)
pnpm tsx "${ROOT_DIR}/scripts/verify_release_manifest.ts"
T_END=$(date +%s)
STAGE_STATUS+=("release_manifest:PASS ($((T_END - T_START))s)")
echo "    [PASS] Source-candidate checksum and topology verified."

# ------------------------------------------------------------------------------
# Stage 7: Database Isolation Verification
# ------------------------------------------------------------------------------
echo ""
echo "--> [Stage 7/8] Verifying production database isolation guard..."
T_START=$(date +%s)
PROD_PORT="54332"
TEST_PORT="55432"
# Verify TEST_DATABASE_URL does not point to production port
if echo "${TEST_DATABASE_URL:-}" | grep -q "${PROD_PORT}"; then
  echo "FATAL: TEST_DATABASE_URL points to production port ${PROD_PORT}! Aborting."
  exit 1
fi
echo "    [PASS] Production port ${PROD_PORT} isolated from test execution."

# A gate that passes here says nothing about what is published unless the two agree. On 2026-09-21
# this branch had been rebased and its remote deleted: 267 local commits against 252 published,
# sharing only a distant ancestor, while a qualification report was being written from this checkout
# claiming production readiness. The report was not wrong about the tests; it was answering about a
# tree nobody could relate to the published history. Refuse rather than certify a branch that has
# diverged, and say which way it went.
if git -C "${ROOT_DIR}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  UPSTREAM="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
  git -C "${ROOT_DIR}" fetch --quiet origin 2>/dev/null || true
  AHEAD_BEHIND="$(git -C "${ROOT_DIR}" rev-list --left-right --count "HEAD...${UPSTREAM}" 2>/dev/null || echo "0	0")"
  LOCAL_AHEAD="$(echo "${AHEAD_BEHIND}" | cut -f1)"
  REMOTE_AHEAD="$(echo "${AHEAD_BEHIND}" | cut -f2)"
  if [ "${REMOTE_AHEAD:-0}" -gt 0 ]; then
    echo "FATAL: ${UPSTREAM} has ${REMOTE_AHEAD} commit(s) this branch does not (local is ${LOCAL_AHEAD} ahead)."
    echo "       A release cannot be certified from a branch that has diverged from what is published."
    echo "       Reconcile first — and never with --force before checking what exists only on the remote."
    exit 1
  fi
  echo "    [PASS] Branch agrees with ${UPSTREAM} (${LOCAL_AHEAD} ahead, 0 behind)."
else
  echo "FATAL: this branch tracks no remote, so nothing here is published or backed up off this host."
  echo "       A remote was deleted from this repository's config on 2026-09-21; restore it before certifying."
  exit 1
fi

T_END=$(date +%s)
STAGE_STATUS+=("db_isolation:PASS ($((T_END - T_START))s)")

# ------------------------------------------------------------------------------
# Stage 8: Full Monorepo Test Suite Execution
# ------------------------------------------------------------------------------
TOTAL_TESTS=0
TOTAL_FILES=0
if [ "$SKIP_TESTS" -eq 1 ]; then
  echo ""
  echo "--> [Stage 8/8] SKIPPING test execution per --skip-tests flag."
  STAGE_STATUS+=("test_suite:SKIPPED")
else
  echo ""
  echo "--> [Stage 8/8] Executing full monorepo vitest suite (with isolated test DB)..."
  T_START=$(date +%s)
  TEST_RUN_LOG="${OUTPUT_DIR}/FULL_TEST_SUITE_RUN.log"
  TEST_EXIT=0
  # The isolated test databases take the versioned upgrades added since they were built, so a new
  # migration is under test before it reaches production.
  pnpm test:db > "${OUTPUT_DIR}/TEST_DB_PROVISION.log" 2>&1 || { echo "FATAL: the isolated test database could not be brought up to date. See ${OUTPUT_DIR}/TEST_DB_PROVISION.log"; exit 1; }
  pnpm test > "${TEST_RUN_LOG}" 2>&1 || TEST_EXIT=$?
  T_END=$(date +%s)
  
  if [ "$TEST_EXIT" -ne 0 ] || grep -qE "Test Files +[0-9]+ failed" "${TEST_RUN_LOG}"; then
    echo "FATAL: Test suite failed! See log at ${TEST_RUN_LOG}"
    tail -n 30 "${TEST_RUN_LOG}"
    exit 1
  fi
  
  TOTAL_FILES=$(grep -oE "Test Files +[0-9]+ passed" "${TEST_RUN_LOG}" | tail -1 | awk '{print $3}' || true)
  TOTAL_TESTS=$(grep -oE "Tests +[0-9]+ passed" "${TEST_RUN_LOG}" | tail -1 | awk '{print $2}' || true)
  if [ -z "$TOTAL_FILES" ] || [ -z "$TOTAL_TESTS" ]; then
    echo "FATAL: Test runner returned no parseable passing test/file counts. See ${TEST_RUN_LOG}"
    exit 1
  fi
  STAGE_STATUS+=("test_suite:PASS (${TOTAL_TESTS} tests in ${TOTAL_FILES} files, $((T_END - T_START))s)")
  echo "    [PASS] Monorepo tests: ${TOTAL_TESTS} passed across ${TOTAL_FILES} files (0 failures)."
fi

# ------------------------------------------------------------------------------
# Emit Evidence Dossier
# ------------------------------------------------------------------------------
MANIFEST_SHA256=$(shasum -a 256 "${ROOT_DIR}/RELEASE_MANIFEST.json" | awk '{print $1}')
GIT_COMMIT=$(git rev-parse HEAD)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

CLEAN_TREE="false"
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  CLEAN_TREE="true"
fi

# The negative control is a separate check. A clean source checkout is still
# only an engineering candidate; this pre-deployment script cannot inspect a
# built image, live publication, recovery, or blinded human design quality.
REFUSAL_VERIFIED=false
if bash "${ROOT_DIR}/scripts/enforce_release_gate.sh" --test-refusal >/dev/null 2>&1; then
  REFUSAL_VERIFIED=true
fi

ENGINEERING_PASSED=1
if [ "$SKIP_TESTS" -eq 1 ] || [ "$CLEAN_TREE" != "true" ] || [ "$REFUSAL_VERIFIED" != "true" ]; then
  ENGINEERING_PASSED=0
fi
REFUSAL_VALUE=0
if [ "$REFUSAL_VERIFIED" = "true" ]; then REFUSAL_VALUE=1; fi
ADMISSION_JSON=$(pnpm exec tsx "${ROOT_DIR}/scripts/release_admission_verdict.ts" \
  "${GIT_COMMIT}" "${MANIFEST_SHA256}" "${ENGINEERING_PASSED}" "${REFUSAL_VALUE}")
GATE_STATUS=$(printf '%s' "$ADMISSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).status))')
ADMISSION_QUALIFIED=$(printf '%s' "$ADMISSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s).admissionQualified))')
GATES_JSON=$(printf '%s' "$ADMISSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s).normativeGatesEvaluated)))')

cat <<EOF > "${EVIDENCE_FILE}"
{
  "taskId": "R11",
  "name": "Make the Release Gate Reproducible and Non-Bypassable",
  "status": "${GATE_STATUS}",
  "admissionQualified": ${ADMISSION_QUALIFIED},
  "evaluatedAt": "${TIMESTAMP}",
  "git": {
    "commit": "${GIT_COMMIT}",
    "branch": "${GIT_BRANCH}",
    "cleanTree": ${CLEAN_TREE}
  },
  "releaseManifest": {
    "file": "RELEASE_MANIFEST.json",
    "sha256": "${MANIFEST_SHA256}",
    "flags": {
      "DESIGN_PIPELINE_V3": "off",
      "DESIGN_STUDIO_V2": "off"
    }
  },
  "databaseIsolation": {
    "productionPort": 54332,
    "testPort": 55432,
    "isolated": true
  },
  "verificationStages": [
    "Stage 1: TypeScript typecheck (pnpm typecheck)",
    "Stage 2: Database schema & migrations check (pnpm run db:check)",
    "Stage 3: Pending migrations on production's newest dump (predeploy-dump-check.ts): ${PREDEPLOY_STAGE}",
    "Stage 4: Security & secret scanner with self-test (security_scan.py)",
    "Stage 5: Knowledge pack validation (validate_pack.py)",
    "Stage 6: Source-candidate manifest check (verify_release_manifest.ts)",
    "Stage 7: Production DB & credential isolation guard",
    "Stage 8: Full monorepo acceptance tests (${TOTAL_TESTS} passed, 0 failed)"
  ],
  "normativeGatesEvaluated": ${GATES_JSON},
  "admissionEvidence": "Current-candidate deployment, gate, and blinded human-quality evidence are not evaluated by pre-deployment checks; R27 admission remains open.",
  "negativeRefusalTest": {
    "command": "scripts/enforce_release_gate.sh --test-refusal",
    "expectedBehavior": "Fail-closed non-zero exit when manifest flag violated",
    "verified": ${REFUSAL_VERIFIED}
  }
}
EOF

if [ "$ENGINEERING_PASSED" -ne 1 ] || { [ "$REQUIRE_ADMISSION" -eq 1 ] && [ "$ADMISSION_QUALIFIED" != "true" ]; }; then
  echo ""
  echo "================================================================================"
  echo "      RELEASE PREFLIGHT REFUSED"
  echo "      Status: ${GATE_STATUS}"
  echo "================================================================================"
  echo "Evidence written to: ${EVIDENCE_FILE}"
  for s in "${STAGE_STATUS[@]}"; do
    echo "  - $s"
  done
  echo "================================================================================"
  exit 2
fi

echo ""
echo "================================================================================"
echo "          ENGINEERING PREFLIGHT PASSED — PRODUCT ADMISSION OPEN"
echo "================================================================================"
echo "Evidence written to: ${EVIDENCE_FILE}"
for s in "${STAGE_STATUS[@]}"; do
  echo "  - $s"
done
echo "================================================================================"
exit 0
