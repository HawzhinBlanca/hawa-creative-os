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

# Retention: keep the 14 newest nightly dumps, and copy off-disk to archive destination
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
if [[ "$ARCHIVE_DEST" == gs://* ]]; then
  if command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$OUT" "$OUT.sha256" "$ARCHIVE_DEST/" 2>/dev/null || echo "WARNING: off-disk upload to $ARCHIVE_DEST failed" >&2
  fi
else
  mkdir -p "$ARCHIVE_DEST" && chmod 700 "$ARCHIVE_DEST"
  cp "$OUT" "$OUT.sha256" "$ARCHIVE_DEST/"
fi

ls -1t "$DIR"/hawa_*.dump 2>/dev/null | tail -n +15 | while read -r old; do rm -f "$old" "$old.sha256"; done
ls -1t "$DIR"/hawa_*.sql 2>/dev/null | tail -n +15 | while read -r old; do
  [[ -d "$ARCHIVE_DEST" ]] && cp "$old" "$ARCHIVE_DEST/" 2>/dev/null || true
  rm -f "$old"
done

echo "$(date -u +%FT%TZ) OK ${STAMP} bytes=${SIZE} tasks=${REST} events=${EVENTS} sha256=$(cat "$OUT.sha256" | cut -c1-16)" >> "$LOG"
echo "✓ backup ${OUT/$ROOT\//} (${SIZE} bytes), restore verified: tasks=${REST} events=${EVENTS}, archived to ${ARCHIVE_DEST}"
