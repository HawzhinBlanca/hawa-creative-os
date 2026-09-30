#!/usr/bin/env bash
# Off-site copy of the nightly recovery set (ADR-141, plans/hosting section 6.1). The nightly backup's
# archive sits on the host it protects; this copies the newest complete encrypted set (dump, file
# manifest and packs, and the paired Restate copy) to a second place, verifies it there and prunes
# old sets there. The work is done by infra/backup/offsite_copy.py, which says what a set is.
#
#   bash infra/backup/offsite_copy.sh     # what the design.hawa.offsite-copy agent / hawa-offsite-copy timer runs, 05:30
#
# Off unless configured: with HAWA_OFFSITE_DEST empty it copies nothing, writes nothing and exits 0.
#   HAWA_OFFSITE_DEST        /absolute/path, or [user@]host:path for rsync over ssh
#   HAWA_OFFSITE_RSH         the ssh command for rsync, e.g. "ssh -p 23 -i ~/.ssh/hawa_offsite -o BatchMode=yes"
#   HAWA_OFFSITE_KEEP        sets kept at the destination (14)
#   HAWA_BACKUP_ARCHIVE_DEST, HAWA_BACKUP_ARCHIVE_KEYFILE, HAWA_RESTATE_BACKUP_ENABLED: as the nightly backup's
#   HAWA_OFFSITE_LOCK_WAIT_SECONDS  how long to wait for a nightly backup still holding the archive (1800)
#
# Each run appends one line to snapshots/offsite.log: COPIED or CURRENT (already there, verified again),
# or FAILED. The watchdog reads it through backup_status.py and reports a failed or late copy; a failure
# is also sent to the operator's Telegram chat. Once off-site copying has run here, removing the
# setting is not enough to stop it being expected: remove snapshots/offsite.log as well.
set -Eeuo pipefail; umask 077
# pwd -P: started through ~/.hawa/current, the run stays on that release even if a deploy switches it (ADR-158).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"; cd "$ROOT"
source "$ROOT/infra/ops/host_lib.sh"
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
DIR="${HAWA_BACKUP_SNAPSHOT_DIR:-$ROOT/infra/backup/snapshots}"; LOG="$DIR/offsite.log"
PROD="${HAWA_BACKUP_NOTIFY_ENV:-$ROOT/infra/docker/.env.production}"
WAIT="${HAWA_OFFSITE_LOCK_WAIT_SECONDS:-1800}"

if [[ -z "${HAWA_OFFSITE_DEST:-}" ]]; then
  echo "off-site copy is not configured (HAWA_OFFSITE_DEST is empty); nothing was copied"
  exit 0
fi
HOST_ROLE_RC=0; HOST_ROLE="$(hawa_host_role)" || HOST_ROLE_RC=$?
if [[ "$HOST_ROLE_RC" != 0 ]]; then
  echo "unrecognised host role '${HOST_ROLE}' in $(hawa_host_role_source); nothing was copied" >&2; exit 1
fi
if [[ "$HOST_ROLE" != production ]]; then
  # The production host copies its own archive; this one must not prune the same destination.
  echo "this host is ${HOST_ROLE} ($(hawa_host_role_source)); production runs elsewhere, nothing was copied"
  exit 0
fi

notify() { # Telegram, operator chat; values read at call time, never logged
  local token chat; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2- || true)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1 || true)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" || true
}
fail() { # message, [exit status: 1 in the waiting parent, 3 in the child that holds the lock]
  mkdir -p "$DIR" && chmod 700 "$DIR"
  echo "$(date -u +%FT%TZ) FAILED: $1" | tee -a "$LOG" >&2
  notify "🔴 Hawa off-site backup copy FAILED: $1"
  exit "${2:-1}"
}

# The copy runs holding the archive lock in shared mode: the nightly backup (exclusive) cannot publish
# or prune while a set is read, and a restore drill (shared) may run alongside. A nightly still running
# is waited for; the child exits 3 on its own failure, and archive_lock.py 1 when the lock is busy.
if [[ -z "${HAWA_ARCHIVE_LOCK_FD:-}" ]]; then
  [[ "$WAIT" =~ ^[0-9]+$ ]] || fail "HAWA_OFFSITE_LOCK_WAIT_SECONDS must be a whole number"
  [[ -d "$ARCHIVE_DEST" ]] || fail "no archive at ${ARCHIVE_DEST/#$HOME/~}"
  waited=0
  while :; do
    rc=0
    python3 "$ROOT/infra/backup/archive_lock.py" --archive "$ARCHIVE_DEST" --mode shared \
      -- bash "$ROOT/infra/backup/offsite_copy.sh" "$@" || rc=$?
    [[ $rc == 1 ]] || exit "$rc"
    (( waited < WAIT )) || fail "the archive stayed locked for ${WAIT} s (a nightly backup still running?); nothing was copied"
    sleep 60; waited=$((waited + 60))
  done
fi
python3 "$ROOT/infra/backup/archive_lock.py" --archive "$ARCHIVE_DEST" --mode shared --check \
  || { echo "off-site copy does not hold the archive lock" >&2; exit 3; }

mkdir -p "$DIR" && chmod 700 "$DIR"
ERRFILE="$(mktemp "$DIR/.offsite_err.XXXXXX")"
OUT="$(HAWA_BACKUP_ARCHIVE_DEST="$ARCHIVE_DEST" python3 "$ROOT/infra/backup/offsite_copy.py" --apply 2>"$ERRFILE")" && RC=0 || RC=$?
ERR="$(tail -1 "$ERRFILE" 2>/dev/null || true)"; rm -f "$ERRFILE"
[[ $RC == 0 ]] || fail "${ERR:-offsite_copy.py exited ${RC}}" 3
field() { printf '%s' "$OUT" | python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1]); print(len(v) if isinstance(v,list) else v)' "$1"; }
STATUS="$(field status)"; SET="$(field stamp)"
LINE="$(date -u +%FT%TZ) $(tr '[:lower:]' '[:upper:]' <<< "$STATUS") ${SET} files=$(field files) bytes=$(field bytes) verified=$(field verified) pruned_sets=$(field prunedSets) pruned_packs=$(field prunedPacks) skipped_newer=$(field skippedNewer)"
mkdir -p "$DIR" && chmod 700 "$DIR"
echo "$LINE" >> "$LOG"
echo "✓ off-site copy ${STATUS}: set ${SET}, verified at the destination ($(field verified))"
