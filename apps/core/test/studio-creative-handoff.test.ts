import { describe, expect, it, vi } from 'vitest';
import type { CandidateState, CreativeBrief, StageContext } from '../src/services/design-studio/types.js';
import { layoutBriefV3, runLayoutsStage } from '../src/services/design-studio/stages/layouts.stage.js';
import { runReviseStageV3 } from '../src/services/design-studio/stages/v3.stage.js';
import { runArtStage } from '../src/services/design-studio/stages/art.stage.js';
import { layoutVisualInputs } from '../src/services/design-studio/stages/asset-inputs.js';

const intercepted = vi.hoisted(() => ({ refine: vi.fn(), generate: vi.fn(), rank: vi.fn() }));
vi.mock('@hawa/creative', async (original) => ({
  ...await original<typeof import('@hawa/creative')>(),
  refineCandidateV3: intercepted.refine,
  generateLayoutCandidatesV3: intercepted.generate,
  rankCandidatesV3: intercepted.rank,
}));

const brief: CreativeBrief = {
  occasion: 'Workshop', audience: 'Students', formality: 2, toneWords: ['clear', 'open', 'warm'],
  readingOrder: [1, 0], roles: [{ copyIndex: 0, role: 'body', importance: 1 }, { copyIndex: 1, role: 'title', importance: 5 }],
  must: ['Keep date exact'], mustNot: ['No invented awards'], imageryStrategy: 'none',
  imageryRationale: 'Typography communicates this request', kurdishLeads: true, riskFlags: ['Long bilingual copy'],
};
const ctx = (): StageContext => ({
  runId: 'run', taskId: 'task', tenantId: 'tenant', clientId: 'client', actorId: 'actor',
  width: 1080, height: 1350, tier: 'standard', instructions: 'Keep the supplied wording',
  copyBlocks: [{ text: 'Body', script: 'latin' }, { text: 'Title', script: 'latin' }],
  referencePack: { palette: ['#FFFFFF', '#000000'], clientId: 'client' }, promotedRules: '',
  latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', pipelineV3: true,
  client: {} as StageContext['client'],
});

describe('creative input handoff (ADR-109)', () => {
  it('refuses exemplar scope and hash mismatches before a model call', async () => {
    const exemplar = { path: 'private.png', label: 'private', bytes: Buffer.from('asset') };
    await expect(layoutVisualInputs({ ...ctx(), clientId: 'other-client', exemplars: [exemplar] })).rejects.toThrow('SCOPE_MISMATCH');
    await expect(layoutVisualInputs({ ...ctx(), exemplars: [{ ...exemplar, sha256: 'changed' }] })).rejects.toThrow('HASH_MISMATCH');
  });

  it('no-imagery suppresses optional generated art and preserves required content photos', async () => {
    const context = { ...ctx(), imageryStrategy: 'none' as const };
    const photo = { photoIndex: 0, x: 0, y: 0, width: 100, height: 100 };
    const candidate = { concept: { artStrategy: 'generated' }, currentLayout: { art: { source: 'generated' }, photos: [photo] }, artPng: Buffer.from('stale') } as CandidateState;
    await runArtStage(context, [candidate]);
    expect(candidate.currentLayout.art).toBeUndefined();
    expect(candidate.artPng).toBeNull();
    expect(candidate.currentLayout.photos).toEqual([photo]);
    expect(candidate.concept.artStrategy).toBe('none');
  });
  it('carries every structured brief decision without losing exact instruction punctuation', () => {
    const context = { ...ctx(), instructions: 'Use "Workshop" exactly' };
    const prompt = layoutBriefV3(brief, context);
    for (const [field, value] of Object.entries(brief)) expect(prompt).toContain(JSON.stringify({ [field]: value }).slice(1, -1));
    expect(prompt).toContain(JSON.stringify(context.instructions));
    expect(prompt).toContain('proposal');
  });

  it('passes only the run-scoped visual inputs to the generator', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1kAAAAASUVORK5CYII=', 'base64');
    const context = { ...ctx(), exemplars: [{ path: 'approved.png', label: 'Scoped approved example', bytes, mimeType: 'image/png' }],
      photos: [{ bytes, mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, notes: 'Speaker faces left' }] };
    intercepted.generate.mockRejectedValueOnce(new Error('intercepted before transport'));
    await expect(runLayoutsStage(context, brief, [])).rejects.toThrow('intercepted before transport');
    const args = intercepted.generate.mock.calls.at(-1)![0];
    expect(args.exemplars).toBeUndefined();
    expect(args.visualInputs).toHaveLength(2);
    expect(args.visualInputs[0]).toMatchObject({ kind: 'approved_example', label: 'Scoped approved example' });
    expect(args.visualInputs[1]).toMatchObject({ kind: 'content_photo', label: 'Photo 0', notes: 'Speaker faces left' });
    expect(args.visualInputs.every((v: { dataUrl: string }) => v.dataUrl.startsWith('data:image/'))).toBe(true);
  });

  it('supplies real art, photos and cutouts to the refinement engine', async () => {
    const context = { ...ctx(), photos: [{ bytes: Buffer.from('photo'), dataUrl: 'unused', mimeType: 'image/jpeg' as const }],
      photoCutouts: [{ png: Buffer.from('cutout'), width: 80, height: 100 }],
      logo: { bytes: Buffer.from('logo'), mimeType: 'image/png' as const, sha256: 'logo-hash' } };
    const layout: CandidateState['currentLayout'] = { version: 2, width: 1080, height: 1350, text: [], shapes: [], background: { color: '#FFFFFF' },
      grid: { margin: 60, columns: 6, gutter: 20, baseline: 8 }, logo: { x: 80, y: 80, width: 120, height: 120 } };
    const candidate = { id: 'chosen', ordinal: 0, currentLayout: layout, artPng: Buffer.from('candidate-art') } as CandidateState;
    intercepted.rank.mockReturnValue([{ sourceIndex: 0, layout, metrics: { compositeScore: 1 } }]);
    intercepted.refine.mockResolvedValue({ layout });
    await runReviseStageV3(context, [candidate]);
    const options = intercepted.refine.mock.calls.at(-1)![2];
    expect(options.renderOptions.artImagePath).toBe(`data:image/png;base64,${candidate.artPng!.toString('base64')}`);
    expect(options.renderOptions.photoFiles).toEqual([{ bytes: context.photos[0].bytes, mediaType: 'image/jpeg' }]);
    expect(options.renderOptions.logoDataUri).toContain(context.logo.bytes.toString('base64'));
    expect(options.renderOptions.photoCutouts).toBe(context.photoCutouts);
  });
});
