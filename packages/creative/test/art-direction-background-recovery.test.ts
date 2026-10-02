import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { strFromU8, unzipSync } from 'fflate';
import { applyContentBackground } from '../src/studio/background-planning.js';
import { RecipeInfeasibleError, solveRecipe, type ArtDirectionChoice } from '../src/studio/art-direction/solver.js';
import { generateArtDirectedCandidatesV3, solveConcepts, type GenerateArtDirectedOptions, type RawArtDirectionConcept } from '../src/studio/art-direction/generate.js';
import { declaredTextContrast, computeBoxP05Contrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { flatPng } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const body = Array.from({ length: 3 }, () => 'Exact date 2026 Price 123.45 Office details').join('\n');
const options: Omit<GenerateArtDirectedOptions, 'client'> = {
  brief: 'An original announcement', canvasWidth: 800, canvasHeight: 1000,
  palette: ['#888888', '#666666', '#000000', '#FFFFFF'], logoAspect: 1,
  copyBlocks: [{ index: 0, text: 'Original title', role: 'title', script: 'latin' },
    { index: 1, text: body, role: 'body', script: 'latin' }],
  photos: [{ photoIndex: 0, width: 2400, height: 2400, quiet: 'top' },
    { photoIndex: 1, width: 2400, height: 2400 }],
};
const mosaic: ArtDirectionChoice = {
  recipe: 'photo_mosaic', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
  slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }],
  params: { backgroundIntent: 'showcase', backgroundMode: 'gradient', backgroundColorIndex: 0 },
};
const choices: ArtDirectionChoice[] = [mosaic,
  { ...mosaic, recipe: 'hero_card', params: { backgroundMode: 'solid', backgroundColorIndex: 3 } },
  { ...mosaic, recipe: 'editorial_split', params: { backgroundMode: 'solid', backgroundColorIndex: 3 } },
];
const solve = () => solveRecipe({ width: 800, height: 1000, palette: options.palette, logoAspect: 1,
  photos: options.photos, copy: { text: { 0: 'Original title', 1: body } }, choice: mosaic,
  backgroundPlanning: { intent: 'showcase', mode: 'gradient', colorIndex: 0 } });
const readable = (layout: ReturnType<typeof solve>) => layout.text.every(t =>
  declaredTextContrast(layout, t) >= requiredContrast(t.fontSize, !!t.bold));

describe('candidate-local background rejection', () => {
  it('classifies a real unsatisfiable mosaic as recipe infeasibility', () => {
    expect(solve).toThrow(RecipeInfeasibleError);
    expect(solve).toThrow(/BACKGROUND.*no approved readable ink for block 1/);
  });

  it('keeps the other feasible concepts, records the refused field and replays deterministically', () => {
    const before = structuredClone(choices);
    const result = solveConcepts(choices, options);
    expect(result.layouts.length).toBeGreaterThanOrEqual(2);
    expect(result.choices.map(c => c.recipe)).toContain('hero_card');
    expect(result.replaced).toContainEqual(expect.objectContaining({ index: 0, recipe: 'photo_mosaic',
      reason: expect.stringMatching(/BACKGROUND.*readable ink/) }));
    expect(result.layouts.every(readable)).toBe(true);
    expect(result.layouts.every(l => l.text.map(t => t.copyIndex).join(',') === '0,1')).toBe(true);
    expect(choices).toEqual(before);
    expect(solveConcepts(JSON.parse(JSON.stringify(choices)), options)).toEqual(result);
  });

  it('uses one art-director call and preserves its billing receipt while rejecting the bad concept', async () => {
    let calls = 0;
    const raw: RawArtDirectionConcept[] = choices.map((c, i) => ({
      id: `c${i}`, conceptNote: 'Message-led concept', recipe: c.recipe, typicality: .5,
      heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, supportingPhotoIndices: [1],
      slots: c.slots, titleAccentWords: null, fadeShare: null, surfaceTone: 'auto', frame: 'none', align: 'start',
      backgroundIntent: c.params.backgroundIntent, backgroundMode: c.params.backgroundMode,
      backgroundColorIndex: c.params.backgroundColorIndex,
    }));
    const client = { createStructuredCompletion: async () => {
      calls++;
      return { data: { concepts: raw }, rawText: '', receipt: { responseId: 'synthetic-response',
        xRequestId: null, model: 'synthetic-model', inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 20, costUsd: .01, latencyMs: 1 } };
    } };
    const result = await generateArtDirectedCandidatesV3({ ...options, client: client as never });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ responseId: 'synthetic-response', costUsd: .01, inputTokens: 100,
      outputTokens: 50, cachedTokens: 20 });
    expect(result.layouts.length).toBeGreaterThanOrEqual(2);
    expect(result.replaced.some(r => /BACKGROUND.*readable ink/.test(r.reason))).toBe(true);
    expect(result.rawCandidates.map(c => c.compositionArchetype)).toEqual(result.choices.map(c => c.recipe));
  });

  it('does not turn invalid requester policy into a candidate fallback', () => {
    let error: unknown;
    try { solveConcepts(choices, { ...options, backgroundPlanning: { requestedColor: '#FF00FF' } }); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RecipeInfeasibleError);
    expect((error as Error).message).toMatch(/BACKGROUND.*outside the approved palette/);
  });

  it('retains atomic refusal in the standalone background planner', () => {
    const layout = solveRecipe({ width: 800, height: 1000, palette: options.palette, logoAspect: 1,
      photos: options.photos, copy: { text: { 0: 'Original title', 1: body } }, choice: mosaic });
    const before = structuredClone(layout);
    expect(() => applyContentBackground(layout, options.palette, {
      intent: 'showcase', mode: 'gradient', colorIndex: 0,
    })).toThrow(/BACKGROUND.*readable ink/);
    expect(layout).toEqual(before);
  });

  it('renders a retained concept with readable pixels and editable exact factual copy', async () => {
    const result = solveConcepts(choices, options);
    const layout = result.layouts.find(l => l.artDirection?.recipe === 'hero_card')!;
    expect(layout).toBeDefined();
    const photoBytes = flatPng(2400, 2400, [232, 236, 240]);
    const photos = options.photos.map(() => ({ bytes: photoBytes, mimeType: 'image/png' as const }));
    const copyText = { 0: 'Original title', 1: body };
    const render = renderLayoutV2(layout, { copyText, logoDataUri: KAAE_TEST_LOGO,
      photoDataUris: photos.map(p => `data:${p.mimeType};base64,${p.bytes.toString('base64')}`) });
    expect(render.svg).toContain('Original title');
    const composite = PNG.sync.read(render.noTextPng);
    for (const t of layout.text) expect(computeBoxP05Contrast(composite, t, t.color))
      .toBeGreaterThanOrEqual(requiredContrast(t.fontSize, !!t.bold));
    const logoBytes = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const deck = await encodeStudioTransferV2(layout, ['Original title', body], {
      bytes: logoBytes, sha256: createHash('sha256').update(logoBytes).digest('hex'), mimeType: 'image/png',
    }, { photos });
    const files = unzipSync(deck.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
    expect(xml).toContain('<a:t>Original title</a:t>');
    expect(xml).toContain('Exact date 2026 Price 123.45 Office details');
    expect(Object.entries(files).filter(([name]) => name.startsWith('ppt/media/'))
      .some(([, bytes]) => Buffer.from(bytes).equals(photoBytes))).toBe(true);
  });
});
