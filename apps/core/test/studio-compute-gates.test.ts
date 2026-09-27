import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { runArtStage } from '../src/services/design-studio/stages/art.stage.js';
import type { CandidateState, StageContext } from '../src/services/design-studio/types.js';
import { DesignStudioService } from '../src/services/design-studio/design-studio-service.js';
import { rankStudioCandidatesV3 } from '../src/services/design-studio/stages/v3.stage.js';

describe('artwork admission', () => {
  it.each([[true, false], [false, false], [false, true]])('checks copy before buying artwork, deferring contrast only (overflow=%s, contrast=%s)', async (overflow, contrast) => {
    const png = Buffer.from('synthetic-admitted-art');
    const generateArt = vi.fn().mockResolvedValue({ imageBuffer: png, receipt: { sha256: createHash('sha256').update(png).digest('hex'), provider: 'fake' } });
    const ctx = {
      pipelineV3: true, width: 1080, height: 1350, copyBlocks: [{ text: 'Long approved copy '.repeat(overflow ? 100 : 1), script: 'latin' }],
      referencePack: { palette: ['#0A1628', '#FFFFFF'] }, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', artProvider: { generateArt },
    } as unknown as StageContext;
    const candidate = {
      id: 'too-small', ordinal: 0, layouts: [], critiques: [], status: 'draft', concept: { artStrategy: 'generated' } as CandidateState['concept'], currentLayout: {
        version: 2, width: 1080, height: 1350, grid: { margin: 76, columns: 6, gutter: 26, baseline: 8 },
        background: { color: '#0A1628' }, shapes: [], logo: { x: 480, y: 80, width: 120, height: 120 },
        text: [{ copyIndex: 0, role: 'body', x: 76, y: 300, width: 900, height: 70, fontSize: 24, fontFamily: 'Verdana', lineHeight: 1.3, color: contrast ? '#0A1628' : '#FFFFFF', align: 'center' }],
        art: { source: 'generated', prompt: 'Abstract texture', box: { x: 0, y: 0, width: 1080, height: 1350 }, calmRegion: { x: 0, y: 0, width: 1080, height: 1350 }, opacity: 0.1 },
      },
    } as CandidateState;
    await runArtStage(ctx, [candidate]);
    expect(generateArt).toHaveBeenCalledTimes(overflow ? 0 : 1);
    expect(candidate.status).toBe(overflow ? 'eliminated' : 'draft');
    if (overflow) {
      expect(candidate.diagnostics).toContain('COPY_OVERFLOW');
      expect(candidate.artPng).toBeUndefined();
    } else expect(candidate.artPng).toBe(png);
  });
});

describe('Studio selection persistence and fallback', () => {
  function fixture() {
    const createStructuredCompletion = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const ctx = { pipelineV3: true, width: 1080, height: 1350, copyBlocks: [{ text: 'Approved workshop', script: 'latin' }],
      referencePack: { palette: ['#0A1628', '#FFFFFF'] }, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', client: { createStructuredCompletion } } as unknown as StageContext;
    const candidate = (ordinal: number, valid: boolean): CandidateState => ({
      id: `candidate-${ordinal}`, ordinal, status: 'active', previewPng: Buffer.from(`preview-${ordinal}`),
      concept: {} as CandidateState['concept'], critiques: [], layouts: [], currentLayout: {
        version: 2, width: 1080, height: 1350, grid: { margin: 76, columns: 6, gutter: 26, baseline: 8 },
        background: { color: '#0A1628' }, shapes: [], logo: { x: 480, y: 80, width: 120, height: 120 },
        text: [{ copyIndex: 0, role: 'body', x: 76, y: 300, width: 928, height: valid ? 70 : 1,
          fontSize: 24, fontFamily: 'Verdana', lineHeight: 1.3, color: '#FFFFFF', align: 'center' }],
      },
    });
    const repo = { updateRunStatus: vi.fn().mockResolvedValue(undefined), updateCandidate: vi.fn().mockResolvedValue(undefined), insertJudgment: vi.fn() };
    const service = Object.assign(Object.create(DesignStudioService.prototype), { repo }) as {
      judgeV3: (...args: unknown[]) => Promise<{ status: string; winnerCandidateId?: string }>;
      finishLayoutsStage: (...args: unknown[]) => Promise<{ status: string }>;
    };
    const stages: Record<string, unknown> = {};
    const judge = (candidates: CandidateState[]) => service.judgeV3({ tenantId: 'tenant', actorId: 'actor' }, { id: 'run' }, ctx, stages,
      { maxUsd: 1, maxCalls: 10, spentUsd: 0, calls: 0 }, candidates);
    const persist = (candidates: CandidateState[]) => service.finishLayoutsStage({ tenantId: 'tenant', actorId: 'actor' }, 'run', stages,
      { maxUsd: 1, maxCalls: 10, spentUsd: 0, calls: 0 }, candidates.map((c) => ({ id: c.id, ordinal: c.ordinal })), candidates, true);
    return { ctx, candidate, repo, stages, judge, persist, createStructuredCompletion };
  }

  it.each([false, true])('retains pre-art refusal reasons and advances only with survivors (survivor=%s)', async (survives) => {
    const f = fixture();
    const rejected = { ...f.candidate(0, false), status: 'eliminated' as const, diagnostics: ['COPY_OVERFLOW'] };
    const candidates = [rejected, ...(survives ? [f.candidate(1, true)] : [])];
    const result = await f.persist(candidates);
    expect(result.status).toBe(survives ? 'rendering' : 'failed');
    expect(f.repo.updateCandidate).toHaveBeenCalledWith('candidate-0', 'tenant', expect.objectContaining({ status: 'eliminated', layouts: [rejected.currentLayout] }));
    expect(f.stages.layouts).toEqual({ count: survives ? 1 : 0, preArtRejected: [{ candidateId: 'candidate-0', ordinal: 0, defectCodes: ['COPY_OVERFLOW'] }] });
    expect(f.repo.updateRunStatus).toHaveBeenCalledWith('run', 'tenant', survives ? 'rendering' : 'failed', expect.objectContaining({ stages: f.stages }));
  });

  it('records zero-eligible failure instead of promoting a deterministic fallback winner', async () => {
    const f = fixture();
    const result = await f.judge([f.candidate(0, false)]);
    expect(result.status).toBe('failed');
    expect(result.winnerCandidateId).toBeUndefined();
    expect(f.createStructuredCompletion).not.toHaveBeenCalled();
    expect(f.repo.updateRunStatus).toHaveBeenCalledWith('run', 'tenant', 'failed', expect.objectContaining({ winnerCandidateId: null, judgeStatus: 'SKIPPED' }));
    expect(f.stages.tournament).toMatchObject({ decidedBy: 'no_eligible_candidate', candidates: [{ qa: 'failed', defectCodes: expect.arrayContaining(['COPY_OVERFLOW']) }] });
  });

  it('excludes a failed candidate from winner and runner-up when the provider is unavailable', async () => {
    const f = fixture();
    const candidates = [f.candidate(0, false), f.candidate(1, true), f.candidate(2, true)];
    expect(rankStudioCandidatesV3(f.ctx, candidates).filter((r) => r.hardQa?.passed).length).toBe(2);
    const result = await f.judge(candidates);
    expect(result.status).toBe('qa');
    expect(result.winnerCandidateId).not.toBe('candidate-0');
    expect(f.createStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(f.repo.updateCandidate).toHaveBeenCalledWith('candidate-0', 'tenant', { status: 'eliminated', rank: null });
    expect(f.stages.tournament).toMatchObject({ decidedBy: 'composite_judge_unavailable', excludedCandidates: [{ candidateId: 'candidate-0', qa: 'failed' }] });
  });
});
