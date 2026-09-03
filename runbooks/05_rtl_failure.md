# Runbook: Sorani/Arabic/RTL Failure

1. Block publication and identify affected exact strings/nodes/exports.
2. Compare source text code points, direction/style runs, selected font files/hashes, editor view, and every export path.
3. Reproduce with the closest golden case and add a new one when novel.
4. Determine class: glyph coverage, shaping, bidi order, paired brackets/isolate, line break, fallback font, renderer mismatch.
5. Fix through source direction/font/node or approved renderer patch/fallback—not rasterized text.
6. Rerun all critical RTL checks and native review.
7. Record affected studio/browser/font versions.

Do not accept correct OCR as proof of correct visual order, and do not accept a visually plausible raster if live text is broken.
