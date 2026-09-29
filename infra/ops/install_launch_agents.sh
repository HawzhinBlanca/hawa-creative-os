#!/usr/bin/env bash
# Installs (or removes) the per-user launch agents that keep the office stack alive unattended:
#   design.hawa.watchdog              every 5 minutes and at login: infra/ops/watchdog.sh
#   design.hawa.nightly-backup        03:30 local time:              infra/backup/nightly_backup.sh
#   design.hawa.backup-restore-drill  Sundays 04:00:                 infra/backup/backup_restore_drill.sh (schema parity)
#   design.hawa.restore-drill         the 1st of each month, 05:00:  infra/backup/restore_drill.sh (data and files, ADR-035)
#   design.hawa.offsite-copy          05:30:                         infra/backup/offsite_copy.sh (ADR-141; copies nothing until HAWA_OFFSITE_DEST is set)
#
#   bash infra/ops/install_launch_agents.sh            # install or refresh
#   bash infra/ops/install_launch_agents.sh --uninstall
#   bash infra/ops/install_launch_agents.sh --render <dir>   # write the plists to <dir> only; launchctl is not called
# Logs: ~/.hawa/logs/. Agents run only while this user is logged in (that is how launchd works on a Mac).
# On a Linux host use infra/ops/install_systemd_units.sh instead (the same jobs as systemd timers).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS="${HAWA_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"; LOGS="$HOME/.hawa/logs"
OUT="$AGENTS"; RENDER=0
if [[ "${1:-}" == "--render" ]]; then OUT="${2:?--render needs a directory}"; RENDER=1; mkdir -p "$OUT"; else mkdir -p "$AGENTS" "$LOGS"; fi
PATHS="/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.docker/bin"
uid="$(id -u)"
# Settings added by hand to an installed agent (the nightly job's archive destination, its passphrase
# file and how many copies to keep) are carried over. Rewriting the plist without them sent the next
# nightly copy to the default folder, unencrypted, with nothing to say so.
carried_env() { # label [key pattern] -> <key>/<string> pairs for every HAWA_* variable the installed agent has
  local plist="$AGENTS/$1.plist" pattern="${2:-^HAWA_}" key value
  [[ -f "$plist" ]] || return 0
  { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables" "$plist" 2>/dev/null || true; } \
    | sed -nE 's/^ *(HAWA_[A-Z0-9_]+) = .*/\1/p' | { grep -E "$pattern" || true; } | while read -r key; do
      value="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$key" "$plist")"
      value="$(printf '%s' "$value" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
      printf '<key>%s</key><string>%s</string>' "$key" "$value"
    done
}
write_plist() { # label, script, schedule-xml, [label whose HAWA_* settings to carry when this one has none], [carried settings]
  local carried; carried="$(carried_env "$1")"
  if [[ -z "$carried" && -n "${4:-}" ]]; then carried="$(carried_env "$4")"; fi
  if [[ -n "${5+x}" ]]; then carried="$5"; fi
  cat > "$OUT/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string><key>HOME</key><string>$HOME</string>$carried</dict>
  $3
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
</dict></plist>
PLIST
}
AGENT_LABELS=(design.hawa.watchdog design.hawa.nightly-backup design.hawa.backup-restore-drill design.hawa.restore-drill design.hawa.offsite-copy)
if [[ "$RENDER" == 0 ]]; then
  for label in "${AGENT_LABELS[@]}"; do launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true; done
fi
if [[ "${1:-}" == "--uninstall" ]]; then rm -f "$AGENTS"/design.hawa.*.plist; echo "launch agents removed"; exit 0; fi
write_plist design.hawa.watchdog "$ROOT/infra/ops/watchdog.sh" "<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>"
write_plist design.hawa.nightly-backup "$ROOT/infra/backup/nightly_backup.sh" "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>"
write_plist design.hawa.backup-restore-drill "$ROOT/infra/backup/backup_restore_drill.sh" "<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>7</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>"
# The monthly drill restores the newest archived dump and its files; it carries the nightly job's
# archive settings (destination, passphrase file) over from that agent's installed plist when it has
# none of its own, since it reads the same archive.
write_plist design.hawa.restore-drill "$ROOT/infra/backup/restore_drill.sh" "<key>StartCalendarInterval</key><dict><key>Day</key><integer>1</integer><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>" design.hawa.nightly-backup
# The off-site copy (ADR-141) reads the same archive as the nightly job, so it always takes that
# agent's archive settings, and keeps its own HAWA_OFFSITE_* (the destination, the ssh command and how
# many sets to keep), which are added to its plist by hand; without HAWA_OFFSITE_DEST it copies nothing.
write_plist design.hawa.offsite-copy "$ROOT/infra/backup/offsite_copy.sh" "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>" "" \
  "$(carried_env design.hawa.nightly-backup '^HAWA_' | sed -E 's#<key>HAWA_OFFSITE_[A-Z0-9_]+</key><string>[^<]*</string>##g')$(carried_env design.hawa.offsite-copy '^HAWA_OFFSITE_')"
if [[ "$RENDER" == 1 ]]; then echo "rendered ${#AGENT_LABELS[@]} launch agents into $OUT"; exit 0; fi
for label in "${AGENT_LABELS[@]}"; do
  launchctl bootstrap "gui/$uid" "$AGENTS/$label.plist"
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 && echo "✓ $label loaded" || { echo "ERROR: $label did not load"; exit 1; }
done
