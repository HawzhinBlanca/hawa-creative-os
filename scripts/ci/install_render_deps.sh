#!/usr/bin/env bash
# System packages the test suite renders and measures with, on Debian/Ubuntu (CI runners, Linux
# dev boxes). The same set Dockerfile.core installs, so tests measure what production draws:
#   - librsvg2-bin (rsvg-convert) + webp-pixbuf-loader: every SVG -> PNG render, WebP photos included;
#   - ttf-mscorefonts-installer: Verdana, the client's Latin body face (render-fonts.json systemPaths).
#     It is licensed, so it is never committed; without it ~115 tests fail with FONT_UNRESOLVED;
#   - imagemagick: one test writes a PNG the way ImageMagick does by default;
#   - build-essential, pkg-config, libpango1.0-dev: `pnpm build:native` compiles the shared Pango
#     text-measurement helper (ADR-118), as Dockerfile.core does in its build stage;
#   - ffmpeg + libheif-examples (heif-convert): Core decodes every uploaded PNG/JPEG/WebP with ffmpeg
#     before admitting it (packages/creative/src/uploaded-asset-inspection.ts), turns voice notes into
#     Ogg Opus and HEIC photos into JPEG (apps/core/src/services/media-conversion.ts). Without them the
#     upload tests answer 422 and the media tests skip (ADR-281). Ubuntu 24.04's libheif 1.17 loads its
#     HEVC decoder as a plugin that is only a Recommends, so it is named explicitly where it exists
#     (Debian bookworm's libheif links libde265 directly and has no such package).
# On macOS none of this is needed: Verdana ships with the system and rsvg comes from Homebrew.
set -euo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

echo 'ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true' | $SUDO debconf-set-selections
$SUDO apt-get update -qq
HEIF_PLUGIN=""
if apt-cache show libheif-plugin-libde265 >/dev/null 2>&1; then HEIF_PLUGIN="libheif-plugin-libde265"; fi

# The fonts installer downloads from SourceForge mirrors, which fail now and then: retry it.
for attempt in 1 2 3; do
  if DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq --no-install-recommends \
      librsvg2-bin webp-pixbuf-loader imagemagick fontconfig cabextract ttf-mscorefonts-installer \
      build-essential pkg-config libpango1.0-dev \
      ffmpeg libheif-examples $HEIF_PLUGIN \
    && [ -f /usr/share/fonts/truetype/msttcorefonts/Verdana.ttf ]; then
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "Verdana is still missing after 3 attempts (SourceForge unreachable?)" >&2
    exit 1
  fi
  echo "fonts install attempt $attempt failed; retrying" >&2
  $SUDO dpkg-reconfigure -f noninteractive ttf-mscorefonts-installer || true
  sleep $((attempt * 10))
done

rsvg-convert --version
ffmpeg -hide_banner -version | sed -n 1p
heif-convert --version | sed -n 1p
ls /usr/share/fonts/truetype/msttcorefonts/ | grep -i verdana
