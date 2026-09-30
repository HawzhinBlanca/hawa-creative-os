import { describe, expect, it, vi } from 'vitest';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from '../src/studio/validate-layout-v2.js';
import { measureWrappedLines } from '../src/studio/render-layout-v2.js';
import { reviewFindings } from '../src/studio/hard-qa.js';
import { evaluatePairOrder, PHOTO_JUDGE_DIMENSIONS } from '../src/studio/pairwise-judge-v3.js';
import { measureDesignV3, rankCandidatesV3, selectWinnerV3, type RankedCandidateV3 } from '../src/studio/pipeline-v3.js';
import { solveRecipe, brandTones, type ArtDirectionChoice, type SolverPhoto } from '../src/studio/art-direction/solver.js';
import { solveConcepts } from '../src/studio/art-direction/generate.js';
import { artDirectionPrior, houseRecipesFor } from '../src/studio/art-direction/prior.js';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';

/**
 * ADR-170, second round after the paid live trials of 2026-09-30 on the owner's KAAE K-12 album:
 * the judge's ties go to the house prior, a plate sits only in the photo's quiet region, a hero is not
 * enlarged past 1.3x where the recipe can avoid it, the type follows the office's example 3, and the
 * corner logo never sits bare on a photo.
 */

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const OWNER = { 0: 'KAAE K-12 Pilot Study', 1: 'Field Visit Report', 2: 'Insights from KAAE school field visits and next steps toward education quality improvement.' };
const SLOTS: ArtDirectionChoice['slots'] = [{ copyIndex: 0, slot: 'accent' }, { copyIndex: 1, slot: 'title' }, { copyIndex: 2, slot: 'body' }];
/** The album's six photos as Telegram delivers them, 1280x853; photo 5 (the courtyard) is quiet at the top. */
const PHOTOS: SolverPhoto[] = Array.from({ length: 6 }, (_, i) => ({
  photoIndex: i, width: 1280, height: 853, salient: { x: 0.45, y: 0.45 }, quiet: i === 5 ? 'top' : 'none', quietLuminance: 0.8,
}));

const solve = (recipe: ArtDirectionChoice['recipe'], hero: number, over: Partial<ArtDirectionChoice> = {}, w = 1080, h = 1350) => solveRecipe({
  width: w, height: h, copy: { text: OWNER }, photos: PHOTOS, palette: PALETTE, logoAspect: 1,
  choice: { recipe, heroPhotoIndex: hero, texturePhotoIndex: recipe === 'hero_fade_report' ? 4 : null, cutoutPhotoIndex: null, slots: SLOTS,
    params: { frame: recipe === 'hero_card' ? 'outer' : 'inset', align: recipe === 'hero_plate' ? 'center' : 'start' }, ...over },
});
const context = (): LayoutValidationContext => ({
  expectedWidth: 1080, expectedHeight: 1350, copyCount: 3, copyScripts: ['latin', 'latin', 'latin'], photoCount: 6,
  photoSelection: { mode: 'choose', minimum: 1 }, reference: { rules: { fontFamily: 'Verdana', palette: PALETTE }, logoAspect: 1 },
});
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const holds = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;

const preferenceEvidence = { clientId: 'fixture-client', referenceClientId: 'fixture-client', policySha256: 'a'.repeat(64),
  loadedIds: ['fixture-reference'], matches: [{ id: 'fixture-reference', recipe: 'hero_fade_report' as const, subjectMatches: ['report_release', 'field_visit'] }] };

describe('1. the judge\'s ties go to the house prior, not to a composite that favours centred plates', () => {
  it('maps the brief\'s subject to the house recipe', () => {
    expect(houseRecipesFor(['report_release', 'field_visit', 'k12'])[0]).toBe('hero_fade_report');
    expect(houseRecipesFor(['meeting', 'officials'])[0]).toBe('scrim_caption');
    expect(houseRecipesFor(['event_forum'])).toEqual(['cutout_speaker', 'hero_plate']);
    expect(houseRecipesFor(['eid'])).toEqual(['sky_title']);
    expect(houseRecipesFor(['school'])).toEqual([]);
  });

  it('prefers the subject\'s recipe, then the sharper hero, and says why', () => {
    const fade = solve('hero_fade_report', 0);
    const scrim = solve('scrim_caption', 3);
    const card = solve('hero_card', 3);
    expect(artDirectionPrior(scrim, fade, ['report_release', 'field_visit'], preferenceEvidence)).toMatchObject({ winner: 'b', basis: 'client_reference', reason: expect.stringMatching(/hero_fade_report matches loaded subject-relevant references/) });
    // No subject between them: the card's hero is enlarged past 1.5x, the scrim's is not.
    expect(card.artDirection!.heroUpscale).toBeGreaterThan(1.5);
    expect(artDirectionPrior(card, scrim, ['school'])).toMatchObject({ winner: 'b', basis: 'sharpness' });
    expect(artDirectionPrior(scrim, scrim, ['school'])).toMatchObject({ winner: null });
  });

  it('does not claim an unmeasured historical hero is sharper than a measured one', () => {
    const measured = solve('scrim_caption', 3);
    const unknown = { artDirection: { ...measured.artDirection!, heroUpscale: undefined } };
    const soft = { artDirection: { ...measured.artDirection!, heroUpscale: 2 } };
    expect(artDirectionPrior(unknown, soft, [])).toMatchObject({ winner: null, basis: null });
    expect(artDirectionPrior(soft, unknown, [])).toMatchObject({ winner: null, basis: null });
  });

  it('a judge that picks whichever design is second in both orders leaves the pair to the prior, recorded', async () => {
    const scrim = solve('scrim_caption', 3);
    const fade = solve('hero_fade_report', 0);
    const copy = { text: OWNER };
    const passedQa = { passed: true, defectCodes: [], messages: [], findings: [] } as any;
    const ranked: RankedCandidateV3[] = [
      { sourceIndex: 1, layout: scrim, metrics: measureDesignV3(scrim, copy), hardQa: passedQa },
      { sourceIndex: 0, layout: fade, metrics: measureDesignV3(fade, copy), hardQa: passedQa },
    ];
    // Position bias, as in runs 1 and 5: every dimension goes to the design shown second.
    const verdict = { dimensions: Object.fromEntries(PHOTO_JUDGE_DIMENSIONS.map((d) => [d, { winner: 'B', rationale: 'b' }])), majorityWinner: 'B', summary: 's' };
    const client = { createStructuredCompletion: vi.fn().mockResolvedValue({ data: verdict, receipt: { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } }) } as any;
    const selection = await selectWinnerV3(ranked, copy, { client, model: 'gpt-4.1-mini', renderOptions: { logoDataUri: KAAE_TEST_LOGO }, subjects: ['report_release', 'field_visit'], recipePreferences: preferenceEvidence });
    expect(selection.decidedBy).toBe('art_direction_prior');
    expect(selection.humanChoiceRecommended).toBe(true);
    expect(selection.judgeReliable).toBe(false);
    expect(selection.winner.layout.artDirection!.recipe).toBe('hero_fade_report');
    expect(selection.prior).toMatchObject({ basis: 'client_reference', instead: 'composite_after_tie' });
  }, 60000);

  it('never records "photos tiled in a grid" for a design with one photograph, and tells the judge the count', async () => {
    const fade = solve('hero_fade_report', 0);
    const scrim = solve('scrim_caption', 3);
    const wrong = { heroFitsSubject: true, photoBoldAndDominant: true, textOnPlateCardOrFade: true, conceptConnection: true, photosTiledInGrid: true, houseRulesBroken: [] };
    const verdict = { artDirection: { A: wrong, B: wrong }, dimensions: Object.fromEntries(PHOTO_JUDGE_DIMENSIONS.map((d) => [d, { winner: 'A', rationale: 'a' }])), majorityWinner: 'A', summary: 's' };
    const create = vi.fn().mockResolvedValue({ data: verdict, receipt: { model: 'gpt-4.1-mini', responseId: 'r', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } });
    const png = Buffer.from('x');
    const out = await evaluatePairOrder({ id: 'a', layout: fade, renderedPng: png }, { id: 'b', layout: scrim, renderedPng: png }, 'AB', { client: { createStructuredCompletion: create } as any, model: 'gpt-4.1-mini' });
    expect(out.artDirection!.map((c) => c.photosTiledInGrid)).toEqual([false, false]);
    const prompt = create.mock.calls[0][0].messages[1].content[0].text as string;
    expect(prompt).toContain('PHOTOS PLACED (counted from the layouts): Candidate A: 1 photograph as picture; 1 blended into the text area as a texture. Candidate B: 1 photograph as picture.');
  });
});

describe('2. hero_plate sits in the photo\'s quiet region, and its title keeps to one line when it can', () => {
  it('puts the plate in the quiet top band of the courtyard photo and sets "KAAE K-12 Pilot Study" on one line', () => {
    const layout = solve('hero_plate', 5);
    const plate = layout.shapes.find((s) => s.surface === 'plate')!;
    const hero = layout.photos!.find((p) => p.role === 'hero')!;
    expect(plate.y + plate.height).toBeLessThanOrEqual(hero.y + 0.45 * hero.height);
    expect(measureWrappedLines(layout, OWNER)[0]).toBe(1);
    expect(validateLayoutV2(layout, context())).toMatchObject({ ok: true });
  });

  it('keeps a title that fits on one line on one line in the other plated recipes too', () => {
    for (const [recipe, hero] of [['fade_to_paper', 5], ['hero_card', 3]] as const) {
      expect(measureWrappedLines(solve(recipe, hero), OWNER)[0], recipe).toBe(1);
    }
  });

  it('never sets the plate on a quiet floor where the photo\'s people stand', () => {
    const floor = PHOTOS.map((p) => (p.photoIndex === 5 ? { ...p, quiet: 'bottom' as const, focus: { x: 0.7, y: 0.6 }, faceShare: 0.06 } : p));
    expect(() => solveRecipe({ width: 1080, height: 1350, copy: { text: OWNER }, photos: floor, palette: PALETTE, logoAspect: 1,
      choice: { recipe: 'hero_plate', heroPhotoIndex: 5, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params: { frame: 'inset', align: 'center' } } }))
      .toThrow(/where its people stand/);
  });

  it('refuses a hero with no quiet top or bottom, and a plate concept on one moves to the photo that has one', () => {
    expect(() => solve('hero_plate', 3)).toThrow(/no quiet top or bottom/);
    const copyBlocks = [0, 1, 2].map((index) => ({ index, text: OWNER[index as 0 | 1 | 2], script: 'latin' as const, role: index === 1 ? 'title' : index === 0 ? 'subtitle' : 'body' }));
    const facts = PHOTOS.map((p) => ({ ...p, ...(p.quiet === 'top' ? { quietArea: 'top' as const } : {}) }));
    const choice: ArtDirectionChoice = { recipe: 'hero_plate', heroPhotoIndex: 3, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params: { frame: 'inset', align: 'center' } };
    const solved = solveConcepts([choice], { brief: '', photoSelection: { mode: 'choose', minimum: 1 }, copyBlocks: copyBlocks as any, palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350, photos: facts as any, logoAspect: 1 });
    expect(solved.layouts[0].artDirection).toMatchObject({ recipe: 'hero_plate', heroPhotoIndex: 5 });
  });
});

describe('3. a hero is not enlarged past 1.3x where the recipe can avoid it; past 1.5x is a warning and ranks behind', () => {
  it('scrim_caption keeps the album photo at 1.3x in a band, the scrim closing over its edge', () => {
    const layout = solve('scrim_caption', 3);
    const hero = layout.photos!.find((p) => p.role === 'hero')!;
    expect(layout.artDirection!.heroUpscale).toBeLessThanOrEqual(1.3);
    expect(hero.height).toBeLessThan(1350);
    const scrim = layout.overlays![0];
    const edge = (hero.y + hero.height - scrim.y) / scrim.height;
    const at = scrim.stops.find((s) => Math.abs(s.at - round3(edge)) < 0.002)!;
    expect(at.opacity).toBeGreaterThanOrEqual(0.98);
    expect(validateLayoutV2(layout, context())).toMatchObject({ ok: true });
  });

  it('hero_fade_report with no texture closes its fade over the hero\'s edge (run 7 showed it as a line)', () => {
    const layout = solve('hero_fade_report', 5, { texturePhotoIndex: null });
    const hero = layout.photos!.find((p) => p.role === 'hero')!;
    expect(hero.y + hero.height).toBeLessThan(1350);
    const fade = layout.overlays![0];
    const edge = round3((hero.y + hero.height - fade.y) / fade.height);
    expect(fade.stops.find((st) => Math.abs(st.at - edge) < 0.002)?.opacity).toBeGreaterThanOrEqual(0.98);
    expect(validateLayoutV2(layout, context())).toMatchObject({ ok: true });
  });

  it('warns on a hero enlarged past 1.5x and ranks it behind a sharp one', () => {
    const card = solve('hero_card', 3);
    const scrim = solve('scrim_caption', 3);
    expect(reviewFindings(card, {}).map((f) => f.code)).toContain('HERO_UPSCALED');
    expect(reviewFindings(scrim, {}).map((f) => f.code)).not.toContain('HERO_UPSCALED');
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: card }, { sourceIndex: 1, layout: scrim }], { text: OWNER });
    expect(ranked.map((r) => r.layout.artDirection!.recipe)).toEqual(['scrim_caption', 'hero_card']);
  });

  it('replaces a concept whose hero would be soft when a sharp recipe can carry it', () => {
    const copyBlocks = [0, 1, 2].map((index) => ({ index, text: OWNER[index as 0 | 1 | 2], script: 'latin' as const, role: index === 1 ? 'title' : index === 0 ? 'subtitle' : 'body' }));
    const choice: ArtDirectionChoice = { recipe: 'hero_card', heroPhotoIndex: 3, texturePhotoIndex: null, cutoutPhotoIndex: null, slots: SLOTS, params: { frame: 'outer', align: 'center' } };
    const solved = solveConcepts([choice], { brief: '', photoSelection: { mode: 'choose', minimum: 1 }, copyBlocks: copyBlocks as any, palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350, photos: PHOTOS as any, logoAspect: 1 });
    expect(solved.layouts[0].artDirection!.recipe).not.toBe('hero_card');
    expect(solved.layouts[0].artDirection!.heroUpscale).toBeLessThanOrEqual(1.5);
    expect(solved.replaced[0].reason).toMatch(/HERO_UPSCALED/);
  });
});

describe('4. type set as the office sets example 3', () => {
  for (const [recipe, hero] of [['hero_fade_report', 0], ['scrim_caption', 3]] as const) {
    it(`${recipe}: body about 3.3% of the width, on a two-thirds measure, at a 1.3 leading`, () => {
      const layout = solve(recipe, hero);
      const body = layout.text.find((t) => t.copyIndex === 2)!;
      expect(body.fontSize / 1080).toBeGreaterThanOrEqual(0.031);
      expect(body.fontSize / 1080).toBeLessThanOrEqual(0.034);
      expect(body.width).toBeLessThanOrEqual(Math.round(0.68 * 1080));
      expect(body.lineHeight).toBe(1.3);
      // The two-colour title keeps its lines whole: one line each.
      const lines = measureWrappedLines(layout, OWNER);
      expect([lines[0], lines[1]]).toEqual([1, 1]);
    });
  }
});

describe('5. the corner logo: set bare by the solver, lifted only where its pixels are busy (ADR-180)', () => {
  // Superseded by the owner's "current design has logo background" (2026-09-30): a cream tab on every
  // logo that touched a photo was a box the office does not draw. settleLogoGround reads the pixels.
  for (const [recipe, hero] of [['hero_fade_report', 0], ['scrim_caption', 3], ['hero_plate', 5]] as const) {
    it(`${recipe}: no tab behind the logo from the geometry alone`, () => {
      const layout: StudioLayoutV2 = solve(recipe, hero);
      expect(layout.shapes.filter((s) => s.surface === 'tab' && holds(s, layout.logo))).toEqual([]);
      expect(brandTones(PALETTE).cream).toBe('#FDF8F3');
      expect(validateLayoutV2(layout, context())).toMatchObject({ ok: true });
    });
  }

  it('hero_card keeps its one navy tab on the card, not a second one', () => {
    expect(solve('hero_card', 3).shapes.filter((s) => s.surface === 'tab')).toHaveLength(1);
  });
});
