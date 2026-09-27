import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { StageContext, CandidateState } from '../src/services/design-studio/types.js';
import { OpenAiStudioClient, OpenAiImageProvider, type StudioLayoutV2 } from '@hawa/creative';
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

  it('Regression 2: a layout with alignmentScore below 0.70 fails QA with POOR_GRID_ALIGNMENT', async () => {
    const ctx = createMockContext();
    const layout = createBaseLayout(1080, 1350);

    const candidate: CandidateState = {
      id: 'cand_poor_alignment',
      ordinal: 0,
      concept: {} as any,
      layouts: [layout],
      currentLayout: layout,
      metrics: {
        alignmentScore: 0.62, // Below 0.70 threshold (exemplar baseline is 0.792 - 1.000, mean 0.949)
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
  });
});
