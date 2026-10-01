# ADR-236: KAAE Designs Follow the Brand Guideline, Light First

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/kaae-light-guideline` (from production `3726c8c6`); not deployed. The production DNA row is a separate step for the lead after deploy (section 6).
**Requirements:** FR-017 (versioned authoritative brand identity), FR-013 (the design brief carries the requester's requirements), FR-023 (a design plan cites the rules it used).
**Changes a foundation:** no. No migration, no new dependency, no new paid call per design. The requester's tone is read with no model call.
**Builds on:** ADR-127 (client packs and palette-only colours), ADR-170 (art-directed photo recipes), ADR-180 (house style), ADR-234 (model consent on a new DNA version).
**Supersedes, in part:** the KAAE palette of 2026-09-14 (`2aec0bc3`, from the 13 September review), which replaced the guideline's palette with a navy set.
**Number:** 236, assigned by the lead.

## 1. Context

The owner decided on 2026-10-01: the "Brand guideline PDF" palette, light first.

The guideline ("BRAND GUIDLINES.pdf", 11 pages, Drive "KAAE Stuff"; read page by page for this ADR):

- 7 pages are white pages under an indigo-to-black header band, 3 are full indigo, and the cover is cream with a navy band.
- The palette page lists `#E8B85C`, `#4770A3`, `#FFF2DB`, `#17087A`, `#3833A3` and `#0F73DE`.
- Its body text and headings on white pages are pure black (`#000000`, measured on the rendered page).

The office's own posts ("KAAE Stuff/Designs", ADR-170 exemplars) are mostly light: cream cards, a gold frame, cream grid paper. Navy and indigo appear as bands, plates and tabs; gold appears only as thin frames and rules.

Production was the opposite. All 46 of the 46 recent renders had a navy ground. The causes, all in this repository:

- `kaae-reference.json` carried a navy-only `colorUsage` written for one dark invitation, ending "Never use purple, violet, indigo…". Through `studioReferenceFromRaw` it became every stage's `promotedRules`.
- Its `paletteFallbacks.background` was `#0A1628`. `client-design-reference.ts` took the first DNA colour with the background role, and KAAE's DNA listed midnight navy first.
- The art-direction rules said "navy for fades, plates and scrims".
- The solver set every photo recipe on `tones.navy`, except `fade_to_paper` and the cream option of `sky_title`.
- The layout prompt said "The calmRegion MUST stay dark". A layout with no ground fell back to the palette's darkest colour.
- The typographic layout call never saw the client's colour rules. It saw only what the brief chose to repeat.

## 2. Decision: the palette

`rules.palette`, light grounds first:

| Colour | Hex | Role |
|---|---|---|
| White | `#FFFFFF` | the default page (the guideline's pages) |
| Cream | `#FFF2DB` | the light page, card fills |
| Indigo | `#17087A` | primary dark: bands, plates, tabs, scrims, titles on light; the ground of a dark design |
| Royal Indigo | `#3833A3` | plates, accent lines on light |
| Blue | `#4770A3` | secondary lines, rules |
| Bright Blue | `#0F73DE` | one highlight at most |
| Gold | `#E8B85C` | thin rules, frames, the accent line on indigo; never text on white or cream |
| Ink | `#000000` | body text on light, as the guideline sets it |

The guideline shows a black ink, so the ink is the guideline's black, not the old charcoal `#1A1A1A`.

The other values follow the same palette:

- `paletteFallbacks` are background `#FFFFFF`, text `#17087A` and accent `#3833A3`. These are the fallbacks the legacy Canva planner applies to off-palette colours: a light ground with readable bold text. Gold is not readable as text on a light ground.
- `brandColors` names the eight colours.
- The indigo ban is removed.

The DNA fixture (`packages/domain/src/fixtures/kaae-client-dna.ts`) and `config/clients/kaae.dna.json`/`.yaml` carry the same eight colours. In the DNA roles, white and cream are the background colours, listed first.

`validate-layout-v2`'s PALETTE rule already reads the reference's palette, so hard QA now accepts the indigos and refuses the old midnight navy.

**A ground never snaps to the ink.** `nearestPaletteColour` maps an off-palette `#0A1628` to `#000000`. The new `nearestGroundColour` (`pipeline-v3.ts`) is used for backgrounds, panels, art scrims and overlays, and for a requested background. It snaps a neutral near-black to the brand's darkest blue. A palette with no dark blue keeps its black (ADR-127: no client named).

## 3. Decision: light-first rules

- **`colorUsage`.** Rewritten from the guideline:
  - the default page is white or cream;
  - indigo is for header bands, plates, panels, tabs and scrims, and for titles on light;
  - gold is only for thin rules, frames and the accent line on indigo, never text on white or cream;
  - body text is ink or indigo on light, white or cream on indigo;
  - an indigo page only when the brief or the photo calls for it: an evening or dark invitation, a keynote or stage screen, a dark photo hero, or a requester who asks for dark or navy.
- **`artDirection` rules R2, R3, R7 and R8.** Rewritten the same way, and R11 added for the dark exception.
- **Fallback background.** `paletteFallbacksOf` (`client-design-reference.ts`) takes the lightest DNA colour with the background role, whatever order the DNA lists them in.
- **The layout call sees the rules.** `layoutBriefV3` now includes the client's house rules (`promotedRules`) as data.
- **The layout prompt is tone-neutral.**
  - Dark text on light comes first.
  - "A light canvas is as finished as a dark one".
  - Bands on light canvases are allowed.
  - The calm region is "low-frequency and low-contrast relative to the text over it". It is no longer "MUST stay dark".
  - A candidate that names no ground is set on the palette's lightest colour.
- **Edge bands stay on the edge.** `balanceCanvasMargins` shifted a footer band bled off the bottom edge with the rest of the composition. That left a 5px sliver of page under it, which is invisible on navy and plain on white. Such a band now stays anchored.

## 4. Decision: light photo recipes, ground chosen per brief and photo

`ArtDirectionParams.paper` (`cream` | `white`) joins `surfaceTone`, where `cream` means the light page. `SolveContext.ground()` gives each recipe its background and the text colours for it:

- **`hero_fade_report`.** The fade closes to the page's paper, with an indigo title and a royal-indigo accent line. The navy variant is unchanged.
- **`hero_plate`.** The plate stays indigo. The lines below it sit on paper, or on a navy scrim.
- **`scrim_caption`.** The caption sits on a paper scrim rising over the photo, or on navy.
- **`cutout_speaker`.** The person stands on paper, or on navy.
- **`hero_card`.** The office's carousel post is already the light design (a cream card on the photo). Only its ground under the frame follows the tone.
- **`fade_to_paper` on white paper.** This is the guideline's page: an indigo band across the top holding the logo and the title, and the photo fading into the white page.

`resolveSurfaceTone` (new `art-direction/tone.ts`) decides every concept's ground in `solveConcepts`, including the fallback concepts:

1. The requester's words decide first.
2. With no words, a dark concept is kept only when the hero is dark (quiet-area luminance under 0.28).
3. Otherwise the concept sits on the light page. The model's habitual navy for a bright photo becomes the light page.

The art-director prompt's surfaceTone line says the same.

The ADR-170 judge and the house tie-break do not penalise light grounds:

- the tie-break (`artDirectionPrior`) reads only recipe and sharpness, and a test holds that a light and a dark variant tie;
- the judge's house-rule checks read the rewritten rules, which no longer name navy as the only surface;
- the contrast metrics are symmetric, and every light variant passes `checkLayout`, `validateLayoutV2` and hard QA on rendered pixels.

## 5. Decision: the requester's tone

`tonePreferenceFromWords` (no model call) reads the requester's instructions. `runBriefStage` records the result as `brief.tonePreference`, so a resume, a re-brief or a change keeps it.

- **Light.** "white", "cream", "light background", "like the brand book" or "as per the brand guidelines" (white paper), and Sorani "سپی", "کرێمی".
- **Dark.** "dark", "navy", "indigo", Sorani "تاریک", "تۆخ", or an occasion the guideline sets on indigo: "evening", "night", "gala", "dinner", "keynote", "stage screen", Sorani "ئێوارە", "شەو".
- **Not read as a tone:**
  - a colour that names the text ("white text", "dark blue title");
  - a negated tone ("not too dark");
  - weak words outside a colour context ("light refreshments", "research paper").
- **Conflicts.** A colour named with its ground ("white background", "a dark navy overlay") wins. Two colours that disagree with no ground named decide nothing.

The studio honours the preference in two places:

- `requestedBackgroundFor` sets the brand paper or indigo as the typographic ground. A model hex of the other tone gives way to it.
- The art-directed call passes `tonePreference` to `solveConcepts`.

The owner's K-12 brief ("a dark navy overlay") still gets navy.

## 6. Production DNA

KAAE's Studio designs read the packaged reference: `resolveClientDesignReference` returns `kaae-reference.json` for KAAE's client id before it reads Postgres. The design change therefore deploys with the code.

The DNA row is what the Desk's DNA page and the DNA readers show (rubric, search, the Canva planner for DNA-path clients). It needs its own update after deploy:

1. `bash plans/kaae-light-guideline-2026-10-01/apply-kaae-dna-colors.sh` (dry run).
   - It GETs the active DNA and builds the payload with only `colors` (and `brand.colors`, if the row carries them) replaced, from `kaae-dna-colors.json`.
   - It prints the diff of every other field, which must be empty. Nothing is sent.
2. `bash plans/kaae-light-guideline-2026-10-01/apply-kaae-dna-colors.sh --apply`.
   - `POST /v1/clients/<id>/dna`, which saves a new, unapproved version, so model reading closes.
   - `POST /v1/clients/<id>/dna/model-consent` with `{"expectedVersion":<new>,"mode":"approved_providers","providers":["openai"],"reason":...}` (ADR-234), which approves the next version.
   - Finally it prints `GET .../dna/model-consent`. Expect `approved` true and `modelReading.openai` true.

Both requests use the trusted-office headers of ADR-234 §5.

## 7. Consequences

- **Saved runs.** A run created before deploy carries the old reference hash. Its next stage refuses with `CLIENT_REFERENCE_CHANGED`, as after any reference change. Plan it again.
- **Prompt cost.** The layout call's prompt gains the client's house rules, about 200 tokens. No call is added.
- **Remaining habit.** The typographic layout model still chooses the ground of a text-only design with no tone words. It now sees the light-first rule, but its behaviour on the paid model is not measured here: the proofs mock it. A paid sample of text-only KAAE posts after deploy is the check.
- **Legacy surfaces not changed.**
  - `brand-kits.ts` (KAAE kit) and `kaae-graphics-learning.ts`: legacy demo data, not read by the Studio.
  - `packages/evals/src/design-studio/offline-runner.ts`: an eval fixture.
  - `config/clients/kaae.dna.json` `contentHash` and its campaign archetypes. The hash was already stale and no code verifies it; the archetypes describe historical designs.

## 8. Verification

- **`packages/creative/test/kaae-light-guideline.test.ts` (19).** The palette; hard-QA acceptance of the indigos and refusal of `#0A1628`; ground snapping; the tone words in English and Sorani, including the owner's K-12 wording; `resolveSurfaceTone`; light and dark variants of five recipes, all valid and readable; the white-page band; `solveConcepts` grounds; tie-break neutrality; the tone-neutral prompt; the lightest fallback.
- **`apps/core/test/kaae-light-guideline.test.ts` (12).** The palette and DNA fixture; `paletteFallbacksOf`; the layout brief carries the rules; requested grounds from words; the evening invitation stays indigo even when every candidate came back light; and proofs through the real layout stage, render, ranking and hard QA (layout model mocked):
  - the Quality Assurance Workshop text-only poster;
  - the evening gala;
  - a one-photo report, light by default;
  - "like the brand book", which gives the white page with the indigo band;
  - the owner's dark-navy K-12 wording, which stays navy.
- **Failing before.** The new tests were run on base `3726c8c6`, with the test files copied in:
  - the core file fails 12 of 12;
  - the creative file cannot load there (no `tone.ts`); with the new modules stubbed out, 18 of 19 fail, including the anchored band;
  - the tie-break test passes there, because it guards a property the base already has.
- **Updated tests.** Tests that pinned the old palette were updated to the guideline's: `style-spec`, `title-color`, `art-direction-e2e`, `design-studio-orchestrator`, `client-rules`, `studio-asset-resolution`.
