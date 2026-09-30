import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { buildArtDirectorSystemPrompt, buildArtDirectorUserPrompt, normalizeConcepts, solveConcepts, type RawArtDirectionConcept } from '../src/studio/art-direction/generate.js';
import { eligibleRecipes } from '../src/studio/art-direction/recipes.js';
import { solveRecipe } from '../src/studio/art-direction/solver.js';
import { studioLayoutV2Schema } from '../src/studio/layout-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import type { CopyBlockSlotInput } from '../src/studio/layout-generator-v3.js';

const palette = ['#092033', '#2D5470', '#E6AE37', '#FAF5ED', '#FFFFFF', '#141414'];
const photos = Array.from({ length: 6 }, (_, photoIndex) => ({ photoIndex, width: 1600, height: 1200,
  subjectFit: photoIndex === 4 ? 5 : photoIndex === 2 ? 4 : 2, regionStatus: 'measured' as const, regions: [] }));
const copyBlocks: CopyBlockSlotInput[] = [{ index: 0, text: 'Working together', role: 'title', script: 'latin' },
  { index: 1, text: 'From discovery to practice', role: 'body', script: 'latin' }];
const copyText = Object.fromEntries(copyBlocks.map(b => [b.index, b.text]));
const concept: RawArtDirectionConcept = { id: 'story', recipe: 'hero_storyboard', conceptNote: 'Scene then related detail',
  typicality: .4, heroPhotoIndex: 4, texturePhotoIndex: null, cutoutPhotoIndex: null,
  slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }], titleAccentWords: null,
  fadeShare: null, surfaceTone: 'cream', frame: 'none', align: 'start' };
const options = { brief: 'An editorial announcement', palette, photos, copyBlocks, canvasWidth: 1080, canvasHeight: 1350 };

describe('ADR-181 content-aware photo composition policy', () => {
  it('offers multi-photo composition without requiring a counted instruction, and keeps single-photo alternatives', () => {
    expect(eligibleRecipes(photos, 1)).toEqual(expect.arrayContaining(['hero_storyboard', 'scrim_caption', 'hero_card']));
    expect(eligibleRecipes([photos[0]], 1)).not.toContain('hero_storyboard');
    expect(eligibleRecipes(photos, 3)).toEqual(['hero_storyboard']);
  });
  it('accepts a model-selected multi-photo concept rather than silently replacing it with a hero fade', () => {
    const choices = normalizeConcepts([concept], photos, copyBlocks);
    expect(choices[0].recipe).toBe('hero_storyboard');
  });
  it('does not let a legacy storyboard imply that every unspecified upload is required', () => {
    const layout = solveRecipe({ width: 1080, height: 1350, palette, photos, logoAspect: 1, copy: { text: copyText },
      choice: { ...concept, recipe: 'hero_storyboard', slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }], params: {} } });
    expect(layout.photos).toHaveLength(2);
    expect(layout.artDirection?.omittedPhotos).toHaveLength(4);
  });
  it('states flexible content and client-scoped references without a global hero-only instruction', () => {
    const system = buildArtDirectorSystemPrompt();
    expect(system).not.toContain('A second photo is at most a texture');
    expect(system).not.toContain('report release, study, field visit = hero_fade_report');
    const user = buildArtDirectorUserPrompt({ ...options, houseRules: ['Prefer one hero plus a dark fade for this client.'] });
    expect(user).toContain('R1. Prefer one hero plus a dark fade for this client.');
    expect(user).not.toContain('with at most a blended texture, in the house style');
  });
  it('keeps supporting-image narrative order, deduplicates unknown model indices and reports actual omissions', () => {
    const choices = normalizeConcepts([{ ...concept, supportingPhotoIndices: [5, 2, 5, 99, 4] }], photos, copyBlocks);
    expect(choices[0].supportingPhotoIndices).toEqual([5, 2]);
    const result = solveConcepts([choices[0]], options);
    const layout = result.layouts[0];
    expect(layout.photos?.map(p => p.photoIndex)).toEqual([4, 5, 2]);
    expect(layout.artDirection?.omittedPhotos).toEqual([0, 1, 3]);
    expect(studioLayoutV2Schema.safeParse(layout).success).toBe(true);
    const qa = evaluateHardQa(layout, { width: 1080, height: 1350, palette, copyText, copyScripts: ['latin', 'latin'],
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, photoCount: 6,
      photoRegions: photos.map(p => ({ width: p.width, height: p.height, regionStatus: p.regionStatus, regions: p.regions })) });
    expect(qa.passed, qa.messages.join('\n')).toBe(true);
    expect(qa.omittedPhotos).toEqual([0, 1, 3]);
  });
  it('completes an explicit count from ranked sources, but not the old uncounted half-upload guess', () => {
    for (const selection of [undefined, { mode: 'all' as const, minimum: 6 }, { mode: 'choose' as const, minimum: 3 }]) {
      const choice = normalizeConcepts([{ ...concept, supportingPhotoIndices: [5] }], photos, copyBlocks, selection)[0];
      expect(solveConcepts([choice], { ...options, photoSelection: selection }).layouts[0].photos).toHaveLength(2);
    }
    const counted = { mode: 'choose' as const, minimum: 3, counted: true };
    const choice = normalizeConcepts([{ ...concept, supportingPhotoIndices: [5] }], photos, copyBlocks, counted)[0];
    const layout = solveConcepts([choice], { ...options, photoSelection: counted }).layouts[0];
    expect(layout.photos?.map(p => p.photoIndex)).toEqual([4, 5, 2]);
  });
  it('carries ten explicitly required source photos through schema and independent coverage validation', () => {
    const ten = Array.from({ length: 10 }, (_, photoIndex) => ({ ...photos[0], photoIndex }));
    const selection = { mode: 'all' as const, minimum: 10, insisted: true };
    const choice = normalizeConcepts([{ ...concept, supportingPhotoIndices: [9] }], ten, copyBlocks, selection)[0];
    const layout = solveConcepts([choice], { ...options, photos: ten, photoSelection: selection, canvasWidth: 1920, canvasHeight: 1080 }).layouts[0];
    expect(layout, 'required ten-photo layout was refused').toBeDefined();
    expect(layout.photos).toHaveLength(10);
    expect(studioLayoutV2Schema.safeParse(layout).success).toBe(true);
    expect(validateLayoutV2(layout, { expectedWidth: 1920, expectedHeight: 1080, photoCount: 10, photoSelection: selection,
      copyCount: 2, copyScripts: ['latin', 'latin'], reference: { rules: { fontFamily: 'Verdana', palette }, logoAspect: 1 } })).toMatchObject({ ok: true });
    expect(layout.artDirection?.omittedPhotos).toEqual([]);
  });
  it('refuses forged direct support choices instead of addressing unrelated sources', () => {
    const choice = normalizeConcepts([concept], photos, copyBlocks)[0];
    expect(() => solveRecipe({ width: 1080, height: 1350, palette, photos, logoAspect: 1, copy: { text: copyText },
      choice: { ...choice, supportingPhotoIndices: [99] } })).toThrow('invalid supporting photo indices');
  });

  it('renders and transfers ten required photos as native source images with exact live copy', async () => {
    const ten = Array.from({ length: 10 }, (_, photoIndex) => ({ ...photos[0], photoIndex }));
    const selection = { mode: 'all' as const, minimum: 10, insisted: true };
    const choice = normalizeConcepts([{ ...concept, supportingPhotoIndices: [9, 2] }], ten, copyBlocks, selection)[0];
    const layout = solveConcepts([choice], { ...options, photos: ten, photoSelection: selection, canvasWidth: 1920, canvasHeight: 1080 }).layouts[0];
    const files = ten.map((_, i) => ({ bytes: syntheticPhoto(1600, 1200, i + 1) }));
    const rendered = renderLayoutV2(layout, { copyText, photoFiles: files, logoDataUri: KAAE_TEST_LOGO });
    const qa = evaluateHardQa(layout, { width: 1920, height: 1080, palette, copyText, copyScripts: ['latin', 'latin'],
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, photoCount: 10, photoSelection: selection,
      renderedComposite: rendered.noTextPng,
      photoRegions: ten.map(p => ({ width: p.width, height: p.height, regionStatus: p.regionStatus, regions: p.regions })) });
    expect(qa.passed, qa.messages.join('\n')).toBe(true);
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const logoBytes = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const result = await encodeStudioTransferV2(layout, copyBlocks.map(b => b.text), { bytes: logoBytes, sha256: digest(logoBytes), mimeType: 'image/png' },
      { photos: files.map(f => ({ ...f, mimeType: 'image/png' as const })) });
    const zip = unzipSync(result.bytes);
    const xml = strFromU8(zip['ppt/slides/slide1.xml']);
    expect((xml.match(/<p:pic>/g) ?? [])).toHaveLength(11); // ten sources plus the explicit official control logo
    for (const block of copyBlocks) expect(xml).toContain(block.text);
    const media = new Set(Object.entries(zip).filter(([key]) => key.startsWith('ppt/media/') && !key.endsWith('/')).map(([, bytes]) => digest(bytes)));
    for (const source of files) expect(media.has(digest(source.bytes))).toBe(true);
    expect(media.has(digest(logoBytes))).toBe(true);
  });

});
