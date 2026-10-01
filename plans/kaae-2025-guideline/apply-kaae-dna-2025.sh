#!/usr/bin/env bash
# ADR-238: bring KAAE's production Client DNA to the 2025 guideline ("Brand Guidelines — Excellence
# Edition", KAAE_Guidelines4.pdf), and take every value of the withdrawn older brand book out of it.
#
# KAAE's Studio designs read the packaged reference (packages/creative/assets/kaae-reference.json),
# not this DNA row; the row is what the Desk's DNA page and the DNA readers (rubric, search, the Canva
# planner for DNA-path clients) show. Run it AFTER the release with ADR-238 is deployed: before it,
# the deployed reader refuses a primary logo minimum under 100px, and the 2025 rule is 80px.
#
# What changes (from kaae-dna-2025.json, generated from the DNA fixture and config/clients/kaae.dna.json):
#   colors, fonts, guidelines.layoutRules; the logo assets' minimumWidthPx, allowedBackgrounds and
#   prohibitedModifications (by role; asset ids, hashes and storage keys are kept); brand.colors,
#   brand.fonts and brand.layoutRules when the row carries the config shape; every other string with a
#   withdrawn colour mapped to its 2025 colour; and canvaMapping.canvaBrandKitId when
#   CANVA_BRAND_KIT_ID names a new 2025 brand kit (the kit itself is changed in Canva, by hand).
#
# Dry run (default): reads the active DNA, writes before.json / payload.json, prints every field that
# changes and every withdrawn word that is still left (which must be none). Nothing is sent.
# `--apply` then POSTs the new version (unapproved, which closes model reading) and re-records the
# owner's model consent on it (ADR-234), which approves it. `--apply` refuses while anything withdrawn
# is left.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="${CORE:-http://127.0.0.1:8080}"
CLIENT="c1000000-0000-4000-8000-000000000002"
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
H=(-H 'Host: 127.0.0.1:8080' -H 'Origin: http://127.0.0.1:8080' -H 'X-Hawa-Office-Request: 1')
WITHDRAWN_WORDS='Minion|BRAND GUIDLINES|brand book|indigo|Cinzel|Playfair Display|Verdana|Cairo|Noto Naskh Arabic'

curl -fsS "${H[@]}" "$CORE/v1/clients/$CLIENT/dna" > "$OUT/before.json"
VERSION="$(jq -r '.version' "$OUT/before.json")"

jq --slurpfile p "$HERE/kaae-dna-2025.json" --argjson v "$VERSION" --arg kit "${CANVA_BRAND_KIT_ID:-}" '
  def remap:
    gsub("#17087[Aa]"; "#1E3A5F") | gsub("#16087[4]"; "#0A1628") | gsub("#002050"; "#1E3A5F")
    | gsub("#3833[Aa]3"; "#2C5282") | gsub("#35309[Bb]"; "#2C5282") | gsub("#0[Ff]73[Dd][Ee]"; "#4A90E2")
    | gsub("#[Ee]8[Bb]85[Cc]"; "#F7B500") | gsub("#[Cc]5[Aa]059"; "#F7B500") | gsub("#[Dd]4[Aa]94[Cc]"; "#F7B500")
    | gsub("#[Ff][Ff][Dd]15[Cc]"; "#FFD700") | gsub("#[Ff][Ff][Ff]2[Dd][Bb]"; "#FDF8F3") | gsub("#2[Dd]4[Aa]73"; "#1E3A5F")
    | gsub("#1[Aa]1[Aa]1[Aa]"; "#0A1628");
  $p[0] as $n
  | del(.__commitMessage, .__createdBy)
  | walk(if type == "string" then remap else . end)
  | (if has("colors") then .colors = $n.colors else . end)
  | (if has("fonts") then .fonts = $n.fonts else . end)
  | (if (.guidelines | type) == "object" then .guidelines.layoutRules = $n.layoutRules else . end)
  | (if (.assets | type) == "array" then .assets |= map(if (.role == "logo_primary" or .role == "logo_symbol") then . + $n.logoRules[.role] else . end) else . end)
  | (if (.brand | type) == "object" then
       (if (.brand | has("colors")) then .brand.colors = $n.brandColors else . end)
       | (if (.brand | has("fonts")) and $n.brandFonts != null then .brand.fonts = $n.brandFonts else . end)
       | (if (.brand | has("layoutRules")) and $n.brandLayoutRules != null then .brand.layoutRules = $n.brandLayoutRules else . end)
     else . end)
  | (if $kit != "" and (.canvaMapping | type) == "object" then .canvaMapping.canvaBrandKitId = $kit else . end)
  | .expectedVersion = $v
  | .commitMessage = "ADR-238: KAAE Brand Guidelines, Excellence Edition (2025): palette, fonts, logo rules and layout rules; the older brand book withdrawn (owner, 2026-10-01)"
' "$OUT/before.json" > "$OUT/payload.json"

echo "active version: $VERSION   files: $OUT"
echo "fields that change (paths):"
jq -n --slurpfile a "$OUT/before.json" --slurpfile b "$OUT/payload.json" '
  ($a[0] | del(.__commitMessage, .__createdBy)) as $x | ($b[0] | del(.expectedVersion, .commitMessage)) as $y
  | [($x, $y) | paths(scalars)] | unique | map(. as $q | select(($x | getpath($q)) != ($y | getpath($q)))) | map(map(tostring) | join(".")) | .[]' -r \
  | sed -E 's/\.[0-9]+(\.|$)/[]\1/g' | sort -u | sed 's/^/  /'
echo "colours now: $(jq -c '[.colors[]?.hex]' "$OUT/payload.json")"
echo "fonts now:   $(jq -c '[.fonts[]? | "\(.family) \(.style) (\(.role))"]' "$OUT/payload.json")"

LEFT="$(jq -r --arg re "$WITHDRAWN_WORDS" '
  [paths(scalars) as $q | {p: ($q | map(tostring) | join(".")), v: (getpath($q) | tostring)}]
  | map(select(.p != "commitMessage" and (.v | test($re; "i"))))
  | .[] | "  \(.p): \(.v | .[0:120])"' "$OUT/payload.json")"
if [[ -n "$LEFT" ]]; then
  echo "withdrawn brand-book text still in the row (edit these by hand in payload.json, or in the Desk, before --apply):"
  echo "$LEFT"
else
  echo "withdrawn brand-book text left: (none)"
fi

if [[ "${1:-}" != "--apply" ]]; then echo "dry run: nothing sent. Re-run with --apply."; exit 0; fi
if [[ -n "$LEFT" && "${ALLOW_LEFT:-}" != "1" ]]; then echo "refusing --apply while withdrawn text is left (ALLOW_LEFT=1 overrides after review)"; exit 2; fi

curl -fsS -X POST "${H[@]}" -H 'Content-Type: application/json' --data-binary @"$OUT/payload.json" \
  "$CORE/v1/clients/$CLIENT/dna" > "$OUT/posted.json"
NEW="$(jq -r '.version' "$OUT/posted.json")"
echo "saved DNA version $NEW (unapproved: model reading is closed until the next step)"
curl -fsS -X POST "${H[@]}" -H 'Content-Type: application/json' \
  -d "{\"expectedVersion\":$NEW,\"mode\":\"approved_providers\",\"providers\":[\"openai\"],\"reason\":\"Re-approve model reading after the ADR-238 2025 guideline update (owner approved model reading for KAAE in chat on 2026-10-01)\"}" \
  "$CORE/v1/clients/$CLIENT/dna/model-consent" | tee "$OUT/consent.json"
echo
curl -fsS "${H[@]}" "$CORE/v1/clients/$CLIENT/dna/model-consent" | jq '{version, approved, modelReading}'
