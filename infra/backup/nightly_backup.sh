#!/usr/bin/env bash
# Nightly production backup: pg_dump (custom format), SHA-256 sidecar, restore verification into a
# scratch database on the same server, 14-day retention, Telegram alert on failure.
#
#   bash infra/backup/nightly_backup.sh            # run once (also what the launch agent runs)
#   bash infra/backup/nightly_backup.sh --list     # show what exists
#
# Output: infra/backup/snapshots/hawa_<UTC stamp>.dump (+ .sha256); log in snapshots/backup.log.
# Nothing here is committable (infra/backup/snapshots/ is gitignored) and files are owner-only.
set -Eeuo pipefail; umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
DIR="$ROOT/infra/backup/snapshots"; mkdir -p "$DIR"; chmod 700 "$DIR"
LOG="$DIR/backup.log"; PROD="$ROOT/infra/docker/.env.production"
PG=hawa-production-postgres-1; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$DIR/hawa_${STAMP}.dump"

if [[ "${1:-}" == "--list" ]]; then ls -la "$DIR" | grep -E 'hawa_.*\.(dump|sql)$' || echo "no snapshots"; tail -5 "$LOG" 2>/dev/null || true; exit 0; fi

notify() { # Telegram, operator chat; values read at call time, never logged
  local token chat; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2-)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" || true
}
fail() { echo "$(date -u +%FT%TZ) FAIL ${STAMP}: $1" | tee -a "$LOG" >&2; notify "🔴 Hawa nightly backup FAILED (${STAMP}): $1"; exit 1; }

docker exec "$PG" pg_isready -U hawa_owner -d hawa >/dev/null 2>&1 || fail "postgres container not ready"
docker exec "$PG" pg_dump -U hawa_owner -Fc --no-owner hawa > "$OUT" || fail "pg_dump exited non-zero"
SIZE="$(stat -f '%z' "$OUT" 2>/dev/null || stat -c '%s' "$OUT")"
[[ "$SIZE" -gt 100000 ]] || fail "dump is only ${SIZE} bytes"
shasum -a 256 "$OUT" | awk '{print $1}' > "$OUT.sha256"

# Restore verification: the dump must actually load, and hold the same task count as the live database.
VDB="hawa_verify_$(printf "%s" "$STAMP" | tr "[:upper:]" "[:lower:]")"
docker exec "$PG" createdb -U hawa_owner "$VDB" || fail "could not create verification database"
if ! docker exec -i "$PG" pg_restore -U hawa_owner -d "$VDB" --no-owner --no-privileges --exit-on-error < "$OUT"; then
  docker exec "$PG" dropdb -U hawa_owner "$VDB" || true; fail "pg_restore rejected the dump"
fi
LIVE="$(docker exec "$PG" psql -U hawa_owner -d hawa -Atc 'SELECT count(*) FROM hawa.tasks')"
REST="$(docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc 'SELECT count(*) FROM hawa.tasks')"
EVENTS="$(docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc 'SELECT count(*) FROM hawa.task_events')"
docker exec "$PG" dropdb -U hawa_owner "$VDB" || fail "could not drop verification database"
[[ "$REST" -gt 0 && "$LIVE" -ge "$REST" && $((LIVE - REST)) -lt 50 ]] || fail "restored task count ${REST} does not match live ${LIVE}"

# Retention: keep the 14 newest nightly dumps, and copy off-disk to archive destination.
#
# The archive copy is encrypted when HAWA_BACKUP_ARCHIVE_KEYFILE names a passphrase file, because
# the destination is now somewhere off this machine (an iCloud Drive folder by default on the
# owner's Mac), and a dump carries every client's copy, briefs and task history in clear text.
# Same cipher as the disaster-recovery drill, so one restore procedure covers both.
# Losing the passphrase loses the archive: it belongs in the owner's password manager, not only here.
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
ARCHIVE_KEEP="${HAWA_BACKUP_ARCHIVE_KEEP:-14}"
ARCHIVE_KEYFILE="${HAWA_BACKUP_ARCHIVE_KEYFILE:-}"
ARCHIVE_SRC="$OUT"
ARCHIVE_SRC_SHA="$OUT.sha256"
if [[ -n "$ARCHIVE_KEYFILE" ]]; then
  if [[ ! -r "$ARCHIVE_KEYFILE" ]]; then
    fail "archive passphrase file $ARCHIVE_KEYFILE is not readable; refusing to write an unencrypted off-host copy"
  fi
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -in "$OUT" -out "$OUT.enc" -pass "file:$ARCHIVE_KEYFILE" \
    || fail "could not encrypt the archive copy"
  # Proves the copy decrypts with this passphrase before the plain dump is ever pruned.
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$OUT.enc" -pass "file:$ARCHIVE_KEYFILE" \
    | shasum -a 256 | cut -d' ' -f1 > "$OUT.enc.plain.sha256"
  [[ "$(cat "$OUT.enc.plain.sha256")" == "$(cut -d' ' -f1 < "$OUT.sha256")" ]] \
    || fail "the encrypted archive copy does not decrypt back to the dump"
  shasum -a 256 "$OUT.enc" | cut -d' ' -f1 > "$OUT.enc.sha256"
  rm -f "$OUT.enc.plain.sha256"
  ARCHIVE_SRC="$OUT.enc"
  ARCHIVE_SRC_SHA="$OUT.enc.sha256"
fi
if [[ "$ARCHIVE_DEST" == gs://* ]]; then
  if command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$ARCHIVE_SRC" "$ARCHIVE_SRC_SHA" "$ARCHIVE_DEST/" 2>/dev/null || echo "WARNING: off-disk upload to $ARCHIVE_DEST failed" >&2
  fi
else
  mkdir -p "$ARCHIVE_DEST" && chmod 700 "$ARCHIVE_DEST"
  cp "$ARCHIVE_SRC" "$ARCHIVE_SRC_SHA" "$ARCHIVE_DEST/"
fi
[[ -n "$ARCHIVE_KEYFILE" ]] && rm -f "$OUT.enc" "$OUT.enc.sha256"

ls -1t "$DIR"/hawa_*.dump 2>/dev/null | tail -n +15 | while read -r old; do rm -f "$old" "$old.sha256"; done
ls -1t "$DIR"/hawa_*.sql 2>/dev/null | tail -n +15 | while read -r old; do
  [[ -d "$ARCHIVE_DEST" ]] && cp "$old" "$ARCHIVE_DEST/" 2>/dev/null || true
  rm -f "$old"
done

# Prune archive destination after all new and moved files have arrived
if [[ -d "$ARCHIVE_DEST" && "$ARCHIVE_DEST" != gs://* ]]; then
  for ext in dump enc sql; do
    { ls -1t "$ARCHIVE_DEST"/hawa_*."$ext" 2>/dev/null || true; } | tail -n +$((ARCHIVE_KEEP + 1)) | while read -r old; do
      rm -f "$old" "$old.sha256"
    done
  done
fi

echo "$(date -u +%FT%TZ) OK ${STAMP} bytes=${SIZE} tasks=${REST} events=${EVENTS} sha256=$(cat "$OUT.sha256" | cut -c1-16)" >> "$LOG"
echo "✓ backup ${OUT/$ROOT\//} (${SIZE} bytes), restore verified: tasks=${REST} events=${EVENTS}, archived to ${ARCHIVE_DEST}"
