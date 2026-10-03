import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { OpenAiStudioClient, renderMotifPng, type RenderLayoutOptions, type StudioLayoutV2 } from '@hawa/creative';
import { runQAStage } from '../src/services/design-studio/stages/qa.stage.js';
import type { CandidateState, StageContext } from '../src/services/design-studio/types.js';
import { OFFICE_POSTS } from '../../../packages/creative/test/fixtures/office-posts/office-posts.js';

/**
 * ADR-290: the QA stage checks the Kurdish lines of the render that ships against the face they were
 * measured with, and names a mismatch as an advisory finding. The renderer is wrapped so a test can
 * make it draw a block in another face, as a host without the bundled file does.
 */
const runtime = vi.hoisted(() => ({ drawAs: undefined as string | undefined }));
vi.mock('@hawa/creative', async (original) => {
  const actual = await original<typeof import('@hawa/creative')>();
  return { ...actual, renderLayoutV2Async: (layout: StudioLayoutV2, options?: RenderLayoutOptions) =>
    actual.renderLayoutV2Async(runtime.drawAs ? { ...layout, text: layout.text.map((t) => ({ ...t, fontFamily: runtime.drawAs! })) } : layout, options) };
});
afterEach(() => { runtime.drawAs = undefined; });

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// A Sorani string already in the repository's fixtures (README of office-posts lists their sources).
const SORANI = OFFICE_POSTS.find((p) => p.id === 'photo12_peer_evaluators_call_ckb')!.copy[1];

function stage(): { context: StageContext; candidate: CandidateState } {
  const logo = renderMotifPng('thin-rules', { width: 100, height: 100, palette: ['#000000', '#FFFFFF'] });
  const transport = vi.fn<typeof fetch>(async () => { throw new Error('No provider dispatch in this fixture'); });
  const context: StageContext = {
    runId: randomUUID(), tenantId: '00000000-0000-4000-a000-000000000001', taskId: randomUUID(), clientId: randomUUID(), actorId: randomUUID(),
    width: 1080, height: 1350, tier: 'standard', instructions: 'Exact copy.', copyBlocks: [{ text: SORANI, script: 'arabic' }],
    referencePack: { palette: ['#FFFFFF', '#000000'] }, promotedRules: '', latinFont: 'Inter', arabicFont: 'Noto Sans Arabic', logoAspect: 1,
    client: new OpenAiStudioClient({ apiKey: 'synthetic-key', fetcher: transport }),
    logo: { bytes: logo, sha256: hash(logo), mimeType: 'image/png' },
  };
  const layout: StudioLayoutV2 = {
    version: 2, width: 1080, height: 1350, grid: { margin: 76, columns: 6, gutter: 26, baseline: 8 },
    background: { color: '#FFFFFF' }, shapes: [], logo: { x: 490, y: 80, width: 100, height: 100 },
    text: [{ copyIndex: 0, role: 'title', x: 76, y: 400, width: 928, height: 220, fontSize: 48, lineHeight: 1.6,
      fontFamily: 'Noto Sans Arabic', color: '#0A1628', align: 'right', rtl: true }],
  };
  const candidate: CandidateState = { id: randomUUID(), ordinal: 0, status: 'winner', layouts: [layout], currentLayout: layout, critiques: [],
    concept: { id: 'notice', name: 'Notice', archetype: 'typographic-poster', artStrategy: 'none',
      typographicScale: { ratio: 1.3, titleSize: 48, bodySize: 28 },
      colourRoles: { background: '#FFFFFF', title: '#0A1628', body: '#0A1628', accent: '#0A1628', rule: '#0A1628' },
      layoutIdea: 'Live copy in a calm field', whyDifferent: 'Typography only' } };
  return { context, candidate };
}

describe('QA stage: Kurdish shaping of the render that ships (ADR-290)', () => {
  it('records a passing check and no finding when the render draws the measured face', async () => {
    const { context, candidate } = stage();
    const qa = await runQAStage(context, candidate);
    expect(qa.textShaping).toMatchObject({ pass: true, unmeasured: [] });
    expect(qa.findings?.map((f) => f.code)).not.toContain('TEXT_SHAPING_MISMATCH');
  }, 60_000);

  it('names a render drawn in another face as an advisory finding; the QA verdict is unchanged', async () => {
    const { context, candidate } = stage();
    const clean = await runQAStage(context, candidate);
    runtime.drawAs = 'Vazirmatn';
    const { context: c2, candidate: k2 } = stage();
    const qa = await runQAStage(c2, k2);
    expect(qa.textShaping).toMatchObject({ pass: false });
    const finding = qa.findings?.find((f) => f.code === 'TEXT_SHAPING_MISMATCH');
    expect(finding).toMatchObject({ severity: 'warning', copyIndex: 0 });
    expect(finding?.message).toMatch(/^TEXT_SHAPING_MISMATCH: copy block 1 /);
    expect(qa.passed).toBe(clean.passed);
  }, 60_000);
});
