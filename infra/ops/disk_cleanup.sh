#!/usr/bin/env bash
# Keeps Hawa's own disk use bounded. On 2026-09-23 the Mac reached 98% and the watchdog alerted every
# 30 minutes: 26 GB of old deploy dumps sat in ~/.hawa/snapshots_archive, which nothing pruned (the
# nightly job prunes its own archive, elsewhere), and Docker's build cache held 24 GB.
#
#   - pre-deploy database dumps (infra/backup/snapshots): the newest $HAWA_PREDEPLOY_KEEP (10);
#   - the old archive of deploy dumps: the newest dump of each day, for $HAWA_ARCHIVE_DAYS (30) days;
#   - plain SQL dumps that are kept are compressed (zstd, checked before the original goes: about
#     17 times smaller, because a dump repeats the same images many times);
#   - Docker's build cache held to $HAWA_BUILD_CACHE_MAX (8 GB), and images no tag or container uses.
#
# Nightly dumps (hawa_*.dump) keep their own retention in nightly_backup.sh. Nothing else is touched.
#
#   bash infra/ops/disk_cleanup.sh             # clean everything above, then report
#   bash infra/ops/disk_cleanup.sh --backups   # the dumps only (what the nightly backup runs)
#   bash infra/ops/disk_cleanup.sh --report    # report only, delete nothing
set -Eeuo pipefail; umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$ROOT/infra/backup/snapshots"
ARCHIVE="${HAWA_BACKUP_ARCHIVE_DIR:-$HOME/.hawa/snapshots_archive}"
KEEP_PREDEPLOY="${HAWA_PREDEPLOY_KEEP:-10}"
ARCHIVE_DAYS="${HAWA_ARCHIVE_DAYS:-30}"
CACHE_MAX="${HAWA_BUILD_CACHE_MAX:-8GB}"
MODE="${1:-}"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"

# The UTC stamp in a dump's name (hawa_20260923T183220Z.sql, predeploy_20260923T183220Z.dump).
stamp_of() { basename "$1" | sed -E 's/^(hawa|predeploy)_([0-9]{8}T[0-9]{6}Z).*/\2/'; }

# "<stamp> <path>" for each existing file matching the patterns, newest first.
dumps() {
  local f
  for f in "$@"; do
    if [[ -e "$f" ]]; then echo "$(stamp_of "$f") $f"; fi
  done | sort -r
}

# A plain SQL dump becomes .sql.zst; the original goes only after the compressed copy tests whole.
compress() {
  local f="$1"
  command -v zstd >/dev/null || return 0
  zstd -q -T0 -6 --long=27 -f "$f" -o "$f.zst" && zstd -q -t --long=27 "$f.zst" && touch -r "$f" "$f.zst" && rm -f "$f"
}

report() {
  local d
  for d in "$DIR" "$ARCHIVE"; do
    if [[ -d "$d" ]]; then du -sh "$d" | awk -v n="${d/#$HOME/~}" '{print "backups", $1, n}'; fi
  done
  if docker info >/dev/null 2>&1; then
    docker system df --format '{{.Type}} {{.Size}} ({{.Reclaimable}} reclaimable)' | grep -E '^(Build Cache|Images)' || true
  fi
  df -h "$ROOT" | awk 'NR==2{print "disk", $5, "used,", $4, "free"}'
}

if [[ "$MODE" == "--report" ]]; then report; exit 0; fi

# 1. Pre-deploy dumps. deploy.sh writes predeploy_*.dump; before 2026-09-23 it wrote plain
#    hawa_*.sql, which are pre-deploy dumps too (nightly dumps are hawa_*.dump, not matched here).
if [[ -d "$DIR" ]]; then
  n=0
  while read -r _ f; do
    n=$((n + 1))
    if (( n > KEEP_PREDEPLOY )); then rm -f "$f" "$f.sha256"
    elif [[ "$f" == *.sql ]]; then compress "$f"; fi
  done < <(dumps "$DIR"/predeploy_*.dump "$DIR"/hawa_*.sql "$DIR"/hawa_*.sql.zst)
fi

# 2. The old archive of deploy dumps (deploy.sh no longer writes to it): one dump a day, 30 days.
if [[ -d "$ARCHIVE" ]]; then
  cutoff="$(date -u -v-"${ARCHIVE_DAYS}"d +%Y%m%d 2>/dev/null || date -u -d "-${ARCHIVE_DAYS} days" +%Y%m%d)"
  last_day=""
  while read -r stamp f; do
    day="${stamp:0:8}"
    if [[ "$day" < "$cutoff" || "$day" == "$last_day" ]]; then rm -f "$f" "$f.sha256"; continue; fi
    last_day="$day"
    if [[ "$f" == *.sql ]]; then compress "$f"; fi
  done < <(dumps "$ARCHIVE"/hawa_*.sql "$ARCHIVE"/hawa_*.sql.zst "$ARCHIVE"/hawa_*.dump)
fi

# 3. Docker: build cache held to a ceiling (a rebuild recreates what it needs), and dangling images.
#    Images a container uses, even a stopped one, are never removed.
if [[ "$MODE" != "--backups" ]] && docker info >/dev/null 2>&1; then
  docker builder prune -f --max-used-space "$CACHE_MAX" >/dev/null 2>&1 \
    || docker builder prune -f --keep-storage "$CACHE_MAX" >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
fi

report
