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
