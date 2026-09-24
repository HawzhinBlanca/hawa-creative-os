#!/usr/bin/env bash
# Restores a nightly Restate archive (infra/backup/restate-nightly.sh) into the Restate container of a
# stack that is NOT production: the chaos stack's, for the restore drill (architecture programme 2.6,
# ADR-034, PHASE2_DESIGN.md section 2.6; packages/testkit/chaos, `run.ts --restore-drill`).
#
#   HAWA_RESTATE_RESTORE_PROJECT=hawa-chaos bash infra/backup/restate-restore.sh [archive]
#
# The archive defaults to the newest restate_*.tar[.enc] in HAWA_BACKUP_ARCHIVE_DEST; an encrypted one
# needs HAWA_BACKUP_ARCHIVE_KEYFILE. Its checksum is checked, it is decrypted and read back, then the
# target Restate is stopped, its volume emptied and filled from the archive by a helper container of
# its own image (no network, never pulled), and it is started again and must be healthy and serve
# HAWA_RESTATE_REQUIRED_SERVICE (TaskWorkflow): an archive restores the worker registrations too.
#
# Restate keeps its data under /restate-data/<RESTATE_NODE_NAME>/. A server started under another node
# name ignores that directory and starts empty, healthy and serving nothing (measured on 1.7.10,
# 2026-09-25), so the node name inside the archive must be the target's: production's archive holds
# hawa-restate-prod-1, the chaos stack runs as hawa-restate-chaos-1 unless CHAOS_RESTATE_NODE_NAME says
# otherwise. A mismatch is refused before anything is stopped.
#
# It refuses any project, container or volume whose name says production. Output: one line
# "RESTORE OK archive=… bytes=… restore_s=… down_s=… node=…" on stdout; exit 1 on any failure (after
# starting the target again if it stopped it).
set -euo pipefail; umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
PROJECT="${HAWA_RESTATE_RESTORE_PROJECT:-}"
[[ -n "$PROJECT" ]] || { echo "HAWA_RESTATE_RESTORE_PROJECT is required (for the drill: hawa-chaos)" >&2; exit 1; }
RESTATE="${HAWA_RESTATE_RESTORE_CONTAINER:-${PROJECT}-restate-1}"
ARCHIVE_DEST="${HAWA_BACKUP_ARCHIVE_DEST:-$HOME/.hawa/snapshots_archive}"
ARCHIVE_KEYFILE="${HAWA_BACKUP_ARCHIVE_KEYFILE:-}"
DATA_PATH="${HAWA_RESTATE_DATA_PATH:-/restate-data}"
SERVICE="${HAWA_RESTATE_REQUIRED_SERVICE:-TaskWorkflow}"
HEALTH_S="${HAWA_RESTATE_HEALTH_SECONDS:-180}"
ARCHIVE="${1:-${HAWA_RESTATE_RESTORE_ARCHIVE:-}}"
STOPPED=0; WORK=""

fail() { echo "restate restore: $1" >&2; exit 1; }
cleanup() {
  local rc=$?
  set +e
  # A target this run stopped is never left stopped, even when the restore failed half way.
  if [[ "$STOPPED" == 1 ]]; then docker start "$RESTATE" >/dev/null 2>&1; fi
  [[ -n "$WORK" ]] && rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

for name in "$PROJECT" "$RESTATE"; do
  [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "unexpected name: $name"
  [[ "$name" != *production* ]] || fail "refusing to restore into $name: this restores into a drill stack only"
done
docker inspect "$RESTATE" >/dev/null 2>&1 || fail "no container $RESTATE"
VOL="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$DATA_PATH\"}}{{.Name}}{{end}}{{end}}" "$RESTATE")"
IMG="$(docker inspect -f '{{.Config.Image}}' "$RESTATE")"
[[ -n "$VOL" ]] || fail "$RESTATE has no named volume at $DATA_PATH"
[[ "$VOL" != *production* ]] || fail "refusing to overwrite the volume $VOL"
# Only the one variable is kept from the container's environment; nothing else of it is printed.
TARGET_NODE="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$RESTATE" | sed -nE 's/^RESTATE_NODE_NAME=([A-Za-z0-9_.-]+)$/\1/p' | head -1)"

if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$( { ls -1t "$ARCHIVE_DEST"/restate_*.tar.enc "$ARCHIVE_DEST"/restate_*.tar 2>/dev/null || true; } | head -1)"
fi
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || fail "no Restate archive to restore (looked in ${ARCHIVE_DEST/#$HOME/~})"
NAME="$(basename "$ARCHIVE")"
if [[ -f "$ARCHIVE.sha256" ]]; then
  [[ "$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)" == "$(cut -d' ' -f1 < "$ARCHIVE.sha256")" ]] || fail "$NAME does not match its checksum"
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hawa-restate-restore.XXXXXX")"
if [[ "$ARCHIVE" == *.enc ]]; then
  [[ -r "$ARCHIVE_KEYFILE" ]] || fail "$NAME is encrypted and HAWA_BACKUP_ARCHIVE_KEYFILE is not readable"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$ARCHIVE" -out "$WORK/restate.tar" -pass "file:$ARCHIVE_KEYFILE" || fail "could not decrypt $NAME"
else
  cp "$ARCHIVE" "$WORK/restate.tar"
fi
tar -tf "$WORK/restate.tar" > "$WORK/list" 2>/dev/null || fail "$NAME does not read back as a tar"
# The node directories the archive holds (./<node>/...), and whether the target runs as one of them.
NODES="$(sed -nE 's#^(\./)?([^/]+)/.*#\2#p' "$WORK/list" | grep -vx '\.' | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')"
[[ -n "$NODES" ]] || fail "$NAME holds no node directory"
if [[ -n "$TARGET_NODE" && " $NODES " != *" $TARGET_NODE "* ]]; then
  fail "$NAME holds node ${NODES}, but $RESTATE runs as ${TARGET_NODE}: Restate would start empty. Run the target with RESTATE_NODE_NAME=${NODES%% *} (the chaos stack: CHAOS_RESTATE_NODE_NAME)"
fi
BYTES="$(wc -c < "$WORK/restate.tar" | tr -d ' ')"

START_S="$(date +%s)"
STOPPED=1
docker stop -t 60 "$RESTATE" >/dev/null || fail "could not stop $RESTATE"
[[ "$(docker inspect -f '{{.State.Running}}' "$RESTATE")" == false ]] || fail "$RESTATE is still running"
docker run --rm -i --pull never --network none -v "$VOL:/data" --entrypoint sh "$IMG" \
  -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar --numeric-owner -xf - -C /data' < "$WORK/restate.tar" \
  || fail "could not unpack $NAME into $VOL"
docker start "$RESTATE" >/dev/null || fail "could not start $RESTATE"
STOPPED=0
DOWN_S=$(( $(date +%s) - START_S ))
deadline=$(( $(date +%s) + HEALTH_S ))
until [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$RESTATE")" == healthy ]] \
  && docker exec "$RESTATE" curl -fsS -m 10 "http://127.0.0.1:9070/services/$SERVICE" >/dev/null 2>&1; do
  (( $(date +%s) < deadline )) || fail "$RESTATE did not come back healthy and serving $SERVICE within ${HEALTH_S} s after the restore"
  sleep 1
done
echo "RESTORE OK archive=${NAME} bytes=${BYTES} restore_s=$(( $(date +%s) - START_S )) down_s=${DOWN_S} node=${NODES} target=${RESTATE}"
