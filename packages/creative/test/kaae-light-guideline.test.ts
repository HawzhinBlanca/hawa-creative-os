import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { studioReferenceFromRaw } from '../src/studio/hard-qa.js';
import { solveRecipe, brandTones, type ArtDirectionChoice, type SolverPhoto } from '../src/studio/art-direction/solver.js';
import { solveConcepts } from '../src/studio/art-direction/generate.js';
import { artDirectionPrior } from '../src/studio/art-direction/prior.js';
import { tonePreferenceFromWords, resolveSurfaceTone, toneGroundHex } from '../src/studio/art-direction/tone.js';
import { nearestGroundColour, prepareGeneratedLayoutV3 } from '../src/studio/pipeline-v3.js';
import { scaleNormalizedLayoutToV2, buildLayoutV3SystemPrompt, balanceCanvasMargins } from '../src/studio/layout-generator-v3.js';
import { calculateLuminanceContrastRatio, hexToLuminance } from '../src/studio/composite-contrast.js';

/**
 * ADR-236 (owner, 2026-10-01): KAAE's designs follow its brand guideline, light first. The guideline's
 * palette (#E8B85C, #4770A3, #FFF2DB, #17087A, #3833A3, #0F73DE, white, black body ink) replaces the
 * navy set of 13 September; the default page is white or cream; indigo is for bands, plates, tabs and
 * scrims; a dark ground is for what calls for one.
 */

const RAW = JSON.parse(readFileSync(new URL('../assets/kaae-reference.json', import.meta.url), 'utf8'));
const REF = studioReferenceFromRaw(RAW);
const PALETTE = REF.palette;
const [WHITE, CREAM, INDIGO, ROYAL] = ['#FFFFFF', '#FFF2DB', '#17087A', '#3833A3'];
const OWNER = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward education quality improvement.' };
const SLOTS: ArtDirectionChoice['slots'] = [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }];
const photo = (quietLuminance: number): SolverPhoto => ({ photoIndex: 0, width: 2048, height: 1536, salient: { x: 0.5, y: 0.45 }, quiet: 'top', quietLuminance });
const context = (): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 3, copyScripts: ['latin', 'latin', 'latin'], photoCount: 1,
  photoSelection: { mode: 'choose', minimum: 1 }, reference: { rules: { fontFamily: 'Verdana', palette: PALETTE }, logoAspect: 1 },
});
const solve = (recipe: ArtDirectionChoice['recipe'], params: ArtDirectionChoice['params'], p = photo(0.8)) => solveRecipe({
  width: 1080, height: 1350, copy: { text: OWNER }, photos: [p], palette: PALETTE, logoAspect: 1,
  choice: { recipe, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params },
});
const contrast = (a: string, b: string) => calculateLuminanceContrastRatio(hexToLuminance(a), hexToLuminance(b));

it.each(['editorial_split', 'photo_diptych', 'photo_sequence', 'photo_mosaic'] as const)(
  '%s preserves requester-selected white paper across content-aware compositions', (recipe) => {
    const photos = recipe === 'editorial_split' ? [photo(0.8)] : [photo(0.8), { ...photo(0.8), photoIndex: 1 }];
    const layout = solveRecipe({ width: 1080, height: 1350, copy: { text: OWNER }, photos,
      palette: PALETTE, logoAspect: 1, choice: { recipe, heroPhotoIndex: 0,
        supportingPhotoIndices: photos.slice(1).map(p => p.photoIndex), texturePhotoIndex: null,
        cutoutPhotoIndex: null, slots: SLOTS, params: { surfaceTone: 'cream', paper: 'white', frame: 'none' } } });
    expect(layout.background.color).toBe(WHITE);
    expect(layout.photos?.map(p => p.photoIndex)).toEqual(photos.map(p => p.photoIndex));
  });

describe('the reference and the hard-QA palette are the guideline\'s', () => {
  it('reads the guideline palette, light grounds first, with no indigo ban', () => {
    expect(PALETTE).toEqual([WHITE, CREAM, INDIGO, ROYAL, '#4770A3', '#0F73DE', '#E8B85C', '#000000']);
    expect(REF.promotedRules).not.toMatch(/never use[^.]*indigo/i);
    expect(brandTones(PALETTE)).toEqual({ navy: INDIGO, deep: ROYAL, gold: '#E8B85C', cream: CREAM, white: WHITE });
  });

  it('accepts a design on the guideline\'s indigo and royal indigo, and refuses the old midnight navy', () => {
    const plate = solve('hero_plate', { frame: 'none', align: 'center', surfaceTone: 'navy' });
    expect(plate.shapes.some((s) => s.color === ROYAL)).toBe(true);
    expect(validateLayoutV2(plate, context())).toMatchObject({ ok: true });
    const light = solve('hero_fade_report', { frame: 'inset', align: 'start', surfaceTone: 'cream', paper: 'white' });
    expect(validateLayoutV2(light, context())).toMatchObject({ ok: true });
    const old = { ...plate, background: { color: '#0A1628' } };
    expect(validateLayoutV2(old, context())).toMatchObject({ ok: false, code: 'PALETTE' });
  });

  it('never snaps a ground to the black body ink: a navy ground goes to indigo, black text stays black', () => {
    expect(nearestGroundColour('#0A1628', PALETTE)).toBe(INDIGO);
    expect(nearestGroundColour('#000000', PALETTE)).toBe(INDIGO);
    expect(nearestGroundColour('#FFF0D5', PALETTE)).toBe(CREAM);
    // A palette without a dark blue keeps its black.
    expect(nearestGroundColour('#050505', ['#000000', '#FFFFFF', '#E8B85C'])).toBe('#000000');
    const layout = solve('fade_to_paper', { surfaceTone: 'cream', align: 'start' });
    const prepared = prepareGeneratedLayoutV3({ ...layout, background: { color: '#0A1628' } }, { text: OWNER }, { width: 1080, height: 1350, palette: PALETTE });
    expect(prepared.background.color).toBe(INDIGO);
  });
});

describe('the requester\'s words name the ground', () => {
  const tone = (s: string) => tonePreferenceFromWords(s);
  it('reads light, white, cream and the brand book', () => {
    expect(tone('Please put it on a white background')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('Make it look like the brand book')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('as per the brand guidelines please')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('light cream background')).toMatchObject({ tone: 'light', ground: 'cream' });
    expect(tone('a light design, nothing heavy')).toMatchObject({ tone: 'light' });
    expect(tone('باکگراوندی سپی بێت')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('ڕەنگی کرێمی')).toMatchObject({ tone: 'light', ground: 'cream' });
  });

  it('reads dark, navy and the occasions the guideline sets on indigo', () => {
    expect(tone('use a dark navy background')).toMatchObject({ tone: 'dark', basis: 'colour' });
    expect(tone('An invitation for our evening gala dinner')).toMatchObject({ tone: 'dark', basis: 'occasion' });
    expect(tone('for the keynote stage screen')).toMatchObject({ tone: 'dark' });
    // The owner's K-12 brief of 2026-09-30 names the palette and then the ground.
    expect(tone('Use KAAE’s navy blue, yellow, and white brand colors, with a dark navy overlay or gradient toward the lower section')).toMatchObject({ tone: 'dark' });
    expect(tone('باکگراوندەکەی تۆخ بێت')).toMatchObject({ tone: 'dark' });
    expect(tone('بانگهێشتنامەیەک بۆ ئاهەنگی ئێوارە')).toMatchObject({ tone: 'dark', basis: 'occasion' });
  });

  it('ignores a colour that names the text, a negated tone and words with other senses', () => {
    expect(tone('white text on a navy background')).toMatchObject({ tone: 'dark' });
    expect(tone('dark blue text on a white background')).toMatchObject({ tone: 'light', ground: 'white' });
    expect(tone('not too dark please')).toBeUndefined();
    expect(tone('Light refreshments will be served')).toBeUndefined();
    expect(tone('Our research paper on school quality')).toBeUndefined();
    expect(tone('Design a poster for the Quality Assurance Workshop. For school principals. Seats are limited, please register early')).toBeUndefined();
    // A gala on a white background: the ground named with its noun wins over the occasion.
    expect(tone('our evening gala, white background please')).toMatchObject({ tone: 'light', ground: 'white' });
  });

  it('sets the ground colour of a tone from the palette', () => {
    expect(toneGroundHex({ tone: 'light', ground: 'white' }, PALETTE)).toBe(WHITE);
    expect(toneGroundHex({ tone: 'light', ground: 'cream' }, PALETTE)).toBe(CREAM);
    expect(toneGroundHex({ tone: 'light' }, PALETTE)).toBe(WHITE);
    expect(toneGroundHex({ tone: 'dark' }, PALETTE)).toBe(INDIGO);
  });
});

describe('photo recipes sit on the light page unless the brief or the photo calls for dark', () => {
  it('resolves the ground: words first, then a dark hero, else light', () => {
    expect(resolveSurfaceTone({ requested: 'navy', heroLuminance: 0.8 })).toEqual({ surfaceTone: 'cream', paper: 'cream' });
    expect(resolveSurfaceTone({ requested: 'navy', heroLuminance: 0.15 })).toEqual({ surfaceTone: 'navy', paper: 'cream' });
    expect(resolveSurfaceTone({ heroLuminance: 0.15 })).toMatchObject({ surfaceTone: 'navy' });
    expect(resolveSurfaceTone({ requested: 'cream', heroLuminance: 0.15 })).toMatchObject({ surfaceTone: 'cream' });
    expect(resolveSurfaceTone({ requested: 'cream', preference: { tone: 'dark' } })).toMatchObject({ surfaceTone: 'navy' });
    expect(resolveSurfaceTone({ requested: 'navy', preference: { tone: 'light', ground: 'white' } })).toEqual({ surfaceTone: 'cream', paper: 'white' });
  });

  for (const recipe of ['hero_fade_report', 'hero_plate', 'scrim_caption', 'hero_card', 'fade_to_paper'] as const) {
    it(`${recipe}: a light variant on the page and a dark variant on indigo, both readable and valid`, () => {
      const params = { frame: recipe === 'hero_card' ? 'outer' as const : 'inset' as const, align: recipe === 'hero_plate' || recipe === 'hero_card' ? 'center' as const : 'start' as const };
      const light = solve(recipe, { ...params, surfaceTone: 'cream' });
      expect([CREAM, WHITE]).toContain(light.background.color);
      for (const o of light.overlays ?? []) expect([CREAM, WHITE]).toContain(o.color);
      expect(validateLayoutV2(light, context()), recipe).toMatchObject({ ok: true });
      if (recipe !== 'fade_to_paper') {
        const dark = solve(recipe, { ...params, surfaceTone: 'navy' });
        expect(dark.background.color).toBe(INDIGO);
        expect(validateLayoutV2(dark, context())).toMatchObject({ ok: true });
      }
      // Gold is never set as text on the light page; the light page's title is indigo.
      for (const t of light.text) {
        const onPage = !light.shapes.some((s) => s.role === 'panel' && s.fill !== 'none' && t.x >= s.x && t.y >= s.y && t.x + t.width <= s.x + s.width && t.y + t.height <= s.y + s.height);
        if (onPage) expect(contrast(t.color, light.background.color), `${recipe} ${t.role}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('fade_to_paper on white paper is the guideline\'s page: an indigo band across the top with the logo and title', () => {
    const page = solve('fade_to_paper', { surfaceTone: 'cream', paper: 'white', align: 'start' });
    expect(page.background.color).toBe(WHITE);
    const band = page.shapes.find((s) => s.surface === 'plate')!;
    expect(band).toMatchObject({ x: 0, y: 0, width: 1080, color: INDIGO });
    expect(page.logo.y + page.logo.height).toBeLessThan(band.height);
    expect(page.text.find((t) => t.role === 'title')!.color).toBe(WHITE);
    expect(validateLayoutV2(page, context())).toMatchObject({ ok: true });
  });

  it('solveConcepts puts a navy concept for a bright photo on the page, and keeps a requested dark ground', () => {
    const copyBlocks = [0, 1, 2].map((index) => ({ index, text: OWNER[index as 0 | 1 | 2], script: 'latin' as const, role: index === 0 ? 'title' : index === 1 ? 'subtitle' : 'body' }));
    const choice: ArtDirectionChoice = { recipe: 'hero_fade_report', heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params: { frame: 'inset', align: 'start', surfaceTone: 'navy' } };
    const opts = { brief: '', copyBlocks: copyBlocks as any, palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350, photos: [photo(0.8)] as any, logoAspect: 1 };
    expect(solveConcepts([choice], opts).layouts[0].background.color).toBe(CREAM);
    expect(solveConcepts([choice], { ...opts, tonePreference: { tone: 'dark' } }).layouts[0].background.color).toBe(INDIGO);
    expect(solveConcepts([choice], { ...opts, photos: [photo(0.12)] as any }).layouts[0].background.color).toBe(INDIGO);
  });

  it('the house tie-break sees no difference between the light and dark variants of a recipe', () => {
    const light = solve('hero_fade_report', { frame: 'inset', align: 'start', surfaceTone: 'cream' });
    const dark = solve('hero_fade_report', { frame: 'inset', align: 'start', surfaceTone: 'navy' });
    expect(artDirectionPrior(light, dark, ['report_release'])).toMatchObject({ winner: null });
    expect(artDirectionPrior(dark, light, ['report_release'])).toMatchObject({ winner: null });
  });
});

describe('the typographic layout handles a light canvas', () => {
  it('asks for a quiet calm region relative to the text, not a dark one', () => {
    const prompt = buildLayoutV3SystemPrompt();
    expect(prompt).not.toContain('MUST stay dark');
    expect(prompt).toContain('quiet and light under dark text on a light canvas');
  });

  it('keeps a footer band on the bottom edge when the composition is re-balanced (no sliver of page under it)', () => {
    const band = { kind: 'rect' as const, role: 'panel' as const, color: INDIGO, x: 0, y: 932, width: 1080, height: 418 };
    const l: any = {
      width: 1080, height: 1350, grid: { margin: 76, columns: 12, gutter: 20, baseline: 8 }, shapes: [band],
      text: [{ copyIndex: 0, role: 'title', x: 120, y: 330, width: 840, height: 200 }, { copyIndex: 1, role: 'date', x: 86, y: 1000, width: 900, height: 50 }],
      logo: { x: 86, y: 81, width: 130, height: 130 },
    };
    expect(balanceCanvasMargins(l)).toBe(1);
    expect(band.y + band.height).toBe(1350);
    expect(l.logo.y).not.toBe(81);
  });

  it('puts a candidate that names no ground on the palette\'s lightest colour, with dark text', () => {
    const layout = scaleNormalizedLayoutToV2({
      id: '1', conceptTitle: 't', compositionArchetype: 'monolith_centered', typeScale: { base: 18, ratio: 1.333 },
      grid: { margin: 0.07, columns: 12, gutter: 0.02, baseline: 0.006 }, background: undefined as any,
      logo: { x: 0.44, y: 0.06, width: 0.12, height: 0.096 }, art: null, shapes: [],
      text: [{ copyIndex: 0, role: 'title', x: 0.1, y: 0.3, width: 0.8, height: 0.1, fontSize: 0.05, lineHeight: 1.2, letterSpacing: 0, fontFamily: 'Verdana', color: '#FFF2DB', align: 'center', bold: true, italic: false, rtl: false }],
    }, 1080, 1350, 1, PALETTE);
    expect(hexToLuminance(layout.text[0].color)).toBeLessThan(0.05);
  });
});
