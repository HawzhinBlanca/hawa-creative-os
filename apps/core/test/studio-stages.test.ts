import { describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { StageContext, CandidateState, CreativeBrief, Concept } from '../src/services/design-studio/types.js';
import { OpenAiStudioClient, OpenAiImageProvider, type StudioLayoutV2 } from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { studioSentBlocks } from '../src/services/canva-connect-service.js';
import { officialLogoPath } from '../src/services/design-studio/design-studio-service.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runBriefStage,
  runConceptsStage,
  runLayoutsStage,
  runArtStage,
  runRenderStage,
  runCritiqueStage,
  runReviseStage,
  runTournamentStage,
  runCanaryStage,
  runQAStage,
  runTransferStage,
} from '../src/services/design-studio/stages/index.js';

const KAAE_PALETTE = [
  '#0A1628',
  '#1E3A5F',
  '#4770A3',
  '#D4E2F0',
  '#F7B500',
  '#FDF8F3',
  '#FFFFFF',
];

function createMockLayout(width = 1080, height = 1350): StudioLayoutV2 {
  const margin = Math.round(width * 0.08);
  const logoWidth = Math.round(width * 0.085);
  return {
    version: 2,
    width,
    height,
    grid: { margin, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    art: {
      source: 'procedural',
      motif: 'thin-rules',
      box: { x: 0, y: 0, width, height },
      opacity: 0.15,
      calmRegion: { x: margin, y: 245, width: width - 2 * margin, height: height - 350 },
    },
    shapes: [
      {
        x: margin,
        y: 245,
        width: width - 2 * margin,
        height: 2,
        kind: 'rect',
        color: '#F7B500',
        role: 'rule',
      },
    ],
    text: [
      {
        x: margin,
        y: 260,
        width: width - 2 * margin,
        height: 35,
        copyIndex: 0,
        role: 'eyebrow',
        fontSize: 16,
        lineHeight: 1.3,
        fontFamily: 'Verdana',
        color: '#D4E2F0',
        align: 'center',
      },
      {
        // Two lines of 48px Verdana bold at 1.2 need 116px: the copy wraps at this width.
        x: margin,
        y: 310,
        width: width - 2 * margin,
        height: 120,
        copyIndex: 1,
        role: 'title',
        fontSize: 48,
        lineHeight: 1.2,
        fontFamily: 'Verdana',
        color: '#FFFFFF',
        align: 'center',
        bold: true,
      },
      {
        x: margin,
        y: 450,
        width: width - 2 * margin,
        height: 50,
        copyIndex: 2,
        role: 'subtitle',
        fontSize: 24,
        lineHeight: 1.3,
        fontFamily: 'Verdana',
        color: '#D4E2F0',
        align: 'center',
      },
      {
        x: margin,
        y: 520,
        width: width - 2 * margin,
        height: 90,
        copyIndex: 3,
        role: 'body',
        fontSize: 20,
        lineHeight: 1.4,
        fontFamily: 'Verdana',
        color: '#FDF8F3',
        align: 'center',
      },
    ],
    logo: {
      x: Math.round(width / 2 - 50),
      y: margin,
      width: 100,
      height: 100,
    },
  };
}

function createMockContext(fetchFn: typeof fetch): StageContext {
  const client = new OpenAiStudioClient({
    apiKey: 'mock-key',
    fetcher: fetchFn,
  });

  const artProvider = new OpenAiImageProvider('mock-key', fetchFn);

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
      { text: 'KAAE ANNUAL GALA', script: 'latin' },
      { text: 'Celebrating 10 Years of Innovation', script: 'latin' },
      { text: 'Join us for an evening of impact', script: 'latin' },
      { text: 'Thursday, 25 October 2026 at Grand Palace Ballroom', script: 'latin' },
    ],
    referencePack: {
      palette: KAAE_PALETTE,
      referenceFonts: {
        latin: 'Verdana',
        arabic: 'Noto Sans Arabic',
      },
    },
    promotedRules: 'Keep title clear and centered. Do not crowd logo.',
    latinFont: 'Verdana',
    arabicFont: 'Noto Sans Arabic',
    logoAspect: 1.0,
    client,
    artProvider,
  };
}

describe('Design Studio v2 Stage Pipeline Pure Functions', () => {
  it('1. brief stage: produces CreativeBrief matching schema and enforces copy index coverage', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_brief',
        model: 'claude-fable-5-1',
        usage: { input_tokens: 500, output_tokens: 300 },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              occasion: '10th Anniversary Gala',
              audience: 'Alumni, donors, and partners',
              formality: 5,
              toneWords: ['Monumental', 'Prestigious', 'Celebratory'],
              readingOrder: [0, 1, 2, 3],
              roles: [
                { copyIndex: 0, role: 'eyebrow', importance: 3 },
                { copyIndex: 1, role: 'title', importance: 5 },
                { copyIndex: 2, role: 'subtitle', importance: 4 },
                { copyIndex: 3, role: 'body', importance: 3 },
              ],
              must: ['Use official brand palette', 'Honor 10-year milestone'],
              mustNot: ['Do not use clip art', 'No cartoonish elements'],
              imageryStrategy: 'abstract',
              imageryRationale: 'Abstract architectural textures support institutional prestige',
              kurdishLeads: false,
              riskFlags: [],
            }),
          },
        ],
      }),
    } as any);

    const ctx = createMockContext(mockFetch);
    const brief = await runBriefStage(ctx);

    expect(brief.occasion).toBe('10th Anniversary Gala');
    expect(brief.formality).toBe(5);
    expect(brief.roles).toHaveLength(4);
    expect(brief.toneWords).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('2. concepts stage: produces diverse concepts and enforces archetype uniqueness', async () => {
    const mockConcepts = [
      {
        id: 'c1',
        name: 'Editorial Centerpiece',
        archetype: 'editorial-centered',
        artStrategy: 'none',
        typographicScale: { ratio: 1.414, titleSize: 48, bodySize: 20 },
        colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#4770A3' },
        layoutIdea: 'Centered majestic layout',
        whyDifferent: 'Symmetrical authority',
      },
      {
        id: 'c2',
        name: 'Framed Aristocrat',
        archetype: 'framed-invitation',
        artStrategy: 'procedural',
        motif: 'thin-rules',
        typographicScale: { ratio: 1.333, titleSize: 44, bodySize: 18 },
        colourRoles: { background: '#0A1628', title: '#FDF8F3', body: '#D4E2F0', accent: '#F7B500', rule: '#F7B500' },
        layoutIdea: 'Delicate border rules framing copy',
        whyDifferent: 'Fine hairline borders',
      },
      {
        id: 'c3',
        name: 'Monumental Gold',
        archetype: 'monumental-title',
        artStrategy: 'none',
        typographicScale: { ratio: 1.5, titleSize: 56, bodySize: 18 },
        colourRoles: { background: '#0A1628', title: '#F7B500', body: '#FFFFFF', accent: '#4770A3', rule: '#1E3A5F' },
        layoutIdea: 'Title dominates upper canvas',
        whyDifferent: 'Massive title presence',
      },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_concepts',
        model: 'claude-fable-5-1',
        usage: { input_tokens: 800, output_tokens: 600 },
        content: [{ type: 'text', text: JSON.stringify({ concepts: mockConcepts }) }],
      }),
    } as any);

    const ctx = createMockContext(mockFetch);
    ctx.tier = 'standard'; // 3 concepts expected

    const brief: CreativeBrief = {
      occasion: 'Anniversary',
      audience: 'Guests',
      formality: 5,
      toneWords: ['Regal', 'Calm', 'Noble'],
      readingOrder: [0, 1, 2, 3],
      roles: [
        { copyIndex: 0, role: 'eyebrow', importance: 3 },
        { copyIndex: 1, role: 'title', importance: 5 },
        { copyIndex: 2, role: 'subtitle', importance: 4 },
        { copyIndex: 3, role: 'body', importance: 3 },
      ],
      must: [],
      mustNot: [],
      imageryStrategy: 'none',
      imageryRationale: 'Typography only',
      kurdishLeads: false,
      riskFlags: [],
    };

    const concepts = await runConceptsStage(ctx, brief);
    expect(concepts).toHaveLength(3);
    expect(concepts[0].archetype).toBe('editorial-centered');
    expect(concepts[1].archetype).toBe('framed-invitation');
    expect(concepts[2].archetype).toBe('monumental-title');
  });

  it('3. layouts stage: validates layout and produces candidate state', async () => {
    const validLayout = createMockLayout(1080, 1350);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_layout',
        model: 'claude-fable-5-1',
        usage: { input_tokens: 1200, output_tokens: 800 },
        content: [{ type: 'text', text: JSON.stringify({ layout: validLayout, notes: 'Centered classical hierarchy' }) }],
      }),
    } as any);

    const ctx = createMockContext(mockFetch);
    const brief: any = { roles: [0, 1, 2, 3].map((i) => ({ copyIndex: i, role: 'body', importance: 3 })) };
    const concept: Concept = {
      id: 'c1',
      name: 'Editorial Classic',
      archetype: 'editorial-centered',
      artStrategy: 'none',
      typographicScale: { ratio: 1.4, titleSize: 48, bodySize: 20 },
      colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#4770A3' },
      layoutIdea: 'Centered',
      whyDifferent: 'Authority',
    };

    const candidates = await runLayoutsStage(ctx, brief, [concept]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].currentLayout.version).toBe(2);
    expect(candidates[0].currentLayout.width).toBe(1080);
  });

  it('4. art stage: renders procedural motif fallback and records provenance', async () => {
    const ctx = createMockContext(vi.fn());
    const layout = createMockLayout(1080, 1350);
    layout.art = {
      source: 'procedural',
      motif: 'guilloche',
      box: { x: 0, y: 0, width: 1080, height: 1350 },
      opacity: 0.2,
      calmRegion: { x: 100, y: 200, width: 880, height: 900 },
    };

    const candidate: CandidateState = {
      id: randomUUID(),
      ordinal: 0,
      concept: {
        id: 'c1',
        name: 'Guilloche Classic',
        archetype: 'editorial-centered',
        artStrategy: 'procedural',
        motif: 'guilloche',
        typographicScale: { ratio: 1.4, titleSize: 48, bodySize: 20 },
        colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FDF8F3', accent: '#F7B500', rule: '#4770A3' },
        layoutIdea: 'Guilloche security background',
        whyDifferent: 'Fine linework',
      },
      layouts: [layout],
      currentLayout: layout,
      critiques: [],
      status: 'draft',
    };

    const updated = await runArtStage(ctx, [candidate]);
    expect(updated[0].artPng).toBeInstanceOf(Buffer);
    expect(updated[0].artSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(updated[0].artProvenance?.source).toBe('procedural');
  });

  it('5. render stage: local render produces preview PNG, composite PNG, and metrics', async () => {
    const ctx = createMockContext(vi.fn());
    const layout = createMockLayout(1080, 1350);

    const candidate: CandidateState = {
      id: randomUUID(),
      ordinal: 0,
      concept: {} as any,
      layouts: [layout],
      currentLayout: layout,
      critiques: [],
      status: 'draft',
    };

    const rendered = await runRenderStage(ctx, [candidate]);
    expect(rendered[0].previewPng).toBeInstanceOf(Buffer);
    expect(rendered[0].previewSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered[0].compositePng).toBeInstanceOf(Buffer);
    expect(rendered[0].metrics).toBeDefined();
    expect(rendered[0].metrics?.alignmentScore).toBeGreaterThanOrEqual(0.7);
    expect(rendered[0].metrics?.whitespaceRatio).toBeGreaterThan(0);
  }, 15000);

  it('6. critique stage: scores candidate, computes weighted score, checks hard fails', async () => {
    const mockCritique = {
      observations: [
        { text: 'Centered title in gold', region: { x: 100, y: 280, w: 880, h: 80 } },
        { text: 'Thin rule separates header and body', region: { x: 100, y: 200, w: 880, h: 2 } },
        { text: 'Dark navy background with generous margins', region: { x: 0, y: 0, w: 1080, h: 1350 } },
        { text: 'Clear logo placed at top center', region: { x: 494, y: 86, w: 92, h: 38 } },
        { text: 'Body copy set cleanly in ivory serif', region: { x: 100, y: 460, w: 880, h: 90 } },
      ],
      scores: {
        hierarchy: 9,
        typography: 9,
        composition: 8.5,
        whitespace: 9,
        brandFidelity: 9.5,
        legibility: 9,
        craft: 8.5,
      },
      evidence: {
        hierarchy: 'Unambiguous dominant title',
        typography: 'Disciplined classical scale with Verdana',
        composition: 'Stable centered editorial grid',
        whitespace: 'Intentional breathing room around copy',
        brandFidelity: 'Exact brand navy and gold palette',
        legibility: 'High contrast text exceeding 7:1',
        craft: 'Precise spacing and optical alignment',
      },
      hardFails: [],
      revisions: [],
      overall: 9.0,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg_critique',
        model: 'claude-fable-5-1',
        usage: { input_tokens: 1500, output_tokens: 500 },
        content: [{ type: 'text', text: JSON.stringify(mockCritique) }],
      }),
    } as any);

    const ctx = createMockContext(mockFetch);
    const candidate: CandidateState = {
      id: randomUUID(),
      ordinal: 0,
      concept: {} as any,
      layouts: [createMockLayout(1080, 1350)],
      currentLayout: createMockLayout(1080, 1350),
      previewPng: Buffer.from('fake-preview-png'),
      critiques: [],
      status: 'draft',
    };

    const critiqued = await runCritiqueStage(ctx, {} as any, [candidate]);
    expect(critiqued[0].critiques).toHaveLength(1);
    expect(critiqued[0].score).toBeCloseTo(8.95, 1);
    expect(critiqued[0].critiques[0].hardFails).toHaveLength(0);
  });

  it('7. revise stage: respects early stopping when score >= 8.5 and 0 hard fails', async () => {
    const mockFetch = vi.fn();
    const ctx = createMockContext(mockFetch);

    const candidate: CandidateState = {
      id: randomUUID(),
      ordinal: 0,
      concept: {} as any,
      layouts: [createMockLayout(1080, 1350)],
      currentLayout: createMockLayout(1080, 1350),
      previewPng: Buffer.from('fake-preview-png'),
      critiques: [
        {
          observations: [],
          scores: {} as any,
          evidence: {} as any,
          hardFails: [],
          revisions: [],
          weightedScore: 9.2,
        },
      ],
      score: 9.2,
      status: 'draft',
    };

    // Since candidate score is 9.2 >= 8.5 and hardFails is empty, no revise call should be dispatched!
    const revised = await runReviseStage(ctx, [candidate]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(revised[0].layouts).toHaveLength(1);
  });

  it('8. tournament stage: executes pairwise comparisons in both orders and resolves winner', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'msg_pair_1',
          model: 'claude-fable-5-1',
          usage: { input_tokens: 2000, output_tokens: 300 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                winner: 'A',
                confidence: 0.9,
                reasons: ['A exhibits superior typographic restraint'],
                hardFails: { A: [], B: [] },
              }),
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'msg_pair_2',
          model: 'claude-fable-5-1',
          usage: { input_tokens: 2000, output_tokens: 300 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                winner: 'B', // In swapped order B is cand1, so this is consistent agreement!
                confidence: 0.9,
                reasons: ['B is visibly cleaner'],
                hardFails: { A: [], B: [] },
              }),
            },
          ],
        }),
      });

    const ctx = createMockContext(mockFetch as any);

    const cand1: CandidateState = {
      id: 'c1',
      ordinal: 0,
      concept: {} as any,
      layouts: [],
      currentLayout: createMockLayout(1080, 1350),
      previewPng: Buffer.from('cand1-png'),
      metrics: {} as any,
      critiques: [],
      score: 9.0,
      status: 'active',
    };

    const cand2: CandidateState = {
      id: 'c2',
      ordinal: 1,
      concept: {} as any,
      layouts: [],
      currentLayout: createMockLayout(1080, 1350),
      previewPng: Buffer.from('cand2-png'),
      metrics: {} as any,
      critiques: [],
      score: 8.2,
      status: 'active',
    };

    const result = await runTournamentStage(ctx, {} as any, [cand1, cand2]);
    expect(result.winnerCandidate.id).toBe('c1');
    expect(result.rankedCandidates[0].rank).toBe(1);
    expect(result.rankedCandidates[0].status).toBe('winner');
    expect(result.rankedCandidates[1].rank).toBe(2);
    expect(result.rankedCandidates[1].status).toBe('runner_up');
  });

  it('9. canary stage: verifies winner against perturbations in both orders (4 vision calls)', async () => {
    // 4 calls: 2 perturbations x 2 orders
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usage: { input_tokens: 1500, output_tokens: 200 },
          content: [{ type: 'text', text: JSON.stringify({ winner: 'A', confidence: 0.95, reasons: ['A has legible typography'], hardFails: { A: [], B: ['unreadableSize'] } }) }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usage: { input_tokens: 1500, output_tokens: 200 },
          content: [{ type: 'text', text: JSON.stringify({ winner: 'B', confidence: 0.95, reasons: ['B has legible typography'], hardFails: { A: ['unreadableSize'], B: [] } }) }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usage: { input_tokens: 1500, output_tokens: 200 },
          content: [{ type: 'text', text: JSON.stringify({ winner: 'A', confidence: 0.98, reasons: ['A has clear logo separation'], hardFails: { A: [], B: ['textCollision'] } }) }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          usage: { input_tokens: 1500, output_tokens: 200 },
          content: [{ type: 'text', text: JSON.stringify({ winner: 'B', confidence: 0.98, reasons: ['B has clear logo separation'], hardFails: { A: ['textCollision'], B: [] } }) }],
        }),
      });

    const ctx = createMockContext(mockFetch as any);
    const winner: CandidateState = {
      id: 'w1',
      ordinal: 0,
      concept: {} as any,
      layouts: [],
      currentLayout: createMockLayout(1080, 1350),
      previewPng: Buffer.from('winner-png'),
      metrics: {} as any,
      critiques: [],
      score: 9.2,
      status: 'winner',
    };

    const canary = await runCanaryStage(ctx, {} as any, winner);
    expect(canary.passed).toBe(true);
    expect(canary.judgeStatus).toBe('RELIABLE');
    expect(canary.details).toHaveLength(4);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('10. qa stage: hard QA v2 passes valid candidate and catches defect codes', async () => {
    const ctx = createMockContext(vi.fn());
    const validWinner: CandidateState = {
      id: 'w1',
      ordinal: 0,
      concept: {} as any,
      layouts: [],
      currentLayout: createMockLayout(1080, 1350),
      metrics: {
        alignmentScore: 0.92,
        whitespaceRatio: 0.55,
        balanceOffset: 2.1,
        hierarchyRatio: 2.4,
        bodyCharsPerLine: 50,
        lines: { 0: 1, 1: 1, 2: 1, 3: 2 },
        contrastP05: { 0: 11.2, 1: 15.4, 2: 11.2, 3: 13.8 },
        marginMin: 86,
        overlapCount: 0,
        logoWidthPct: 8.5,
      },
      critiques: [],
      status: 'winner',
    };

    const qaResult = await runQAStage(ctx, validWinner);
    expect(qaResult.passed).toBe(true);
    expect(qaResult.defectCodes).toHaveLength(0);

    // Test defect detection: corrupt width
    const invalidWinner: CandidateState = JSON.parse(JSON.stringify(validWinner));
    invalidWinner.currentLayout.width = 999; // mismatch
    const failQA = await runQAStage(ctx, invalidWinner);
    expect(failQA.passed).toBe(false);
    expect(failQA.defectCodes).toContain('DIMENSIONS_CHANGED');
  });

  it('10b. QA stage defaults logoAspect to 1.0 (official KAAE emblem) when unspecified in context', async () => {
    const ctx = createMockContext(vi.fn());
    delete (ctx as any).logoAspect;

    const winner: CandidateState = {
      id: 'w_default_logo',
      ordinal: 0,
      concept: {} as any,
      layouts: [],
      currentLayout: createMockLayout(1080, 1350),
      metrics: {
        alignmentScore: 0.90,
        whitespaceRatio: 0.50,
        balanceOffset: 2.0,
        hierarchyRatio: 2.2,
        bodyCharsPerLine: 45,
        lines: { 0: 1, 1: 1, 2: 1, 3: 2 },
        contrastP05: { 0: 10.5, 1: 14.0, 2: 10.5, 3: 12.0 },
        marginMin: 86,
        overlapCount: 0,
        logoWidthPct: 8.5,
      },
      critiques: [],
      status: 'winner',
    };

    const qaResult = await runQAStage(ctx, winner);
    expect(qaResult.passed).toBe(true);
    expect(qaResult.defectCodes).not.toContain('LOGO_ASPECT_CHANGED');
    expect(qaResult.defectCodes).not.toContain('LOGO_SHAPE_CHANGED');
  });

  it('11. transfer stage: encodes StudioLayoutV2 into valid PPTX buffer with manifest', async () => {
    const ctx = createMockContext(vi.fn());
    const winner: CandidateState = {
      id: 'w1',
      ordinal: 0,
      concept: {} as any,
      layouts: [],
      currentLayout: createMockLayout(1080, 1350),
      critiques: [],
      status: 'winner',
    };

    const transfer = await runTransferStage(ctx, winner);
    expect(transfer.pptxBytes).toBeInstanceOf(Buffer);
    expect(transfer.pptxBytes.length).toBeGreaterThan(1000);
    expect(transfer.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(transfer.plan.width).toBe(1080);
    expect(transfer.plan.height).toBe(1350);
    expect(transfer.manifest.version).toBe(2);

    const pptxCheck = checkCanvaPptx(
      new Uint8Array(transfer.pptxBytes),
      ctx.copyBlocks.map((c) => c.text),
      'Verdana'
    );
    expect(pptxCheck.copyPass).toBe(true);
    expect(pptxCheck.fontPass).toBe(true);
  });

  it('12. a studio design is checked block by block against the faces it was sent in', async () => {
    // The first live pilot (2026-09-18) reached Canva, then failed SOURCE_REQUIRED: the post-import
    // check knew only the planner's single brand font, and a studio manifest carries none.
    const ctx = createMockContext(vi.fn());
    const layout = createMockLayout(1080, 1350);
    const faces = ['Cinzel', 'Playfair Display', 'Verdana', 'Verdana'];
    [...layout.text].sort((a, b) => a.copyIndex - b.copyIndex).forEach((t, i) => { t.fontFamily = faces[i]; });
    const winner: CandidateState = {
      id: 'w1', ordinal: 0, concept: {} as any, layouts: [], currentLayout: layout, critiques: [], status: 'winner',
    };
    const transfer = await runTransferStage(ctx, winner);
    const copy = transfer.manifest.copy as string[];

    const blocks = studioSentBlocks(transfer.manifest);
    expect(blocks?.map((b) => b.fontFamily)).toEqual(faces);
    const bytes = new Uint8Array(transfer.pptxBytes);
    const kept = checkCanvaPptx(bytes, copy, { fontsByIndex: blocks!.map((b) => b.fontFamily) });
    expect(kept.copyPass).toBe(true);
    expect(kept.fontPass).toBe(true);
    // The planner's single-font check would call this design a mismatch.
    expect(checkCanvaPptx(bytes, copy, 'Verdana').fontPass).toBe(false);
    // A face Canva did not keep is caught at its block.
    const swapped = checkCanvaPptx(bytes, copy, { fontsByIndex: ['Verdana', 'Playfair Display', 'Verdana', 'Verdana'] });
    expect(swapped.fontPass).toBe(false);
    expect(swapped.offendingObjects[0]).toMatchObject({ index: 0, expectedFont: 'Verdana', observedFont: 'Cinzel' });
    // A planner manifest carries its reference pack and keeps the single-font check.
    expect(studioSentBlocks({ ...transfer.manifest, reference: { rules: { fontFamily: 'Verdana' } } })).toBeNull();
  });

  it('13. the transfer carries the official logo, found from wherever the service runs', async () => {
    // Both pilots of 2026-09-18 reached Canva with the logo box empty: the stage context looked for
    // the logo at one relative path that does not exist in the image, and went on without it.
    const path = officialLogoPath();
    const bytes = readFileSync(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reference = JSON.parse(readFileSync(resolve(path, '../../kaae-reference.json'), 'utf8'));
    expect(sha256).toBe(reference.logoSha256);

    const ctx = { ...createMockContext(vi.fn()), logo: { bytes, sha256, mimeType: 'image/png' as const } };
    const winner: CandidateState = {
      id: 'w1', ordinal: 0, concept: {} as any, layouts: [], currentLayout: createMockLayout(1080, 1350), critiques: [], status: 'winner',
    };
    const transfer = await runTransferStage(ctx, winner);
    expect(transfer.manifest.logoSha256).toBe(sha256);
    expect(Buffer.from(transfer.pptxBytes).includes('ppt/media/')).toBe(true);
  });
});
