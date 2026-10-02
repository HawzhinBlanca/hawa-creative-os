#!/usr/bin/env bash
# Installs (or removes) the systemd units that keep production alive unattended on a Linux host: the
# Linux counterpart of install_launch_agents.sh (ADR-141, plans/hosting section 6.1). Macs keep the
# launch agents. Each timer runs the same script as the launch agent of the same name:
#   hawa-watchdog              at boot, then every 5 minutes:        infra/ops/watchdog.sh
#   hawa-nightly-backup        03:30 Asia/Baghdad, catch-up at boot: infra/backup/nightly_backup.sh
#   hawa-backup-restore-drill  Sundays 04:00:                        infra/backup/backup_restore_drill.sh (schema parity)
#   hawa-restore-drill         the 1st of each month, 05:00:         infra/backup/restore_drill.sh (data and files)
#   hawa-offsite-copy          05:30:                                infra/backup/offsite_copy.sh (off until configured)
#   hawa-live-canary           04:30 Asia/Baghdad:                   infra/ops/live_canary.sh (ADR-240/254; skipped until configured)
#
#   sudo bash infra/ops/install_systemd_units.sh [--user hawa]    # install or refresh; enable and start the timers
#   sudo bash infra/ops/install_systemd_units.sh --uninstall      # stop, disable and remove them (settings are kept)
#   bash infra/ops/install_systemd_units.sh --render <dir> [--user <name>]   # write the units to <dir> only
#
# The units are system units that run as the unprivileged user who owns this checkout and is in the
# docker group (--user, else the user who ran sudo), so they run from boot without anyone logging in.
# Settings live in /etc/hawa/backup.env (root-owned, 0600; systemd reads it before dropping to the
# user): HAWA_BACKUP_ARCHIVE_DEST, HAWA_BACKUP_ARCHIVE_KEYFILE, HAWA_BACKUP_ARCHIVE_KEEP,
# HAWA_RESTATE_BACKUP_ENABLED, HAWA_RESTATE_BACKUP_HELPER_IMAGE (the variables the launch agents carry),
# and HAWA_OFFSITE_*. A first install writes it from those variables when they are set in the calling
# environment, as commented lines otherwise; an existing file is never rewritten, only tightened to 0600.
# Logs: ~/.hawa/logs/<launch agent label>.log, as on the Mac.
#   HAWA_SYSTEMD_UNIT_DIR (/etc/systemd/system), HAWA_BACKUP_ENV_FILE (/etc/hawa/backup.env) and
#   HAWA_UNIT_PATH (the PATH the jobs get) can be overridden.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/infra/ops/systemd"
UNIT_DIR="${HAWA_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
ENV_FILE="${HAWA_BACKUP_ENV_FILE:-/etc/hawa/backup.env}"
UNITS=(hawa-watchdog hawa-nightly-backup hawa-backup-restore-drill hawa-restore-drill hawa-offsite-copy hawa-live-canary)
LABELS=(design.hawa.watchdog design.hawa.nightly-backup design.hawa.backup-restore-drill design.hawa.restore-drill design.hawa.offsite-copy design.hawa.live-canary)
CARRIED=(HAWA_BACKUP_ARCHIVE_DEST HAWA_BACKUP_ARCHIVE_KEYFILE HAWA_BACKUP_ARCHIVE_KEEP HAWA_RESTATE_BACKUP_ENABLED
  HAWA_RESTATE_BACKUP_HELPER_IMAGE HAWA_OFFSITE_DEST HAWA_OFFSITE_RSH HAWA_OFFSITE_KEEP HAWA_HOST_ROLE)
die() { echo "ERROR: $1" >&2; exit 1; }

MODE=install; RENDER_DIR=""; RUN_USER="${SUDO_USER:-$(id -un)}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --render) MODE=render; RENDER_DIR="${2:?--render needs a directory}"; shift ;;
    --user) RUN_USER="${2:?--user needs a name}"; shift ;;
    *) die "unknown argument $1 (see the header of this script)" ;;
  esac
  shift
done

if [[ "$MODE" == uninstall ]]; then
  [[ "$(id -u)" == 0 || -n "${HAWA_SYSTEMD_UNIT_DIR:-}" ]] || die "run it with sudo"
  for unit in "${UNITS[@]}"; do systemctl disable --now "$unit.timer" >/dev/null 2>&1 || true; systemctl stop "$unit.service" >/dev/null 2>&1 || true; done
  for unit in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$unit.service" "$UNIT_DIR/$unit.timer"; done
  systemctl daemon-reload
  echo "systemd units removed; ${ENV_FILE} was kept (it holds the backup settings)"
  exit 0
fi

[[ "$MODE" == render || "$(uname -s)" == Linux ]] || die "systemd units are for Linux; on a Mac run infra/ops/install_launch_agents.sh"
[[ "$RUN_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || die "'$RUN_USER' is not a user name (--user)"
[[ "$RUN_USER" != root ]] || die "the jobs must not run as root: pass --user with the account that owns the checkout and is in the docker group"
id "$RUN_USER" >/dev/null 2>&1 || die "no user '$RUN_USER' on this host (--user)"
if command -v getent >/dev/null; then RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"; else RUN_HOME="$(eval "echo ~$RUN_USER")"; fi
RUN_GROUP="$(id -gn "$RUN_USER")"
[[ "$RUN_HOME" == /* ]] || die "no home directory for '$RUN_USER'"
LOGS="$RUN_HOME/.hawa/logs"
# The units run the release production runs, through its link (ADR-158; install_launch_agents.sh says
# why); this checkout only until a first deploy has made one. HAWA_AGENT_ROOT names another directory.
CURRENT="${HAWA_CURRENT_LINK:-$RUN_HOME/.hawa/current}"
if [[ -n "${HAWA_AGENT_ROOT:-}" ]]; then ROOT="$HAWA_AGENT_ROOT"
elif [[ -d "$CURRENT" ]]; then ROOT="$CURRENT"
else echo "NOTE: no release at $CURRENT yet: the units run this checkout's scripts ($ROOT) until the first deploy with release directories"; fi
if [[ -z "${HAWA_UNIT_PATH:-}" ]]; then
  # node and pnpm (deploy.sh, the monthly drill's blob-verify), docker, python3: wherever this shell finds them.
  UNIT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  for tool in node pnpm docker python3; do
    found="$(command -v "$tool" 2>/dev/null || true)"; dir="${found%/*}"
    [[ -z "$found" || ":$UNIT_PATH:" == *":$dir:"* ]] || UNIT_PATH="$dir:$UNIT_PATH"
  done
else
  UNIT_PATH="$HAWA_UNIT_PATH"
fi
for value in "$ROOT" "$RUN_HOME" "$RUN_USER" "$RUN_GROUP" "$UNIT_PATH" "$ENV_FILE"; do
  [[ "$value" != *[[:space:]\|]* ]] || die "'$value' holds whitespace or '|', which a unit file cannot take"
done

render() { # into $1
  local out="$1" file
  mkdir -p "$out"
  for file in "$SRC"/*.in; do
    sed -e "s|@ROOT@|$ROOT|g" -e "s|@USER@|$RUN_USER|g" -e "s|@GROUP@|$RUN_GROUP|g" -e "s|@HOME@|$RUN_HOME|g" \
        -e "s|@PATH@|$UNIT_PATH|g" -e "s|@ENV_FILE@|$ENV_FILE|g" -e "s|@LOGS@|$LOGS|g" "$file" > "$out/$(basename "${file%.in}")"
  done
  ! grep -l '@[A-Z_]*@' "$out"/*.service "$out"/*.timer || die "a placeholder was left unrendered"
}

if [[ "$MODE" == render ]]; then
  render "$RENDER_DIR"
  echo "rendered $(ls "$RENDER_DIR" | wc -l | tr -d ' ') unit files into $RENDER_DIR for user $RUN_USER"
  exit 0
fi

[[ "$(id -u)" == 0 ]] || die "run it with sudo: it writes $UNIT_DIR and $ENV_FILE"
command -v systemctl >/dev/null || die "systemctl not found: is this host running systemd?"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
render "$STAGE"
if command -v systemd-analyze >/dev/null; then
  systemd-analyze verify "$STAGE"/*.service "$STAGE"/*.timer || die "systemd-analyze verify rejected the rendered units; nothing was installed"
fi

# Logs, as on the Mac: created here, owned by the user, so systemd appends to files the jobs own.
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 700 "$RUN_HOME/.hawa" "$LOGS"
for label in "${LABELS[@]}"; do
  [[ -e "$LOGS/$label.log" ]] || install -o "$RUN_USER" -g "$RUN_GROUP" -m 600 /dev/null "$LOGS/$label.log"
done

# The settings file: written once, never rewritten; values are never printed.
if [[ -f "$ENV_FILE" ]]; then
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
  echo "✓ kept ${ENV_FILE} (root, 0600)"
else
  install -d -m 755 "$(dirname "$ENV_FILE")"
  ( umask 077
    { echo "# Hawa backup and off-site settings for the systemd units (ADR-141). Root-owned, 0600; never in git."
      echo "# Same variables the Mac launch agents carry; see infra/ops/README.md and runbooks/10_backup_restore.md."
      for key in "${CARRIED[@]}"; do
        if [[ -n "${!key:-}" ]]; then printf '%s=%s\n' "$key" "${!key}"; else printf '#%s=\n' "$key"; fi
      done
    } > "$ENV_FILE" )
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
  echo "✓ wrote ${ENV_FILE} (root, 0600): fill in the commented settings, then re-run this script or systemctl restart the timers"
fi

for unit in "${UNITS[@]}"; do
  install -m 644 "$STAGE/$unit.service" "$UNIT_DIR/$unit.service"
  install -m 644 "$STAGE/$unit.timer" "$UNIT_DIR/$unit.timer"
done
systemctl daemon-reload
for unit in "${UNITS[@]}"; do
  systemctl enable "$unit.timer" >/dev/null 2>&1 || die "$unit.timer could not be enabled"
  systemctl restart "$unit.timer" || die "$unit.timer could not be started"
  if systemctl is-active --quiet "$unit.timer"; then echo "✓ $unit.timer active"; else die "$unit.timer is not active"; fi
done
systemctl list-timers --all 'hawa-*' --no-pager || true
