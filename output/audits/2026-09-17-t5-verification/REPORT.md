# T5 qualification — verification, and the defect that invalidated its visual evidence

**Date:** 2026-09-17 · **Author:** lead engineer (every proof below re-executed) · **Branch:** studio-v2

Instruction: *"fix the runner first with T9, then run it again and make it truely ready, dont waste tokens."*

T9 was implemented and committed as `22380cc`. Run 3 completed 16 of 20 briefs; a checkpointed
resume then brought it to **18 of 20** for $0.62 instead of $6.28. This document records what the run
proved, what the report claimed without measuring, defects found in my own T9 code, four bugs found
in the renderer and generator, and the finding that invalidates the visual half of every
qualification proof produced so far.

**Bottom line: this is not a qualification pass, and it cannot become one on this machine.**

---

## 1. Outcome

| | |
|---|---|
| Briefs attempted | 20 |
| Completed | **18** |
| Failed | 2 — `brief_13_en_a4doc`, `brief_16_ckb_a4doc`, both `fetch failed` |
| Model calls | 90 = 18 x 5 stages |
| Total spend | $5.655748 |
| Resume cost | $0.624160 for 2 briefs, against $6.28 to re-run all 20 |

T9 did its job. A brief's failure no longer discards its batch, the checkpoint preserved every paid
brief across two recoveries, resume re-ran only what was missing, and the report states
attempted/completed/failed instead of dividing by whatever survived. Six retries with exponential
backoff (~62 s of retrying) still lost two briefs, so those tunnel outages lasted over a minute.

Both survivors of the failure set are A4 documents (1240x1754) — the largest layouts, the longest
generations, and therefore the most exposed to a dropped connection. That is the pattern, not chance.

## 2. The ledger is genuine

Independently recomputed, not read from the report:

- **90 rows = 18 briefs x 5 stages**, exactly: `P03_LAYOUT`, `P05_CRITIQUE`, `P07_JUDGE_AB`, `P07_JUDGE_BA`, `P07_CANARY`. No brief missing a stage, no extra rows, no rows for the two failed briefs.
- **Every cost recomputes exactly.** All 90 rows re-derived from token counts against $10/MTok input, $50/MTok output, $1/MTok cached. Zero mismatches beyond 5e-6.
- **Provider ids are real.** 90 distinct `chatcmpl-` ids, all 38 chars; 90 distinct `x-request-id`, all 36 chars. (A fabricated run earlier in this project produced 33-char ids.)
- **Latencies are real.** 90 distinct values, 6 389 ms to 427 779 ms.
- **Median per brief $0.312272**, mean $0.314208 — both against a $0.380 published comparison.
- Every carried-forward journal was cross-checked against the ledger token math before being reused.

## 3. What the report claimed without measuring it

Three rows of the headline table were literal strings and could not fail:

| Row | What the generator actually emitted |
|---|---|
| Canva Copy & Font Checks | `**PASS**` as a literal, denominator hardcoded to 20. It printed **80.0% against a ">= 90%" target and still said PASS.** |
| Hard-QA Escapes | `**0**` and `**PASS**`, both literals. Nothing in the run measured escapes. |
| Distinct Skeletons | `**PASS**` as a literal, denominator hardcoded to 20. |

Every rate was computed over completed briefs but printed as `x/20`, so a reader saw "100.0% (16/20)"
— a figure and a fraction that contradict each other. The median cost was `costs[floor(n/2)]`, the
upper-middle element, not a median.

The diversity metric was not a diversity metric: `distinctSkeleton` was true when a brief's archetype
differed from *the brief dispatched immediately before it*, which under two-way parallel batches is
order-dependent, and it counted `null` propagation as diversity. It reported 6/20.

**All fixed.** The regenerated report now leads with `Verdict: PARTIAL — NOT A QUALIFICATION PASS.
2 of 20 briefs never ran.` Canva copy/font is computed and passes at 100.0% (18/18) on its own merits.
Hard-QA escapes are counted for real — briefs marked print-ready while a hard deterministic check
failed — and the true count is 0. Skeleton diversity reports the archetype set with a histogram and
is labelled MEASURED, since the cited literature sets no numeric target; inventing a threshold would
only flatter it. The histogram honestly shows `unknown=16` for briefs run before the field was
recorded, plus `monolith_centered` and `split_statutory_banner` from the two newly run briefs.

## 4. Two defects in my own T9 code, found on review

1. **Resume would have produced an inconsistent proof.** The checkpoint stored completed ids, failures
   and ledger rows, but not per-brief results — so a `--resume` run would compute every rate over
   only the briefs it re-ran while the ledger carried all 90 calls. Fixed: result rows are persisted
   and rehydrated, brief definitions and indices resolve from source rather than the checkpoint copy,
   and a checkpoint whose id list disagrees with its result rows re-runs the difference instead of
   silently reporting over a subset.
2. **The image lane had no retry at all.** `generateImage` made a single attempt and rethrew, so one
   dropped connection lost the call outright — the very failure that cost runs 1, 2 and 3. It also
   leaked its abort timer on a thrown attempt. Both fixed; it now has the same six-attempt backoff
   and 429/5xx handling as the text path.

## 5. The finding that matters: every preview was drawn in the wrong typefaces

`getFontFidelityManifest` was a hardcoded table returning `'exact'` for all eight admitted families
while ignoring its own `fontsDir` argument. It measured nothing. Measured properly:

| Family | This macOS dev host | Production image |
|---|---|---|
| Verdana | exact | exact |
| Noto Sans Arabic | exact | exact |
| Inter | exact | exact |
| **Cinzel** | **stand-in** | exact |
| **Playfair Display** | **stand-in** | exact |
| **Cairo** | **stand-in** | exact |
| Amiri | not previously measured | exact |
| Plus Jakarta Sans | stand-in | exact |
| Vazirmatn | stand-in | **stand-in** |

Method: rasterise a probe in the requested family and in a family that cannot exist, then compare
bytes. Identical output means the renderer substituted a fallback. On this host, requests for Cinzel,
Playfair Display and Cairo produce **byte-identical PNGs to a request for `ZZNoSuchFamilyZZ`**.
Re-rendering the run's own `preview.svg` under the pipeline's own fontconfig reproduces the run's
`preview.png` byte for byte (sha256 `2402b33f2f0bcfa7...`), which proves the qualification renders
came out of this substituting configuration rather than some unrelated path.

`fc-match` cannot catch this, and the existing `assertFontResolves` guard used it: under the bundled
fontconfig, `fc-match` resolves "Cinzel" to Cinzel and "Playfair Display" to Playfair Display while
`rsvg-convert` still draws Helvetica. Name resolution succeeds; rasterisation does not use it. That
is precisely why the defect survived a guard written to catch it.

**What this invalidates.** Every preview PNG in the T5 proof, the images fed to the P05 vision
critique, the pair images fed to the P07 pairwise judge and to the canary, and the T8 blind test set
were drawn with a grotesque substituted for both display faces. **The 0.953 mean composite score and
every critique and judge verdict in this run were formed on typography production does not produce.**
The layout geometry, the copy fidelity, the editability test and the cost ledger are unaffected. The
P05 critique has since been re-run on correct typography — see section 11; the judge and canary have
not.

**Fixed and re-proved.** `probeFontFidelity` measures per host, caches per process, and now covers
Amiri as well. The manifest is measured. The qualification report carries a Font Fidelity row that
fails the run when any family a layout uses was substituted (added after this run started, so it
will appear on the next one). All 18 layouts were re-rendered inside the production image, where
every family used measures exact — deterministic, no model calls:
`output/proofs/2026-09-17-research-grade-pipeline/T5_FULL_QUALIFICATION/renders-production-fonts/`
with `RERENDER_MANIFEST.json` recording each family used and each sha256.

Vazirmatn is substituted in the production image too, and is still named in about twenty places
including the v1 planner and the Canva font declarations. It is not part of the owner's font policy.
Tracked as separate work; not changed here.

## 6. Three bugs in the text renderer, one in the generator

Found while reading `renderTextElementToSvg` to explain the font behaviour:

1. **Letter-spacing was applied to Arabic script.** Arabic joins cursively, so tracking pulls joined
   letters apart and reads as broken text. The generator emitted `letterSpacing: 0.02` on the eyebrow
   of **every Kurdish layout, 8 of 8**. Fixed in two places: the generator now emits 0 for any RTL
   element and its prompt says why, and the renderer refuses to apply tracking to Arabic-script
   families regardless of what the layout asks for. Confirmed by re-render: the Kurdish eyebrow
   changes hash and the joins close up.
2. **The emitted letter-spacing disagreed with the measured one.** Wrapping used a clamped value while
   the SVG attribute used the raw `t.letterSpacing`, so lines were measured with one spacing and drawn
   with another.
3. **The eyebrow autofit threw its own result away.** When an eyebrow wrapped, the code shrank a local
   copy of the font size until it fit on one line, then emitted the text at the *original* size — so a
   shrunk eyebrow overflowed the box it had just been fitted into.

All 205 tests in 33 files pass after these changes.

## 7. Are the designs actually different? Measured from the artifacts

`measure_layout_diversity.py`, committed beside the proof, ignores what the model says about its own
output and measures the geometry produced, across all 18 layouts:

- **18 of 18 distinct full geometric signatures** (quantised text-block placement + shape vocabulary + background treatment).
- **Zero pairs at >= 0.95 block-position overlap.** Mean within-size overlap: 0.203 at 1080x1080, 0.139 at 1080x1350, 0.037 at 1080x1920, 0.111 at 1240x1754, 0.042 at 1920x1080.

The "last ten designs are all the same" failure is fixed at the level of layout geometry. What stays
uniform is narrower and specific:

- **13 of 18 centre every text block.** Only 5 depart from a fully centred stack.
- **Every background is a flat colour.** 0 gradients, 0 image art, 18 of 18.
- Shape vocabulary is lines and rectangles only, with one ellipse across the whole set.

The qualification exercises layout, critique and judge only. **No image-generation call is made** —
`art.stage.ts` and `art-generator-v3.ts` exist but are not on this path — so $0.31 per brief is a
text-only figure and the art lane is entirely unproven. Flat-colour backgrounds and a centred stack
are the remaining reason output reads as templated rather than designed.

## 8. Font policy compliance is real

Verified per layout rather than from the prompt: English body = Verdana in 9 of 9 English layouts,
Kurdish body = Noto Sans Arabic in 9 of 9 Kurdish layouts, `rtl: true` on every block of every
Kurdish layout, display roles free (Cinzel + Playfair Display for English, Amiri + Cairo for
Kurdish). Verdana also carries the footer role, which the policy permits — it constrains the body
face, it does not ban Verdana elsewhere.

## 9. Correcting my own reading

From the local preview I judged the body panel's internal padding badly imbalanced. Measured across
all 20 panels, 19 have a vertical padding skew of 0.11 or less; `brief_01`'s is 0.02. The single
outlier at -0.46 is `brief_10`'s full-bleed container, not a text panel. There is no panel padding
defect, and dead space below the last element (5.5%-14.5% of canvas height) is footer margin.

## 10. The qualification can run inside the production image

Smoke-tested: with `scripts/` and the built `dist/` bind-mounted and `HAWA_QUALIFICATION_OUT_DIR`
pointed at an isolated directory, `tsx scripts/run_p10_qualification.ts` runs inside
`hawa-core:canva-only-20260913` — imports resolve, the cost governor arms, briefs dispatch, egress
works, and the only failure was the deliberately invalid API key returning a real HTTP 401.

This is the fix for the whole class of defect in section 5. Run in the image and the previews, the
vision critique and the judges all see the typography production produces. A valid 20-brief
qualification costs about $6.30 there. There is no cheaper route to valid aesthetic evidence: the
pairwise judge needs both candidates of each pair, and only the winning layout was persisted, so the
judge and canary verdicts cannot be recomputed from the artifacts on disk.

## 11. Re-critique on correct typography — what the designs are actually like

Owner's decision: re-render and re-critique rather than re-run the whole qualification. The layouts
were reused untouched, so this paid for one vision call per brief instead of regenerating anything.
Run inside the production image, which refuses to spend if any layout uses a substituted face.

While reading the first results, one HIGH severity finding turned out to be a real renderer bug and
led to a fourth fix, so the nine Kurdish designs were re-critiqued again after it:

**The renderer measured text with a different font file than it asked the rasteriser to draw.**
`loadFont` had no Amiri branch at all, so Amiri text was measured with the Verdana fallback — a face
with no Arabic glyphs. And Cairo has only a regular file, yet the SVG still carried
`font-weight="bold"`, so pango synthesised a wider face than fontkit had measured. 16 of 45 RTL
blocks are bold and 10 use Amiri. The visible consequence: `brief_11`'s Kurdish title rendered about
950px wide inside an 821px box and was **clipped by the canvas edge**, while the wrapper recorded it
as fitting on one line. Fixed by adding the Amiri branch and by emitting only the weight and style
the measured file actually provides. The title now sits inside its box. Nine of eighteen renders
changed, all of them Kurdish, and only those nine were re-critiqued.

| | Original run (substituted type) | Now (correct type and faces) |
|---|---|---|
| Critique comments across 18 designs | 29 | **21** |
| Designs with no comments at all | 1 | **3** |
| **High-severity findings** | 1 | **0** |

Every remaining comment is low severity, and they cluster on two root causes rather than eighteen
separate problems:

- **Visible ink sits high inside its box (7 comments).** Text is positioned from the line box, whose height includes ascender and descender space, so glyphs sit above the box's optical centre. One renderer change addresses all seven — but `t.y` currently means "top of the first line box", and the Canva/pptx transfer maps text frames by those coordinates, so this has to be done together with the raster/Canva parity check rather than in isolation.
- **Dividers and accents are not centred between the blocks they separate (9 comments).** Gaps like "38px above, 84px below" — a generator spacing issue, not a rendering one.

Cost: $0.518080 for the first 18 plus $0.261680 for the nine corrected Kurdish designs = **$0.779760**.
All 27 calls have distinct 38-character provider ids and every cost recomputes exactly.
Artifacts: `P05_RECRITIQUE/` and `P05_RECRITIQUE_KURDISH_FIXED/`, each with its own ledger, the
annotated Set-of-Mark image the model was shown, and the before/after verdict for every brief.

Total spend for this session: $5.655748 qualification + $0.779760 re-critique = **$6.435508**.

## 12. The two clustered defects, fixed

### 12.1 Ink centring — text now sits on the box's optical centre

The renderer placed the first baseline at `t.y + ascent`, using the font's declared metric ascent.
That is far taller than the ink. Measured from the bundled faces:

| Face | size | metric ascent | ink above baseline | empty space it created |
|---|---|---|---|---|
| Playfair Display Bold | 54px | 58.4px | 42.3px | 16.1px |
| Verdana | 24px | 24.1px | 18.2px | 5.9px |
| Cairo | 61px | 79.5px | 49.2px | **30.3px** |
| Noto Sans Arabic | 27px | 37.1px | 19.3px | 17.8px |

Arabic faces declare a very tall ascent to reserve room for stacked diacritics — Cairo asks for
1.303em — so the taller the Kurdish type, the further the glyphs drifted from centre. The renderer
now measures each shaped line's bounding box with fontkit and centres the real ink inside the box.
When the ink is taller than the box the old top-anchored behaviour is kept, so nothing is pushed off
the canvas. All 18 renders changed.

This had to land with the deck encoders, which is why it was deferred earlier: both `transfer-v2`
and `editable-transfer` anchored pptx text with `vertAnchor: 'top'`. Centring the raster alone would
have made the preview and the Canva design disagree in every block. Both now use `'middle'`.

### 12.2 Separator centring — and a metric that could not see the problem

The generator now centres a thin horizontal rule or accent inside the gap between the two text
blocks it divides, before the layout leaves the generator. Deliberately narrow: only thin,
horizontally-oriented separators that sit clear of every text block and overlap the blocks on both
sides. Panels, frames, vertical accent bars and anything a text block overlaps are left alone,
because for those the offset is usually the intent.

Measured over the eighteen real T5 layouts: **31 separators sit in a text gap, and 28 of them were
off-centre by 3px or more** — up to 172px above against 65px below. The nine the vision critique
happened to name were a sample, not the extent.

The reason the model kept emitting them is worth recording: **not one of the thirteen deterministic
metrics responds to separator position.** Recentring all 31 separators moved every metric score by
exactly 0.0000 — composite, negative space, alignment, balance, regularity, all unchanged. The free
gate scored these layouts at 0.95 while a paid vision call was the only thing that could see the
defect. `findAsymmetricSeparators` now closes that: a relative-and-absolute threshold (skew >= 0.25
and >= 8px difference, so a few pixels in a tight gap is not a defect) feeding a new hard
`ASYMMETRIC_SEPARATOR` QA code. It is a hard gate rather than a fourteenth weighted metric, so no
existing threshold or proof had to be re-weighted. Against the real layouts it flags **12 of 18**,
including the exact cases the critique quoted (43/74, 38/84, 48/84).

Verification output: `SPACING_FIX_VERIFICATION.txt`, reproducible with
`node scripts/proofs/verify_spacing_fixes.mjs <briefsDir>` — no model calls.

## 13. Further bugs and gaps found while fixing those two

1. **A centre-aligned Kurdish title reached Canva without RTL.** `studioLayoutV2ToTransferPlan` decided direction with "Arabic-ish family name OR right-aligned". Amiri was not in that family list, so a centre-aligned Amiri title — **9 of the 18 layouts** — was handed to the deck with `rtl: false`, no `rtlMode` and no `lang: "ku"`, and was left out of the manifest's `rtlBlocks`. The same test marked an English right-aligned footer as Kurdish. Both now use the layout's own `rtl` flag with the cursive-script families as a safety net.
2. **Every shape reached Canva as an opaque filled rectangle.** The transfer plan carried only x, y, width, height and colour, so a hairline frame, a translucent wash, an ellipse and a rule all arrived as solid slabs. `kind`, `opacity`, `radius` and the stroke fields now cross the boundary and the encoder maps them to the matching pptx shape, mirroring the raster.
3. **The deck ignored the layout's line height.** The encoders imposed a fixed multiple (1.3, 1.7 or 1.4) while the layout specifies one per block in the 1.15-1.85 range, so text reflowed away from the preview. Both now use the block's own value.
4. **`assertFontResolves` gave false assurance.** It ran `fc-match`, which resolves a family name the rasteriser then fails to use — the whole reason the substitution in section 5 survived a guard written to catch it. It now consults the render probe and warns once per family, with the machine-readable verdict on the render result's `fontFidelity`.
5. **A test that passed per-package and failed from the root.** The new spacing tests resolved the fonts directory from `process.cwd()`, which differs between `pnpm --filter` and `pnpm test`. Now resolved from the test file. Worth noting because `pnpm --filter` masked it entirely.
6. Removed a dead adjacency counter left behind in the qualification script when the archetype-set figure replaced it.

Coverage for all of the above: `packages/creative/test/layout-spacing-fixes.test.ts`, 13 tests.
Full suite: **1074 passed, 12 skipped, 0 failed** across 147 files, and a clean repo typecheck.

## 14. What remains

1. **The pairwise judge and canary verdicts are still unvalidated.** The re-critique validated the P05 stage only; the judge needs both candidates of each pair and only winners were persisted, so those scores remain measured on substituted typography. A full in-image run (~$6.30) is the only way to validate them, or persist both candidates so a re-judge becomes possible from artifacts.
2. **A clean 20/20.** Two A4 briefs still fail on tunnel outages longer than the retry budget.
3. **The art lane is unproven.** No image call in the qualification; cost and print-ready figures exclude it.
4. **Visual defaults.** Flat-colour backgrounds on 18 of 18 and a centred stack on 13 of 18 are the live quality ceiling.
5. **Re-critiquing on the fixed renders has not been paid for.** Both clustered defects are fixed, tested and measured, but the 21 surviving comments were raised against the pre-fix renders. A re-critique (~$0.5) would show what is left; the fixes themselves are verified without it.
5. **T6 still rejected.** A 40%-empty canvas must fail; the 1.20:1 panel contrast must be fixed; before/after must use real copy, not `Sample copy block N`.
6. **T8 still rejected.** Its blind pairs were drawn with substituted fonts and must be regenerated in the image.
7. **T7 blocked on the owner.** `DESIGN_PIPELINE_V3_CHATS` must be set in the production env file, which only the owner writes.
8. **Deployed build is behind HEAD.** Redeploy after a valid run, with flags owner-controlled.
