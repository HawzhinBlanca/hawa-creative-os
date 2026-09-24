#!/bin/bash
# Diagnoses resvg's font fallback outside the gate: one Verdana line with Sorani in it and one Noto
# Sans Arabic line with Latin in it, rendered with different font sets, so the owner can see whether
# the missing glyphs (drawn as .notdef boxes) are a matter of configuration or of resvg itself.
#
#   bash fallback_probe.sh <resvg binary> <fonts dir> <out dir>
set -uo pipefail
R="$1"
F="$2"
OUT="$3"
mkdir -p "$OUT"
cat > "$OUT/t.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="900" height="200" fill="#fff"/><text x="20" y="80" font-family="Verdana" font-size="40" fill="#000">KAAE 2026 کوردستان</text><text x="20" y="160" font-family="Noto Sans Arabic" font-size="40" fill="#000">کوردستان Quality (K-12)</text></svg>
EOF
run() {
  local name="$1"
  shift
  echo "== $name"
  "$R" "$@" "$OUT/t.svg" "$OUT/$name.png" 2>&1 | sort | uniq -c
}
run verdana-then-noto --skip-system-fonts --use-font-file "$F/Verdana.ttf" --use-font-file "$F/NotoSansArabic-Regular.ttf"
run noto-then-verdana --skip-system-fonts --use-font-file "$F/NotoSansArabic-Regular.ttf" --use-font-file "$F/Verdana.ttf"
run fonts-dir --skip-system-fonts --use-fonts-dir "$F"
run dejavu-and-noto --skip-system-fonts --use-font-file "$F/DejaVuSans.ttf" --use-font-file "$F/NotoSansArabic-Regular.ttf"
