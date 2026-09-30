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
  renderLayoutV2,
  PNG,
  type StudioLayoutV2,
} from '@hawa/creative';
import type { CandidateState, CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { runLayoutsStage, runRenderStage, runQAStage, rankStudioCandidatesV3, photosBrief } from '../src/services/design-studio/stages/index.js';
import { briefPhotoFacts } from '../src/services/design-studio/art-direction.js';

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
    const client = {
      createStructuredCompletion: async (req: any) => {
        requests.push(req);
        return {
          data: MODEL_ANSWER, rawText: JSON.stringify(MODEL_ANSWER),
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
      photoSelection: { mode: 'choose', minimum: 1, matched: "you don't have to use all the photos" },
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
    } as unknown as CreativeBrief;

    // This single-hero control explicitly permits one. ADR-171 separately checks the default six.
    const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map((ordinal) => ({ id: randomUUID(), ordinal })));
    // The model was shown the photos at high detail and the house rules as data.
    const user = requests[0].messages[1].content;
    expect(user.filter((p: any) => p.type === 'image_url').every((p: any) => p.image_url.detail === 'high')).toBe(true);
    expect(user[0].text).toContain('R1. Pick ONE hero photo');
    expect(requests[0].messages[0].content).not.toMatch(/KAAE/);
    expect(photosBrief(ctx.photos, 1080, 1350, undefined, ctx.photoSelection)).toContain('choose');

    expect(candidates.map((c) => c.currentLayout.artDirection?.recipe)).toEqual(['hero_fade_report', 'scrim_caption', 'hero_card']);
    const rendered = await runRenderStage(ctx, candidates);
    const ranked = rankStudioCandidatesV3(ctx, rendered);
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
    const layout: StudioLayoutV2 = winner.currentLayout;
    // One hero and one blended texture; the title and gold line on the fade; the inset gold line.
    expect(layout.photos!.map((p) => [p.photoIndex, p.role])).toEqual([[0, 'hero'], [4, 'texture']]);
    expect(layout.text.find((t) => t.copyIndex === 1)!.color.toUpperCase()).toBe('#F7B500');
    for (const t of layout.text) expect(qa.measuredContrast![t.copyIndex]).toBeGreaterThanOrEqual(t.fontSize >= 24 && t.bold ? 3 : 4.5);

    // The Canva deck: the hero native, the fade its own PNG, the text native.
    const deck = await encodeStudioTransferV2(JSON.parse(JSON.stringify(layout)), COPY, KAAE_TEST_CLIENT_LOGO, {
      photos: photos.map((p) => ({ bytes: p.bytes, mimeType: p.mimeType })),
    });
    expect(deck.bytes.length).toBeGreaterThan(1000);

    const out = process.env.HAWA_ART_DIRECTION_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      for (const r of ranked) {
        const png = renderLayoutV2(r.layout, { copyText: Object.fromEntries(COPY.map((c, i) => [i, c])), logoDataUri: `data:image/png;base64,${KAAE_TEST_CLIENT_LOGO.bytes.toString('base64')}`, photoFiles: photos.map((p) => ({ bytes: p.bytes, mediaType: p.mimeType })) }).png;
        writeFileSync(join(out, `e2e_${r.layout.artDirection?.recipe}.png`), png);
      }
      writeFileSync(join(out, 'e2e_hero_fade_report.layout.json'), JSON.stringify(layout, null, 2));
      writeFileSync(join(out, 'e2e_hero_fade_report.pptx'), deck.bytes);
      writeFileSync(join(out, 'e2e_sha256.txt'), createHash('sha256').update(renderLayoutV2(layout, { copyText: Object.fromEntries(COPY.map((c, i) => [i, c])), logoDataUri: `data:image/png;base64,${KAAE_TEST_CLIENT_LOGO.bytes.toString('base64')}`, photoFiles: photos.map((p) => ({ bytes: p.bytes, mediaType: p.mimeType })) }).png).digest('hex'));
    }
  }, 240000);
});
