#!/usr/bin/env bash
# Rotate the credentials that live in third-party consoles, without editing files by hand.
#
#   bash infra/docker/rotate_external_secrets.sh          # asks for each new value (hidden input), verifies it,
#                                                         # writes infra/docker/.env.production, redeploys
#   bash infra/docker/rotate_external_secrets.sh --check  # only verifies the values currently configured
#
# Press Enter without typing to skip a value. Nothing you type is echoed or logged.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.production"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE is missing"; exit 1; }
umask 077

current() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
http() { curl -s -o /dev/null -w '%{http_code}' -m 20 "$@" || echo 000; }

verify_telegram() { # prints bot username on success
  local out; out="$(curl -s -m 20 "https://api.telegram.org/bot$1/getMe" || true)"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); r=d.get("result") or {}; print("ok @"+r["username"]) if d.get("ok") and r.get("username") else (print("REJECTED: "+str(d.get("description","no answer"))), sys.exit(1))' "$out"
}
verify_gemini() { local code; code="$(http "https://generativelanguage.googleapis.com/v1beta/models?key=$1")"; [[ "$code" == "200" ]] && echo "ok (HTTP 200)" || { echo "REJECTED (HTTP $code)"; return 1; }; }
verify_anthropic() { local code; code="$(http https://api.anthropic.com/v1/models -H "x-api-key: $1" -H 'anthropic-version: 2023-06-01')"; [[ "$code" == "200" ]] && echo "ok (HTTP 200)" || { echo "REJECTED (HTTP $code)"; return 1; }; }
verify_canva_secret() { [[ ${#1} -ge 32 ]] && echo "format ok (verified live after redeploy via /v1/integrations/canva/status)" || { echo "REJECTED: too short to be a Canva client secret"; return 1; }; }

if [[ "${1:-}" == "--check" ]]; then
  echo "Telegram bot token: $(verify_telegram "$(current TELEGRAM_BOT_TOKEN)" || true)"
  echo "Anthropic key:      $(verify_anthropic "$(current ANTHROPIC_API_KEY)" || true)"
  echo "Gemini key:         $(verify_gemini "$(current GEMINI_API_KEY)" || true)"
  echo "Canva client secret: $(verify_canva_secret "$(current CANVA_CLIENT_SECRET)" || true)"
  OP="$(current HAWA_BEARER_TOKEN)"
  echo "Canva connection (live): $(curl -s -m 15 -H "Authorization: Bearer $OP" http://127.0.0.1:8080/v1/integrations/canva/status | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d.get("status") or d.get("state") or json.dumps({k:v for k,v in d.items() if k in ("connected","status","state","expiresAt","scopes")}))
except Exception: print("no answer (is the stack running?)")')"
  exit 0
fi

declare -a CHANGED=()
ask() { # $1 key  $2 label  $3 verifier
  local value
  echo ""
  echo "== $2 =="
  read -rs -p "Paste the NEW value and press Enter (or just Enter to skip): " value; echo ""
  [[ -n "$value" ]] || { echo "skipped"; return 0; }
  local result; if result="$($3 "$value")"; then echo "verified: $result"; else echo "$result"; echo "NOT written. Check the value and run again."; return 0; fi
  printf '%s\n' "$value" > "${TMPDIR:-/tmp}/.hawa_new_$1"   # owner-only scratch (umask 077), removed below
  CHANGED+=("$1")
}
ask TELEGRAM_BOT_TOKEN "Telegram bot token (BotFather -> /mybots -> your bot -> API Token -> Revoke current token)" verify_telegram
ask CANVA_CLIENT_SECRET "Canva client secret (canva.com/developers -> your integration -> Configuration -> Generate new secret)" verify_canva_secret
ask GEMINI_API_KEY "Gemini API key (aistudio.google.com/app/apikey -> Create API key)" verify_gemini
ask ANTHROPIC_API_KEY "Anthropic API key (console.anthropic.com -> API keys) — only if you also want to rotate it" verify_anthropic

if [[ ${#CHANGED[@]} -eq 0 ]]; then echo ""; echo "Nothing changed."; exit 0; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; KEEP="$HOME/Hawdesign-local-state-${STAMP}"; mkdir -p "$KEEP"; chmod 700 "$KEEP"
cp "$ENV_FILE" "$KEEP/env.production.before"
python3 - "$ENV_FILE" "${CHANGED[@]}" <<'PY'
import pathlib, sys, os
env = pathlib.Path(sys.argv[1]); keys = sys.argv[2:]
tmp = os.environ.get('TMPDIR', '/tmp')
new = {k: pathlib.Path(f"{tmp}/.hawa_new_{k}").read_text().rstrip('\n') for k in keys}
lines = env.read_text().split('\n'); seen = set(); out = []
for line in lines:
    k = line.split('=', 1)[0] if '=' in line and not line.startswith('#') else None
    if k in new:
        if k in seen: continue           # drop duplicate lines of a rotated key
        out.append(f"{k}={new[k]}"); seen.add(k)
    else: out.append(line)
for k in keys:
    if k not in seen: out.append(f"{k}={new[k]}")
env.write_text('\n'.join(out).rstrip('\n') + '\n')
print("written:", ", ".join(keys))
PY
for k in "${CHANGED[@]}"; do rm -f "${TMPDIR:-/tmp}/.hawa_new_$k"; done
chmod 600 "$ENV_FILE"
echo "previous file kept at $KEEP/env.production.before (owner-only)"
echo ""
echo "== redeploying so the running containers pick up the new values =="
bash "${SCRIPT_DIR}/deploy.sh" --apply
echo ""
echo "== post-rotation check =="
bash "${SCRIPT_DIR}/rotate_external_secrets.sh" --check
echo ""
echo "Done. If the Telegram line above says 'ok @<your bot>' and health is healthy, the old token and secrets are dead and the new ones are live."
