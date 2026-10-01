import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { OpenAiStudioClient, PNG, encodeStudioTransferV2, renderLayoutV2Async, settleLogoGround, solveConcepts } from '@hawa/creative';
import { MISSED_TYPE_SCALE_INPUT } from '../../../packages/creative/test/fixtures/type-scale-input.js';
import { KAAE_TEST_CLIENT_LOGO } from './fixtures/kaae-logo.js';
import { runQAStage } from '../src/services/design-studio/stages/qa.stage.js';
import type { CandidateState, StageContext } from '../src/services/design-studio/types.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
describe('joint typography through Core final QA and editable transfer (ADR203)', () => {
  it('carries the improved measured scale through actual pixels, QA and native live text with zero providers', async () => {
    const input = structuredClone(MISSED_TYPE_SCALE_INPUT), before = structuredClone(input);
    const image = new PNG({ width: 2400, height: 1800 });
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 10; image.data[i + 1] = 22; image.data[i + 2] = 40; image.data[i + 3] = 255;
    }
    const bytes = PNG.sync.write(image), photo = { bytes, mimeType: 'image/png' as const, width: 2400, height: 1800 };
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('No provider dispatch authorized'); });
    const copy = Object.values(input.copy.text), copyBlocks = copy.map(text => ({ text, script: 'latin' as const }));
    const solved = solveConcepts([input.choice], {
      brief: 'Synthetic measured-type fixture', copyBlocks: copy.map((text, index) => ({ text, index, script: 'latin', role: index ? 'body' : 'title' })),
      canvasWidth: 1080, canvasHeight: 1350, palette: input.palette, logoAspect: 1, photos: input.photos,
    });
    expect(solved.choices[0].recipe).toBe('hero_fade_report');
    expect(solved.replaced).toEqual([]);
    const render = { logoDataUri: `data:image/png;base64,${KAAE_TEST_CLIENT_LOGO.bytes.toString('base64')}`,
      photoFiles: [photo, photo].map(p => ({ bytes: p.bytes, mediaType: p.mimeType })), copyText: input.copy.text };
    const layout = await settleLogoGround(solved.layouts[0], { render, palette: input.palette });
    expect(layout.text[0].fontSize).toBeGreaterThanOrEqual(56);
    expect(layout.text[1].fontSize).toBeGreaterThanOrEqual(25);
    const ctx: StageContext = {
      runId: randomUUID(), tenantId: randomUUID(), clientId: randomUUID(), taskId: randomUUID(), actorId: randomUUID(),
      width: 1080, height: 1350, tier: 'standard', instructions: 'Synthetic exact supplied copy.', copyBlocks,
      referencePack: { palette: input.palette }, promotedRules: '', latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
      client: new OpenAiStudioClient({ apiKey: 'synthetic-key', fetcher: transport }), logo: KAAE_TEST_CLIENT_LOGO,
      photos: [photo, photo].map(p => ({ ...p, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })),
      photoSelection: { mode: 'choose', minimum: 1 },
    };
    const candidate: CandidateState = { id: randomUUID(), ordinal: 0, layouts: [layout], currentLayout: layout, status: 'winner', critiques: [],
      concept: { id: 'scale', name: 'Measured scene and copy', archetype: 'typographic-poster', artStrategy: 'none',
        typographicScale: { ratio: 2.2, titleSize: layout.text[0].fontSize, bodySize: layout.text[1].fontSize },
        colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#F7B500' },
        layoutIdea: 'Existing recipe with measured live text', whyDifferent: 'Exact feasible integer size' } };
    const qa = await runQAStage(ctx, candidate);
    expect(qa.passed, JSON.stringify({ messages: qa.messages, logo: layout.logo,
      text: layout.text.map(t => ({ x: t.x, width: t.width, align: t.align })), shapes: layout.shapes })).toBe(true);
    expect(qa.textMeasurements.every(m => m.status === 'measured')).toBe(true);
    const contrast = Object.values(qa.measuredContrast ?? {});
    expect(contrast).toHaveLength(copy.length);
    expect(contrast.every(c => c >= 4.5)).toBe(true);
    const raster = await renderLayoutV2Async(candidate.currentLayout, render);
    expect(PNG.sync.read(raster.png)).toMatchObject({ width: 1080, height: 1350 });
    const transfer = await encodeStudioTransferV2(candidate.currentLayout, copy, KAAE_TEST_CLIENT_LOGO, { photos: [photo, photo] });
    expect(transfer.manifest.copy).toEqual(copy);
    expect(transfer.bytes.length).toBeGreaterThan(0);
    expect(transfer.sha256).toBe(hash(Buffer.from(transfer.bytes)));
    expect(input).toEqual(before);
    expect(ctx.copyBlocks.map(b => b.text)).toEqual(copy);
    expect(transport).not.toHaveBeenCalled();
  }, 30000);
});
