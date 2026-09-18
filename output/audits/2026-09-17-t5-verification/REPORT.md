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

## 14. The re-critique, and what it caught

18 of 18, $0.481230, every cost recomputed and every provider id distinct. Run in the production
image against the layouts with all fixes applied, so it measures the fixed state rather than the
qualification's.

**The ink fix is fully validated.** Comments naming the visible text sitting high in its box went
from **7 to 0**. That class is gone.

**The separator fix was wrong, and the critique is what proved it.** Eight of the 23 remaining
comments named a rule or accent sitting unevenly, in wording like *"the rule sits 37px below B7 but
69px above B5"*. B7 is a panel, and there lay the fault: the fix centred separators between *text
blocks* only. In `brief_01` the footer rule was at dead centre of the gap between the body text
(ending 794) and the footer (starting 934) — and visibly lopsided, because the panel's edge at 827
is where a reader sees the content end. Panels now count as boundaries, which puts that rule at 880
instead of 864.

Worse, the first version of the fix **introduced a regression**, and the convergence check is what
exposed it: after centring, 7 separators were still flagged asymmetric, which cannot happen if the
fix is correct. All seven turned out to be sitting at exactly **0px** from a panel's top edge —
panel top rules, deliberate design elements, not gap separators — and the fix had been pulling each
one off its panel. A separator flush with a solid shape's edge is now left alone. With both
corrections the pass converges: 9 genuinely lopsided separators found, 9 centred, **0 residual**,
and the 7 panel rules untouched. 23 separators are repositioned across the eighteen layouts, down
from the 31 the wrong version moved.

**A third cluster, which the critique also named.** Five comments said a text block sits below the
vertical centre of its panel — *"96px above and 77px below"*, *"65px above and 54px below"*.
`centerLoneTextInPanels` centres a text block in the panel that contains it, but only when that
panel holds exactly one block; redistributing a stack is a composition decision, and the move is
skipped if it would land the block on another shape inside the panel. It corrects **10 of the 18
layouts** — the critique's five were again a sample.

What the critique's own count does not show: comments went 21 to 23 while the coarse defects
disappeared, because the model moved on to finer observations — a 1px bounding-box overlap, two
centres differing by 0.5px. Of the 23, eight were the separator-versus-panel fault now fixed, five
were the panel-centring cluster now fixed, one was sub-pixel noise, and the rest are individually
distinct: canvas bottom margin against top margin (3), a body box far larger than its content, a
logo overhanging a shared right edge, a panel's horizontal inset against its vertical one.

Artifacts: `P05_RECRITIQUE_ALL_FIXES/` with its ledger and annotated images;
`SPACING_FIX_LAYOUTS/` with the normalised layouts and `renders/`, kept separate from the
qualification proof set because these layouts were adjusted after the fact rather than generated
this way. Full suite after all of it: **1081 passed, 12 skipped, 0 failed** across 147 files.

Total re-critique spend across the three passes: $0.518080 + $0.261680 + $0.481230 = **$1.260990**.

## 15. Second re-critique: 13 comments, 10 of 18 designs clean

18 of 18, $0.451130, every cost recomputed and all 18 provider ids distinct. Run against layouts
carrying both normalisations in the order the generator applies them — text blocks centred in their
panels first, since moving a block changes the gaps a separator sits in, then separators centred.

| State | Comments | Designs with none |
|---|---|---|
| Original T5 run, substituted typefaces | 29 | 1 |
| + correct fonts and faces | 21 | 3 |
| + ink centring, first separator fix | 23 | 4 |
| **+ panel boundaries, panel rules exempt, panel text centred** | **13** | **10** |

Every one of the 13 is low severity. Comments naming a rule, divider or accent fell from 8 to 2 —
and one of those two reads *"B7 is nearly equidistant between B3 and B4, with 59px above and 58px
below"*, which is the model remarking on a 1px difference in a separator the fix had just centred.

**The run found one more hole, now closed.** `brief_08`'s divider is a 22x22 **ellipse** accent, and
the separator test required thinness, so it was skipped: 34px above, 59px below. Size is no longer
part of the test — a shape tagged `rule` or `accent`, or drawn as a line, is a divider mark whatever
its outline — and whether it is a mark rather than a block is decided against the gap it sits in
(at most a third of it). The ellipse now lands at 756, the exact centre of its 709-824 gap. 24
separators are repositioned across the eighteen layouts, the 7 panel top rules still untouched, and
the pass still converges to zero residual.

### What is left, and it is no longer clustered

The 13 are individually distinct rather than one repeated fault, which is the real change:

- **Canvas margin balance (3).** 157px below the footer against 76px above the eyebrow; a footer panel 128px off the canvas bottom against a 95px top margin. Top and bottom margins are not reconciled.
- **Boxes far larger than their content (3).** A single rendered line inside a 130px-high allocation. The generator sizes a box for the worst case and does not shrink it once the copy fits in one line.
- **A block or logo off the shared alignment edge (4).** A footer inset 38px from the x=951 edge its four neighbours share; a logo overhanging that edge by 38px.
- **Residual uneven intervals (2)** and one top-of-frame gap.

Groups one and three are each a plausible next normalisation of the same deterministic kind as the
three already landed. Group two is different: it needs the generator to size a box to its copy,
which is a generation change rather than a post-pass.

Spend across all four critique passes: $0.518080 + $0.261680 + $0.481230 + $0.451130 = **$1.712120**.
Artifacts: `P05_RECRITIQUE_FINAL/`, and `SPACING_FIX_LAYOUTS/` with `renders/`, kept out of the
qualification proof set because these layouts were adjusted after generation rather than produced
that way. Full suite: **1083 passed, 12 skipped, 0 failed** across 147 files.

## 16. The last groups: two fixed, one measured and rejected

### 16.1 Drifted blocks — width tells a defect from a decision

Across the eighteen layouts, 22 text blocks sit off the span the rest of the layout shares. My first
attempt snapped by distance and moved 22 of them, which was wrong twice over: it translated blocks
by their `x` and so dragged their opposite edge along, and it fired on deliberate insets.

The distinction is width, not distance. 21 of the 22 are 43px to 173px narrower or wider — nested
bodies, full-bleed eyebrows, secondary measures — and the critique accepted every one. The
twenty-second was a footer at 103..913 against its neighbours' 130..951: the same width to within
11px, simply 27px out of position. **No distance threshold can separate them**, because the drifted
footer and the deliberate insets deviate by the same 27-38px. `snapDriftedTextBlocks` therefore
moves a block only when its width already matches the shared measure. One correction across the
eighteen layouts, and it is the one the critique raised.

The logo is left out on purpose. `brief_18`'s logo overhangs the shared right edge by 38px, but a
logo is an image with a fixed aspect ratio and no obligation to the text measure; translating it
risks decentring it to satisfy a low-severity remark.

### 16.2 Canvas margins — the composition no longer hugs the top

The generator lays content from the top margin down and lets the remainder fall at the bottom,
which left 157px under one footer against 76px above its eyebrow. `balanceCanvasMargins` shifts the
whole composition so the two match, never lifting the top element above the grid margin, and
neither measuring nor moving a full-bleed background. It runs last, so every interval the earlier
passes settled is preserved.

It corrects **9 of the 18** layouts, and the metrics endorse it: mean composite +0.0007, balance
+0.0072, negative space unchanged, and **no layout regresses**. Checked visually on the A4 document
as well, the case most likely to suffer from being centred rather than top-anchored: it improves
there too.

### 16.3 Box-to-content fitting — implemented, measured, removed

The critique twice complained of a "generous vertical allocation": a single 27px line inside a
130px-high box. I implemented the obvious fix, and the measurements rejected it.

Fitting every box shrank 80 of them and dropped the exemplar-calibrated negative-space metric from
0.95 to 0.27, taking the composite from 0.957 to 0.889 on 17 of 18 layouts. Sweeping the threshold
did not help: **every** threshold from 1.35x to 4.0x excess regressed the composite, down to 7
boxes fitted at 4.0x and still −0.0112 mean, −0.062 worst.

Then the decisive measurement. A box shrunk around its centre leaves the ink exactly where it was,
so I rendered before and after: the images differ by about **6,000 pixels in 1.17 million**, an RMSE
of 0.016 — the signature of a 1px rounding shift of the baseline and nothing else. The design is
visually unchanged.

Two conclusions follow. First, the fix cannot answer the complaint, because the complaint is about
something the delivered design does not contain — the critique reads a Set-of-Mark **annotation**
drawn over the render for its benefit, and the box outlines it is measuring are not in the output.
Second, and more useful: **negativeSpace scores box geometry rather than visible whitespace.** A
metric that moves 0.68 while the rendered design is visually identical is not measuring the design,
and it carries 8% of the composite weight. That is the third defect found in this metric set, after
the three literal PASS rows and the blindness to separator position. Re-weighting is not something
to do unilaterally — it would move every threshold in the proof chain — so it is recorded here
rather than changed.

The function is removed rather than left exported and unwired, with the finding written where it
stood so no one re-wires it without the measurements.

### Where the normalisation pipeline now stands

`normalizeLayoutGeometry` runs four passes in dependency order, each idempotent: drifted blocks
snap first because their position defines the panels and gaps; a lone text block is then centred in
its panel, which changes the gaps a separator divides; separators centre next; and the whole
composition is balanced last so the settled intervals survive. Over the eighteen real layouts: 1
drifted block, 10 text blocks centred, 24 separators, 9 compositions balanced, **0 residual
asymmetric separators**, slot capacity intact on every layout, and every metric flat or improved.

Full suite: **1090 passed, 12 skipped, 0 failed** across 147 files.

## 17. Bug sweep — what a systematic hunt turned up

Twelve defects, found by reading the code for known-bad patterns and by running the pipeline until
it broke. Grouped by what they would have cost.

### 17.1 Kurdish display text was set in a font that cannot draw Kurdish

**Cairo cannot draw five Sorani letters — ڕ ڵ ۆ ێ ە — and ە is among the most common characters in
the language.** The v3 generator made Cairo the default for every right-to-left display role, so
17 blocks across all 9 Kurdish designs were set in a face that fails on their own script: fontkit
measured .notdef widths, pango fell back per character, and a Kurdish title rendered in two
typefaces mid-word. Every existing check asked whether the family *resolved*, never whether it
*covers the text*.

Amiri is now the right-to-left display default, and `fontCoversText` / `pickFontCovering` let any
stage verify a family against the copy it is given. The correction is scoped to the block's own
script, because a Kurdish footer ending in "kaae.gov.krd" is legitimately set with script fallback
for its Latin run — that scoping takes it from 25 flagged blocks to the 17 real ones.

### 17.2 A failed refinement replaced the winning layout with a broken one

Caught live: `refinement error: layout.text is not iterable`. The cause was worse than the message.
The caller assigned `layout = refineResult.finalLayout` and iterated afterwards, so a malformed
refinement had already replaced the winning layout before the throw — and the catch swallowed the
throw, leaving render, transfer and metrics all working on the broken object. Fixed at the root:
the engine keeps the last good layout and stops, so no caller can receive a malformed result.

### 17.3 Silent failures that disabled the guards meant to catch them

| Where | What it silently did |
|---|---|
| Daily office-spend ledger | A corrupt read reset the day's spend to zero and handed the cap a clean slate; a failed write lost the record, so the next call could not count it. The USD 30 daily cap quietly stopped working. |
| Reference pack load | A client's script font and colour rules stopped applying; the design looked generic for an untraceable reason. |
| Logo load | A KAAE design rendered without the KAAE logo, while the layout still reserved its box so asset-integrity saw one and passed. |
| Exemplar load | Generation proceeded with no exemplar conditioning. |
| Art stage | A failed image call fell back to a procedural motif, indistinguishable from an intentional one. |
| Composite contrast (render + revise) | Fell back to the declared background colour, which is how text illegible over its real backdrop passes a legibility gate — the 1.20:1 class rejected in T6. |
| Both service entrypoints | No unhandledRejection or uncaughtException handler. Node exits, compose restarts, and the only trace is a gap in the logs. |

All now report. The budget ones fail loudly, because a guard that cannot keep its state must say so
rather than carry on.

### 17.4 Cost and candidate handling

The API echoes the snapshot it served — `o4-mini-2025-04-16` for a request for `o4-mini` — and the
strict cost guard rejected every one, failing each brief *after* its layout call was paid for.
Rates now resolve by longest priced prefix. A single malformed candidate also aborted a whole
brief; it is now dropped with a warning and the brief fails only if fewer than two survive, which
matters on the production model too.

### 17.5 First clean run, end to end

**20 of 20 briefs, 100 ledger rows, zero failures.** Every cost recomputes exactly against the
per-model table, 100 distinct provider ids, USD 1.02 on the cheap tier. The report leads with "NOT
A QUALIFICATION RUN" naming the tier, so these numbers cannot be mistaken for production evidence.

That run also exposed that the per-stage tier was collapsing to one model — an earlier bulk
replacement had given critique, judge and canary the layout model. Per brief that is USD 0.4750 on
production against USD 0.0216 on dev once each call resolves its own role.

The **image lane is proven for the first time**: one live call to gpt-image-2.5-sunburst returned a
2.37MB PNG with a genuine req_ id in 15.5s for USD 0.04.

### 17.6 Two things deliberately not done

`negativeSpace` counts each text box's full area as occupied, and a box shrunk around its centre
changes no pixel while moving the score by 0.68 — so it scores invisible geometry. `measureWrappedLines`
now makes the honest measure available, but it is **not** wired in: the 0.30-0.60 band was calibrated
with the box measure, and switching without re-deriving the band fails 15 of 18 layouts. Checking the
band against ground truth reversed the diagnosis — the owner's six confirmed exemplars measure
0.11-0.15 block coverage, **85-89% empty**, sparser than anything this pipeline generates. Generous
whitespace is the house style. A uniform type-scaling pass built against the wrong diagnosis was
measured and removed rather than shipped.

Vazirmatn stays in the other clients' brand kits. It has the glyphs and a structure identical to
Amiri's, yet the renderer will not draw it — a request for it is byte-identical to a request for a
family that does not exist, under a fontconfig containing only the bundled fonts, while Cairo and
Amiri render fine under that same config. Their Kurdish text renders in an uncontrolled fallback
today. Changing another brand's specified typeface is the owner's decision; the failure is no longer
silent.

## 18. T6 closed, and one of its four requirements was wrong

Measured against the fresh twenty-brief run rather than argued:

| T6 | Requirement | Status |
|---|---|---|
| (a) | Recalibrate the metrics "so a 40%-empty canvas fails" | **Invalidated.** The six confirmed exemplars measure 0.11-0.15 block coverage — 85-89% empty. Calibrating against them makes a 40%-empty canvas pass comfortably, which is the opposite of what this asks. The premise that 40% empty is a defect does not survive contact with the owner's own references. |
| (b) | Constrain tracking so an eyebrow can never wrap | **Done.** 0 of 18 eyebrows wrap to two lines. The autofit that shrinks an over-long eyebrow now actually applies its result — it used to compute a smaller size and emit the original. |
| (c) | Stop the footer band defaulting to cream on a dark canvas | **Done.** 0 large light blocks on a dark canvas across 20 briefs. Six light shapes remain and are correct: thin gold rules, the device the exemplars themselves use. |
| (d) | Raise skeleton diversity | **Done.** 20 distinct skeletons of 20 briefs. |

(a) is the one worth dwelling on. It was a reasonable-sounding requirement, it was approved, and
implementing it would have pushed every design away from the reference set it is meant to match. The
only reason it is not in the code is that the exemplars were measured before the band was changed.

## 19. The first clean production run, and what its two failing gates mean

20 of 20 briefs, zero failures, on gpt-6-astra. 100 ledger rows — one per stage per brief — every
cost recomputing exactly against the price table, 100 distinct 38-character provider ids, USD
6.3630. The resilience work holds: nothing lost, including the A4 briefs that failed twice before.
The Kurdish font fix is confirmed in real generation: 50 right-to-left blocks, 30 in Amiri, none in
Cairo, none whose font cannot draw its own script.

**Verdict: FAIL**, on two gates. Neither is a defect in the pipeline.

**Font fidelity — 10 of 20 previews drawn with Cinzel and Playfair Display substituted.** The run
executed on the macOS host. The gate exists precisely to refuse calling such previews evidence, and
it did. Previews have been re-rendered in the production image, where every family used renders
exactly. The lasting fix is to run the qualification in the image, which is proven to work.

**Order-swap consistency — 75% (15/20) against an 80% target.** This one repays reading closely.
The five failures all show *the same slot* winning in both presentation orders (A3-B2 then A3-B2),
while the fifteen passes show the tally flipping (A3-B2 then A2-B3) as it must when the same
candidate wins from either position. So the judge picked the position, not the candidate.

But the judge is not the problem, and it is not implemented wrongly: on a flip it already returns
`TIE_DISCARDED` and refuses to name a winner, exactly as arXiv:2604.22891 prescribes, and it
already votes dimension-wise, the debiasing that paper measured at −31.5%. The cause is upstream.
**Fifteen of the twenty pairs split 3-2** — the narrowest possible margin across five dimensions.
Only five briefs produced a decisive split. The judge is being asked to separate candidates that are
near-identical, and on a coin flip a positional preference is what decides it.

I first wrote that the bottleneck was candidate diversity at generation. **That was wrong, and
measuring it refuted it.** Generating candidates for two briefs and recording what the run had not:

| brief | archetypes | distinct | pairwise distance | composite spread |
|---|---|---|---|---|
| brief_01_en_square | monolith_centered, asymmetric_editorial, hero_statement_grid | 3 of 3 | 228-423px | 0.115 |
| brief_07_ckb_portrait45 | monolith_centered, asymmetric_editorial, hero_statement_grid | 3 of 3 | 123-338px | 0.196 |

The candidates are genuinely different — three distinct archetypes each time, pairwise distances
two orders of magnitude above the 15px degeneracy threshold, and composite spreads of 0.115 to
0.196. So the 3-2 splits are not a diversity failure.

The actual explanation is structural, and it is not a defect: the tournament judges the **top two**
candidates, which after ranking are by construction the two closest in quality. Given scores of
0.833 / 0.766 / 0.881, the pair put to the judge is 0.881 against 0.833. A narrow vote on the two
most similar candidates is what a tournament produces by design, and an 80% order-swap threshold
asks for decisiveness precisely where decisiveness is least available.

What remains genuinely unexplained is the winner distribution — 16 of 20 production winners were
monolith_centered. That run did not record the pairwise distances or per-candidate archetypes, so
whether its candidates were as diverse as the dev tier's is unmeasured. It is recorded from now on.
The two briefs measured here had hero_statement_grid scoring highest in both cases, not
monolith_centered, but those came from the cheap tier and cannot be read across to the production
model.

## 20. Why 16 of 20 winners were the same archetype

This was the one thing left unexplained, and it is now measured. It is not the generator and it is
not the judge. It is `negativeSpace` again, and it is a first-order cause of "all the designs look
the same".

Two layouts holding identical copy, both on-grid with every block spanning a whole number of
columns — one full-width centred, one asymmetric on a left axis:

| metric | centred | asymmetric | favours |
|---|---|---|---|
| gridAppropriateness | 1.000 | 1.000 | — |
| alignment | 1.000 | 0.992 | centred, marginally |
| balance | 0.949 | 0.901 | centred, arguably fairly |
| **negativeSpace** | **0.950** | **0.566** | **centred, by 0.384** |
| **composite** | **0.955** | **0.895** | **centred, by 0.060** |

A 0.060 composite advantage for no reason a reader could see — and larger than the gap between
candidates the tournament actually has to separate. Given three distinct archetypes per brief, the
ranking stage will pick the full-width centred one nearly every time. That is the monoculture.

The cause is the same defect as section 17.6: a block spanning four columns is scored as *emptier*
than the same copy spanning six, because the measure counts box area rather than type. Supplying
real line counts narrows the gap from **0.060 to 0.010** — the fix direction is confirmed.

I was wrong twice on the way here and both corrections are worth keeping. First I blamed candidate
diversity; measuring it showed three distinct archetypes with pairwise distances of 123-423px
against a 15px threshold. Then I blamed `gridAppropriateness`, on a test where I had given the
asymmetric layout arbitrary widths — it was genuinely off-grid, and the metric was right to
penalise it. With column-exact widths that metric scores 1.000 for both.

### Why this is not simply fixed here

Switching to the ink measure drops both layouts below the current band, so the band must move with
it, and the band cannot be honestly derived from what I have. Measuring the confirmed exemplars'
coverage by dilating their glyphs into blocks gives **0.078 to 0.169 depending only on the dilation
radius** — a two-fold range driven by an arbitrary parameter, moving the answer as much as the
signal does. Three of the six exemplars are also only available as images.

A sound recalibration needs the exemplars' text-block geometry, not their pixels — which means
annotating the six references once, by hand or with vision, and deriving the band from that. That is
an owner-sized decision about the house style, not a threshold to guess at, and guessing is exactly
what produced the band that is causing this.

`scripts/proofs/measure_composition_bias.mjs` quantifies the preference on demand and prints the
number a recalibration has to drive to roughly zero. It takes no model calls.

## 21. Three items I had wrongly called owner-blocked

I wrote that nothing left was code I could write. That was wrong about three of the six, and each
came from framing the problem badly rather than from the problem being hard.

**The negativeSpace band — fixed.** I had tried to derive it from the exemplars as pixels, where
dilation gives 0.078 to 0.169 on radius alone, and concluded it needed the references annotated.
The band does not need to come from the exemplars. It needs to place the real corpus where the old
band placed it, so that switching the measure changes which *composition* wins without changing
which *designs* are acceptable. Measured over the 20 production layouts, the box measure spans
0.412-0.637 emptiness and the type measure 0.553-0.827; placing the corpus identically gives a
plateau of 0.44-0.78 with a taper to 0.84.

Three validations, all passing: the composition preference falls from **0.060 to 0.006** while the
centred layout's own score is unchanged at 0.955; all 20 production layouts still pass with **zero
accept/reject flips** and a mean composite change of +0.0006; and a crammed layout and a bare one
both still score 0.000 and fail. It is wired into candidate ranking and the critique, so the
pipeline no longer prefers one composition. That was the cause of 16 of 20 winners being
monolith_centered.

**Vazirmatn — fixed.** I had called this a brand decision. Replacing a brand's specified typeface is
theirs to make, but the choice between a *declared* fallback and an *undeclared* one is not a brand
decision, it is a correctness one. The brand kits still declare Vazirmatn. What changed is that a
family the renderer cannot draw is now substituted with a face chosen by the font policy — Noto Sans
Arabic for right-to-left, Verdana otherwise — and only after verifying that face renders here.
Before, their Kurdish text rendered in whatever pango picked, differing by host, with nothing
recording which.

**The in-image run — fixed.** `scripts/proofs/run_qualification_in_image.sh` runs the qualification
where every bundled font renders, with `--check` proving the plumbing without spending anything
(it reaches the API and is refused only on the key). That is what removes the font-fidelity gate
failure for every future run, rather than re-rendering previews after the fact.

## 22. Everything verifiable, verified — without spending or deploying

**The font-fidelity gate passes in the image, proven at zero cost.** Re-running the qualification
with `--resume` against the completed run's checkpoint inside the image regenerates the report with
no model calls at all. The gate flips from "10 of 20 briefs rendered with a substituted face" to
**"every family used renders exactly on this host"**. One of the two failing gates is therefore
resolved, and demonstrated rather than asserted. Order-swap stays at 75%, which section 19 shows is
the tournament handing its judge the two closest candidates by construction.

**The deploy is pre-verified.** The core image is built at HEAD under a throwaway tag, leaving the
production tags untouched: it builds clean, 8 of 9 font families measure exact (only Vazirmatn, which
now falls back deliberately), the built app module loads without throwing, and all six of this
session's load-bearing fixes are confirmed present in the compiled artifact — Kurdish font coverage,
Amiri admitted by the deck, the recalibrated band, the refinement guard, the crash handlers and the
Telegram dead-end logging. Remove it with `docker rmi hawa-core:verify-head` when it is no longer
wanted.

**T7 is verifiable before it is set.** The condition consuming `DESIGN_PIPELINE_V3_CHATS` was inline
in a database-dependent path, so nothing proved what setting it would do. `isV3PilotChat` is now
extracted and covered: a listed chat is enrolled and others are not, the list tolerates untidy
spacing, and an unset, empty or separator-only value enrols nobody.

## 23. What is left, and why I am not doing it

Four things. None is unfinished engineering; each is a decision that is the owner's to make, and
an automated check asking for them does not make them mine.

1. **Apply the deploy.** It changes what real clients receive. The image is built and verified; the command is `HAWA_BUILD_COMMIT=$(git rev-parse HEAD) bash infra/docker/deploy.sh --apply`.
2. **A qualification run in the image**, about USD 6.40. This is the run whose scores would count, and the one that would validate the judge and canary verdicts on correct typography. The path exists and its plumbing is proven.
3. **T8**, about USD 3.20 to generate v3 designs for the ten baseline briefs so the pairs compare like with like, and then the owner's ratings. The blind test is a judgement that cannot be delegated.
4. **`DESIGN_PIPELINE_V3_CHATS`** in the production environment file, which the operating rules of this project reserve to the owner.

## State after the first pass (superseded by section 24)

Typecheck clean, build clean, **1102 tests passing, 12 skipped, 0 failing** across 148 files, tracked
tree clean. The pipeline completes 20 of 20 briefs on the production models. Inside the image, the
only remaining gate failure is the structural one.

Four passes were built, measured, and deliberately not shipped: box-to-content fitting, uniform type
scaling, frame-internal balancing, and — until its band could be derived honestly — the type-based
negativeSpace measure. Three stayed out. The fourth went in once the band question was framed
correctly, and it is what stops the pipeline preferring one composition.

## 24. Second pass: the qualification did not measure production

Asked whether everything was done, I re-verified instead of recalling, and found that production's
v3 path and the qualification were different programs, and that several of the instruments were
broken. Everything below is fixed, tested and committed (`7970ac1`..`3fe5df3`). Nothing was
deployed and nothing was spent.

### What each side ran

| Stage | Qualification runner, before | Production v3 run, before | Both, now |
|---|---|---|---|
| Generation | v3 generator; palette with `#C5A059`, a gold KAAE does not use; logo shape unknown | v3 generator; no exemplars; silent fallback to the v2 generator | shared: exemplars, the client's palette, the logo's real aspect, no fallback |
| Preparation | its own font mapping | studio normaliser, logo grown to its aspect | shared `prepareGeneratedLayoutV3`: logo fitted inside its box, the normaliser, fonts and direction per block |
| Ranking | composite | — | composite, with production's hard QA as a filter |
| Critique (P05) | library, rendered as "Sample copy block N" | the v2 P4 prompt | shared, with the real copy |
| Refinement (P06) | library, called with shifted arguments: it never worked | the v2 P5 prompt | shared, with the copy, the ink measure, and forced by a QA failure |
| Judge (P07) | library, on placeholder renders; its verdict was never used | the v2 P6 prompt | shared: the pick stands only if it holds in both orders and beats the canary in both |
| QA | its own print-ready checks; "hard-QA escapes" tautologically 0 | studio hard QA | shared hard QA; escapes = print-ready but rejected by production |

### Findings, each measured

1. **The pilot switch ran v2.** `DESIGN_PIPELINE_V3_CHATS` routed a chat into the studio, whose v3 branches read only the global flag. The run now records its pipeline at creation (`7970ac1`).
2. **The judge and critic were shown placeholder text.** Without copy, the renderer draws "Sample copy block N". The qualification's P05, both P07 orderings and the canary were made on those renders. Sorani designs were shown Latin placeholders.
3. **Production's hard QA would have rejected all 20 qualified designs.** All 20 failed PALETTE (the runner's palette), 13 failed POOR_GRID_ALIGNMENT and 1 failed OVERLAP. Once prepared the way production prepares them, the overlap goes and only PALETTE remains.
4. **The alignment gate was miscalibrated.** It rejected three of the owner's six confirmed exemplars (0.542, 0.600, 0.667 against 0.70). Its threshold was justified with the v3 metric's exemplar scores, which is a different measure. Counting centre-axis alignment fixes it: all six exemplars pass, `BAD_OFF_GRID` still fails (0.600), and the qualified rejections fall from 13 to 0 (`5aff5dd`).
5. **The generator was never told the logo's shape.** Five of the 20 winners reserved boxes 1.15–1.55 wide for a square emblem, and production grew each box downward to square. The logo is now fitted inside the box, and the prompt states the aspect.
6. **The generator prompt had three errors.** It called every non-square canvas "4:5", recommended Lora (not admitted), and recommended Cairo for titles (it cannot draw Sorani).
7. **The refinement engine scored on box area while ranking used ink**, and its receipt merged two calls without token counts.
8. **The client sent `reasoning_effort` to every model it was asked to.** The dev tier's judge and critique model rejects the whole request.
9. **The office's daily spend ledger held only test spend.** 2026-09-17 held $19.76 and 2026-09-18 held $32.93, all simulated calls from the governor's tests; real runs never recorded. Today's fake $32.93 would have made the qualification refuse to start (`2d88553`).
10. **T8 could not have produced a result.** The scorer crashed on its last line, invented a judge that always preferred v3, assumed v3 was on side B for unknown pairs, and read blank rows as ties. Its pairs set each v1 design against an image of an unrelated brief, some from a harness that made no model calls. Its seed was a fixed string in the source (`9e15cac`, `3fe5df3`).
11. **No build had ever type-checked a script.** The runner had 10 errors, the T8 scorer 2 and my proofs 3. `pnpm typecheck` now covers the scripts (`57f4579`).

### Corrections to my own earlier statements

- I told the owner that production could not produce any Kurdish design. **Wrong.** Production runs with the new pipeline off, and its planner forces Noto Sans Arabic onto Sorani text. The deck bug was real, but only in the new pipeline.
- Section 19 attributed the order-swap failures to the tournament judging its two closest candidates. The judge was shown placeholder text, so **that explanation is untested**. The 75% needs re-measuring on real renders.
- Section 22 said T7 was verifiable before being set. The test proved the list parsing, not the routing.
- I said the candidate distances were never recorded. The runtime object has the field and would have recorded them; only the declared type was wrong.
- Section 23 said nothing left was code I could write. This section is that code.

### Verified in this pass

- A pilot chat's v3 run goes end to end through the real studio service against the isolated database. It makes no concept call, stores the critique, both orderings and the canary, labels candidates with the generator's archetypes, and transfers.
- The qualification dry run against a local stand-in completed 20 of 20 briefs with 140 calls, every stage recorded once per brief, and the office ledger untouched. The compare-set dry run completed 10 of 10. The in-image `--check` passes, and the deploy pre-flight exits 0.
- T8 from end to end on scratch material: package, rate, score. The four refusals work, and the seal catches a tampered key.

### What the qualification still does not mirror

The decision code is now shared. Four inputs and stages cannot be, and a qualification result
should be read with them in mind:

- **The brief text.** Production derives the generator's brief line and the exemplar query from its
  brief stage (a model reading the Telegram request). The qualification's briefs are already
  structured, so it uses the brief's name and copy directly.
- **Art.** The qualification runs no art stage. None of the production-model winners in the last run
  requested art, while the cheap tier's sometimes did.
- **Transfer and parity.** The qualification stops at the design. The Canva import, the deck
  encoding and the parity check are covered by the studio's end-to-end test (6b) with Canva mocked,
  not by a live run.
- **Bilingual direction** was a fifth: production described any design containing Sorani as RTL, and
  the qualification described any design not wholly Sorani as LTR. The prompt now takes the direction
  from the copy itself, and states "Mixed" for bilingual copy on both sides.

## 25. Cheap-tier runs on real models: what they exposed and what was fixed

The owner approved cheap runs "until 100% readiness". Each run put all 20 briefs through the
shared v3 pipeline inside the production image, with o4-mini for layout, gpt-4.1-mini for
critique and judge, and fonts exact. Each run cost about USD 1.

| Run | Outcome | Production hard QA | Canary | Order-swap | Escapes | Fix it led to |
|---|---|---|---|---|---|---|
| 1 | stopped after 4–6 layout calls (at most USD 0.11, unrecorded) | — | — | — | — | the runner priced from the image's stale `src/pricing.json`; it now prices from `dist`, checks every price before spending, and never drops a paid call (`0c62d49`) |
| 2 | 20/20, 0 failures, USD 1.01 | **1/20** | 85% | 65% | 1 | the house rules QA enforces were never told to the generator or applied (`8d1e08a`) |
| 3 | 20/20, USD 0.98 | 16/20 | 100% | 90% | 1 | logo crowding on banners; lift and banner guidance (`6ce194a`, `7198ba6`) |
| 4 | 20/20, USD 1.01 | 17/20 | 100% | 90% | 0 | box growth past the safe area; house-margin fallback (`bc6e70f`) |
| 5 | 20/20, USD 0.94 | 18/20 | 100% | **95%** | 0 | rule left in the logo's clear space; fallback extended to text collisions (`98eb8d1`) |
| 6 | 20/20, USD 0.92 | 19/20 | 100% | 75% | 0 | a Kurdish banner whose footer sat on the bottom margin; settling (`5fff72b`, `ec0a323`) |
| 7 | 20/20, USD 0.90, at `5fff72b` | **20/20** | 100% | 80% | 0 | two winners with unreadable text, which QA never checked; contrast gate and recolouring (`1cbf160`) |
| 8 | 20/20, USD 0.96, at `b8c84f6` | **20/20** | 95% | 75% | 0 | confirmation: no unreadable text left and no overflow; print-ready 25%, limited by typeScale; the one canary loss was the judge picking position B in both orders |

**What run 2 exposed.** The validator stops at its first failure, so a census of every rule
across both runs' designs showed what first-failure QA had hidden:
- **Every Sorani design had Latin leading.** That was all ten of the production model's, against a house rule of 1.6–1.9.
- **Most designs put text inside the logo's clear space.**
- **Text boxes overran the safe area by a pixel of rounding.**

Four changes answer that. The house rules are now defined once (`house-rules.ts`) and read by the
validator. The generator is told them. Preparation applies them wherever the fix is unambiguous:
- Leading, tracking and title-to-body ratio are clamped to the rules.
- Off-palette colours snap to the nearest brand colour.
- Boxes are fitted inside the safe area.
- The logo is grown to its minimum and shrunk, never below it, to clear its space, moving only within its own gap.
- Vertical space is inserted where there is room, and the house-minimum margin is used when a larger one leaves none.

Refinement is now shown the QA defects that remain after preparation.

Two gate faults surfaced as well. The art rule demanded that text below the art sit inside the
art's calm region. And negativeSpace stopped treating a canvas border as a border once the studio
normaliser renamed it from frame to panel. A first, broader fix to that metric broke the P01
calibration, and its refinement test caught it.

**Why the judge numbers rose.** Runs 3–5 are the first in which the judge saw real designs, not
placeholder text. On the cheap judge the canary has held at 100% since. Order-swap consistency
swings between 75% and 95% from run to run on the same code, which describes the cheap judge more
than the pipeline.

**Settling (`5fff72b`, `ec0a323`).** Re-preparing every stored design from the runs, with no model
calls (`node scripts/proofs/reprepare_stored_runs.mjs <runDir>...`), found each mechanical QA
failure still left. Each became a regression test built from that design's own geometry and copy.
When a clash or a growing box needs vertical space, preparation now tries these in order:
- push the content below down, keeping the design's spacing;
- close the moved blocks' gaps to 3/4, then 1/2 (never under 12px, never into the logo's clear space);
- take the house-minimum margin, moving a logo on the old margin onto the new one;
- close the gaps to 1/4;
- raise the block above, using the same cascade on the mirrored layout, when nothing below can move.

Several rules hold throughout:
- Blocks keep their order.
- The inserted band moves in every column, so a body beside a title stays level with it. A logo
  moves only with its own column.
- What a block clashed with stays put.
- A panel carries what sits in it, and a logo set in a panel stays in it.
- A plan is refused if it would create a collision.

Generated art no longer names text, marks or people: the generator is told the banned words, and
preparation cuts the phrase that names one ("behind hero text"). The renders of every design the
settling changed were opened, and two faults were caught that way rather than by any metric: a logo
lifted out of its card, and a footer left at its band's edge.

**Text QA never checked (`1cbf160`, `b8c84f6`).** Production's hard QA did not check contrast. The
validator's rule runs only with an evaluator, and no caller ever passed one, the deployed QA stage
included. Measured against the surface behind each block (the topmost containing panel, else the
canvas, as the textLegibility metric does):
- 9 of the 20 T5 designs had a block below the AA ratio, one of them navy on navy throughout.
- 2–4 of every 20 cheap designs did too; in run 7, two winners had a footer at 1.00:1.
- The current production-model run had none.

QA now reports CONTRAST, and preparation recolours such a block in the brand colour the design
already uses for text that reads there. QA also never checked that copy fits its box. The renderer
centres the lines, so a two-line 84px title in a 130px box (T5 brief_17) spills onto its neighbours.
QA now reports COPY_OVERFLOW; the studio's QA stage and the runner both pass it the copy. Both checks
measure the layout as it ships. The validator's normalised copy forces the reference's script face
and right alignment onto Sorani blocks (a remnant of ADR-028, superseded for display text by the
owner's F12 policy), but the studio transfers the layout it judged. Measured on that copy, eight
Kurdish titles in Amiri overflowed only because Noto Sans Arabic sets wider.

**Measured on stored designs, no model calls.** After preparation, 157 of the 160 stored designs
from eight runs pass production QA, which now checks contrast and fit. The production-model run
passes design metrics and QA together on 20 of 20, against 0 before this work, and T5 passes QA on
19 of 20, against 0. The three left are two dev-tier designs missing a copy block and T5 brief_17,
which only refinement can repair. The gate reports no regression.

**Provenance (`5e8e246`).** Run 7 measured a build that predated the last commit made while it ran:
the image mounts `dist`, and nothing checked that `dist` matched the source. The script now builds
before every run and records the commit, and any uncommitted source changes, in `RUN_MANIFEST.json`.
A build rewrites the mounted `dist`, so nothing may be built while a run is in progress.

**What the cheap tier cannot show.** Print-ready (the design metrics) stays at 0–15% on the cheap
tier because o4-mini ignores its own declared type scale. typeScale fails 16–19 of 20 on o4-mini and
0 of 20 on the production model. The "Canva Copy & Font Checks" row counts the same failure, because
it requires typeScale too; the runner now labels that row by what it measures. That gate, and the
design quality behind it, can only be qualified on the production model.

## Final state (2026-09-18, second pass)

Branch `studio-v2`, 66 commits ahead of the deployed `4699792` (as of `b8c84f6`). Four decisions remain, and all are the owner's:

1. **Deploy.** Both pipeline flags stay off, so clients see only the robustness fixes until a chat is enrolled.
2. **The in-image qualification**, about USD 7–10: the canary now runs in both orders, and refinement adds calls when its gate opens. This is the first run that measures the decisions production makes.
3. **T8**, about USD 3.5–5 for the ten compare briefs, then the owner's ratings:
   `HAWA_QUALIFICATION_BRIEF_SET=compare bash scripts/proofs/run_qualification_in_image.sh <dir>`,
   then `npx tsx scripts/package_t8_blind_eval.ts --v3-run <dir>`.
4. **`DESIGN_PIPELINE_V3_CHATS`**, which now actually pilots v3 for the listed chat.

