#!/bin/sh
# Rasterises render-layout-v2.ts's font probes with the production image's rsvg-convert and its
# fontconfig, and prints each PNG's hash: a family whose hash equals the sentinel's is substituted
# there. Run inside the measurement image with the work directory mounted at /work.
set -eu
export FONTCONFIG_FILE=/app/packages/creative/assets/fonts/fonts.conf
cd /work/probe
for f in *.svg; do
  rsvg-convert -f png -o "${f%.svg}.png" "$f"
done
sha256sum *.png
