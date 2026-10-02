# Office posts as layout fixtures (ADR-273)

These are measured annotations of twelve of the KAAE office's own published social posts. They are
not copies of the posts. No client photo, logo file or post image is stored here.

Each post is one of the exemplars in `packages/creative/assets/exemplars/photo*.jpg`, which
`PHOTO_EXEMPLARS.md` describes. Each annotation is a `StudioLayoutV2` layout. Every box was read off
a 50px grid laid over the post. The post was first scaled to the studio canvas:

- 864x1080 posts became 1080x1350;
- 1080x864 posts became 1350x1080;
- the 1080x1080 post was not scaled.

Each annotation records:

- the logo;
- each text block, with its role, size, weight, leading and alignment;
- each photo, as a box with its treatment (framed or cut out, its fade, its opacity), but no pixels;
- each fade and scrim, as an overlay with its stops;
- each plate, card, tab, pill, band and footer bar;
- the post's art-direction recipe record, from `PHOTO_EXEMPLARS.md`.

`gates.ts` runs every annotation through the gates production uses (see the ADR).

## Copy

The copy is placeholder copy. Each placeholder is about as long as the original line and wraps to the
same number of lines.

- English placeholders are new Latin text.
- Sorani placeholders are whole strings that already exist in this repository's tests. No Sorani
  was written for these fixtures. In one place a string is split over two lines at a space, as the
  office splits its title. The strings come from these files:
  - `packages/creative/test/kaae-poster-compositions.test.ts`
  - `packages/creative/test/kaae-creative-generation.test.ts`
  - `packages/creative/test/art-direction-solver.test.ts`
  - `packages/creative/test/pipeline-v3.test.ts`
  - `packages/creative/test/layout-spacing-fixes.test.ts`
  - `apps/core/test/telegram-paid-guards.test.ts`
  - `apps/core/test/task-list-page.test.ts`
- URLs are placeholders, except `kaae.org`, the call to action the office prints on its posts.

## Where an annotation departs from the post

Sometimes the office does something a house safety rule does not allow. That rule was not
recalibrated, so the annotation keeps the rule. Each post's `conformance` list says what the office
does and what the annotation does instead. The departures are of these kinds:

- **Text and logo position.** Text and logo are moved inside the 64px safe margin. The office sets
  them 15–60px from the edge.
- **Leading.** Leading is set to the house minimum: 1.2 for Latin text, 1.6 for Sorani. The office
  sets display caps at about 0.85–1.15. The annotation keeps each line box at the office's measured
  height, so the type size becomes the box height divided by the house leading. That makes the
  display type 20–30% smaller than the office's.
- **Carriers on photos.** The office sets some lines bare on a photo: the URLs on the partnership
  post, and the greeting on the Eid post. The annotation puts them on a scrim, because the house
  requires text over a photo to sit on a carrier.
- **Colours.** An antique gold that is not in the KAAE palette is mapped to a palette colour.
- **The forum post's sunburst.** It is left out, because a brand element may not lie under copy.

Each post's `omitted` list names what the layout model cannot express, such as icons and the
grid-paper texture.

## Type sizes are approximate

The sizes are read off 864px JPEGs. On top of that, the leading departure described above sets
every display size from the line box. So these sizes cannot calibrate a metric that needs them to
within 1.5px, such as `typeScale`.
