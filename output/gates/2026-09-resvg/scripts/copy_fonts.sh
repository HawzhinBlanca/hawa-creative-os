#!/bin/sh
# Copies, out of the production image, every font file resvg is given with --use-font-file, so the
# container and the Mac read byte-identical fonts. Run inside the measurement image with the work
# directory mounted at /work.
set -eu
mkdir -p /work/fonts
cp /app/packages/creative/assets/fonts/*.ttf /work/fonts/
cp /usr/share/fonts/truetype/msttcorefonts/Verdana.ttf /usr/share/fonts/truetype/msttcorefonts/Verdana_Bold.ttf \
   /usr/share/fonts/truetype/msttcorefonts/Verdana_Italic.ttf /usr/share/fonts/truetype/msttcorefonts/Verdana_Bold_Italic.ttf \
   /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf /work/fonts/
# The same files as the image's own copies, checked by hash.
sha256sum /work/fonts/*.ttf
