import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { recipePhotoMinimum, photoSelectionFromInstructions } from '../src/studio/photo-selection.js';
import { eligibleRecipes } from '../src/studio/art-direction/recipes.js';
import { solveRecipe, type SolveRecipeInput } from '../src/studio/art-direction/solver.js';
import { logoBackingExcess, settleLogoGround } from '../src/studio/art-direction/logo-ground.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { logoClearZone } from '../src/studio/house-rules.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

/**
 * ADR-180, owner decisions of 2026-09-30. Shown a live draft built as a three-photo collage (ADR-171's
 * default half-of-the-photos minimum) and asked "office house style or show more photos (collage)?",
 * the owner answered "office house style". And of the same draft: "current design has logo
 * background", the logo in a heavy navy square the size of its clear space.
 */

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const COPY = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits' };
const INSTRUCTIONS = "you don't have to use all the photos, choose the best ones based on your design.";

/** A 1280x853 photo: `calm` a flat pale wall, else a busy high-contrast checker at the top. */
function photo(kind: 'calm' | 'busy'): Buffer {
  const png = new PNG({ width: 1280, height: 853 });
  for (let y = 0; y < 853; y++) for (let x = 0; x < 1280; x++) {
    const i = (y * 1280 + x) * 4;
    const v = kind === 'calm' ? 214 : ((x >> 3) + (y >> 3)) % 2 ? 30 : 235;
    png.data[i] = v; png.data[i + 1] = kind === 'calm' ? 218 : v; png.data[i + 2] = kind === 'calm' ? 222 : (v + 40) % 256; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const PHOTOS = Array.from({ length: 6 }, (_, photoIndex) => ({ photoIndex, width: 1280, height: 853 }));
const input = (recipe: SolveRecipeInput['choice']['recipe'], extra: Partial<SolveRecipeInput> = {}): SolveRecipeInput => ({
  width: 1080, height: 1350, photos: PHOTOS, palette: PALETTE, logoAspect: 1, copy: { text: COPY },
  choice: { recipe, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
    slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }], params: { frame: 'inset' } },
  ...extra,
});
const context = (photoSelection?: LayoutValidationContext['photoSelection']): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 3, copyScripts: ['latin', 'latin', 'latin'], photoCount: 6,
  ...(photoSelection ? { photoSelection } : {}), reference: { rules: { fontFamily: 'Verdana', palette: PALETTE }, logoAspect: 1 },
});
const qa = (layout: StudioLayoutV2, photoSelection = photoSelectionFromInstructions(INSTRUCTIONS, 6)) => evaluateHardQa(layout, {
  width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'], latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
  palette: PALETTE, logoAspect: 1, copyText: COPY, photoCount: 6, photoSelection,
});

describe('ADR-180: office house style wins over default photo coverage', () => {
  it('only the requester\'s explicit words bind a recipe to more than its hero', () => {
    // "Choose the best ones", no count: the recorded half-the-photos guess does not bind.
    expect(recipePhotoMinimum(photoSelectionFromInstructions(INSTRUCTIONS, 6), 6)).toBe(1);
    // Photos with nothing said about them: the house rulebook's hero.
    expect(recipePhotoMinimum(photoSelectionFromInstructions('Please make a report cover.', 6), 6)).toBe(1);
    expect(recipePhotoMinimum(undefined, 6)).toBe(1);
    // "Use all the photos" means all; "pick 3" means 3; "pick 6" of six is all.
    expect(recipePhotoMinimum(photoSelectionFromInstructions('Use all the photos please.', 6), 6)).toBe(6);
    expect(recipePhotoMinimum(photoSelectionFromInstructions('pick 3 of them', 6), 6)).toBe(3);
    expect(recipePhotoMinimum(photoSelectionFromInstructions('pick 6 photos', 6), 6)).toBe(6);
  });

  it('offers the collage only when the requester asked for more photos in so many words', () => {
    expect(eligibleRecipes(PHOTOS, 1)).not.toContain('hero_storyboard');
    expect(eligibleRecipes(PHOTOS, 1)).toContain('hero_fade_report');
    expect(eligibleRecipes(PHOTOS, 2)).toEqual(expect.arrayContaining(['hero_storyboard', 'hero_fade_report']));
    expect(eligibleRecipes(PHOTOS, 3)).toEqual(['hero_storyboard']);
  });

  it('a hero design is the request done, and the photos left out are recorded for office review', () => {
    const layout = solveRecipe(input('hero_fade_report'));
    expect(layout.photos).toHaveLength(1);
    expect(validateLayoutV2(layout, context(photoSelectionFromInstructions(INSTRUCTIONS, 6))).ok).toBe(true);
    expect(validateLayoutV2(layout, context({ mode: 'all', minimum: 6 })).ok).toBe(true);
    expect(validateLayoutV2(layout, context({ mode: 'all', minimum: 6, insisted: true }))).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(qa(layout).omittedPhotos).toEqual([1, 2, 3, 4, 5]);
    expect(qa(layout, { mode: 'all', minimum: 6 }).omittedPhotos).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('ADR-180: no heavy box behind the logo', () => {
  it('the collage recipe no longer draws a navy square the size of the logo\'s clear space (the source)', () => {
    const layout = solveRecipe(input('hero_storyboard', { photoSelection: { mode: 'all', minimum: 6, insisted: true } }));
    const clear = logoClearZone(layout.logo);
    expect(layout.shapes.filter((s) => s.x <= layout.logo.x && s.y <= layout.logo.y && s.x + s.width >= layout.logo.x + layout.logo.width
      && s.y + s.height >= layout.logo.y + layout.logo.height && s.fill !== 'none')).toEqual([]);
    // The square it drew is now a hard-QA defect wherever it comes from.
    const square: StudioLayoutV2 = { ...layout, shapes: [...layout.shapes, { kind: 'rect', role: 'panel', layer: 'overlay', surface: 'tab', color: '#0A1628', ...clear }] };
    expect(logoBackingExcess(square)).toBeGreaterThan(1);
    expect(qa(square, { mode: 'all', minimum: 6, insisted: true }).defectCodes).toContain('LOGO_BACKING');
    expect(qa(layout, { mode: 'all', minimum: 6, insisted: true }).defectCodes).not.toContain('LOGO_BACKING');
  });

  it('a thin tab and a scrim within the clear space pass; anything larger fails', () => {
    const layout = solveRecipe(input('hero_fade_report'));
    const { logo } = layout;
    const clear = logoClearZone(logo);
    const pad = Math.round(0.07 * logo.height);
    const tab = { kind: 'roundRect' as const, role: 'panel' as const, layer: 'overlay' as const, surface: 'tab' as const, color: '#FDF8F3',
      x: logo.x - pad, y: logo.y - pad, width: logo.width + 2 * pad, height: logo.height + 2 * pad, radius: 8 };
    expect(logoBackingExcess({ ...layout, shapes: [...layout.shapes, tab] })).toBe(0);
    const scrim = { kind: 'gradient' as const, purpose: 'scrim' as const, direction: 'radial' as const, color: '#FDF8F3', ...clear,
      stops: [{ at: 0, opacity: 0.6 }, { at: 1, opacity: 0 }] };
    expect(logoBackingExcess({ ...layout, overlays: [...(layout.overlays ?? []), scrim] })).toBe(0);
    const wide = { ...scrim, x: clear.x - 40, width: clear.width + 80 };
    expect(logoBackingExcess({ ...layout, overlays: [...(layout.overlays ?? []), wide] })).toBe(40);
  });

  it('on a calm photo the logo stays bare; on a busy one it gets the lightest lift, inside its clear space', async () => {
    for (const kind of ['calm', 'busy'] as const) {
      const bytes = photo(kind);
      const render = { logoDataUri: KAAE_TEST_LOGO, photoFiles: PHOTOS.map(() => ({ bytes, mediaType: 'image/png' })) };
      const layout = solveRecipe(input('hero_fade_report'));
      const settled = await settleLogoGround(layout, { render, palette: PALETTE });
      const ground = settled.artDirection!.logoGround!;
      if (kind === 'calm') {
        expect(ground.treatment).toBe('none');
        expect(settled.overlays).toEqual(layout.overlays);
        expect(settled.shapes).toEqual(layout.shapes);
      } else {
        expect(ground.treatment).not.toBe('none');
        expect(ground.contrast).toBeGreaterThanOrEqual(3);
      }
      expect(logoBackingExcess(settled)).toBe(0);
      const rendered = renderLayoutV2(settled, { ...render, copyText: COPY });
      const outcome = evaluateHardQa(settled, { width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'], latinFont: 'Verdana',
        arabicFont: 'Noto Sans Arabic', palette: PALETTE, logoAspect: 1, copyText: COPY, photoCount: 6, renderedComposite: rendered.noTextPng });
      expect(outcome.passed, outcome.messages.join('\n')).toBe(true);
    }
  }, 60000);
});
