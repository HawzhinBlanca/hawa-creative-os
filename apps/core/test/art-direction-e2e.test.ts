import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ExemplarRetrievalIndex,
  artDirectionRulesFromRaw,
  creativeAssetPath,
  eligibleRecipes,
  encodeStudioTransferV2,
  imagePixelSize,
  photoSelectionFromInstructions,
  renderLayoutV2,
  tonePreferenceFromWords,
  PNG,
  type StudioLayoutV2,
} from '@hawa/creative';
import type { CandidateState, CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { runLayoutsStage, runRenderStage, runQAStage, rankStudioCandidatesV3, photosBrief } from '../src/services/design-studio/stages/index.js';
import { briefPhotoFacts, photoFactsFor } from '../src/services/design-studio/art-direction.js';

/**
 * ADR-170, end to end: the owner's KAAE K-12 brief with its six field-visit photos, through the real
 * layout stage, preparation, render, ranking and hard QA, with the layout model mocked to a fixed
 * art-direction answer. The design that comes back must be a hero_fade_report (example 3 of the
 * office's reference sheet), not a grid of tiles, and it must pass hard QA with its contrast
 * measured on the rendered pixels.
 *
 * No client photo is committed. By default the six photos are deterministic synthetic stand-ins of
 * the album's size (1280x853). With HAWA_ART_DIRECTION_ALBUM pointing at a folder of the real album's
 * JPEGs, the same test runs on them; with HAWA_ART_DIRECTION_OUT it writes the winner's PNG there.
 */

const REFERENCE = JSON.parse(readFileSync(creativeAssetPath('kaae-reference.json'), 'utf8'));
const PALETTE: string[] = REFERENCE.rules.palette;
const INSTRUCTIONS =
  'Design a professional report cover for KAAE using only the provided field-visit photos and the provided text. ' +
  'Use KAAE’s navy blue, yellow, and white brand colors, with a dark navy overlay or gradient toward the lower section to create a clear text area. ' +
  'Place the KAAE logo near the top and use a thin yellow border as a framing element. ' +
  "Do not generate new photos or replace the supplied ones and you don't have to use all the photos, choose the best ones based on your design.";
const COPY = ['KAAE K-12 Pilot Study', 'Field Visit Report', 'Insights from KAAE school field visits and next steps toward'];

/** A photo with a calm, bright upper part and a busy lower part, seeded. */
function syntheticPhoto(seed: number): Buffer {
  const width = 1280, height = 853;
  const png = new PNG({ width, height });
  let s = seed * 7919 + 17;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const calm = y < height * 0.35;
      const n = calm ? 0 : Math.floor(rnd() * 90) - 45;
      png.data[i] = calm ? 232 : 150 + n + ((x >> 4) % 3) * 20;
      png.data[i + 1] = calm ? 236 : 120 + n;
      png.data[i + 2] = calm ? 240 : 90 + n;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function albumPhotos(): Array<{ bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' }> {
  const dir = process.env.HAWA_ART_DIRECTION_ALBUM;
  if (dir && existsSync(dir)) {
    return readdirSync(dir).filter((f) => /^photo\d\.jpe?g$/i.test(f)).sort().map((f) => ({ bytes: readFileSync(join(dir, f)), mimeType: 'image/jpeg' as const }));
  }
  return Array.from({ length: 6 }, (_, i) => ({ bytes: syntheticPhoto(i + 1), mimeType: 'image/png' as const }));
}

/** The fixed layout-model answer: three concepts, three recipes, as an art director would propose. */
const MODEL_ANSWER = {
  concepts: [
    {
      id: 'report-fade', conceptNote: 'The library visit is the report: the scene fades into navy, the crowd of pupils rising through it, the title on the fade.',
      recipe: 'hero_fade_report', typicality: 0.8, heroPhotoIndex: 0, texturePhotoIndex: 4, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }],
      titleAccentWords: null, fadeShare: 0.48, surfaceTone: 'navy', frame: 'inset', align: 'start',
    },
    {
      id: 'schoolyard-scrim', conceptNote: 'The schoolyard at break, untouched, with the report named on a navy scrim.',
      recipe: 'scrim_caption', typicality: 0.5, heroPhotoIndex: 5, texturePhotoIndex: null, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }],
      titleAccentWords: null, fadeShare: null, surfaceTone: 'navy', frame: 'none', align: 'start',
    },
    {
      id: 'visit-card', conceptNote: 'The field visit itself, framed in gold, the report named on a cream card.',
      recipe: 'hero_card', typicality: 0.3, heroPhotoIndex: 3, texturePhotoIndex: null, cutoutPhotoIndex: null,
      slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'accent' }, { copyIndex: 2, slot: 'body' }],
      titleAccentWords: null, fadeShare: null, surfaceTone: 'cream', frame: 'outer', align: 'center',
    },
  ],
};

describe('art direction end to end: the KAAE K-12 field visit report (ADR-170)', () => {
  it('counts a detector point as a face only when it carries a face height (live trial, 2026-09-30)', async () => {
    // The face service answers the centre, with no face height, for a photo with no face in it (the
    // album's woman in profile at the bookshelf). Taken for a face, it told the art director "faces
    // found" and cropped the hero on the middle instead of the photo's measured detail.
    const [bytes] = albumPhotos().map((p) => p.bytes);
    const size = imagePixelSize(bytes)!;
    const photo = { bytes, mimeType: 'image/png' as const, dataUrl: '', width: size.width, height: size.height };
    const [none, face] = await photoFactsFor({ photos: [photo, photo], photoFaces: [{ x: 0.5, y: 0.5 }, { x: 0.3, y: 0.33, faceShare: 0.17 }] } as any);
    expect(none.faces).toBeUndefined();
    expect(none.focus).toBeUndefined();
    expect(none.salient).toBeDefined();
    expect(face).toMatchObject({ faces: true, focus: { x: 0.3, y: 0.33 } });
  });

  it('retains measured individual and invalid region evidence through the art-direction adapter', async () => {
    const bytes = PNG.sync.write(new PNG({ width: 100, height: 100 }));
    const photo = { bytes, mimeType: 'image/png' as const, dataUrl: '', width: 100, height: 100 };
    const regions = [{ kind: 'face' as const, x: .1, y: .2, width: .15, height: .2 }];
    const [measured, invalid] = await photoFactsFor({ photos: [photo, photo], photoFaces: [
      { x: .2, y: .3, faceShare: .2, regionStatus: 'measured', regions },
      { x: .5, y: .5, regionStatus: 'invalid' },
    ] });
    expect(measured).toMatchObject({ regionStatus: 'measured', regions });
    expect(invalid).toMatchObject({ regionStatus: 'invalid' });
    expect(invalid.faces).toBeUndefined();
  });

  it('retrieves the office\'s own K-12 field-visit report among the photo exemplars', () => {
    const manifest = JSON.parse(readFileSync(creativeAssetPath('kaae-exemplars.json'), 'utf8'));
    const brief = {
      photosSent: 6, subjectTags: ['report_release', 'field_visit', 'k12', 'school'],
      imageRoles: Array.from({ length: 6 }, (_, index) => ({ index, role: 'content_photo' as const, notes: '', subjectFit: 4, shot: 'classroom_or_interior' as const, quietArea: 'none' as const })),
    };
    const retrieval = new ExemplarRetrievalIndex({ manifest }).retrieveTopExemplars({
      text: [INSTRUCTIONS, ...COPY].join('\n'), format: '4:5', photoCount: 6, subjects: brief.subjectTags,
      eligibleRecipes: eligibleRecipes(briefPhotoFacts(brief as Partial<CreativeBrief>, false)),
    }, 3);
    expect(retrieval.retrievedIds.some((id) => /^photo0[12]_/.test(id))).toBe(true);
    expect(retrieval.retrievedExemplars[0]).toMatchObject({ recipe: 'hero_fade_report' });
  });

  it('produces a hero_fade_report that passes hard QA on its rendered pixels, from a mocked model answer', async () => {
    const photos = albumPhotos();
    expect(photos).toHaveLength(6);
    const requests: any[] = [];
    let modelAnswer: unknown = MODEL_ANSWER;
    const client = {
      createStructuredCompletion: async (req: any) => {
        requests.push(req);
        return {
          data: modelAnswer, rawText: JSON.stringify(modelAnswer),
          receipt: { responseId: 'resp_e2e', xRequestId: null, model: 'mock', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, latencyMs: 0 },
        };
      },
    };
    const real = Boolean(process.env.HAWA_ART_DIRECTION_ALBUM);
    const ctx: StageContext = {
      runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: REFERENCE.clientId, actorId: 'e2e',
      width: 1080, height: 1350, tier: 'standard', instructions: INSTRUCTIONS,
      copyBlocks: COPY.map((text) => ({ text, script: 'latin' as const })),
      referencePack: { palette: PALETTE, referenceFonts: { latin: 'Verdana', arabic: 'Noto Sans Arabic' }, clientId: REFERENCE.clientId },
      promotedRules: REFERENCE.rules.colorUsage, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
      logo: KAAE_TEST_CLIENT_LOGO, client: client as any, pipelineV3: true, imageryStrategy: 'photographic',
      // The selection the owner's words record: "choose the best ones", no count (half the photos, 3).
      photoSelection: photoSelectionFromInstructions(INSTRUCTIONS, 6),
      artDirectionRules: artDirectionRulesFromRaw(REFERENCE),
      photos: photos.map((p, i) => {
        const size = imagePixelSize(p.bytes)!;
        return {
          ...p, dataUrl: `data:${p.mimeType};base64,${p.bytes.toString('base64')}`, width: size.width, height: size.height,
          review: i === 0 ? { subjectFit: 5, shot: 'classroom_or_interior', quietArea: 'none' } : i === 4 ? { subjectFit: 4, shot: 'group_or_crowd', quietArea: 'none' } : { subjectFit: 3, shot: 'classroom_or_interior', quietArea: 'none' },
        };
      }),
      // With the real album, the face of the visitor in photo 0 as a point, read from the photo by eye:
      // the face detector is a service not run in this test. Synthetic photos have no face.
      ...(real ? { photoFaces: [{ x: 0.2, y: 0.3 }, null, null, null, null, null] } : {}),
    };
    const brief = {
      occasion: 'K-12 pilot study field visit report release', audience: 'education stakeholders', formality: 4,
      toneWords: ['formal', 'institutional', 'modern'], readingOrder: [0, 1, 2],
      roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'subtitle', importance: 4 }, { copyIndex: 2, role: 'body', importance: 3 }],
      must: [], mustNot: [], imageryStrategy: 'photographic', imageryRationale: '', kurdishLeads: false, riskFlags: [],
      // ADR-236: the brief records the ground the owner's words ask for ("a dark navy overlay").
      tonePreference: tonePreferenceFromWords(INSTRUCTIONS),
    } as unknown as CreativeBrief;
    expect(brief.tonePreference).toMatchObject({ tone: 'dark' });

    // ADR-180 (owner, 2026-09-30: "office house style"): with no stated count the recorded half-the-photos
    // guess does not bind a recipe. Under ADR-171 it did, and this brief became a three-photo collage.
    expect(ctx.photoSelection).toMatchObject({ mode: 'choose', minimum: 3 });
    expect(ctx.photoSelection!.counted).toBeUndefined();
    const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
    // The model was shown the photos at high detail and the house rules as data.
    const user = requests[0].messages[1].content;
    expect(user.filter((p: any) => p.type === 'image_url').every((p: any) => p.image_url.detail === 'high')).toBe(true);
    expect(user[0].text).toContain('R1. Pick ONE hero photo');
    expect(requests[0].messages[0].content).not.toMatch(/KAAE/);
    expect(photosBrief(ctx.photos, 1080, 1350, undefined, ctx.photoSelection)).toContain('choose');

    // The card concept would fill the canvas with a 1280x853 photo enlarged about 1.6x: a sharp recipe
    // replaces it (live trials, 2026-09-30). Every hero stays at 1.5x or less.
    expect(candidates.map((c) => c.currentLayout.artDirection?.recipe).slice(0, 2)).toEqual(['hero_fade_report', 'scrim_caption']);
    expect(candidates[2].currentLayout.artDirection?.recipe).not.toBe('hero_card');
    for (const c of candidates) expect(c.currentLayout.artDirection?.heroUpscale ?? 1).toBeLessThanOrEqual(1.5);
    const rendered = await runRenderStage(ctx, candidates);
    const ranked = rankStudioCandidatesV3(ctx, rendered);
    const out = process.env.HAWA_ART_DIRECTION_OUT;
    const renderOptions = { copyText: Object.fromEntries(COPY.map((c, i) => [i, c])), logoDataUri: `data:image/png;base64,${KAAE_TEST_CLIENT_LOGO.bytes.toString('base64')}`, photoFiles: photos.map((p) => ({ bytes: p.bytes, mediaType: p.mimeType })) };
    if (out) {
      mkdirSync(out, { recursive: true });
      for (const r of ranked) writeFileSync(join(out, `e2e_${r.layout.artDirection?.recipe}.png`), renderLayoutV2(r.layout, renderOptions).png);
    }
    // No heavy box behind the logo (owner, 2026-09-30): any backing stays inside its clear space.
    for (const r of ranked) expect(r.hardQa?.defectCodes).not.toContain('LOGO_BACKING');
    const fade = ranked.find((r) => r.layout.artDirection?.recipe === 'hero_fade_report')!;
    expect(fade.hardQa?.messages).toEqual([]);
    expect(fade.hardQa?.passed).toBe(true);
    // Every candidate passes: the recipes are solved to the house rules, not repaired into them.
    for (const r of ranked) expect(r.hardQa?.passed, `${r.layout.artDirection?.recipe}: ${r.hardQa?.messages.join(' | ')}`).toBe(true);

    const winner: CandidateState = fade.candidate;
    const qa = await runQAStage(ctx, winner);
    expect(qa.messages).toEqual([]);
    expect(qa.passed).toBe(true);
    expect(qa.omittedPhotos).toEqual([1, 2, 3, 5]);
    // W3: the final gate measures the current source and composite, even with an old passed record.
    const missingLogo = await runQAStage({ ...ctx, logo: undefined }, { ...winner });
    expect(missingLogo.passed).toBe(false);
    expect(missingLogo.defectCodes).toContain('LOGO_UNMEASURED');
    const whiteLogo = new PNG({ width: 128, height: 128 }); whiteLogo.data.fill(255);
    const whiteBytes = PNG.sync.write(whiteLogo);
    const invisibleLogo = await runQAStage({ ...ctx, logo: { bytes: whiteBytes,
      sha256: createHash('sha256').update(whiteBytes).digest('hex'), mimeType: 'image/png' } }, { ...winner });
    expect(invisibleLogo.passed).toBe(false);
    expect(invisibleLogo.defectCodes).toContain('LOGO_UNREADABLE');
    const layout: StudioLayoutV2 = winner.currentLayout;
    // One hero and one blended texture; the title and gold line on the fade; the inset gold line.
    expect(layout.photos!.map((p) => [p.photoIndex, p.role])).toEqual([[0, 'hero'], [4, 'texture']]);
    expect(layout.text.find((t) => t.copyIndex === 1)!.color.toUpperCase()).toBe('#E8B85C');
    for (const t of layout.text) expect(qa.measuredContrast![t.copyIndex]).toBeGreaterThanOrEqual(t.fontSize >= 24 && t.bold ? 3 : 4.5);

    // The Canva deck: the hero native, the fade its own PNG, the text native.
    const deck = await encodeStudioTransferV2(JSON.parse(JSON.stringify(layout)), COPY, KAAE_TEST_CLIENT_LOGO, {
      photos: photos.map((p) => ({ bytes: p.bytes, mimeType: p.mimeType })),
    });
    expect(deck.bytes.length).toBeGreaterThan(1000);

    // ADR-172: the production adapter passes the requester decision through the same one-call
    // recipe path. All solved geometries remain readable after the surface color changes.
    const requested = await runLayoutsStage({ ...ctx, requestedBackground: '#1E3A5F' }, brief, [],
      [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].content[0].text).toContain('"requestedColor":"#1E3A5F"');
    expect(requested.every(c => c.currentLayout.background.color === '#1E3A5F')).toBe(true);
    expect(requested.every(c => c.currentLayout.background.decision?.basis === 'requester')).toBe(true);
    const requestedRenders = await runRenderStage({ ...ctx, requestedBackground: '#1E3A5F' }, requested);
    for (const r of rankStudioCandidatesV3({ ...ctx, requestedBackground: '#1E3A5F' }, requestedRenders)) {
      expect(r.hardQa?.passed, r.hardQa?.messages.join(' | ')).toBe(true);
    }

    // ADR-181: a different client/content direction may choose several meaningful images
    // without a counted instruction. Existing per-client KAAE fade evidence above stays intact.
    modelAnswer = { concepts: [{ ...MODEL_ANSWER.concepts[0], recipe: 'hero_storyboard',
      heroPhotoIndex: 0, texturePhotoIndex: null, supportingPhotoIndices: [5, 2], surfaceTone: 'cream',
      conceptNote: 'Primary scene followed by two related moments' }, ...MODEL_ANSWER.concepts.slice(1)] };
    const flexibleCtx = { ...ctx, instructions: 'Create an editorial announcement; choose photos for the strongest composition.',
      artDirectionRules: [], photoSelection: photoSelectionFromInstructions(undefined, 6) };
    const flexible = await runLayoutsStage(flexibleCtx, brief, [], [0, 1, 2].map(ordinal => ({ id: randomUUID(), ordinal })));
    expect(requests).toHaveLength(3); // one existing model call for each generation, no new role/call
    const story = flexible.find(c => c.currentLayout.artDirection?.recipe === 'hero_storyboard');
    expect(story).toBeDefined();
    expect(story!.currentLayout.photos?.map(p => p.photoIndex)).toEqual([0, 5, 2]);
    expect(story!.currentLayout.artDirection?.omittedPhotos).toEqual([1, 3, 4]);
    const flexibleRendered = await runRenderStage(flexibleCtx, [story!]);
    const flexibleRanked = rankStudioCandidatesV3(flexibleCtx, flexibleRendered);
    expect(flexibleRanked[0].hardQa?.passed, flexibleRanked[0].hardQa?.messages.join(' | ')).toBe(true);

    // Three genuinely distinct native coverage geometries share the same exact source set.
    modelAnswer = { concepts: ['hero_storyboard', 'photo_sequence', 'photo_mosaic'].map(recipe => ({
      ...MODEL_ANSWER.concepts[0], recipe, heroPhotoIndex: 0, texturePhotoIndex: null,
      supportingPhotoIndices: [5, 2, 1, 4, 3], surfaceTone: 'cream', frame: 'none',
      conceptNote: `Coverage-safe ${recipe}` })) };
    const allCtx = { ...flexibleCtx, width: 1920, height: 1080, instructions: 'Use all six photos with the exact supplied copy.',
      photoSelection: photoSelectionFromInstructions('Use all six photos.', 6) };
    const allCandidates = await runLayoutsStage(allCtx, brief, [], [0, 1, 2].map(ordinal => ({ id: randomUUID(), ordinal })));
    expect(requests).toHaveLength(4);
    expect(new Set(allCandidates.map(c => c.currentLayout.artDirection?.recipe))).toEqual(new Set(['hero_storyboard', 'photo_sequence', 'photo_mosaic']));
    const allRendered = await runRenderStage(allCtx, allCandidates);
    for (const candidate of rankStudioCandidatesV3(allCtx, allRendered)) {
      expect(candidate.hardQa?.passed, candidate.hardQa?.messages.join(' | ')).toBe(true);
      expect(candidate.layout.photos?.map(p => p.photoIndex)).toEqual([0, 5, 2, 1, 4, 3]);
      expect(candidate.layout.artDirection?.omittedPhotos).toEqual([]);
    }

    if (out) {
      writeFileSync(join(out, 'e2e_hero_fade_report.layout.json'), JSON.stringify(layout, null, 2));
      writeFileSync(join(out, 'e2e_hero_fade_report.pptx'), deck.bytes);
      writeFileSync(join(out, 'e2e_sha256.txt'), createHash('sha256').update(renderLayoutV2(layout, renderOptions).png).digest('hex'));
    }
  }, 240000);
});
