# Office photo exemplars (ADR-170)

Twelve of the office's own published KAAE social posts, chosen on 2026-09-30 so the layout model can
learn how the office uses photos. Until now every exemplar was typographic. The owner's verdict on the
system's photo drafts (2026-09-30) was that the images were "just set there one by one". These posts
show the office doing the opposite.

## Status

Each entry in `../kaae-exemplars.json` has `status: "office-published"`: publicly published by the
office, but **not owner-confirmed**. The retrieval index admits these entries only for briefs that carry
photos. Typographic briefs still use only the six owner-confirmed exemplars and rank them exactly as
before (a test pins this). The owner can confirm any entry (`ReferenceLibraryManager.confirmReference`),
and it then joins the confirmed ranking. The owner can also drop any entry.

## Files

Sources are read-only:

- `KAAE Archives /Graphics/` (the trailing space is part of the folder name);
- `KAAE Stuff/Designs/` (the 2025 carousel and partnership posts).

Each post was downscaled to at most 1080 px on the long side at JPEG quality 85, with metadata stripped.
The dates come from each export's EXIF `DateTime`. The two carousel files have no EXIF data, so their file
date is used instead.

| File | Recipe | Lang | Photos | Source | Exported |
|---|---|---|---|---|---|
| photo01_k12_field_visit_report_en.jpg | hero_fade_report | en | 2 | kaae raphic 10.jpg.jpeg | 2026-06-09 |
| photo02_k12_field_visit_report_ckb.jpg | hero_fade_report | ckb | 2 | kaae raphic kurdi 10.jpg.jpeg | 2026-06-09 |
| photo03_why_accreditation_card_en.jpg | hero_card | en | 1 | 1 (1)(1).jpg | 2025-02-11 |
| photo04_why_accreditation_card_ckb.jpg | hero_card | ckb | 1 | 1 (1).jpg | 2025-02-11 |
| photo05_global_partnership_plate_en.jpg | hero_plate | en | 1 | hawbash eng (1).jpg | 2025-08-07 |
| photo06_global_partnership_plate_ckb.jpg | hero_plate | ckb | 1 | hawbash (1).jpg | 2025-08-07 |
| photo07_prime_minister_meeting_scrim_en.jpg | scrim_caption | en | 1 | kaae 5.jpg.jpeg | 2026-05-20 |
| photo08_prime_minister_meeting_scrim_ckb.jpg | scrim_caption | ckb | 1 | kaae 5 kurdi.jpg.jpeg | 2026-05-20 |
| photo09_eid_al_adha_sky_title.jpg | sky_title | bilingual | 1 | eid 3.jpg.jpeg | 2026-05-26 |
| photo10_educational_forum_speaker_en.jpg | cutout_speaker | en | 1 | kaae graphic new.jpg.jpeg | 2026-07-28 |
| photo11_peer_evaluators_call_en.jpg | fade_to_paper | en | 1 | call for.jpg.jpeg | 2026-08-17 |
| photo12_peer_evaluators_call_ckb.jpg | fade_to_paper | ckb | 1 | call for kurdi.jpg.jpeg | 2026-08-17 |

Where the office published both an English and a Sorani version, both are included, linked by
`pairedWith`. The forum invitation exists only in English, and the Eid greeting is a single bilingual
post. The Dr. Lina webinar pair (a cut-out with a QR card) was left out to stay within 12 entries. The
forum post already covers `cutout_speaker`.

## Fields

Each entry has these fields:

- `recipe`: one of the shared ADR-170 recipe ids.
- `subject`: tags to match against the brief's subject. The tags are `report_release`, `field_visit`,
  `k12`, `carousel`, `accreditation`, `partnership`, `meeting`, `officials`, `occasion`, `event_forum`,
  `speaker` and `call_for_applications`, among others.
- `photoCount`: how many photos the design uses.
- `language`: the language of the post.
- `descriptor`: an English description of how the photo is used, sent to the layout model as text. It
  covers the hero choice, the crop and bleed, the fade, plate or card, where the text sits, the colours
  and what makes the design good. No descriptor contains Kurdish text; the Sorani copy is described in
  English.
- `provenance`: the source file, its hash, its export date and how the date was found.

## Retrieval

Callers pass `photoCount` in the brief. They may also pass `eligibleRecipes`, `subjects` and `category`.
When `photoCount` is greater than zero, `ExemplarRetrievalIndex.retrieveTopExemplars` returns photo
exemplars.

- It considers only exemplars whose recipe is eligible.
- It ranks them by subject match first. Ties are broken by text evidence, then the brief's script (a
  Sorani brief gets the Sorani twin), then format, then curator order.
- The first three picks each use a different recipe. A language twin is picked only if no other
  candidates remain.

Each match includes its `recipe`, `subject`, `photoCount`, `status` and `descriptor`. If no photo
exemplar is eligible, the call falls back to the typographic set and the result carries a warning.

**Not yet wired.** Core (`design-studio-service.ts`) and `retrieveExemplarsV3` (`pipeline-v3.ts`) do
not pass `photoCount` yet, so production still retrieves typographic exemplars only. The layout prompt
also does not show the recipe yet. Those files belong to the ADR-170 core work.

## The reversed drop

On 2026-09-17, `kaae 5 kurdi.jpg.jpeg` was dropped as "a photo post, not a layout to learn composition
from". That judgement compared it against typographic references only. It is reinstated here as the
`scrim_caption` exemplar (photo08, with its English twin photo07), for three reasons:

- The owner now asks the system to use photos the way the office does.
- An untouched group photo with a bottom navy scrim, a two-line caption and a short gold rule is exactly
  how the office presents meetings.
- The post has a real title and subtitle. The caption bar is a technique, not a missing hierarchy.

The `droppedInReview` record is kept and now carries `reconsideredAt` and `reconsideration`. The
`semanticLayout` metric still fails a layout that has no title. Its message no longer claims that a
photograph with a caption bar cannot be a composition.

`call for kurdi.jpg.jpeg` stays dropped as a typographic reference, because its large empty area is a
real flaw. Its descriptor says so. It is included only for its photo-to-paper fade. In it, the office also
flipped the document photo horizontally, which breaks the house rule never to mirror a photo. The
descriptor says not to copy that.
