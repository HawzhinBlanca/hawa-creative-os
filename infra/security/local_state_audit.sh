#!/usr/bin/env bash
# Lists plaintext credential material that lives on this host OUTSIDE git: env files, deployment
# snapshots, database dumps and container inspections. The repository scanner cannot see these
# because they are ignored by git, so this is the only gate that does.
#
#   bash infra/security/local_state_audit.sh          # report; exit 1 on an exposed or committable file
#
# Prints paths, sizes and modes only. Never prints values. Never deletes anything.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PATTERN='^(export )?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_KEY|CREDENTIAL)[A-Z0-9_]*=.{6,}|"[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|_KEY)[A-Z0-9_]*=[^"]{6,}"|postgres(ql)?://[^:/@]+:[^@/]{4,}@'

# GNU or BSD stat, chosen by uname (infra/ops/host_lib.sh). `stat -f … || stat -c …` stopped deploy.sh
# on Linux: there `stat -f` is "file-system status", prints several lines and fails, and both outputs
# reached the mode check below (plans/hosting section 3.6).
source "$ROOT/infra/ops/host_lib.sh"
mode_of() { hawa_file_mode "$1"; }
size_of() { hawa_file_size "$1"; }

exposed=0; committable=0; total=0
printf '%-6s %-10s %-22s %s\n' MODE BYTES KIND PATH
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  kind=""
  case "$f" in
    *.dump|*.sql) kind="database dump" ;;
  esac
  if [[ -z "$kind" ]] && LC_ALL=C grep -aqE "$PATTERN" "$f" 2>/dev/null; then
    if LC_ALL=C grep -aq '"Env"' "$f" 2>/dev/null; then kind="container inspect (env)"; else kind="plaintext credentials"; fi
  fi
  [[ -n "$kind" ]] || continue
  total=$((total + 1))
  mode="$(mode_of "$f")"
  flags=""
  if [[ "$((8#$mode & 8#077))" -ne 0 ]]; then flags="$flags EXPOSED"; exposed=$((exposed + 1)); fi
  if ! git check-ignore -q "$f" 2>/dev/null; then flags="$flags COMMITTABLE"; committable=$((committable + 1)); fi
  printf '%-6s %-10s %-22s %s%s\n' "$mode" "$(size_of "$f")" "$kind" "$f" "$flags"
done < <(
  { find .hawa-state infra/backup/snapshots -type f 2>/dev/null || true
    find infra/docker . -maxdepth 1 -type f -name '.env*' ! -name '*.example' 2>/dev/null || true
  } | sed 's#^\./##' | sort -u
)

echo ""
echo "local credential material: ${total} file(s); exposed to other users: ${exposed}; committable: ${committable}"
if [[ $total -gt 0 ]]; then
  echo "After rotating credentials, move snapshots off the checkout to an encrypted location or delete them; this script never deletes."
fi
if [[ $exposed -gt 0 || $committable -gt 0 ]]; then
  echo "ERROR: fix the flagged files first (chmod 600 for EXPOSED; add to .gitignore or move for COMMITTABLE)."
  exit 1
fi
