import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { strFromU8, unzipSync } from 'fflate';
import { generateArtDirectedCandidatesV3, normalizeConcepts, solveConcepts, type RawArtDirectionConcept } from '../src/studio/art-direction/generate.js';
import { solveRecipe, type ArtDirectionChoice } from '../src/studio/art-direction/solver.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import type { CopyBlockSlotInput } from '../src/studio/layout-generator-v3.js';
import { flatPng } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const palette = ['#0A1628', '#FFFFFF', '#F7B500', '#1A1A1A'];
const copyBlocks: CopyBlockSlotInput[] = [{ index: 0, text: 'Original title', role: 'title', script: 'latin' as const },
  { index: 1, text: 'Exact date 2026 Office details', role: 'body', script: 'latin' as const }];
const photos = Array.from({ length: 6 }, (_, photoIndex) => ({ photoIndex,
  width: photoIndex === 5 ? 200 : 2400, height: photoIndex === 5 ? 200 : 2400,
  subjectFit: photoIndex === 0 ? 5 : 3, shot: 'classroom_or_interior' as const,
  quietArea: 'top' as const, quiet: 'top' as const }));
const slots = [{ copyIndex: 0, slot: 'title' as const }, { copyIndex: 1, slot: 'body' as const }];
const choice: ArtDirectionChoice = { recipe: 'photo_mosaic', heroPhotoIndex: 5, texturePhotoIndex: null,
  cutoutPhotoIndex: null, supportingPhotoIndices: [4, 3, 1], slots,
  params: { frame: 'none', align: 'start' }, typicality: .2, conceptNote: 'Selected image narrative' };
const options = { brief: 'An announcement', palette, copyBlocks, canvasWidth: 800, canvasHeight: 1000, photos, logoAspect: 1 };
const raw = (over: Partial<RawArtDirectionConcept>): RawArtDirectionConcept => ({
  id: 'concept', recipe: choice.recipe, conceptNote: choice.conceptNote!, typicality: .2,
  heroPhotoIndex: 5, texturePhotoIndex: null, cutoutPhotoIndex: null, supportingPhotoIndices: [4, 3, 1], slots,
  titleAccentWords: null, fadeShare: null, surfaceTone: 'auto', frame: 'none', align: 'start', ...over,
});

describe('art-direction photo intent through normalization and hero repair', () => {
  it.each([{ supportingPhotoIndices: [0, 4] }, { supportingPhotoIndices: [99, 4] },
    { supportingPhotoIndices: [NaN, 4] }])('keeps the first valid support after unusable prefix $supportingPhotoIndices', ({ supportingPhotoIndices }) => {
    const [normalized] = normalizeConcepts([raw({ recipe: 'photo_diptych', heroPhotoIndex: 0, supportingPhotoIndices })], photos, copyBlocks);
    expect(normalized.supportingPhotoIndices).toEqual([4]);
    const solved = solveConcepts([normalized], options);
    expect(solved.layouts[0].photos?.map(p => p.photoIndex)).toEqual([0, 4]);
  });

  it('deduplicates in narrative order and does not read beyond the nine-support model contract', () => {
    const [normalized] = normalizeConcepts([raw({ heroPhotoIndex: 0, supportingPhotoIndices: [4, 4, 0, 3, 1] })], photos, copyBlocks);
    expect(normalized.supportingPhotoIndices).toEqual([4, 3, 1]);
    const [bounded] = normalizeConcepts([raw({ recipe: 'photo_diptych', heroPhotoIndex: 0,
      supportingPhotoIndices: [...Array<number>(9).fill(0), 4] })], photos, copyBlocks);
    expect(bounded.supportingPhotoIndices).toEqual([]);
  });

  it.each(['photo_mosaic', 'photo_sequence', 'hero_storyboard'] as const)('keeps the feasible ordered supports when %s replaces a blurry hero', recipe => {
    const original = { ...choice, recipe }, before = structuredClone(original);
    const directlyFeasible = solveRecipe({ width: 800, height: 1000, palette, photos, logoAspect: 1,
      copy: { text: Object.fromEntries(copyBlocks.map(b => [b.index, b.text])) }, choice: { ...original, heroPhotoIndex: 0 } });
    expect(directlyFeasible.photos?.map(p => p.photoIndex)).toEqual([0, 4, 3, 1]);
    const result = solveConcepts([original], options);
    expect(result.choices[0].recipe).toBe(recipe);
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([0, 4, 3, 1]);
    expect(result.choices[0]).toMatchObject({ typicality: .2, conceptNote: choice.conceptNote, params: choice.params });
    expect(result.layouts[0].artDirection?.omittedPhotos).toEqual([2, 5]);
    expect(result.layouts[0].artDirection?.heroUpscale).toBeLessThanOrEqual(1.5);
    expect(result.replaced.some(r => /HERO_UPSCALED/.test(r.reason))).toBe(true);
    expect(original).toEqual(before);
    expect(solveConcepts(JSON.parse(JSON.stringify([original])), options)).toEqual(result);
  });

  it('removes only the new hero from its former support role; unspecified photos are not forced back in', () => {
    const result = solveConcepts([{ ...choice, supportingPhotoIndices: [4, 0, 3] }], options);
    expect(result.choices[0].supportingPhotoIndices).toEqual([4, 3]);
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([0, 4, 3]);
    expect(result.layouts[0].artDirection?.omittedPhotos).toEqual([1, 2, 5]);
  });

  it('preserves feasible texture and exact title accent metadata when only the hero needs replacing', () => {
    const original = { ...choice, recipe: 'hero_fade_report' as const, texturePhotoIndex: 4,
      titleAccentWords: 'Original' };
    const direct = solveRecipe({ width: 800, height: 1000, palette, photos, logoAspect: 1,
      copy: { text: Object.fromEntries(copyBlocks.map(b => [b.index, b.text])) }, choice: { ...original, heroPhotoIndex: 0 } });
    expect(direct.text[0].accentText).toBe('Original');
    const result = solveConcepts([original], options);
    expect(result.choices[0]).toMatchObject({ heroPhotoIndex: 0, texturePhotoIndex: 4, titleAccentWords: 'Original', typicality: .2 });
    expect(result.layouts[0].artDirection).toMatchObject({ heroPhotoIndex: 0, texturePhotoIndex: 4 });
    expect(result.layouts[0].text[0].accentText).toBe('Original');
  });

  it.each([null, 0])('does not invent another texture when the original texture is absent or becomes the hero (%s)', texturePhotoIndex => {
    const result = solveConcepts([{ ...choice, recipe: 'hero_fade_report', texturePhotoIndex }], options);
    expect(result.choices[0]).toMatchObject({ heroPhotoIndex: 0, texturePhotoIndex: null });
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([0]);
    expect(result.layouts[0].artDirection?.texturePhotoIndex).toBeUndefined();
  });

  it('completes a stated count only after removing the promoted hero from its former support role', () => {
    const result = solveConcepts([{ ...choice, supportingPhotoIndices: [4, 0, 3] }], {
      ...options, photoSelection: { mode: 'choose', minimum: 4, counted: true },
    });
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([0, 4, 3, 1]);
    expect(result.layouts[0].artDirection?.omittedPhotos).toEqual([2, 5]);
  });

  it('still fills explicit use-all coverage after the preserved narrative, without repeating the hero', () => {
    const result = solveConcepts([choice], { ...options, photoSelection: { mode: 'all', minimum: 6, insisted: true } });
    expect(result.layouts[0].photos?.map(p => p.photoIndex)).toEqual([0, 4, 3, 1, 2, 5]);
    expect(result.layouts[0].artDirection?.omittedPhotos).toEqual([]);
  });

  it('retains three distinct photo plans with one billed art-director call', async () => {
    let calls = 0;
    const concepts = ['photo_mosaic', 'photo_sequence', 'hero_storyboard'].map(recipe => raw({ recipe }));
    const client = { createStructuredCompletion: async () => {
      calls++;
      return { data: { concepts }, rawText: '', receipt: { responseId: 'synthetic-intent', xRequestId: null,
        model: 'synthetic-model', inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: .01, latencyMs: 1 } };
    } };
    const result = await generateArtDirectedCandidatesV3({ ...options, client: client as never });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ responseId: 'synthetic-intent', costUsd: .01 });
    expect(new Set(result.choices.map(c => c.recipe)).size).toBe(3);
    expect(result.layouts.map(l => l.photos?.map(p => p.photoIndex))).toEqual(Array(3).fill([0, 4, 3, 1]));
  });

  it('keeps selected source-photo bytes and exact live copy in the editable transfer', async () => {
    const result = solveConcepts([choice], options), layout = result.layouts[0];
    expect(layout.photos?.map(p => p.photoIndex)).toEqual([0, 4, 3, 1]);
    const assets = photos.map(p => ({ bytes: flatPng(p.width, p.height, [30 + p.photoIndex * 30, 80, 150]), mimeType: 'image/png' as const }));
    const render = renderLayoutV2(layout, { copyText: Object.fromEntries(copyBlocks.map(b => [b.index, b.text])),
      logoDataUri: KAAE_TEST_LOGO, photoDataUris: assets.map(a => `data:image/png;base64,${a.bytes.toString('base64')}`) });
    expect(render.svg).toContain('>Original</tspan>');
    expect(render.svg).toContain('>title</tspan>');
    const composite = PNG.sync.read(render.noTextPng);
    for (const text of layout.text) expect(computeBoxP05Contrast(composite, text, text.color))
      .toBeGreaterThanOrEqual(requiredContrast(text.fontSize, !!text.bold));
    const logoBytes = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const deck = await encodeStudioTransferV2(layout, copyBlocks.map(b => b.text), {
      bytes: logoBytes, sha256: createHash('sha256').update(logoBytes).digest('hex'), mimeType: 'image/png',
    }, { photos: assets });
    const files = unzipSync(deck.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('<a:t>Original title</a:t>');
    expect(xml).toContain('Exact date 2026 Office details');
    const media = Object.entries(files).filter(([name]) => name.startsWith('ppt/media/')).map(([, bytes]) =>
      createHash('sha256').update(bytes).digest('hex'));
    for (const index of [0, 4, 3, 1]) expect(media).toContain(createHash('sha256').update(assets[index].bytes).digest('hex'));
    for (const index of [2, 5]) expect(media).not.toContain(createHash('sha256').update(assets[index].bytes).digest('hex'));
  });
});
