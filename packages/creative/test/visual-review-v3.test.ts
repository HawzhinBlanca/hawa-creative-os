import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import {
  JUDGE_DIMENSIONS,
  applyVisualReviewV3,
  conformReviewedLayoutV3,
  decideVisualRefinementV3,
  encodeStudioTransferV2,
  getLayoutBoxAnnotations,
  judgeImageDetail,
  judgeMaxTokens,
  judgeRefinementV3,
  layoutSha256,
  measureDesignV3,
  metricRegressions,
  prepareGeneratedLayoutV3,
  rankCandidatesV3,
  renderLayoutV2,
  resolveVisualReviewSettings,
  reviewCandidateVisuallyV3,
  VisualReviewSettingsError,
  type OpenAiStudioClient,
  type PipelineV3Copy,
  type StudioLayoutV2,
  type VisualReview,
  type VisualReviewFix,
} from '../src/index.js';

/**
 * ADR-237: the top model looks at the actual render, returns structured fixes, and one controlled
 * pass applies them. These tests pin what the pass may and may not change, and that a refinement
 * is kept only when hard QA passes and the measures hold or the judge prefers it.
 */
const W = 1080;
const H = 1350;
const MARGIN = 76;
const PALETTE = ['#FFFFFF', '#FFF2DB', '#17087A', '#3833A3', '#E8B85C', '#000000'];
const COPY: PipelineV3Copy = {
  text: {
    0: 'Quality Assurance Workshop',
    1: 'For school principals',
    2: '22 October 2026 · 10:00 AM',
    3: 'Divan Hotel, Erbil',
    4: 'Seats are limited, please register early',
  },
};
const QA = {
  width: W, height: H, copyScripts: ['latin', 'latin', 'latin', 'latin', 'latin'] as Array<'latin' | 'arabic'>,
  latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette: PALETTE, logoAspect: 1,
};
const CANVAS = { width: W, height: H, logoAspect: 1, palette: PALETTE };

const T = (i: number, role: string, y: number, h: number, size: number, extra: Record<string, unknown> = {}) => ({
  copyIndex: i, role, x: MARGIN, y, width: W - 2 * MARGIN, height: h, fontSize: size, lineHeight: 1.3,
  fontFamily: role === 'title' ? 'Playfair Display' : 'Verdana', color: '#17087A', align: 'center',
  bold: role === 'title', italic: false, rtl: false, ...extra,
});

/** A plain, sound KAAE announcement on white, prepared the way production prepares a layout. */
function poster(): StudioLayoutV2 {
  const raw = {
    version: 2, width: W, height: H, genre: 'poster',
    grid: { margin: MARGIN, columns: 6, gutter: 26, baseline: 14 },
    background: { color: '#FFFFFF' },
    logo: { x: W / 2 - 80, y: 90, width: 160, height: 160 },
    shapes: [{ x: W / 2 - 80, y: 640, width: 160, height: 3, kind: 'line', color: '#E8B85C', role: 'rule' }],
    text: [
      T(0, 'title', 340, 220, 76),
      T(1, 'subtitle', 580, 50, 30),
      T(2, 'date', 700, 50, 30),
      T(3, 'venue', 770, 50, 30),
      T(4, 'footer', 1180, 44, 24, { color: '#000000', bold: false }),
    ],
  } as unknown as StudioLayoutV2;
  return prepareGeneratedLayoutV3(raw, COPY, CANVAS);
}

function ranked(layout: StudioLayoutV2) {
  const [r] = rankCandidatesV3([{ sourceIndex: 0, layout, renderedPng: renderLayoutV2(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png }], COPY, QA);
  return r;
}

const fix = (over: Partial<VisualReviewFix>): VisualReviewFix => ({
  boxId: 'B1', category: 'type_size', problem: 'p', x: null, y: null, width: null, height: null, fontSize: null,
  lineHeight: null, focusX: null, focusY: null, zoom: null, raiseContrast: false, ...over,
});

/** The mark the labelled render gives an element. */
const markOf = (layout: StudioLayoutV2, pick: (a: ReturnType<typeof getLayoutBoxAnnotations>[number]) => boolean) =>
  getLayoutBoxAnnotations(layout).find(pick)!.boxId;

function reviewClient(review: VisualReview | ((params: any) => VisualReview)) {
  const calls: any[] = [];
  const client = {
    async createStructuredCompletion(params: any) {
      calls.push(params);
      const data = typeof review === 'function' ? review(params) : review;
      return { data, rawText: JSON.stringify(data), receipt: { id: 'r', responseId: 'resp_review', xRequestId: 'x', model: params.model,
        inputTokens: 9000, outputTokens: 1200, reasoningTokens: 600, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0.03, sha256: '', latencyMs: 9, attempts: 1 } };
    },
  } as unknown as OpenAiStudioClient;
  return { client, calls };
}

describe('ADR-237 settings: on in production, off on the dev tier, bounded', () => {
  it('reviews one round of the top two on production and nothing on the dev tier by default', () => {
    expect(resolveVisualReviewSettings({}, 'production')).toEqual({ rounds: 1, candidates: 2, maxUsd: 1 });
    expect(resolveVisualReviewSettings({}, 'dev')).toEqual({ rounds: 0, candidates: 2, maxUsd: 1 });
    expect(resolveVisualReviewSettings({ HAWA_STUDIO_VISUAL_REVIEW_ROUNDS: '2', HAWA_STUDIO_VISUAL_REVIEW_CANDIDATES: '1', HAWA_STUDIO_VISUAL_REVIEW_MAX_USD: '0.4' }, 'dev'))
      .toEqual({ rounds: 2, candidates: 1, maxUsd: 0.4 });
  });

  it('refuses a value outside its range instead of spending differently', () => {
    expect(() => resolveVisualReviewSettings({ HAWA_STUDIO_VISUAL_REVIEW_ROUNDS: '3' }, 'production')).toThrow(VisualReviewSettingsError);
    expect(() => resolveVisualReviewSettings({ HAWA_STUDIO_VISUAL_REVIEW_ROUNDS: '1.5' }, 'production')).toThrow(VisualReviewSettingsError);
    expect(() => resolveVisualReviewSettings({ HAWA_STUDIO_VISUAL_REVIEW_CANDIDATES: '0' }, 'production')).toThrow(VisualReviewSettingsError);
    expect(() => resolveVisualReviewSettings({ HAWA_STUDIO_VISUAL_REVIEW_MAX_USD: '0' }, 'production')).toThrow(VisualReviewSettingsError);
    expect(() => resolveVisualReviewSettings({ HAWA_STUDIO_VISUAL_REVIEW_MAX_USD: '9' }, 'production')).toThrow(VisualReviewSettingsError);
  });
});

describe('ADR-237 judge on Sol reads at full detail with room to reason', () => {
  it('sends Sol the renders at high detail, as natively counted, and keeps the dev judge as it was', () => {
    expect(judgeImageDetail('gpt-6.1-sol')).toBe('high');
    expect(judgeImageDetail('gpt-4.1-mini')).toBe('high');
    expect(judgeImageDetail('gpt-6-astra')).toBe('low');
    expect(judgeMaxTokens('gpt-6.1-sol')).toBe(6000);
    expect(judgeMaxTokens('gpt-4.1-mini')).toBe(2000);
  });
});

describe('ADR-237 review: the model sees the real render and returns structured fixes', { timeout: 60000 }, () => {
  it('shows the render the client will see and a labelled copy, with the brief, rules and QA facts', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    vi.stubEnv('HAWA_MODEL_CRITIQUE', '');
    const layout = poster();
    const candidate = ranked(layout);
    const title = markOf(layout, (a) => a.copyIndex === 0);
    const { client, calls } = reviewClient({ assessment: 'The title is timid.', fixes: [
      fix({ boxId: title, category: 'hierarchy', fontSize: 90 }),
      fix({ boxId: 'B99', category: 'spacing', y: 10 }),
    ] });
    const result = await reviewCandidateVisuallyV3(candidate, COPY, {
      client, renderOptions: { logoDataUri: KAAE_TEST_LOGO },
      context: { brief: { instructions: 'A poster for our workshop', copy: [{ copyIndex: 0, text: COPY.text[0], role: 'title' }] },
        clientRules: 'White or cream page; indigo bands; gold only for rules and frames.' },
    });
    vi.unstubAllEnvs();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.model).toBe('gpt-6.1-sol');
    expect(call.jsonSchema.name).toBe('VisualDesignReview');
    expect(call.jsonSchema.strict).toBe(true);
    const parts = call.messages[1].content;
    const images = parts.filter((p: any) => p.type === 'image_url');
    expect(images[0].image_url.url).toBe(`data:image/png;base64,${candidate.renderedPng!.toString('base64')}`);
    expect(images.map((p: any) => p.image_url.detail)).toEqual(['high', 'high']);
    const text = parts[0].text as string;
    expect(text).toContain('A poster for our workshop');
    expect(text).toContain('gold only for rules and frames');
    expect(text).toContain('Hard QA: passed');
    expect(text).toContain(JSON.stringify(COPY.text[4]));
    expect(result.reviewedLayoutSha256).toBe(layoutSha256(layout));
    expect(result.review.fixes).toHaveLength(1);
    expect(result.discarded[0].reason).toContain('unknown mark');
    expect(result.receipt).toMatchObject({ model: 'gpt-6.1-sol', costUsd: 0.03 });
  });

  it('refuses to review a candidate with no render, before any call', async () => {
    const { client, calls } = reviewClient({ assessment: '', fixes: [] });
    const candidate = { ...ranked(poster()), renderedPng: undefined };
    await expect(reviewCandidateVisuallyV3(candidate, COPY, { client })).rejects.toThrow(/no render/);
    expect(calls).toHaveLength(0);
  });

  it('treats an empty or truncated reply as no review, not as "nothing to fix"', async () => {
    const { client } = reviewClient({} as VisualReview);
    await expect(reviewCandidateVisuallyV3(ranked(poster()), COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } })).rejects.toThrow(/empty, truncated or unparseable/);
  });
});

describe('ADR-237 applying fixes: geometry and type size only, through the ADR-190 patch', { timeout: 60000 }, () => {
  it('applies box and type-size fixes and keeps copy, fonts, colours, roles and alignment', () => {
    const layout = poster();
    const title = markOf(layout, (a) => a.copyIndex === 0);
    const footer = markOf(layout, (a) => a.copyIndex === 4);
    const titleBefore = layout.text.find((t) => t.copyIndex === 0)!;
    const footerBefore = layout.text.find((t) => t.copyIndex === 4)!;
    const applied = applyVisualReviewV3(layout, { assessment: 'a', fixes: [
      fix({ boxId: title, category: 'type_size', fontSize: titleBefore.fontSize + 8, lineHeight: 1.1 }),
      fix({ boxId: footer, category: 'spacing', y: footerBefore.y - 40 }),
    ] }, { palette: PALETTE });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.changed).toBe(true);
    expect(applied.fixes.map((f) => f.status)).toEqual(['applied', 'applied']);
    const titleAfter = applied.layout.text.find((t) => t.copyIndex === 0)!;
    expect(titleAfter.fontSize).toBe(titleBefore.fontSize + 8);
    expect(titleAfter.lineHeight).toBe(1.1);
    expect(applied.layout.text.find((t) => t.copyIndex === 4)!.y).toBe(Math.round(footerBefore.y) - 40);
    // Nothing else is the model's to change.
    expect(applied.layout.text.map((t) => [t.copyIndex, t.role, t.fontFamily, t.color, t.align]))
      .toEqual(layout.text.map((t) => [t.copyIndex, t.role, t.fontFamily, t.color, t.align]));
    expect(applied.layout.background).toEqual(layout.background);
    expect(applied.layout.shapes.map((s) => [s.kind, s.role, s.color])).toEqual(layout.shapes.map((s) => [s.kind, s.role, s.color]));
    // The original is not mutated.
    expect(layout.text.find((t) => t.copyIndex === 0)!.fontSize).toBe(titleBefore.fontSize);
  });

  it('keeps a client photograph where it is, and leaves a recipe\'s crop to its solver', () => {
    const layout = poster();
    layout.photos = [{ photoIndex: 0, role: 'inset', x: 300, y: 860, width: 480, height: 280 }];
    const photo = markOf(layout, (a) => a.role.startsWith('photo') || /photo/i.test(a.role));
    const applied = applyVisualReviewV3(layout, { assessment: 'a', fixes: [
      fix({ boxId: photo, category: 'crop', x: 10, width: 900, focusX: 0.3, focusY: 0.2, zoom: 1.4 }),
    ] }, { palette: PALETTE });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const p = applied.layout.photos![0];
    expect([p.x, p.y, p.width, p.height]).toEqual([300, 860, 480, 280]);
    expect(p.focus).toEqual({ x: 0.3, y: 0.2 });
    expect(p.zoom).toBe(1.4);
    expect(applied.fixes[0].detail).toContain('refused: a client photograph keeps its box');

    const recipe = structuredClone(layout);
    (recipe as any).artDirection = { recipe: 'hero_card' };
    const solved = applyVisualReviewV3(recipe, { assessment: 'a', fixes: [fix({ boxId: photo, category: 'crop', focusX: 0.9 })] }, { palette: PALETTE });
    expect(solved.ok && solved.layout.photos![0].focus).toBeFalsy();
    expect(solved.fixes[0].status).toBe('refused');
    expect(solved.fixes[0].detail).toContain('composition owns this crop');
  });

  it('never takes a colour from the model: contrast picks the most readable brand ink', () => {
    const layout = poster();
    const footer = layout.text.find((t) => t.copyIndex === 4)!;
    footer.color = '#E8B85C'; // gold on white: the guideline never sets it as text
    const mark = markOf(layout, (a) => a.copyIndex === 4);
    const applied = applyVisualReviewV3(layout, { assessment: 'a', fixes: [fix({ boxId: mark, category: 'contrast', raiseContrast: true })] }, { palette: PALETTE });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.layout.text.find((t) => t.copyIndex === 4)!.color).toBe('#000000');
    expect(applied.fixes[0].status).toBe('applied');
  });

  it('keeps an accent colour that already reads: contrast is raised only where it is short', () => {
    // Live photo trial, 2026-10-01: a gold subtitle on an indigo panel (8.5:1 against 3:1 needed)
    // was turned white on a "raise contrast" ask, and the guideline's gold accent line was lost.
    const layout = poster();
    layout.shapes.push({ x: 0, y: 1100, width: W, height: 250, kind: 'rect', color: '#17087A', role: 'panel' } as any);
    const footer = layout.text.find((t) => t.copyIndex === 4)!;
    footer.color = '#E8B85C';
    const mark = markOf(layout, (a) => a.copyIndex === 4);
    const applied = applyVisualReviewV3(layout, { assessment: 'a', fixes: [fix({ boxId: mark, category: 'contrast', raiseContrast: true })] }, { palette: PALETTE });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.layout.text.find((t) => t.copyIndex === 4)!.color).toBe('#E8B85C');
    expect(applied.fixes[0].status).toBe('refused');
    expect(applied.fixes[0].detail).toMatch(/already reads at/);
  });

  it('bounds type changes, so a review adjusts the type instead of redrawing it', () => {
    const layout = poster();
    const title = layout.text.find((t) => t.copyIndex === 0)!;
    const mark = markOf(layout, (a) => a.copyIndex === 0);
    const applied = applyVisualReviewV3(layout, { assessment: 'a', fixes: [fix({ boxId: mark, fontSize: title.fontSize * 3, lineHeight: 4 })] }, { palette: PALETTE });
    expect(applied.ok && applied.changed).toBe(false);
    expect(applied.fixes[0].status).toBe('refused');
    expect(applied.fixes[0].detail).toMatch(/outside half to double/);
  });

  it('keeps every requested copy block and stays a transferable, editable layout', async () => {
    const layout = poster();
    const mark = markOf(layout, (a) => a.copyIndex === 1);
    const applied = applyVisualReviewV3(layout, { assessment: 'a', fixes: [fix({ boxId: mark, category: 'grouping', y: 560 })] }, { palette: PALETTE });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const conformed = conformReviewedLayoutV3(applied.layout, COPY, CANVAS);
    expect(conformed.text.map((t) => t.copyIndex).sort()).toEqual([0, 1, 2, 3, 4]);
    const logo = Buffer.from(KAAE_TEST_LOGO.split(',')[1], 'base64');
    const deck = await encodeStudioTransferV2(structuredClone(conformed), Object.values(COPY.text), { bytes: logo, mimeType: 'image/png', sha256: createHash('sha256').update(logo).digest('hex') } as any);
    expect(deck.bytes.length).toBeGreaterThan(1000);
  });
});

describe('ADR-237 regression guard: a refinement is kept only when it is better', { timeout: 60000 }, () => {
  const metrics = (composite: number, failing: string[] = []) => {
    const m = measureDesignV3(poster(), COPY);
    const names = Object.keys(m.metrics);
    return {
      ...m, compositeScore: composite, passed: failing.length === 0, failingMetrics: failing,
      metrics: Object.fromEntries(names.map((n) => [n, { ...(m.metrics as any)[n], passed: !failing.includes(n) }])),
    } as typeof m;
  };
  const qa = (passed: boolean) => ({ passed, defectCodes: passed ? [] : ['COPY_OVERFLOW'] }) as any;

  it('discards a refinement that fails hard QA, without asking the judge', async () => {
    const judge = vi.fn();
    const d = await decideVisualRefinementV3({ metrics: metrics(0.8), hardQa: qa(true) }, { metrics: metrics(0.9), hardQa: qa(false) }, judge);
    expect(d).toMatchObject({ adopt: false, reason: 'refined_fails_hard_qa' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('keeps a refinement whose measures hold, without asking the judge', async () => {
    const judge = vi.fn();
    const d = await decideVisualRefinementV3({ metrics: metrics(0.8), hardQa: qa(true) }, { metrics: metrics(0.8005), hardQa: qa(true) }, judge);
    expect(d).toMatchObject({ adopt: true, reason: 'metrics_hold', regressions: [] });
    expect(judge).not.toHaveBeenCalled();
  });

  it('discards a worse refinement the judge does not prefer', async () => {
    const judge = vi.fn().mockResolvedValue({ winnerId: 'original', reason: 'consistent', totalCostUsd: 0.04 });
    const d = await decideVisualRefinementV3({ metrics: metrics(0.8), hardQa: qa(true) }, { metrics: metrics(0.7, ['balance']), hardQa: qa(true) }, judge);
    expect(d.adopt).toBe(false);
    expect(d.reason).toBe('judge_prefers_original');
    expect(d.regressions).toEqual(expect.arrayContaining(['design gate now fails', 'balance now fails']));
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('keeps the original when the judge splits or ties, and when there is no judge', async () => {
    const split = vi.fn().mockResolvedValue({ winnerId: 'TIE_DISCARDED', reason: 'split', totalCostUsd: 0.04 });
    expect((await decideVisualRefinementV3({ metrics: metrics(0.8), hardQa: qa(true) }, { metrics: metrics(0.79), hardQa: qa(true) }, split)).reason).toBe('judge_undecided');
    expect((await decideVisualRefinementV3({ metrics: metrics(0.8), hardQa: qa(true) }, { metrics: metrics(0.79), hardQa: qa(true) })).reason).toBe('metrics_regressed');
  });

  it('keeps a refinement the judge prefers even though a measure fell', async () => {
    const judge = vi.fn().mockResolvedValue({ winnerId: 'refined', reason: 'consistent', totalCostUsd: 0.04 });
    const d = await decideVisualRefinementV3({ metrics: metrics(0.8), hardQa: qa(true) }, { metrics: metrics(0.78), hardQa: qa(true) }, judge);
    expect(d).toMatchObject({ adopt: true, reason: 'judge_prefers_refined' });
  });

  it('names what regressed', () => {
    expect(metricRegressions(metrics(0.8), metrics(0.8))).toEqual([]);
    expect(metricRegressions(metrics(0.8), metrics(0.75))).toEqual(['composite 0.800→0.750']);
  });

  it('judges a refinement against its original in both orders, on the judge role', async () => {
    vi.stubEnv('HAWA_MODEL_TIER', 'production');
    vi.stubEnv('HAWA_MODEL_JUDGE', '');
    const original = ranked(poster());
    const better = poster();
    better.text.find((t) => t.copyIndex === 0)!.fontSize += 6;
    const refined = ranked(better);
    const seen: any[] = [];
    const client = {
      async createStructuredCompletion(params: any) {
        seen.push(params);
        const imgs = params.messages[1].content.filter((p: any) => p.type === 'image_url').map((p: any) => p.image_url.url);
        const w = imgs[0] === `data:image/png;base64,${refined.renderedPng!.toString('base64')}` ? 'A' : 'B';
        const data = { dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, { winner: w, rationale: 'r' }])), majorityWinner: w, summary: 's' };
        return { data, rawText: '', receipt: { model: params.model, responseId: 'j', xRequestId: null, inputTokens: 1, outputTokens: 1, costUsd: 0.02, latencyMs: 1 } };
      },
    } as unknown as OpenAiStudioClient;
    const match = await judgeRefinementV3(original, refined, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    vi.unstubAllEnvs();
    expect(seen).toHaveLength(2);
    expect(seen.every((p) => p.model === 'gpt-6.1-sol' && p.maxTokens === 6000)).toBe(true);
    expect(match.winnerId).toBe('refined');
  });
});
