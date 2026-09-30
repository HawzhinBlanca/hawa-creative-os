#!/usr/bin/env bash
# Keeps Hawa's own disk use bounded. On 2026-09-23 the Mac reached 98% and the watchdog alerted every
# 30 minutes: 26 GB of old deploy dumps sat in ~/.hawa/snapshots_archive, which nothing pruned (the
# nightly job prunes its own archive, elsewhere), and Docker's build cache held 24 GB.
#
#   - pre-deploy database dumps (infra/backup/snapshots): the newest $HAWA_PREDEPLOY_KEEP (10);
#   - the old archive of deploy dumps: the newest dump of each day, for $HAWA_ARCHIVE_DAYS (30) days;
#   - plain SQL dumps that are kept are compressed (zstd, checked before the original goes: about
#     17 times smaller, because a dump repeats the same images many times);
#   - Docker's build cache held to $HAWA_BUILD_CACHE_MAX (8 GB), and images no tag or container uses;
#     and, while the cache is still over that, Hawa's own images that nothing uses (see step 4);
#   - container logs Vector writes (infra/docker/vector.yaml, ~/.hawa/logs/containers/<YYYY-MM-DD>/):
#     the last $HAWA_LOG_DAYS (30) days, and the oldest days beyond $HAWA_LOG_MAX_MB (2048 MB). Vector
#     never deletes, so this is their only retention.
#
# Every step says what it removed and freed, and a step that fails says why (ADR-158): every Docker
# call used to go to /dev/null, and a build-cache cap that never held went unnoticed for days.
#
# Nightly dumps (hawa_*.dump) keep their own retention in nightly_backup.sh. Nothing else is touched:
# in particular never the file store's archive ($ARCHIVE/blobs: packs and their index) or its
# manifests (hawa_*.blobs), which nightly_backup.sh prunes by what the kept dumps still need, and never
# a file of the store itself (~/.hawa/blobs), which only the collector deletes. Only their half-written
# temporary files (*.part) older than a day go. Every glob below is hawa_* or predeploy_* at depth 1.
#
#   bash infra/ops/disk_cleanup.sh             # clean everything above, then report
#   bash infra/ops/disk_cleanup.sh --backups   # the dumps and the container logs (what the nightly backup runs)
#   bash infra/ops/disk_cleanup.sh --report    # report only, delete nothing
set -Eeuo pipefail; umask 077
# pwd -P: started through ~/.hawa/current, the run stays on that release even if a deploy switches it (ADR-158).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DIR="${HAWA_BACKUP_SNAPSHOT_DIR:-$ROOT/infra/backup/snapshots}"
ARCHIVE="${HAWA_BACKUP_ARCHIVE_DIR:-$HOME/.hawa/snapshots_archive}"
BLOBS="${HAWA_BLOBS_DIR:-$HOME/.hawa/blobs}"
KEEP_PREDEPLOY="${HAWA_PREDEPLOY_KEEP:-10}"
ARCHIVE_DAYS="${HAWA_ARCHIVE_DAYS:-30}"
CACHE_MAX="${HAWA_BUILD_CACHE_MAX:-8GB}"
IMAGE_KEEP_DAYS="${HAWA_IMAGE_KEEP_DAYS:-7}"
CONTAINER_LOGS="${HAWA_CONTAINER_LOGS_DIR:-$HOME/.hawa/logs/containers}"
LOG_DAYS="${HAWA_LOG_DAYS:-30}"
LOG_MAX_MB="${HAWA_LOG_MAX_MB:-2048}"
MODE="${1:-}"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"
# BSD or GNU date, chosen by uname (ADR-141).
source "$ROOT/infra/ops/host_lib.sh"

# The UTC stamp in a dump's name (hawa_20260923T183220Z.sql, predeploy_20260923T183220Z.dump).
stamp_of() { basename "$1" | sed -E 's/^(hawa|predeploy)_([0-9]{8}T[0-9]{6}Z).*/\2/'; }

# "<stamp> <path>" for each existing file matching the patterns, newest first.
dumps() {
  local f
  for f in "$@"; do
    if [[ -e "$f" ]]; then echo "$(stamp_of "$f") $f"; fi
  done | sort -r
}

# Removes files and says so: "removed <name> (<size>): <why>". FREED_KB adds up what the files took.
FREED_KB=0
remove() { # why, file...
  local why="$1" f kb; shift
  for f in "$@"; do
    [[ -e "$f" ]] || continue
    kb="$(du -sk "$f" 2>/dev/null | awk '{print $1}')"; kb="${kb:-0}"
    if rm -f "$f"; then
      FREED_KB=$((${FREED_KB:-0} + kb)); echo "removed $(basename "$f") (${kb} KB): ${why}"
    else
      echo "ERROR: could not remove $f" >&2
    fi
  done
}

# A plain SQL dump becomes .sql.zst; the original goes only after the compressed copy tests whole.
# It is written as .zst.part first, so a run cut short (a full disk, a reboot) never leaves a broken
# .sql.zst that the listing below would count as a kept dump.
compress() {
  local f="$1" before after
  command -v zstd >/dev/null || { echo "zstd not installed: $(basename "$f") is kept uncompressed"; return 0; }
  before="$(du -sk "$f" | awk '{print $1}')"
  if zstd -q -T0 -6 --long=27 -f "$f" -o "$f.zst.part" && zstd -q -t --long=27 "$f.zst.part" \
    && touch -r "$f" "$f.zst.part" && mv -f "$f.zst.part" "$f.zst"; then
    rm -f "$f"; after="$(du -sk "$f.zst" | awk '{print $1}')"
    FREED_KB=$((FREED_KB + before - after)); echo "compressed $(basename "$f") (${before} KB to ${after} KB)"
  else
    rm -f "$f.zst.part"; return 1
  fi
}

# Deletes the day directories of container logs older than $2 days (UTC), then, oldest first, until
# the rest fits in $3 MB: Docker's own driver capped each container at 5 x 50 MB, Vector caps nothing,
# and an error loop can write gigabytes in a day. Today's directory is never deleted. Only directories
# named as a day are looked at, so nothing else under the logs directory can go.
prune_container_logs() {
  local dir="$1" days="$2" max_mb="$3" cutoff today d kb
  [[ -d "$dir" ]] || return 0
  cutoff="$(hawa_utc_days_ago "$days" %Y-%m-%d)"
  today="$(date -u +%Y-%m-%d)"
  for d in "$dir"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
    if [[ -d "$d" && "$(basename "$d")" < "$cutoff" ]]; then
      kb="$(du -sk "$d" | awk '{print $1}')"
      rm -rf -- "$d" && FREED_KB=$((${FREED_KB:-0} + kb)) && echo "container logs older than ${days} days: removed $(basename "$d") (${kb} KB)"
    fi
  done
  for d in "$dir"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
    [[ -d "$d" && "$(basename "$d")" != "$today" ]] || continue
    (( $(du -sk "$dir" | awk '{print $1}') > max_mb * 1024 )) || break
    kb="$(du -sk "$d" | awk '{print $1}')"
    echo "container logs over ${max_mb} MB: removed $(basename "$d") (${kb} KB)"
    rm -rf -- "$d" && FREED_KB=$((${FREED_KB:-0} + kb))
  done
}

# Bytes in a size as docker prints it (31.73GB, 512MB, 0B); 8GB is 8 000 000 000, as Docker counts.
to_bytes() {
  awk -v s="$1" 'BEGIN { if (match(s, /^[0-9.]+/)) { n = substr(s, 1, RLENGTH); u = toupper(substr(s, RLENGTH + 1)) } else { print 0; exit }
    m = 1; if (u ~ /^K/) m = 1e3; else if (u ~ /^M/) m = 1e6; else if (u ~ /^G/) m = 1e9; else if (u ~ /^T/) m = 1e12
    printf "%.0f\n", n * m }'
}
build_cache_size() { { docker system df --format '{{.Type}}|{{.Size}}' 2>&1 || true; } | awk -F'|' '$1=="Build Cache"{print $2}'; }
# What a docker prune printed as freed ("Total: 1.2GB", "Total reclaimed space: 1.2GB").
freed_of() { sed -nE 's/^Total( reclaimed space)?:[[:space:]]*//p' <<< "$1" | tail -1; }
# Runs one docker prune and says what it freed, or why it failed.
docker_step() { # label, command...
  local label="$1" out rc=0; shift
  out="$("$@" 2>&1)" || rc=$?
  if [[ $rc == 0 ]]; then echo "${label}: freed $(freed_of "$out" | grep . || echo 0B)"; return 0; fi
  echo "ERROR: ${label} failed (exit ${rc}): $(tail -3 <<< "$out" | tr '\n' ' ')" >&2
  return "$rc"
}
prune_build_cache() {
  local out rc=0
  out="$(docker builder prune -f --max-used-space "$CACHE_MAX" 2>&1)" || rc=$?
  if [[ $rc != 0 && "$out" == *"unknown flag"* ]]; then
    # Docker before 28 (buildx before 0.17) knows the same limit as --keep-storage.
    docker_step "build cache over ${CACHE_MAX}" docker builder prune -f --keep-storage "$CACHE_MAX" || true; return 0
  fi
  if [[ $rc == 0 ]]; then echo "build cache over ${CACHE_MAX}: freed $(freed_of "$out" | grep . || echo 0B)"
  else echo "ERROR: build cache prune failed (exit ${rc}): $(tail -3 <<< "$out" | tr '\n' ' ')" >&2; fi
}
# Hawa's own images (hawa-*) that no container uses, running or stopped, that production's compose files
# do not name, and that are older than $IMAGE_KEEP_DAYS days: experiments and superseded builds. Docker
# refuses to remove an image a container uses; nothing else (other projects' images, bases) is touched.
old_hawa_images() {
  local protected used
  protected="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]@]+).*/\1/p' "$ROOT/infra/docker/docker-compose.prod.yml" "$ROOT/infra/docker/canva-release.override.yml" 2>/dev/null | tr '\n' ' ')"
  used="$( { docker ps -a --format '{{.Image}}' 2>/dev/null || true; } | tr '\n' ' ')"
  { docker image ls --filter 'reference=hawa-*' --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.CreatedAt}}|{{.Size}}' 2>/dev/null || true; } \
    | python3 -c '
import sys, datetime
days, protected, used = int(sys.argv[1]), set(sys.argv[2].split()), set(sys.argv[3].split())
now = datetime.datetime.now(datetime.timezone.utc)
for line in sys.stdin:
    parts = line.rstrip("\n").split("|")
    if len(parts) != 4 or parts[0].endswith(":<none>"):
        continue
    ref, image_id, created, size = parts
    try:
        when = datetime.datetime.strptime(" ".join(created.split()[:3]), "%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        continue
    if ref in protected or ref in used or image_id in used or (now - when).days < days:
        continue
    print(ref, size)' "$IMAGE_KEEP_DAYS" "$protected" "$used"
}

report() {
  local d
  for d in "$DIR" "$ARCHIVE"; do
    if [[ -d "$d" ]]; then du -sh "$d/" | awk -v n="${d/#$HOME/~}" '{print "backups", $1, n}'; fi
  done
  if [[ -d "$CONTAINER_LOGS" ]]; then du -sh "$CONTAINER_LOGS" | awk -v n="${CONTAINER_LOGS/#$HOME/~}" '{print "logs", $1, n}'; fi
  if [[ -d "$ARCHIVE/blobs" ]]; then du -sh "$ARCHIVE/blobs" | awk -v n="${ARCHIVE/#$HOME/~}/blobs" '{print "backups", $1, n, "(file store packs, included above)"}'; fi
  if [[ -d "$BLOBS" ]]; then du -sh "$BLOBS" | awk -v n="${BLOBS/#$HOME/~}" '{print "files", $1, n}'; fi
  if docker info >/dev/null 2>&1; then
    docker system df --format '{{.Type}} {{.Size}} ({{.Reclaimable}} reclaimable)' | grep -E '^(Build Cache|Images)' || true
  fi
  df -h "$ROOT" | awk 'NR==2{print "disk", $5, "used,", $4, "free"}'
}

if [[ "$MODE" == "--report" ]]; then report; exit 0; fi

# Everything to delete goes first and compression last, so one dump that will not compress (a disk
# too full for the copy) neither stops the rest nor keeps the surplus that would have made room.
to_compress=()

# Left behind by a run that was cut short: a half-written compressed copy, and a pre-deploy dump
# deploy.sh was still writing or checking (it removes its own on failure; these are a day old).
for d in "$DIR" "$ARCHIVE"; do
  if [[ -d "$d" ]]; then
    while IFS= read -r f; do remove "left by a run cut short, over a day old" "$f"; done \
      < <(find "$d/" -maxdepth 1 \( -name '*.zst.part' -o -name 'predeploy_*.partial' \) -mtime +0)
  fi
done
# The same for the file store: a pack the nightly backup was still writing, and a file a put was still
# writing (the collector also removes these; a day is far longer than either takes).
for d in "$ARCHIVE/blobs" "$BLOBS/tmp"; do
  if [[ -d "$d" ]]; then
    while IFS= read -r f; do remove "half-written, over a day old" "$f"; done < <(find "$d/" -maxdepth 1 -type f -name '*.part' -mtime +0)
  fi
done

# 1. Pre-deploy dumps. deploy.sh writes predeploy_*.dump, with its .sha256 only once the dump has
#    been checked; one without it is not counted as one of the ten. Before 2026-09-23 deploy.sh wrote
#    plain hawa_*.sql, which are pre-deploy dumps too (nightly dumps are hawa_*.dump, not matched here).
if [[ -d "$DIR" ]]; then
  n=0
  while read -r _ f; do
    if [[ "$f" == */predeploy_*.dump && ! -e "$f.sha256" ]]; then continue; fi
    n=$((n + 1))
    if (( n > KEEP_PREDEPLOY )); then remove "beyond the newest ${KEEP_PREDEPLOY} pre-deploy dumps" "$f" "$f.sha256"
    elif [[ "$f" == *.sql ]]; then to_compress+=("$f"); fi
  done < <(dumps "$DIR"/predeploy_*.dump "$DIR"/hawa_*.sql "$DIR"/hawa_*.sql.zst)
fi

# 2. The old archive of deploy dumps (deploy.sh no longer writes to it): one dump a day, 30 days.
if [[ -d "$ARCHIVE" ]]; then
  cutoff="$(hawa_utc_days_ago "$ARCHIVE_DAYS" %Y%m%d)"
  last_day=""
  while read -r stamp f; do
    day="${stamp:0:8}"
    if [[ "$day" < "$cutoff" ]]; then remove "older than ${ARCHIVE_DAYS} days" "$f" "$f.sha256"; continue; fi
    if [[ "$day" == "$last_day" ]]; then remove "a newer dump of the same day is kept" "$f" "$f.sha256"; continue; fi
    last_day="$day"
    if [[ "$f" == *.sql ]]; then to_compress+=("$f"); fi
  done < <(dumps "$ARCHIVE"/hawa_*.sql "$ARCHIVE"/hawa_*.sql.zst "$ARCHIVE"/hawa_*.dump)
fi

for f in ${to_compress[@]+"${to_compress[@]}"}; do
  compress "$f" || echo "WARNING: $(basename "$f") could not be compressed; it is kept as it is" >&2
done

# 3. Container logs: $LOG_DAYS days and $LOG_MAX_MB MB, in the nightly run too (--backups), since
#    nothing else prunes them.
prune_container_logs "$CONTAINER_LOGS" "$LOG_DAYS" "$LOG_MAX_MB"
echo "files: freed $((FREED_KB / 1024)) MB"

# 4. Docker: build cache held to a ceiling (a rebuild recreates what it needs), and dangling images.
#    Images a container uses, even a stopped one, are never removed.
#    With the containerd image store (Docker Desktop's default) most of what `docker system df` calls
#    Build Cache is layers shared with images: 23 of 31.7 GB on 2026-09-30. BuildKit's --max-used-space
#    counts only the rest, so that prune left 31.7 GB standing, every hour, with nothing said (ADR-158).
#    While the cache is over the ceiling, Hawa's own unused images older than $IMAGE_KEEP_DAYS days go
#    (old_hawa_images), which frees their layers, and the cache is pruned again; what still exceeds the
#    ceiling is reported, with its reason.
if [[ "$MODE" != "--backups" ]]; then
  if docker info >/dev/null 2>&1; then
    prune_build_cache
    docker_step "dangling images" docker image prune -f || true
    cap="$(to_bytes "$CACHE_MAX")"; size="$(build_cache_size)"
    if [[ -n "$size" && "$(to_bytes "$size")" -gt "$cap" ]]; then
      echo "build cache is ${size}, over ${CACHE_MAX}: most of it is layers of images; removing Hawa's unused images older than ${IMAGE_KEEP_DAYS} days"
      while read -r ref image_size; do
        [[ -n "$ref" ]] || continue
        if out="$(docker image rm "$ref" 2>&1)"; then echo "removed image ${ref} (${image_size})"
        else echo "ERROR: could not remove image ${ref}: $(tail -1 <<< "$out")" >&2; fi
      done < <(old_hawa_images)
      prune_build_cache
      size="$(build_cache_size)"
      if [[ -n "$size" && "$(to_bytes "$size")" -gt "$cap" ]]; then
        echo "WARNING: build cache is still ${size}, over ${CACHE_MAX}: the rest belongs to images in use, production's own tags, other projects' images or Hawa images newer than ${IMAGE_KEEP_DAYS} days (docker image ls shows them)" >&2
      fi
    fi
  else
    echo "WARNING: Docker is not reachable: build cache and images were not pruned" >&2
  fi
fi

report
