#!/bin/bash
# Builds the photo inputs of the resvg gate with ImageMagick 7: one picture in every container and
# pixel format a client photo arrives in, EXIF orientations 1-8, a matted person and their shadow.
#
#   bash make_photos.sh <exemplar png> <out dir>
#
# The picture is a KAAE exemplar poster (real type, gradients and flat colour) with a red "F" in its
# top-left corner, so a turned or mirrored decode is visible and measurable.
set -euo pipefail
SRC="$1"
OUT="$2"
mkdir -p "$OUT"
cd "$OUT"

magick "$SRC" -resize 1800x1200^ -gravity center -extent 1800x1200 +repage \
  -fill '#E53935' -draw 'rectangle 40,40 400,120' -draw 'rectangle 40,40 128,560' -draw 'rectangle 40,260 300,330' \
  PNG24:base.png

# JPEG: baseline, progressive, CMYK (Adobe), greyscale, 4:4:4 chroma.
magick base.png -quality 88 -interlace none -sampling-factor 4:2:0 jpeg-baseline.jpg
magick base.png -quality 88 -interlace Plane jpeg-progressive.jpg
magick base.png -colorspace CMYK -quality 90 jpeg-cmyk.jpg
magick base.png -colorspace Gray -quality 88 jpeg-gray.jpg
magick base.png -quality 92 -sampling-factor 4:4:4 jpeg-444.jpg

# PNG: RGB, RGBA (alpha ramp), palette, 16-bit RGB, 16-bit RGBA, greyscale.
magick -size 1200x1800 gradient:white-'#303030' -rotate 90 alpha-ramp.png
magick base.png alpha-ramp.png -alpha off -compose CopyOpacity -composite PNG32:png-rgba.png
cp base.png png-rgb.png
magick base.png -colors 96 PNG8:png-palette.png
magick base.png -depth 16 PNG48:png-16bit.png
magick png-rgba.png -depth 16 PNG64:png-16bit-rgba.png
magick base.png -colorspace Gray -depth 8 PNG:png-gray.png

# WebP: lossy, lossless, lossy with alpha.
magick base.png -quality 80 webp-lossy.webp
magick base.png -define webp:lossless=true webp-lossless.webp
magick png-rgba.png -quality 80 webp-alpha.webp

# GIF: a still, and a two-frame animation (only the first frame is ever drawn).
magick base.png -colors 128 gif-still.gif
magick base.png \( base.png -negate \) -colors 128 -set delay 50 -loop 0 gif-anim.gif

# EXIF orientations 1-8: the pixels stored so that applying the tag gives the upright picture. The tag
# itself is written by cases.ts (ImageMagick writes no EXIF block for a picture that had none).
magick base.png -quality 88 exif-1-pixels.jpg
magick base.png -flop -quality 88 exif-2-pixels.jpg
magick base.png -rotate 180 -quality 88 exif-3-pixels.jpg
magick base.png -flip -quality 88 exif-4-pixels.jpg
magick base.png -transpose -quality 88 exif-5-pixels.jpg
magick base.png -rotate 270 -quality 88 exif-6-pixels.jpg
magick base.png -transverse -quality 88 exif-7-pixels.jpg
magick base.png -rotate 90 -quality 88 exif-8-pixels.jpg

# A large phone photo (12 MP) as a JPEG and as the PNG a redraw makes of it, which passes rsvg's
# 10,000,000-byte attribute limit as a data URI.
magick base.png -resize 4000x3000! -attenuate 0.4 +noise Gaussian -quality 85 large-12mp.jpg
magick large-12mp.jpg PNG24:large-12mp.png

# A matted person: head and shoulders with a soft (blurred) matte edge, textured from the picture,
# and a soft contact shadow. Synthetic, so it is reproducible and carries no one's likeness.
magick -size 1200x1800 xc:none -fill white \
  -draw 'ellipse 600,340 210,260 0,360' -draw 'roundrectangle 300,570 900,940 120,120' \
  -draw 'roundrectangle 140,760 1060,1800 180,180' -blur 0x5 person-matte.png
magick base.png -resize 1200x1800^ -gravity center -extent 1200x1800 +repage person-matte.png \
  -alpha off -compose CopyOpacity -composite PNG32:person.png
magick -size 1400x320 xc:none -fill 'rgba(0,0,0,0.55)' -draw 'ellipse 700,160 600,100 0,360' -blur 0x36 PNG32:person-shadow.png

ls -l
