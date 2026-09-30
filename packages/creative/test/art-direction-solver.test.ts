import { describe, expect, it } from 'vitest';
import { studioLayoutV2Schema, type RecipeId, type StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { declaredTextContrast } from '../src/studio/composite-contrast.js';
import { requiredContrast } from '../src/studio/house-rules.js';
import { copyOrderViolations } from '../src/studio/hard-qa.js';
import { evaluateDesignMetrics } from '../src/studio/design-metrics.js';
import { measureWrappedLines } from '../src/studio/render-layout-v2.js';
import { prepareGeneratedLayoutV3, settlePhotos, fitPhotoBoxesToImages, rankCandidatesV3 } from '../src/studio/pipeline-v3.js';
import { coverCrop } from '../src/studio/photo-crop.js';
import {
  RecipeInfeasibleError,
  brandTones,
  normalizeSlots,
  solveRecipe,
  type ArtDirectionChoice,
  type SolverPhoto,
} from '../src/studio/art-direction/solver.js';
import { carrierOf } from '../src/studio/art-direction/surfaces.js';

/**
 * ADR-170: the recipe solver. Every recipe, on every canvas the office orders, in both directions,
 * must give a layout the validator accepts as it stands: text inside the safe area, no two blocks
 * overlapping, the logo's clear space kept, the copy in its order, every block legible on the
 * surface it declares, and any text over a photo carried by a plate, card, pill, fade or scrim.
 */

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const LATIN = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward', 3: 'kaae.org' };
const SORANI = {
  0: 'توێژینەوەی پیلۆتی K-12ی کەی ئەی',
  1: 'ڕاپۆرتی سەردانی مەیدانی',
  2: 'تێڕوانینەکان لە سەردانە مەیدانییەکانی کەی ئەی بۆ قوتابخانەکان و هەنگاوەکانی داهاتوو',
  3: 'kaae.org',
};

/** Six field-visit photos as the album delivers them: 1280x853 landscape. */
const PHOTOS: SolverPhoto[] = Array.from({ length: 6 }, (_, i) => ({
  photoIndex: i,
  width: 1280,
  height: 853,
  salient: { x: 0.45, y: 0.4 },
  quiet: i === 5 ? 'top' : 'none',
  quietLuminance: 0.8,
  ...(i === 3 ? { focus: { x: 0.3, y: 0.35 }, cutoutSize: { width: 600, height: 1100 } } : {}),
}));

const SIZES: Array<[number, number]> = [[1080, 1350], [1080, 1080], [1920, 1080], [1080, 1920]];
const RECIPES: RecipeId[] = ['hero_fade_report', 'hero_card', 'hero_plate', 'scrim_caption', 'sky_title', 'cutout_speaker', 'fade_to_paper'];

function choice(recipe: RecipeId): ArtDirectionChoice {
  return {
    recipe,
    heroPhotoIndex: recipe === 'sky_title' || recipe === 'hero_plate' ? 5 : 0,
    texturePhotoIndex: 4,
    cutoutPhotoIndex: recipe === 'cutout_speaker' ? 3 : null,
    slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }, { copyIndex: 3, slot: 'cta' }],
    params: { frame: 'inset', align: 'start', fadeShare: 0.46 },
  };
}

function solve(recipe: RecipeId, w: number, h: number, rtl: boolean): StudioLayoutV2 {
  return solveRecipe({
    width: w, height: h, choice: choice(recipe), copy: { text: rtl ? SORANI : LATIN },
    photos: PHOTOS, palette: PALETTE, logoAspect: 1,
  });
}

function context(w: number, h: number, rtl: boolean, insisted = false): LayoutValidationContext {
  return {
    expectedWidth: w, expectedHeight: h, copyCount: 4,
    copyScripts: rtl ? ['arabic', 'arabic', 'arabic', 'latin'] : ['latin', 'latin', 'latin', 'latin'],
    photoCount: 6,
    photoSelection: insisted ? { mode: 'all', minimum: 6, insisted: true } : { mode: 'choose', minimum: 1 },
    reference: { rules: { fontFamily: 'Verdana', palette: PALETTE }, logoAspect: 1 },
  };
}

const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('recipe solver (ADR-170): every recipe x size x direction', () => {
  for (const recipe of RECIPES) {
    for (const [w, h] of SIZES) {
      for (const rtl of [false, true]) {
        it(`${recipe} ${w}x${h} ${rtl ? 'RTL' : 'LTR'}`, () => {
          // A landscape photo on a 9:16 story leaves the plate no quiet band below the story's unsafe
          // top without enlarging the photo past 1.3x: the recipe is refused, not forced.
          if (recipe === 'hero_plate' && h / w >= 1.7) {
            expect(() => solve(recipe, w, h, rtl)).toThrow(RecipeInfeasibleError);
            return;
          }
          const layout = solve(recipe, w, h, rtl);
          expect(studioLayoutV2Schema.safeParse(layout).success).toBe(true);
          const result = validateLayoutV2(layout, context(w, h, rtl));
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
          expect(layout.artDirection).toMatchObject({ recipe, rtl });
          // Bounds: every element inside the canvas.
          for (const el of [...layout.text, ...layout.shapes, ...(layout.photos ?? []), ...(layout.overlays ?? []), layout.logo]) {
            expect(el.x).toBeGreaterThanOrEqual(0);
            expect(el.y).toBeGreaterThanOrEqual(0);
            expect(el.x + el.width).toBeLessThanOrEqual(w);
            expect(el.y + el.height).toBeLessThanOrEqual(h);
          }
          // No two text slots overlap; the copy stays in its order.
          for (const a of layout.text) for (const b of layout.text) if (a !== b) expect(hit(a, b)).toBe(false);
          expect(copyOrderViolations(layout)).toEqual([]);
          // Every block legible on the surface it declares; text over a photo carried by one.
          for (const t of layout.text) {
            expect(declaredTextContrast(layout, t)).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, Boolean(t.bold)));
            if ((layout.photos ?? []).some((p) => hit(p, t))) expect(carrierOf(layout, t), `block ${t.copyIndex}`).toBeDefined();
          }
          // Photos are left out, never gridded: at most a hero and a texture (or one cut-out).
          expect((layout.photos ?? []).length).toBeLessThanOrEqual(2);
          expect(layout.artDirection!.omittedPhotos.length).toBe(6 - (layout.photos ?? []).length);
          // Recipe metrics: a quiet region for the title, not an empty canvas.
          const metrics = evaluateDesignMetrics(layout, { wrappedLines: measureWrappedLines(layout, rtl ? SORANI : LATIN) });
          expect(metrics.metrics.negativeSpace.details).toMatchObject({ measure: 'recipe_quiet_region', titleInQuietRegion: true, bareTextOnPhoto: [] });
          expect(metrics.metrics.negativeSpace.passed).toBe(true);
          expect(metrics.metrics.textLegibility.passed).toBe(true);
        });
      }
    }
  }

  // The owner's K-12 request has three blocks and no URL: the stack ends on body text, not a pill.
  for (const recipe of RECIPES) {
    for (const [w, h] of SIZES) {
      for (const rtl of [false, true]) {
        it(`${recipe} ${w}x${h} ${rtl ? 'RTL' : 'LTR'} with three blocks and no call to action`, () => {
          const text = rtl ? { 0: SORANI[0], 1: SORANI[1], 2: SORANI[2] } : { 0: LATIN[0], 1: LATIN[1], 2: LATIN[2] };
          if (recipe === 'hero_plate' && h / w >= 1.7) return;
          const layout = solveRecipe({
            width: w, height: h, copy: { text }, photos: PHOTOS, palette: PALETTE, logoAspect: 1,
            choice: { ...choice(recipe), slots: choice(recipe).slots.slice(0, 3) },
          });
          const ctx = { ...context(w, h, rtl), copyCount: 3, copyScripts: context(w, h, rtl).copyScripts.slice(0, 3) };
          expect(validateLayoutV2(layout, ctx)).toMatchObject({ ok: true });
        });
      }
    }
  }

  it('is deterministic', () => {
    expect(solve('hero_fade_report', 1080, 1350, false)).toEqual(solve('hero_fade_report', 1080, 1350, false));
  });

  it('never flips a photo for right-to-left copy: the hero box and crop are the same in both directions', () => {
    const ltr = solve('hero_fade_report', 1080, 1350, false);
    const rtl = solve('hero_fade_report', 1080, 1350, true);
    const [a, b] = [ltr.photos![0], rtl.photos![0]];
    expect({ index: b.photoIndex, x: b.x, width: b.width, focus: b.focus }).toEqual({ index: a.photoIndex, x: a.x, width: a.width, focus: a.focus });
    // Text mirrors: the title is left-aligned in English and right-aligned in Sorani.
    expect(ltr.text.find((t) => t.role === 'title')!.align).toBe('left');
    expect(rtl.text.find((t) => t.role === 'title')!.align).toBe('right');
    expect(rtl.logo.x).toBeGreaterThan(ltr.logo.x);
  });

  it('hero_fade_report: title and body on the fade, the gold line gold, the URL in a gold pill, the texture blended', () => {
    const layout = solve('hero_fade_report', 1080, 1350, false);
    const tones = brandTones(PALETTE);
    const title = layout.text.find((t) => t.copyIndex === 0)!;
    const accent = layout.text.find((t) => t.copyIndex === 1)!;
    const cta = layout.text.find((t) => t.copyIndex === 3)!;
    expect(title.color).toBe(tones.white);
    expect(accent.color).toBe(tones.gold);
    const pill = layout.shapes.find((s) => s.surface === 'pill')!;
    expect(pill).toMatchObject({ layer: 'overlay', color: tones.gold });
    expect(carrierOf(layout, cta)).toMatchObject({ kind: 'shape' });
    expect(carrierOf(layout, title)).toMatchObject({ kind: 'overlay' });
    const fade = layout.overlays![0];
    expect(fade).toMatchObject({ purpose: 'fade', color: tones.navy, direction: 'to-bottom' });
    // The fade covers 35-55% of the canvas (rulebook item 3).
    expect(fade.height / 1350).toBeGreaterThanOrEqual(0.35);
    const texture = layout.photos!.find((p) => p.role === 'texture')!;
    expect(texture).toMatchObject({ photoIndex: 4, fade: { edge: 'top' } });
    // It rises just into the hero, fully transparent at its top edge, and lies under the fade.
    expect(texture.y).toBeGreaterThanOrEqual(fade.y - 0.1 * fade.height);
    expect(texture.y + texture.height).toBe(1350);
    // The hero bleeds off the top and both sides.
    const hero = layout.photos!.find((p) => p.role === 'hero')!;
    expect(hero).toMatchObject({ x: 0, y: 0, width: 1080 });
    // A thin gold inset line frames the single report post (rulebook item 6).
    expect(layout.shapes.find((s) => s.role === 'frame')).toMatchObject({ fill: 'none', strokeColor: tones.gold });
  });

  it('a slot a concept gets wrong is repaired from the brief, never dropped', () => {
    const slots = normalizeSlots({
      choice: { ...choice('hero_fade_report'), slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 2, slot: 'accent' }, { copyIndex: 3, slot: 'cta' }] },
      copy: { text: { 0: 'A', 1: 'B', 2: 'C', 3: 'a very long sentence that is certainly not a call to action and so must be body text' } },
      briefRoles: { 1: 'subtitle' },
    });
    // Block 1 had no slot: its brief role makes it the accent beside the title; block 2 is not
    // beside the title, so it cannot be the accent; long copy is never squeezed into a pill.
    expect(slots).toEqual([
      { copyIndex: 0, slot: 'title' },
      { copyIndex: 1, slot: 'accent' },
      { copyIndex: 2, slot: 'body' },
      { copyIndex: 3, slot: 'body' },
    ]);
  });

  it('refuses a recipe it cannot carry rather than forcing it', () => {
    expect(() => solveRecipe({
      width: 1080, height: 1350, choice: { ...choice('cutout_speaker'), cutoutPhotoIndex: 0 }, copy: { text: LATIN },
      photos: PHOTOS.map((p) => ({ ...p, cutoutSize: undefined })), palette: PALETTE, logoAspect: 1,
    })).toThrow(RecipeInfeasibleError);
    const essay = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [i, 'A long paragraph of copy that goes on '.repeat(40)]));
    expect(() => solveRecipe({ width: 1080, height: 1080, choice: choice('sky_title'), copy: { text: essay }, photos: PHOTOS, palette: PALETTE, logoAspect: 1 }))
      .toThrow(RecipeInfeasibleError);
  });

  it('a recipe cannot waive the default all-photo contract or the recorded selection minimum', () => {
    const layout = solve('hero_fade_report', 1080, 1350, false);
    expect(validateLayoutV2(layout, context(1080, 1350, false)).ok).toBe(true);
    expect(validateLayoutV2(layout, context(1080, 1350, false, true))).toMatchObject({ ok: false, code: 'PHOTOS' });
    // ADR-171: both stored minimums bind; a recipe is never authority to reduce them.
    const guessed = { ...context(1080, 1350, false), photoSelection: { mode: 'choose' as const, minimum: 3 } };
    expect(validateLayoutV2(layout, guessed)).toMatchObject({ ok: false, code: 'PHOTOS' });
    expect(validateLayoutV2(layout, { ...guessed, photoSelection: undefined })).toMatchObject({ ok: false, code: 'PHOTOS' });
    const counted = { ...context(1080, 1350, false), photoSelection: { mode: 'choose' as const, minimum: 3, counted: true } };
    expect(validateLayoutV2(layout, counted)).toMatchObject({ ok: false, code: 'PHOTOS' });
  });

  it('preparation preserves solved geometry while honoring a requested background; fitters leave it intact', () => {
    const layout = solve('hero_fade_report', 1080, 1350, false);
    const before = JSON.parse(JSON.stringify(layout));
    const prepared = prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(layout)), { text: LATIN }, {
      width: 1080, height: 1350, logoAspect: 1, palette: PALETTE, background: '#1E3A5F',
      ornament: { texture: true, dividers: true, balance: true } as never,
    });
    // Fonts are re-sanitised (rtl made explicit); no box moves and no ornament is added.
    expect(prepared.photos).toEqual(before.photos);
    expect(prepared.shapes).toEqual(before.shapes);
    expect(prepared.overlays).toEqual(before.overlays.map((o: { color: string }) => ({ ...o, color: o.color === before.background.color ? '#1E3A5F' : o.color })));
    expect(prepared.text.map((t) => [t.x, t.y, t.width, t.height, t.fontSize])).toEqual(before.text.map((t: any) => [t.x, t.y, t.width, t.height, t.fontSize]));
    expect(prepared.background).toMatchObject({ color: '#1E3A5F', decision: { basis: 'requester' } });
    expect(prepared.art).toBeUndefined();
    expect(settlePhotos(JSON.parse(JSON.stringify(layout)))).toEqual(before);
    expect(fitPhotoBoxesToImages(JSON.parse(JSON.stringify(layout)), PHOTOS, { text: LATIN })).toEqual(before);
  });

  // Found in the paid live trials of 2026-09-30 on the owner's KAAE K-12 album.
  describe('live-trial defects (2026-09-30)', () => {
    const OWNER = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward education quality improvement.' };
    /** Photo 3 of the album: two visitors talking, with the detector's face point and tallest face as measured. */
    const faces: SolverPhoto[] = PHOTOS.map((p) => (p.photoIndex === 3 ? { ...p, focus: { x: 0.3078, y: 0.3282 }, faceShare: 0.17, cutoutSize: undefined } : p));
    const plateOn = (photos: SolverPhoto[]) => solveRecipe({
      width: 1080, height: 1350, copy: { text: OWNER }, photos, palette: PALETTE, logoAspect: 1,
      choice: { recipe: 'hero_plate', heroPhotoIndex: 3, texturePhotoIndex: null, cutoutPhotoIndex: null,
        slots: [{ copyIndex: 0, slot: 'accent' }, { copyIndex: 1, slot: 'title' }, { copyIndex: 2, slot: 'body' }], params: { frame: 'inset', align: 'center' } },
    });
    /** The face as the renderer draws it: the detector's point through the hero's cover crop, one face tall. */
    const faceBandOf = (layout: StudioLayoutV2, src: SolverPhoto = faces[3]) => {
      const hero = layout.photos!.find((p) => p.role === 'hero')!;
      const crop = coverCrop(hero, src, hero.focus);
      const scale = hero.height / crop.sh;
      const cy = hero.y + (src.focus!.y * src.height - crop.sy) * scale;
      const half = 0.5 * src.faceShare! * src.height * scale;
      return { top: cy - half, bottom: cy + half };
    };

    it('hero_plate sets its plate in the photo\'s quiet region, never on the people', () => {
      // Photo 3 (two visitors) has no quiet top or bottom: in round one the plate sat on their faces,
      // then, moved below them, on their bodies. The recipe is refused for it.
      expect(() => plateOn(faces)).toThrow(/no quiet top or bottom/);
      // A photo quiet at the top with its people low: the plate stays in the top band, above them.
      const calm: SolverPhoto[] = faces.map((p) => (p.photoIndex === 3 ? { ...p, quiet: 'top', focus: { x: 0.4, y: 0.72 } } : p));
      const layout = plateOn(calm);
      const plate = layout.shapes.find((s) => s.surface === 'plate')!;
      const hero = layout.photos!.find((p) => p.role === 'hero')!;
      expect(plate.y + plate.height).toBeLessThanOrEqual(hero.y + 0.45 * hero.height);
      expect(plate.y + plate.height).toBeLessThanOrEqual(faceBandOf(layout, calm[3]).top);
      expect(validateLayoutV2(layout, { ...context(1080, 1350, false), copyCount: 3, copyScripts: ['latin', 'latin', 'latin'] })).toMatchObject({ ok: true });
      // Quiet at the top but with the faces there too: refused rather than set on them.
      const crowded: SolverPhoto[] = faces.map((p) => (p.photoIndex === 3 ? { ...p, quiet: 'top', focus: { x: 0.5, y: 0.3 } } : p));
      expect(() => plateOn(crowded)).toThrow(/cover the faces/);
    });

    it('refuses a recipe whose copy would sit on a face rather than set it there', () => {
      // Faces low in the frame: the lines of a scrim caption would be set across them.
      const low: SolverPhoto[] = faces.map((p) => (p.photoIndex === 3 ? { ...p, focus: { x: 0.3, y: 0.86 } } : p));
      expect(() => solveRecipe({
        width: 1080, height: 1350, copy: { text: OWNER }, photos: low, palette: PALETTE, logoAspect: 1,
        choice: { recipe: 'scrim_caption', heroPhotoIndex: 3, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: [], params: { frame: 'none', align: 'start' } },
      })).toThrow(/cover the faces/);
    });

    it('a short line beside the title that the brief calls its subtitle is the gold line, not body text', () => {
      // The cut caption's two lines: the model set the report's own name at body size.
      const bodySlot = { ...choice('scrim_caption'), slots: [{ copyIndex: 0, slot: 'title' as const }, { copyIndex: 1, slot: 'body' as const }] };
      expect(normalizeSlots({ choice: bodySlot, copy: { text: { 0: OWNER[0], 1: OWNER[1] } }, briefRoles: { 0: 'title', 1: 'subtitle' } }))
        .toEqual([{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }]);
      // A sentence stays body text, and so does a line the brief does not call a subtitle.
      expect(normalizeSlots({ choice: bodySlot, copy: { text: { 0: OWNER[0], 1: OWNER[2] } }, briefRoles: { 0: 'title', 1: 'subtitle' } })[1].slot).toBe('body');
      expect(normalizeSlots({ choice: bodySlot, copy: { text: { 0: OWNER[0], 1: OWNER[1] } }, briefRoles: { 0: 'title', 1: 'body' } })[1].slot).toBe('body');
    });

    it('ranks the office\'s report layout among the two the judge sees: a frame and a corner logo are not off-grid', () => {
      // The three concepts the layout model proposed in all four runs.
      const slots = [{ copyIndex: 0, slot: 'accent' as const }, { copyIndex: 1, slot: 'title' as const }, { copyIndex: 2, slot: 'body' as const }];
      const concept = (recipe: RecipeId, hero: number, texture: number | null, align: 'start' | 'center') => solveRecipe({
        width: 1080, height: 1350, copy: { text: OWNER }, photos: PHOTOS, palette: PALETTE, logoAspect: 1,
        choice: { recipe, heroPhotoIndex: hero, texturePhotoIndex: texture, cutoutPhotoIndex: null, slots, params: { frame: 'inset', align, fadeShare: 0.46 } },
      });
      const layouts = [concept('hero_fade_report', 0, 4, 'start'), concept('scrim_caption', 3, null, 'start'), concept('hero_plate', 5, null, 'center')];
      const fade = evaluateDesignMetrics(layouts[0], { wrappedLines: measureWrappedLines(layouts[0], OWNER) });
      expect(fade.metrics.gridAppropriateness.passed).toBe(true);
      const ranked = rankCandidatesV3(layouts.map((layout, sourceIndex) => ({ sourceIndex, layout })), { text: OWNER });
      expect(ranked.slice(0, 2).map((r) => r.layout.artDirection!.recipe)).toContain('hero_fade_report');
    });
  });
});
