import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { strFromU8, unzipSync } from 'fflate';
import { generateArtDirectedCandidatesV3, solveConcepts, type GenerateArtDirectedOptions, type RawArtDirectionConcept } from '../src/studio/art-direction/generate.js';
import * as solver from '../src/studio/art-direction/solver.js';
import type { ArtDirectionChoice } from '../src/studio/art-direction/solver.js';
import { PHOTO_RECIPE_IDS } from '../src/studio/art-direction/recipes.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import { flatPng } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const options: Omit<GenerateArtDirectedOptions, 'client'> = {
  brief: 'An original announcement', canvasWidth: 800, canvasHeight: 1000,
  palette: ['#0A1628', '#FFFFFF', '#F7B500', '#1A1A1A'], logoAspect: 1,
  copyBlocks: [{ index: 0, text: 'Original title', role: 'title', script: 'latin' },
    { index: 1, text: 'Exact date 2026 Office details', role: 'body', script: 'latin' }],
  photos: [{ photoIndex: 0, width: 200, height: 200, subjectFit: 5, quiet: 'top', quietArea: 'top' },
    { photoIndex: 1, width: 2400, height: 2400, subjectFit: 3, quiet: 'top', quietArea: 'top' }],
};
const choice: ArtDirectionChoice = {
  recipe: 'hero_card', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
  slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }],
  params: { frame: 'none', align: 'center', backgroundMode: 'solid', backgroundColorIndex: 0 },
  titleAccentWords: 'Original', conceptNote: 'Original content-aware concept', typicality: .2,
};
const direct = (c: ArtDirectionChoice, over: Partial<typeof options> = {}) => {
  const o = { ...options, ...over };
  return solver.solveRecipe({ width: o.canvasWidth, height: o.canvasHeight, photos: o.photos,
    palette: o.palette, logoAspect: 1, choice: c, photoSelection: o.photoSelection,
    copy: { text: Object.fromEntries(o.copyBlocks.map(b => [b.index, b.text])) },
    backgroundPlanning: { mode: c.params.backgroundMode, colorIndex: c.params.backgroundColorIndex, ...o.backgroundPlanning } });
};

describe('bounded alternate hero feasibility', () => {
  it('keeps the intended composition with a sharp source when the best subject-fit source is tiny', () => {
    const feasible = direct({ ...choice, heroPhotoIndex: 1 });
    expect(feasible.artDirection?.heroUpscale).toBeLessThanOrEqual(1.5);
    const before = structuredClone(choice), result = solveConcepts([choice], options);
    expect(result.choices[0]).toEqual({ ...choice, heroPhotoIndex: 1 });
    expect(result.layouts[0]).toEqual(feasible);
    expect(result.replaced).toHaveLength(1);
    expect(result.replaced[0].reason).toMatch(/HERO_UPSCALED/);
    expect(result.layouts[0].artDirection?.omittedPhotos).toEqual([0]);
    expect(choice).toEqual(before);
    expect(solveConcepts(JSON.parse(JSON.stringify([choice])), options)).toEqual(result);
  });

  it('rejects invalid and impossible protected crops before accepting the next sharp source', () => {
    const photos: typeof options.photos = [
      { ...options.photos[0], width: 2400, height: 2400, regionStatus: 'invalid' },
      { ...options.photos[1], width: 4000, height: 1000, subjectFit: 4, regionStatus: 'measured',
        regions: [{ kind: 'subject', x: .01, y: .1, width: .98, height: .8 }] },
      { ...options.photos[1], photoIndex: 2, subjectFit: 2, regionStatus: 'measured',
        regions: [{ kind: 'subject', x: .4, y: .4, width: .1, height: .1 }] },
    ];
    expect(() => direct(choice, { photos })).toThrow(/invalid subject regions/);
    expect(() => direct({ ...choice, heroPhotoIndex: 1 }, { photos })).toThrow(/retain every subject/);
    const feasible = direct({ ...choice, heroPhotoIndex: 2 }, { photos });
    const result = solveConcepts([choice], { ...options, photos });
    expect(result.choices[0]).toEqual({ ...choice, heroPhotoIndex: 2 });
    expect(result.layouts[0]).toEqual(feasible);
    expect(result.replaced.map(r => r.reason).join(' | ')).toMatch(/invalid subject regions.*retain every subject/);
  });

  it.each(['photo_mosaic', 'photo_sequence', 'hero_storyboard'] as const)('preserves the selected narrative when %s searches beyond its blurry default', recipe => {
    const photos = Array.from({ length: 5 }, (_, photoIndex) => ({ ...options.photos[1], photoIndex,
      width: photoIndex === 0 ? 200 : 2400, height: photoIndex === 0 ? 200 : 2400,
      subjectFit: photoIndex === 0 ? 5 : photoIndex === 1 ? 4 : 2 }));
    const original = { ...choice, recipe, supportingPhotoIndices: [4, 1, 3] };
    const result = solveConcepts([original], { ...options, photos });
    expect(result.choices[0]).toEqual({ ...original, heroPhotoIndex: 1, supportingPhotoIndices: [4, 3] });
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([1, 4, 3]);
    expect(result.layouts[0].artDirection?.omittedPhotos).toEqual([0, 2]);
  });

  it('still completes explicit count and all-photo obligations after role promotion', () => {
    const photos = Array.from({ length: 5 }, (_, photoIndex) => ({ ...options.photos[1], photoIndex,
      width: photoIndex === 0 ? 200 : 2400, height: photoIndex === 0 ? 200 : 2400,
      subjectFit: photoIndex === 0 ? 5 : photoIndex === 1 ? 4 : 2 }));
    const original = { ...choice, recipe: 'photo_mosaic' as const, supportingPhotoIndices: [4, 1, 3] };
    const counted = solveConcepts([original], { ...options, photos, photoSelection: { mode: 'choose', minimum: 4, counted: true } });
    expect(counted.layouts[0].photos?.map(p => p.photoIndex)).toEqual([1, 4, 3, 0]);
    const all = solveConcepts([original], { ...options, photos, photoSelection: { mode: 'all', minimum: 5, insisted: true } });
    expect(all.layouts[0].photos?.map(p => p.photoIndex)).toEqual([1, 4, 3, 0, 2]);
    expect(all.layouts[0].artDirection?.omittedPhotos).toEqual([]);
  });

  it.each([null, 1])('clears a promoted texture without inventing another (%s)', texturePhotoIndex => {
    const result = solveConcepts([{ ...choice, recipe: 'hero_fade_report', texturePhotoIndex }], options);
    expect(result.choices[0]).toMatchObject({ heroPhotoIndex: 1, texturePhotoIndex: null, titleAccentWords: 'Original', typicality: .2 });
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([1]);
  });

  it('returns a feasible original immediately and retains the warned fallback if every source is soft', () => {
    const spy = vi.spyOn(solver, 'solveRecipe');
    try {
      expect(solveConcepts([{ ...choice, heroPhotoIndex: 1 }], options).choices[0].heroPhotoIndex).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      const result = solveConcepts([choice], { ...options, photos: options.photos.map(p => ({ ...p, width: 100, height: 100 })) });
      expect(result.choices[0]).toEqual(choice);
      expect(result.layouts[0].artDirection?.heroUpscale).toBeGreaterThan(1.5);
      expect(result.replaced.every(r => /HERO_UPSCALED/.test(r.reason))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('retains the existing calm default priority before other ranked sources', () => {
    const photos: typeof options.photos = [
      { ...options.photos[0], quiet: 'none', quietArea: 'none' },
      { ...options.photos[1], subjectFit: 2 },
      { ...options.photos[1], photoIndex: 2, subjectFit: 4, quiet: 'none', quietArea: 'none' },
    ];
    const result = solveConcepts([{ ...choice, recipe: 'hero_plate' }], { ...options, photos });
    expect(result.choices[0]).toMatchObject({ recipe: 'hero_plate', heroPhotoIndex: 1 });
  });

  it('searches only admitted cutouts and moves both source roles together', () => {
    const photos: typeof options.photos = [
      { ...options.photos[0], cutout: true }, // saved role says cutout, but its required size is missing
      { ...options.photos[1], subjectFit: 4 }, // a sharp source with no admitted cutout
      { ...options.photos[1], photoIndex: 2, subjectFit: 2, cutout: true, cutoutSize: { width: 1200, height: 2400 } },
    ];
    const original = { ...choice, recipe: 'cutout_speaker' as const, cutoutPhotoIndex: 0 };
    const feasible = direct({ ...original, heroPhotoIndex: 2, cutoutPhotoIndex: 2 }, { photos });
    const spy = vi.spyOn(solver, 'solveRecipe');
    try {
      const result = solveConcepts([original], { ...options, photos });
      expect(result.choices[0]).toEqual({ ...original, heroPhotoIndex: 2, cutoutPhotoIndex: 2 });
      expect(result.layouts[0]).toEqual(feasible);
      expect(spy.mock.calls.map(([i]) => i.choice.cutoutPhotoIndex)).toEqual([0, 2]);
      expect(result.layouts[0].photos?.map(p => [p.photoIndex, p.treatment])).toEqual([[2, 'cutout']]);
    } finally { spy.mockRestore(); }
  });

  it('bounds actual solver attempts even when a direct caller supplies too many failed sources', () => {
    const photos = Array.from({ length: 30 }, (_, photoIndex) => ({ ...options.photos[1], photoIndex,
      subjectFit: 3, regionStatus: 'invalid' as const }));
    const spy = vi.spyOn(solver, 'solveRecipe');
    try {
      expect(solveConcepts([choice], { ...options, photos }).layouts).toEqual([]);
      const sameRecipe = spy.mock.calls.filter(([i]) => i.choice.recipe === choice.recipe);
      expect(sameRecipe.length).toBe(10);
      expect(new Set(sameRecipe.map(([i]) => i.choice.heroPhotoIndex)).size).toBe(10);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(11 + PHOTO_RECIPE_IDS.length - 1);
    } finally { spy.mockRestore(); }
  });

  it('still aborts invalid requester background policy', () => {
    expect(() => solveConcepts([choice], { ...options, backgroundPlanning: { requestedColor: '#FF00FF' } }))
      .toThrow(/BACKGROUND.*outside the approved palette/);
  });

  it('retains three distinct concepts and billing from one model call', async () => {
    let calls = 0;
    const concepts: RawArtDirectionConcept[] = ['hero_card', 'editorial_split', 'hero_fade_report'].map(recipe => ({
      id: recipe, recipe, conceptNote: choice.conceptNote!, typicality: .2,
      heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, supportingPhotoIndices: [],
      slots: choice.slots, titleAccentWords: 'Original', fadeShare: null, surfaceTone: 'auto',
      frame: 'none', align: 'center', backgroundMode: 'solid', backgroundColorIndex: 0,
    }));
    const client = { createStructuredCompletion: async () => {
      calls++;
      return { data: { concepts }, rawText: '', receipt: { responseId: 'synthetic-alternate-hero', xRequestId: null,
        model: 'synthetic-model', inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 20, costUsd: .01, latencyMs: 1 } };
    } };
    const result = await generateArtDirectedCandidatesV3({ ...options, client: client as never });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ responseId: 'synthetic-alternate-hero', costUsd: .01, cachedTokens: 20 });
    expect(result.choices.map(c => [c.recipe, c.heroPhotoIndex])).toEqual(concepts.map(c => [c.recipe, 1]));
    expect(result.layouts.every(l => l.artDirection!.heroUpscale! <= 1.5)).toBe(true);
  });

  it('renders a sharp retained concept and transfers original source bytes with live exact copy', async () => {
    const result = solveConcepts([choice], options), layout = result.layouts[0];
    expect(layout.artDirection?.heroPhotoIndex).toBe(1);
    const photos = options.photos.map(p => ({ bytes: flatPng(p.width, p.height, [40 + p.photoIndex * 80, 100, 150]), mimeType: 'image/png' as const }));
    const render = renderLayoutV2(layout, { copyText: Object.fromEntries(options.copyBlocks.map(b => [b.index, b.text])),
      logoDataUri: KAAE_TEST_LOGO, photoDataUris: photos.map(p => `data:image/png;base64,${p.bytes.toString('base64')}`) });
    const composite = PNG.sync.read(render.noTextPng);
    for (const t of layout.text) expect(computeBoxP05Contrast(composite, t, t.color)).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, !!t.bold));
    const logoBytes = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const deck = await encodeStudioTransferV2(layout, options.copyBlocks.map(b => b.text), {
      bytes: logoBytes, sha256: createHash('sha256').update(logoBytes).digest('hex'), mimeType: 'image/png',
    }, { photos });
    const files = unzipSync(deck.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('<a:t>Original title</a:t>');
    expect(xml).toContain('Exact date 2026 Office details');
    const media = Object.entries(files).filter(([name]) => name.startsWith('ppt/media/')).map(([, bytes]) => Buffer.from(bytes));
    expect(media.some(bytes => bytes.equals(photos[1].bytes))).toBe(true);
    expect(media.some(bytes => bytes.equals(photos[0].bytes))).toBe(false);
  });
});
