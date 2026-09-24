# ADR-036: Renderer-Neutral SVG, Raster Outlines, and a Gate Before Any Renderer Change

**Date:** 2026-09-24
**Status:** Proposed (architecture programme, Phases 0.5, 3.2 and 3.3).
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
