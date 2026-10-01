# Merge note for Codex: ADR-238 (KAAE 2025 guideline)

**Branch:** `claude/kaae-2025-guideline`, from production `baffce10` (which carries ADR-236 and ADR-237).
**Edits in `packages/creative/**` and `apps/core/src/services/design-studio/**`:** the owner authorised them for this change (2026-10-01).
**Line numbers:** base `baffce10` (`git diff -U0 baffce10`).
**Codex's branch:** `origin/codex/research-grade-design-system`, compared as fetched on 2026-10-02 at `015dcc0d`. Its merge-base with this branch is `baffce10`.
**Codex's review** (`plans/content-aware-design-2026-09-30/KAAE2025_INTEGRATION_REVIEW.md`, at `015dcc0d`):

- It reproduced three grammar inputs the first parser accepted. All three are now refused at admission: `pageGrammarFromRaw` validates the whole grammar with a zod schema, then checks palette membership.
- The refusal tests are in `packages/creative/test/kaae-2025-guideline.test.ts`, under "the page grammar is checked whole where the reference is admitted":
  - required parts present as empty objects;
  - zero, unordered or non-spanning gradient stops;
  - a non-numeric or infinite share;
  - an off-palette colour and an empty face name;
  - plus a valid grammar, and an absent one.

## Files both branches change

| File | This branch (base lines) | Codex (base lines) | Merge |
|---|---|---|---|
| `packages/creative/src/studio/art-direction/generate.ts` | 20 import; 198 options `grammar`, `logoClearSpaceShare`; 412 `solve()` passes `grammar`; 451-470 after the concept loop, the guideline-page replacement | Many, including 193, 412-419 (`solveConcepts`) | **Conflict at 412.** Keep Codex's `solveConcepts` body and supporting-photo logic. Re-add the `grammar` spread to the `solveRecipe` input, and the guideline-page block after the loop. That block replaces the last kept concept with `fade_to_paper` on white when no `fade_to_paper` was kept, and only on a light tone. |
| `packages/creative/src/studio/art-direction/solver.ts` | 19 import; 110 `SolveRecipeInput.grammar`, `logoClearSpaceShare`; 376 fonts default to the grammar's; 519 `logoClear` uses the client share; 558-568 `element()`: the grammar's accent is the lead (italic, not bold); 723-726 `ground()` → `lightColours()`; 791-795 `finish()` adds the grammar marks, plus `clientClearPx()`; 861 face check counts only overlay panels; 1256-1265 `grammarPage()`, and `fadeToPaper` on white returns it; 1323 re-export | 18, 110, 486-536, 858-887, 1231 | **Conflicts at 18-19, 110 and 858-861.** Keep both import lines and both sets of input fields. At 861, keep Codex's change and apply `sh.layer === 'overlay'` to the panel filter of the face check: a card under a photo frames it. |
| `packages/creative/src/studio/pipeline-v3.ts` | 5 import; 279 comment; 823-845 `prepareGeneratedLayoutV3`: a `composition` layout keeps its fonts and palette only; with a grammar, its type before the body passes and its marks after (the body moved into `prepareGeneratedLayoutBody`); 886 `conformColoursOnly` covers gradient stops and ornaments | 4, 790, 830-831 | **Conflict at 823-831.** Keep Codex's options. Re-apply the split: the composition guard first, then type, then `prepareGeneratedLayoutBody(...)` with Codex's body, then marks. |
| `packages/creative/src/studio/hard-qa.ts` | 13 imports; 32 `logoClearSpaceShareOfHeight`; 112 passes it to validation; 356-376 `LOGO_BACKING` uses the client clear space, then `logoRuleDefects` (LOGO_CLEAR_SPACE, LOGO_EFFECT, LOGO_BUSY_GROUND) and `clearSpaceBusyness` | 10, 13, 41, 61-63, 360-409 | **Conflict at 13 and 356-409.** Keep Codex's checks, and add the `logoRuleDefects` call after `LOGO_BACKING`. The two new functions sit before `reviewFindings`. |
| `packages/creative/src/studio/composite-contrast.ts` | 2 import; 31-50 `declaredBackgroundColour` via `declaredSurface`; `declaredTextContrast` takes the worst colour under a gradient | 5, 20, 47-50 | **Conflict at 47-50.** Keep Codex's edits and route `declaredTextContrast` through `declaredSurface` + `fillColoursUnder`. |
| `packages/creative/src/studio/layout-v2.ts` | 54 `ShapeElement.gradient`, `.primitive`, `PAGE_PRIMITIVES`, `ShapeGradient`, `OrnamentElement`, `CompositionRecord`; 200 `ornaments`, `composition`; 366 schemas; 475 layout schema | 97, 141-185, 396, 467-473 | **Adjacent at 467-475.** Keep both sets of fields in `studioLayoutV2Schema`. |
| `packages/creative/src/studio/render-layout-v2.ts` | 0 imports; 259 `ADMITTED_FONT_FAMILIES` adds Crimson Pro; 1402 shape gradient fill; 1952 cover ground, then ornaments, then shapes | 0, 256-259, 1867-1893 | **Adjacent at 256-259.** Keep both lists. |
| `packages/creative/src/studio/transfer-v2.ts` | 5 imports; 321 Crimson Pro admitted; 440-523 ornaments baked as PNGs after the cover ground, primitive object names, gradient shapes recorded; 694 `withGradientFills` after `pptx.write`; 717 `PRIMITIVE_NAMES`, `withGradientFills` | 227, 388, 694, 711 | **Conflict at 694.** Keep Codex's change and wrap the written buffer: `gradientFills.size ? withGradientFills(written, gradientFills) : written`. |
| `packages/creative/src/studio/design-metrics.ts` | 64-70 Crimson Pro and IBM Plex Sans Arabic as display faces; `ADMITTED_BODY_FONTS` adds Inter; 503 uses it | 98-134 | None. |
| `packages/creative/src/studio/validate-layout-v2.ts` | 20 `logoClearSpaceShareOfHeight`; 54 `ORNAMENT`; 101 Crimson Pro; 125 `clientLogoClearSpacePx`; 259 gradient and ornament palette checks; 613-659 client clear space, ORNAMENT rule | 231, 344 | None. |
| `packages/creative/src/index.ts` | 54 exports `page-grammar`, `brand-elements`, `shape-gradient` | 8, 19, 64 | None. |
| `apps/core/src/services/design-studio/stages/layouts.stage.ts` | 16 imports; 226-271 grammar to the art director, the generator and preparation; 297 composed grammar candidates merged first (three candidates); 435 `composedGrammarCandidates` | 235 | **Near 226-247.** Keep Codex's line and both option spreads. |
| `apps/core/src/services/design-studio/stages/v3.stage.ts` | 186 `logoClearSpaceShareOfHeight` | 17, 168-172, 403 | None. |
| `apps/core/src/services/design-studio/types.ts` | 240 `StageContext.pageGrammar` | 244 | **Adjacent.** Keep both. |
| `apps/core/src/services/design-studio/design-studio-service.ts` | 47 imports, `packagedAdmittedDisplayFonts`; 1228-1250 the packaged reference passes its admitted faces and `logoConstraints`; 1359 `pageGrammar` in the context | 2075 | None. |
| `packages/qa/src/canva-pptx-check.ts` | 15 Crimson Pro and IBM Plex Sans Arabic admitted; 336 message names the client's font | 340-371 | **Near 336.** Keep both. |
| `packages/creative/test/kaae-light-guideline.test.ts` | **Renamed** to `kaae-2025-guideline.test.ts` and rewritten for the 2025 guideline | Adds an `it.each` (content-aware recipes keep white paper) | **Port Codex's `it.each`** into `kaae-2025-guideline.test.ts`. The palette constants it uses are now `WHITE` etc. from the 2025 palette. |
| `apps/core/test/art-direction-e2e.test.ts`, `milestone1-vertical-slice.test.ts`, `packages/testkit/**` pilot and chaos files | 2025 palette and fonts; rule text "R1. With photos: …" | Codex's additions | Take both. Codex's additions should use the 2025 values (`#F7B500`, `#0A1628`, `#FDF8F3`, Inter). |
| `plans/traceability.csv` | ADR-238 appended to FR-013, FR-017, FR-038 | its own rows | Append both. |

## Semantic points for Codex's own code

- **Palette.** KAAE's palette is now `#FFFFFF, #FDF8F3, #4770A3, #F7B500, #0A1628, #1E3A5F, #2C5282, #4A90E2, #FFD700`.
  - The withdrawn values `#17087A`, `#3833A3`, `#0F73DE`, `#E8B85C`, `#FFF2DB` and `#000000` (as the ink) are refused by PALETTE.
  - `backgroundColorIndex` values that indexed ADR-236's palette now point at other colours.
- **Fonts.** KAAE's latin font is Inter, not Verdana.
  - The packaged reference now passes `admittedDisplayFonts`: Latin Crimson Pro and Inter; Sorani Noto Sans Arabic and IBM Plex Sans Arabic.
  - KAAE layouts in Verdana, Cinzel, Playfair Display or Amiri now fail FONT_NOT_ADMITTED unless the grammar restyle has run. `conformTypeToPageGrammar` maps a model layout's faces.
- **The grammar** (`ctx.pageGrammar`):
  - The content-aware recipes (`editorial_split`, `photo_diptych`, …) do not call `grammarPage` or `conformMarksToPageGrammar` yet.
  - On a light ground, they would benefit from `this.input.grammar` faces and colours, which the solver's `fonts` and `lightColours()` already give, and the marks via `conformMarksToPageGrammar` in `finish()`.
  - `finish()` adds the marks when `this.input.grammar && this.isLight() && !layout.composition`, so recipes that go through `finish()` get them.
- **Gate.** `scripts/proofs/reprepare_stored_runs.mjs` has a `grammar` mode, with its baseline recorded in `gate-baseline.json`; the other modes' numbers are unchanged.
  - The corpus run at `baffce10` already shows 109 regressions against the 2026-09-20 baseline, before this change.
  - This branch's plain mode is 160/200 against 161/200 at base. The one difference is a stored design that the new LOGO_CLEAR_SPACE refuses: an accent in the logo's clear space.
- **Reference hash.** The reference hash changes, so in-flight KAAE runs refuse with `CLIENT_REFERENCE_CHANGED` after deploy.

## Follow-up (2026-10-02, section 11 of ADR-238): selection, fidelity rule, cover clear space

| File | This branch | Merge |
|---|---|---|
| `packages/creative/src/studio/pipeline-v3.ts` | imports `guidelinePrior`, `judgeClearMargin`, `guidelineDeviations`; `PipelineV3CallOptions.pageGrammar`; `WinnerSelectionV3.prior` basis `guideline`, instead `judge_without_clear_margin`; `guidelinePair()` before `selectWinnerV3`; in `selectWinnerV3` the pair is `guidelinePair(ranked)` when a grammar is set, and the guideline block runs before `fewerFindingsFirst` | If Codex changed `selectWinnerV3`, keep its body and re-apply the two insertions: the pair line, and the `if (options.pageGrammar)` block just before the ADR-157 findings tie-break. The brief-bound challenger is untouched. |
| `packages/creative/src/studio/art-direction/prior.ts` | `basis` union adds `guideline`; new `guidelinePrior`, `GUIDELINE_CLEAR_MARGIN`, `judgeClearMargin` | Additive. |
| `packages/creative/src/studio/page-grammar.ts` | new `guidelineDeviations`, `guidelineFidelityRule`; the composer's clear zone uses `{ clientOnly: cover }` | Additive. |
| `packages/creative/src/studio/house-rules.ts` | `logoClearZone(logo, clientPx, { clientOnly })`; `usesGuidelineClearSpace(layout)` | Additive; existing callers unchanged. |
| `validate-layout-v2.ts`, `hard-qa.ts`, `art-direction/logo-ground.ts` | the logo clear zone takes `clientOnly` for a composed cover | Re-apply on Codex's lines if they moved. |
| `apps/core/src/services/design-studio/stages/v3.stage.ts` | `houseRulesFor(ctx)` replaces the three `ctx.artDirectionRules` spreads (judge, visual review context, refinement judge); `runJudgeStageV3` passes `pageGrammar` | Re-apply `houseRulesFor` wherever Codex's code passes `houseRules: ctx.artDirectionRules`. |

**Desk handoff (Codex owns `apps/desk/**`).** `StudioJudgeNotice.tsx` explains `decidedBy: 'art_direction_prior'` as the house art-direction tie-break. When `stages.tournament.prior.basis === 'guideline'`, it should say the client's guideline decided. With `instead: 'judge_without_clear_margin'`, it should add that the judge leaned the other way without a clear margin. `humanChoiceRecommended` is false in that case.
