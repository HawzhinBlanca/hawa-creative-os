import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect, vi } from 'vitest';
import {
  admittedFontFor,
  sanitizeFontsV3,
  measureDesignV3,
  rankCandidatesV3,
  selectWinnerV3,
  refineCandidateV3,
  prepareGeneratedLayoutV3,
  computeLayoutMetrics,
  createDegradedCanaryLayout,
  renderLayoutV2,
  renderAnnotatedLayoutV2,
  JUDGE_DIMENSIONS,
  OpenAiStudioClient,
  type StudioLayoutV2,
  type PipelineV3Copy,
} from '../src/index.js';

// Fixtures: identical copy, every block a whole number of columns. The panel and the larger title
// put enough type on the canvas to sit inside the negative-space band; `broken` crams everything
// into the top edge and fails three metrics.
const W = 1080;
const H = 1350;
const MARGIN = 76;
const COLS = 6;
const GUT = 26;
const colW = (W - 2 * MARGIN - (COLS - 1) * GUT) / COLS;
const span = (n: number) => Math.round(n * colW + (n - 1) * GUT);

const COPY: PipelineV3Copy = {
  text: {
    0: 'Kurdistan Accrediting Agency for Education',
    1: 'Mandatory Quality Standards 2026',
    2: 'Institutional Excellence Under Law No. 6',
    3: 'All universities must publish audited accreditation reports by the end of Q3.',
    4: 'Erbil • September 2026 • kaae.gov.krd',
  },
};

const base = (over: Partial<StudioLayoutV2>): StudioLayoutV2 =>
  ({
    version: 2,
    width: W,
    height: H,
    genre: 'poster',
    grid: { margin: MARGIN, columns: COLS, gutter: GUT, baseline: 14 },
    background: { color: '#0A1628' },
    logo: { x: Math.round(W / 2 - 100), y: 90, width: 200, height: 120 },
    shapes: [],
    text: [],
    ...over,
  }) as StudioLayoutV2;

const T = (o: any) => ({
  copyIndex: o.i,
  role: o.role,
  x: o.x,
  y: o.y,
  width: o.w,
  height: o.h,
  fontSize: o.size,
  lineHeight: 1.35,
  fontFamily: o.font || 'Verdana',
  color: '#FDF8F3',
  align: o.align,
  bold: !!o.bold,
  italic: false,
  rtl: false,
});

const panel = (x: number, width: number) => ({ x, y: 730, width, height: 260, kind: 'rect', color: '#162B48', role: 'panel' });

const centred = () =>
  base({
    text: [
      T({ i: 0, role: 'eyebrow', x: MARGIN, y: 260, w: span(6), h: 40, size: 18, align: 'center', font: 'Cinzel' }),
      T({ i: 1, role: 'title', x: MARGIN, y: 360, w: span(6), h: 220, size: 72, align: 'center', font: 'Playfair Display', bold: true }),
      T({ i: 2, role: 'subtitle', x: MARGIN, y: 580, w: span(6), h: 70, size: 26, align: 'center', font: 'Playfair Display' }),
      T({ i: 3, role: 'body', x: MARGIN, y: 760, w: span(6), h: 200, size: 22, align: 'center' }),
      T({ i: 4, role: 'footer', x: MARGIN, y: 1180, w: span(6), h: 44, size: 16, align: 'center' }),
    ] as any,
    shapes: [
      { x: Math.round(W / 2 - 80), y: 320, width: 160, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
      panel(MARGIN, span(6)),
    ] as any,
  });

const asymmetric = () =>
  base({
    logo: { x: MARGIN, y: 90, width: 200, height: 120 },
    text: [
      T({ i: 0, role: 'eyebrow', x: MARGIN, y: 260, w: span(4), h: 40, size: 18, align: 'left', font: 'Cinzel' }),
      T({ i: 1, role: 'title', x: MARGIN, y: 360, w: span(5), h: 220, size: 72, align: 'left', font: 'Playfair Display', bold: true }),
      T({ i: 2, role: 'subtitle', x: MARGIN, y: 580, w: span(4), h: 70, size: 26, align: 'left', font: 'Playfair Display' }),
      T({ i: 3, role: 'body', x: MARGIN, y: 760, w: span(4), h: 200, size: 22, align: 'left' }),
      T({ i: 4, role: 'footer', x: MARGIN, y: 1180, w: span(4), h: 44, size: 16, align: 'left' }),
    ] as any,
    shapes: [
      { x: MARGIN, y: 320, width: span(1), height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
      panel(MARGIN, span(4)),
    ] as any,
  });

const broken = () =>
  base({
    text: [
      T({ i: 0, role: 'eyebrow', x: 20, y: 100, w: 300, h: 30, size: 9, align: 'left' }),
      T({ i: 1, role: 'title', x: 30, y: 110, w: 1040, h: 100, size: 20, align: 'left' }),
      T({ i: 2, role: 'subtitle', x: 30, y: 120, w: 1040, h: 60, size: 20, align: 'left' }),
      T({ i: 3, role: 'body', x: 30, y: 130, w: 1040, h: 60, size: 8, align: 'left' }),
      T({ i: 4, role: 'footer', x: 30, y: 140, w: 1040, h: 40, size: 8, align: 'left' }),
    ] as any,
  });

const b64 = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

/**
 * A client that answers like the model would, recording every call. The judge decides by which
 * design it is actually shown, so a test can assert what the judge saw as well as what it chose.
 */
function mockClient(opts: {
  names?: Record<string, string>;
  prefer?: (a: string, b: string) => 'A' | 'B';
  repairLayout?: StudioLayoutV2;
}) {
  const calls: Array<{ schema: string; model: string; images: string[] }> = [];
  const nameOf = (url: string) => opts.names?.[url] ?? 'unknown';
  const client = {
    async createStructuredCompletion(params: any) {
      const content = params.messages?.[1]?.content;
      const images = Array.isArray(content)
        ? content.filter((c: any) => c.type === 'image_url').map((c: any) => c.image_url.url)
        : [];
      calls.push({ schema: params.jsonSchema?.name, model: params.model, images });

      let data: any;
      if (params.jsonSchema?.name === 'PairwiseDimensionVerdict') {
        const w = (opts.prefer ?? (() => 'A'))(nameOf(images[0]), nameOf(images[1]));
        data = {
          dimensions: Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, { winner: w, rationale: 'r' }])),
          majorityWinner: w,
          summary: 's',
        };
      } else if (params.jsonSchema?.name === 'DesignCritiqueReport') {
        data = {
          overallAssessment: 'Blocks collide at the top edge.',
          comments: [
            {
              boxId: 'B1',
              category: 'placement',
              issue: 'The title sits on top of the eyebrow.',
              severity: 'high',
              suggestedFix: 'Move the title down to its own band below the eyebrow.',
            },
          ],
        };
      } else if (params.jsonSchema?.name === 'layout_v3_repair') {
        data = { repairSummary: 'Separated the stacked blocks.', layout: opts.repairLayout };
      } else {
        throw new Error(`unexpected schema ${params.jsonSchema?.name}`);
      }
      return {
        data,
        rawText: JSON.stringify(data),
        receipt: {
          id: `resp_${calls.length}`,
          responseId: `resp_${calls.length}`,
          xRequestId: `req_${calls.length}`,
          model: params.model,
          inputTokens: 1000,
          outputTokens: 100,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 200,
          costUsd: 0.001,
          sha256: '',
          latencyMs: 5,
          attempts: 1,
        },
      };
    },
  } as unknown as OpenAiStudioClient;
  return { client, calls };
}

describe('pipeline v3 — fonts', () => {
  it('chooses each block\'s face by that block\'s own script and role', () => {
    expect(admittedFontFor('Montserrat', 'latin', 'title')).toBe('Cinzel');
    expect(admittedFontFor('Lora', 'latin', 'title')).toBe('Playfair Display');
    expect(admittedFontFor('Cinzel', 'latin', 'body')).toBe('Verdana');
    expect(admittedFontFor('Vazirmatn', 'arabic', 'title')).toBe('Amiri');
    expect(admittedFontFor('Amiri', 'arabic', 'footer')).toBe('Noto Sans Arabic');
  });

  it('keeps a bilingual design bilingual and replaces a face that cannot draw Sorani', () => {
    const layout = base({
      text: [
        T({ i: 0, role: 'title', x: MARGIN, y: 300, w: span(6), h: 120, size: 48, align: 'center', font: 'Montserrat' }),
        // Cairo is admitted, but has no glyph for ڕ or ێ.
        T({ i: 1, role: 'title', x: MARGIN, y: 500, w: span(6), h: 120, size: 48, align: 'center', font: 'Cairo' }),
      ] as any,
    });
    sanitizeFontsV3(layout, { text: { 0: 'Annual Report', 1: 'ڕاپۆرتی ساڵانە' } });
    expect(layout.text[0].fontFamily).toBe('Cinzel');
    expect(layout.text[1].fontFamily).toBe('Amiri');
  });
});

describe('pipeline v3 — ranking', () => {
  it('selects the sole hard-QA eligible candidate without a comparison or canary call', async () => {
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: centred() }, { sourceIndex: 1, layout: asymmetric() }], COPY);
    ranked[0].hardQa = { textMeasurements: [], findings: [], omittedPhotos: [], passed: false, defectCodes: ['COPY_OVERFLOW'], messages: ['Too long'], layout: ranked[0].layout, metrics: computeLayoutMetrics(ranked[0].layout) };
    ranked[1].hardQa = { textMeasurements: [], findings: [], omittedPhotos: [], passed: true, defectCodes: [], messages: [], layout: ranked[1].layout, metrics: computeLayoutMetrics(ranked[1].layout) };
    const createStructuredCompletion = vi.fn().mockRejectedValue(new Error('unexpected paid comparison'));
    const result = await selectWinnerV3(ranked, COPY, { client: { createStructuredCompletion } as unknown as OpenAiStudioClient });
    expect(result.winner).toBe(ranked[1]);
    expect(result.decidedBy).toBe('single_candidate');
    expect(result.canary).toBeNull();
    expect(createStructuredCompletion).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('refuses a sole candidate when hard-QA pass is %s', async (passed) => {
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: centred() }], COPY);
    if (passed === false) ranked[0].hardQa = { textMeasurements: [], findings: [], omittedPhotos: [], passed, defectCodes: ['COPY_OVERFLOW'], messages: [], layout: ranked[0].layout, metrics: computeLayoutMetrics(ranked[0].layout) };
    const createStructuredCompletion = vi.fn().mockRejectedValue(new Error('unexpected paid comparison'));
    await expect(selectWinnerV3(ranked, COPY, { client: { createStructuredCompletion } as unknown as OpenAiStudioClient })).rejects.toThrow('NO_ELIGIBLE_CANDIDATE');
    expect(createStructuredCompletion).not.toHaveBeenCalled();
  });
  it('cannot restore prohibited artwork through preparation or brand ornament', () => {
    const prepared = prepareGeneratedLayoutV3(centred(), COPY, {
      width: W, height: H, allowArt: false, palette: ['#0A1628', '#FFFFFF', '#F7B500'],
      ornament: { texture: 'sun-rays', textureOpacity: 0.1, dividers: true, balance: true },
    });
    expect(prepared.art).toBeUndefined();
  });
  it('puts passing candidates first, then orders by composite', () => {
    const ranked = rankCandidatesV3(
      [
        { sourceIndex: 0, layout: broken() },
        { sourceIndex: 1, layout: asymmetric() },
        { sourceIndex: 2, layout: centred() },
      ],
      COPY
    );
    expect(ranked.map((r) => r.metrics.passed)).toEqual([true, true, false]);
    expect(ranked[2].sourceIndex).toBe(0);
    expect(ranked[0].metrics.compositeScore).toBeGreaterThanOrEqual(ranked[1].metrics.compositeScore);
  });
});

// Render-heavy: each rsvg render takes 0.2-0.5s, so the 5s default is too tight under load.
// These isolate judge protocol/rendering, using explicit synthetic QA evidence. Production
// and the qualification script compute hard QA from the actual client context.
function admitForJudgeFixture(candidate: ReturnType<typeof rankCandidatesV3>[number]): void {
  candidate.hardQa = { textMeasurements: [], findings: [], omittedPhotos: [], passed: true, defectCodes: [], messages: [], layout: candidate.layout, metrics: computeLayoutMetrics(candidate.layout) };
}

describe('pipeline v3 — winner selection', { timeout: 30000 }, () => {
  it('renders each candidate and both sides of its canary with that candidate’s actual assets', async () => {
    const layouts = [centred(), asymmetric()];
    layouts.forEach((layout, i) => {
      layout.art = { source: 'generated', box: { x: 100, y: 100, width: 700, height: 700 },
        calmRegion: { x: 100, y: 100, width: 700, height: 700 }, opacity: i ? 0.3 : 0.15 };
    });
    const options = { logoDataUri: KAAE_TEST_LOGO, artImagePath: KAAE_TEST_LOGO, copyText: COPY.text };
    const names: Record<string, string> = {};
    layouts.forEach((layout, i) => {
      names[b64(renderLayoutV2(layout, options).png)] = `actual-${i}`;
      names[b64(renderLayoutV2(createDegradedCanaryLayout(layout), options).png)] = 'degraded';
    });
    const ranked = rankCandidatesV3(layouts.map((layout, sourceIndex) => ({ sourceIndex, layout })), COPY);
    ranked.forEach(admitForJudgeFixture);
    const preferred = `actual-${ranked[1].sourceIndex}`;
    const seen: string[] = [];
    const { client } = mockClient({ names, prefer: (a, b) => {
      seen.push(a, b);
      return a === 'degraded' || b === preferred ? 'B' : 'A';
    } });
    const result = await selectWinnerV3(ranked, COPY, {
      client, renderOptions: { logoDataUri: KAAE_TEST_LOGO }, renderOptionsForCandidate: () => options,
    });
    expect(result.winner.sourceIndex).toBe(ranked[1].sourceIndex);
    expect(result.canary?.passed).toBe(true);
    expect(seen).toHaveLength(8);
    expect(seen.every((name) => ['actual-0', 'actual-1', 'degraded'].includes(name))).toBe(true);
  });

  const named = () => {
    const a = centred();
    const b = asymmetric();
    const names: Record<string, string> = {
      [b64(renderLayoutV2(a, { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png)]: 'centred',
      [b64(renderLayoutV2(b, { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png)]: 'asymmetric',
      [b64(renderLayoutV2(createDegradedCanaryLayout(a), { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png)]: 'degraded',
      [b64(renderLayoutV2(createDegradedCanaryLayout(b), { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png)]: 'degraded',
    };
    const ranked = rankCandidatesV3(
      [
        { sourceIndex: 0, layout: a },
        { sourceIndex: 1, layout: b },
      ],
      COPY
    );
    ranked.forEach(admitForJudgeFixture);
    return { names, ranked };
  };

  it('adopts the judge\'s pick when it holds in both orders and the judge beats the canary', async () => {
    const { names, ranked } = named();
    const second = ranked[1];
    const secondName = second.sourceIndex === 0 ? 'centred' : 'asymmetric';
    const { client, calls } = mockClient({
      names,
      prefer: (a, b) => {
        if (a === 'degraded') return 'B';
        if (b === 'degraded') return 'A';
        return a === secondName ? 'A' : 'B';
      },
    });

    const result = await selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(result.decidedBy).toBe('judge');
    expect(result.winner.sourceIndex).toBe(second.sourceIndex);
    expect(result.judgeReliable).toBe(true);
    expect(result.canary?.passed).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('keeps the higher composite when the judge only ever picks a position', async () => {
    const { names, ranked } = named();
    const { client } = mockClient({ names, prefer: () => 'A' });

    const result = await selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(result.match?.winnerId).toBe('TIE_DISCARDED');
    expect(result.decidedBy).toBe('composite_after_tie');
    expect(result.winner.sourceIndex).toBe(ranked[0].sourceIndex);
    // A judge that picks by position cannot pass a two-order canary either.
    expect(result.judgeReliable).toBe(false);
  });

  it('overrules a judge that cannot tell its pick from a degraded copy', async () => {
    const { names, ranked } = named();
    const secondName = ranked[1].sourceIndex === 0 ? 'centred' : 'asymmetric';
    const { client } = mockClient({
      names,
      prefer: (a, b) => {
        if (a === 'degraded') return 'A';
        if (b === 'degraded') return 'B';
        return a === secondName ? 'A' : 'B';
      },
    });

    const result = await selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(result.decidedBy).toBe('composite_judge_unreliable');
    expect(result.winner.sourceIndex).toBe(ranked[0].sourceIndex);
    expect(result.judgeReliable).toBe(false);
  });

  it('shows the judge the real copy, never placeholder text', async () => {
    const { names, ranked } = named();
    const { client, calls } = mockClient({ names, prefer: () => 'A' });
    await selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });

    const placeholder = b64(renderLayoutV2(ranked[0].layout, { logoDataUri: KAAE_TEST_LOGO }).png);
    const seen = calls.flatMap((c) => c.images);
    expect(seen.length).toBe(8);
    expect(seen).not.toContain(placeholder);
    expect(seen.every((url) => names[url] !== undefined)).toBe(true);
  });

  it('spends nothing when only one candidate is left', async () => {
    const { client, calls } = mockClient({});
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: centred() }], COPY);
    ranked.forEach(admitForJudgeFixture);
    const result = await selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(result.decidedBy).toBe('single_candidate');
    expect(calls).toHaveLength(0);
  });
});

// Render-heavy: each rsvg render takes 0.2-0.5s, so the 5s default is too tight under load.
describe('pipeline v3 — refinement', { timeout: 30000 }, () => {
  it('spends nothing on a candidate that already passes the gate', async () => {
    const { client, calls } = mockClient({});
    const [top] = rankCandidatesV3([{ sourceIndex: 0, layout: centred() }], COPY);
    const outcome = await refineCandidateV3(top, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(outcome.reason).toBe('gate_passed');
    expect(outcome.adopted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refines a failing candidate with the critic seeing the real copy, and adopts a passing repair', async () => {
    const failing = broken();
    const { client, calls } = mockClient({ repairLayout: centred() });
    const [top] = rankCandidatesV3([{ sourceIndex: 3, layout: failing }], COPY);
    expect(top.metrics.passed).toBe(false);

    const outcome = await refineCandidateV3(top, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(outcome.adopted).toBe(true);
    expect(outcome.reason).toBe('adopted_now_passes');
    expect(outcome.metrics.passed).toBe(true);
    expect(outcome.metrics.compositeScore).toBe(measureDesignV3(outcome.layout, COPY).compositeScore);

    // The critic was shown the design with its copy, not "Sample copy block N".
    const critiqueCall = calls.find((c) => c.schema === 'DesignCritiqueReport');
    expect(critiqueCall?.images[0]).toBe(b64(renderAnnotatedLayoutV2(failing, { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png));

    // Each round records its two calls separately, with the tokens a ledger needs.
    const round = outcome.result.rounds[0];
    expect(round.calls.map((c) => c.stage)).toEqual(['critique', 'repair']);
    expect(round.calls[1]).toMatchObject({ inputTokens: 1000, cachedTokens: 200, outputTokens: 100 });
  });
});

describe('OpenAI client — reasoning effort', () => {
  const capture = () => {
    const bodies: any[] = [];
    const fetcher = (async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'req_test' },
        json: async () => ({
          id: 'chatcmpl_test',
          model: JSON.parse(init.body).model,
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      };
    }) as unknown as typeof fetch;
    return { bodies, client: new OpenAiStudioClient({ apiKey: 'test', fetcher }) };
  };
  const call = (client: OpenAiStudioClient, model: string) =>
    client.createStructuredCompletion({
      model,
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: { name: 'x', schema: { type: 'object' } },
      reasoningEffort: 'low',
    });

  it('sends it to a reasoning model and withholds it from one that would reject the request', async () => {
    const { bodies, client } = capture();
    await call(client, 'o4-mini');
    await call(client, 'gpt-4.1-mini');
    expect(bodies[0].reasoning_effort).toBe('low');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });
});

// Render-heavy: each rsvg render takes 0.2-0.5s, so the 5s default is too tight under load.
describe('production hard QA — the gate v3 is ranked and qualified against', { timeout: 30000 }, () => {
  it('passes every owner-confirmed exemplar on alignment and still rejects an off-grid layout', async () => {
    const { SIX_CONFIRMED_EXEMPLARS, BAD_OFF_GRID } = await import('./fixtures/design-metrics-fixtures.js');
    const { computeLayoutMetrics } = await import('../src/index.js');
    // Counting edges only, three of these six scored 0.542, 0.600 and 0.667 against the 0.70 gate.
    for (const exemplar of SIX_CONFIRMED_EXEMPLARS) {
      expect(computeLayoutMetrics(exemplar).alignmentScore).toBeGreaterThanOrEqual(0.7);
    }
    expect(computeLayoutMetrics(BAD_OFF_GRID).alignmentScore).toBeLessThan(0.7);
  });

  it('ranks a candidate production would reject below one it would accept, whatever the composite', async () => {
    const { studioReferenceFromRaw } = await import('../src/index.js');
    const ref = studioReferenceFromRaw({ rules: { palette: ['#0A1628', '#FDF8F3', '#C5A059', '#162B48'] } });
    const qa = {
      width: W,
      height: H,
      copyScripts: ['latin', 'latin', 'latin', 'latin', 'latin'] as Array<'latin' | 'arabic'>,
      latinFont: ref.latinFont,
      arabicFont: ref.arabicFont,
      palette: ref.palette,
      logoAspect: 200 / 120,
    };
    const offPalette = centred();
    offPalette.background.color = '#123456';
    // Clean for production QA: the eyebrow clears the logo's clear space (half its height), and
    // no divider sits off-centre in its gap.
    const clean = asymmetric();
    clean.text[0].y = 290;
    clean.shapes = clean.shapes.filter((s) => s.role !== 'rule');
    const ranked = rankCandidatesV3(
      [
        { sourceIndex: 0, layout: offPalette },
        { sourceIndex: 1, layout: clean },
      ],
      COPY,
      qa
    );
    expect(ranked[0].sourceIndex).toBe(1);
    expect(ranked[0].hardQa?.passed).toBe(true);
    expect(ranked[1].hardQa?.defectCodes).toContain('PALETTE');
  });
});

describe('logo and canvas truth', () => {
  it('fits the real logo inside its reserved box without ever growing it', async () => {
    const { fitLogoToAspect } = await import('../src/index.js');
    // A 2:1 box for a square emblem: the emblem becomes the box's height, centred in it.
    expect(fitLogoToAspect({ logo: { x: 400, y: 80, width: 200, height: 100 } }, 1).logo).toEqual({ x: 450, y: 80, width: 100, height: 100 });
    // A tall box for a square emblem: bounded by the width instead.
    expect(fitLogoToAspect({ logo: { x: 0, y: 0, width: 100, height: 300 } }, 1).logo).toEqual({ x: 0, y: 100, width: 100, height: 100 });
    // The production qualification's widest box, 192x124: previously grown to 192x192.
    const fitted = fitLogoToAspect({ logo: { x: 0, y: 0, width: 192, height: 124 } }, 1).logo!;
    expect(fitted.height).toBeLessThanOrEqual(124);
    expect(fitted.width).toBe(fitted.height);
  });

  it('describes the canvas to the generator by its real proportion', async () => {
    const { aspectRatioLabel } = await import('../src/index.js');
    expect(aspectRatioLabel(1080, 1350)).toBe('4:5');
    expect(aspectRatioLabel(1080, 1080)).toBe('1:1');
    // These were all described as "4:5".
    expect(aspectRatioLabel(1920, 1080)).toBe('16:9');
    expect(aspectRatioLabel(1080, 1920)).toBe('9:16');
    expect(aspectRatioLabel(1240, 1754)).toBe('A4 portrait, 1:1.414');
  });
});

describe('bilingual direction', () => {
  it('describes a bilingual design as mixed, whatever flag a caller passes', async () => {
    const { languageDirectionLabel, buildLayoutV3UserPrompt } = await import('../src/index.js');
    const mixed = [
      { index: 0, text: 'Annual Report', role: 'title' as const, script: 'latin' as const },
      { index: 1, text: 'ڕاپۆرتی ساڵانە', role: 'title' as const, script: 'arabic' as const },
    ];
    // Production passed true for this copy and the qualification passed false; both now get the same line.
    for (const flag of [true, false]) {
      expect(languageDirectionLabel(mixed, flag)).toMatch(/^Mixed/);
      expect(
        buildLayoutV3UserPrompt({ brief: 'b', copyBlocks: mixed, palette: ['#0A1628'], canvasWidth: 1080, canvasHeight: 1350, isRtl: flag })
      ).toContain('Language Direction: Mixed');
    }
    expect(languageDirectionLabel([mixed[1]])).toMatch(/^RTL/);
    expect(languageDirectionLabel([mixed[0]])).toMatch(/^LTR/);
  });
});


// Render-heavy (wrapped-line measurement): generous timeout for loaded machines.
describe('house rules — preparation conforms what QA would reject for a mechanical reason', { timeout: 30000 }, () => {
  const kurdish: PipelineV3Copy = {
    text: { 0: 'دەستەی متمانەپێدانی کوردستان', 1: 'ستانداردە نوێیەکانی کوالیتی', 2: 'هەموو زانکۆکان دەبێت ڕاپۆرتی ساڵانە بڵاو بکەنەوە.' },
  };
  const kurdishLayout = () =>
    base({
      logo: { x: 490, y: 76, width: 100, height: 100 },
      text: [
        T({ i: 0, role: 'eyebrow', x: MARGIN, y: 260, w: span(6), h: 40, size: 18, align: 'center', font: 'Cairo' }),
        T({ i: 1, role: 'title', x: MARGIN, y: 340, w: span(6), h: 90, size: 52, align: 'center', font: 'Amiri', bold: true }),
        T({ i: 2, role: 'body', x: MARGIN, y: 470, w: span(6), h: 60, size: 22, align: 'center' }),
      ] as any,
    });
  const qaFor = (copyScripts: Array<'latin' | 'arabic'>, palette = ['#0A1628', '#FDF8F3', '#F7B500', '#162B48', '#1E3A5F']) => ({
    width: W, height: H, copyScripts, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette, logoAspect: 1,
  });

  it('gives Sorani its leading and no tracking, and grows boxes so the copy still fits', async () => {
    const { conformToHouseRules, measureWrappedLines, evaluateHardQa } = await import('../src/index.js');
    const layout = kurdishLayout();
    for (const t of layout.text) {
      t.lineHeight = 1.3;
      t.letterSpacing = 0.05;
    }
    conformToHouseRules(layout, kurdish);
    const lines = measureWrappedLines(layout, kurdish.text);
    for (const t of layout.text) {
      expect(t.lineHeight).toBeGreaterThanOrEqual(1.6);
      expect(t.lineHeight).toBeLessThanOrEqual(1.9);
      expect(t.letterSpacing).toBe(0);
      expect(t.height).toBeGreaterThanOrEqual(Math.ceil((lines[t.copyIndex] ?? 1) * t.fontSize * t.lineHeight));
    }
    // Boxes grew by inserting space, so nothing now overlaps.
    const qa = evaluateHardQa(layout, qaFor(['arabic', 'arabic', 'arabic']));
    expect(qa.defectCodes).not.toContain('LINE_HEIGHT');
    expect(qa.defectCodes).not.toContain('OVERLAP');
  });

  it('keeps body copy untracked and Latin display tracking within 0.1', async () => {
    const { conformToHouseRules } = await import('../src/index.js');
    const layout = centred();
    layout.text[0].letterSpacing = 0.3;
    layout.text[3].letterSpacing = 0.02;
    conformToHouseRules(layout, COPY);
    expect(layout.text[0].letterSpacing).toBe(0.1);
    expect(layout.text[3].letterSpacing).toBe(0);
  });

  it('pulls a box that overruns the safe area by rounding back inside it', async () => {
    const { conformToHouseRules } = await import('../src/index.js');
    const layout = centred();
    layout.text[0].width = W - 2 * MARGIN + 1;
    conformToHouseRules(layout, COPY);
    const t = layout.text[0];
    expect(t.x).toBeGreaterThanOrEqual(MARGIN);
    expect(t.x + t.width).toBeLessThanOrEqual(W - MARGIN);
  });

  it('snaps an off-palette colour to the nearest brand colour', async () => {
    const { conformToHouseRules, nearestPaletteColour } = await import('../src/index.js');
    // The qualification's old gold snaps to the brand gold; navy stays navy.
    expect(nearestPaletteColour('#C5A059', ['#0A1628', '#F7B500', '#FDF8F3'])).toBe('#F7B500');
    expect(nearestPaletteColour('#0a1628', ['#0A1628', '#F7B500'])).toBe('#0a1628');
    const layout = centred();
    conformToHouseRules(layout, COPY, ['#0A1628', '#F7B500', '#FDF8F3', '#162B48']);
    expect(layout.shapes.find((s) => s.role === 'rule')!.color).toBe('#F7B500');
  });

  it('raises a title that misses 2.2x the body by a fraction of a pixel', async () => {
    const { conformToHouseRules } = await import('../src/index.js');
    const layout = centred();
    layout.text[3].fontSize = 22;
    layout.text[1].fontSize = 48;
    conformToHouseRules(layout, COPY);
    expect(layout.text[1].fontSize).toBe(49);
  });

  it('shrinks a crowding logo down to exactly its minimum, and grows one below it', async () => {
    const { conformToHouseRules, logoClearZone } = await import('../src/index.js');
    // 119px logo at y=94: its clear zone reaches 272.5, the eyebrow starts at 245. At 100px the
    // zone ends at 244 — the one size that clears it, which a 2px step from 117 never tried.
    const crowded = centred();
    crowded.logo = { x: 481, y: 94, width: 119, height: 119 };
    crowded.text[0].y = 245;
    conformToHouseRules(crowded, COPY);
    expect(crowded.logo.width).toBe(100);
    const zone = logoClearZone(crowded.logo);
    expect(zone.y + zone.height).toBeLessThanOrEqual(crowded.text[0].y);

    const small = { ...centred(), width: 1920, height: 1080 } as StudioLayoutV2;
    small.logo = { x: 76, y: 76, width: 120, height: 120 };
    conformToHouseRules(small, COPY);
    expect(small.logo.width).toBe(154);
  });

  it('moves a block out of the logo clear zone when the canvas has room, and leaves it when it has none', async () => {
    const { conformToHouseRules, logoClearZone } = await import('../src/index.js');
    const roomy = centred();
    roomy.logo = { x: 490, y: 76, width: 100, height: 100 };
    roomy.text[0].y = 190; // inside the 50px clear space below the logo
    conformToHouseRules(roomy, COPY);
    expect(roomy.text[0].y).toBeGreaterThanOrEqual(logoClearZone(roomy.logo).y + logoClearZone(roomy.logo).height);

    const full = centred();
    full.logo = { x: 490, y: 76, width: 100, height: 100 };
    full.text[0].y = 190;
    full.text[4].y = H - MARGIN - full.text[4].height; // the footer already sits on the bottom margin
    const before = full.text.map((t) => t.y);
    conformToHouseRules(full, COPY);
    // No room: nothing below is pushed out of the safe area.
    for (const t of full.text) expect(t.y + t.height).toBeLessThanOrEqual(H - MARGIN);
    expect(full.text[4].y).toBe(before[4]);
  });

  it('never stretches a panel past the canvas when it inserts space', async () => {
    const { conformToHouseRules } = await import('../src/index.js');
    const layout = centred();
    layout.shapes = [{ x: 0, y: 200, width: W, height: H - 200, kind: 'rect', color: '#162B48', role: 'panel' } as any];
    layout.logo = { x: 490, y: 76, width: 100, height: 100 };
    layout.text[0].y = 190;
    conformToHouseRules(layout, COPY);
    for (const s of layout.shapes) expect(s.y + s.height).toBeLessThanOrEqual(H);
  });

  it('asks the art to be calm only where text is over it', async () => {
    const { conformToHouseRules, validateLayoutV2 } = await import('../src/index.js');
    const layout = centred();
    layout.shapes = [];
    // Art over the top 60% of the canvas; the footer sits below it.
    (layout as any).art = { source: 'procedural', motif: 'thin-rules', box: { x: 0, y: 0, width: W, height: 810 }, opacity: 0.2, calmRegion: { x: 108, y: 135, width: 864, height: 400 } };
    conformToHouseRules(layout, COPY);
    const c = (layout as any).art.calmRegion;
    // Every block that touches the art — including the body straddling its lower edge — is covered.
    for (const t of layout.text.filter((t) => t.y < 810)) {
      expect(c.x <= t.x && c.y <= t.y && c.x + c.width >= t.x + t.width && c.y + c.height >= t.y + t.height).toBe(true);
    }
    const result = validateLayoutV2(layout, {
      expectedWidth: W, expectedHeight: H, copyCount: 5, copyScripts: ['latin', 'latin', 'latin', 'latin', 'latin'],
      reference: { rules: { fontFamily: 'Verdana', palette: ['#0A1628', '#FDF8F3', '#C5A059', '#162B48'] }, logoAspect: 200 / 120 },
    } as any);
    expect(result.ok || result.code !== 'ART_SAFETY').toBe(true);
  });
});

describe('refinement is told what production QA rejects', { timeout: 30000 }, () => {
  it('shows the repair model the defects preparation cannot fix, and adopts a repair QA accepts', async () => {
    const { refineCandidateV3, rankCandidatesV3, prepareGeneratedLayoutV3 } = await import('../src/index.js');
    const qa = {
      width: W, height: H, copyScripts: ['latin', 'latin', 'latin', 'latin', 'latin'] as Array<'latin' | 'arabic'>,
      latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette: ['#0A1628', '#FDF8F3', '#C5A059', '#162B48'], logoAspect: 1,
    };
    const canvas = { width: W, height: H, logoAspect: 1, palette: qa.palette };
    // The generator dropped the subtitle, as the cheap tier did in 2 of 20 designs: no preparation
    // can put copy back, so QA rejects it. (A crowded layout used to serve here; preparation now
    // resolves those — see the settling tests below.)
    const missing = centred();
    missing.text = missing.text.filter((t) => t.role !== 'subtitle');
    const [top] = rankCandidatesV3([{ sourceIndex: 0, layout: prepareGeneratedLayoutV3(missing, COPY, canvas) }], COPY, qa);
    expect(top.hardQa?.passed).toBe(false);
    expect(top.hardQa?.defectCodes).toContain('COPY_PLACEMENT');

    const prompts: string[] = [];
    const { client } = mockClient({ repairLayout: centred() });
    const spying = {
      createStructuredCompletion: async (params: any) => {
        if (params.jsonSchema?.name === 'layout_v3_repair') prompts.push(String(params.messages[1].content));
        return (client as any).createStructuredCompletion(params);
      },
    } as unknown as OpenAiStudioClient;
    const outcome = await refineCandidateV3(top, COPY, { client: spying, qa, canvas, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('HARD QA DEFECTS');
    expect(prompts[0]).toContain('COPY_PLACEMENT');
    expect(outcome.adopted).toBe(true);
    expect(outcome.reason).toBe('adopted_now_passes_qa');
    expect(outcome.hardQa?.passed).toBe(true);
  });
});

describe('negative space and canvas borders', () => {
  it('treats a background-filled border around the canvas as a border, whatever it is called', async () => {
    const { evaluateDesignMetrics } = await import('../src/index.js');
    const without = centred();
    const border = (role: string) => {
      const l = centred();
      // The kind of border the studio normaliser renames from frame to panel.
      l.shapes.push({ x: 40, y: 40, width: W - 80, height: H - 80, kind: 'rect', color: '#0A1628', strokeColor: '#C5A059', role } as any);
      return (evaluateDesignMetrics(l).metrics.negativeSpace.details as any).occupiedArea;
    };
    const base = (evaluateDesignMetrics(without).metrics.negativeSpace.details as any).occupiedArea;
    expect(border('frame')).toBe(base);
    expect(border('panel')).toBe(base);
  });

  it('still counts an outlined content card, as the calibration does', async () => {
    const { evaluateDesignMetrics } = await import('../src/index.js');
    const base = (evaluateDesignMetrics(centred()).metrics.negativeSpace.details as any).occupiedArea;
    const card = centred();
    card.shapes.push({ x: 86, y: 689, width: 907, height: 311, kind: 'rect', color: '#0A1628', strokeColor: '#C5A059', role: 'frame' } as any);
    expect((evaluateDesignMetrics(card).metrics.negativeSpace.details as any).occupiedArea).toBeGreaterThan(base);
  });
});

describe('the logo is lifted clear of the text below it', { timeout: 30000 }, () => {
  it('lifts a logo whose clear space reaches the eyebrow, but never above the margin', async () => {
    const { conformToHouseRules, logoClearZone } = await import('../src/index.js');
    const layout = centred();
    layout.logo = { x: 490, y: 200, width: 100, height: 100 };
    layout.text[0].y = 330; // the zone ends at 350: 20px into the eyebrow
    conformToHouseRules(layout, COPY);
    const zone = logoClearZone(layout.logo);
    expect(zone.y + zone.height).toBeLessThanOrEqual(layout.text[0].y);
    expect(layout.logo.y).toBeGreaterThanOrEqual(MARGIN);
    expect(layout.text[0].y).toBe(330); // the text did not move: the logo did
  });
});

describe('inserted space moves a low logo with its content', { timeout: 30000 }, () => {
  it('keeps a bottom logo clear of text pushed down by a growing box', async () => {
    const { conformToHouseRules } = await import('../src/index.js');
    const layout = centred();
    // A tall Sorani-free title box that must grow, and a logo in the lower part of the design.
    layout.text[1].height = 60; // two lines of 72px type need far more than 60px
    layout.text = layout.text.filter((t) => t.role !== 'footer');
    layout.logo = { x: 490, y: 1000, width: 100, height: 100 };
    const before = layout.logo.y;
    conformToHouseRules(layout, COPY);
    const intersects = (a: any, b: any) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    for (const t of layout.text) expect(intersects(t, layout.logo)).toBe(false);
    expect(layout.logo.y).toBeGreaterThanOrEqual(before);
  });
});

describe('a growing box stays inside the safe area', { timeout: 30000 }, () => {
  it('never grows the lowest box past the safe bottom', async () => {
    const { conformToHouseRules } = await import('../src/index.js');
    const layout = centred();
    const footer = layout.text[4];
    footer.y = H - MARGIN - footer.height; // on the bottom margin
    footer.fontSize = 30; // now needs more height than it has
    conformToHouseRules(layout, COPY);
    expect(footer.y + footer.height).toBeLessThanOrEqual(H - MARGIN);
  });
});

describe('a rule never ends up in the logo clear space', { timeout: 30000 }, () => {
  it('moves a rule out of the logo zone, or drops it when there is no room either side', async () => {
    const { conformToHouseRules, logoClearZone } = await import('../src/index.js');
    const intersects = (a: any, b: any) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    // cheap run 5, brief_10: a full-width rule 36px above a 100px logo whose zone needs 50px.
    const layout = centred();
    layout.logo = { x: 490, y: 568, width: 100, height: 100 };
    layout.shapes = [{ x: MARGIN, y: 528, width: W - 2 * MARGIN, height: 4, kind: 'line', color: '#C5A059', role: 'rule' } as any];
    layout.text[0].y = 718;
    conformToHouseRules(layout, COPY);
    const zone = logoClearZone(layout.logo);
    for (const s of layout.shapes) expect(intersects(s, zone)).toBe(false);
  });
});

describe('settling a crowded design — stored designs production QA rejected', { timeout: 30000 }, () => {
  const KAAE_PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
  /** [copyIndex, role, x, y, width, height, fontSize, lineHeight, face, colour] */
  type Row = [number, string, number, number, number, number, number, number, string, string?];
  /** [role, kind, x, y, width, height, colour] */
  type ShapeRow = [string, string, number, number, number, number, string];
  /** A design as a qualification run stored it. */
  const stored = (
    [width, height, margin]: [number, number, number],
    logo: { x: number; y: number; width: number; height: number },
    rows: Row[],
    shapes: ShapeRow[],
    background = '#0A1628'
  ): StudioLayoutV2 =>
    ({
      version: 2,
      width,
      height,
      genre: 'poster',
      grid: { margin, columns: 6, gutter: 38, baseline: 8 },
      background: { color: background },
      logo,
      text: rows.map(([copyIndex, role, x, y, w, h, fontSize, lineHeight, fontFamily, color]) => ({
        copyIndex, role, x, y, width: w, height: h, fontSize, lineHeight, fontFamily,
        color: color || '#FDF8F3', align: 'center', bold: role === 'title', italic: false, rtl: false,
      })),
      shapes: shapes.map(([role, kind, x, y, w, h, color]) => ({ role, kind, x, y, width: w, height: h, color })),
    }) as StudioLayoutV2;
  const copyOf = (script: 'latin' | 'arabic', texts: string[]): PipelineV3Copy => ({
    text: Object.fromEntries(texts.map((t, i) => [i, t])),
    scripts: Object.fromEntries(texts.map((_, i) => [i, script])),
  });
  /** Production's preparation, then production's hard QA, as the studio and the qualification run them. */
  const prepare = async (raw: StudioLayoutV2, copy: PipelineV3Copy) => {
    const { prepareGeneratedLayoutV3, evaluateHardQa } = await import('../src/index.js');
    const layout = prepareGeneratedLayoutV3(raw, copy, { width: raw.width, height: raw.height, logoAspect: 1, palette: KAAE_PALETTE });
    const qa = evaluateHardQa(layout, {
      width: raw.width, height: raw.height, copyScripts: Object.values(copy.scripts!), latinFont: 'Verdana',
      arabicFont: 'Noto Sans Arabic', palette: KAAE_PALETTE, logoAspect: 1, copyText: copy.text,
    });
    return { layout, qa };
  };
  const byRole = (l: StudioLayoutV2, role: string) => l.text.find((t) => t.role === role)!;
  const bottom = (b: { y: number; height: number }) => b.y + b.height;
  const SUMMIT = copyOf('latin', [
    'Executive Directorate for Higher Education',
    'Kurdistan Chancellor Summit 2026',
    'Strategic Convergence on Global Academic Recognition',
    'Uniting leadership to pioneer internationally recognized degree validation and regional research clusters.',
    'KAAE Plenary Hall • October 2026 • Live Broadcast kaae.gov.krd',
  ]);

  it('closes up the gaps under a logo on the top margin of a full banner, rather than fail QA', async () => {
    // Production model, brief_17: a 154px logo, its clear space and five blocks do not fit a 1080px
    // banner at a 115px margin with the design's own spacing.
    const { layout, qa } = await prepare(
      stored([1920, 1080, 115], { x: 864, y: 70, width: 192, height: 124 }, [
        [0, 'eyebrow', 192, 232, 1536, 38, 16, 1.3, 'Cinzel', '#C5A059'],
        [1, 'title', 115, 346, 1690, 124, 81, 1.25, 'Playfair Display'],
        [2, 'subtitle', 192, 502, 1536, 65, 24, 1.4, 'Playfair Display', '#C5A059'],
        [3, 'body', 230, 637, 1459, 162, 36, 1.5, 'Verdana'],
        [4, 'footer', 192, 924, 1536, 38, 16, 1.4, 'Verdana'],
      ], [
        ['rule', 'line', 845, 307, 230, 2, '#C5A059'],
        ['panel', 'rect', 115, 886, 1690, 113, '#1E3A5F'],
        ['rule', 'line', 115, 886, 1690, 2, '#C5A059'],
      ]),
      SUMMIT
    );
    expect(qa.messages, qa.messages.join('\n')).toEqual([]);
    expect(layout.grid.margin).toBe(115);
    // The footer band stayed; the blocks above it closed up, never tighter than 12px.
    expect(layout.shapes.find((s) => s.role === 'panel')!.y).toBe(886);
    const stack = [...layout.text].sort((a, b) => a.y - b.y);
    for (let i = 1; i < stack.length; i++) expect(stack[i].y - bottom(stack[i - 1])).toBeGreaterThanOrEqual(12);
  });

  it('takes the house-minimum margin when closing up is not enough, and the band carries its footer', async () => {
    // Production model, brief_19 (Sorani): even half the design's spacing does not fit at 115px.
    // At the house minimum the logo moves onto the new margin, and the footer band moves with its
    // footer instead of leaving it 9px from the band's top edge.
    const { layout, qa } = await prepare(
      stored([1920, 1080, 115], { x: 874, y: 65, width: 173, height: 151 }, [
        [0, 'eyebrow', 192, 246, 1536, 49, 24, 1.35, 'Amiri', '#C5A059'],
        [1, 'title', 115, 351, 1690, 162, 81, 1.3, 'Amiri'],
        [2, 'subtitle', 192, 529, 1536, 81, 36, 1.4, 'Amiri', '#C5A059'],
        [3, 'body', 230, 664, 1459, 167, 36, 1.5, 'Noto Sans Arabic'],
        [4, 'footer', 192, 919, 1536, 54, 24, 1.4, 'Noto Sans Arabic'],
      ], [
        ['rule', 'line', 672, 322, 576, 2, '#C5A059'],
        ['panel', 'rect', 115, 886, 1690, 119, '#1E3A5F'],
      ]),
      copyOf('arabic', [
        'فەرمانگەی باڵای خوێندنی ئەکادیمی',
        'دیداری لوتکەی سەرۆک زانکۆکان ٢٠٢٦',
        'هەنگاوەکانی بەدەستهێنانی دانپێدانانی نێودەوڵەتی',
        'کۆکردنەوەی تواناکان بۆ داڕشتنی ڕوانگەیەکی هاوبەش بەرەو پێشەنگی پەروەردەیی و زانستی لە ناوچەکەدا.',
        'هۆڵی کۆبوونەوەکانی KAAE • هەولێر • پەخشی ڕاستەوخۆ',
      ])
    );
    // Geometry and the original mixed-font footer now have measured local evidence.
    expect(qa.passed, qa.messages.join('; ')).toBe(true);
    expect(qa.defectCodes).toEqual([]);
    expect(qa.textMeasurements.find((m) => m.copyIndex === 4)).toMatchObject({status: 'measured', method: 'pango-wrap-v1'});
    expect(layout.grid.margin).toBe(64);
    expect(layout.logo!.y).toBe(64);
    const band = layout.shapes.find((s) => s.role === 'panel')!;
    const footer = byRole(layout, 'footer');
    expect(footer.y - band.y).toBeGreaterThanOrEqual(20);
    expect(bottom(band) - bottom(footer)).toBeGreaterThanOrEqual(20);
  });

  it('keeps the order of two blocks that already overlapped when space is inserted above them', async () => {
    // T5, brief_07: the eyebrow overlapped the title by 20px and both lay in the logo's clear space;
    // the inserted space used to put both on the same line.
    const { layout, qa } = await prepare(
      stored([1080, 1350, 65], { x: 65, y: 81, width: 76, height: 81 }, [
        [0, 'eyebrow', 130, 182, 821, 41, 14, 1.3, 'Cairo'],
        [1, 'title', 130, 203, 821, 135, 40, 1.3, 'Amiri', '#C5A059'],
        [2, 'subtitle', 130, 378, 821, 81, 20, 1.4, 'Cairo'],
        [3, 'body', 130, 486, 821, 162, 19, 1.5, 'Noto Sans Arabic'],
        [4, 'footer', 130, 1168, 821, 41, 12, 1.3, 'Noto Sans Arabic', '#0A1628'],
      ], [
        ['panel', 'rect', 65, 81, 950, 243, '#0A1628'],
        ['panel', 'rect', 65, 1107, 950, 162, '#C5A059'],
      ], '#1E3A5F'),
      copyOf('arabic', [
        'دەستەی متمانەبەخشین بە دامەزراوەکانی پەروەردە',
        'کۆنفرانسی نیشتمانیی دڵنیایی جۆری ٢٠٢٦',
        'بەرەو بەرزکردنەوەی ئاستی زانستی لە زانکۆکانی کوردستان',
        'بانگهێشتی سەرجەم سەرۆک زانکۆکان و پسپۆڕانی پەروەردەیی دەکرێت بۆ بەشداریکردن لە شیکاری پێوەرە نێودەوڵەتییەکان.',
        'هۆڵی سەعد عەبدوڵڵا، هەولێر • ٢٨ی تشرینی یەکەمی ٢٠٢٦',
      ])
    );
    // Geometry and the original mixed-font footer now have measured local evidence.
    expect(qa.passed, qa.messages.join('; ')).toBe(true);
    expect(qa.defectCodes).toEqual([]);
    expect(qa.textMeasurements.find((m) => m.copyIndex === 4)).toMatchObject({status: 'measured', method: 'pango-wrap-v1'});
    expect(bottom(byRole(layout, 'eyebrow'))).toBeLessThanOrEqual(byRole(layout, 'title').y);
  });

  it('leaves the logo in place when text starts in its own clear space, and cleans the art prompt', async () => {
    // T5, brief_13: the eyebrow started at the logo's top edge, and the space inserted to clear the
    // logo moved the logo along with it. Its art was placed "behind focal text", which QA rejects.
    const raw = stored([1240, 1754, 87], { x: 87, y: 123, width: 124, height: 88 }, [
      [0, 'eyebrow', 87, 123, 1066, 61, 16, 1.3, 'Cinzel', '#C5A059'],
      [1, 'title', 87, 193, 1066, 246, 54, 1.2, 'Playfair Display'],
      [2, 'subtitle', 87, 456, 1066, 123, 26, 1.35, 'Playfair Display'],
      [3, 'body', 149, 1000, 942, 210, 20, 1.5, 'Verdana', '#1E3A5F'],
      [4, 'footer', 149, 1245, 942, 88, 14, 1.35, 'Verdana', '#1E3A5F'],
    ], [['panel', 'roundRect', 87, 965, 1066, 667, '#162B48']], '#1E3A5F');
    (raw as any).art = {
      source: 'generated', prompt: 'subtle sun-ray gradient in navy behind focal text', motif: 'sun-rays',
      box: { x: 87, y: 123, width: 1066, height: 789 }, opacity: 0.2, calmRegion: { x: 87, y: 123, width: 1066, height: 789 },
    };
    const { layout, qa } = await prepare(
      raw,
      copyOf('latin', [
        'Kurdistan Regional Government • KAAE High Council',
        'Statutory Accreditation Order No. 4',
        'Mandatory Governance Criteria for Higher Education Institutions',
        'Pursuant to powers vested under Law No. 6 of 2022, all degree-granting bodies must comply with institutional auditing standards.',
        'Published in the Official Gazette • Erbil, Kurdistan Region • 2026',
      ])
    );
    const { logoClearZone } = await import('../src/index.js');
    expect(qa.messages, qa.messages.join('\n')).toEqual([]);
    expect(layout.logo!.y).toBe(123);
    expect(byRole(layout, 'eyebrow').y).toBeGreaterThanOrEqual(bottom(logoClearZone(layout.logo!)));
    expect(layout.art!.prompt).toBe('subtle sun-ray gradient in navy');
  });

  it('orders two blocks the model put at the same height, and a card keeps its logo and the title overhanging it', async () => {
    // Dev tier, brief_16: eyebrow and title both at y=588, the title overhanging its card by 17px,
    // and the logo in the card's corner — lifted to clear its zone, it used to straddle the edge.
    const { layout, qa } = await prepare(
      stored([1240, 1754, 62], { x: 992, y: 483, width: 186, height: 88 }, [
        [0, 'eyebrow', 87, 588, 1066, 53, 16, 1.3, 'Amiri'],
        [1, 'title', 87, 588, 1066, 175, 46, 1.25, 'Amiri'],
        [2, 'subtitle', 87, 772, 1066, 123, 24, 1.4, 'Amiri', '#0A1628'],
        [3, 'body', 87, 921, 1066, 228, 24, 1.5, 'Noto Sans Arabic', '#0A1628'],
        [4, 'footer', 87, 1219, 1066, 53, 14, 1.35, 'Noto Sans Arabic', '#0A1628'],
      ], [
        ['panel', 'rect', 62, 483, 1116, 263, '#1E3A5F'],
        ['rule', 'line', 62, 746, 1116, 4, '#C5A059'],
      ], '#FDF8F3'),
      copyOf('arabic', [
        'پەیماننامەی سەروەریی ئەکادیمی',
        'بەڵگەنامەی نیشتمانیی دڵنیایی جۆری',
        'بنەما سەرەکییەکانی پەروەردە و فێرکردن',
        'زانکۆ واژۆکارەکان پابەند دەبن بە ڕەچاوکردنی شەفافیەت، سەربەخۆیی زانستی، و پاراستنی مافی خوێندکاران.',
        'دەستەی باڵای متمانەبەخشین • شاری هەولێر • ٢٠٢٦',
      ])
    );
    const { logoClearZone } = await import('../src/index.js');
    // Geometry and the original mixed-font footer now have measured local evidence.
    expect(qa.passed, qa.messages.join('; ')).toBe(true);
    expect(qa.defectCodes).toEqual([]);
    expect(qa.textMeasurements.find((m) => m.copyIndex === 4)).toMatchObject({status: 'measured', method: 'pango-wrap-v1'});
    const eyebrow = byRole(layout, 'eyebrow');
    const title = byRole(layout, 'title');
    const card = layout.shapes.find((s) => s.role === 'panel')!;
    expect(title.y).toBeGreaterThanOrEqual(bottom(eyebrow));
    expect(bottom(card)).toBeGreaterThanOrEqual(bottom(title));
    expect(layout.logo!.y).toBeGreaterThanOrEqual(card.y);
    expect(eyebrow.y).toBeGreaterThanOrEqual(bottom(logoClearZone(layout.logo!)));
  });

  it('moves the block beside a column pushed under the logo level with it', async () => {
    // Dev tier, brief_17: a two-column banner whose square logo needed 154px where the model had
    // reserved a 76px band. The left column moved down; the body beside it stayed at the top and
    // read as coming before the title (semantic layout 1.0 -> 0.6).
    const { layout, qa } = await prepare(
      stored([1920, 1080, 96], { x: 134, y: 76, width: 576, height: 76 }, [
        [0, 'eyebrow', 134, 173, 595, 32, 13, 1.3, 'Cinzel', '#C5A059'],
        [1, 'title', 134, 227, 595, 130, 76, 1.2, 'Cinzel'],
        [2, 'subtitle', 134, 378, 595, 65, 22, 1.35, 'Playfair Display'],
        [3, 'body', 960, 216, 864, 216, 32, 1.5, 'Verdana', '#0A1628'],
        [4, 'footer', 96, 994, 1728, 43, 13, 1.35, 'Verdana', '#0A1628'],
      ], [
        ['panel', 'rect', 96, 54, 672, 972, '#1E3A5F'],
        ['rule', 'rect', 826, 54, 10, 972, '#C5A059'],
      ], '#FDF8F3'),
      SUMMIT
    );
    expect(qa.messages, qa.messages.join('\n')).toEqual([]);
    expect(measureDesignV3(layout, SUMMIT).metrics.semanticLayout.passed).toBe(true);
    expect(byRole(layout, 'title').y - byRole(layout, 'body').y).toBe(227 - 216);
  });

  it('raises what is above a block clamped onto the bottom margin instead of leaving them overlapping', async () => {
    // Dev tier, brief_20: the body and footer ran past the safe area. Pulled back inside it they
    // overlapped the blocks above them, and nothing below could move.
    const { layout, qa } = await prepare(
      stored([1920, 1080, 96], { x: 864, y: 54, width: 192, height: 54 }, [
        [0, 'eyebrow', 192, 648, 1536, 32, 14, 1.3, 'Amiri', '#C5A059'],
        [1, 'title', 192, 688, 1536, 103, 76, 1.3, 'Amiri'],
        [2, 'subtitle', 192, 805, 1536, 65, 22, 1.4, 'Amiri'],
        [3, 'body', 192, 869, 1536, 130, 32, 1.5, 'Noto Sans Arabic'],
        [4, 'footer', 192, 1015, 1536, 32, 13, 1.35, 'Noto Sans Arabic', '#C5A059'],
      ], [['panel', 'rect', 96, 594, 1728, 432, '#1E3A5F']], '#FDF8F3'),
      copyOf('arabic', [
        'پەیمانگەی نێودەوڵەتیی کوالیتی پەروەردە',
        'فۆڕمی نێودەوڵەتیی متمانەبەخشین',
        'پەرەپێدانی هاوبەشییە زانستییەکان',
        'بەشداریی شارەزایانی بیانی لە تاوتوێکردنی سیستەمی دڵنیایی جۆری زانکۆکانی هەرێمی کوردستان.',
        'هەولێر • تشرینی دووەمی ٢٠٢٦ • kaae.gov.krd',
      ])
    );
    // Geometry and the original mixed-font footer now have measured local evidence.
    expect(qa.passed, qa.messages.join('; ')).toBe(true);
    expect(qa.defectCodes).toEqual([]);
    expect(qa.textMeasurements.find((m) => m.copyIndex === 4)).toMatchObject({status: 'measured', method: 'pango-wrap-v1'});
    expect(layout.grid.margin).toBe(96);
    expect(byRole(layout, 'eyebrow').y).toBeLessThan(648);
  });

  it('never carries a logo in another column along with the band', async () => {
    // The title overlaps the eyebrow; space is inserted at the title, and the logo in the right
    // column starts inside that band. Moved, it would collide with nothing, so only the rule
    // keeps it: set in its own corner, it stays.
    const { layout, qa } = await prepare(
      stored([1920, 1080, 96], { x: 1670, y: 230, width: 154, height: 154 }, [
        [0, 'eyebrow', 96, 200, 900, 40, 18, 1.3, 'Cinzel', '#C5A059'],
        [1, 'title', 96, 220, 900, 130, 76, 1.2, 'Cinzel'],
        [2, 'subtitle', 96, 420, 900, 70, 26, 1.35, 'Playfair Display'],
        [3, 'body', 1100, 560, 724, 250, 32, 1.5, 'Verdana'],
        [4, 'footer', 96, 941, 1728, 43, 14, 1.35, 'Verdana'],
      ], []),
      SUMMIT
    );
    expect(qa.messages, qa.messages.join('\n')).toEqual([]);
    expect(layout.logo!.y).toBe(230);
    expect(byRole(layout, 'title').y).toBeGreaterThanOrEqual(bottom(byRole(layout, 'eyebrow')));
  });

  it('resolves a subtitle overlapping the title with the footer already on the bottom margin', async () => {
    // The layout the refinement test used as beyond preparation, until blocks could rise.
    const crowded = centred();
    crowded.text[2].y = 500;
    crowded.text[4].y = H - MARGIN - crowded.text[4].height;
    const { qa } = await prepare(crowded, { ...COPY, scripts: { 0: 'latin', 1: 'latin', 2: 'latin', 3: 'latin', 4: 'latin' } });
    expect(qa.messages, qa.messages.join('\n')).toEqual([]);
  });

  it('leaves a block above the logo that reaches into its clear space for refinement, named', async () => {
    // Cheap tier, run 2, brief_08: an eyebrow 27px above a card's logo and 68px into its clear
    // space, with the title below the logo. Raising the eyebrow passed QA with a 216px gap above the
    // title, which failed regularity: a QA pass bought with the rhythm, which the gate rejects.
    const { layout, qa } = await prepare(
      stored([1080, 1350, 64], { x: 64, y: 284, width: 108, height: 108 }, [
        [0, 'eyebrow', 162, 257, 756, 41, 16, 1.2, 'Amiri', '#F7B500'],
        [1, 'title', 162, 338, 756, 180, 44, 1.3, 'Amiri'],
        [2, 'subtitle', 162, 459, 756, 108, 24, 1.35, 'Amiri', '#F7B500'],
        [3, 'body', 108, 602, 864, 176, 23, 1.5, 'Noto Sans Arabic', '#1A1A1A'],
        [4, 'footer', 108, 928, 864, 54, 15, 1.35, 'Noto Sans Arabic', '#1A1A1A'],
      ], [
        ['panel', 'rect', 0, 189, 1080, 338, '#1E3A5F'],
        ['rule', 'line', 54, 579, 972, 3, '#C5A059'],
      ], '#FFFFFF'),
      copyOf('arabic', [
        'فەرمانگەی دڵنیایی جۆری و متمانەبەخشین',
        'کۆبوونەوەی باڵای سەرۆک زانکۆکان',
        'پەسەندکردنی ڕێسای نوێی خوێندنی ئەکادیمی',
        'گفتوگۆ لەسەر شێوازی تاقیکردنەوەکان، نوێکردنەوەی پڕۆگرامەکان و پەسەندکردنی بڕوانامە نێودەوڵەتییەکان.',
        'شاری سلێمانی • هۆڵی کۆنگرێس • کانوونی دووەمی ٢٠٢٦',
      ])
    );
    expect(qa.messages).toContain('OVERLAP: 1 overlapping pair(s): block 0 (eyebrow) and the logo');
    expect(byRole(layout, 'eyebrow').y).toBe(257);
    expect(layout.logo).toEqual({ x: 64, y: 284, width: 108, height: 108 });
  });

  it('leaves text set on the logo itself for refinement, and QA names what overlaps what', async () => {
    // Cheap tier, run 2, brief_03: eyebrow and title set across a centred logo. Clearing it would
    // take the eyebrow off the canvas — a new arrangement, which is refinement's job. QA used to
    // tell refinement "2 pair(s) of text boxes overlap", though no two text boxes did.
    const { qa } = await prepare(
      stored([1080, 1080, 64], { x: 459, y: 76, width: 162, height: 162 }, [
        [0, 'eyebrow', 108, 64, 864, 32, 14, 1.3, 'Amiri', '#1E3A5F'],
        [1, 'title', 108, 122, 864, 108, 41, 1.25, 'Amiri', '#1E3A5F'],
        [2, 'subtitle', 108, 256, 864, 63, 26, 1.4, 'Amiri'],
        [3, 'body', 108, 370, 864, 169, 18, 1.5, 'Noto Sans Arabic'],
        [4, 'footer', 108, 784, 864, 32, 14, 1.35, 'Noto Sans Arabic'],
      ], [
        ['panel', 'rect', 0, 54, 1080, 194, '#FDF8F3'],
        ['panel', 'rect', 0, 248, 1080, 832, '#1E3A5F'],
      ], '#FFFFFF'),
      copyOf('arabic', [
        'دەستەی باڵای متمانەبەخشین بە پەروەردە',
        'پێوەرە نیشتمانییەکانی کوالیتی خوێندن',
        'بەپێی یاسای ژمارە ٦ی ساڵی ٢٠٢٢',
        'پێویستە هەموو کۆلێژ و زانکۆکان ڕاپۆرتی بەراوردکاری متمانەبەخشین ئامادە بکەن.',
        'هەولێر • ئەنجومەنی باڵا • kaae.gov.krd',
      ])
    );
    expect(qa.messages).toContain(
      'OVERLAP: 2 overlapping pair(s): block 0 (eyebrow) and the logo; block 1 (title) and the logo'
    );
  });
});

describe('generated art names no lettering, marks or people', () => {
  it('cuts the phrase naming a banned word, and drops art that is nothing but', async () => {
    const { sanitizeArtPrompt, conformToHouseRules } = await import('../src/index.js');
    expect(sanitizeArtPrompt('subtle sun-ray motif behind hero text')).toBe('subtle sun-ray motif');
    expect(sanitizeArtPrompt('abstract geometric pattern, no text or letters')).toBe('abstract geometric pattern');
    expect(sanitizeArtPrompt('navy waves framing the logo area, gold dust')).toBe('navy waves, gold dust');
    expect(sanitizeArtPrompt('textured paper grain')).toBe('textured paper grain');
    expect(sanitizeArtPrompt('portrait of a graduate in cap and gown')).toBeNull();
    const layout = centred();
    (layout as any).art = { source: 'generated', prompt: 'portrait of a graduate', box: { x: 0, y: 0, width: W, height: 400 }, opacity: 0.2 };
    conformToHouseRules(layout, COPY);
    expect(layout.art).toBeUndefined();
  });
});

describe('text reads against the surface behind it', { timeout: 30000 }, () => {
  const KAAE_PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
  // The body, on a navy panel, set in the same navy: T5 brief_04 set every block this way.
  const navyOnNavy = () => {
    const layout = centred();
    layout.shapes = [{ ...panel(MARGIN, span(6)), color: '#1E3A5F' } as any];
    layout.text[3].color = '#1E3A5F';
    return layout;
  };

  it('fails QA for navy text on a navy panel, which production never checked', async () => {
    const { evaluateHardQa } = await import('../src/index.js');
    const qa = evaluateHardQa(navyOnNavy(), {
      width: W, height: H, copyScripts: ['latin', 'latin', 'latin', 'latin', 'latin'], latinFont: 'Verdana',
      arabicFont: 'Noto Sans Arabic', palette: [...KAAE_PALETTE, '#C5A059'], logoAspect: 200 / 120,
    });
    expect(qa.defectCodes).toContain('CONTRAST');
    expect(qa.messages.find((m) => m.startsWith('CONTRAST'))).toContain('block 3 (body) #1E3A5F on #1E3A5F');
  });

  it('recolours unreadable text in the brand colour the design already uses for text', async () => {
    const { conformToHouseRules, declaredTextContrast, requiredContrast } = await import('../src/index.js');
    const layout = conformToHouseRules(navyOnNavy(), COPY, KAAE_PALETTE);
    for (const t of layout.text) expect(declaredTextContrast(layout, t)).toBeGreaterThanOrEqual(requiredContrast(t.fontSize, t.bold === true));
    expect(layout.text[3].color).toBe('#FDF8F3');
  });
});

describe('copy fits its box', { timeout: 30000 }, () => {
  const qaContext = {
    width: W, height: H, copyScripts: ['latin', 'latin', 'latin', 'latin', 'latin'] as Array<'latin' | 'arabic'>,
    latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic', palette: ['#0A1628', '#FDF8F3', '#C5A059', '#162B48'], logoAspect: 200 / 120,
  };
  // The 72px title wraps to two lines and needs about 195px; the renderer centres the lines, so they
  // would spill onto the eyebrow and subtitle.
  const overflowing = () => {
    const layout = centred();
    layout.text[1].height = 60;
    return layout;
  };

  it('fails QA when a block wraps taller than its box, and does not guess without the copy', async () => {
    const { evaluateHardQa } = await import('../src/index.js');
    const qa = evaluateHardQa(overflowing(), { ...qaContext, copyText: COPY.text });
    expect(qa.defectCodes).toContain('COPY_OVERFLOW');
    expect(qa.messages.find((m) => m.startsWith('COPY_OVERFLOW'))).toContain('block 1 (title) wraps to 2 line(s)');
    expect(evaluateHardQa(overflowing(), qaContext).defectCodes).not.toContain('COPY_OVERFLOW');
  });

  it('checks it when ranking, from the copy the pipeline already has', async () => {
    const { rankCandidatesV3 } = await import('../src/index.js');
    const [ranked] = rankCandidatesV3([{ sourceIndex: 0, layout: overflowing() }], COPY, qaContext);
    expect(ranked.hardQa?.defectCodes).toContain('COPY_OVERFLOW');
  });
});

describe('pipeline v3 — brief-bound challenger behind its flag (ADR-124)', { timeout: 30000 }, () => {
  const BRIEF = {
    instructions: 'Formal notice for university leadership; the deadline must be unmistakable.',
    audience: 'university leadership',
    copy: Object.entries(COPY.text).map(([i, text]) => ({ copyIndex: Number(i), text })),
  };
  const pair = () => {
    const a = centred();
    const b = asymmetric();
    const render = (layout: StudioLayoutV2) => b64(renderLayoutV2(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png);
    const names: Record<string, string> = {
      [render(a)]: 'centred', [render(b)]: 'asymmetric',
      [render(createDegradedCanaryLayout(a))]: 'degraded', [render(createDegradedCanaryLayout(b))]: 'degraded',
    };
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: a }, { sourceIndex: 1, layout: b }], COPY);
    ranked.forEach(admitForJudgeFixture);
    return { names, ranked };
  };
  const dims = (c: string, m: string, a: string) => ({
    correctness: { choice: c, reason: 'r' }, communication: { choice: m, reason: 'r' }, aesthetic: { choice: a, reason: 'r' },
  });
  /** Answers the challenger schema only; any incumbent call fails the test. */
  function challengerClient(names: Record<string, string>, answer: (left: string, right: string) => ReturnType<typeof dims>) {
    const calls: Array<{ schema: string; left: string; right: string; user: string; detail: string[] }> = [];
    const client = {
      async createStructuredCompletion(params: any) {
        const content = params.messages[1].content as any[];
        const images = content.filter((c) => c.type === 'image_url').map((c) => c.image_url);
        const [left, right] = images.map((i: any) => names[i.url] ?? 'unknown');
        calls.push({ schema: params.jsonSchema.name, left, right, user: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
          detail: images.map((i: any) => i.detail) });
        if (params.jsonSchema.name !== 'BriefBoundDimensionVerdict') throw new Error(`unexpected schema ${params.jsonSchema.name}`);
        const data = { dimensions: answer(left, right), findings: [] };
        return { data, rawText: JSON.stringify(data), receipt: { id: 'r', responseId: `resp_${calls.length}`, xRequestId: null,
          model: params.model, inputTokens: 1000, outputTokens: 100, reasoningTokens: 0, cacheCreationTokens: 0,
          cacheReadTokens: 0, costUsd: 0.002, sha256: '', latencyMs: 5, attempts: 1 } };
      },
    };
    return { client: client as any, calls };
  }

  it('keeps the incumbent judge unless the challenger is selected', async () => {
    const { names, ranked } = pair();
    const { client, calls } = mockClient({ names, prefer: () => 'A' });
    const result = await selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO } });
    expect(result.protocol).toBe('incumbent');
    expect(calls.every((c) => c.schema === 'PairwiseDimensionVerdict')).toBe(true);
  });

  it('adopts a stable brief-bound pick that also beats the degraded canary', async () => {
    const { names, ranked } = pair();
    const secondName = ranked[1].sourceIndex === 0 ? 'centred' : 'asymmetric';
    const { client, calls } = challengerClient(names, (left, right) => {
      if (left === 'degraded') return dims('B', 'B', 'B');
      if (right === 'degraded') return dims('A', 'A', 'A');
      return left === secondName ? dims('tie', 'A', 'tie') : dims('tie', 'B', 'tie');
    });
    const result = await selectWinnerV3(ranked, COPY, {
      client, renderOptions: { logoDataUri: KAAE_TEST_LOGO }, judgeProtocol: 'brief_bound_v1', judgeBrief: BRIEF,
    });
    expect(result).toMatchObject({ protocol: 'brief_bound_v1', decidedBy: 'judge', judgeReliable: true, humanChoiceRecommended: false });
    expect(result.winner.sourceIndex).toBe(ranked[1].sourceIndex);
    expect(result.match).toBeNull();
    expect(result.briefBound?.match.decision.decidedBy).toBe('communication');
    expect(result.briefBound?.canaryPassed).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.user.includes(COPY.text[3]) && c.detail.every((d) => d === 'high'))).toBe(true);
  });

  it('keeps the higher composite and asks for a human choice when the challenger is uncertain', async () => {
    const { names, ranked } = pair();
    const { client } = challengerClient(names, (left, right) =>
      left === 'degraded' ? dims('B', 'B', 'B') : right === 'degraded' ? dims('A', 'A', 'A') : dims('tie', 'tie', 'tie'));
    const result = await selectWinnerV3(ranked, COPY, {
      client, renderOptions: { logoDataUri: KAAE_TEST_LOGO }, judgeProtocol: 'brief_bound_v1', judgeBrief: BRIEF,
    });
    expect(result).toMatchObject({ decidedBy: 'composite_judge_uncertain', humanChoiceRecommended: true, judgeReliable: true });
    expect(result.winner.sourceIndex).toBe(ranked[0].sourceIndex);
  });

  it('overrules a challenger that cannot prefer its pick over a degraded copy', async () => {
    const { names, ranked } = pair();
    const secondName = ranked[1].sourceIndex === 0 ? 'centred' : 'asymmetric';
    const { client } = challengerClient(names, (left, right) =>
      left === 'degraded' || right === 'degraded' ? dims('tie', 'tie', 'tie') : left === secondName ? dims('A', 'A', 'A') : dims('B', 'B', 'B'));
    const result = await selectWinnerV3(ranked, COPY, {
      client, renderOptions: { logoDataUri: KAAE_TEST_LOGO }, judgeProtocol: 'brief_bound_v1', judgeBrief: BRIEF,
    });
    expect(result).toMatchObject({ decidedBy: 'composite_judge_unreliable', judgeReliable: false, humanChoiceRecommended: true });
    expect(result.winner.sourceIndex).toBe(ranked[0].sourceIndex);
  });

  it('does not trust a pick it could not test, and spends nothing, when the degraded canary renders identically', async () => {
    // createDegradedCanaryLayout degrades only title and body roles; without them the canary is the same image.
    const { names, ranked } = pair();
    for (const r of ranked) r.layout = { ...r.layout, text: r.layout.text.map((t) => ({ ...t, role: 'other' as const })) };
    const renderOf = (layout: StudioLayoutV2) => renderLayoutV2(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: COPY.text }).png;
    expect(renderOf(createDegradedCanaryLayout(ranked[0].layout)).equals(renderOf(ranked[0].layout))).toBe(true);
    for (const r of ranked) {
      const name = r.sourceIndex === ranked[1].sourceIndex ? 'second' : 'first';
      names[b64(renderOf(r.layout))] = name;
      if (r.renderedPng) names[b64(r.renderedPng)] = name;
    }
    const { client, calls } = challengerClient(names, (left) => (left === 'second' ? dims('A', 'A', 'A') : dims('B', 'B', 'B')));
    const result = await selectWinnerV3(ranked, COPY, {
      client, renderOptions: { logoDataUri: KAAE_TEST_LOGO }, judgeProtocol: 'brief_bound_v1', judgeBrief: BRIEF,
    });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ protocol: 'brief_bound_v1', decidedBy: 'composite_judge_uncertain', judgeReliable: null,
      humanChoiceRecommended: true });
    expect(result.winner.sourceIndex).toBe(ranked[0].sourceIndex);
    expect(result.briefBound).toMatchObject({ canaryPassed: null, canaryMatch: null, canaryUnavailable: 'degraded_canary_identical_bytes' });
    expect(result.briefBound?.match.decision.winner).toBe('second');
  });

  it('refuses the challenger without the actual brief, before any call', async () => {
    const { names, ranked } = pair();
    const { client, calls } = challengerClient(names, () => dims('tie', 'tie', 'tie'));
    await expect(selectWinnerV3(ranked, COPY, { client, renderOptions: { logoDataUri: KAAE_TEST_LOGO }, judgeProtocol: 'brief_bound_v1' }))
      .rejects.toThrow(/brief/);
    expect(calls).toHaveLength(0);
  });
});
