#!/usr/bin/env bash
# Monthly restore drill for data and files (ADR-035, runbooks/10_backup_restore.md). A backup that has
# not been restored is unproven: this restores the newest archived nightly dump into a scratch
# database, unpacks the files its manifest lists from the archive's packs, and checks that every file
# row has its file with the right size and hash. `missing` must be 0.
#
#   bash infra/backup/restore_drill.sh      # what the design.hawa.restore-drill launch agent runs monthly
#
# The result is recorded in hawa.backup_drills (drill_type data_and_blobs), and a failure is sent to the
# operator's Telegram chat. infra/backup/backup_restore_drill.sh is a different, older check: it
# rebuilds the schema from the repository and restores no data.
#
# Needs apps/core/dist (pnpm build) for the store check. Every location and the database can be
# pointed elsewhere, which packages/db/test/blob-backup.test.ts does: HAWA_BACKUP_ARCHIVE_DEST,
# HAWA_BACKUP_ARCHIVE_KEYFILE, HAWA_BACKUP_PG_CONTAINER, HAWA_BACKUP_DB (where the result is recorded),
# HAWA_DRILL_DIR, HAWA_DRILL_DATABASE_URL (the owner's URL on the same server; without it, built from
# infra/docker/.env as deploy.sh does), HAWA_BACKUP_NOTIFY_ENV.
set -Eeuo pipefail; umask 077
# pwd -P: started through ~/.hawa/current, the run stays on that release even if a deploy switches it (ADR-158).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"; cd "$ROOT"
# The SHA-256 tool and the host role, chosen per host (ADR-141).
source "$ROOT/infra/ops/host_lib.sh"
# A standby or retired host runs no drill (ADR-141): production, and its database, live elsewhere.
HAWA_ROLE_NOW="$(hawa_host_role)" || { echo "unrecognised host role '${HAWA_ROLE_NOW}' in $(hawa_host_role_source) (production, standby or retired); no drill was run" >&2; exit 1; }
if [[ "$HAWA_ROLE_NOW" != production ]]; then
  echo "$(date -u +%FT%TZ) SKIP: this host is ${HAWA_ROLE_NOW} ($(hawa_host_role_source)); production runs elsewhere, no drill was run"
  exit 0
fi
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
ARCHIVE_KEYFILE="${HAWA_BACKUP_ARCHIVE_KEYFILE:-}"
PG="${HAWA_BACKUP_PG_CONTAINER:-hawa-production-postgres-1}"; LIVE_DB="${HAWA_BACKUP_DB:-hawa}"
PROD="${HAWA_BACKUP_NOTIFY_ENV:-$ROOT/infra/docker/.env.production}"
DRILL_ROOT="${HAWA_DRILL_DIR:-$HOME/.hawa/drill}"
VERIFY="${HAWA_DRILL_VERIFY_JS:-$ROOT/apps/core/dist/tools/blob-verify.js}"
NOW="$(date -u +%Y%m%dT%H%M%SZ)"; START_TS="$(date -u +%FT%TZ)"; START_S="$(date +%s)"
# Scratch database names end in this run's suffix, so two runs (a manual one beside the nightly, or
# tests in parallel) never share one. Letters and digits only.
SCRATCH_SUFFIX="$(printf '%s' "${HAWA_SCRATCH_DB_SUFFIX:-$$}" | tr -cd 'a-z0-9' | cut -c1-16)"; SCRATCH_SUFFIX="${SCRATCH_SUFFIX:-$$}"
DDB="hawa_drill_$(printf '%s' "$NOW" | tr '[:upper:]' '[:lower:]')_${SCRATCH_SUFFIX}"
WORK=""; DB_CREATED=0
DUMP_NAME=""; TARGET=""; BLOBS_CHECKED=""; MISSING=""; ROWS=""; WITHOUT_ROW=""; RESTATE_ARCHIVE=""; RESTATE_CHECK="off"

notify() { # Telegram, operator chat; values read at call time, never logged
  # `|| true`: under set -e and pipefail a missing file or line would end the script here, with the
  # alert unsent and the wrong exit status.
  local token chat; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2- || true)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1 || true)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" || true
}
# One row per drill in the live database's hawa.backup_drills, passed or failed. Values are built
# only from this script's own variables (numbers, file names it chose), never from file contents.
jnum() { if [[ "$1" =~ ^[0-9]+$ ]]; then echo "$1"; else echo "NULL"; fi; }
record() {
  local status="$1" detail="${2:-}" rto=$(( $(date +%s) - START_S )) target="NULL" dump restate
  detail="$(printf '%s' "$detail" | tr -cd 'A-Za-z0-9 ._:/()=-' | cut -c1-300)"
  # The dump's name comes from a glob over the archive folder: kept to the characters a name has.
  dump="$(printf '%s' "$DUMP_NAME" | tr -cd 'A-Za-z0-9._-' | cut -c1-100)"
  restate="$(printf '%s' "$RESTATE_ARCHIVE" | tr -cd 'A-Za-z0-9._-' | cut -c1-100)"
  if [[ "$TARGET" =~ ^[0-9T:Z-]+$ ]]; then target="'${TARGET}'::timestamptz"; fi
  docker exec -i "$PG" psql -U hawa_owner -d "$LIVE_DB" -v ON_ERROR_STOP=1 -q >/dev/null <<SQL || echo "WARNING: could not record the drill in hawa.backup_drills" >&2
INSERT INTO hawa.backup_drills (tenant_id, started_at, completed_at, target_timestamp, rpo_seconds, rto_seconds, status, evidence, performed_by)
VALUES ('00000000-0000-4000-a000-000000000001', '${START_TS}', now(), ${target},
  extract(epoch FROM ('${START_TS}'::timestamptz - ${target}))::bigint, ${rto}, '${status}',
  jsonb_build_object('drill_type', 'data_and_blobs', 'dump', '${dump}', 'blobs_checked', $(jnum "$BLOBS_CHECKED"),
    'rows', $(jnum "$ROWS"), 'missing', $(jnum "$MISSING"), 'referenced_without_row', $(jnum "$WITHOUT_ROW"),
    'rto_seconds', ${rto}, 'restate_archive', '${restate}', 'restate_check', '${RESTATE_CHECK}', 'detail', '${detail}'),
  '00000000-0000-4000-b000-000000000001');
SQL
}
cleanup() {
  if [[ "$DB_CREATED" == 1 ]]; then docker exec "$PG" dropdb -U hawa_owner --if-exists "$DDB" >/dev/null 2>&1 || echo "WARNING: could not drop $DDB" >&2; fi
  if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi
}
# The run that holds the archive lock fails with 3, so the waiting parent can tell its failure (already
# recorded and alerted) from archive_lock.py's 1 for a busy lock.
FAIL_STATUS=1; [[ -z "${HAWA_ARCHIVE_LOCK_FD:-}" ]] || FAIL_STATUS=3
fail() {
  trap - ERR
  echo "$(date -u +%FT%TZ) DRILL FAIL: $1" >&2
  record failed "$1"
  notify "🔴 Hawa monthly restore drill FAILED: $1"
  exit "$FAIL_STATUS"
}
trap 'fail "stopped unexpectedly at line $LINENO"' ERR
trap cleanup EXIT
decrypt() { # file -> stdout; every caller fails the drill on a non-zero status
  if [[ "$1" == *.enc ]]; then
    # Not fail(): in `decrypt | tar` this runs in a subshell, and fail there would record and alert
    # once, then the caller's `|| fail` a second time.
    [[ -r "$ARCHIVE_KEYFILE" ]] || { echo "$(basename "$1") is encrypted and HAWA_BACKUP_ARCHIVE_KEYFILE is not readable" >&2; return 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$1" -pass "file:$ARCHIVE_KEYFILE"
  else
    cat "$1"
  fi
}

[[ -d "$ARCHIVE_DEST" ]] || fail "no archive at ${ARCHIVE_DEST/#$HOME/~}"
# A busy lock (the nightly backup still writing) is waited for, up to HAWA_DRILL_LOCK_WAIT_SECONDS (3600),
# then fails the drill, recorded and alerted. It used to end the drill at once with exit 1, unrecorded and
# unalerted, and the month went without one (hunt 3).
if [[ -z "${HAWA_ARCHIVE_LOCK_FD:-}" ]]; then
  LOCK_WAIT="${HAWA_DRILL_LOCK_WAIT_SECONDS:-3600}"
  [[ "$LOCK_WAIT" =~ ^[0-9]+$ ]] || fail "HAWA_DRILL_LOCK_WAIT_SECONDS must be a whole number"
  waited=0
  while :; do
    rc=0
    python3 "$ROOT/infra/backup/archive_lock.py" --archive "$ARCHIVE_DEST" --mode shared \
      -- bash "$ROOT/infra/backup/restore_drill.sh" "$@" || rc=$?
    if [[ $rc == 0 ]]; then exit 0; fi
    if [[ $rc != 1 ]]; then exit 1; fi
    (( waited < LOCK_WAIT )) || fail "the backup archive stayed locked for ${LOCK_WAIT} s (the nightly backup still holds it); no drill was run"
    (( waited > 0 )) || echo "waiting for the backup archive lock (the nightly backup holds it)" >&2
    sleep 30; waited=$((waited + 30))
  done
fi
python3 "$ROOT/infra/backup/archive_lock.py" --archive "$ARCHIVE_DEST" --mode shared --check \
  || fail "restore drill does not own this archive lock"
mkdir -p "$DRILL_ROOT"; chmod 700 "$DRILL_ROOT"
WORK="$(mktemp -d "$DRILL_ROOT/${NOW}.XXXXXX")"; chmod 700 "$WORK"

# 1. The newest archived dump, its checksum, and its file manifest.
DUMP="$( { ls -1t "$ARCHIVE_DEST"/hawa_*.dump.enc "$ARCHIVE_DEST"/hawa_*.dump 2>/dev/null || true; } | head -1)"
[[ -n "$DUMP" ]] || fail "no archived dump in ${ARCHIVE_DEST/#$HOME/~}"
DUMP_NAME="$(basename "$DUMP")"; STAMP="$(sed -E 's/^hawa_([0-9]{8}T[0-9]{6}Z)\..*/\1/' <<< "$DUMP_NAME")"
TARGET="$(sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3T\4:\5:\6Z/' <<< "$STAMP")"
MANIFEST="$ARCHIVE_DEST/hawa_${STAMP}.blobs"
[[ -f "$MANIFEST" ]] || fail "$DUMP_NAME has no file manifest (hawa_${STAMP}.blobs); it predates the file store or its night failed"
if [[ -f "$DUMP.sha256" ]]; then
  [[ "$("${HAWA_SHA256[@]}" "$DUMP" | cut -d' ' -f1)" == "$(cut -d' ' -f1 < "$DUMP.sha256")" ]] || fail "$DUMP_NAME does not match its checksum"
fi

# 2. Verify all required packs and extract only validated regular files into a new
# private directory before creating a scratch database. System tar never writes archive paths.
NEEDED="$(wc -l < "$MANIFEST" | tr -d ' ')"
HAWA_BACKUP_ARCHIVE_KEYFILE="$ARCHIVE_KEYFILE" python3 "$ROOT/infra/backup/blob_archive.py" \
  --archive "$ARCHIVE_DEST" --manifest "$MANIFEST" --destination "$WORK/blobs" \
  > "$WORK/archive-verification.json" || fail "file archive verification failed before database restore"

# 3. The dump, restored into a scratch database on the same server.
decrypt "$DUMP" > "$WORK/dump" || fail "could not decrypt $DUMP_NAME (is HAWA_BACKUP_ARCHIVE_KEYFILE readable?)"
docker exec "$PG" createdb -U hawa_owner "$DDB" || fail "could not create $DDB"
DB_CREATED=1
docker exec -i "$PG" pg_restore -U hawa_owner -d "$DDB" --no-owner --no-privileges --exit-on-error < "$WORK/dump" \
  || fail "pg_restore rejected $DUMP_NAME"
rm -f "$WORK/dump"

# 4. The store check against the restored database: every file row has its file, the file hashes to its
#    name and has the row's size. A reference with no row is counted apart (packages/db/src/blobs/verify.ts).
[[ -f "$VERIFY" ]] || fail "$VERIFY is missing (run pnpm build)"
if [[ -z "${HAWA_DRILL_DATABASE_URL:-}" ]]; then
  PGPASS_="$(grep -E '^POSTGRES_PASSWORD=' "$ROOT/infra/docker/.env" 2>/dev/null | cut -d= -f2-)" || PGPASS_=""
  [[ -n "$PGPASS_" ]] || fail "no HAWA_DRILL_DATABASE_URL and no POSTGRES_PASSWORD in infra/docker/.env"
  HAWA_DRILL_DATABASE_URL="postgresql://hawa_owner:${PGPASS_}@127.0.0.1:54332/postgres"
fi
# `trap - ERR` inside $(...): a failing check would otherwise fire the ERR trap in the subshell too (bash
# 3.2 does), and fail() would record and alert a spurious "stopped unexpectedly" before the real failure.
OUTPUT="$(trap - ERR; DATABASE_URL="$HAWA_DRILL_DATABASE_URL" node "$VERIFY" --db "$DDB" --dir "$WORK/blobs" 2>&1)" && RC=0 || RC=$?
LINE="$(printf '%s\n' "$OUTPUT" | grep -E '^\{' | tail -1 || true)"
[[ -n "$LINE" ]] || fail "the store check did not report (exit ${RC}): $(printf '%s' "$OUTPUT" | tail -1 | cut -c1-200)"
num() { printf '%s' "$LINE" | sed -nE "s/.*\"$1\":([0-9]+).*/\1/p"; }
ROWS="$(num rows)"; BLOBS_CHECKED="$(num checked)"; MISSING="$(num missing)"; CORRUPT="$(num corrupt)"
# References the backfill has not copied yet (their bytes are still in the dump's bytea): recorded, not a failure.
WITHOUT_ROW="$(num referencedWithoutRow)"
[[ "$RC" == 0 && "$MISSING" == 0 && "$CORRUPT" == 0 ]] \
  || fail "the store check found missing=${MISSING} corrupt=${CORRUPT} of ${ROWS} file rows in ${DUMP_NAME}"

# Re-read the exact Restate ciphertext paired with the selected dump on a later day. A newer
# unrelated Restate archive cannot satisfy this night. A clean-host start and replay remain R10 gates.
if [[ "${HAWA_RESTATE_BACKUP_ENABLED:-off}" == on ]]; then
  RESTATE_PAIR="$ARCHIVE_DEST/hawa_${STAMP}.restate.json"
  [[ -f "$RESTATE_PAIR" ]] || fail "the selected dump has no same-night Restate pair"
  RESTATE_ARCHIVE="$(basename "$RESTATE_PAIR")"
  HAWA_BACKUP_ARCHIVE_KEYFILE="$ARCHIVE_KEYFILE" \
    python3 "$ROOT/infra/backup/restate_nightly.py" --verify-pair "$RESTATE_PAIR" \
    || fail "the selected dump's Restate pair failed independent verification"
  RESTATE_CHECK="verified_pair"
fi

record passed "rows=${ROWS} needed=${NEEDED}"
echo "✓ restore drill: ${DUMP_NAME} restored, ${BLOBS_CHECKED} of ${ROWS} file rows checked, missing=${MISSING}, in $(( $(date +%s) - START_S )) s"
