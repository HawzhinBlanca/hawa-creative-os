#!/usr/bin/env bash
# Sets up the office Mac's Cloudflare named tunnel (ADR-294, runbooks/GO_LIVE_WEBSITE.md).
#
# Run by the owner or lead on the office Mac, from a checkout or release directory, AFTER the
# hawzhin.app zone is active on Cloudflare and `cloudflared tunnel login` has written
# ~/.cloudflared/cert.pem. Idempotent: every step checks first and changes only what differs.
#
#   infra/cloudflared/install.sh            # dry run (default): prints what it would do, changes nothing,
#                                           # and makes no call to Cloudflare
#   infra/cloudflared/install.sh --apply    # does it
#   infra/cloudflared/install.sh --stop     # dry run of taking the tunnel off (rollback)
#   infra/cloudflared/install.sh --stop --apply
#
# What --apply does, in order:
#   1. creates the tunnel `hawa-office` unless it exists (and fetches its credentials file if missing);
#   2. renders infra/cloudflared/config.template.yml into ~/.cloudflared/config.yml (0600; the previous
#      file is kept as config.yml.bak.<time> when it differs) and validates its ingress rules;
#   3. routes design-api.hawzhin.app and desk.hawzhin.app to the tunnel (proxied CNAMEs). An existing
#      record that points elsewhere is NOT overwritten: the command fails and says so;
#   4. installs the launchd agent com.hawa.cloudflared (RunAtLoad, KeepAlive, logs in ~/.hawa/logs) and
#      (re)starts it on the new configuration.
# Then it prints the verification steps. Nothing here touches Docker, nginx, Core or ~/.hawa/current.
#
# Overridable for tests and unusual layouts: CLOUDFLARED_BIN, LAUNCHCTL_BIN, HAWA_TUNNEL_NAME,
# HAWA_CUSTOMER_GATEWAY_PORT (8081), HAWA_DESK_GATEWAY_PORT (8082), HAWA_CLOUDFLARED_DIR (~/.cloudflared),
# HAWA_LAUNCH_AGENTS_DIR (~/Library/LaunchAgents), HAWA_LOG_DIR (~/.hawa/logs).
set -Eeuo pipefail

APPLY=0
ACTION=install
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --stop) ACTION=stop ;;
    -h|--help) sed -n '2,/^set -E/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (use --apply, --stop, --help)" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${HERE}/config.template.yml"
CLOUDFLARED="${CLOUDFLARED_BIN:-$(command -v cloudflared || true)}"
LAUNCHCTL="${LAUNCHCTL_BIN:-launchctl}"
TUNNEL="${HAWA_TUNNEL_NAME:-hawa-office}"
API_HOST="design-api.hawzhin.app"
DESK_HOST="desk.hawzhin.app"
CUSTOMER_PORT="${HAWA_CUSTOMER_GATEWAY_PORT:-8081}"
DESK_PORT="${HAWA_DESK_GATEWAY_PORT:-8082}"
CF_DIR="${HAWA_CLOUDFLARED_DIR:-${HOME}/.cloudflared}"
CONFIG="${CF_DIR}/config.yml"
AGENTS_DIR="${HAWA_LAUNCH_AGENTS_DIR:-${HOME}/Library/LaunchAgents}"
LABEL="com.hawa.cloudflared"
PLIST="${AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${HAWA_LOG_DIR:-${HOME}/.hawa/logs}"
DOMAIN="gui/$(id -u)"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
# A command that changes something: printed in a dry run, run with --apply.
change() {
  if (( APPLY )); then say "+ $*"; "$@"; else say "would run: $*"; fi
}
die() { say "ERROR: $*" >&2; exit 1; }

[[ "$CUSTOMER_PORT" =~ ^[0-9]{2,5}$ && "$DESK_PORT" =~ ^[0-9]{2,5}$ ]] || die "gateway ports must be numbers"
[[ -f "$TEMPLATE" ]] || die "missing ${TEMPLATE}"

if (( APPLY )); then say "Mode: APPLY"; else say "Mode: dry run (nothing is changed and Cloudflare is not contacted; add --apply)"; fi

if [[ "$ACTION" == stop ]]; then
  step "Take the tunnel off (rollback): stop and unload ${LABEL}"
  if [[ -f "$PLIST" ]]; then
    change "$LAUNCHCTL" bootout "${DOMAIN}/${LABEL}" || true
    change mv "$PLIST" "${PLIST}.disabled"
  else
    say "${PLIST} is not installed; nothing to stop."
  fi
  say ""
  say "The public names now answer with a Cloudflare error (530/1033); the office listener 127.0.0.1:8080 is unaffected."
  say "DNS records and the tunnel itself are kept, so install.sh --apply brings it back unchanged."
  exit 0
fi

step "Preconditions"
[[ -n "$CLOUDFLARED" && -x "$CLOUDFLARED" ]] || die "cloudflared is not installed (brew install cloudflared)"
say "cloudflared: ${CLOUDFLARED} ($("$CLOUDFLARED" --version 2>/dev/null | head -1))"
if [[ -f "${CF_DIR}/cert.pem" ]]; then
  say "account certificate: ${CF_DIR}/cert.pem"
elif (( APPLY )); then
  die "${CF_DIR}/cert.pem is missing: run \`cloudflared tunnel login\` first and pick the hawzhin.app zone"
else
  say "account certificate: MISSING (${CF_DIR}/cert.pem); --apply will stop here until \`cloudflared tunnel login\` is done"
fi

step "1. Tunnel ${TUNNEL}"
TUNNEL_ID=""
if (( APPLY )); then
  tunnel_id() {
    "$CLOUDFLARED" tunnel list --name "$TUNNEL" --output json 2>/dev/null | python3 -c '
import json, sys
name = sys.argv[1]
live = lambda t: not t.get("deleted_at") or str(t["deleted_at"]).startswith("0001-01-01")
rows = [t for t in (json.load(sys.stdin) or []) if t.get("name") == name and live(t)]
print(rows[0]["id"] if rows else "")' "$TUNNEL"
  }
  TUNNEL_ID="$(tunnel_id)"
  if [[ -z "$TUNNEL_ID" ]]; then
    change "$CLOUDFLARED" tunnel create "$TUNNEL"
    TUNNEL_ID="$(tunnel_id)"
  else
    say "exists: ${TUNNEL_ID}"
  fi
  [[ "$TUNNEL_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "could not read the id of tunnel ${TUNNEL}"
  CREDENTIALS="${CF_DIR}/${TUNNEL_ID}.json"
  if [[ ! -f "$CREDENTIALS" ]]; then
    # Created elsewhere (or the file was lost): the account certificate can fetch it again.
    change "$CLOUDFLARED" tunnel token --cred-file "$CREDENTIALS" "$TUNNEL"
  fi
  [[ -f "$CREDENTIALS" ]] || die "no credentials file ${CREDENTIALS}"
  chmod 600 "$CREDENTIALS"
else
  say "would look up tunnel ${TUNNEL} (cloudflared tunnel list --name ${TUNNEL}) and create it if missing:"
  say "would run: ${CLOUDFLARED} tunnel create ${TUNNEL}"
  TUNNEL_ID="00000000-0000-0000-0000-000000000000"
  CREDENTIALS="${CF_DIR}/<tunnel id>.json"
fi

step "2. ${CONFIG}"
RENDERED="$(mktemp "${TMPDIR:-/tmp}/hawa-cloudflared.XXXXXX")"
trap 'rm -f "$RENDERED"' EXIT
sed -e "s#__TUNNEL_ID__#${TUNNEL_ID}#g" -e "s#__CREDENTIALS_FILE__#${CREDENTIALS}#g" \
    -e "s#__CUSTOMER_PORT__#${CUSTOMER_PORT}#g" -e "s#__DESK_PORT__#${DESK_PORT}#g" "$TEMPLATE" > "$RENDERED"
! grep -q '__[A-Z_]*__' "$RENDERED" || die "a template placeholder was left unfilled"
# Offline: checks the rules only, never contacts Cloudflare.
"$CLOUDFLARED" tunnel --config "$RENDERED" ingress validate >/dev/null || die "the rendered ingress rules do not validate"
say "ingress rules validate"
if [[ -f "$CONFIG" ]] && cmp -s "$RENDERED" "$CONFIG"; then
  say "unchanged"
  CONFIG_CHANGED=0
else
  CONFIG_CHANGED=1
  if (( APPLY )); then
    mkdir -p "$CF_DIR"
    if [[ -f "$CONFIG" ]]; then cp -p "$CONFIG" "${CONFIG}.bak.$(date +%Y%m%d%H%M%S)"; say "previous file kept as ${CONFIG}.bak.*"; fi
    install -m 600 "$RENDERED" "$CONFIG"
    say "written"
  else
    say "would write (0600):"
    sed 's/^/    /' "$RENDERED"
  fi
fi

step "3. DNS: ${API_HOST} and ${DESK_HOST} -> tunnel ${TUNNEL}"
for host in "$API_HOST" "$DESK_HOST"; do
  # No --overwrite-dns: an existing record for another target stays, and this fails with Cloudflare's message.
  change "$CLOUDFLARED" tunnel route dns "$TUNNEL" "$host"
done

step "4. launchd agent ${LABEL}"
PLIST_BODY="$(cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CLOUDFLARED}</string>
    <string>tunnel</string>
    <string>--config</string><string>${CONFIG}</string>
    <string>--no-autoupdate</string>
    <string>run</string>
    <string>${TUNNEL}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/cloudflared.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/cloudflared.err.log</string>
</dict>
</plist>
PLIST_EOF
)"
if [[ -f "$PLIST" ]] && [[ "$(cat "$PLIST")" == "$PLIST_BODY" ]]; then
  say "${PLIST} unchanged"
  PLIST_CHANGED=0
else
  PLIST_CHANGED=1
  if (( APPLY )); then
    mkdir -p "$AGENTS_DIR" "$LOG_DIR"
    printf '%s\n' "$PLIST_BODY" > "$PLIST"
    chmod 644 "$PLIST"
    say "written ${PLIST}"
  else
    say "would write ${PLIST} (logs in ${LOG_DIR}):"
    printf '%s\n' "$PLIST_BODY" | sed 's/^/    /'
  fi
fi
LOADED=0
if "$LAUNCHCTL" print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then LOADED=1; fi
if (( LOADED && PLIST_CHANGED )); then
  change "$LAUNCHCTL" bootout "${DOMAIN}/${LABEL}"
  LOADED=0
fi
if (( ! LOADED )); then
  change "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
elif (( CONFIG_CHANGED )); then
  change "$LAUNCHCTL" kickstart -k "${DOMAIN}/${LABEL}"
else
  say "running, configuration unchanged"
fi

step "Verify"
cat <<VERIFY_EOF
  1. The tunnel has connections:   ${CLOUDFLARED} tunnel info ${TUNNEL}
     Logs:                         tail -f ${LOG_DIR}/cloudflared.err.log
  2. The listeners, locally:       pnpm exec tsx scripts/verify_public_gateway.ts --local
  3. From outside (a phone off the office network, or any other machine):
                                   pnpm exec tsx scripts/verify_public_gateway.ts https://${API_HOST}
     It must end "all N checks passed". Until Core runs with HAWA_DESK_AUTH_MODE=required, Google
     sign-in and HAWA_CUSTOMER_API_ENABLED=on, the customer and Desk checks fail: that is expected at
     this step (runbooks/GO_LIVE_WEBSITE.md, lead step L3).
  4. The address nginx logged is the caller's, not Docker's gateway:
                                   docker logs --since 2m hawa-production-nginx-1 2>&1 | grep 'customer/session' | tail -3
  Rollback (tunnel off):           infra/cloudflared/install.sh --stop --apply
VERIFY_EOF
