# resvg gate: resvg 0.48.1 against rsvg-convert 2.54.7 (ADR-036 section 2.3)

**Date:** 2026-09-24. **Item:** architecture programme Phase 3.3 (PLAN.md 3.3). **Scope:** measurement
only. The renderer the product uses is unchanged.

**Verdict: NO-GO.** Four of the seven measured criteria fail (C1 to C4). resvg is deterministic,
never crashed, is faster at p95 overall and uses less memory. But with the product's fonts it draws
`.notdef` boxes for every mixed-script line. It also decodes a CMYK JPEG with wrong colours without a
warning, shrinks the logo visibly worse, and draws the cut-out outlines and glows 2 to 10 device px
wider. No font setup tried fixes the first of these (section 5). Criterion C8, the human sign-off,
is left open for the owner.

## 1. Verdict per criterion

| # | ADR-036 2.3 criterion | Measured | Verdict |
|---|---|---|---|
| C1 | No crash, silent blank, decode or font warning | 0 crashes, 0 silent blanks, 0 decode warnings; **108 of 383 canvases with font warnings**, every one with at least one missing-character warning; a CMYK JPEG decoded with wrong colours and no warning | **NO-GO** |
| C2 | Every text line within 1 px (Latin) or 2 px (Arabic), no word-order change | 1,613 of 1,777 lines within tolerance; **24 Latin and 140 Arabic-script lines outside**; **137 lines flagged for word order** | **NO-GO** |
| C3 | Every treatment within tolerance | Photo bakes 10 of 10 within; **cut-out treatment bakes 4 of 32 within** (outlines 2-10 px wider, glows 4-10 px, one at 87 px) | **NO-GO** (re-measure after 3.2) |
| C4 | Median canvas SSIM >= 0.99, minimum >= 0.97 | Median **0.9983** (met); minimum **0.8835** (0.9165 without the Cairo rows); 17 canvases below 0.97 (14 without Cairo) | **NO-GO** |
| C5 | Byte-identical across repeats and between Mac and container | resvg repeats 383 of 383 identical; Mac build against container 386 of 386 identical | GO |
| C6 | p95 time no worse than rsvg's, nothing over 5 s | Gate set p95 resvg **321.2 ms** against rsvg **373.4 ms**; slowest resvg render 1,772.4 ms. Per class, resvg's p95 is worse for stored designs (158.3 against 86.9 ms) and for text | GO as written (see 4.6) |
| C7 | Peak memory <= 1.5x | Per canvas, resvg/rsvg peak RSS: median 0.61, maximum 1.26; highest peak 161,280 KB against rsvg's 193,596 KB | GO |
| C8 | A person signs off the lowest-scoring pairs and the Kurdish sheet | `lowest-ssim/` (30 pairs) and `kurdish-sheet/` (21 canvases) are ready | **OPEN (owner)** |
| - | Today's markup against renderer-neutral markup through rsvg | Not measured here: Phase 0.5 already replaced the old markup; see section 6 | Covered by Phase 0.5 |

A GO needs every criterion. C1 to C4 fail, so the gate is NO-GO whatever C8 says.

## 2. Method

### 2.1 The measurement image

`Dockerfile` builds resvg 0.48.1 from crates.io source in a `rust:1-bookworm` stage
(`cargo install resvg --version 0.48.1 --locked -j 4`, then `strip`) and copies the binary into an
image `FROM hawa-core:canva-only-20260913`, the production core image, which carries
rsvg-convert 2.54.7 and the production fonts. The only other addition is GNU `time`, for peak RSS.
The image is `hawa-resvg-gate:0.48.1`; it is not a product image.

- Build: cargo compiled 63 crates in 18.7 s (`Finished release ... in 18.74s`); the whole
  `docker build` took 45.6 s wall, most of the rest pulling `rust:1-bookworm`.
- Binary: 4,133,672 bytes stripped (`/usr/local/bin/resvg` in the image), linux/arm64.
- A second build on the Mac host (`cargo install`, 24.5 s wall) gives the host-against-container
  comparison of C5; that binary is 4,520,400 bytes, unstripped.

### 2.2 Inputs (386 canvases, 1,777 single lines, 174 controls)

`scripts/cases.ts` builds every input with the repository's own code: `renderLayoutV2ToSvg` (the
renderer-neutral markup of Phase 0.5) and the treatment code in `photo-treatments.ts`. Each SVG is
built once and both rasterisers read the same bytes. The font family on each text element is set to
what the production image's own font probe decides (`probe_fonts.sh`, run in the image), because the
Mac's rsvg 2.62 would substitute Cinzel, Playfair Display and Cairo.

| Class | Canvases | What |
|---|---:|---|
| stored | 201 | 67 stored designs from `output/proofs` (42 cheap-tier runs, 10 production-tier, 9 committed fixtures, 6 dev runs), each re-prepared in the three production modes (plain, ornament, style reference `k12-89c242f2`). 25 designs (75 canvases) carry Sorani copy |
| photo | 42 | One picture in JPEG baseline, progressive, 4:4:4, greyscale and CMYK; PNG RGB, RGBA, palette, greyscale, 16-bit and 16-bit RGBA; WebP lossy, lossless and alpha; GIF still and animated; each framed and with arch + fade + duotone. The baseline JPEG also goes through circle, arch, four fades, black and white, tint, focus zoom and circle + fade + black and white |
| exif-raw | 8 | JPEGs tagged with EXIF orientation 1-8, handed to the rasteriser directly |
| exif-upright | 8 | The same JPEGs through `photo-upright.ts`, the product path |
| cutout | 26 | Cut-out people at 1x: outlines 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20 and 24 px; glows 2, 8, 16, 30 and 60 px; outline + glow; fade; duotone; plain shadow; two overlapping; off canvas left, top and right |
| bake | 42 | The treatments as the deck bakes them, the fragment alone at 2x: 32 cut-out fragments and 10 photo fragments |
| kurdish | 21 | A Sorani text matrix: Noto Sans Arabic, IBM Plex Sans Arabic and Amiri (regular and bold) and Cairo (regular), each right, centre and left, with Latin, digits and punctuation |
| latin | 24 | The Latin faces (Verdana in four styles, Cinzel in two, Playfair Display in two) in the same three alignments, with digits, punctuation and one Sorani line each |
| logo | 6 | The logo pre-scale: the 2,687 px KAAE PNG fitted into boxes of 80 to 200 px |
| motif | 5 | The procedural motif SVGs |
| stress | 3 | A 12 MP photo as a JPEG data URI, a PNG data URI and a PNG file |

`analyse.ts` keeps the 3 stress canvases out of the gate set as limit probes (383 gate canvases).
Section 4 gives the numbers both ways where they differ. Every text line of every canvas is also
rendered alone (1,777 lines: 1,127 Latin, 650 Arabic-script). And 174 Sorani lines are rendered by
rsvg a second time with their words reversed, as controls for the word-order detector.

### 2.3 Renders

`scripts/render.mjs` runs inside the image, one process at a time, with the two renderers
interleaved so they see the same load:

- **rsvg (baseline):** as production calls it in `svgToPngAsync`: `rsvg-convert -w -h -f png`, with
  `FONTCONFIG_FILE` set to the bundled `fonts.conf`.
- **resvg:** `--skip-system-fonts`, the 22 font files with `--use-font-file` in a fixed order (the
  families of `render-fonts.json` in file order, then Inter and DejaVu Sans), `--resources-dir` set to
  the SVG's own folder, `-w -h`.

Every canvas is rendered twice by each renderer under `/usr/bin/time -v`, which gives wall time and
peak RSS per render; lines and controls are rendered once. The machine is the Mac that also runs
production, so the times carry its load. Both renderers carry the same load.

### 2.4 Measures

- **Crash, blank, warning:** exit status, signal, timeout and a missing PNG count as a crash. A
  silent blank is a resvg canvas with less than half of rsvg's non-background content. Warnings are
  resvg's stderr, sorted into font, decode and other.
- **Canvas SSIM:** a 7 x 7 window SSIM on luma, written for this gate (`image-metrics.ts`, no new
  dependency). It is taken on the canvas composited over black and over white, and the lower of the
  two counts. `selftest.ts` checks it and the other measures against cases with known answers.
- **Lines:** the ink box (alpha >= 128) of each line rendered alone, compared edge by edge. Word
  order is the correlation of the two column-ink profiles, allowing a shift of up to 6 px; a line
  is flagged below 0.8. **That threshold was set after looking at the first run:** the 174
  reversed-word controls score at most 0.674 (median 0.375), and all 174 are flagged. Lines with no
  resvg warning score at least 0.886. The count at 0.9, the value tried first, is reported too (166
  lines).
- **Treatments:** for each bake, the ink-box delta (alpha >= 128) and the ratio of inked pixels,
  resvg over rsvg. ADR-036 gives no number for a treatment. This report counts a bake as within
  tolerance at a box delta of at most 2 px and a coverage ratio within 5 %.
- **Determinism:** SHA-256 of each PNG across the two repeats, and of the container's resvg PNG
  against the Mac build's.
- **Time and memory:** nearest-rank p50 and p95 of wall time over every timed render; peak RSS from
  `time -v`.

## 3. Numbers per class

SSIM, warnings and failures per canvas class (`summary.json` `perClass`):

| Class | Canvases | resvg crashes | resvg warned | SSIM median | SSIM min | < 0.99 | < 0.97 |
|---|---:|---:|---:|---:|---:|---:|---:|
| stored | 201 | 0 | 75 | 0.9986 | 0.9740 | 17 | 0 |
| photo | 42 | 0 | 0 | 0.9993 | 0.9170 | 2 | 2 |
| exif-raw | 8 | 0 | 0 | 0.9992 | 0.9992 | 0 | 0 |
| exif-upright | 8 | 0 | 0 | 0.9994 | 0.9994 | 0 | 0 |
| cutout | 26 | 0 | 0 | 0.9927 | 0.9859 | 7 | 0 |
| bake | 42 | 0 | 0 | 0.9906 | 0.9728 | 18 | 0 |
| kurdish | 21 | 0 | 9 | 0.9955 | 0.8835 | 9 | 9 |
| latin | 24 | 0 | 24 | 0.9879 | 0.9856 | 13 | 0 |
| logo | 6 | 0 | 0 | 0.9336 | 0.9165 | 6 | 6 |
| motif | 5 | 0 | 0 | 0.9997 | 0.9978 | 0 | 0 |
| stress (outside the gate set) | 3 | 0 (rsvg: 1) | 0 | 0.9503 | 0.9503 | 2 | 2 |

Time (ms) and peak memory per class, both renderers:

| Class | rsvg p50 | rsvg p95 | resvg p50 | resvg p95 | rsvg peak RSS (KB) | resvg peak RSS (KB) |
|---|---:|---:|---:|---:|---:|---:|
| stored | 51.4 | 86.9 | 79.1 | 158.3 | 64,756 | 52,728 |
| photo | 72.8 | 108.9 | 73.4 | 89.3 | 46,212 | 34,688 |
| exif-raw | 67.8 | 77.3 | 66.0 | 77.2 | 35,500 | 21,116 |
| exif-upright | 111.1 | 116.8 | 122.2 | 135.6 | 32,068 | 22,628 |
| cutout | 150.2 | 372.0 | 94.6 | 221.4 | 118,228 | 51,424 |
| bake | 285.9 | 1,299.2 | 247.0 | 1,166.2 | 193,596 | 161,280 |
| kurdish | 44.8 | 51.3 | 74.0 | 101.7 | 25,312 | 17,024 |
| latin | 42.4 | 46.1 | 48.7 | 59.2 | 25,268 | 16,996 |
| logo | 83.6 | 89.9 | 27.7 | 29.7 | 72,776 | 33,456 |
| motif | 43.8 | 81.1 | 54.5 | 74.8 | 26,656 | 33,472 |
| stress | 279.9 | 421.7 | 303.7 | 360.4 | 118,004 | 129,080 |

Lines (`summary.json` `lineSummary`):

| Set | Lines | Within tolerance | Outside | Max delta p95 (px) | Max delta max (px) | Word order flagged (at 0.8 / at 0.9) | resvg warned |
|---|---:|---:|---:|---:|---:|---:|---:|
| All | 1,777 | 1,613 | 164 | 11 | 272 | 137 / 166 | 161 |
| Latin | 1,127 | 1,103 | 24 | 1 | 17 | 0 / 8 | 0 |
| Arabic-script | 650 | 510 | 140 | 39 | 272 | 137 / 158 | 161 |
| Arabic-script, no resvg warning | 489 | 489 | 0 | 1 | 1 | 0 / 0 | 0 |
| Stored, Arabic-script | 422 | 359 | 63 | 15 | 44 | 65 / 83 | 83 |
| Kurdish matrix | 204 | 151 | 53 | 32 | 62 | 48 / 51 | 54 |

## 4. Findings per criterion

### 4.1 C1: warnings, crashes, blanks

- **No crash, no silent blank.** resvg exited 0 and wrote a PNG for all 386 canvases, stress
  included. rsvg failed one stress canvas: the 22.7 MB PNG data URI is over librsvg's
  10,000,000-byte attribute limit (the production bug of 2026-09-24).
- **Font warnings on 108 of 383 gate canvases.** These are all 75 stored canvases with Sorani copy,
  9 of the 21 Kurdish matrix canvases (the Noto Sans Arabic and Cairo rows) and all 24 Latin matrix
  canvases (through their Sorani line).
- **Exact count: 1,246 "No fonts with a X character were found" warnings.** A re-run of exactly
  those 108 canvases with stderr kept whole (`scripts/recount.mjs`, `warning-recount.json`) gives
  that number, and every one of the 108 canvases has at least one such warning. Each re-render was
  byte-identical to the gate run's PNG.
- The gate run itself kept only the first 2,000 characters of stderr per render, which cut 9
  canvases short. So the catalogue in `summary.json` (1,174 such warnings, plus 9 cut-off lines) is
  a lower bound: **at least** 1,174. `render.mjs` now keeps stderr whole.
- The cause is resvg's fallback, not a missing file. Latin in a Noto Sans Arabic run, or Sorani in
  a Verdana run, gets a "Fallback from ... to ..." warning. Then every such character gets the
  missing-character warning and is drawn as a `.notdef` box (`samples/resvg-fallback-probe.png`,
  section 5).
- **No decode warning, but a silent wrong decode.** resvg draws the CMYK JPEG with wrong colours
  (`samples/cmyk-jpeg-source-rsvg-resvg.png`: source, rsvg, resvg). SSIM is 0.9170 framed and 0.9571
  with arch, fade and duotone. resvg prints nothing, which is the silent failure the criterion is
  there to catch.
- **EXIF: both renderers treat the tag the same way.** Against orientation 1, rsvg scores 0.887 to
  0.774 for tags 2-8 and resvg 0.885 to 0.773, so neither turns the picture by itself. Through
  `photo-upright.ts` (the product path), all 8 match at SSIM 0.9994 or better.

### 4.2 C2: text lines

- **Where resvg has a glyph for every character, Arabic-script lines match.** All 489 such lines are
  within 1 px, and none is flagged for word order (lowest profile correlation 0.9896).
- **140 Arabic-script lines are outside 2 px, every one on a line with a resvg font warning.** 123
  of them carry a missing-character warning. The other 17 are Cairo lines of the Kurdish matrix
  whose only warning is "Fallback from Cairo to Noto Sans Arabic": drawn, but in the other face. The
  worst is 272 px, a Verdana line with Sorani in it.
- **137 lines are flagged for word order, all Arabic-script and all on lines with a resvg font
  warning** (122 with a missing-character warning). The profile detector cannot tell a reordered
  line from one whose glyphs became boxes, so these are not proven reorderings. What the data does
  show is that it flagged nothing where resvg drew every glyph.
- **24 Latin lines are outside 1 px, none with a warning.** 20 are off by exactly 2 px: Cinzel and
  Playfair Display in the Latin matrix, and single words such as "Accreditation" and "Certification"
  in stored designs. The other 4 are the "(K-12)" run inside a right-to-left embedding in Amiri, 15
  and 17 px off, where resvg draws the mirrored parentheses taller
  (`samples/amiri-k12-rtl-parentheses-rsvg-top-resvg-bottom.png`).
- `flagged-lines/` shows the 60 worst flagged lines, rsvg above resvg, indexed in `index.json`.

### 4.3 C3: treatments

**C3 must be measured again after Phase 3.2.** It was measured on today's treatment code, which
still draws outlines with `feMorphology` and glows as SVG filters (`photo-treatments.ts`, lines
389-419), because Phase 3.2 (outlines and glows as rasters) has not landed. ADR-036 section 1
already records that resvg's `feMorphology` window is lopsided. After 3.2, both renderers only
composite a PNG.

- **Photo bakes** (masks, fades, black and white, tint, duotone): 10 of 10 within tolerance, box
  delta 0 px, coverage 0.9998 to 1.0006.
- **Cut-out outline bakes at 2x:** every one is wider in resvg. The box delta is 2 px for outlines
  1-5, 4 px for 6-10, 6 px for 12, 8 px for 16 and 20, and 10 px for 24. The coverage ratio is 1.08
  to 1.41.
- **Cut-out glow bakes fail too:**

  | Glow bake | Box delta (px) | Coverage ratio |
  |---|---:|---:|
  | glow 2 | 0 | 1.009 (within tolerance) |
  | glow 8 | 5 | 0.940 |
  | glow 16 | 87 | 1.000 |
  | glow 30 | 5 | 1.068 |
  | glow 60 | 6 | 1.035 |
  | outline 12 + glow 30 (glow layer) | 6 | 1.094 |
  | outline 24 + glow 60 (glow layer) | 10 | 1.075 |
  | overlapping pair (glow layer) | 4 | 1.097 |
  | off canvas top (glow layer) | 8 | 1.099 |

  The glow 16 box is fragile: only 1,929 of its pixels reach the 50 % alpha threshold. At a
  threshold of 8/255, its two boxes agree within 2 px, but resvg inks 6.5 % more pixels.
- **Within tolerance: 4 of 32 cut-out bakes.** These are glow 2, the off-canvas-right outline, and
  the person layers of the fade and duotone bakes, which carry no outline.
- At 1x (the `cutout` class), the SSIM is 0.9859 to 0.9998, with none below 0.97.

### 4.4 C4: canvas SSIM

- **Gate set (383 canvases):** median **0.9983**, minimum **0.8835**; 72 are below 0.99 and 17
  below 0.97.
- **The three lowest are the Cairo rows of the Kurdish matrix** (0.8835, 0.8891, 0.9011), and they
  cannot occur in production. `render-fonts.json` records that Cairo has no glyph for the five
  Sorani letters ڕ ڵ ۆ ێ ە. `admittedFontFaces` offers a family for a script only when its file draws
  every required character, so Cairo is never offered for Sorani copy.
- **Without the Cairo rows, the gate still fails.** The minimum is **0.9165** (the logo pre-scale at
  80 px), followed by the CMYK JPEG at 0.9170, and **14 canvases are below 0.97**: 6 logo
  pre-scales, 2 CMYK photos and 6 Noto Sans Arabic rows of the Kurdish matrix.
- **The logo pre-scale scores 0.9165 to 0.9550 at every size.** resvg shrinks the 2,687 px PNG with
  visibly coarser sampling, so the rays and the ring lettering break up
  (`samples/logo-prescale-120-rsvg-left-resvg-right-x4.png`). Phase 0.5 pre-scales the logo once
  with the rasteriser, so this would be the logo on every design.

The 30 lowest-SSIM pairs are in `lowest-ssim/`, numbered by rank. Each file shows rsvg, resvg and a
difference map side by side:

| Rank | Canvas | SSIM | resvg warned |
|---:|---|---:|---|
| 1 | kurdish-Cairo-regular-right | 0.8835 | yes |
| 2 | kurdish-Cairo-regular-center | 0.8891 | yes |
| 3 | kurdish-Cairo-regular-left | 0.9011 | yes |
| 4 | logo-prescale-80 | 0.9165 | |
| 5 | photo-jpeg-cmyk-jpg-framed | 0.9170 | |
| 6 | logo-prescale-100 | 0.9236 | |
| 7 | logo-prescale-130 | 0.9336 | |
| 8 | logo-prescale-120 | 0.9347 | |
| 9 | logo-prescale-160 | 0.9409 | |
| 10 | kurdish-Noto-Sans-Arabic-bold-center | 0.9423 | yes |
| 11 | kurdish-Noto-Sans-Arabic-regular-center | 0.9476 | yes |
| 12 | stress-12mp-jpeg-datauri (outside the gate set) | 0.9503 | |
| 13 | stress-12mp-png-file (outside the gate set) | 0.9503 | |
| 14 | logo-prescale-200 | 0.9550 | |
| 15 | photo-jpeg-cmyk-jpg-arch-fade-duotone | 0.9571 | |
| 16 | kurdish-Noto-Sans-Arabic-bold-left | 0.9608 | yes |
| 17 | kurdish-Noto-Sans-Arabic-bold-right | 0.9633 | yes |
| 18 | kurdish-Noto-Sans-Arabic-regular-left | 0.9642 | yes |
| 19 | kurdish-Noto-Sans-Arabic-regular-right | 0.9661 | yes |
| 20 | bake-offcanvas-left-cutout-outline-0-x2 | 0.9728 | |
| 21 | stored-fixture-reference-ckb-2-style-k12-89c242f2 | 0.9740 | yes |
| 22 | stored-fixture-reference-ckb-1-style-k12-89c242f2 | 0.9784 | yes |
| 23 | bake-outline-24-glow-60-cutout-outline-0-x2 | 0.9820 | |
| 24 | bake-outline-24-cutout-outline-0-x2 | 0.9822 | |
| 25 | stored-fixture-reference-ckb-0-style-k12-89c242f2 | 0.9828 | yes |
| 26 | stored-fixture-cheap-tier-dead-band-8fb76534-style-k12-89c242f2 | 0.9828 | yes |
| 27 | bake-outline-16-cutout-outline-0-x2 | 0.9831 | |
| 28 | bake-offcanvas-top-cutout-outline-0-x2 | 0.9831 | |
| 29 | bake-outline-20-cutout-outline-0-x2 | 0.9837 | |
| 30 | bake-outline-24-glow-60-cutout-glow-0-x2 | 0.9840 | |

### 4.5 C5: determinism

- resvg: 383 of 383 gate canvases byte-identical across the two repeats. rsvg: also 383 of 383.
- The Mac host build of resvg, with the same font files, against the container: 386 of 386 canvases
  byte-identical. resvg does not depend on the host the way rsvg does (ADR-036 section 1: the Mac's
  rsvg draws a different Noto Sans Arabic).

### 4.6 C6: time

- **Gate set (383 canvases, 766 timed renders per renderer):** rsvg p50 55.4 ms, p95
  **373.4 ms**; resvg p50 78.3 ms, p95 **321.2 ms**. The slowest render was rsvg 1,970.7 ms and
  resvg 1,772.4 ms, both a 2x bake. Nothing took over 5 s.
- **Including the 3 stress canvases** (`summary.json` `overall.msRsvg` and `overall.msResvg`): rsvg
  p95 408.8 ms, resvg p95 347.8 ms. The verdict does not change.
- **The overall p95 favours resvg only because the heavy cut-out bakes and filters are faster in
  it.** For the renders that dominate production, the stored designs, resvg's p95 is 158.3 ms
  against 86.9 ms, and its p50 79.1 against 51.4 ms. Text-only canvases are slower too: Kurdish p95
  101.7 against 51.3 ms. The criterion as written is met; the owner may want it applied per class.

### 4.7 C7: memory

- Per canvas, resvg's peak RSS over rsvg's has a median of 0.61 and a maximum of 1.26, so it is
  under the 1.5x limit everywhere. The highest peaks are the 2x bakes: resvg 161,280 KB, rsvg
  193,596 KB.

## 5. Font fallback: no tested setup draws both lines

`scripts/fallback_probe.ts` renders two lines, each alone and then together, with five resvg font
setups:

- Verdana with Sorani in it: "KAAE 2026 کوردستان".
- Noto Sans Arabic with Latin in it: "کوردستان Quality (K-12)".

It then compares each line's ink box with rsvg-convert's in the gate image. The results are in
`samples/fallback-probe.json`. `samples/resvg-fallback-probe.png` shows rsvg's reference first, then
one panel per setup, in the order of this table:

| Setup | Verdana + Sorani line | Noto Sans Arabic + Latin line |
|---|---|---|
| Verdana then Noto Sans Arabic (`--use-font-file`) | 8 `.notdef` boxes, box 167 px off | 10 `.notdef` boxes, box 63 px off |
| Noto Sans Arabic then Verdana | 8 boxes, 167 px off | 10 boxes, 63 px off |
| `--use-fonts-dir` (the same 22 files) | no box, but the whole line in Amiri, 37 px off | no box, but the whole line in Amiri, 10 px off |
| DejaVu Sans and Noto Sans Arabic | **not drawn at all**: only "No match for Verdana", no ink | drawn in DejaVu Sans with Noto's Arabic, 42 px off |
| All 22 gate fonts in the gate's order | 8 boxes, 167 px off | 10 boxes, 63 px off |

**No tested font setup draws both lines correctly.** In particular, DejaVu Sans plus Noto Sans Arabic
does not work: resvg drops the whole Verdana line and says only that it found no Verdana. An earlier
reading of that setup, taken off the combined picture, missed the dropped line. The probe now renders
and checks each line on its own.

rsvg draws both lines correctly: the Latin in the requested face and the Sorani in Noto Sans Arabic.
That is fontconfig's per-character fallback, which resvg's per-run fallback does not do.

## 6. Today's markup against the renderer-neutral markup

ADR-036 section 2.3 and PLAN 3.3 also ask for a comparison through rsvg of today's markup against the
renderer-neutral markup. This item's brief left it out, because Phase 0.5 (commit `f4db3f4`) had
already replaced the old markup. That comparison is Phase 0.5's evidence, not this gate's:
`scripts/compare_renderer_markup.ts` over 153 designs, identical outside the logo box once the
whitespace fix is taken out, on rsvg 2.62.3 and 2.54.7.

## 7. What would have to change for a GO

- **Per-character font fallback for mixed Latin and Sorani lines.** No resvg option found here does
  it. The product would have to split every mixed line into single-script runs with an explicit
  family, and then the gate would have to run again.
- **CMYK JPEGs converted to RGB** before they reach the rasteriser.
- **The logo pre-scaled by our own code**, not by the rasteriser.
- **C3 measured again** once Phase 3.2 draws outlines and glows as rasters.

## 8. Files

| Path | What |
|---|---|
| `Dockerfile` | The measurement image |
| `scripts/cases.ts` | Builds every input and the job list |
| `scripts/make_photos.sh`, `scripts/copy_fonts.sh`, `scripts/probe_fonts.sh` | Photo inputs, font files, the image's font verdicts |
| `scripts/render.mjs` | Renders every job with both renderers in the image |
| `scripts/image-metrics.ts`, `scripts/selftest.ts` | SSIM, ink boxes, profiles, and their self-test |
| `scripts/analyse.ts` | Scores the renders; writes `results.json`, `summary.json` and the sheets |
| `scripts/recount.mjs` | Exact warning counts (`warning-recount.json`) |
| `scripts/fallback_probe.ts` | Section 5 (`samples/fallback-probe.json`, `samples/resvg-fallback-probe.png`) |
| `scripts/check_report.ts` | Checks this report's load-bearing numbers and claims against the JSON files |
| `lowest-ssim/` | The 30 lowest-SSIM pairs (C8) |
| `kurdish-sheet/` | The Kurdish matrix, rsvg left, resvg right (C8) |
| `flagged-lines/` | The worst flagged lines, rsvg above resvg |
| `samples/` | The CMYK, logo, Amiri parentheses and font fallback samples |

To reproduce:

1. Build the image: `docker build -t hawa-resvg-gate:0.48.1 output/gates/2026-09-resvg`.
2. Run `cases.ts`.
3. Run `render.mjs` in the image, with the work directory mounted at `/work`.
4. Run `analyse.ts`.

`selftest.ts` and `check_report.ts` run on the host.
