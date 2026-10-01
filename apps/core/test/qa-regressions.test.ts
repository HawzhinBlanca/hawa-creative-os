import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { StageContext, CandidateState } from '../src/services/design-studio/types.js';
import { OpenAiStudioClient, OpenAiImageProvider, computeLayoutMetrics, type StudioLayoutV2 } from '@hawa/creative';
import { runQAStage } from '../src/services/design-studio/stages/qa.stage.js';

function createMockContext(): StageContext {
  const client = new OpenAiStudioClient({
    apiKey: 'mock-key',
    fetcher: vi.fn() as any,
  });
  const artProvider = new OpenAiImageProvider('mock-key', vi.fn() as any);

  return {
    runId: randomUUID(),
    tenantId: randomUUID(),
    taskId: randomUUID(),
    clientId: randomUUID(),
    actorId: 'test_operator',
    width: 1080,
    height: 1350,
    tier: 'premium',
    instructions: 'Design an elegant gala invitation',
    copyBlocks: [
      { text: 'Annual Gala 2026', script: 'latin' },
      { text: 'Join us for an evening of distinguished celebration.', script: 'latin' },
    ],
    referencePack: {
      id: 'kaae_ref',
      palette: ['#0A1628', '#FFFFFF', '#FDF8F3', '#F7B500'],
      fonts: ['Verdana', 'Cinzel'],
      rules: {
        maxTextElements: 20,
        marginMin: 40,
        contrastMin: 4.5,
      },
    },
    client,
    artProvider,
    latinFont: 'Verdana',
    arabicFont: 'Noto Sans Arabic',
    logoAspect: 1.0, promotedRules: '',
  };
}

function createBaseLayout(width = 1080, height = 1350): StudioLayoutV2 {
  return {
    version: 2,
    width,
    height,
    grid: { margin: 80, columns: 12, gutter: 16, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [],
    text: [
      {
        x: 80,
        y: 250,
        width: 920,
        height: 80,
        copyIndex: 0,
        role: 'title',
        fontSize: 48,
        lineHeight: 1.2,
        fontFamily: 'Verdana',
        color: '#FFFFFF',
        align: 'center',
        bold: true,
      },
      {
        x: 80,
        y: 360,
        width: 920,
        height: 100,
        copyIndex: 1,
        role: 'body',
        fontSize: 20,
        lineHeight: 1.4,
        fontFamily: 'Verdana',
        color: '#FDF8F3',
        align: 'center',
      },
    ],
    logo: {
      x: 490,
      y: 80,
      width: 100,
      height: 100,
    },
  };
}

describe('T4 — Hard QA Regression Tests (Red/Green)', () => {
  it('Regression 1: a layout with 9 px body text fails QA with named defect instead of being silently rewritten', async () => {
    const ctx = createMockContext();
    const layout = createBaseLayout(1080, 1350);
    // Explicitly set body text to 9px (unreadable, below 12px absolute and below 17.28px 1.6% width)
    const bodyEl = layout.text.find((t) => t.role === 'body')!;
    bodyEl.fontSize = 9;

    const candidate: CandidateState = {
      id: 'cand_9px',
      ordinal: 0,
      concept: {} as any,
      layouts: [layout],
      currentLayout: layout,
      metrics: {
        alignmentScore: 0.92,
        whitespaceRatio: 0.50,
        balanceOffset: 2.0,
        hierarchyRatio: 5.3,
        bodyCharsPerLine: 45,
        lines: { 0: 1, 1: 2 },
        contrastP05: { 0: 14.0, 1: 12.0 },
        marginMin: 80,
        overlapCount: 0,
        logoWidthPct: 9.2,
      },
      critiques: [],
      status: 'winner',
    };

    const result = await runQAStage(ctx, candidate);

    // In a correct system without regression:
    // 1. QA must fail
    expect(result.passed).toBe(false);
    // 2. Named defect must be present
    expect(result.defectCodes.some((code) => code === 'MIN_SIZE' || code === 'UNREADABLE_FONT_SIZE')).toBe(true);
    // 3. The candidate layout text MUST NOT be mutatively rewritten to 18px
    const finalBodyEl = candidate.currentLayout.text.find((t) => t.role === 'body')!;
    expect(finalBodyEl.fontSize).toBe(9);
  });

  it('Regression 2: genuinely off-grid geometry fails even when cached metrics claim perfect alignment', async () => {
    const ctx = createMockContext();
    const layout = createBaseLayout(1080, 1350);
    layout.grid = { margin: 70, columns: 12, gutter: 20, baseline: 8 };
    layout.logo = { x: 91, y: 80, width: 100, height: 100 };
    Object.assign(layout.text[0]!, { x: 119, width: 843 });
    Object.assign(layout.text[1]!, { x: 153, width: 719 });
    expect(computeLayoutMetrics(layout).alignmentScore).toBeLessThan(0.70);

    const candidate: CandidateState = {
      id: 'cand_poor_alignment',
      ordinal: 0,
      concept: {} as any,
      layouts: [layout],
      currentLayout: layout,
      metrics: {
        alignmentScore: 1.0, // An earlier candidate's passing score cannot authorize this geometry.
        whitespaceRatio: 0.50,
        balanceOffset: 2.0,
        hierarchyRatio: 2.4,
        bodyCharsPerLine: 45,
        lines: { 0: 1, 1: 2 },
        contrastP05: { 0: 14.0, 1: 12.0 },
        marginMin: 80,
        overlapCount: 0,
        logoWidthPct: 9.2,
      },
      critiques: [],
      status: 'winner',
    };

    const result = await runQAStage(ctx, candidate);

    // In a correct system without regression:
    // 1. QA must fail
    expect(result.passed).toBe(false);
    // 2. Named defect POOR_GRID_ALIGNMENT must be present
    expect(result.defectCodes).toContain('POOR_GRID_ALIGNMENT');
    expect(result.metrics.alignmentScore).toBeLessThan(0.70);
  });

  it('aligned shipping geometry is not rejected by an earlier candidate\'s failing metrics', async () => {
    const ctx = createMockContext();
    const layout = createBaseLayout();
    const metrics = computeLayoutMetrics(layout);
    const candidate: CandidateState = {
      id: 'stale-failure', ordinal: 0, concept: {} as any,
      layouts: [layout], currentLayout: layout,
      metrics: { ...metrics, alignmentScore: 0, overlapCount: 99 },
      critiques: [], status: 'winner',
    };
    const result = await runQAStage(ctx, candidate);
    expect(result.passed).toBe(true);
    expect(result.metrics.alignmentScore).toBe(metrics.alignmentScore);
    expect(result.metrics.overlapCount).toBe(0);
    expect(candidate.currentLayout).toBe(layout);
  });

  it('reports current wrapped copy and surface contrast rather than cached line counts and scores', async () => {
    const ctx = createMockContext();
    ctx.copyBlocks[1]!.text = 'A short current sentence.';
    const layout = createBaseLayout();
    const candidate: CandidateState = {
      id: 'stale-report', ordinal: 0, concept: {} as any,
      layouts: [layout], currentLayout: layout,
      metrics: { ...computeLayoutMetrics(layout), lines: { 0: 99, 1: 99 }, bodyCharsPerLine: 999, contrastP05: { 0: 1, 1: 1 } },
      critiques: [], status: 'winner',
    };
    const result = await runQAStage(ctx, candidate);
    expect(result.passed).toBe(true);
    for (const m of result.textMeasurements ?? []) {
      expect(m.status).toBe('measured');
      if (m.status === 'measured') expect(result.metrics.lines[m.copyIndex]).toBe(m.lineCount);
    }
    expect(result.metrics.bodyCharsPerLine).toBe(ctx.copyBlocks[1]!.text.length);
    expect(result.metrics.contrastP05[1]).toBeGreaterThan(4.5);
    expect(candidate.metrics).toBe(result.metrics);
  });
});
