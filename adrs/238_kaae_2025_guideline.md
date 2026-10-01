# ADR-238: KAAE Designs Follow the 2025 Guideline (Excellence Edition)

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/kaae-2025-guideline` (from production `baffce10`, which carries ADR-236 and ADR-237); not deployed. The production DNA row is a separate step for the lead after deploy (section 9).
**Requirements:** FR-017 (versioned authoritative brand identity), FR-013 (the design brief carries the requester's requirements), FR-023 (a design plan cites the rules it used), FR-038 (hard QA gates what ships).
**Changes a foundation:** no. No migration and no new dependency. Font files are added as assets: Crimson Pro (OFL) and Inter Italic (OFL). No paid call is added per design: the composed pages are set with no model call, and a typographic run still judges three candidates.
**Supersedes:** ADR-236's palette, fonts and rules. ADR-236's light-first logic is kept: the tone words, the lightest fallback ground, ground snapping, the light and dark recipe variants, and the dark exception. ADR-236 is marked "Superseded by ADR-238".
**Number:** 238, assigned by the lead.

## 1. Context

On 2026-10-01 the owner handed over KAAE's official brand guideline: "Brand Guidelines — Excellence Edition" (2025, 17 pages, file `KAAE_Guidelines4.pdf`). It is a client document and is not committed. Its rules are encoded in `packages/creative/assets/kaae-reference.json`, which cites the file, the edition and the guideline's printed page numbers.

**The older brand book is withdrawn.** The owner said "remove the old brand guide everywhere, fully". That book is "BRAND GUIDLINES.pdf", which ADR-236 applied the same day. Its values were:

- indigo `#17087A`, royal indigo `#3833A3`, bright blue `#0F73DE`;
- gold `#E8B85C`, cream `#FFF2DB`;
- a pure-black ink;
- the typeface "Minion Variable Concept".

The stale DNA line "Midnight Navy (#160874) with Sun Gold (#E8B85C) and Academic Royal (#35309B)" goes with it.

None of these values stays in active code, configuration, data, prompts, learning or tests. They survive only in dated history: the applied migration 009, `output/**`, `evidence/**`, dated plans, and the ADR texts.

What the 2025 guideline says, page by page (read from the rendered pages):

- **p.0, the cover.** A navy gradient runs from KAAE Blue at the top left to Midnight. The logo is centred, the title is a white serif, a short gold bar sits under it, and a gold letter-spaced subtitle follows.
- **pp.1-15, every content page:**
  - a white page with generous margins;
  - a small logo at the top left, and a letter-spaced KAAE Blue section label at the top right;
  - a thin grey rule under them, whose left part is a gold gradient segment;
  - a bold old-style serif title in KAAE Blue, with a short gold gradient bar under it;
  - an italic lead in KAAE Blue (Inter Italic), and body text in Midnight Inter (`#0A1628`, measured on the rendered pages);
  - rounded cards with soft shadows: white, KAAE Blue with white text and a gold card title, or a cream/blush tint with a gold left edge;
  - stat cards with big gold serif numbers;
  - a Blue→Gold gradient rule at the foot.
- **pp.3-6, the logo.**
  - Clear space is the height of the K.
  - Minimum width is 20mm in print, 80px on screen, and 16px for a favicon (simplified mark only).
  - Never stretch, rotate, recolour, add effects or shadows, use on busy backgrounds, or change the typeface.
- **pp.7-8, colours.**
  - Primary: KAAE Blue `#4770A3` (Pantone 5415 C) and KAAE Gold `#F7B500` (Pantone 7549 C).
  - Extended: Midnight `#0A1628`, Royal `#1E3A5F`, Ocean `#2C5282`, Sky `#4A90E2`, Cream `#FDF8F3`, Sun `#FFD700`.
  - Gradient applications Blue→Gold. Measured on the pages: the title bar runs Gold→Sun→Gold, and the foot rule Blue→Royal→Gold→Sun.
- **pp.9-10, typography.** The text says "Verdana" for display and body. The pages themselves are set in a serif, with Inter. The Kurdish page sets a bold sans, right-aligned, with the gold bar under the title's right end.
- **p.13, elements.** A quarter-disc sunburst with five rays, in navy or grey, and a triangle mosaic fading upward, in navy or blue.

## 2. Decision: palette and colour rules

`rules.palette`, light first:

- White `#FFFFFF`
- Cream `#FDF8F3`
- KAAE Blue `#4770A3`
- KAAE Gold `#F7B500`
- Midnight `#0A1628`
- Royal `#1E3A5F`
- Ocean `#2C5282`
- Sky `#4A90E2`
- Sun `#FFD700`

The fallbacks are background White, text Midnight and accent KAAE Blue.

`colorUsage` is rewritten from the guideline, including its composition grammar, so the layout model, the reviewer and the judge read the same rules. The art-direction rules are re-pointed in the same way. The photo-only rules start "With photos:", so a typographic design is not judged against a hero-photo rule. The judge said exactly that in the first live trial.

**Gold is never text on white or cream** (about 1.9:1, under WCAG):

- The guideline's gold stat numbers are set on navy cards, or in KAAE Blue on white.
- A gold card title on a KAAE Blue card is Sun `#FFD700` (3.7:1), because KAAE Gold reads at 2.8:1 there.

The withdrawn indigo is refused by hard QA's PALETTE rule, in a fill or a gradient stop.

## 3. Decision: typography (owner: follow the look, not the "Verdana" text)

**Titles: Crimson Pro.** It is admitted through the font registry. Static Crimson Pro 1.003 Regular, Bold and Italic (OFL) are added to `assets/fonts` and declared in `render-fonts.json`.

- **Fidelity.** The fidelity probe draws it `exact` (ink width within 2% of fontkit on the pinned rasteriser). A test holds that.
- **Look.** Compared on the guideline's headings, Crimson Pro is closest to them. Crimson Text is equally close. EB Garamond is narrower, and Lora is rounder.
- **Lora is not a fallback.** It has no font file here, and the registry aliases it to Playfair Display.
- **Canva availability is not verified live.** The Canva connector was not authorised in this session. A substituted face in Canva would still be caught by the export check (`CANVA_FONT_MISMATCH`).

**Leads and body: Inter.** Inter is now declared in the registry: Regular, SemiBold and Bold (the 4.0 TTFs already here) and Italic (Inter 4.0 `Inter-Italic.otf`).

- Before this, Inter was drawn with no entry, so its italic and bold resolved to the Regular file.
- Inter is body rank 2, behind Verdana, so no other client's default changes.

**Kurdish/Sorani (p.10): admitted sans faces.** KAAE's admitted display faces are now the guideline's:

- Latin: Crimson Pro and Inter;
- Sorani: Noto Sans Arabic and IBM Plex Sans Arabic (the bold sans of p.10; Amiri, a naskh, is not).

`packagedAdmittedDisplayFonts` passes them to hard QA, as it does for a DNA client.

## 4. Decision: the guideline's grammar as layout primitives

**The schema** (`layout-v2.ts`):

- A shape can carry `gradient` (an angle and two to eight stops) and `primitive`, which is one of `header_rule`, `header_accent`, `title_bar`, `card`, `card_edge`, `foot_rule` or `cover_ground`.
- A layout can carry `ornaments` (sunburst, triangle pattern) and `composition` (`page` | `cover`, with a variant).

**The grammar** (`page-grammar.ts`) is data. `kaae-reference.json` `rules.pageGrammar` holds every colour, face, proportion, card and gradient, and shared code names no client.

- **Primitives:** `headerPrimitives`, `titleBarPrimitive`, `cardPrimitives`, `footRulePrimitive` and `coverGroundPrimitive`.
- **`composeGrammarLayout`** sets a whole design from them, measured with the renderer's own text measurement, on one declared major-third type scale:
  - the guideline's page, with its details on a KAAE Blue card or a white card and a call to action on a cream card with a gold edge, optionally with one photo in a rounded card;
  - or its cover, centred with the triangle band, or on the start side with the sunburst.
  - The header rule sits just outside the logo's clear space.
  - A Sorani page is right-aligned, with the bar under the title's right end and the header unchanged.
- **`conformToPageGrammar`** restyles a layout the model drew. It has two parts:
  - **Type, before preparation fits boxes.** Latin title in Crimson Pro, the first subtitle as the italic lead, Inter body, and Sorani faces restricted to the admitted ones.
  - **Marks, after.** Tagged primitives get the grammar's fills, gradients, radius and shadow; the title bar and foot rule are added where they fit; a dark design gets the cover's gradient ground where every block still reads on it.
- **Preparation** leaves a composed design whole, as it does a solved recipe: only the fonts and the palette are re-applied. With a grammar, the generic brand ornament (sun-rays texture and gold dividers) is not added, because the grammar's own marks replace it.

**Editable in the transfer** (`transfer-v2.ts`):

- Every primitive is a native, named shape: "Header rule", "Header gold segment", "Title bar", "Card", "Card edge", "Foot rule" and "Cover ground".
- pptxgenjs cannot write `a:gradFill`. The deck is written with flat fills, and each gradient shape's fill is then replaced with a native `<a:gradFill>` (`a:lin`, `scaled="1"`) in the slide XML (`withGradientFills`, fflate). The shape stays one editable shape with its gradient.
- The preview draws the same gradient (`gradientUnits="objectBoundingBox"`). The contrast model reads the colours under each block's corners and centre.

**Brand elements** (`brand-elements.ts`):

- The quarter-disc sunburst (five rays) and the triangle mosaic (rows fading toward one edge) are vector art generated from geometry.
- The preview inlines them. The deck places the same markup baked to a transparent PNG, named "Sunburst" or "Triangle pattern".
- `assets/elements/*.svg` hold the reference assets, and a test keeps them equal to the generator.
- Validation (`ORNAMENT`) refuses one under copy, in the logo's clear space, off the canvas, or off the palette.

## 5. Decision: who uses the grammar

- **Typographic briefs.** The layouts stage first composes two variants of the guideline's page, or two of its cover when the brief is dark ("an announcement cover", an evening, "navy"). The model's three layouts follow, restyled to the grammar, and the run keeps three candidates.
  - No call is added: the composed candidates need no model.
  - The layout call is also given the grammar in words (`pageGrammarPrompt`). The model can tag shapes with primitives (a nullable `primitive` in its schema), and the system prompt explains them without naming a client.
- **Photo briefs.**
  - The solver sets light concepts in the grammar's faces and colours and adds the grammar's marks where they fit.
  - `fade_to_paper` on white is the guideline's own page: the header, the title and its bar, the lead, the photo in a rounded card with a soft shadow, the details on cards, and the foot rule.
  - When the model chose no such concept, `solveConcepts` turns the last light concept into it.
- **The visual review (ADR-237)** keeps a composed design's colours when they meet the house minimum: "raise contrast" turned the Sun card title white in the first live trial.
- **Design metrics** count Inter as an admitted body face. Before this, an Inter body was scored as an "F12 violation", which the judge read as a typeface-pairing failure, and Crimson Pro as an admitted display face.

## 6. Decision: the logo rules in hard QA (pp.3-6)

| Rule | Enforced by |
|---|---|
| Minimum 80px digital | The validator's LOGO check: the stronger of the reference's 80px and the house's 100px or 8% of the canvas, so 100px applies. The DNA reader now accepts a client minimum down to 16px (it refused anything under 100). |
| Never stretched | The validator's 1% aspect check. |
| Clear space = height of the K (0.15 of the logo box, measured on the official PNG: 404 of 2687 px) | `logoConstraints.clearSpaceShareOfHeight`. The validator and hard QA take the strongest of it, the pixel rule and the house's half-height, which is larger and so decides. A cover composed from the grammar keeps the K alone (section 11). |
| Nothing enters the clear space | Text and rules: the validator's LOGO check. New `LOGO_CLEAR_SPACE` covers accents, card edges and cards reaching into it. New `ORNAMENT` covers brand elements. |
| No effects or shadows | New `LOGO_EFFECT`: a shape with a drop shadow holding the logo. The logo itself is the official file in a box; nothing can recolour or rotate it. |
| Never on a busy ground | New `LOGO_BUSY_GROUND`. With a render, it measures the luma deviation of the clear-space ring on the no-text composite, over 0.12. A recipe instead reads its ADR-180 record: a bare logo on a busy ground fails, and a scrim or tab is the permitted lift. |

## 7. Light-first logic, re-pointed

- `resolveSurfaceTone` gives the white page unless the requester names cream, because the guideline's pages are white.
- A dark ground is Midnight: `toneGroundHex` and `brandTones` read the new palette.
- New dark occasion words cover the guideline's cover: "cover page", "cover design", "as a cover", "announcement cover".
- "Indigo" is no longer a requester tone word.
- The requester phrases for the guideline ("as per the brand guidelines", "like the brand's book") still give the white page.

## 8. Proof

**Live, on the real `gpt-6.1-sol`.** `scripts/kaae_2025_guideline_live_trial.ts` is ADR-237's harness: Telegram intake, the lifecycle projection, then `DesignStudioService` on v3 with the production tier, against a throwaway clone of the test template DB. There is no Canva, no Telegram and no production database. Evidence is in `plans/kaae-2025-guideline/LIVE_PROOF.json`. The images are kept outside the repository because the photo brief shows a client photo.

**Mocked, through the real stages.** `apps/core/test/kaae-2025-guideline.test.ts` runs the real layout stage, preparation, render, ranking and hard QA with the layout model mocked, for:

- the workshop poster;
- the cover;
- the evening invitation;
- the one-photo report;
- the owner's dark-navy K-12 wording.

**Regression tests:**

- `packages/creative/test/kaae-2025-guideline.test.ts` (38): palette, fonts, primitives, gradients in the preview and the deck, the composer, grammar admission, logo rules, brand elements, light first, the solver page, and the model's schema and prompt.
- `apps/core/test/kaae-2025-guideline.test.ts` (11).

These replace the two ADR-236 test files.

**Red on `baffce10`.** The new test files were run there, with the modules the base lacks stubbed out:

- creative: 33 of the first 34 tests fail. The one that passes is the asset check, which is vacuous with the stub.
- core: 10 of 11 fail. The one that passes guards ADR-236's lightest-fallback logic, which the base already has.

**Regression gate.** `scripts/proofs/reprepare_stored_runs.mjs` has a new `grammar` mode, recorded in `gate-baseline.json`. Over the 200 stored designs:

- grammar mode: 159/200 pass QA;
- plain mode: 160/200 on this branch against 161/200 at `baffce10`. The one design is refused by the new LOGO_CLEAR_SPACE: an accent in the logo's clear space.
- At `baffce10`, the gate already reports 109 regressions against its 2026-09-20 baseline.

**Prompt size.** On the live runs, the layout call's input grows by about 700 tokens and the brief's by about 300, for the 2025 rules and the grammar's words. No call is added.

## 9. Production steps (for the lead, after deploy)

KAAE's Studio reads the packaged reference, so the design change deploys with the code. The DNA row (the Desk's DNA page and the DNA readers) needs its own update, after deploy, because the deployed reader refuses an 80px logo minimum:

1. `bash plans/kaae-2025-guideline/apply-kaae-dna-2025.sh` runs as a dry run. It GETs the active DNA and builds the payload:
   - it replaces `colors`, `fonts` and `guidelines.layoutRules`;
   - it replaces the logo assets' `minimumWidthPx`, `allowedBackgrounds` and `prohibitedModifications`, by role, keeping ids, hashes and keys;
   - it replaces `brand.colors`, `brand.fonts` and `brand.layoutRules` when present;
   - it maps every other withdrawn colour to its 2025 colour;
   - it sets `canvaMapping.canvaBrandKitId` only if `CANVA_BRAND_KIT_ID` names a new 2025 kit.

   It prints every changed path and every withdrawn word left, which must be none. Nothing is sent.
2. `--apply` POSTs the new, unapproved version, then re-records model consent (ADR-234), then prints the consent state. It refuses while anything withdrawn is left.
3. **By hand, in Canva.** Update KAAE's brand kit to the 2025 palette and fonts. Upload Crimson Pro if Canva's library lacks it. Then, if a new kit is made, re-run step 2 with `CANVA_BRAND_KIT_ID`.

## 10. Consequences

- **Saved runs.** A run created before deploy carries the old reference hash, so its next stage refuses with `CLIENT_REFERENCE_CHANGED`.
- **The judge still chooses, within the guideline.** Since section 11, a composed design that passed hard QA is overruled only by a clear margin. Before it, in the live trial the judge preferred the model's own restyled layout for the text-only brief. That layout was on the grammar: white page, header, serif title, gold bar, italic lead, a card and the foot rule. For the photo brief it chose the guideline page. See LIVE_PROOF.json for which candidate won each run.
- **Not done here.**
  - The Desk (`apps/desk/**`, Codex's) still loads Cairo, Noto Naskh and Playfair in places. The handoff is in `plans/kaae-2025-guideline/INVENTORY.md`.
  - The Canva brand kit and the production DNA row wait for section 9.
  - Client DNA learning rows in production cannot be changed by SQL; the handoff is in the inventory.

## 11. Follow-up (2026-10-02): the guideline decides unless the judge clearly disagrees

**Why.** In proof (c) the judge chose the model's restyled cover over the guideline's own composed covers. That cover was a flat Midnight panel laid on the gradient, which the guideline's cover never has. The composed cover's title also sat low: the composer kept the house's logo clear space (half the logo's height, 162px on the centred cover) rather than the guideline's (the height of the K, 49px).

**Selection.** This reuses ADR-170's tie-break prior (`art-direction/prior.ts`) rather than adding a mechanism.

- `guidelinePrior(a, b, deviations)` prefers a design composed from the client's page grammar (`layout.composition`) over one that is not. Between two that are not, it prefers fewer departures from the grammar.
- `guidelineDeviations(layout, grammar)` (page-grammar.ts) names each departure:
  - a flat dark panel on the gradient cover;
  - a dark design with no gradient ground;
  - a light page missing the header rule and its gold segment, the title bar or the foot rule;
  - a Latin face outside the grammar's.
- `selectWinnerV3` takes `pageGrammar` (passed by `runJudgeStageV3` from `ctx.pageGrammar`). The judge then sees the best composed candidate against the best other one, in rank order, rather than the top two. The favoured design wins unless the judge chose the other with a clear margin in both presentation orders (`judgeClearMargin`: at least 0.75 of the votes, or of the weighted votes on a photo brief, so four of five) and then passed its canary.
- The decision is recorded as `decidedBy: 'art_direction_prior'` with `prior: { basis: 'guideline', reason, instead }`. `instead` is the new `judge_without_clear_margin`, or `composite_after_tie` / `composite_judge_unreliable` as before.
- `humanChoiceRecommended` is false for `judge_without_clear_margin`: the client's guideline decided, not an uncertainty. It stays true after a tie or a failed canary.
- Without a page grammar nothing changes.

**The judge and the visual review.** `guidelineFidelityRule(grammar)` is appended after the client's house art-direction rules, so their R-numbers hold. `houseRulesFor(ctx)` in v3.stage.ts feeds it to the pairwise judge, the ADR-237 visual review and the refinement judge. The rule says that the departures above count against a design in brand fit. It fits the judge's 240-character limit for one rule.

**Clear space.** `logoClearZone(logo, clientPx, { clientOnly })` and `usesGuidelineClearSpace(layout)` (house-rules.ts) apply only to a layout whose `composition.grammar` is `cover`. The composer, the validator, hard QA (`logoRuleDefects`) and the logo-ground pass then use the client's clear space alone. Pages, model layouts and every other client keep the stronger of the house and client rules. The minimum width is unchanged: the house's 100px decides over the guideline's 80px. On 1080x1350, the composed covers' titles move from y=700 to 618 (pattern) and from 549 to 496 (sunburst).

**Proof.**

- Regression tests:
  - `packages/creative/test/kaae-2025-guideline-selection.test.ts` (12): prior, deviations, clear margin, selection with a scripted judge (3-2 keeps the composed cover; 4-1 lets the judge decide; no grammar keeps the old behaviour), the fidelity rule in the judge and review prompts, and the cover clear space in the composer, validator and hard QA.
  - Two tests added to `apps/core/test/kaae-2025-guideline.test.ts`: `houseRulesFor`, and the real judge stage on an evening invitation keeping the composed navy cover against a 3-2 judge.
- Red on 4c95154a (source reverted, tests kept): creative 10 of 12 fail (the two that pass are guards: the judge picking the composed cover, and the 100px minimum); core 2 of 13 fail (the two new ones).
- Live, real `gpt-6.1-sol`, $0.33 of the $0.80 allowed (LIVE_PROOF.json `followUp`):
  - live8: the model cover failed hard QA (CONTRAST), and the judge chose the composed sunburst cover in both orders.
  - live9: all three passed. The judge saw the guideline pair (composed pattern cover against the model cover) and chose the composed cover 3-2 in both orders, so the prior was not needed.
  - The winner is the composed cover in both runs.
- **Desk.** `StudioJudgeNotice.tsx` (Codex's) words `art_direction_prior` as an art-direction tie-break. A `prior.basis` of `guideline` should read as "the client's guideline decided". This is handed off in CODEX_MERGE_NOTE.md.
