#!/usr/bin/env bash
# Installs (or removes) the two per-user launch agents that keep the office stack alive unattended:
#   design.hawa.watchdog        every 5 minutes and at login: infra/ops/watchdog.sh
#   design.hawa.nightly-backup  03:30 local time:              infra/backup/nightly_backup.sh
#
#   bash infra/ops/install_launch_agents.sh            # install or refresh
#   bash infra/ops/install_launch_agents.sh --uninstall
# Logs: ~/.hawa/logs/. Agents run only while this user is logged in (that is how launchd works on a Mac).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"; LOGS="$HOME/.hawa/logs"; mkdir -p "$AGENTS" "$LOGS"
PATHS="/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.docker/bin"
uid="$(id -u)"
write_plist() { # label, script, schedule-xml
  cat > "$AGENTS/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATHS</string><key>HOME</key><string>$HOME</string></dict>
  $3
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
</dict></plist>
PLIST
}
for label in design.hawa.watchdog design.hawa.nightly-backup; do launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true; done
if [[ "${1:-}" == "--uninstall" ]]; then rm -f "$AGENTS"/design.hawa.*.plist; echo "launch agents removed"; exit 0; fi
write_plist design.hawa.watchdog "$ROOT/infra/ops/watchdog.sh" "<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>"
write_plist design.hawa.nightly-backup "$ROOT/infra/backup/nightly_backup.sh" "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>"
for label in design.hawa.watchdog design.hawa.nightly-backup; do
  launchctl bootstrap "gui/$uid" "$AGENTS/$label.plist"
  launchctl print "gui/$uid/$label" >/dev/null 2>&1 && echo "✓ $label loaded" || { echo "ERROR: $label did not load"; exit 1; }
done
