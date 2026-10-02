import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PNG, type RawArtDirectionConcept } from '@hawa/creative';
import { log } from '../src/logging.js';
import { runLayoutsStage } from '../src/services/design-studio/stages/index.js';
import type { CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';

it('Core keeps three sharp content-led compositions when the top-ranked source is tiny', async () => {
  const concepts: RawArtDirectionConcept[] = ['hero_card', 'editorial_split', 'hero_fade_report'].map(recipe => ({
    id: recipe, recipe, conceptNote: 'Original photo announcement', typicality: .2,
    heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, supportingPhotoIndices: [],
    slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }], titleAccentWords: 'Original',
    fadeShare: null, surfaceTone: 'auto', frame: 'none', align: 'center', backgroundMode: 'solid', backgroundColorIndex: 0,
  }));
  let calls = 0;
  const client = { createStructuredCompletion: async () => {
    calls++;
    return { data: { concepts }, rawText: '', receipt: { responseId: 'synthetic-alternate-hero-core', xRequestId: null,
      model: 'synthetic-model', inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 20, costUsd: .01, latencyMs: 1 } };
  } };
  const photos = [200, 2400].map((size, index) => {
    const png = new PNG({ width: size, height: size });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 40 + index * 80; png.data[i + 1] = 100; png.data[i + 2] = 150; png.data[i + 3] = 255;
    }
    const bytes = PNG.sync.write(png);
    return { bytes, mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      width: size, height: size, review: { subjectFit: index === 0 ? 5 : 3, shot: 'classroom_or_interior' as const, quietArea: 'top' as const } };
  });
  const ctx: StageContext = {
    runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: randomUUID(), actorId: 'synthetic-office',
    width: 800, height: 1000, tier: 'standard', instructions: 'Choose the best composition for this announcement.',
    copyBlocks: [{ text: 'Original title', script: 'latin' }, { text: 'Exact date 2026 Office details', script: 'latin' }],
    referencePack: { palette: ['#0A1628', '#FFFFFF', '#F7B500', '#1A1A1A'] }, promotedRules: '',
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1, logo: KAAE_TEST_CLIENT_LOGO,
    client: client as never, pipelineV3: true, imageryStrategy: 'photographic', photos,
  };
  const brief: CreativeBrief = { occasion: 'Announcement', audience: 'Office', formality: 3,
    toneWords: ['clear', 'precise', 'calm'], readingOrder: [0, 1],
    roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'body', importance: 3 }],
    must: [], mustNot: [], imageryStrategy: 'photographic', imageryRationale: 'Source photos', kurdishLeads: false, riskFlags: [] };
  const warning = vi.spyOn(log, 'warn');
  try {
    const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map(ordinal => ({ id: randomUUID(), ordinal })));
    expect(candidates).toHaveLength(3);
    expect(calls).toBe(1);
    expect(candidates.map(c => c.currentLayout.artDirection?.recipe)).toEqual(concepts.map(c => c.recipe));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/concept\(s\) replaced:.*HERO_UPSCALED/));
    for (const candidate of candidates) {
      expect(candidate.currentLayout.photos?.map(p => p.photoIndex)).toEqual([1]);
      expect(candidate.currentLayout.artDirection?.omittedPhotos).toEqual([0]);
      expect(candidate.currentLayout.artDirection?.heroUpscale).toBeLessThanOrEqual(1.5);
      expect(candidate.currentLayout.text.map(t => t.copyIndex)).toEqual([0, 1]);
    }
  } finally { warning.mockRestore(); }
});
