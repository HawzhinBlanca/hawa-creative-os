# Shared host helpers for the production scripts (sourced, never run). ADR-141.
#
# Production runs on macOS today and may move to an arm64 Linux server (plans/hosting). The scripts
# that run on the production host (deploy.sh, the watchdog, the nightly backup and its drills, the
# local-state audit, the off-site copy) take their host-specific commands from here, chosen once by
# `uname`. Never `bsd-form || gnu-form`: on Linux `stat -f` means "file-system status", prints several
# lines and fails, and both outputs ended up in one variable (plans/hosting section 3.6).
#
# Bash 3.2 compatible: the macOS launch agents run the scripts with /bin/bash.
#
#   HAWA_STAT_SIZE   command array: prints the size in bytes of each file argument, one per line
#   HAWA_STAT_MODE   command array: prints the permission bits in octal (600, 755) of each argument
#   HAWA_SHA256      command array: `<hex>  <name>` for each argument, or for stdin with no argument
#   hawa_file_size <file>, hawa_file_mode <file>
#   hawa_utc_days_ago <days> <date format>   the UTC date that many days ago (BSD date -v, GNU date -d)
#   hawa_host_role   production | standby | retired (see below); exit 2 for a value it does not know
#   hawa_host_role_source   where the role came from, for messages

HAWA_HOST_OS="$(uname -s 2>/dev/null || echo unknown)"
case "$HAWA_HOST_OS" in
  Linux)
    HAWA_STAT_SIZE=(stat -c '%s')
    HAWA_STAT_MODE=(stat -c '%a')
    ;;
  *)
    # macOS and the BSDs.
    HAWA_STAT_SIZE=(stat -f '%z')
    HAWA_STAT_MODE=(stat -f '%Lp')
    ;;
esac
# shasum ships with macOS and with perl on Linux; sha256sum is GNU coreutils. Same output format.
if command -v shasum >/dev/null 2>&1; then
  HAWA_SHA256=(shasum -a 256)
else
  HAWA_SHA256=(sha256sum)
fi

hawa_file_size() { "${HAWA_STAT_SIZE[@]}" "$1"; }
hawa_file_mode() { "${HAWA_STAT_MODE[@]}" "$1"; }
hawa_utc_days_ago() {
  if [[ "$HAWA_HOST_OS" == Linux ]]; then date -u -d "-$1 days" "+$2"; else date -u -v-"$1"d "+$2"; fi
}

# The host's role in production, host-local and never in git:
#   production  (also: nothing set) this host runs production: today's behaviour everywhere
#   standby     a host being prepared (the rehearsal before a cutover): nothing starts production here
#   retired     the host production moved away from: nothing starts production here
# HAWA_HOST_ROLE wins over the file ${HAWA_HOST_ROLE_FILE:-~/.hawa/host-role} (its first word).
# On standby and retired hosts the watchdog never starts or restarts a hawa-production container,
# deploy.sh --apply refuses, and the nightly backup, the drills and the off-site copy skip. Two hosts
# must never run production at once: both would poll the same Telegram bot (plans/hosting 7.4 and 8).
hawa_host_role_file() { printf '%s' "${HAWA_HOST_ROLE_FILE:-$HOME/.hawa/host-role}"; }
hawa_host_role_source() {
  if [[ -n "${HAWA_HOST_ROLE:-}" ]]; then printf 'HAWA_HOST_ROLE'; else hawa_host_role_file; fi
}
hawa_host_role() {
  local raw file
  if [[ -n "${HAWA_HOST_ROLE:-}" ]]; then
    raw="$HAWA_HOST_ROLE"
  else
    file="$(hawa_host_role_file)"
    if [[ -f "$file" ]]; then raw="$(awk 'NF { print $1; exit }' "$file" 2>/dev/null || true)"; else raw=""; fi
  fi
  raw="$(printf '%s' "$raw" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    ""|production) echo production ;;
    standby|retired) echo "$raw" ;;
    *) echo "$raw"; return 2 ;;
  esac
}

# The outside heartbeat (2026-10-02 operations review): the watchdog alerts through Telegram from this same
# host, so a host that is off, asleep, locked at FileVault after an update, or offline says nothing. A
# healthy pass pings HAWA_HEARTBEAT_URL (an https check URL from a dead-man's-switch service the owner
# chooses, e.g. healthchecks.io or Better Stack); that service alerts the owner when the pings stop. Read
# from the environment or the production env file (spaces around it, quotes and a trailing CR stripped);
# unset: nothing is sent. Returns 1 when the ping failed, and 2 when the value is set but is not an https
# URL (a URL pasted without its scheme sent nothing and said nothing, and a new check never alerts before
# its first ping), so the caller can say so.
hawa_heartbeat() { # env file
  local url="${HAWA_HEARTBEAT_URL:-}"
  [[ -n "$url" ]] || url="$(grep -E '^HAWA_HEARTBEAT_URL=' "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true)"
  url="$(printf '%s' "$url" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  url="${url%\"}"; url="${url#\"}"; url="${url%\'}"; url="${url#\'}"
  [[ -n "$url" ]] || return 0
  [[ "$url" =~ ^https://[^[:space:]]+$ ]] || return 2
  curl -fsS -m 10 -o /dev/null "$url" >/dev/null 2>&1 || return 1
}
