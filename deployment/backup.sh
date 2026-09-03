#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${PGBACKREST_STANZA:?Set PGBACKREST_STANZA}"
: "${BACKUP_REPOSITORY:?Set BACKUP_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}"

LOCK=/var/lock/hawa-backup.lock
exec 9>"$LOCK"
flock -n 9 || { echo "backup already running" >&2; exit 75; }

started=$(date -u +%FT%TZ)
echo "[$started] starting PostgreSQL and file backup"

pgbackrest --stanza="$PGBACKREST_STANZA" --type=incr backup
pgbackrest --stanza="$PGBACKREST_STANZA" check

restic -r "$BACKUP_REPOSITORY" backup \
  /srv/hawa/config \
  /srv/hawa/staging \
  /srv/hawa/workflows \
  /srv/hawa/evals \
  --tag hawa-creative-os \
  --exclude-caches

restic -r "$BACKUP_REPOSITORY" check --read-data-subset=1/20
restic -r "$BACKUP_REPOSITORY" forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune

echo "[$(date -u +%FT%TZ)] backup completed"
