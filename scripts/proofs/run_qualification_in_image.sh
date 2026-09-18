#!/usr/bin/env bash
# Runs the P10 qualification inside the production image, where every bundled font renders.
#
# Why this exists: run on a macOS host, rsvg-convert silently substitutes Helvetica for Cinzel,
# Playfair Display and Cairo, so the previews, the vision critique and both judges all score
# typography production does not produce. The font-fidelity gate correctly fails such a run — the
# 2026-09-18 production qualification failed it on 10 of 20 briefs for exactly this reason. Inside
# the image every family used renders exactly, so the run's visual evidence means something.
#
#   bash scripts/proofs/run_qualification_in_image.sh --check         # plumbing only, no spend
#   bash scripts/proofs/run_qualification_in_image.sh <outDir> [args] # real run
#   HAWA_QUALIFICATION_BRIEF_SET=compare bash scripts/proofs/run_qualification_in_image.sh <outDir>
#                                        # v3 designs of the ten compare briefs, for the T8 blind test
#
# The API key is read from the running core container and never printed or written to disk.
# The daily spend ledger is mounted from the host, so the office cap counts every run, host or image.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${HAWA_QUALIFICATION_IMAGE:-hawa-core:canva-only-20260913}"
KEY_SOURCE_CONTAINER="${HAWA_KEY_CONTAINER:-hawa-production-core-1}"

if [[ "${1:-}" == "--check" ]]; then
  echo "Checking the image can run the qualification (no model spend)..."
  # A deliberately invalid key: reaching a 401 proves imports, egress and the cost governor work.
  OUT=$(docker run --rm \
    -v "$REPO_ROOT/scripts:/app/scripts:ro" \
    -v "$REPO_ROOT/packages/creative/dist:/app/packages/creative/dist:ro" \
    -v "$REPO_ROOT/packages/domain/dist:/app/packages/domain/dist:ro" \
    -e OPENAI_API_KEY=sk-invalid-plumbing-check \
    -e HAWA_QUALIFICATION_OUT_DIR=/tmp/qualification-check \
    -e HAWA_MODEL_MAX_ATTEMPTS=1 \
    -w /app "$IMAGE" \
    sh -c './node_modules/.bin/tsx scripts/run_p10_qualification.ts 2>&1 | head -40' || true)

  if grep -q "Incorrect API key" <<<"$OUT"; then
    echo "OK: the image runs the qualification and reaches the API. Only the key was rejected."
    exit 0
  fi
  echo "FAILED: the image did not reach the API. Output:" >&2
  echo "$OUT" >&2
  exit 1
fi

OUT_DIR="${1:-}"
if [[ -z "$OUT_DIR" ]]; then
  echo "usage: $0 --check | $0 <outDir> [extra args]" >&2
  exit 2
fi
shift

mkdir -p "$OUT_DIR" "$REPO_ROOT/.hawa-state/spend"
KEY="$(docker exec "$KEY_SOURCE_CONTAINER" printenv OPENAI_API_KEY)"
if [[ -z "$KEY" ]]; then
  echo "ERROR: no OPENAI_API_KEY in $KEY_SOURCE_CONTAINER." >&2
  exit 1
fi

echo "Running the qualification in $IMAGE, writing to $OUT_DIR"
docker run --rm \
  -v "$REPO_ROOT/scripts:/app/scripts:ro" \
  -v "$REPO_ROOT/packages/creative/dist:/app/packages/creative/dist:ro" \
  -v "$REPO_ROOT/packages/domain/dist:/app/packages/domain/dist:ro" \
  -v "$REPO_ROOT/$OUT_DIR:/app/qualification-out" \
  -v "$REPO_ROOT/.hawa-state/spend:/app/spend-ledger" \
  -e OPENAI_API_KEY="$KEY" \
  -e HAWA_QUALIFICATION_OUT_DIR=/app/qualification-out \
  -e HAWA_SPEND_STATE_DIR=/app/spend-ledger \
  -e HAWA_MODEL_TIER="${HAWA_MODEL_TIER:-production}" \
  -e HAWA_QUALIFICATION_BRIEF_SET="${HAWA_QUALIFICATION_BRIEF_SET:-qualification}" \
  -w /app "$IMAGE" \
  ./node_modules/.bin/tsx scripts/run_p10_qualification.ts "$@"
