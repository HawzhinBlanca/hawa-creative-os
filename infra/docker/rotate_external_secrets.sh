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
source "${ROOT_DIR}/infra/ops/release_lib.sh"
ACTIVE_ROOT="$(hawa_deployed_root "$ROOT_DIR")"
ENV_FILE="$(hawa_shared_dir)/infra/docker/.env.production"
if [[ "${HAWA_RELEASE_DIRS:-on}" == off ]]; then ENV_FILE="${SCRIPT_DIR}/.env.production"; fi
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE is missing"; exit 1; }
umask 077
CREDENTIAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/hawa-credential-update.XXXXXX")"
trap 'rm -rf "$CREDENTIAL_TMP"' EXIT

current() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
http() { curl -s -o /dev/null -w '%{http_code}' -m 20 "$@" || echo 000; }

verify_telegram() { # prints bot username on success
  local out; out="$(curl -s -m 20 "https://api.telegram.org/bot$1/getMe" || true)"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1] or "{}"); r=d.get("result") or {}; print("ok @"+r["username"]) if d.get("ok") and r.get("username") else (print("REJECTED: Telegram did not verify the token"), sys.exit(1))' "$out"
}
verify_openai() { local code; code="$(http https://api.openai.com/v1/models -H "Authorization: Bearer $1")"; [[ "$code" == "200" ]] && echo "ok (HTTP 200)" || { echo "REJECTED (HTTP $code)"; return 1; }; }
verify_gemini() { local code; code="$(http "https://generativelanguage.googleapis.com/v1beta/models?key=$1")"; [[ "$code" == "200" ]] && echo "ok (HTTP 200)" || { echo "REJECTED (HTTP $code)"; return 1; }; }
verify_anthropic() { local code; code="$(http https://api.anthropic.com/v1/models -H "x-api-key: $1" -H 'anthropic-version: 2023-06-01')"; [[ "$code" == "200" ]] && echo "ok (HTTP 200)" || { echo "REJECTED (HTTP $code)"; return 1; }; }
verify_canva_secret() { # Canva has no read-only credential check; a refresh with a bogus token answers invalid_grant when the secret is right, invalid_client when it is wrong
  local cid; cid="$(current CANVA_CLIENT_ID)"; [[ -n "$cid" ]] || { echo "REJECTED: CANVA_CLIENT_ID is not configured"; return 1; }
  local body; body="$(curl -s -m 20 -u "$cid:$1" -X POST https://api.canva.com/rest/v1/oauth/token -H 'Content-Type: application/x-www-form-urlencoded' -d 'grant_type=refresh_token&refresh_token=deliberately-invalid' || true)"
  if [[ "$body" == *invalid_grant* ]]; then echo "ok (Canva accepts this client secret)"; elif [[ "$body" == *invalid_client* ]]; then echo "REJECTED: Canva did not verify the client secret"; return 1; else echo "REJECTED: could not verify with Canva"; return 1; fi; }

if [[ "${1:-}" == "--check" ]]; then
  CHECK_FAILED=0
  check_provider() {
    local label="$1" key="$2" verifier="$3" value result
    value="$(current "$key")"
    if [[ -z "$value" ]]; then echo "$label: not configured"; return; fi
    if result="$($verifier "$value")"; then echo "$label: $result";
    else echo "$label: $result"; CHECK_FAILED=1; fi
  }
  check_provider "OpenAI key" OPENAI_API_KEY verify_openai
  check_provider "Telegram bot token" TELEGRAM_BOT_TOKEN verify_telegram
  check_provider "Anthropic key" ANTHROPIC_API_KEY verify_anthropic
  check_provider "Gemini key" GEMINI_API_KEY verify_gemini
  check_provider "Canva client secret" CANVA_CLIENT_SECRET verify_canva_secret
  exit "$CHECK_FAILED"
fi

declare -a CHANGED=()
ask() { # $1 key  $2 label  $3 verifier
  local value
  echo ""
  echo "== $2 =="
  read -rs -p "Paste the NEW value and press Enter (or just Enter to skip): " value; echo ""
  [[ -n "$value" ]] || { echo "skipped"; return 0; }
  local result; if result="$($3 "$value")"; then echo "verified: $result"; else echo "$result"; echo "NOT written. Check the value and run again."; return 0; fi
  printf '%s\n' "$value" > "${CREDENTIAL_TMP}/$1"   # owner-only scratch (umask 077), removed below
  CHANGED+=("$1")
}
ask OPENAI_API_KEY "OpenAI API key (platform.openai.com/api-keys)" verify_openai
ask TELEGRAM_BOT_TOKEN "Telegram bot token (BotFather -> /mybots -> your bot -> API Token -> Revoke current token)" verify_telegram
ask CANVA_CLIENT_SECRET "Canva client secret (canva.com/developers -> your integration -> Configuration -> Generate new secret)" verify_canva_secret
ask GEMINI_API_KEY "Gemini API key (aistudio.google.com/app/apikey -> Create API key)" verify_gemini
ask ANTHROPIC_API_KEY "Anthropic API key (console.anthropic.com -> API keys) — only if you also want to rotate it" verify_anthropic

if [[ ${#CHANGED[@]} -eq 0 ]]; then echo ""; echo "Nothing changed."; exit 0; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; KEEP="$HOME/Hawdesign-local-state-${STAMP}"; mkdir -p "$KEEP"; chmod 700 "$KEEP"
cp "$ENV_FILE" "$KEEP/env.production.before"
read -r -p "Reason for this credential update: " CHANGE_REASON
[[ -n "${CHANGE_REASON// /}" ]] || { echo "ERROR: a reason is required; no configuration changed"; exit 1; }
python3 "${ROOT_DIR}/infra/ops/update_provider_credentials.py" --env-file "$ENV_FILE" \
  --input-dir "$CREDENTIAL_TMP" --audit-dir "$(hawa_shared_dir)/infra/backup/release-receipts" \
  --reason "$CHANGE_REASON" --actor "$(id -un)" "${CHANGED[@]}"
chmod 600 "$ENV_FILE"
echo "previous file kept at $KEEP/env.production.before (owner-only)"
echo ""
echo "== redeploying so the running containers pick up the new values =="
bash "${ACTIVE_ROOT}/infra/docker/deploy.sh" --apply
echo ""
echo "== post-rotation check =="
bash "${ACTIVE_ROOT}/infra/docker/rotate_external_secrets.sh" --check
echo ""
echo "The new credential configuration passed verification and coordinated deployment. Retire the replaced credentials in their provider consoles as applicable."
