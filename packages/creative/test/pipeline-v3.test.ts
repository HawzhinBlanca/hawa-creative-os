import { describe, it, expect } from 'vitest';
import {
  admittedFontFor,
  sanitizeFontsV3,
  measureDesignV3,
  rankCandidatesV3,
  selectWinnerV3,
  refineCandidateV3,
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
describe('pipeline v3 — winner selection', { timeout: 30000 }, () => {
  const named = () => {
    const a = centred();
    const b = asymmetric();
    const names: Record<string, string> = {
      [b64(renderLayoutV2(a, { copyText: COPY.text }).png)]: 'centred',
      [b64(renderLayoutV2(b, { copyText: COPY.text }).png)]: 'asymmetric',
      [b64(renderLayoutV2(createDegradedCanaryLayout(a), { copyText: COPY.text }).png)]: 'degraded',
      [b64(renderLayoutV2(createDegradedCanaryLayout(b), { copyText: COPY.text }).png)]: 'degraded',
    };
    const ranked = rankCandidatesV3(
      [
        { sourceIndex: 0, layout: a },
        { sourceIndex: 1, layout: b },
      ],
      COPY
    );
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

    const result = await selectWinnerV3(ranked, COPY, { client });
    expect(result.decidedBy).toBe('judge');
    expect(result.winner.sourceIndex).toBe(second.sourceIndex);
    expect(result.judgeReliable).toBe(true);
    expect(result.canary?.passed).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('keeps the higher composite when the judge only ever picks a position', async () => {
    const { names, ranked } = named();
    const { client } = mockClient({ names, prefer: () => 'A' });

    const result = await selectWinnerV3(ranked, COPY, { client });
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

    const result = await selectWinnerV3(ranked, COPY, { client });
    expect(result.decidedBy).toBe('composite_judge_unreliable');
    expect(result.winner.sourceIndex).toBe(ranked[0].sourceIndex);
    expect(result.judgeReliable).toBe(false);
  });

  it('shows the judge the real copy, never placeholder text', async () => {
    const { names, ranked } = named();
    const { client, calls } = mockClient({ names, prefer: () => 'A' });
    await selectWinnerV3(ranked, COPY, { client });

    const placeholder = b64(renderLayoutV2(ranked[0].layout).png);
    const seen = calls.flatMap((c) => c.images);
    expect(seen.length).toBe(8);
    expect(seen).not.toContain(placeholder);
    expect(seen.every((url) => names[url] !== undefined)).toBe(true);
  });

  it('spends nothing when only one candidate is left', async () => {
    const { client, calls } = mockClient({});
    const ranked = rankCandidatesV3([{ sourceIndex: 0, layout: centred() }], COPY);
    const result = await selectWinnerV3(ranked, COPY, { client });
    expect(result.decidedBy).toBe('single_candidate');
    expect(calls).toHaveLength(0);
  });
});

// Render-heavy: each rsvg render takes 0.2-0.5s, so the 5s default is too tight under load.
describe('pipeline v3 — refinement', { timeout: 30000 }, () => {
  it('spends nothing on a candidate that already passes the gate', async () => {
    const { client, calls } = mockClient({});
    const [top] = rankCandidatesV3([{ sourceIndex: 0, layout: centred() }], COPY);
    const outcome = await refineCandidateV3(top, COPY, { client });
    expect(outcome.reason).toBe('gate_passed');
    expect(outcome.adopted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refines a failing candidate with the critic seeing the real copy, and adopts a passing repair', async () => {
    const failing = broken();
    const { client, calls } = mockClient({ repairLayout: centred() });
    const [top] = rankCandidatesV3([{ sourceIndex: 3, layout: failing }], COPY);
    expect(top.metrics.passed).toBe(false);

    const outcome = await refineCandidateV3(top, COPY, { client });
    expect(outcome.adopted).toBe(true);
    expect(outcome.reason).toBe('adopted_now_passes');
    expect(outcome.metrics.passed).toBe(true);
    expect(outcome.metrics.compositeScore).toBe(measureDesignV3(outcome.layout, COPY).compositeScore);

    // The critic was shown the design with its copy, not "Sample copy block N".
    const critiqueCall = calls.find((c) => c.schema === 'DesignCritiqueReport');
    expect(critiqueCall?.images[0]).toBe(b64(renderAnnotatedLayoutV2(failing, { copyText: COPY.text }).png));

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
    // The subtitle overlaps the title, and the footer already sits on the bottom margin, so there is
    // no room to insert space: preparation cannot fix it, and QA rejects it.
    const crowded = centred();
    crowded.text[2].y = 500;
    crowded.text[4].y = H - MARGIN - crowded.text[4].height;
    const [top] = rankCandidatesV3([{ sourceIndex: 0, layout: prepareGeneratedLayoutV3(crowded, COPY, canvas) }], COPY, qa);
    expect(top.hardQa?.passed).toBe(false);
    expect(top.hardQa?.defectCodes).toContain('OVERLAP');

    const prompts: string[] = [];
    const { client } = mockClient({ repairLayout: centred() });
    const spying = {
      createStructuredCompletion: async (params: any) => {
        if (params.jsonSchema?.name === 'layout_v3_repair') prompts.push(String(params.messages[1].content));
        return (client as any).createStructuredCompletion(params);
      },
    } as unknown as OpenAiStudioClient;
    const outcome = await refineCandidateV3(top, COPY, { client: spying, qa, canvas });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('HARD QA DEFECTS');
    expect(prompts[0]).toContain('OVERLAP');
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
