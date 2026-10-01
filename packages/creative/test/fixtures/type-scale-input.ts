import type { SolveRecipeInput } from '../../src/studio/art-direction/solver.js';

/** Synthetic copy and source dimensions from the actual coarse-grid reproduction. */
export const MISSED_TYPE_SCALE_INPUT: SolveRecipeInput = {
  width: 1080, height: 1350,
  palette: ['#0A1628', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF'], logoAspect: 1,
  photos: [{ photoIndex: 0, width: 2400, height: 1800 }, { photoIndex: 1, width: 2400, height: 1800 }],
  copy: { text: { 0: 'Learning outcomes Learning outcomes Learning outcomes', 1: 'A report on practical evidence and progress.' } },
  choice: { recipe: 'hero_fade_report', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
    slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }], params: {} },
};
