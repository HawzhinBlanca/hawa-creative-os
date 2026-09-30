#!/usr/bin/env bash
# Nightly production backup: pg_dump (custom format), SHA-256 sidecar, restore verification into a
# scratch database on the same server, 14-day retention, Telegram alert on failure. Then the file
# store (ADR-035): every file the dump references must be on disk, new files go into the archive as
# one encrypted pack, and the garbage collector runs last, after a verified backup has been archived.
#
#   bash infra/backup/nightly_backup.sh            # run once (also what the launch agent runs)
#   bash infra/backup/nightly_backup.sh --list     # show what exists
#
# Output: infra/backup/snapshots/hawa_<UTC stamp>.dump (+ .sha256); log in snapshots/backup.log.
# Nothing here is committable (infra/backup/snapshots/ is gitignored) and files are owner-only.
#
# The archive (HAWA_BACKUP_ARCHIVE_DEST, ~/.hawa/snapshots_archive by default) holds, per night:
#   hawa_<STAMP>.dump[.enc] (+ .sha256)   the dump
#   hawa_<STAMP>.blobs                    the manifest: every store file present right after the dump
# and, shared by all nights:
#   blobs/blobpack_<STAMP>.tar[.enc]      the files that were new that night (tar of sha256/ab/<hex>.<ext>)
#   blobs/index.tsv                       "<path>\t<pack>" for every packed file
# Files never change, so a file is packed once; a pack goes when no kept manifest lists any of its files.
#
# Every location and the database can be pointed elsewhere, which the tests do (packages/db/test/
# blob-backup.test.ts runs this whole script against a test database and temporary directories):
#   HAWA_BACKUP_SNAPSHOT_DIR, HAWA_BACKUP_PG_CONTAINER, HAWA_BACKUP_DB, HAWA_BACKUP_NOTIFY_ENV,
#   HAWA_BACKUP_MIN_BYTES, HAWA_BLOBS_DIR, HAWA_BLOB_GC_CMD (or HAWA_BLOB_GC=off).
set -Eeuo pipefail; umask 077
# pwd -P: started through ~/.hawa/current, the run stays on that release even if a deploy switches it (ADR-158).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"; cd "$ROOT"
# GNU or BSD stat and the SHA-256 tool, chosen by uname; the host role (ADR-141).
source "$ROOT/infra/ops/host_lib.sh"
DIR="${HAWA_BACKUP_SNAPSHOT_DIR:-$ROOT/infra/backup/snapshots}"; mkdir -p "$DIR"; chmod 700 "$DIR"
LOG="$DIR/backup.log"; PROD="${HAWA_BACKUP_NOTIFY_ENV:-$ROOT/infra/docker/.env.production}"
PG="${HAWA_BACKUP_PG_CONTAINER:-hawa-production-postgres-1}"; DB="${HAWA_BACKUP_DB:-hawa}"
MIN_BYTES="${HAWA_BACKUP_MIN_BYTES:-100000}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$DIR/hawa_${STAMP}.dump"
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
ARCHIVE_KEEP="${HAWA_BACKUP_ARCHIVE_KEEP:-14}"
ARCHIVE_KEYFILE="${HAWA_BACKUP_ARCHIVE_KEYFILE:-}"
# The file store on this host (the containers mount it at /var/lib/hawa/blobs) and the collector's grace.
BLOBS="${HAWA_BLOBS_DIR:-$HOME/.hawa/blobs}"
GRACE_DAYS="${HAWA_BLOB_GRACE_DAYS:-15}"

if [[ "${1:-}" == "--list" ]]; then ls -la "$DIR" | grep -E 'hawa_.*\.(dump|sql)$' || echo "no snapshots"; tail -5 "$LOG" 2>/dev/null || true; exit 0; fi

notify() { # Telegram, operator chat; values read at call time, never logged
  # `|| true`: under set -e and pipefail a missing file or line would end the script here, with the
  # alert unsent and the wrong exit status.
  local token chat; token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROD" 2>/dev/null | cut -d= -f2- || true)"; chat="$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$PROD" 2>/dev/null | cut -d= -f2- | cut -d, -f1 || true)"
  [[ -n "$token" && -n "$chat" ]] || return 0
  curl -s -m 15 -o /dev/null -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" || true
}
# A dump that failed its own checks is renamed .failed: under its real name the watchdog took it for a
# fresh backup and the retention below for one of the fourteen. Only the newest two are kept, to look
# at. A failure after the checks (the archive copy) leaves the verified dump as it is.
DUMP_VERIFIED=0; DUMP_STARTED=0; LOCK_OWNED=0
fail() {
  trap - ERR
  if [[ "$DUMP_STARTED" == 1 && "$DUMP_VERIFIED" == 0 && -e "$OUT" ]]; then mv -f "$OUT" "$OUT.failed" || true; rm -f "$OUT.sha256"; fi
  if [[ "$LOCK_OWNED" == 1 ]]; then
    { ls -1t "$DIR"/hawa_*.dump.failed 2>/dev/null || true; } | tail -n +3 | while read -r old; do rm -f "$old"; done
  fi
  echo "$(date -u +%FT%TZ) FAIL ${STAMP}: $1" | tee -a "$LOG" >&2; notify "🔴 Hawa nightly backup FAILED (${STAMP}): $1"; exit 1
}
# Anything else that stops the script is a failure too, and says so, instead of ending in silence.
trap 'fail "stopped unexpectedly at line $LINENO"' ERR
# A command substitution whose failure is handled (`|| X=`) drops the trap inside with `trap - ERR`:
# bash 3.2 fires it in the $(...) subshell too, and fail() there would log and alert a FAIL for a night
# that then carries on (a failed collector run was reported as a failed backup).
# Scratch space for this run (reference lists, the pack being checked). Temporary copies never outlive
# the run, whatever happens: the encrypted dump, and a pack still named .part.
WORK=""; PACK_PART=""; ARCHIVE_PART=""
cleanup() {
  if [[ "$DUMP_STARTED" == 1 ]]; then rm -f "$OUT.enc" "$OUT.enc.sha256" "$OUT.enc.plain.sha256"; fi
  if [[ -n "$PACK_PART" ]]; then rm -f "$PACK_PART"; fi
  if [[ -n "$ARCHIVE_PART" ]]; then rm -f "$ARCHIVE_PART"; fi
  if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

# A standby or retired host takes no backup (ADR-141): production runs on another host, and a paired
# run here would stop this host's Restate and pause its intake. The skip is logged (backup_status.py
# reads only OK and FAIL lines) and alerts nobody. A role this script does not know fails the night.
HOST_ROLE="$(trap - ERR; hawa_host_role)" || fail "unrecognised host role '${HOST_ROLE}' in $(hawa_host_role_source) (production, standby or retired); no backup was taken"
if [[ "$HOST_ROLE" != production ]]; then
  echo "$(date -u +%FT%TZ) SKIP ${STAMP}: this host is ${HOST_ROLE} ($(hawa_host_role_source)); production runs elsewhere, no backup was taken" | tee -a "$LOG"
  exit 0
fi

# The collector deletes a file once it has been unreferenced for GRACE_DAYS. The oldest dump the archive
# keeps is ARCHIVE_KEEP nights old, and every file it references must still be packed or on disk when
# it is restored: so the grace must be longer than the retention (15 days against 14 nightly copies).
[[ "$ARCHIVE_KEEP" =~ ^[0-9]+$ && "$GRACE_DAYS" =~ ^[0-9]+$ ]] || fail "HAWA_BACKUP_ARCHIVE_KEEP and HAWA_BLOB_GRACE_DAYS must be whole numbers"
(( ARCHIVE_KEEP >= 1 )) || fail "HAWA_BACKUP_ARCHIVE_KEEP must retain at least one archive"
(( ARCHIVE_KEEP < GRACE_DAYS )) \
  || fail "HAWA_BACKUP_ARCHIVE_KEEP (${ARCHIVE_KEEP}) must be less than HAWA_BLOB_GRACE_DAYS (${GRACE_DAYS}): the oldest kept dump would reference files the collector may already have deleted"
[[ "$ARCHIVE_DEST" != gs://* ]] || fail "gs:// is not supported for complete database and file recovery; use a local archive and separately verify its off-host copy"
if [[ "${HAWA_RESTATE_BACKUP_ENABLED:-off}" == on ]] || \
   { [[ "$ARCHIVE_DEST" != gs://* ]] && compgen -G "$ARCHIVE_DEST/hawa_*.restate.json" >/dev/null; }; then
  [[ -n "$ARCHIVE_KEYFILE" && -r "$ARCHIVE_KEYFILE" && -s "$ARCHIVE_KEYFILE" ]] \
    || fail "paired recovery archive needs a readable nonempty key before any dump is copied"
fi

# Serialize publication, index updates, retention and collection with restores and
# the existing Restate archive tools. The restarted shell inherits an actual locked
# descriptor, checked against this directory; an environment marker alone is insufficient.
if [[ -z "${HAWA_ARCHIVE_LOCK_FD:-}" ]]; then
  python3 "$ROOT/infra/backup/archive_lock.py" --archive "$ARCHIVE_DEST" --mode exclusive \
    -- bash "$ROOT/infra/backup/nightly_backup.sh" "$@" && exit 0
  exit 1
fi
python3 "$ROOT/infra/backup/archive_lock.py" --archive "$ARCHIVE_DEST" --mode exclusive --check \
  || fail "nightly backup does not own this archive lock"
LOCK_OWNED=1
# Orphan cleanup is also a mutation: a contending command must not remove another
# run's workspace before it has acquired the archive lock.
find "$DIR" -maxdepth 1 -name 'hawa_*.dump.enc*' -mmin +120 -delete 2>/dev/null || true
find "$DIR" -maxdepth 1 -name '.work_*' -mmin +120 -exec rm -rf {} + 2>/dev/null || true
WORK="$(mktemp -d "$DIR/.work_${STAMP}.XXXXXX")"
[[ ! -e "$OUT" && ! -L "$OUT" && ! -e "$OUT.enc" && ! -e "$OUT.sha256" ]] \
  || fail "a local snapshot with this timestamp already exists; refusing overwrite"

docker exec "$PG" pg_isready -U hawa_owner -d "$DB" >/dev/null 2>&1 || fail "postgres container not ready"
# zstd with long-distance matching: the dump repeats the same images many times, so it is about an
# eighth of the default compression's size (41 MB against 319 MB on 2026-09-23), and faster.
DUMP_START="$(date +%s)"
DUMP_STARTED=1
docker exec "$PG" pg_dump -U hawa_owner -Fc --no-owner --compress=zstd:long "$DB" > "$OUT" || fail "pg_dump exited non-zero"
DUMP_S=$(( $(date +%s) - DUMP_START ))
SIZE="$(hawa_file_size "$OUT")"
[[ "$SIZE" -gt "$MIN_BYTES" ]] || fail "dump is only ${SIZE} bytes"
"${HAWA_SHA256[@]}" "$OUT" | awk '{print $1}' > "$OUT.sha256" || fail "could not checksum the dump"

# Restore verification: the dump must actually load, and hold the same task count as the live database.
# Scratch database names end in this run's suffix, so two runs (a manual one beside the nightly, or
# tests in parallel) never share one. Letters and digits only.
SCRATCH_SUFFIX="$(printf '%s' "${HAWA_SCRATCH_DB_SUFFIX:-$$}" | tr -cd 'a-z0-9' | cut -c1-16)"; SCRATCH_SUFFIX="${SCRATCH_SUFFIX:-$$}"
VDB="hawa_verify_$(printf "%s" "$STAMP" | tr "[:upper:]" "[:lower:]")_${SCRATCH_SUFFIX}"
docker exec "$PG" createdb -U hawa_owner "$VDB" || fail "could not create verification database"
if ! docker exec -i "$PG" pg_restore -U hawa_owner -d "$VDB" --no-owner --no-privileges --exit-on-error < "$OUT"; then
  docker exec "$PG" dropdb -U hawa_owner "$VDB" || true; fail "pg_restore rejected the dump"
fi
LIVE="$(trap - ERR; docker exec "$PG" psql -U hawa_owner -d "$DB" -Atc 'SELECT count(*) FROM hawa.tasks')" || LIVE=""
REST="$(trap - ERR; docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc 'SELECT count(*) FROM hawa.tasks')" || REST=""
EVENTS="$(trap - ERR; docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc 'SELECT count(*) FROM hawa.task_events')" || EVENTS="?"
# Every file the dump references, read from the restored copy (so exactly what a restore would need)
# before it is dropped. A database from before migration 019 has no store yet.
# Only references with a hawa.blobs row are files the store owes. Until the copy backfill has run, the
# running Core writes hashes into columns the view reads (design_studio_candidates.preview_sha256 and
# others) while the bytes still live in bytea beside them: no row, no file, nothing lost. They are
# counted (refs_without_row in the log line) and never fail the night. Once migration 020 adds the
# foreign keys, a reference without a row cannot exist.
HAS_STORE="$(trap - ERR; docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc "SELECT to_regclass('hawa.blob_references') IS NOT NULL")" || HAS_STORE=""
REFS_OK=1; REFS_WITHOUT_ROW=0
if [[ "$HAS_STORE" == t ]]; then
  docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc 'SELECT DISTINCT r.sha256 FROM hawa.blob_references r JOIN hawa.blobs b USING (sha256)' > "$WORK/refs" || REFS_OK=0
  REFS_WITHOUT_ROW="$(trap - ERR; docker exec "$PG" psql -U hawa_owner -d "$VDB" -Atc 'SELECT count(DISTINCT r.sha256) FROM hawa.blob_references r WHERE NOT EXISTS (SELECT 1 FROM hawa.blobs b WHERE b.sha256 = r.sha256)')" || REFS_OK=0
fi
docker exec "$PG" dropdb -U hawa_owner "$VDB" || fail "could not drop verification database"
[[ "$LIVE" =~ ^[0-9]+$ && "$REST" =~ ^[0-9]+$ ]] || fail "could not count the tasks (live '${LIVE}', restored '${REST}')"
[[ "$REST" -gt 0 && "$LIVE" -ge "$REST" && $((LIVE - REST)) -lt 50 ]] || fail "restored task count ${REST} does not match live ${LIVE}"
[[ "$HAS_STORE" == t || "$HAS_STORE" == f ]] || fail "could not tell whether the dump has the file store tables"
[[ "$REFS_OK" == 1 ]] || fail "could not read the file references from the restored dump"
[[ "$REFS_WITHOUT_ROW" =~ ^[0-9]+$ ]] || fail "could not count the references without a file row in the restored dump"
DUMP_VERIFIED=1

# The file store's manifest: every file present now, right after the dump. The dump cannot reference a
# file stored after it, and files never change, so this list is what a restore of this dump needs.
BLOB_COUNT=0; BLOB_BYTES=0; NEW_BLOBS=0; GC_DELETED="skipped"
if [[ "$HAS_STORE" == t ]]; then
  : > "$WORK/manifest"
  if [[ -d "$BLOBS/sha256" ]]; then
    (cd "$BLOBS" && find sha256 -mindepth 2 -maxdepth 2 -type f -name '*.*' | grep -E '^sha256/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z]+$' || true) | LC_ALL=C sort > "$WORK/manifest"
  fi
  BLOB_COUNT="$(wc -l < "$WORK/manifest" | tr -d ' ')"
  if [[ "$BLOB_COUNT" -gt 0 ]]; then
    BLOB_BYTES="$(cd "$BLOBS" && tr '\n' '\0' < "$WORK/manifest" | xargs -0 "${HAWA_STAT_SIZE[@]}" 2>/dev/null | awk '{s+=$1} END {print s+0}')" || BLOB_BYTES="?"
  fi
  # The nightly restore check for files: no file the dump references with a row may be missing.
  sed -E 's#^.*/([0-9a-f]{64})\.[a-z]+$#\1#' "$WORK/manifest" | LC_ALL=C sort -u > "$WORK/present"
  LC_ALL=C sort -u "$WORK/refs" | grep -E '^[0-9a-f]{64}$' > "$WORK/refs.sorted" || true
  MISSING="$(LC_ALL=C comm -23 "$WORK/refs.sorted" "$WORK/present" | wc -l | tr -d ' ')"
  [[ "$MISSING" == 0 ]] || fail "the dump references ${MISSING} blob(s) not on disk in ${BLOBS/#$HOME/~} (first: $(LC_ALL=C comm -23 "$WORK/refs.sorted" "$WORK/present" | head -1 | cut -c1-16)…); the dump here is verified, but a restore would miss those files"
  cp "$WORK/manifest" "$DIR/hawa_${STAMP}.blobs"
fi

# Retention: keep the 14 newest nightly dumps, and copy off-disk to archive destination.
#
# The archive copy is encrypted when HAWA_BACKUP_ARCHIVE_KEYFILE names a passphrase file.
# This verifies local archive bytes only: a synchronized folder does not establish off-host durability.
# A dump carries client copy, briefs and task history; keep its key separately from its archive.
# Same cipher as the disaster-recovery drill, so one restore procedure covers both.
# Losing the passphrase loses the archive: it belongs in the owner's password manager, not only here.
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
    | "${HAWA_SHA256[@]}" | cut -d' ' -f1 > "$OUT.enc.plain.sha256" || fail "the encrypted archive copy does not decrypt"
  [[ "$(cat "$OUT.enc.plain.sha256")" == "$(cut -d' ' -f1 < "$OUT.sha256")" ]] \
    || fail "the encrypted archive copy does not decrypt back to the dump"
  "${HAWA_SHA256[@]}" "$OUT.enc" | cut -d' ' -f1 > "$OUT.enc.sha256" || fail "could not checksum the encrypted copy"
  rm -f "$OUT.enc.plain.sha256"
  ARCHIVE_SRC="$OUT.enc"
  ARCHIVE_SRC_SHA="$OUT.enc.sha256"
fi
# Publish the dump only after every required file pack is verified. A final dump name
# is the recovery-set discovery marker; .part copies must never be selected by restore.
mkdir -p "$ARCHIVE_DEST" && chmod 700 "$ARCHIVE_DEST" || fail "could not prepare the local archive"
archive_publish() {
  local source="$1" target="$2" expected actual
  [[ ! -e "$target" && ! -L "$target" ]] || fail "an archive member with this timestamp already exists"
  ARCHIVE_PART="$(mktemp "$ARCHIVE_DEST/.publish_${STAMP}.XXXXXX")" || fail "could not stage an archive member"
  cat "$source" > "$ARCHIVE_PART" || fail "could not copy an archive member"
  expected="$(trap - ERR; "${HAWA_SHA256[@]}" "$source" | cut -d' ' -f1)" || fail "could not checksum the archive source"
  actual="$(trap - ERR; "${HAWA_SHA256[@]}" "$ARCHIVE_PART" | cut -d' ' -f1)" || fail "could not checksum the staged archive copy"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]] \
    || fail "archive copy checksum differs from its source"
  # Same-directory rename publishes atomically under the exclusive archive lock.
  mv "$ARCHIVE_PART" "$target" || fail "could not publish an archive member"
  ARCHIVE_PART=""
}

# The file store's archive: the files this manifest lists that no earlier pack holds go into one new
# pack, checked by unpacking it and hashing every file against its name before it takes its name.
# The manifest is copied last: a manifest in the archive means every file it lists is packed.
ARCHIVE_BLOBS="$ARCHIVE_DEST/blobs"; INDEX="$ARCHIVE_BLOBS/index.tsv"
if [[ "$HAS_STORE" == t ]]; then
  { mkdir -p "$ARCHIVE_BLOBS" && chmod 700 "$ARCHIVE_BLOBS" && touch "$INDEX"; } || fail "could not prepare ${ARCHIVE_BLOBS/#$HOME/~}"
  cut -f1 "$INDEX" | LC_ALL=C sort -u > "$WORK/packed"
  LC_ALL=C comm -23 "$WORK/manifest" "$WORK/packed" > "$WORK/new"
  NEW_BLOBS="$(wc -l < "$WORK/new" | tr -d ' ')"
  if [[ "$NEW_BLOBS" -gt 0 ]]; then
    PACK="blobpack_${STAMP}.tar"; [[ -n "$ARCHIVE_KEYFILE" ]] && PACK="$PACK.enc"
    PACK_PART="$ARCHIVE_BLOBS/$PACK.part"
    # COPYFILE_DISABLE: macOS tar would otherwise add ._ files for extended attributes.
    if [[ -n "$ARCHIVE_KEYFILE" ]]; then
      (cd "$BLOBS" && COPYFILE_DISABLE=1 tar -cf - -T "$WORK/new") \
        | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -out "$PACK_PART" -pass "file:$ARCHIVE_KEYFILE" \
        || fail "could not write the file pack"
    else
      (cd "$BLOBS" && COPYFILE_DISABLE=1 tar -cf "$PACK_PART" -T "$WORK/new") || fail "could not write the file pack"
    fi
    mkdir "$WORK/check"
    if [[ -n "$ARCHIVE_KEYFILE" ]]; then
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$PACK_PART" -pass "file:$ARCHIVE_KEYFILE" | tar -xf - -C "$WORK/check" \
        || fail "the file pack does not decrypt and unpack"
    else
      tar -xf "$PACK_PART" -C "$WORK/check" || fail "the file pack does not unpack"
    fi
    (cd "$WORK/check" && find . -type f | sed 's#^\./##' | LC_ALL=C sort) > "$WORK/unpacked"
    cmp -s "$WORK/unpacked" "$WORK/new" || fail "the file pack does not hold exactly the ${NEW_BLOBS} new files"
    BAD="$(cd "$WORK/check" && tr '\n' '\0' < "$WORK/new" | xargs -0 "${HAWA_SHA256[@]}" | awk '{ n=$2; sub(/^.*\//, "", n); sub(/\.[a-z]+$/, "", n); if (n != $1) print $2 }' | head -1)"
    [[ -z "$BAD" ]] || fail "a file in the pack does not hash to its name (${BAD})"
    mv -f "$PACK_PART" "$ARCHIVE_BLOBS/$PACK"; PACK_PART=""
    { cat "$INDEX"; awk -v p="$PACK" '{ print $0 "\t" p }' "$WORK/new"; } > "$INDEX.new" && mv -f "$INDEX.new" "$INDEX" \
      || fail "could not record the pack in the index"
  fi
  HAWA_BACKUP_ARCHIVE_KEYFILE="$ARCHIVE_KEYFILE" python3 "$ROOT/infra/backup/blob_archive.py" \
    --archive "$ARCHIVE_DEST" --manifest "$WORK/manifest" > "$WORK/archive-verification.json" \
    || fail "file archive verification failed; no new recovery set was published and garbage collection was skipped"
  archive_publish "$WORK/manifest" "$ARCHIVE_DEST/hawa_${STAMP}.blobs"
fi

archive_publish "$ARCHIVE_SRC_SHA" "$ARCHIVE_DEST/$(basename "$ARCHIVE_SRC_SHA")"
archive_publish "$ARCHIVE_SRC" "$ARCHIVE_DEST/$(basename "$ARCHIVE_SRC")"
if [[ -n "$ARCHIVE_KEYFILE" ]]; then rm -f "$OUT.enc" "$OUT.enc.sha256"; fi

{ ls -1t "$DIR"/hawa_*.dump 2>/dev/null || true; } | tail -n +15 | while read -r old; do rm -f "$old" "$old.sha256" "$old.enc" "$old.enc.sha256" "${old%.dump}.blobs"; done
# Pre-deploy dumps have their own retention (the newest ten, compressed). They were once copied,
# unencrypted, into the archive destination, which is off this machine: never again.
bash "$ROOT/infra/ops/disk_cleanup.sh" --backups >/dev/null 2>&1 || echo "WARNING: disk_cleanup.sh --backups did not finish" >&2

# R10: the Restate journal lives in a different volume from PostgreSQL and the file store. Opt in
# only after its immutable helper image, key and isolated restore rehearsal are configured. A failed
# Restate copy fails the night before any file-store garbage collection or OK receipt.
RESTATE_STATUS="off"
if [[ "${HAWA_RESTATE_BACKUP_ENABLED:-off}" == on ]]; then
  HAWA_BACKUP_ARCHIVE_DEST="$ARCHIVE_DEST" HAWA_BACKUP_ARCHIVE_KEYFILE="$ARCHIVE_KEYFILE" \
    python3 "$ROOT/infra/backup/restate_nightly.py" --apply --pair-stamp "$STAMP" \
    || fail "Restate volume backup failed; the database/file copy may be valid, but the night is incomplete"
  RESTATE_STATUS="paired_archive"
fi

# Retire older database/file snapshots only after every opted-in member of this night's
# recovery set has published. A failed Restate capture must preserve the older usable archive.
if [[ -d "$ARCHIVE_DEST" && "$ARCHIVE_DEST" != gs://* ]]; then
  # Once this archive contains pairs, keep pruning by complete recovery set even if the opt-in
  # switch is later turned off. Losing the key fails closed rather than discarding old paired dumps.
  if [[ "${HAWA_RESTATE_BACKUP_ENABLED:-off}" == on ]] || compgen -G "$ARCHIVE_DEST/hawa_*.restate.json" >/dev/null; then
    RESTATE_PRUNE="$(HAWA_BACKUP_ARCHIVE_DEST="$ARCHIVE_DEST" HAWA_BACKUP_ARCHIVE_KEYFILE="$ARCHIVE_KEYFILE" \
      python3 "$ROOT/infra/backup/restate_retention.py" --apply --keep "$ARCHIVE_KEEP")" \
      || fail "paired recovery-set retention did not finish; inspect the archive before retrying"
    echo "$(date -u +%FT%TZ) RESTATE-RETENTION ${RESTATE_PRUNE}" >> "$LOG"
    ARCHIVE_EXTS=(dump sql)
  else
    ARCHIVE_EXTS=(dump enc sql)
  fi
  for ext in "${ARCHIVE_EXTS[@]}"; do
    { ls -1t "$ARCHIVE_DEST"/hawa_*."$ext" 2>/dev/null || true; } | tail -n +$((ARCHIVE_KEEP + 1)) | while read -r old; do
      rm -f "$old" "$old.sha256"
    done
  done
  # A manifest goes with its dump; a pack goes when no kept manifest lists any file in it.
  for manifest in "$ARCHIVE_DEST"/hawa_*.blobs; do
    [[ -e "$manifest" ]] || continue
    base="${manifest%.blobs}"
    if [[ ! -e "$base.dump" && ! -e "$base.dump.enc" ]]; then rm -f "$manifest"; fi
  done
  if [[ -s "$INDEX" ]] && compgen -G "$ARCHIVE_DEST/hawa_*.blobs" >/dev/null; then
    cat "$ARCHIVE_DEST"/hawa_*.blobs | LC_ALL=C sort -u > "$WORK/needed"
    awk -F'\t' 'NR==FNR { need[$1] = 1; next } ($1 in need) { keep[$2] = 1 } END { for (p in keep) print p }' "$WORK/needed" "$INDEX" | LC_ALL=C sort > "$WORK/keep_packs"
    cut -f2 "$INDEX" | LC_ALL=C sort -u | LC_ALL=C comm -23 - "$WORK/keep_packs" | while read -r pack; do
      if [[ "$pack" =~ ^blobpack_[0-9]{8}T[0-9]{6}Z\.tar(\.enc)?$ ]]; then rm -f "$ARCHIVE_BLOBS/$pack"; fi
    done
    awk -F'\t' 'NR==FNR { k[$1] = 1; next } ($2 in k)' "$WORK/keep_packs" "$INDEX" > "$INDEX.new" && mv -f "$INDEX.new" "$INDEX"
  fi
fi

# The collector, only now: a file is deleted only after tonight's dump and its files are archived.
# A failure is reported and does not fail the backup, which is already complete. With a gs://
# destination the files are not archived at all, so nothing may be deleted: the disk copy is the only one.
if [[ "$HAS_STORE" == t && "${HAWA_BLOB_GC:-on}" != off && "$ARCHIVE_DEST" == gs://* ]]; then
  GC_DELETED="skipped_unarchived"
  echo "WARNING: the file store collector did not run: the files are not archived locally to ${ARCHIVE_DEST} (off-host copy unverified)" >&2
elif [[ "$HAS_STORE" == t && "${HAWA_BLOB_GC:-on}" != off ]]; then
  if [[ -n "${HAWA_BLOB_GC_CMD:-}" ]]; then
    GC_OUT="$(trap - ERR; bash -c "$HAWA_BLOB_GC_CMD --grace-days $GRACE_DAYS" 2>&1)" && GC_RC=0 || GC_RC=$?
  else
    GC_OUT="$(trap - ERR; docker exec hawa-production-core-1 node /app/apps/core/dist/tools/blob-gc.js --grace-days "$GRACE_DAYS" 2>&1)" && GC_RC=0 || GC_RC=$?
  fi
  GC_LINE="$(printf '%s\n' "$GC_OUT" | grep -E '^\{' | tail -1 || true)"
  if [[ "$GC_RC" == 0 && -n "$GC_LINE" ]]; then
    GC_DELETED="$(printf '%s' "$GC_LINE" | sed -nE 's/.*"deleted":([0-9]+).*/\1/p')"
    echo "$(date -u +%FT%TZ) GC ${STAMP} ${GC_LINE}" >> "$LOG"
  else
    GC_DELETED="failed"
    echo "$(date -u +%FT%TZ) GC-FAIL ${STAMP}: $(printf '%s' "$GC_OUT" | tail -1 | cut -c1-300)" >> "$LOG"
    notify "🟠 Hawa file store clean-up failed after the nightly backup (${STAMP}); the backup itself is fine. See snapshots/backup.log."
  fi
fi

echo "$(date -u +%FT%TZ) OK ${STAMP} bytes=${SIZE} tasks=${REST} events=${EVENTS} sha256=$(cat "$OUT.sha256" | cut -c1-16) dump_s=${DUMP_S} blobs=${BLOB_COUNT} blob_bytes=${BLOB_BYTES} new_blobs=${NEW_BLOBS} refs_without_row=${REFS_WITHOUT_ROW} restate=${RESTATE_STATUS} gc_deleted=${GC_DELETED}" >> "$LOG"
echo "✓ backup ${OUT/$ROOT\//} (${SIZE} bytes), restore verified: tasks=${REST} events=${EVENTS}, files=${BLOB_COUNT} (${NEW_BLOBS} new), archived locally to ${ARCHIVE_DEST} (off-host copy unverified)"
