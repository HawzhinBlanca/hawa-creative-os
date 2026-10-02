import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PNG, type RawArtDirectionConcept } from '@hawa/creative';
import { log } from '../src/logging.js';
import { runLayoutsStage } from '../src/services/design-studio/stages/index.js';
import type { CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';

it('Core prepares viable candidates and reports the actual refused background without another model call', async () => {
  const body = Array.from({ length: 3 }, () => 'Exact date 2026 Price 123.45 Office details').join('\n');
  const concepts: RawArtDirectionConcept[] = ['photo_mosaic', 'hero_card', 'editorial_split'].map((recipe, i) => ({
    id: `c${i}`, conceptNote: 'Message-led concept', recipe, typicality: .5,
    heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null, supportingPhotoIndices: [1],
    slots: [{ copyIndex: 0, slot: 'title' }, { copyIndex: 1, slot: 'body' }],
    titleAccentWords: null, fadeShare: null, surfaceTone: 'auto', frame: 'none', align: 'start',
    backgroundIntent: i === 0 ? 'showcase' : 'documentary', backgroundMode: i === 0 ? 'gradient' : 'solid',
    backgroundColorIndex: i === 0 ? 0 : 3,
  }));
  let calls = 0;
  const client = { createStructuredCompletion: async () => {
    calls++;
    return { data: { concepts }, rawText: '', receipt: { responseId: 'synthetic-background-recovery',
      xRequestId: null, model: 'synthetic-model', inputTokens: 100, outputTokens: 50, reasoningTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: .01, latencyMs: 1 } };
  } };
  const png = new PNG({ width: 2400, height: 2400 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 232; png.data[i + 1] = 236; png.data[i + 2] = 240; png.data[i + 3] = 255; }
  const bytes = PNG.sync.write(png);
  const ctx: StageContext = {
    runId: randomUUID(), tenantId: randomUUID(), taskId: randomUUID(), clientId: randomUUID(), actorId: 'synthetic-office',
    width: 800, height: 1000, tier: 'standard', instructions: 'Use the best composition for this announcement.',
    copyBlocks: [{ text: 'Original title', script: 'latin' }, { text: body, script: 'latin' }],
    referencePack: { palette: ['#888888', '#666666', '#000000', '#FFFFFF'] },
    promotedRules: '', latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
    logo: KAAE_TEST_CLIENT_LOGO, client: client as never, pipelineV3: true, imageryStrategy: 'photographic',
    photos: [0, 1].map(() => ({ bytes, mimeType: 'image/png' as const,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width: 2400, height: 2400 })),
  };
  const brief: CreativeBrief = { occasion: 'Announcement', audience: 'Office', formality: 3,
    toneWords: ['clear', 'precise', 'calm'], readingOrder: [0, 1],
    roles: [{ copyIndex: 0, role: 'title', importance: 5 }, { copyIndex: 1, role: 'body', importance: 3 }],
    must: [], mustNot: [], imageryStrategy: 'photographic', imageryRationale: 'Original supplied photos',
    kurdishLeads: false, riskFlags: [] };
  const warning = vi.spyOn(log, 'warn');
  try {
    const candidates = await runLayoutsStage(ctx, brief, [], [0, 1, 2].map(ordinal => ({ id: randomUUID(), ordinal })));
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(1);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/concept\(s\) replaced:.*BACKGROUND.*readable ink/));
    for (const candidate of candidates) {
      expect(candidate.currentLayout.text.map(t => t.copyIndex)).toEqual([0, 1]);
      expect(candidate.currentLayout.artDirection?.recipe).not.toBe('photo_mosaic');
    }
  } finally { warning.mockRestore(); }
});
