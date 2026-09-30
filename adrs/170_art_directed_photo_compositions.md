# ADR-170 — Art-directed photo compositions: recipes, a solver, and text on photos

Date: 2026-09-30
Status: implemented on `claude/art-direction` (merges `claude/art-judge` and `claude/photo-exemplars`);
not deployed. The layout model's live answers are not yet measured: the lead runs the paid trials.
Requirements: FR-025, FR-026, FR-028, FR-038, FR-039.
Sources: the owner's verdict on the KAAE K-12 draft (2026-09-30: "the images are all just set there
one by one, no creative techniques used"); the office reference sheet (12 published designs, example
3 being the designer's own version of the same brief); the house art-direction rulebook distilled from
~20 of the office's photo designs; the audit of 051d5606 in the build brief.

## Context

For a brief with photos the layout model placed each photo as a box, and every rule around it
enforced a grid: every photo placed, no text or logo on a photo, no overlap, no bleed, photos at
least 22% a side, `settlePhotos` re-seating them in a row, refinement freezing them, and metrics that
counted a full-bleed photo as clutter. The office's own designs do the opposite: one hero that bleeds
off the canvas, a second photo at most blended into a navy fade, and the title on the fade, a plate
or a card.

## Decisions

1. **Recipes, not coordinates.** A closed set of named compositions, shared by every agent:
   `hero_fade_report`, `hero_card`, `hero_plate`, `scrim_caption`, `sky_title`, `cutout_speaker`,
   `fade_to_paper`, `typographic` (`art-direction/recipes.ts`). For a brief with photos the layout
   call is an art director: it chooses, per concept, a recipe, the hero, an optional texture photo,
   the slot of every copy block (title, gold accent line, body, CTA pill, meta, footer), gold words
   within a one-block title, and bounded parameters (fade share, surface tone, frame, alignment). It
   writes no coordinate. The system prompt is byte-stable and names no client; the client's house
   rules come in the request as data (R1..R10, from `rules.artDirection` in its reference).
2. **A deterministic solver** (`art-direction/solver.ts`) turns a concept into a StudioLayoutV2 for
   any canvas (tested at 1080x1350, 1080x1080, 1920x1080 and 1080x1920) in both directions. Type is
   measured with the renderer's own wrapping; the title and body take the largest sizes that fit the
   recipe's text zone at the house leading and 2.2x ratio; the fade, plate or card is then sized
   around the text. Crops centre on the face detector's point, else the photo's measured detail. A
   small landscape photo is not blown up to fill a tall canvas. Sorani text mirrors to the right in
   the same boxes; photos never flip. The solver checks its own output (safe area, logo clear space,
   overlaps, declared contrast) and throws `RecipeInfeasibleError` rather than force a layout; a
   concept it cannot carry is replaced by the house default of another eligible recipe.
3. **Layout-v2 grows, compatibly.** Optional fields only: `artDirection` (recipe, title zone, hero,
   texture, omitted photos, direction), `overlays` (gradient fades and scrims), shape `layer:
   'overlay'`, `fill: 'none'`, `surface` and `shadow`, photo role `texture` and `opacity`. A layout
   without them renders, validates and transfers exactly as before.
4. **Renderer z-order:** background, art, shapes, photos, overlays, overlay shapes, logo, text. A
   plate or card casts a soft shadow (an SVG filter); a stroke-only frame paints only its band.
5. **Text on a photo is allowed only on a carrier, and only when measured.** In a recipe, the
   validator admits a text box over a photo only when a filled overlay panel contains it or an
   overlay is at least 55% opaque over all of it (`art-direction/surfaces.ts`). Hard QA then holds
   it to ADR-157's measured-pixel contrast; without a rendered composite, text over a photo is a
   CONTRAST defect. Outside a recipe every old photo rule stands.
6. **Photo choice.** A recipe's own choice of hero and texture counts as choosing unless the
   requester insisted on every photo (`PhotoSelection.insisted`, read from "use all the photos" and
   the Sorani equivalent). A stated count ("pick 3") binds the recipe; the half-the-photos guess made
   when none is stated does not. Omitted photos are recorded on `artDirection` and in hard QA's
   `omittedPhotos`, and the office note lists them.
7. **Metrics and passes do not punish a recipe.** Negative space becomes a quiet-region check for a
   recipe (title inside its zone, no bare text on a photo, type under 35% of the canvas). Legibility
   reads the same declared surface as the gate. Preparation, `settlePhotos`, the photo-box fitter,
   the Core face/cut-out/head passes and model refinement leave a solved recipe alone (refinement
   reports `recipe_not_refined` and spends nothing).
8. **Photo review with no new call.** The brief call already sees every image; its `imageRoles`
   gain `subjectFit`, `shot` and `quietArea`, and the brief gains `subjectTags` for the exemplars.
   A local analysis (rsvg-convert and pngjs, both already in the repo) measures sharpness (Laplacian
   variance), the calmest third and the centre of detail. Hero ranking combines them.
9. **Canva stays editable.** The hero is a native picture cropped by `srcRect` (re-croppable); each
   fade or scrim is its own transparent PNG above it, so the photo can be swapped; a texture photo
   is its own alpha-faded PNG; plates, cards, tabs and pills are native shapes (shadow as
   `outerShdw`, named for Canva's layers); a frame is a zero-alpha fill with a gold line; text is
   native.
10. **Judge and exemplars.** The judge branch's `houseRules` receive the client's rules, and a
    candidate with no recipe and only plain framed photos is marked `baseline`; the weighted totals,
    checklist and baseline are persisted with each order. Photo briefs retrieve up to three office
    photo exemplars by photo count, subject tags and eligible recipes; each is named with its recipe.

## Cost

One layout call, as before. Measured on the KAAE brief by prompt size: the art-director prompts are
~3.7k text tokens against ~5.3k for the typographic call; six photos at 1024 px and high detail add
about 5k image tokens (ADR-149's native count, 1,768 tokens for a 1080x1350 image, scaled by pixel
count); the answer is ~0.6k tokens of JSON against ~2.9k. At Sol's $2/$10 per million: about +$0.006
input, about -$0.023 output. The brief adds about 150 output tokens (+$0.0015), the judge about
+$0.003 (judge branch). Refinement is not run on recipe layouts. Net: at or slightly under today's
~$0.60 per design. Paid trials must confirm it.

## Consequences and limits

- Uppercase titles are not applied: copy is set exactly as written.
- `cutout_speaker` is solved and tested with a synthetic cut-out size; it has not been rendered with
  a real matted person in this change.
- Changing `kaae-reference.json` changes the KAAE reference hash: runs created before it must be
  re-planned (`CLIENT_REFERENCE_CHANGED`), as with any reference change.
- The layout model's recipe choices are unmeasured until the lead's paid trials.

## Addendum: paid live trials (2026-09-30, branch `claude/art-direction-trials`)

`scripts/art_direction_live_trial.ts` runs the owner's KAAE K-12 album (task ba4469f2's caption and
its six photos) through Telegram album intake, the lifecycle projection and `DesignStudioService` on
pipeline v3 with the production models (`HAWA_MODEL_TIER=production`: Sol for brief and layout,
gpt-4.1-mini for the judge), against a throwaway clone of the test template database, and stops
when the run is ready for Canva. Five paid runs: $0.331 in all, 6 calls and $0.058-0.079 a design
(the ADR's ~$0.60 estimate was high), about 80 s each. Runs 3-5 used a local container of the
production cut-out image for faces; runs 1-2 had none.

- The layout model proposed the same three concepts every time: `hero_fade_report` (the library
  photo as hero, the crowd photo blended into the fade: the office's example 3), `scrim_caption` and
  `hero_plate`. The recipe and hero choices were sound.
- The cut caption no longer reaches the Studio as cut: intake asks for the rest (ADR-160) and, with
  no answer, opens with the two finished lines.

Fixed on this branch, each with a regression test that fails before the fix:

1. **The office's layout never reached the judge.** Composite ranking counted a recipe's gold frame
   and corner logo as off-grid, so `hero_fade_report` ranked last in all four runs and the judge
   compared the other two. Grid appropriateness now leaves a recipe's frame out and counts a box set
   flush on the margin as aligned (`design-metrics.ts`).
2. **A title plate across two faces.** `hero_plate` put its plate in the upper third whatever the
   photo showed. The solver now maps the detected face through the hero's cover crop, moves the plate
   below it, and refuses any recipe whose copy, plate or logo would cover it.
3. **"Field Visit Report" at body size.** With the two-line copy the model slotted the report's name
   as body. A short line beside the title that the brief calls a subtitle is now the gold accent line.
4. **A face that was not there.** The face service answers the centre, with no face height, for a
   photo with no face; that centre was taken for a face ("faces found", and a centre crop instead of
   the measured detail). Only a point with a face height counts now.

Still open, not fixed here: the gpt-4.1-mini judge is position-biased on these pairs (two of five
runs were ties decided by composite, which prefers the centred plate), and it reported "photos tiled
in a grid" for single-photo designs; landscape album photos (1280x853) are enlarged about 1.6x to
fill the portrait canvas in `scrim_caption`, `hero_plate` and `hero_card`; titles are not set in
capitals as the office sets them (copy is set as written); body text is about 2.6% of the width
against about 3.3% in example 3; and the logo sits on the photo with no carrier.
