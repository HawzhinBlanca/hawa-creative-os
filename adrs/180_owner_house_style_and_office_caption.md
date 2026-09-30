# ADR-180 — Office house style over default photo coverage; no box behind the logo; the office photo-alert caption and title

Date: 2026-09-30
Status: implemented on `claude/house-style-fixes` (from production `38f84442`); not deployed.
Requirements: FR-025, FR-026, FR-028, FR-038, FR-039, FR-041.
Supersedes: the parts of ADR-171 named below. Amends: ADR-170 (logo carrier), ADR-155 addendum (office photo alert).

## Owner decisions, 2026-09-30 (verbatim)

1. The owner was shown a live draft built as a three-photo collage. ADR-171 produced it: choose mode
   keeps a default minimum of half the photos, and "a recipe cannot authorize omission". They were asked
   "Which should designs follow: office house style (one strong hero photo, sometimes a second blended in
   the fade) or show more photos (collage)?" The owner answered: **"office house style"**.
2. On the same draft the owner said: **"current design has logo background"**. The logo sat in a heavy navy
   square box. They do not want that.

## Decisions

### 1. House style wins over default coverage

- `recipePhotoMinimum` (`packages/creative/src/studio/photo-selection.ts`) is the only rule for how many
  photos an art-direction recipe must place. Only the requester's own words bind:
  - "use all the photos" (`insisted`, and now also a stated count that covers every photo) binds all;
  - a stated count ("pick 3", `counted`) binds that count.
- Choose mode with no stated count ("you don't have to use all the photos, choose the best ones") no
  longer carries a half-the-photos minimum. The recipe's hero, plus an optional blended texture, is the
  choice.
- Photos sent with no choose or all wording follow the house rulebook (hero first). The photos left out
  are recorded in hard QA's `omittedPhotos` and the office note, as they were under ADR-170.
- `eligibleRecipes`:
  - `hero_storyboard` (the collage) is offered only when the bound minimum is 2 or more;
  - texture recipes are offered for a bound 2;
  - single-hero recipes are offered only for a bound 1.
- The validator, hard QA, the status note and the art director's prompt all read the same rule.
  - The prompt's line is now `REQUIRED PHOTOS`.
  - The system prompt again puts the client's house rules first.
- A layout outside a recipe keeps ADR-157's rule unchanged: `choose` keeps its minimum, and `all` means
  every photo.

**Superseded from ADR-171:** "`choose` preserves its recorded minimum" and "Recipe metadata and model text
grant no authority to discard inputs", but only insofar as they bound recipes to the uncounted minimum or
to all photos without explicit wording. The rest of ADR-171 stands:

- the bijection between received images and brief image reports;
- the per-image reports in requester notes;
- `hero_storyboard` for explicit coverage;
- the selection passed into generation, solving and QA;
- visible holds.

### 2. No box behind the logo

- **Source.** The navy square came from `heroStoryboard()` in `art-direction/solver.ts`. It was a navy rect
  exactly the logo's clear-space box, drawn whatever lay under it, and was added by ADR-171. That was the
  recipe the owner's draft used. ADR-170 round two also gave every recipe a cream tab whenever the logo
  touched a photo (`backLogo`). Both are removed. The solver sets the logo bare.
- **Pixels decide.** `settleLogoGround` (`art-direction/logo-ground.ts`) runs in Core's layouts stage for
  every solved recipe. No model call is made. Each try renders only the clear-space box, with and without
  the logo, and reads two measures:
  - the logo's contrast on its ground: the 95th percentile over the pixels the logo changes, so that its
    lettering and outline must read;
  - the ground's busyness: the luma standard deviation under the logo box.

  It then tries each of these in turn:
  1. Keep the logo bare when the ground is calm (≤ 0.12) and the logo reads (≥ 3:1, or 90% of its own
     contrast on white).
  2. Else try the mirrored top corner, if no copy, face or half-covered panel is there.
  3. Else use the lightest soft radial scrim that makes it read:
     - centre opacity 0.45, 0.65, then 0.85;
     - cream on a pale ground and navy on a dark one;
     - no larger than the clear-space box.
  4. Only then use a thin cream rounded tab: the logo plus 7% of its height.

  The result is recorded as `artDirection.logoGround`. `hero_card`'s wordmark tab is the recipe's own
  surface (rulebook item 4), and is kept.
- **New overlay form.** Layout-v2 gains `direction: 'radial'` for overlays. It is rendered as an SVG
  radial gradient and baked into its own PNG for Canva, like the other scrims.
- **QA.** A new hard-QA defect, `LOGO_BACKING`, fires when anything behind the logo reaches past what it
  may cover (`logoBackingExcess`):
  - a scrim may cover the clear-space box and no more;
  - a solid tab may cover the logo plus at most 0.4 of its height on each side.

  The navy square filled the whole clear-space box, so it now fails.

### 3. Office photo-alert caption

- The draft's photo caption ended "Approve or send it back in Hawa Desk on the office computer". Office
  members now approve in Telegram (ADR-040 addendum).
- The caption's last lines now come from the catalogue: `office.draftAlertDecide`, in English and Sorani.
  The Sorani is marked for native review in SORANI_REVIEW.md. The English reads: "Reply to this picture
  with "approved" to send it to {requester}, or say what to change. You can also decide in Hawa Desk."
- Both languages are shown, because an alert goes to every office member before any of them has written.
- The Sorani says «پەسەندە», a word the office approval reader already accepts.
- This is the one catalogue phrase allowed to name a reply target. The owner asked for it, and office
  members are not requesters.
- The text alert keeps the Hawa Desk wording. It goes without the picture, or from an older worker, and
  approving in Telegram requires the picture that member was sent.
- In named-reviewer mode (ADR-064) the caption keeps the Hawa Desk wording.

### 4. Title named once

- `chat-campaign-intake` titled tasks "<Client>: <first line>". The owner's line was
  "‏KAAE K-12 Pilot Study", with a right-to-left mark (U+200F) before it, so the office read
  `"KAAE: ‏KAAE K-12 Pilot Study…"`.
- Leading direction marks are now stripped from the title (never from the copy). A first line that
  already starts with the client's name or acronym, as whole words, is not prefixed again.
- The caption formatter applies the same rule (`withoutRepeatedClient`) to tasks titled before this change.

## Verification

- Every behaviour change has a test that fails on the base sources and passes after:
  - 16 tests across 10 files fail before;
  - the log is in the branch's report.
- The KAAE six-photo brief ran through `apps/core/test/art-direction-e2e.test.ts` with a mocked layout
  model:
  - with the owner's six album photos, the recorded selection (choose, minimum 3, no count) ships
    `hero_fade_report`: hero photo 0, crowd texture 4, logo on a faint cream scrim, hard QA passed,
    omitted `[1, 2, 3, 5]`;
  - the base shipped the three-photo storyboard with the navy square.
- The before/after image is kept outside the repo (`house_fix_before_after.png`, the lead's scratchpad).

## Cost

No model call is added. Each logo settle renders the clear-space box two to fourteen times, about
0.3–1.5 s per candidate.

## Consequences and limits

- The owner's own words, not a default, now decide coverage. A requester who wants every photo must say
  so. The office sees what was left out.
- The thresholds (3:1, 0.12, 90% of native) were calibrated on the owner's six album photos and synthetic
  grounds. They are not yet qualified on the archive.
- The logo moves only between the two top corners; other placements are left to the recipe.
- Sorani caption lines await native review.
