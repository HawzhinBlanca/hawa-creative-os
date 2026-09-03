#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${RESTORE_ROOT:?Set RESTORE_ROOT to an empty test directory}"
: "${PGBACKREST_STANZA:?Set PGBACKREST_STANZA}"
: "${BACKUP_REPOSITORY:?Set BACKUP_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}"

[[ "$RESTORE_ROOT" == /srv/hawa/restore-tests/* ]] || {
  echo "RESTORE_ROOT must be under /srv/hawa/restore-tests" >&2; exit 64;
}
[[ ! -e "$RESTORE_ROOT" ]] || { echo "RESTORE_ROOT already exists" >&2; exit 65; }
mkdir -p "$RESTORE_ROOT"/{postgres,files,evidence}

start_epoch=$(date +%s)
pgbackrest --stanza="$PGBACKREST_STANZA" --pg1-path="$RESTORE_ROOT/postgres" restore
restic -r "$BACKUP_REPOSITORY" restore latest --target "$RESTORE_ROOT/files" --tag hawa-creative-os

find "$RESTORE_ROOT" -type f -print0 | sort -z | xargs -0 sha256sum > "$RESTORE_ROOT/evidence/file-sha256.txt"
end_epoch=$(date +%s)
printf '{"startedAt":"%s","completedAt":"%s","durationSeconds":%d,"status":"restored-awaiting-application-verification"}\n' \
  "$(date -u -d @"$start_epoch" +%FT%TZ)" "$(date -u -d @"$end_epoch" +%FT%TZ)" "$((end_epoch-start_epoch))" \
  > "$RESTORE_ROOT/evidence/restore.json"

echo "Restore material is ready. Start the isolated test stack and run runbooks/10_backup_restore.md verification before marking passed."
