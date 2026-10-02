import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { solveRecipe, RecipeInfeasibleError, type SolveRecipeInput } from '../src/studio/art-direction/solver.js';
import { packPhotoSequence } from '../src/studio/art-direction/photo-packing.js';
import { eligibleRecipes } from '../src/studio/art-direction/recipes.js';
import type { CopyBlockSlotInput } from '../src/studio/layout-generator-v3.js';
import { normalizeConcepts, solveConcepts, type RawArtDirectionConcept } from '../src/studio/art-direction/generate.js';
import { artDirectionPrior, scopedReferenceRecipes, type RecipePreferenceContext } from '../src/studio/art-direction/prior.js';
import { studioLayoutV2Schema, type RecipeId } from '../src/studio/layout-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const palette = ['#112B24', '#355A45', '#BA813D', '#F7F4EB', '#FFFFFF', '#101815'];
const photos = Array.from({ length: 10 }, (_, photoIndex) => ({ photoIndex, width: photoIndex % 3 === 0 ? 1800 : 1600,
  height: photoIndex % 3 === 0 ? 1200 : 1400, regionStatus: 'measured' as const, regions: [] }));
const ids: RecipeId[] = ['editorial_split', 'photo_diptych', 'photo_sequence', 'photo_mosaic'];
function input(recipe: RecipeId, width = 1080, height = 1350, count = 2, rtl = false): SolveRecipeInput {
  const text = rtl ? { 0: 'ڕاپۆرتی نوێ', 1: 'هەنگاوەکانی داهاتوو', 2: 'example.org' }
    : { 0: 'Shared progress', 1: 'From discovery to practice', 2: 'example.org' };
  return { width, height, palette, photos: photos.slice(0, count), logoAspect: 1,
    photoSelection: { mode: 'all', minimum: count, insisted: true },
    copy: { text, scripts: { 0: rtl ? 'arabic' : 'latin', 1: rtl ? 'arabic' : 'latin', 2: 'latin' } },
    choice: { recipe, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }, { copyIndex: 2, slot: 'cta' }], params: {} } };
}
const context = (i: SolveRecipeInput) => ({ expectedWidth: i.width, expectedHeight: i.height, photoCount: i.photos.length,
  photoSelection: i.photoSelection, copyCount: 3, copyScripts: [i.copy.scripts![0], i.copy.scripts![1], 'latin' as const],
  reference: { rules: { fontFamily: 'Verdana', palette }, logoAspect: 1 } });

describe('W4 content-aware native topology geometry', () => {
  for (const recipe of ids) for (const [width, height] of [[1080, 1350], [1080, 1080], [1080, 1920], [1920, 1080]]) for (const rtl of [false, true]) {
    it(`${recipe} preserves copy/sources and legal geometry at ${width}x${height} ${rtl ? 'RTL' : 'LTR'}`, () => {
      const i = input(recipe, width, height, recipe === 'editorial_split' ? 1 : 2, rtl);
      const layout = solveRecipe(i);
      expect(studioLayoutV2Schema.safeParse(layout).success).toBe(true);
      expect(validateLayoutV2(layout, context(i)), JSON.stringify(layout)).toMatchObject({ ok: true });
      expect(layout.photos?.map(p => p.photoIndex)).toEqual(i.photos.map(p => p.photoIndex));
      expect(layout.text.map(t => t.copyIndex)).toEqual([0, 1, 2]);
      expect(layout.artDirection?.omittedPhotos).toEqual([]);
      expect(solveRecipe(i)).toEqual(layout);
    });
  }
  for (const recipe of ['hero_storyboard', 'photo_sequence', 'photo_mosaic'] as const) for (const count of [6, 10]) {
    it(`${recipe} carries ${count} explicitly required images on a wide canvas`, () => {
      const i = input(recipe, 1920, 1080, count);
      const layout = solveRecipe(i);
      expect(validateLayoutV2(layout, context(i))).toMatchObject({ ok: true });
      expect(studioLayoutV2Schema.safeParse(layout).success).toBe(true);
      expect(layout.photos).toHaveLength(count);
    });
  }
  for (const count of [6, 10]) for (const [width, height] of [[1080, 1350], [1080, 1080], [1080, 1920], [1920, 1080]]) for (const rtl of [false, true]) {
    it(`keeps a coverage-safe alternative for ${count} photos at ${width}x${height} ${rtl ? 'RTL' : 'LTR'}`, () => {
      const feasible: RecipeId[] = [];
      for (const recipe of ['hero_storyboard', 'photo_sequence', 'photo_mosaic'] as const) {
        const i = input(recipe, width, height, count, rtl);
        try {
          const layout = solveRecipe(i);
          expect(validateLayoutV2(layout, context(i))).toMatchObject({ ok: true });
          expect(layout.photos).toHaveLength(count);
          feasible.push(recipe);
        } catch (error) {
          // A shape may be infeasible; it must refuse explicitly rather than lose source coverage.
          if (!(error instanceof RecipeInfeasibleError)) throw error;
          expect(error.code).toBe('RECIPE_INFEASIBLE');
        }
      }
      expect(feasible.length, `${count} photos: no feasible ${width}x${height} ${rtl ? 'RTL' : 'LTR'} composition`).toBeGreaterThan(0);
    });
  }
  it('keeps pair width proportional to source aspect and mirrors reading placement without flipping pixels', () => {
    const a = solveRecipe(input('photo_diptych')), b = solveRecipe(input('photo_diptych', 1080, 1350, 2, true));
    expect(a.photos![0].width).toBeGreaterThan(a.photos![1].width);
    expect(b.photos![0].x).toBeGreaterThan(b.photos![1].x);
    expect(a.photos![0].focus).toEqual(b.photos![0].focus);
    expect(a.photos![1].focus).toEqual(b.photos![1].focus);
  });
  it('produces geometrically distinct three-concept coverage alternatives rather than color-only variants', () => {
    const i = input('hero_storyboard', 1920, 1080, 6);
    const raw: RawArtDirectionConcept = { id: 'same', recipe: 'hero_storyboard', typicality: .5, conceptNote: 'same',
      heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: i.choice.slots,
      titleAccentWords: null, fadeShare: null, surfaceTone: 'cream', frame: 'none', align: 'start' };
    const copyBlocks: CopyBlockSlotInput[] = Object.entries(i.copy.text).map(([index, text]) => ({ index: Number(index), text, role: Number(index) === 0 ? 'title' : Number(index) === 2 ? 'cta' : 'body', script: 'latin' as const }));
    const choices = normalizeConcepts([raw, raw, raw], i.photos, copyBlocks, i.photoSelection);
    expect(new Set(choices.map(c => c.recipe)).size).toBe(3);
    const result = solveConcepts(choices, { brief: '', copyBlocks, photos: i.photos, photoSelection: i.photoSelection,
      palette, canvasWidth: i.width, canvasHeight: i.height });
    expect(result.layouts).toHaveLength(3);
    expect(new Set(result.layouts.map(l => JSON.stringify([l.photos?.map(p => [p.x, p.y, p.width, p.height]), l.text.map(t => [t.x, t.y, t.width, t.height])]))).size).toBe(3);
  });
  it('refuses insufficient coverage rather than dropping explicitly required photos into an undersized recipe', () => {
    expect(eligibleRecipes(photos, 6)).toEqual(expect.arrayContaining(['hero_storyboard', 'photo_sequence', 'photo_mosaic']));
    expect(eligibleRecipes(photos, 6)).not.toContain('photo_diptych');
    expect(() => solveRecipe(input('photo_diptych', 1080, 1350, 6))).toThrow(/capacity 2/);
    expect(() => solveRecipe(input('editorial_split', 1080, 1350, 2))).toThrow(/capacity 1/);
  });
  it('preserves real group regions in packing or refuses infeasible crops, never fabricating a focus', () => {
    const group = { ...photos[0], width: 2000, height: 1000, regions: [
      { kind: 'face' as const, x: .02, y: .25, width: .1, height: .15 },
      { kind: 'face' as const, x: .88, y: .25, width: .1, height: .15 }] };
    const packed = packPhotoSequence([group, { ...group, photoIndex: 1 }], { x: 0, y: 0, width: 1200, height: 1200 }, 0, 1200);
    expect(packed).toHaveLength(2);
    expect(packed?.map(p => [p.width, p.height])).toEqual([[1200, 600], [1200, 600]]);
    expect(packPhotoSequence([group, { ...group, photoIndex: 1 }], { x: 0, y: 0, width: 300, height: 1800 }, 12, 1080)).toBeNull();
    expect(packPhotoSequence([{ ...group, regionStatus: 'invalid' }, group], { x: 0, y: 0, width: 1200, height: 1200 }, 0, 1200)).toBeNull();
  });
  it('rejects malformed/unbounded packing inputs', () => {
    expect(packPhotoSequence(photos.concat(photos[0]), { x: 0, y: 0, width: 1000, height: 1000 }, 12, 1000)).toBeNull();
    expect(packPhotoSequence([{ ...photos[0], width: NaN }, photos[1]], { x: 0, y: 0, width: 1000, height: 1000 }, 12, 1000)).toBeNull();
  });
  for (const recipe of ids) it(`${recipe} renders readable exact copy and transfers native source identities`, async () => {
    const i = input(recipe, 1920, 1080, recipe === 'editorial_split' ? 1 : recipe === 'photo_diptych' ? 2 : 6);
    const layout = solveRecipe(i);
    const files = i.photos.map((p, n) => ({ bytes: syntheticPhoto(p.width, p.height, n + 1), mimeType: 'image/png' as const }));
    const rendered = renderLayoutV2(layout, { copyText: i.copy.text, photoFiles: files, logoDataUri: KAAE_TEST_LOGO });
    const qa = evaluateHardQa(layout, { width: i.width, height: i.height, palette, copyText: i.copy.text, copyScripts: ['latin', 'latin', 'latin'],
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, photoCount: files.length, photoSelection: i.photoSelection,
      renderedComposite: rendered.noTextPng, photoRegions: i.photos });
    expect(qa.passed, qa.messages.join('\n')).toBe(true);
    const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    const logo = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const deck = await encodeStudioTransferV2(layout, Object.values(i.copy.text), { bytes: logo, mimeType: 'image/png', sha256: digest(logo) }, { photos: files });
    const zip = unzipSync(deck.bytes), xml = strFromU8(zip['ppt/slides/slide1.xml']);
    expect((xml.match(/<p:pic>/g) ?? []).length).toBe(files.length + 1);
    const hashes = new Set(Object.entries(zip).filter(([path]) => path.startsWith('ppt/media/') && !path.endsWith('/')).map(([, b]) => digest(b)));
    for (const f of files) expect(hashes.has(digest(f.bytes))).toBe(true);
    expect(hashes.has(digest(logo))).toBe(true);
    for (const copy of Object.values(i.copy.text)) expect(xml).toContain(copy);
  });
});

const preference: RecipePreferenceContext = { clientId: 'client-one', referenceClientId: 'client-one', policySha256: 'a'.repeat(64),
  loadedIds: ['approved-reference'], matches: [{ id: 'approved-reference', recipe: 'hero_fade_report', subjectMatches: ['report_release'] }] };
describe('Scoped style preference boundary', () => {
  const a = { artDirection: { recipe: 'editorial_split', heroUpscale: 1 } } as any;
  const b = { artDirection: { recipe: 'hero_fade_report', heroUpscale: 1 } } as any;
  it('does not activate a global report-fade prior from subject tags alone', () => {
    expect(artDirectionPrior(a, b, ['report_release'])).toMatchObject({ winner: null, basis: null });
  });
  it('uses loaded subject-matched references for the current client and records their policy', () => {
    expect(artDirectionPrior(a, b, ['report_release'], preference)).toMatchObject({ winner: 'b', basis: 'client_reference', reason: expect.stringContaining('aaaaaaaaaaaa') });
  });
  it('refuses cross-client, unloaded, unrelated or unbound reference preferences', () => {
    for (const context of [{ ...preference, referenceClientId: 'other' }, { ...preference, loadedIds: [] }, { ...preference, policySha256: '' }])
      expect(scopedReferenceRecipes(['report_release'], context)).toEqual([]);
    expect(scopedReferenceRecipes(['unrelated'], preference)).toEqual([]);
  });
});
