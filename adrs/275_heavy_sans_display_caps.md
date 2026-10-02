# ADR-275: Poster Display Titles in Heavy Sans Capitals (Engine Layer)

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/display-caps` (from `claude/design-retarget` @ e7aebad7).
Not deployed, and not yet wired into the poster composer (section 6). Two items are open: the
Canva proof (section 7, written, not run) and a native Sorani review of the display leading.
**Owner decision:** 2026-10-02. KAAE poster display titles become heavy sans capitals, as in the
office's own published posts (`packages/creative/assets/exemplars/photo01`-`photo12`). The
guideline's serif stays for document pages.
**Requirements:**
- FR-015: approved copy is compared normalization-aware;
- FR-017: authoritative brand identity;
- FR-028: live, editable source;
- NFR-009: Sorani exact copy and native visual review.

**Changes a foundation:** no. There is no migration, no new dependency and no model call. Inter
ExtraBold and Black were already bundled under the OFL.
**Amends:**
- ADR-271, for the poster title face; its compositions are unchanged;
- ADR-118, whose native measurement protocol takes a weight;
- ADR-209, whose verified font names gain Inter's weighted family names.

## 1. Context

The design-pipeline audit of 2026-10-02 (output/research/2026-10-02-design-and-app-ratings,
section 1.1 rows a-c, section 2 rows 1-3, section 4 items 5-6) found three gaps.

First, the engine could not set the office's display type:
- a text block had only `bold` (`layout-v2.ts`), and the renderer emitted only bold or normal;
- Inter ExtraBold and Black shipped in `assets/fonts` but were not registered;
- nothing could set capitals, neither in the layout nor in the Canva deck;
- the exact-copy check (`checkCanvaPptx`) would have refused "PEER REVIEW WEEK" for typed "Peer
  Review Week".

Second, display leading was a fixed ratio for every role: Latin 1.2-1.5, Arabic script 1.6-1.9
(`house-rules.ts`, enforced as LINE_HEIGHT). The office's caps titles run at about 0.95-1.0, and its
Sorani titles at about 1.3-1.4.

Third, the research (DESIGN_10_RESEARCH.md sections 3-4) sets the type rules:
- Latin capitals are tracked 0 or slightly negative at display size, and +5-12% as small labels;
- Arabic script is never letter-spaced and never given fake capitals or italics;
- a face must cover the script per file: Cairo-Regular lacks the Sorani letters ڕ ڵ ۆ ێ ە.

## 2. Decision: weight and capitals on the text block

`TextElement` gains two fields (`layout-v2.ts`):
- `fontWeight?: 100..900` (CSS numbering). It wins over `bold`. Absent, `bold` reads as 700 and its
  absence as 400 (`textFontWeight`), so every older layout keeps its face.
- `textTransform?: 'uppercase'`. It is Latin only: `uppercaseApplies` ignores it on a right-to-left
  block or on copy with Arabic-script letters, and the validator drops it from Arabic-script blocks.

The zod schema admits both. The model's layout schema in `layouts.stage.ts` does not offer them:
only the composer's measured display policy sets them.

## 3. Decision: measure and draw the same weighted file, in capitals

- **Font registry.** `render-fonts.json` declares Inter `extraBold` (800) and `black` (900).
  fc-scan matches them as family "Inter" at weights 205 and 210. `fonts.conf` already lists the
  folder; a comment there now records the weights.
- **Measured file.** `fontFileFor(..., weight)` returns the file of the nearest declared weight,
  with ties broken as CSS breaks them. Examples: Inter 800 is `Inter-ExtraBold.ttf`; IBM Plex Sans
  Arabic 800 is its Bold; Cairo is its Regular. A block without `fontWeight` resolves exactly as
  before. `elementFontFace` returns the file, its OS/2 weight and its name-ID-1 family ("Inter
  ExtraBold").
- **Drawing.** The renderer asks rsvg for the weight the measured file declares
  (`font-weight="800"`), so fontconfig opens that file and never synthesises a weight. This follows
  the font-rendering-traps memory.
- **Native measurement.** The pango helper (`native/text-measure.c`, protocol 1) accepts a CSS
  weight in its bold argument (0, 1, or 100-1000). `measurePangoText` passes it, and it is in the
  cache key only when set.
- **Capitals.** Measurement, wrapping, fitting, the ink metrics and the SVG all use
  `displayedCopy(t, copy)`, the capitals, and accent words are uppercased with it. The measurement
  record keeps `copySha256` of the copy as typed. `inputSha256` gains `fontWeight` and
  `textTransform` only when they are set, so existing receipts are byte-identical.
- **Fidelity.** A render's `fontFidelity` map gains a verdict per weighted face ("Inter 800"),
  from the ink check drawn at that weight (`weightedFontFidelity`; `probeFontInkWidth` takes
  `fontWeight`). Hard QA's substituted-face finding reads that key (`fontFidelityKey`).
- **Labels.** A capitals eyebrow keeps its label tracking: the old eyebrow clamp (over 0.06 becomes
  0.04) applies to mixed case only.

## 4. Decision: the copy stays exact

The stored copy is never changed. The deck sends the copy as typed and adds `cap="all"` to every
run of a capitals block. `withCapitals` finds the block by its object name, `Caps text <i>`, and
the copy stays live and editable in Canva.

Only blocks set in capitals are compared without regard to case:
- **The PPTX check.** `checkCanvaPptx` takes `uppercaseByIndex` and is now check version 10. A
  flagged block passes when its text, or its text drawn under `cap`, equals the copy in capitals. So
  either way Canva may hand it back passes: as typed under `cap="all"`, or with the capitals written
  into the text.
- **Every other block** is compared exactly, as before. It now also fails when a `cap` run would
  draw capitals the requester did not type.
- **`shownTexts`** reports each object as drawn.
- **The PDF check.** `checkCanvaPdf` takes the same policy. A PDF's text layer holds the drawn
  capitals.
- **Core.** The plan's text entries record `textTransform`, `fontWeight` and `fontFace`. Core
  reads `textTransform` (`importedSourceCapitals`) into the frozen export policy, the stored-row
  re-check (`evaluateCanvaExportQc`) and the PDF capture. A plan without capitals passes no policy,
  and its checks are unchanged.
- **The weighted face in the deck.** It is named by its own family name ("Inter ExtraBold") with
  bold off; a regular or bold file is sent as before (`deckFontFace`). The verified names for Inter
  gain its weighted family names, so a round trip of "Inter ExtraBold" counts as Inter.

## 5. Decision: display leading and caps tracking

The house rules become role- and size-aware (`house-rules.ts`: `displayLineHeight`,
`lineHeightRange`, `capsTracking`, `capsTrackingRange`):
- A **display block** is a title at 0.06 of the width or more.
- **Latin display** may go down to 0.95, up to 1.5.
- **Sorani display** may go down to 1.3, but only when the measured ink of each pair of its lines
  keeps 0.02 em apart. `measureLineInkClearance` lays each line out with the block's own file
  (fontkit applies the face's mark positioning), places it across the box by its alignment, and
  compares every glyph's ink box with every glyph of the next line that shares columns with it.
  Measured on 2026-10-02, fontkit's line ink equals pango's to 0.1 px for the Sorani title. Without
  the copy, a Sorani block under 1.6 fails as unproven. A Latin block under 1.2 is held to the same
  check whenever the copy is at hand.
- **Body and every other role** keep the old ranges. The fields `HOUSE_RULES.lineHeight.latin` and
  `.arabic` are unchanged, so every reader of them is too.
- **Capitals tracking.** A display block takes -0.03 to 0 em. A label (0.035 of the width or less)
  takes 0.05 to 0.1 em: the research's 5-12%, capped at the house's 0.1 em maximum. Arabic script
  always takes 0.
- **Validator.** LINE_HEIGHT applies the range and the ink check, and LETTER_SPACING the capitals
  tracking. The validator measures the ink itself when its context carries `copyText`. Hard QA,
  `layouts.stage`, `edit.stage` and `revise.stage` now pass it.
- **Preparation.** `conformToHouseRules` keeps a display block's leading only when the block carries
  the display style (`fontWeight` or `textTransform`), which only the composer sets. A model's
  block is still held to the body range.
- **Edits.** A requester edit or style spec that takes the bold off drops a contradicting weight.
  The edit model's answer keeps the weight and capitals it did not mention.

## 6. Decision: the poster display policy, and what the composer still has to do

`kaae-reference.json` `rules.pageGrammar.poster.display`:
- **Latin:** Inter 800, uppercase, leading 0.98, tracking -0.01.
- **Arabic:** IBM Plex Sans Arabic 700, leading 1.35.
- **Labels:** tracking 0.08.
- **Guideline title:** Crimson Pro stays for document pages.

`page-grammar-admission.ts` admits the policy. It refuses:
- a weight not in 100..900;
- leading outside the display ranges;
- any case transform or tracking on Arabic script.

`posterDisplayStyle(grammar, script)` (`poster-display.ts`) returns the style. It throws
`PosterDisplayFaceError` when the face's file cannot draw the script's required characters
(render-fonts.json): Cairo for Sorani is refused, and a test pins it. `posterLabelStyle` and
`withPosterDisplayStyle` complete the helper.

`poster-grammar.ts` is not edited here: another branch is fixing composer bugs in it. The wiring it
needs:
1. **Title style.** In `el()` (`poster-grammar.ts:193`), for `kind === 'title'`, return
   `withPosterDisplayStyle(element, posterDisplayStyle(g, b.arabic ? 'arabic' : 'latin', { fontsDir: input.fontsDir }))`.
   `measure()` (`:187`) goes through `measureTextGeometry`, which now measures the capitals in the
   weighted file. The title size search (`:117`) therefore fits the real display type, with no other
   change. This replaces the 1.2 / 1.6 leading (`:195-196`), the `g.title.fontFamily` face (`:199`)
   and the title tracking (`:200`).
2. **Labels.** For `kind === 'label'` on Latin copy, spread `posterLabelStyle(g)` (capitals, 0.08
   em) in place of `g.header.label.letterSpacing`.
3. **Sorani leading.** Under 1.6, call `lineInkClears(measureLineInkClearance(el, copy))` once the
   title is set. If it fails, step the leading up by 0.05 toward 1.6 rather than dropping the
   composition. Hard QA and the validator refuse a collision anyway.
4. **Catch the face error.** Wrap `posterDisplayStyle` so that a `PosterDisplayFaceError` makes the
   composition infeasible (`GrammarInfeasibleError`), not an exception.
5. **Title size.** The audit's 1.1c (a title over 0.18 of the width) is the reference's
   `titleSizeShare.max`. It is untouched here: raise it to 0.2 when wiring if the owner wants
   "PEER" at the office's size.
6. **Prose.** The `artDirection` and `colorUsage` prose in kaae-reference.json still says "a bold
   serif title". It goes to model prompts, so change it in the same commit that wires the composer,
   not before.

## 7. Proof

**Local render**, made with no model, no Canva and no network:
`scripts/proofs/display_caps_proof.ts <outDir>`, run into the session scratchpad
(`displaycaps/`).

| Render | What it shows |
|---|---|
| `en_caps_title.png` | Inter ExtraBold at 216 px (0.20 W), leading 0.98, three lines, PEER in KAAE Blue. Ink between lines is 0.25 em; validator OK; `fontFidelity` gives Inter 800 as exact. |
| `ckb_display_title.png` | IBM Plex Sans Arabic Bold at 112 px, leading 1.35, two lines. Clearance is 0.248 em; validator OK; Plex 700 is exact. |
| `ckb_display_title_too_tight.png` | The same at 1.0. The marks visibly meet, the measured gap is -11.4 px, and the validator refuses it. |

Measured clearance at 1.3 depends on the copy. The ADR-271 Sorani workshop title keeps only 0.042
em in Plex, which is why the gate is a measurement rather than a ratio.

These are host renders. Inter and Plex probe exact on this host, but per the font-rendering-traps
memory, the native Sorani review should look at an in-image render.

**Canva proof plan:** `plans/2026-10-02-canva-display-caps-proof.md`. It covers one import of the
fixture deck, one PPTX and PNG export, and the checks with the plan's policy. It is not run.

**Tests:**
- `packages/creative/test/display-caps.test.ts`, 24 tests;
- `packages/qa/test/display-caps-copy.test.ts`, 6 tests;
- `packages/qa/test/canva-pdf-check.test.ts`, one new test;
- `apps/core/test/display-caps-core.test.ts`, 3 tests;
- `packages/qa/test/pptx-script-fonts.test.ts`, updated for check version 10.

**Open:**
- the composer wiring (section 6);
- the Canva proof (section 7);
- a native Sorani review of 1.35 leading and of IBM Plex Sans Arabic Bold as the display face. The
  research notes there is no black-weight Sorani face in the set.
