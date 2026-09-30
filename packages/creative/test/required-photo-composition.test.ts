import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { solveRecipe, type SolveRecipeInput } from '../src/studio/art-direction/solver.js';
import { normalizeConcepts, solveConcepts, type RawArtDirectionConcept } from '../src/studio/art-direction/generate.js';
import type { CopyBlockSlotInput } from '../src/studio/layout-generator-v3.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { evaluateHardQa } from '../src/studio/hard-qa.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import { syntheticPhoto } from './fixtures/synthetic-photos.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

const palette = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const copy = { 0: 'School Field Visit', 1: 'Learning together across six schools', 2: 'kaae.org' };
const photos = Array.from({ length: 6 }, (_, photoIndex) => ({ photoIndex, width: 1280, height: 853, focus: { x: .5, y: .4 } }));
function input(width = 1080, height = 1350): SolveRecipeInput {
  return { width, height, photos, palette, logoAspect: 1, copy: { text: copy },
    choice: { recipe: 'hero_storyboard', heroPhotoIndex: 2, texturePhotoIndex: null, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }, { copyIndex: 2, slot: 'cta' }], params: {} } };
}
const context = (width: number, height: number): LayoutValidationContext => ({ expectedWidth: width, expectedHeight: height, copyCount: 3,
  copyScripts: ['latin', 'latin', 'latin'], photoCount: 6, reference: { rules: { fontFamily: 'Verdana', palette }, logoAspect: 1 } });

describe('ADR-171 required photo composition', () => {
  for (const [width, height] of [[1080, 1350], [1080, 1080], [1080, 1920], [1920, 1080]]) {
    it(`places every photo once with a dominant hero and readable supporting sequence at ${width}x${height}`, () => {
      const layout = solveRecipe(input(width, height));
      expect(validateLayoutV2(layout, context(width, height))).toMatchObject({ ok: true });
      expect(layout.photos!.map(p => p.photoIndex).sort()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(layout.artDirection!.omittedPhotos).toEqual([]);
      const hero = layout.photos!.find(p => p.role === 'hero')!;
      expect(layout.photos!.filter(p => p.role === 'inset').every(p => hero.width * hero.height > 3 * p.width * p.height)).toBe(true);
    });
  }
  it('keeps six required photographs unmirrored with Sorani and mixed-script live copy', () => {
    const text = { 0: 'ڕاپۆرتی سەردانی مەیدانی', 1: 'هەنگاوەکانی داهاتوو بۆ قوتابخانەکان', 2: 'kaae.org' };
    const layout = solveRecipe({ ...input(), copy: { text, scripts: { 0: 'arabic', 1: 'arabic', 2: 'latin' } } });
    expect(validateLayoutV2(layout, { ...context(1080, 1350), copyScripts: ['arabic', 'arabic', 'latin'] })).toMatchObject({ ok: true });
    expect(layout.text.slice(0, 2).every(t => t.rtl === true)).toBe(true);
    expect(layout.photos!.map(p => p.focus)).toEqual(photos.map(p => p.focus));
    expect(layout.photos![0].x).toBe(0);
    expect(layout.photos).toHaveLength(6);
  });
  it('preserves a stated count ("pick 3") and refuses a forged recipe omission', () => {
    const requested = { mode: 'choose' as const, minimum: 3, counted: true };
    const layout = solveRecipe({ ...input(), photoSelection: requested });
    expect(layout.photos).toHaveLength(3);
    expect(validateLayoutV2(layout, { ...context(1080, 1350), photoSelection: requested })).toMatchObject({ ok: true });
    // ADR-180: "use all the photos" binds all six.
    expect(validateLayoutV2(layout, { ...context(1080, 1350), photoSelection: { mode: 'all', minimum: 6, insisted: true } })).toMatchObject({ ok: false, code: 'PHOTOS' });
    const duplicate = { ...layout, photos: [layout.photos![0], layout.photos![0], layout.photos![2]] };
    expect(validateLayoutV2(duplicate, { ...context(1080, 1350), photoSelection: requested })).toMatchObject({ ok: false, code: 'PHOTOS' });
  });
  it('a choose minimum of one still permits the two-photo storyboard without dropping its recipe minimum', () => {
    const requested = { mode: 'choose' as const, minimum: 1 };
    const layout = solveRecipe({ ...input(), photoSelection: requested });
    expect(layout.photos).toHaveLength(2);
    expect(validateLayoutV2(layout, { ...context(1080, 1350), photoSelection: requested })).toMatchObject({ ok: true });
  });
  it('with no words about the photos a single-hero concept stands: the house style (ADR-180)', () => {
    const blocks: CopyBlockSlotInput[] = Object.entries(copy).map(([index, text]) => ({ index: Number(index), text, role: Number(index) === 0 ? 'title' : Number(index) === 2 ? 'cta' : 'body', script: 'latin' as const }));
    const concept: RawArtDirectionConcept = { id: 'hero', conceptNote: 'One hero', recipe: 'scrim_caption', typicality: .7,
      heroPhotoIndex: 1, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: [], titleAccentWords: null,
      fadeShare: null, surfaceTone: 'navy', frame: 'none', align: 'start' };
    for (const selection of [undefined, { mode: 'all' as const, minimum: 6 }, { mode: 'choose' as const, minimum: 3 }]) {
      const choices = normalizeConcepts([concept], photos, blocks, selection);
      expect(choices[0].recipe).toBe('scrim_caption');
      expect(choices.some((c) => c.recipe === 'hero_storyboard')).toBe(false);
    }
  });
  it('normalizes an invalid model concept when the requester asked for every photo and solves all six', () => {
    const blocks: CopyBlockSlotInput[] = Object.entries(copy).map(([index, text]) => ({ index: Number(index), text, role: Number(index) === 0 ? 'title' : Number(index) === 2 ? 'cta' : 'body', script: 'latin' as const }));
    const choices = normalizeConcepts([{
      id: 'untrusted', conceptNote: 'Discard five photos', recipe: 'hero_card', typicality: .7,
      heroPhotoIndex: 99, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: [], titleAccentWords: null,
      fadeShare: null, surfaceTone: 'navy', frame: 'none', align: 'start',
    }], photos, blocks, { mode: 'all', minimum: 6, insisted: true });
    expect(choices.every(c => c.recipe === 'hero_storyboard')).toBe(true);
    const solved = solveConcepts(choices, { brief: '', copyBlocks: blocks, palette, photos, canvasWidth: 1080, canvasHeight: 1350, photoSelection: { mode: 'all', minimum: 6, insisted: true } });
    expect(solved.layouts).toHaveLength(3);
    expect(solved.layouts.every(l => l.photos?.length === 6)).toBe(true);
  });
  it('final QA detects individual subjects lost in supporting-photo crops after solving', () => {
    const layout = solveRecipe(input());
    const outcome = evaluateHardQa(layout, { width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'],
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette, logoAspect: 1, copyText: copy, photoCount: 6,
      photoRegions: photos.map((p, i) => ({ width: p.width, height: p.height, regionStatus: 'measured', regions: i === 1 ? [
        { kind: 'face', x: .02, y: .15, width: .1, height: .1 },
        { kind: 'face', x: .85, y: .15, width: .1, height: .1 },
      ] : [] })) });
    expect(outcome.passed).toBe(false);
    expect(outcome.defectCodes).toContain('PHOTO_SUBJECT_CROPPED');
    expect(outcome.messages.some(m => m.includes('photo 1 region'))).toBe(true);
  });

  it('shows absent detector evidence explicitly without fabricating a measured empty result', () => {
    const layout = solveRecipe(input());
    const outcome = evaluateHardQa(layout, { width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'],
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette, logoAspect: 1, copyText: copy, photoCount: 6,
      photoRegions: photos.map(() => undefined) });
    expect(outcome.findings.filter(f => f.code === 'PHOTO_REGIONS_UNMEASURED')).toHaveLength(6);
  });

  it('passes measured local QA and carries six native images plus exact live text into the Canva deck', async () => {
    const layout = solveRecipe(input());
    const photoFiles = photos.map((p, i) => ({ bytes: syntheticPhoto(p.width, p.height, i + 1) }));
    const rendered = renderLayoutV2(layout, { copyText: copy, photoFiles, logoDataUri: KAAE_TEST_LOGO });
    const qa = evaluateHardQa(layout, { width: 1080, height: 1350, copyScripts: ['latin', 'latin', 'latin'], latinFont: 'Verdana',
      arabicFont: 'Noto Sans Arabic', palette, logoAspect: 1, copyText: copy, photoCount: 6, renderedComposite: rendered.noTextPng });
    expect(qa.passed, qa.messages.join('\n')).toBe(true);
    const transfer = await encodeStudioTransferV2(layout, Object.values(copy), undefined, { photos: photoFiles.map(p => ({ ...p, mimeType: 'image/png' as const })) });
    const zip = unzipSync(transfer.bytes);
    const xml = strFromU8(zip['ppt/slides/slide1.xml']);
    expect((xml.match(/<p:pic>/g) ?? []).length).toBeGreaterThanOrEqual(6);
    for (const text of Object.values(copy)) expect(xml).toContain(text);
    // Optional local proof artifact uses synthetic photographs; never private client assets.
    if (process.env.HAWA_REQUIRED_PHOTO_OUT) {
      mkdirSync(process.env.HAWA_REQUIRED_PHOTO_OUT, { recursive: true });
      writeFileSync(join(process.env.HAWA_REQUIRED_PHOTO_OUT, 'six-photo-local-preview.png'), rendered.png);
      writeFileSync(join(process.env.HAWA_REQUIRED_PHOTO_OUT, 'six-photo-native-source.pptx'), transfer.bytes);
    }
  });
});
