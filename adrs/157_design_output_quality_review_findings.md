# ADR-157 — Design output quality: review findings, chosen photos, measured contrast

Date: 2026-09-30
Status: implemented on `claude/fix-design-quality`; not deployed. Owner review needed before the
judge prompt change is treated as qualified (FR-057, below).
Requirements: FR-034, FR-038, FR-039, FR-041, FR-057.
Sources: audit 2026-09-30 items #16, #17, #18, #19, #20 and the P2 design items; the production
KAAE report-cover draft of 2026-09-30 (1080x1350, six photos), rebuilt from its render as
`packages/creative/test/kaae-draft-quality.test.ts`.

## Context

The KAAE draft passed hard QA with a subtitle ending "…and next steps toward", six photos placed
because the validator refused anything else, a 100x80 logo in a 232px band, a panel text stack 50px
from the panel top and 90px from its bottom, and a door photo cropped through its sign. The judge
that chose it never saw the brief. The negative-space and balance metrics could not see the photos,
and the hard contrast gate never looked at rendered pixels.

## Decisions

1. **Copy completeness is a review finding, never a gate (#16).** `copy-completeness.ts` is pure:
   a block ending on a closed-list English or Sorani word that cannot end a phrase (a block ending
   in "?" is exempt), brackets or quotes that do not pair, and copy that arrived as a caption at the
   1024-character limit when the origin is known. Hard QA returns them as `findings`
   (`severity: 'warning'`) beside `defectCodes`; the studio stores them on `stages.qa` and the office
   note shows them ("check before approving: …"). The Canva planner records them in its manifest as
   `reviewFindings`. A finding moves the choice only as a tie-break: at equal composite in ranking,
   and when the judge did not decide (`composite_after_tie`, `composite_judge_unreliable`), the
   candidate with fewer findings goes first. Copy-level findings are the same for every candidate,
   so in practice it is font substitution that separates them. Why not a gate: the copy is the
   client's, "toward" may be deliberate, and only the requester can supply missing words; asking at
   intake belongs to the intake stream. The caption-origin flag is not recorded anywhere on this
   base, so that check is wired but idle until intake records it.
2. **"Choose the best photos" (#17).** `photoSelectionFromInstructions` reads the requester's own
   words, English and Sorani, deterministically, with no model call: `all` (default) or `choose`
   with a minimum (a stated count, else half the photos rounded up). The brief stage records it on
   `stages.brief.photoSelection`, so a directed change inherits it with the parent brief. In
   `choose` mode the validator accepts a distinct subset of at least the minimum, the layout prompt
   says the model may choose, hard QA returns `omittedPhotos`, the office note lists them, and the
   requester is no longer told "Only 4 of your 6 photos are on the design" for a choice they asked
   for. No new requester wording was added. The brief contract still records every photo as client
   content; its enforcement is the validator, which now honours the recorded choice.
3. **The judge reads the request, with no call added (#18).** The incumbent pairwise judge now
   receives the requester's instructions and the exact copy (as data) in each of its four existing
   calls, and both judge protocols get the brief from the service. Images go at `high` detail for
   patch-priced judge models (gpt-4.1-mini, production's judge on both tiers; o4-mini) and stay
   `low` otherwise. Cost: the reservation already prices a patch model's image at its full patch
   count whatever the detail, so no reservation grows. Worst case, if `low` had been honoured as a
   512px image, full detail adds about 3,900 input tokens per call, 15,600 per design at $0.40/M:
   about $0.006 per design. No separate absolute brief-compliance call was added; the deterministic
   findings above cover the copy case the audit reproduced, at no cost.
4. **Photos are content in the metrics (#19).** Negative-space policy `2026-09-30.1` counts a
   framed photo's whole box (a cut-out 0.6 of it) as occupied and as a span; balance weighs photos
   by the same share. Generated art is still not counted. The generator is told the new definition.
5. **Re-spacing photo designs and panels (P2).** `centerPanelStacks` centres a panel's text stack
   (two or more blocks, with the rules between them) as one rigid unit on its measured lines; panels
   holding a photo or touching the logo's clear space are left alone. `fitLogoBand`, for photo
   designs only and not for a reference's spread composition, moves the content to the logo's clear
   space and re-centres the whole composition between the margins. Both keep a change only if it
   adds no layout defect, overlap, art calm-region breach or newly failing metric.
6. **Crops follow the photo (P2).** `fitPhotoBoxesToImages` re-divides a row of framed photos
   towards each photo's own aspect, keeping the row's ends, gaps, height and minimum sizes, and only
   when the row crops away less; a crop shorter than a detected face costs extra. There is no text or
   saliency detector and none was added: protecting lettering in a photo (the door's sign) needs one
   and is future work.
7. **Hard QA measures the render that ships (#20).** `evaluateHardQa` takes the no-text composite
   and holds every block to its 5th-percentile contrast sampled under its own measured lines, not
   only to the declared colours. The QA stage renders the winner (art, photos, logo) for this;
   ranking and the edit stage pass their own composites. The art stage still defers CONTRAST for v3,
   and the final QA now re-checks it on pixels. An unreadable or unavailable render is recorded as a
   `CONTRAST_UNMEASURED` finding, never a silent pass.
8. **Font substitution is a finding (P2).** A text face the renderer reports as `stand-in` is a
   `FONT_SUBSTITUTED` warning finding at QA and in the office note, not only a console line.
9. **Mixed-script copy and missing languages (P2).** A copy block whose lines are in two scripts is
   split, when the studio run is built, into one block per run of lines, so each part gets its own
   face and direction; single-script blocks are untouched byte for byte. Instructions naming a
   language no line of the copy is written in produce a `LANGUAGE_MISSING` finding.

## Consequences and limits

- The re-prepare gate over the stored 2026-09-18 corpus gives identical results with and without
  these passes (that corpus has no photos). `gate-baseline.json` is already stale at 6bd479c1: 109
  designs are "worse than baseline" with or without this change.
- FR-057: the judge prompt and the layout prompt changed. The per-run degraded canary still guards
  the judge; no offline paid replay was run. The owner decides whether to run one before deploy.
- A revision of a design made before this change, whose copy has a mixed-script block, sees a
  different block count; it falls back to designing afresh, as a refused edit already does.
- Not done: asking the requester (intake stream); showing the planner path's `reviewFindings` on
  the Desk or in the outcome notice (Desk and the outcome route belong to other owners); a text or
  saliency detector for crops.
