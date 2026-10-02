# ADR-273: The Studio's Gates Are Calibrated on the Office's Own Posts

**Date:** 2026-10-02
**Status:** Implemented on branch `claude/gates-calibration` (from `claude/design-retarget` @ `e7aebad7`). Not deployed.
**Requirements:** FR-038 (hard QA gates what ships), FR-017 (authoritative brand identity).
**Changes a foundation:** no. There is no migration, no dependency, no model call and no prompt change, apart from the negative-space statement, which is derived from the policy.
**Plan:** item 1 of the 2026-10-02 design plan (`output/research/2026-10-02-design-and-app-ratings/DESIGN_PIPELINE_AUDIT.md`, sections 1.2 and 4), approved by the owner on 2026-10-02.

## 1. Context

The studio's gates were calibrated on two sources: Hawa's own earlier output and the owner's six typographic references. They had never been run on what the office actually publishes. The audit found that the gates penalise the office's own techniques:

- dense posters;
- tabs, bands and cards that bleed off the edge;
- photos with text set over them on a fade, plate or scrim.

The audit also found that the band poster was double-counted (ADR-271 section 7.2). The memory rule applies: a gate that rejects an owner-approved design is miscalibrated.

Two owner decisions were made on 2026-10-02:

- KAAE display titles become heavy sans capitals, as on the office posts.
- Office archive photos will feed text-only posts.

## 2. What was measured

There are twelve office posts in `packages/creative/assets/exemplars/photo*.jpg`. Each was hand-annotated as a `StudioLayoutV2` layout (`packages/creative/test/fixtures/office-posts/`, with a README). Every box was read off a 50px grid laid over the post, after scaling it to the studio canvas.

The fixtures store no client media and no new Sorani text. Where the office breaks a house safety rule, the fixture follows the rule and records the office's value in its `conformance` list (section 6).

Each post was scored in two forms, through the exact functions production calls (`fixtures/office-posts/gates.ts`):

- **As carried:** with its ADR-170 recipe record. This is the photo recipe path.
- **As composed:** the same geometry with no recipe record. This is the path a text-only KAAE poster takes (ADR-271) once office photos feed it.

The gates applied to each form:

| Gate | Function |
|---|---|
| negative space | `computeNegativeSpace` |
| alignment (hard QA `POOR_GRID_ALIGNMENT`) | `computeLayoutMetrics().alignmentScore` |
| design metrics | `evaluateDesignMetrics().passed`, including `gridAppropriateness`, with the composite |
| hard QA | `evaluateHardQa`, layout checks only (no render) |
| validator | `validateLayoutV2` |

One hard-QA check needs a render: the contrast of text over a photo, measured on the rendered pixels. It is reported apart and was not weakened.

## 3. Before and after, per gate and per post

"Carried" is the recipe form and "composed" is the form with no recipe record. Every post passed alignment (0.75–1.00), the hard-QA layout checks and the validator both before and after, so those gates are not repeated in the table.

| Post (recipe) | Negative space, carried | Negative space, composed | Design metrics, carried | Design metrics, composed |
|---|---|---|---|---|
| photo01 field visit EN (hero_fade_report) | pass → pass | **fail 0.00** → pass (photo-led) | pass → pass | **fail** (negativeSpace) → pass |
| photo02 field visit CKB (hero_fade_report) | pass → pass | **fail 0.00** → pass | pass → pass | **fail** (negativeSpace) → pass |
| photo03 why accreditation EN (hero_card) | pass → pass | **fail 0.00** → pass | pass → pass | **fail** (negativeSpace) → pass |
| photo04 why accreditation CKB (hero_card) | pass → pass | **fail 0.00** → pass | pass → pass | **fail** (negativeSpace) → pass |
| photo05 partnership EN (hero_plate) | pass → pass | **fail 0.13** → pass | **fail** (typeScale) → **fail** (typeScale) | **fail** (negativeSpace, typeScale) → **fail** (typeScale) |
| photo06 partnership CKB (hero_plate) | pass → pass | **fail 0.12** → pass | **fail** (typeScale) → **fail** (typeScale) | **fail** (negativeSpace, typeScale) → **fail** (typeScale) |
| photo07 PM meeting EN (scrim_caption) | pass → pass | **fail 0.00** → pass | pass → pass | **fail** (grid 0.50, negativeSpace) → pass (grid 1.00) |
| photo08 PM meeting CKB (scrim_caption) | pass → pass | **fail 0.00** → pass | pass → pass | **fail** (grid 0.50, negativeSpace) → pass |
| photo09 Eid greeting (sky_title) | pass → pass | **fail 0.00** → pass | pass → pass | **fail** (negativeSpace) → pass |
| photo10 forum speaker EN (cutout_speaker) | pass → pass | pass 0.565 → pass 0.565 | **fail** (regularity) → pass | **fail** (regularity) → pass |
| photo11 peer evaluators EN (fade_to_paper) | pass → pass | pass 0.478 → pass 0.571 | **fail** (typeScale) → **fail** (typeScale) | **fail** (grid 0.36, typeScale) → **fail** (typeScale; grid 0.82) |
| photo12 peer evaluators CKB (fade_to_paper) | pass → pass | pass 0.478 → pass 0.580 | **fail** (typeScale) → **fail** (typeScale) | **fail** (grid 0.30, typeScale) → **fail** (typeScale; grid 0.90) |

**Before:**

- In the composed form, 9 of 12 posts failed negative space, every one with a large photo. They measured 0.00–0.13 empty.
- 4 of 12 posts failed `gridAppropriateness` in the composed form.
- The forum post failed `regularity` in both forms.
- `typeScale` failed 4 posts.

**After:** every gate passes on every post, except `typeScale` (section 5).

## 4. Decisions

### 4.1 Negative space: policy `studio.negative-space` 2026-09-30.1 → 2026-10-02.1

All of this is in `negative-space-policy.ts` and `design-metrics.ts`.

**1. Union, not sum.** This applies to the measured-lines measure. Every element paints its weight over its area in render order:

1. shapes under the photos;
2. the photos;
3. the fades and scrims;
4. the overlay panels;
5. the logo;
6. the type.

Each point counts once, at the weight left on it. A band and the title on it are therefore one area, at the heavier weight. Type set over type still stacks, so a crammed layout of overlapping blocks stays crammed: the existing crammed-layout test failed under a pure union, at 0.765. The plane is cut at every box edge, so the result is exact for boxes; a photo's own fade enters as 16 bands.

**2. Photos can be ground.** A photo counts at its weight × its opacity × its own fade's alpha. Under a fade or scrim at least 0.55 opaque (the ADR-170 carry threshold), the photo is ground. A filled overlay panel replaces what lies under it with its own weight.

**3. A photo-led layout uses the quiet-region measure.** A photo-led layout is one in which a single framed photo covers more than half the canvas. It is measured the way an art-directed recipe is (ADR-170), whether or not it carries a recipe record:

- the title is on quiet ground: off the photo, or on a plate, card, pill, fade or scrim;
- no text sits bare on the photo;
- inked type covers at most 35% of the canvas.

A full-bleed photo is the subject, not clutter. Counted as occupied, it failed every office photo post. Under a union with the photo as ground, the photo-led office posts still measured only 0.13–0.33 empty. That is far below any floor that could still reject a crammed typographic layout. The photo-led measure is the honest one.

**4. The bands did not move.** This is the re-derivation.

| Set | Fraction under 2026-10-02.1 |
|---|---|
| Densest office post on the typographic path | 0.565 (photos 10–12 sit at 0.565–0.580) |
| Densest composed poster | 0.414 |
| Owner's six references (declared boxes) | 0.48–0.58 |
| Crammed test layout | below the 0.36 floor (it still fails) |
| Bare test layout | still fails |

So the floor of 0.36 does not bind any accepted design, and the preferred range of 0.44–0.78 holds. The audit's claim that "dense office posters fall under the floor" came from the double counting and from the photo weighting, not from the floor itself.

The studio-wide ceiling stays at 0.84. The office posts sit at or below 0.58, under KAAE's own poster ceiling of 0.65 (ADR-271). Lowering the studio-wide ceiling would reject the owner's document-like references and other clients' work, so that is left open (section 7).

**5. The declared-box fallback keeps the box sum.** The fallback is used only when no copy is supplied. Its band of 0.25–0.65 was calibrated on the sum. Under a union, 22 of the 200 stored designs cross that band, and the office posts are measured with lines. The fallback therefore keeps the sum and its band, as `combine.declared_boxes: 'sum'` in the policy.

### 4.2 Alignment: `ALIGNMENT_POLICY` `studio.layout-alignment` 2026-10-02.1 (new id)

These changes are in `layout-metrics.ts`, and hard QA reads the policy's pass score.

- **The canvas edges (x=0 and x=W) are alignment targets.** A tab, card or footer bar bleeding off the edge used to line up only by coincidence with another bleed.
- **Text on a container aligns to that container.** A container is a panel, or a fade or scrim that carries the text. The text aligns when it is centred in the container, or when it is set on the container's start or end edge at the same inset it has from the container's top (even padding).
- **The pass score stays at 0.70.**

None of the office posts failed alignment before, at 0.75–1.00. The fix is proven on the smallest office-like layout: a bleeding tab with centred caps, a title on the margin, and a pill with a centred call to action. It measured 0.583 on the base and failed hard QA. It now measures 0.917. A layout whose edges line up with nothing still fails (test).

### 4.3 `gridAppropriateness`: `GRID_APPROPRIATENESS_POLICY` `studio.grid-appropriateness` 2026-10-02.1 (new id)

These changes are in `design-metrics.ts`. What ADR-170 allowed only for photo recipes now holds for every layout:

- a frame round the canvas follows the canvas edge, so it is not counted;
- a box set on the margin is flush;
- a shape bleeding off a canvas edge (within 2px) is aligned to that edge;
- a text block is on the grid when its own alignment axis is (its start edge, end edge or centre), whatever its ragged width.

The pass score stays at 0.70. `BAD_OFF_GRID` and the three 16:9 slides still fail.

Before, every composed poster failed this metric (15 of 15), and so did one of the five guideline pages. The cause was ragged left-aligned text and bleeding bands.

### 4.4 `regularity`: a dead area is a gap "without composition"

This is in `design-metrics.ts`. The metric's own message says "without composition", but it never checked for any. Now a gap of more than 25% of the height is not dead when one of these spans the whole gap:

- a photo;
- a brand element;
- a panel or accent that is not the canvas ground.

Such a gap separates two groups of type, so it also leaves the rhythm calculation.

Generated art and anything covering the canvas do not count. A first version that counted art passed 77 more stored designs; that version was rejected.

The forum post's 392px gap beside the cut-out speaker now passes. The same gap with nothing in it still fails as `EXCESSIVE_DEAD_AREA` (test), as does the "call for kurdi" negative fixture.

### 4.5 Not changed

- **`typeScale`** holds every size to a modular scale within 1.5px. Four posts still fail it (05, 06, 11 and 12).
  - The fixture sizes are read off 864px JPEGs. The display sizes are also re-derived from the house leading (section 6). So they cannot show whether the office works on a scale.
  - One attempted fix was to take the smallest size as the base when there is no body. It passed photo05 and broke photo01, so it was withdrawn.
  - Calibrating `typeScale` needs exact sizes, for example from the office's source files.
- **`poster-grammar.ts`** was not touched. Its floor (+0.04) and its alignment threshold read the policies.
- These were also not touched: `prior.ts`, `pipeline-v3.ts` selection, `art-direction/generate.ts`, `solver.ts`, `pairwise-judge-v3.ts` and `page-grammar.ts` `guidelineDeviations`.

## 5. Measured effect

### 5.1 The 20 deterministic poster renders, plus the one photo page

These are local renders made with the ADR-271 render script. They are in the session scratchpad: `calibrate/before/`, `calibrate/after/` and `calibrate/montage_bands_before_after.png`.

| Render | Title px | Negative space | Alignment | Grid | Metrics pass | Hard QA |
|---|---|---|---|---|---|---|
| en_workshop band | 122 → 122 | 0.422 → 0.576 | 0.85 → 0.95 | 0.40 → 0.80 | no → yes | pass |
| en_workshop cream | 122 → 122 | 0.587 → 0.628 | 0.833 → 0.944 | 0.333 → 0.778 | no → yes | pass |
| en_workshop navy | 134 → 134 | 0.578 → 0.589 | 0.938 | 0.375 → 1 | no → yes | pass |
| en_workshop page | 122 → 122 | 0.541 → 0.595 | 0.885 | 0.769 → 1 | yes | pass |
| en_peer_call band | **179 → 191** | 0.454 → 0.435 | 0.90 | 0.40 → 1 | no → yes | pass |
| en_peer_call cream | 191 | 0.512 | 0.875 | 0.25 → 1 | no → yes | pass |
| en_peer_call navy | 191 | 0.512 | 0.875 | 0.25 → 1 | no → yes | pass |
| en_peer_call page | 191 | 0.503 | 0.786 | 0.714 → 1 | yes | pass |
| en_symposium band | **114 → 126** | 0.410 → 0.520 | 0.857 → 0.929 | 0.286 → 0.714 | no (grid, regularity) → yes | pass |
| en_symposium cream | 134 | 0.486 → 0.505 | 0.833 | 0.333 → 0.833 | no → yes | pass |
| en_symposium navy | 148 | 0.488 | 0.90 | 0.40 → 1 | no → yes | pass |
| en_symposium page | 122 | 0.556 → 0.593 | 0.833 | 0.778 → 1 | yes | pass |
| ckb_workshop band | 111 | 0.524 → 0.648 | 0.864 → 0.955 | 0.545 → 1 | no → yes | pass |
| ckb_workshop cream | 111 | 0.612 → 0.658 | 0.889 → 0.944 | 0.444 → 0.889 | no → yes | pass |
| ckb_workshop navy | 134 | 0.640 → 0.650 | 0.938 | 0.375 → 1 | no → yes | pass |
| ckb_workshop page | 114 | 0.581 → 0.631 | 0.885 | 0.692 → 1 | no → yes | pass |
| ckb_peer_call band | **infeasible → 148** | → 0.414 | → 0.90 | → 1 | → yes | → pass |
| ckb_peer_call cream | 148 | 0.492 | 0.875 | 0.50 → 1 | no → yes | pass |
| ckb_peer_call navy | 148 | 0.492 | 0.875 | 0.50 → 1 | no → yes | pass |
| ckb_peer_call page | 122 | 0.561 | 0.786 | 0.714 → 1 | yes | pass |
| en_photo_report page_photo | 78 | (recipe) | 0.833 | 1 | no (regularity) → no (regularity) | pass |

**Design metrics:**

- Before, 0 of 15 composed posters passed the design metrics (`metrics.passed`). Now 15 of 15 pass.
- All 20 text-only renders pass. Before, 4 of 5 pages passed and every poster failed.
- The ranking among posters no longer rests on composite differences between failures (audit section 1.2 item 6).

**Hard QA:** every render still passes.

**The band posters:**

- The band no longer counts twice, so the composer's floor lets the band title grow:
  - "Call for Peer Evaluators" 179 → 191px;
  - the symposium 114 → 126px.
- The Sorani peer-call band now composes. ADR-271 section 7.2 had left it infeasible because it was "too dense for the studio's floor".

**Seen in the renders, and not caused by this ADR:** in the symposium band, the sunburst runs under the details card. This is the composer's free-corner bug (audit section 3, item 1). It belongs to the `poster-grammar.ts` owner.

### 5.2 The stored corpus

The stored corpus is the existing calibration on real work: 200 designs, run through `prepareGeneratedLayoutV3` in the gate's four production modes, with no model calls. It was compared design by design, base against this branch.

**After preparation:**

- No design newly fails any design metric or any hard-QA code.
- Newly passing:
  - `gridAppropriateness`: 38 designs;
  - negative space: 7;
  - `regularity`: 14.
- Designs passing QA and metrics together:
  - plain: 37 → 37;
  - ornament: 37 → 38;
  - style: 20 → 20;
  - grammar: 35 → 35.

**Before preparation (raw):** one design newly fails negative space: `cheap-tier-run7/brief_12`, a full-width band with type on it, at 0.793 → 0.817, past the taper. Preparation still passes it, at 0.788.

**The gate itself:** `pnpm gate:prepare` cannot see the corpus from this worktree, so it was run against the main checkout's corpus. Its committed `gate-baseline.json` is already stale on the base, with 108 designs "worse than the baseline" before this change. This branch adds 10 entries of the form `new metric:regularity`. They are artefacts of how the gate attributes failures: the raw design now passes `regularity` because its gap is composed, while the prepared design fails it exactly as it did on the base. The baseline was not re-recorded.

### 5.3 Tests

- **New:** `packages/creative/test/office-posts-gates.test.ts` (23 tests).
  - Every office post passes every gate, in both forms. The excepted metric is `typeScale`, which is pinned as still failing on 05, 06, 11 and 12.
  - The regression record states what each gate rejected before.
  - Each fix is shown on the smallest layout that needs it, with the base's value stated: union 0.639 → 0.742; a photo under a fade; the photo-led measure; alignment 0.583 → 0.917; grid 0.40 → 1.00; a composed gap.
  - The negative cases still fail.
- **Updated, with the reason stated in each test:**
  - `negative-space-policy.test.ts`: the digest of the new version, the prompt statement, and the version in the span-semantics test.
  - `kaae-poster-compositions.test.ts`: the Sorani workshop posters keep the same titles and geometry but now read emptier, at navy 0.653 → 0.664, cream 0.626 → 0.698 and band 0.563 → 0.681. The bound moves from 0.66 to 0.70.
  - `apps/core/test/design-studio-orchestrator.test.ts` (6b, dev and production): the winning composed poster now passes the design metrics, so the gated revise stage makes no critique call (`DesignCritiqueReport` is no longer requested). That is one paid call fewer per text-only KAAE design, and the composition is no longer handed to a model to redraw. The critique judgement is still recorded, as a skip.
- **Suite results:**
  - `npx vitest run packages/creative/test apps/core/test`: 425 files passed and 4 skipped; 4911 tests passed, 5 skipped, 0 failed.
  - `pnpm -s typecheck` and `pnpm -s lint` pass.

## 6. Where the office breaks a house safety rule (kept, recorded for the owner)

The fixtures follow these rules, and each post's `conformance` list gives the office's value. None of these rules was weakened.

| Rule | What the office does | Posts |
|---|---|---|
| Safe margin, 64px (6% of the short side) | Text at 50–62px; logo 15–55px from the edge; URLs 25px from the foot | all |
| Leading: Latin 1.2–1.5, Sorani 1.6–1.9 (`LINE_HEIGHT`) | Display caps at about 0.85–1.15. The fixtures keep the office's line boxes, so their display type is 20–30% smaller than the office's (plan Phase B item 6) | 01, 02, 04, 07, 08, 10, 11, 12 |
| Text over a photo needs a carrier (ADR-170) | URLs bare on the photo; the Eid greeting bare on a bright sky | 05, 06, 09 |
| Logo clear space: house 0.5× its height, or the client's K height if larger | Date column about 40px from a 100px logo | 10 |
| No brand element under copy (`ORNAMENT`) | The date set on the sunburst | 10 |
| Declared contrast; palette | An antique gold title on cream (about 3:1), not in the palette | 03, 04 |

## 7. Open

- **Owner decisions.**
  - Display leading for caps; the house leading rule is plan Phase B item 6 and needs a native Sorani review.
  - Whether the house safe margin and logo clear space should follow the office's or the guideline's tighter values.
  - Whether a brand element may sit under copy when the copy's contrast on it is measured.
  - Whether to lower the studio-wide negative-space ceiling for all clients. The office posts sit at or below 0.58. The owner's six references are document-like and much emptier.
- **`typeScale`** needs exact office sizes.
- **The Sorani workshop posters** (short copy) now read 0.66–0.70 empty. That is above KAAE's poster ceiling of 0.65, because the composer cannot fill them. This belongs to the `poster-grammar.ts` owner.
- **`gate-baseline.json`** is stale on the base. Re-recording it is a separate, deliberate step.
- **The render-only contrast check** for text over a photo needs real office photos to calibrate. The fixtures carry boxes only.
- **No live run** was made, and nothing was deployed.
