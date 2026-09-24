# ADR-036: Renderer-Neutral SVG, Raster Outlines, and a Gate Before Any Renderer Change

**Date:** 2026-09-24
**Status:** Accepted 2026-09-24 by the owner ("yes, do all"); 2.1 and 2.2 implemented (Phase 0.5, 3.2); the 2.3 gate ran on 2026-09-24 and is **NO-GO** (C1-C4 fail: missing-glyph warnings on 108 of 383 canvases, 164 text lines out of tolerance, cut-out treatments, minimum SSIM 0.88), so the product stays on rsvg-convert; report in output/gates/2026-09-resvg/REPORT.md.
**Amends:** ADR-032's outline and glow treatments (drawn as rasters instead of SVG filters); the text markup in `render-layout-v2.ts`.

## 1. Context

Every design is rasterised by `rsvg-convert` (librsvg 2.54.7 in production, 2.62 on the Macs). On 2026-09-24 it caused three production bugs: the 10 MB attribute limit, no WebP decoder in 2.54, and a 24 px outline (`feMorphology`) that took 23 s and timed out the Canva deck. Host tests passed while production failed.

Research into resvg (the Rust renderer) found it cannot take our SVGs as they are, and that the Node package is not a safe way to adopt it:

- resvg ignores `direction` and `unicode-bidi` (bidi base level hard-coded to left-to-right; issue #475 open): our right-aligned Kurdish lines would run off the box and mixed lines would reorder.
- resvg's `feMorphology` clears the output when either radius is zero, which is how our outline passes are written, and its window is lopsided.
- `@resvg/resvg-js` bundles resvg 0.34 from 2023: no WebP, CMYK JPEGs blank, panics on some Arabic text; it rebuilds its font database on every call and has no hard timeout in-process.
- Measured on both librsvg versions: the whitespace between our `<tspan>`s shifts centred lines by half a space and end-anchored lines by a whole space (7 and 14 px at 40 px Verdana), today; and the Macs draw a different Noto Sans Arabic from `~/Library/Fonts` (283 px against 302 px for one sample), which `probeFontFidelity` cannot see.

## 2. Decision

1. **Renderer-neutral markup now, on rsvg:** no whitespace between `<tspan>`s; right-to-left lines emitted as `U+202B … U+202C` inside their tspan with left-to-right anchor meanings (measured byte-identical to today's `direction="rtl"` output for right, centre and left alignment on both librsvg versions); image types from magic bytes, not file extensions; the logo pre-scaled once; a font check comparing rendered ink width with fontkit's.
2. **Outlines and glows as rasters:** a distance transform in our code draws them as a PNG embedded in both the preview and the deck bake; no SVG morphology.
3. **A gate before any renderer change:** in the production image, render 200 stored layouts in every style mode plus built photo, cut-out and Kurdish text sets with rsvg (today's and the neutral markup) and with the resvg 0.48.1 command-line tool. GO only if: no crash, silent blank or decode or font warning; every text line within 1 px (Latin) or 2 px (Arabic) with no word-order change; every treatment within tolerance; median canvas SSIM ≥ 0.99, minimum ≥ 0.97; byte-identical across repeats and between Mac and container; p95 time no worse than rsvg's and nothing over 5 s; peak memory ≤ 1.5x; a person signs off the lowest-scoring pairs and the Kurdish sheet.
4. **If GO:** only the rasteriser behind `svgToPngAsync` changes, to the resvg CLI as a subprocess (timeout, kill and memory isolation kept), built from source in a Docker stage (no linux/arm64 binary is published), `--skip-system-fonts` with explicit font files; rsvg-convert stays installed for one release. The preview and the deck bake always use the same renderer.

## 3. Consequences

- The line shift fixed today; the font trap detected; the outline timeout gone for good; pictures no longer inlined (with ADR-035).
- A renderer change becomes a measured decision with a way back, not a dependency swap.
- A Rust build stage in the core image if the gate passes.

## 4. Alternatives considered

- **Switch to `@resvg/resvg-js` now.** Stale engine, the WebP bug would return, RTL and outlines would break.
- **Stay on rsvg unchanged.** Leaves the line shift, the Mac font trap and the outline cost.

## 5. Amendment 2026-09-24: the renderer draws the files it measures (Phase 0.5 follow-up)

The ink check of §2.1 found three places where fontkit measured one face and rsvg drew another. Decided and done:

1. **Static Inter at opsz 14.** `Inter-Regular.ttf` was the variable font (opsz 14–32, wght 100–900). fontkit measures its default instance; pango sets opsz from the drawn size, so a 60 px line was drawn about 7% narrower than it was wrapped and centred on, in production too. It is replaced by static faces for the weights the product asks for (400–900), cut at opsz 14 with `fontTools.varLib.instancer` by `scripts/generate_inter_static_instances.py` (`--check` re-derives them), with the OFL licence. opsz 14 because every named instance sits there and fontkit already measured it, so no wrap decision changes; the alternative, pinning opsz in both fontkit and fontconfig, would leave a variable file that any other reader could draw at another size. Consequence: display Inter is drawn at text optical size (wider, looser), including the operation-template previews (`renderOperationsToPng`), which used to draw weights 500–900 from the variable file's instances.
2. **A generated fontconfig for every rsvg-convert call, and pango on its fontconfig backend.** `font-environment.ts` writes a `fonts.conf` listing only `packages/creative/assets/fonts` and the registry's `systemPaths` (the Verdana files, which cannot be committed), and every spawn runs with it and `PANGOCAIRO_BACKEND=fc`: on the Macs pango drew through CoreText, which never reads `FONTCONFIG_FILE`, and found `~/Library/Fonts`' Noto Sans Arabic (9.4% off). The file lives in a per-user, owner-only temp folder (another user's folder or a link is never used), and a folder a temp cleaner half-deleted is rebuilt. The committed `fonts.conf` (the image's `FONTCONFIG_FILE`) lists the same set.
3. **Symbols from committed faces.** The copy gate admits arrows, maths, geometric shapes, symbols and dingbats; the image drew them from system fonts, mostly DejaVu Sans, and step 2 took them away (☎ ✉ as hex boxes). `HawaSymbols-{Regular,Bold}.ttf` are DejaVu Sans 2.37's glyphs for exactly those ranges (`scripts/generate_symbol_fallback_faces.py`, licence in `LICENSE-DejaVu.txt`); Latin families fall back to them first, Arabic-script families keep fontconfig's order (so a Kurdish footer's "•" is drawn as before). U+27BF alone is not restored.
4. **Fidelity per script, by ink.** A family is judged for each script by the ink it draws against the file fontkit measures; a probe identical to the missing-family sentinel must match within 0.5%. Vazirmatn was called a stand-in only because it is fontconfig's fallback face; its Kurdish is exact (834 px drawn, 834.1 measured).

Measured in the production image (`hawa-core:canva-only-20260913`, read-only, this build mounted over its package; `scripts/rerender_font_pinning.mjs`): the 40 stored layouts of two runs in two modes (80 renders) are byte-identical before and after; the built Inter designs change inside their text boxes only, with no wrap change; Inter ink is within 0.15% of fontkit at 24, 40, 60 and 96 px; every admitted family is exact per script.
