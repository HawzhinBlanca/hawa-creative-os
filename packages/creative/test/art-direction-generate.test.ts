import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ART_DIRECTION_JSON_SCHEMA,
  buildArtDirectorSystemPrompt,
  buildArtDirectorUserPrompt,
  generateArtDirectedCandidatesV3,
  normalizeConcepts,
  type RawArtDirectionConcept,
} from '../src/studio/art-direction/generate.js';
import { eligibleRecipes, rankPhotosForHero, type PhotoFacts } from '../src/studio/art-direction/recipes.js';
import { isPlainBaseline } from '../src/studio/pipeline-v3.js';
import type { CopyBlockSlotInput } from '../src/studio/layout-generator-v3.js';

/**
 * ADR-170: the art-director layout call. One call, as before; the model chooses recipes, photo
 * roles and slots, never coordinates; the prompts name no client; the three concepts diverge.
 */

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const COPY: CopyBlockSlotInput[] = [
  { index: 0, text: 'KAAE K-12 Pilot Study', role: 'title', script: 'latin' },
  { index: 1, text: 'Field Visit Report', role: 'subtitle', script: 'latin' },
  { index: 2, text: 'Insights from KAAE school field visits and next steps toward', role: 'body', script: 'latin' },
];
const PHOTOS: Array<PhotoFacts & { width: number; height: number }> = Array.from({ length: 6 }, (_, i) => ({
  photoIndex: i, width: 1280, height: 853,
  subjectFit: i === 0 ? 5 : i === 4 ? 4 : 2,
  shot: i === 4 ? 'group_or_crowd' : 'classroom_or_interior',
  sharpness: i === 2 ? 0.3 : 0.7,
}));

const concept = (over: Partial<RawArtDirectionConcept>): RawArtDirectionConcept => ({
  id: 'c', conceptNote: 'note', recipe: 'hero_fade_report', typicality: 0.7, heroPhotoIndex: 0, texturePhotoIndex: 4, cutoutPhotoIndex: null,
  slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }],
  titleAccentWords: null, fadeShare: 0.46, surfaceTone: 'navy', frame: 'inset', align: 'start', ...over,
});

describe('art-director prompt and concepts (ADR-170)', () => {
  it('keeps the system prompt byte-stable and client-neutral; the client\'s rules come as data', () => {
    const system = buildArtDirectorSystemPrompt();
    expect(buildArtDirectorSystemPrompt()).toBe(system);
    expect(system).not.toMatch(/KAAE|Kurdistan|accredit/i);
    expect(system).toMatch(/You never write coordinates/);
    expect(createHash('sha256').update(system).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
    const user = buildArtDirectorUserPrompt({
      brief: 'report release', copyBlocks: COPY, palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350, photos: PHOTOS,
      houseRules: ['Pick ONE hero photo.', 'Text always sits on something.'], exemplars: [{ label: 'photo01_k12_field_visit_report_en.jpg [recipe hero_fade_report]: the office\'s own report post' }],
    });
    expect(user).toContain('R1. Pick ONE hero photo.');
    expect(user).toContain('R2. Text always sits on something.');
    expect(user).toContain('[recipe hero_fade_report]');
    expect(user).toContain(`ELIGIBLE RECIPES for these photos: ${eligibleRecipes(PHOTOS).join(', ')}`);
    expect(user).toContain('Ranked for the hero by the local review (best first): 0, 4');
    expect(user).toMatch(/sharpness 0\.30 \(soft\)/);
  });

  it('offers a cut-out recipe only with a cut-out, and a sky title only with a calm top or bottom', () => {
    expect(eligibleRecipes(PHOTOS)).not.toContain('cutout_speaker');
    expect(eligibleRecipes(PHOTOS)).not.toContain('sky_title');
    expect(eligibleRecipes([{ ...PHOTOS[0], cutout: true, localQuiet: 'top' }])).toEqual(expect.arrayContaining(['cutout_speaker', 'sky_title']));
    expect(eligibleRecipes([])).toEqual(['typographic']);
    expect(rankPhotosForHero(PHOTOS)[0].photoIndex).toBe(0);
  });

  it('makes three concepts diverge: at least two recipes even when the model repeats one', () => {
    const same = normalizeConcepts([concept({}), concept({ heroPhotoIndex: 1 }), concept({ heroPhotoIndex: 5 })], PHOTOS, COPY);
    expect(same).toHaveLength(3);
    expect(new Set(same.map((c) => c.recipe)).size).toBeGreaterThanOrEqual(2);
  });

  it('repairs a concept the solver could not carry: an ineligible recipe, a missing photo, a texture where none is allowed', () => {
    const [a, b, c] = normalizeConcepts([
      concept({ recipe: 'cutout_speaker' }),
      concept({ recipe: 'scrim_caption', heroPhotoIndex: 42, texturePhotoIndex: 4 }),
      concept({ recipe: 'hero_card', texturePhotoIndex: 0 }),
    ], PHOTOS, COPY);
    expect(a.recipe).toBe('hero_fade_report');
    expect(b).toMatchObject({ recipe: 'scrim_caption', heroPhotoIndex: 0, texturePhotoIndex: null });
    expect(c).toMatchObject({ recipe: 'hero_card', texturePhotoIndex: null });
    // Too few concepts are filled from the house's defaults for the photos.
    expect(normalizeConcepts([concept({})], PHOTOS, COPY)).toHaveLength(3);
  });

  it('sends the photos at high detail, the exemplars at low, and solves every concept into a layout', async () => {
    const requests: any[] = [];
    const client = {
      createStructuredCompletion: async (req: any) => {
        requests.push(req);
        return {
          data: { concepts: [concept({}), concept({ recipe: 'scrim_caption', heroPhotoIndex: 5, texturePhotoIndex: null }), concept({ recipe: 'hero_plate', heroPhotoIndex: 3 })] },
          rawText: '',
          receipt: { responseId: 'r', xRequestId: null, model: 'm', inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.01, latencyMs: 1 },
        };
      },
    };
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const result = await generateArtDirectedCandidatesV3({
      client: client as never, brief: 'report', copyBlocks: COPY, palette: PALETTE, canvasWidth: 1080, canvasHeight: 1350, photos: PHOTOS, logoAspect: 1,
      visualInputs: [
        { kind: 'approved_example', label: 'ex', sourceSha256: 'a', dataUrl: png },
        { kind: 'content_photo', label: 'Photo 0', sourceSha256: 'b', dataUrl: png },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].jsonSchema.schema).toBe(ART_DIRECTION_JSON_SCHEMA);
    const images = requests[0].messages[1].content.filter((p: any) => p.type === 'image_url');
    expect(images.map((p: any) => p.image_url.detail)).toEqual(['low', 'high']);
    expect(result.layouts.map((l) => l.artDirection!.recipe)).toEqual(['hero_fade_report', 'scrim_caption', 'hero_plate']);
    expect(result.rawCandidates.map((r) => r.compositionArchetype)).toEqual(['hero_fade_report', 'scrim_caption', 'hero_plate']);
    expect(result.costUsd).toBe(0.01);
    // None of them is the plain baseline the judge is anchored against.
    expect(result.layouts.some(isPlainBaseline)).toBe(false);
  });
});
