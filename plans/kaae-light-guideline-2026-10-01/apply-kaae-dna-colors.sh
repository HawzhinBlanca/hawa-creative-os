#!/usr/bin/env bash
# ADR-236: give KAAE's production Client DNA the brand guideline's palette, changing nothing else.
#
# KAAE's Studio designs read the packaged reference (packages/creative/assets/kaae-reference.json),
# not this DNA row; the row is what the Desk's DNA page and the DNA readers (rubric, search, the
# Canva planner for DNA-path clients) show. Run AFTER the release with ADR-236 is deployed.
#
# Dry run (default): reads the active DNA, writes before.json / payload.json and shows that only the
# colour fields differ. Nothing is sent. `--apply` then POSTs the new version (unapproved, which
# closes model reading) and re-records the owner's model consent on it (ADR-234), which approves it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="${CORE:-http://127.0.0.1:8080}"
CLIENT="c1000000-0000-4000-8000-000000000002"
OUT="${OUT:-$(mktemp -d)}"; mkdir -p "$OUT"
H=(-H 'Host: 127.0.0.1:8080' -H 'Origin: http://127.0.0.1:8080' -H 'X-Hawa-Office-Request: 1')

curl -fsS "${H[@]}" "$CORE/v1/clients/$CLIENT/dna" > "$OUT/before.json"
VERSION="$(jq -r '.version' "$OUT/before.json")"
# Only the colour fields change: `colors` (the ClientDNA shape the readers use) and, when the row
# carries the config shape too, `brand.colors`. Commit metadata is dropped (POST writes its own).
jq --slurpfile p "$HERE/kaae-dna-colors.json" --argjson v "$VERSION" '
  del(.__commitMessage, .__createdBy)
  | (if has("colors") then .colors = $p[0].colors else . end)
  | (if (.brand | type) == "object" and (.brand | has("colors")) then .brand.colors = $p[0].brandColors else . end)
  | .expectedVersion = $v
  | .commitMessage = "ADR-236: the brand guideline palette, light grounds first (owner, 2026-10-01)"
' "$OUT/before.json" > "$OUT/payload.json"

echo "active version: $VERSION   files: $OUT"
echo "fields that differ apart from colours, commit metadata and expectedVersion (must be empty):"
diff <(jq -S 'del(.colors, .brand.colors, .__commitMessage, .__createdBy, .expectedVersion, .commitMessage)' "$OUT/before.json") \
     <(jq -S 'del(.colors, .brand.colors, .__commitMessage, .__createdBy, .expectedVersion, .commitMessage)' "$OUT/payload.json") && echo "(none)"
echo "colours now: $(jq -c '[.colors[]?.hex]' "$OUT/payload.json")"

if [[ "${1:-}" != "--apply" ]]; then echo "dry run: nothing sent. Re-run with --apply."; exit 0; fi

curl -fsS -X POST "${H[@]}" -H 'Content-Type: application/json' --data-binary @"$OUT/payload.json" \
  "$CORE/v1/clients/$CLIENT/dna" > "$OUT/posted.json"
NEW="$(jq -r '.version' "$OUT/posted.json")"
echo "saved DNA version $NEW (unapproved: model reading is closed until the next step)"
curl -fsS -X POST "${H[@]}" -H 'Content-Type: application/json' \
  -d "{\"expectedVersion\":$NEW,\"mode\":\"approved_providers\",\"providers\":[\"openai\"],\"reason\":\"Re-approve model reading after the ADR-236 palette change (owner approved model reading for KAAE in chat on 2026-10-01)\"}" \
  "$CORE/v1/clients/$CLIENT/dna/model-consent" | tee "$OUT/consent.json"
echo
curl -fsS "${H[@]}" "$CORE/v1/clients/$CLIENT/dna/model-consent" | jq '{version, approved, modelReading}'
