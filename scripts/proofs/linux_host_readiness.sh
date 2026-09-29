#!/usr/bin/env bash
# Linux readiness proof for the production host scripts (ADR-141, plans/hosting).
#
# Runs INSIDE a throwaway arm64 Debian container, never on a host with production on it. The caller
# bind-mounts a copy of the repository (`git archive HEAD`) read-only at /repo and an output
# directory at /out, for example:
#
#   docker run --rm -v "$COPY:/repo:ro" -v "$OUT:/out" hawa-linux-proof:local bash /repo/scripts/proofs/linux_host_readiness.sh
#
# The image needs bash, GNU coreutils, python3 (pytest, PyYAML), openssl, rsync, git, PostgreSQL and
# systemd's systemd-analyze (Dockerfile in plans/hosting/LINUX_READINESS_PROOF.json). Everything runs
# against a PostgreSQL cluster inside the container, temporary directories and stubs: no production
# container, volume, port or credential is reachable from it. Fixture secrets are built from parts.
#
# Output: one PASS or FAIL line per check, and /out/linux-proof.json. Exit 1 when any check failed.
set -uo pipefail
WORK="$(mktemp -d /tmp/hawa-linux-proof.XXXXXX)"
RESULTS="$WORK/results.tsv"; : > "$RESULTS"
pass() { printf 'PASS\t%s\t%s\n' "$1" "${2:-}" | tee -a "$RESULTS"; }
fail() { printf 'FAIL\t%s\t%s\n' "$1" "${2:-}" | tee -a "$RESULTS"; }
check() { # name, command...: PASS when the command succeeds
  local name="$1"; shift
  local out; if out="$("$@" 2>&1)"; then pass "$name" "$(tail -1 <<< "$out" | cut -c1-200)"; else fail "$name" "$(tail -3 <<< "$out" | tr '\n' ' ' | cut -c1-300)"; fi
}

# A writable git copy of the repository: deploy.sh and the audit read git state.
cp -a /repo "$WORK/repo"; R="$WORK/repo"
git -C "$R" init -q && git -C "$R" add -A && git -C "$R" -c user.name=proof -c user.email=proof@example.invalid commit -qm proof
cd "$R" || exit 1

echo "== host: $(uname -srm); $(stat --version | head -1); $(bash --version | head -1)"

# ---------------------------------------------------------------------------------------------
# A. stat: the plans/hosting 3.6 failure, and the fix.
f="$WORK/sized"; head -c 1234 /dev/zero > "$f"; chmod 640 "$f"
old="$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f")"
if [[ "$(wc -l <<< "$old")" -gt 1 ]]; then pass "A1 old 'stat -f || stat -c' form yields $(wc -l <<< "$old") lines on GNU (the reported bug reproduces)"; else fail "A1 old form reproduces" "$old"; fi
if ( set -e; x=$((8#$old & 8#077)) ) 2>/dev/null; then fail "A2 old mode arithmetic fails"; else pass "A2 old form breaks \$((8#\$mode & 8#077)) as reported"; fi
check "A3 host_lib picks GNU stat and reads mode 640 / size 1234" bash -c "source infra/ops/host_lib.sh; [[ \"\${HAWA_STAT_SIZE[*]}\" == 'stat -c %s' ]] && [[ \$(hawa_file_mode '$f') == 640 && \$(hawa_file_size '$f') == 1234 ]] && echo \"\${HAWA_STAT_MODE[*]} / \${HAWA_STAT_SIZE[*]}\""
check "A4 host_lib GNU date for N days ago" bash -c "source infra/ops/host_lib.sh; [[ \$(hawa_utc_days_ago 1 %F) == \$(date -u -d yesterday +%F) ]] && hawa_utc_days_ago 30 %Y%m%d"
check "A5 host_lib SHA-256 tool present" bash -c "source infra/ops/host_lib.sh; printf hawa | \"\${HAWA_SHA256[@]}\" | grep -Eq '^[0-9a-f]{64}  -$' && echo \"\${HAWA_SHA256[*]}\""

# ---------------------------------------------------------------------------------------------
# B. local_state_audit.sh (deploy.sh step 4) in a throwaway repository.
A="$WORK/audit"; mkdir -p "$A/infra/security" "$A/infra/ops" "$A/infra/backup/snapshots"
cp infra/security/local_state_audit.sh "$A/infra/security/"; cp infra/ops/host_lib.sh "$A/infra/ops/"
echo 'infra/backup/snapshots/' > "$A/.gitignore"; git -C "$A" init -q
head -c 2048 /dev/zero > "$A/infra/backup/snapshots/hawa_20260929T003004Z.dump"; chmod 644 "$A/infra/backup/snapshots/hawa_20260929T003004Z.dump"
out="$(bash "$A/infra/security/local_state_audit.sh" 2>&1)"; rc=$?
if [[ $rc == 1 ]] && grep -Eq '^644 +2048 +database dump .* EXPOSED$' <<< "$out"; then pass "B1 audit flags a 0644 dump (exit 1)"; else fail "B1 audit flags a 0644 dump" "rc=$rc $out"; fi
chmod 600 "$A/infra/backup/snapshots/hawa_20260929T003004Z.dump"
out="$(bash "$A/infra/security/local_state_audit.sh" 2>&1)"; rc=$?
if [[ $rc == 0 ]] && grep -Eq '^600 +2048 +database dump ' <<< "$out" && ! grep -q 'invalid' <<< "$out"; then pass "B2 audit passes a 0600 dump (exit 0)"; else fail "B2 audit passes a 0600 dump" "rc=$rc $out"; fi

# ---------------------------------------------------------------------------------------------
# C. The whole nightly backup against PostgreSQL in this container. `docker exec <c> cmd` is a shim
#    that runs cmd as the postgres user; the database, the store and the archive are temporary.
PGVER="$(ls /usr/lib/postgresql | sort -n | tail -1)"
sed -i -E 's/^(local|host)(\s+\S+\s+\S+\s+(\S+\s+)?)\S+$/\1\2trust/' /etc/postgresql/"$PGVER"/main/pg_hba.conf
pg_ctlcluster "$PGVER" main start >/dev/null 2>&1
runuser -u postgres -- psql -qAtc "CREATE ROLE hawa_owner SUPERUSER LOGIN" >/dev/null
runuser -u postgres -- createdb -O hawa_owner hawa
B="$WORK/blobs"; mkdir -p "$B/sha256"
add_blob() { # content -> hex; stored as the file store stores it
  local hex; hex="$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"
  mkdir -p "$B/sha256/${hex:0:2}"; printf '%s' "$1" > "$B/sha256/${hex:0:2}/$hex.png"; chmod 444 "$B/sha256/${hex:0:2}/$hex.png"; echo "$hex"
}
h1="$(add_blob 'synthetic picture one')"; h2="$(add_blob 'synthetic picture two')"
runuser -u postgres -- psql -q -U hawa_owner -d hawa -v ON_ERROR_STOP=1 >/dev/null <<SQL
CREATE SCHEMA hawa;
CREATE TABLE hawa.tasks (id int PRIMARY KEY, payload text);
CREATE TABLE hawa.task_events (id int PRIMARY KEY, task_id int);
CREATE TABLE hawa.blobs (sha256 text PRIMARY KEY);
CREATE TABLE hawa.blob_references (sha256 text);
INSERT INTO hawa.tasks SELECT g, repeat('brief ', 200) FROM generate_series(1, 40) g;
INSERT INTO hawa.task_events SELECT g, 1 + g % 40 FROM generate_series(1, 90) g;
INSERT INTO hawa.blobs VALUES ('$h1'), ('$h2');
INSERT INTO hawa.blob_references VALUES ('$h1'), ('$h2');
SQL
mkdir -p "$WORK/shim"
cat > "$WORK/shim/docker" <<'SHIM'
#!/bin/bash
# docker exec [-i] [-e K=V]... <container> <command...>, run here as the postgres user.
[[ "${1:-}" == exec ]] || exit 1
shift; envs=()
while [[ "${1:-}" == -* ]]; do case "$1" in -e) envs+=("$2"); shift 2 ;; *) shift ;; esac; done
shift
exec runuser -u postgres -- env ${envs[@]+"${envs[@]}"} "$@"
SHIM
chmod +x "$WORK/shim/docker"
printf '%s-%s-%s\n' fixture offsite passphrase > "$WORK/key"; chmod 600 "$WORK/key"
chown -R postgres "$WORK/shim"
NIGHT_ENV=(env -i PATH="$WORK/shim:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK/home" HAWA_SCRATCH_DB_SUFFIX=proof
  HAWA_BACKUP_SNAPSHOT_DIR="$WORK/snapshots" HAWA_BACKUP_ARCHIVE_DEST="$WORK/archive" HAWA_BACKUP_ARCHIVE_KEYFILE="$WORK/key"
  HAWA_BACKUP_ARCHIVE_DIR="$WORK/cleanup-archive" HAWA_CONTAINER_LOGS_DIR="$WORK/container-logs"
  HAWA_BACKUP_PG_CONTAINER=proof-postgres HAWA_BACKUP_DB=hawa HAWA_BACKUP_MIN_BYTES=100
  HAWA_BACKUP_NOTIFY_ENV="$WORK/no-such-env" HAWA_BLOBS_DIR="$B" HAWA_BLOB_GC=off)
mkdir -p "$WORK/home"
out="$("${NIGHT_ENV[@]}" bash infra/backup/nightly_backup.sh 2>&1)"; rc=$?
line="$(grep ' OK ' "$WORK/snapshots/backup.log" 2>/dev/null | tail -1)"
size="$(stat -c %s "$WORK/snapshots"/hawa_*.dump 2>/dev/null | head -1)"
if [[ $rc == 0 && "$line" =~ bytes=([0-9]+)\ .*blobs=2\ blob_bytes=42\ new_blobs=2 && "${BASH_REMATCH[1]}" == "$size" ]]; then
  pass "C1 nightly_backup.sh completes on Linux: size (line 116) and blob bytes (line 163) read with GNU stat" "$(cut -c1-180 <<< "$line")"
else fail "C1 nightly backup on Linux" "rc=$rc $(tail -3 <<< "$out" | tr '\n' ' ') | $line"; fi
sleep 1; h3="$(add_blob 'synthetic picture three')"
runuser -u postgres -- psql -q -U hawa_owner -d hawa -c "INSERT INTO hawa.blobs VALUES ('$h3'); INSERT INTO hawa.blob_references VALUES ('$h3'); INSERT INTO hawa.tasks VALUES (41, 'x')" >/dev/null
out="$("${NIGHT_ENV[@]}" bash infra/backup/nightly_backup.sh 2>&1)"; rc=$?
line="$(grep ' OK ' "$WORK/snapshots/backup.log" | tail -1)"
if [[ $rc == 0 && "$line" == *"blobs=3 blob_bytes=65 new_blobs=1"* && "$(ls "$WORK/archive/blobs" | grep -c '^blobpack_.*\.tar\.enc$')" == 2 ]]; then
  pass "C2 second night packs only the new file" "$(cut -c1-120 <<< "$line")"
else fail "C2 second night" "rc=$rc $(tail -3 <<< "$out" | tr '\n' ' ') | $line"; fi
check "C3 archive holds encrypted dumps with checksums, owner-only" bash -c "ls $WORK/archive/hawa_*.dump.enc | wc -l | grep -qx 2 && [[ \$(stat -c %a $WORK/archive) == 700 ]] && ! ls $WORK/archive/hawa_*.dump 2>/dev/null && echo 2 encrypted"
check "C4 backup_status.py accepts the night" python3 infra/backup/backup_status.py --snapshots "$WORK/snapshots"
out="$(HAWA_HOST_ROLE=retired "${NIGHT_ENV[@]}" HAWA_HOST_ROLE=retired bash infra/backup/nightly_backup.sh 2>&1)"; rc=$?
if [[ $rc == 0 ]] && grep -q 'SKIP .*this host is retired (HAWA_HOST_ROLE)' "$WORK/snapshots/backup.log" && [[ "$(ls "$WORK/archive"/hawa_*.dump.enc | wc -l)" == 2 ]]; then
  pass "C5 a retired host skips the night with a log line, and backup_status still reads the last OK"
  python3 infra/backup/backup_status.py --snapshots "$WORK/snapshots" >/dev/null || fail "C5b backup_status after SKIP"
else fail "C5 retired host skip" "rc=$rc $out"; fi

# ---------------------------------------------------------------------------------------------
# D. The off-site copy of that archive: a local path, then rsync (GNU rsync 3), then the Python suite.
OFF_ENV=("${NIGHT_ENV[@]}" HAWA_RESTATE_BACKUP_ENABLED=off)
out="$("${OFF_ENV[@]}" HAWA_OFFSITE_DEST="$WORK/offsite-path" bash infra/backup/offsite_copy.sh 2>&1)"; rc=$?
if [[ $rc == 0 ]] && tail -1 "$WORK/snapshots/offsite.log" | grep -Eq '^\S+ COPIED [0-9T]+Z files=[0-9]+ .*verified=sha256-readback'; then
  pass "D1 off-site copy to a path" "$(tail -1 "$WORK/snapshots/offsite.log" | cut -c1-160)"; else fail "D1 off-site copy to a path" "rc=$rc $out"; fi
out="$("${OFF_ENV[@]}" HAWA_OFFSITE_DEST="$WORK/offsite-path" bash infra/backup/offsite_copy.sh 2>&1)"; rc=$?
if [[ $rc == 0 ]] && tail -1 "$WORK/snapshots/offsite.log" | grep -q ' CURRENT '; then pass "D2 rerun verifies and copies nothing"; else fail "D2 rerun" "rc=$rc $out"; fi
out="$("${OFF_ENV[@]}" HAWA_OFFSITE_DEST="$WORK/offsite-rsync" HAWA_OFFSITE_TRANSPORT=rsync bash infra/backup/offsite_copy.sh 2>&1)"; rc=$?
if [[ $rc == 0 ]] && tail -1 "$WORK/snapshots/offsite.log" | grep -q 'COPIED .*verified=rsync-checksum'; then
  pass "D3 off-site copy through rsync ($(rsync --version | head -1 | cut -c1-30))"; else fail "D3 rsync transport" "rc=$rc $out"; fi
set_stamp="$(tail -1 "$WORK/snapshots/offsite.log" | awk '{print $3}')"
check "D4 the rsync copy decrypts back to the archived dump" bash -c "cmp $WORK/offsite-rsync/hawa_${set_stamp}.dump.enc $WORK/archive/hawa_${set_stamp}.dump.enc && openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in $WORK/offsite-rsync/hawa_${set_stamp}.dump.enc -pass file:$WORK/key | head -c 5 | od -c | head -1"
check "D5 backup_status.py accepts the off-site copy" python3 infra/backup/backup_status.py --snapshots "$WORK/snapshots"
# One test runs `node -e` with a top-level await, which only Node 22.12+ accepts (the Core container's
# node runs that script in production); Debian's node is 20, so it is deselected here and runs on macOS.
out="$(cd infra/backup && python3 -m pytest -q -p no:cacheprovider . \
  --deselect test_restate_nightly.py::RestateAdminWireTest::test_running_query_negotiates_json_before_parsing 2>&1)"; rc=$?
if [[ $rc == 0 ]]; then pass "D6 python3 -m pytest infra/backup on Linux (node $(node --version 2>/dev/null); 1 Node-22-only test deselected)" "$(tail -1 <<< "$out")"; else fail "D6 pytest infra/backup" "$(tail -5 <<< "$out" | tr '\n' ' ')"; fi

# ---------------------------------------------------------------------------------------------
# E. The watchdog on Linux, with docker and systemctl stubbed: never `open`, and the host role.
S="$WORK/wd-stubs"; mkdir -p "$S" "$WORK/wd-home/.hawa"
printf '#!/bin/bash\necho "docker $*" >> %s/wd-calls\n[[ "$1" == info ]] && exit 1\nexit 0\n' "$WORK" > "$S/docker"
printf '#!/bin/bash\necho "systemctl $*" >> %s/wd-calls\necho inactive\nexit 3\n' "$WORK" > "$S/systemctl"
printf '#!/bin/bash\necho "$(basename "$0") $*" >> %s/wd-calls\nexit 0\n' "$WORK" > "$S/curl"; cp "$S/curl" "$S/open"; cp "$S/curl" "$S/sleep"
chmod +x "$S"/*
WD_ENV=(env -i PATH="$S:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK/wd-home" HAWA_WATCHDOG_ENV_FILE="$WORK/no-such-env")
out="$("${WD_ENV[@]}" bash infra/ops/watchdog.sh --status 2>&1)"; rc=$?
if [[ $rc == 1 ]] && grep -q 'Docker is not running: docker.service is inactive' <<< "$out" && ! grep -q '^open ' "$WORK/wd-calls"; then
  pass "E1 watchdog reads docker.service and never opens a Mac app"; else fail "E1 watchdog on Linux" "rc=$rc $out"; fi
echo retired > "$WORK/wd-home/.hawa/host-role"; : > "$WORK/wd-calls"
out="$("${WD_ENV[@]}" bash infra/ops/watchdog.sh 2>&1)"; rc=$?
if [[ $rc == 0 ]] && grep -q 'retired host .*nothing was started' <<< "$out" && ! grep -Eq 'compose|docker start|systemctl' "$WORK/wd-calls"; then
  pass "E2 watchdog on a retired Linux host starts nothing" "$out"; else fail "E2 retired watchdog" "rc=$rc $out $(cat "$WORK/wd-calls")"; fi

# ---------------------------------------------------------------------------------------------
# F. deploy.sh on a fresh Linux host (docker stubbed): the volume stamps, and the retired refusal.
D="$WORK/dp-stubs"; mkdir -p "$D" "$WORK/dp-home"
cat > "$D/docker" <<'DOCKER'
#!/bin/bash
case "$*" in
  "compose version"*) exit 0 ;;
  "volume inspect "*"--format"*) echo 2026-10-02T08:00:00Z ;;
  "volume inspect "*) exit 0 ;;
esac
exit 0
DOCKER
chmod +x "$D/docker"
DP_ENV=(env -i PATH="$D:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK/dp-home")
out="$("${DP_ENV[@]}" bash infra/docker/deploy.sh 2>&1)"; rc=$?
st="$WORK/dp-home/.hawa/volume-stamps"
if grep -q 'postgres volume stamp recorded for this host' <<< "$out" && grep -q 'restate volume stamp recorded for this host' <<< "$out" \
   && [[ "$(cat "$st/hawa-production_postgres_data.created")" == 2026-10-02T08:00:00Z && "$(stat -c %a "$st/hawa-production_restate_data.created")" == 600 ]] \
   && grep -q '.env.production is missing' <<< "$out"; then
  pass "F1 deploy.sh pre-flight on a brand-new Linux host records both stamps, then stops at the missing .env.production"
else fail "F1 fresh-host pre-flight" "rc=$rc $(tr '\n' ' ' <<< "$out" | cut -c1-400)"; fi
printf '#!/bin/bash\ncase "$*" in "compose version"*) exit 0;; "volume inspect "*"--format"*) echo 2026-10-03T08:00:00Z;; esac\nexit 0\n' > "$D/docker"
out="$("${DP_ENV[@]}" bash infra/docker/deploy.sh 2>&1)"; rc=$?
if [[ $rc == 1 ]] && grep -q "Postgres volume creation timestamp changed! Expected: '2026-10-02T08:00:00Z'" <<< "$out"; then pass "F2 a recreated volume is refused on the next deploy"; else fail "F2 recreated volume" "rc=$rc $out"; fi
echo retired > "$WORK/dp-home/.hawa/host-role"
out="$("${DP_ENV[@]}" ALLOW_DIRTY_DEPLOY=1 bash infra/docker/deploy.sh --apply 2>&1)"; rc=$?
if [[ $rc == 1 ]] && grep -q 'this host is marked retired' <<< "$out" && ! grep -q 'volume' <<< "$out"; then pass "F3 deploy.sh --apply refuses on a retired host before any step"; else fail "F3 retired refusal" "rc=$rc $out"; fi

# ---------------------------------------------------------------------------------------------
# G. The systemd units, rendered for a real user and checked by systemd-analyze (no PID 1 needed).
id hawa >/dev/null 2>&1 || useradd -m -s /bin/bash hawa
out="$(bash infra/ops/install_systemd_units.sh --render "$WORK/units" --user hawa 2>&1)"; rc=$?
if [[ $rc == 0 ]] && [[ "$(ls "$WORK/units" | wc -l)" == 10 ]]; then pass "G1 render" "$out"; else fail "G1 render" "$out"; fi
out="$(SYSTEMD_LOG_LEVEL=notice systemd-analyze verify "$WORK/units"/*.service "$WORK/units"/*.timer 2>&1)"; rc=$?
if [[ $rc == 0 ]]; then pass "G2 systemd-analyze verify: 10 units" "$(tr '\n' ' ' <<< "$out" | cut -c1-200)"; else fail "G2 systemd-analyze verify" "$(tr '\n' ' ' <<< "$out" | cut -c1-400)"; fi
for spec in "*-*-* 03:30:00 Asia/Baghdad" "Sun *-*-* 04:00:00 Asia/Baghdad" "*-*-01 05:00:00 Asia/Baghdad" "*-*-* 05:30:00 Asia/Baghdad"; do
  check "G3 calendar '$spec'" bash -c "systemd-analyze calendar '$spec' | grep -E 'Next elapse|UTC'| tr '\n' ' '"
done

# ---------------------------------------------------------------------------------------------
python3 - "$RESULTS" /out/linux-proof.json "$(uname -srm)" <<'PY'
import json, sys
rows = [line.rstrip('\n').split('\t') for line in open(sys.argv[1]) if line.strip()]
checks = [{'result': r[0], 'check': r[1], 'detail': r[2] if len(r) > 2 else ''} for r in rows]
json.dump({'host': sys.argv[3], 'passed': sum(c['result'] == 'PASS' for c in checks),
           'failed': sum(c['result'] == 'FAIL' for c in checks), 'checks': checks}, open(sys.argv[2], 'w'), indent=1)
PY
failed="$(grep -c '^FAIL' "$RESULTS")"
echo "== $(grep -c '^PASS' "$RESULTS") passed, ${failed} failed"
[[ "$failed" == 0 ]]
