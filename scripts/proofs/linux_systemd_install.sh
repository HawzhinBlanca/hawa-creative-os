#!/usr/bin/env bash
# Installs the systemd units (infra/ops/install_systemd_units.sh) under a real systemd and runs the
# jobs once through systemd (ADR-141). Runs INSIDE a throwaway container whose PID 1 is systemd, with a
# copy of the repository read-only at /repo and an output directory at /out, for example:
#
#   docker run -d --name hawa-systemd-proof --network none --privileged --cgroupns=private \
#     --tmpfs /run --tmpfs /run/lock -e container=docker -v "$COPY:/repo:ro" -v "$OUT:/out" hawa-linux-proof:local /sbin/init
#   docker exec hawa-systemd-proof bash /repo/scripts/proofs/linux_systemd_install.sh
#
# `docker` is a stub that says the daemon is down, so no job can reach a container; no network.
set -uo pipefail
RESULTS=/tmp/systemd-results.tsv; : > "$RESULTS"
pass() { printf 'PASS\t%s\t%s\n' "$1" "${2:-}" | tee -a "$RESULTS"; }
fail() { printf 'FAIL\t%s\t%s\n' "$1" "${2:-}" | tee -a "$RESULTS"; }
LOGS=/home/hawa/.hawa/logs

systemctl is-system-running --wait >/dev/null 2>&1 || true
echo "== $(systemctl --version | head -1); PID 1: $(ps -o comm= -p 1)"
id hawa >/dev/null 2>&1 || useradd -m -s /bin/bash hawa
cp -a /repo /home/hawa/Hawdesign && chown -R hawa:hawa /home/hawa/Hawdesign
printf '#!/bin/bash\n[[ "$1" == info ]] && exit 1\nexit 0\n' > /usr/local/bin/docker; chmod 755 /usr/local/bin/docker

out="$(HAWA_BACKUP_ARCHIVE_KEEP=14 HAWA_RESTATE_BACKUP_ENABLED=on bash /home/hawa/Hawdesign/infra/ops/install_systemd_units.sh --user hawa 2>&1)"; rc=$?
if [[ $rc == 0 && "$(grep -c '\.timer active' <<< "$out")" == 5 ]]; then pass "S1 install: 5 timers enabled and active (systemd-analyze verify passed inside)"; else fail "S1 install" "rc=$rc $(tr '\n' ' ' <<< "$out")"; fi
envf=/etc/hawa/backup.env
if [[ "$(stat -c '%U %a' "$envf")" == "root 600" ]] && grep -qx 'HAWA_RESTATE_BACKUP_ENABLED=on' "$envf" && grep -qx 'HAWA_BACKUP_ARCHIVE_KEEP=14' "$envf" && grep -qx '#HAWA_OFFSITE_DEST=' "$envf"; then
  pass "S2 /etc/hawa/backup.env root 0600, seeded from the calling environment"; else fail "S2 env file" "$(stat -c '%U %a' "$envf"; cat "$envf")"; fi
if [[ "$(stat -c '%U %a' "$LOGS/design.hawa.watchdog.log")" == "hawa 600" && "$(stat -c '%U %a' "$LOGS")" == "hawa 700" ]]; then pass "S3 logs in ~hawa/.hawa/logs, owned by the job user"; else fail "S3 logs" "$(ls -la "$LOGS")"; fi
timers="$(systemctl list-timers --all --no-pager 'hawa-*' 2>&1)"
if [[ "$(grep -c 'hawa-.*\.timer' <<< "$timers")" == 5 ]]; then pass "S4 list-timers shows 5 hawa timers" "$(grep 'nightly' <<< "$timers" | tr -s ' ' | cut -c1-120)"; else fail "S4 list-timers" "$timers"; fi

# The watchdog, started by its timer (OnActiveSec=10s) and by hand: Docker down, docker.service unknown.
for _ in $(seq 1 60); do grep -q 'Docker is not running' "$LOGS/design.hawa.watchdog.log" && break; sleep 1; done
if grep -q 'Docker is not running: docker.service is inactive' "$LOGS/design.hawa.watchdog.log"; then
  pass "S5 the watchdog timer fired by itself and the pass ran as hawa" "$(grep -m1 'PROBLEM' "$LOGS/design.hawa.watchdog.log" | cut -c1-140)"
else fail "S5 watchdog timer" "$(systemctl status hawa-watchdog.timer hawa-watchdog.service --no-pager 2>&1 | tail -15 | tr '\n' ' ')"; fi
runuser -u hawa -- bash -c 'mkdir -p ~/.hawa && echo retired > ~/.hawa/host-role'
systemctl start hawa-watchdog.service; rc=$?
if [[ $rc == 0 ]] && tail -1 "$LOGS/design.hawa.watchdog.log" | grep -q '^retired host (/home/hawa/.hawa/host-role): production runs elsewhere; nothing was started$'; then
  pass "S6 on a retired host the watchdog service succeeds and starts nothing"; else fail "S6 retired watchdog" "rc=$rc $(tail -2 "$LOGS/design.hawa.watchdog.log")"; fi

# The nightly backup reads /etc/hawa/backup.env: HAWA_HOST_ROLE there wins over the file.
echo 'HAWA_HOST_ROLE=standby' >> "$envf"
systemctl start hawa-nightly-backup.service; rc=$?
if [[ $rc == 0 ]] && grep -q 'SKIP .*this host is standby (HAWA_HOST_ROLE); production runs elsewhere, no backup was taken' "$LOGS/design.hawa.nightly-backup.log"; then
  pass "S7 hawa-nightly-backup.service ran as hawa with the settings file (standby: skipped)"; else fail "S7 nightly via systemd" "rc=$rc $(tail -3 "$LOGS/design.hawa.nightly-backup.log")"; fi
sed -i '/^HAWA_HOST_ROLE=/d' "$envf"; rm -f /home/hawa/.hawa/host-role
systemctl start hawa-offsite-copy.service; rc=$?
if [[ $rc == 0 ]] && grep -q 'off-site copy is not configured' "$LOGS/design.hawa.offsite-copy.log"; then pass "S8 hawa-offsite-copy.service: not configured, nothing done"; else fail "S8 offsite via systemd" "rc=$rc $(tail -2 "$LOGS/design.hawa.offsite-copy.log")"; fi
user="$(systemctl show hawa-nightly-backup.service -p User --value)"; [[ "$user" == hawa ]] && pass "S9 jobs run as hawa, not root" || fail "S9 user" "$user"

# A second install keeps the settings; --uninstall removes the units and keeps the settings.
echo '# kept by hand' >> "$envf"
out="$(bash /home/hawa/Hawdesign/infra/ops/install_systemd_units.sh --user hawa 2>&1)"; rc=$?
if [[ $rc == 0 ]] && grep -q 'kept /etc/hawa/backup.env' <<< "$out" && grep -qx '# kept by hand' "$envf"; then pass "S10 reinstall keeps /etc/hawa/backup.env as it is"; else fail "S10 reinstall" "$out"; fi
out="$(bash /home/hawa/Hawdesign/infra/ops/install_systemd_units.sh --uninstall 2>&1)"; rc=$?
if [[ $rc == 0 && ! -e /etc/systemd/system/hawa-watchdog.timer && -f "$envf" ]] && ! systemctl list-timers --all --no-pager | grep -q hawa-; then pass "S11 --uninstall removes every unit and keeps the settings"; else fail "S11 uninstall" "rc=$rc $out"; fi

python3 - "$RESULTS" /out/systemd-proof.json "$(systemctl --version | head -1)" <<'PY'
import json, sys
rows = [line.rstrip('\n').split('\t') for line in open(sys.argv[1]) if line.strip()]
checks = [{'result': r[0], 'check': r[1], 'detail': r[2] if len(r) > 2 else ''} for r in rows]
json.dump({'systemd': sys.argv[3], 'passed': sum(c['result'] == 'PASS' for c in checks),
           'failed': sum(c['result'] == 'FAIL' for c in checks), 'checks': checks}, open(sys.argv[2], 'w'), indent=1)
PY
failed="$(grep -c '^FAIL' "$RESULTS")"
echo "== $(grep -c '^PASS' "$RESULTS") passed, ${failed} failed"
[[ "$failed" == 0 ]]
