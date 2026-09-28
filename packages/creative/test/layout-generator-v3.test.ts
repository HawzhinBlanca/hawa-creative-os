import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { layoutConditioningImage } from '../src/studio/visual-conditioning.js';
import { svgToPngAsync } from '../src/studio/render-layout-v2.js';
import { imagePixelSize } from '../src/studio/photo-crop.js';
import {
  computeCapacitySlot,
  verifySlotCapacity,
  scaleNormalizedLayoutToV2,
  hasTwinCardBlock,
  LAYOUT_V3_JSON_SCHEMA,
  type NormalizedLayoutCandidate,
  type CopyBlockSlotInput,
  generateLayoutCandidatesV3,
  buildLayoutV3UserPrompt,
} from '../src/studio/layout-generator-v3.js';
import { studioLayoutV2Schema, type StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { checkCandidateSetDegeneracy, evaluateDesignMetrics } from '../src/studio/design-metrics.js';

describe('complete layout conditioning', () => {
  it('bounds conditioning image dimensions while retaining the original asset identity', async () => {
    const source = await svgToPngAsync('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#984423"/></svg>', 1200, 800);
    const image = await layoutConditioningImage(source);
    expect(image.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(imagePixelSize(Buffer.from(image.dataUrl.split(',')[1], 'base64'))).toEqual({ width: 768, height: 512 });
  });
  it('keeps long copy tails and exact punctuation with noncontiguous copy identities', () => {
    const text = `${'Full approved copy '.repeat(12)} — \"کۆتایی\"\nTail 2030`;
    const prompt = buildLayoutV3UserPrompt({ brief: 'Brief', copyBlocks: [{ index: 9, text, role: 'body', script: 'arabic' }],
      palette: ['#000000'], canvasWidth: 1080, canvasHeight: 1350 });
    expect(prompt).toContain(JSON.stringify(text));
    expect(prompt).toContain('Block 9');
  });

  it('sends actual approved examples and photos while leaving the client reference last', async () => {
    const createStructuredCompletion = vi.fn().mockRejectedValue(new Error('intercepted'));
    await expect(generateLayoutCandidatesV3({
      client: { createStructuredCompletion } as unknown as Parameters<typeof generateLayoutCandidatesV3>[0]['client'],
      brief: 'Brief', copyBlocks: [], palette: ['#000000'],
      visualInputs: [
        { kind: 'approved_example', label: 'Approved', sourceSha256: 'a', dataUrl: 'data:image/png;base64,YQ==' },
        { kind: 'content_photo', label: 'Photo 0', notes: 'Speaker faces left', sourceSha256: 'b', dataUrl: 'data:image/png;base64,Yg==' },
      ], reference: { dataUrl: 'data:image/png;base64,Yw==', notes: 'Client direction' },
    })).rejects.toThrow('intercepted');
    const content = createStructuredCompletion.mock.calls[0][0].messages[1].content;
    expect(content.filter((part: { type: string }) => part.type === 'image_url').map((part: { image_url: { url: string } }) => part.image_url.url))
      .toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==', 'data:image/png;base64,Yw==']);
    expect(JSON.stringify(content)).toContain('Speaker faces left');
    expect(JSON.stringify(content)).toContain('untrusted');
  });
});

describe('P03 — Layout-First Candidate Generation (PosterLLaVa & PosterMELD)', () => {
  it('drops same-geometry candidates even when the model gives them different archetype names', async () => {
    const base: NormalizedLayoutCandidate = {
      id: 'one', conceptTitle: 'First', compositionArchetype: 'monolith_centered',
      typeScale: { base: 14, ratio: 1.25 },
      grid: { margin: 0.07, columns: 6, gutter: 0.02, baseline: 0.01 },
      background: { color: '#0A1628' },
      logo: { x: 0.4, y: 0.06, width: 0.2, height: 0.08 },
      art: null, shapes: [],
      text: [{ copyIndex: 0, role: 'title', x: 0.1, y: 0.3, width: 0.8, height: 0.12,
        fontSize: 0.04, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Verdana',
        color: '#FFFFFF', align: 'center', bold: true, italic: false, rtl: false }],
    };
    const twin = { ...base, id: 'two', conceptTitle: 'Second', compositionArchetype: 'minimal_framed' as const,
      background: { color: '#FFFFFF' } };
    const different = { ...base, id: 'three', conceptTitle: 'Third', compositionArchetype: 'asymmetric_editorial' as const,
      logo: { ...base.logo, x: 0.08 }, text: [{ ...base.text[0], x: 0.25, width: 0.65 }] };
    const createStructuredCompletion = vi.fn().mockResolvedValue({
      data: { layouts: [base, twin, different] },
      receipt: { responseId: 'r13', xRequestId: null, inputTokens: 1, outputTokens: 1,
        cacheReadTokens: 0, costUsd: 0, latencyMs: 1 },
    });
    const result = await generateLayoutCandidatesV3({
      client: { createStructuredCompletion } as any,
      brief: 'One approved title', copyBlocks: [{ index: 0, text: 'Approved title', role: 'title', script: 'latin' }],
      palette: ['#0A1628', '#FFFFFF'], canvasWidth: 1080, canvasHeight: 1350,
    });
    expect(createStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(result.rawCandidates.map((candidate) => candidate.id)).toEqual(['one', 'three']);
    expect(result.layouts).toHaveLength(2);
    expect(result.degeneracyCheck.isDegenerate).toBe(false);
  });

  it('refuses a candidate set that collapses to one composition', async () => {
    const first: NormalizedLayoutCandidate = {
      id: 'one', conceptTitle: 'One', compositionArchetype: 'monolith_centered',
      typeScale: { base: 14, ratio: 1.25 },
      grid: { margin: 0.07, columns: 6, gutter: 0.02, baseline: 0.01 },
      background: { color: '#0A1628' }, logo: { x: 0.4, y: 0.06, width: 0.2, height: 0.08 },
      art: null, shapes: [], text: [{ copyIndex: 0, role: 'title', x: 0.1, y: 0.3, width: 0.8, height: 0.12,
        fontSize: 0.04, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Verdana', color: '#FFFFFF',
        align: 'center', bold: true, italic: false, rtl: false }],
    };
    const client = { createStructuredCompletion: vi.fn().mockResolvedValue({
      data: { layouts: [first, { ...first, id: 'two' }, { ...first, id: 'three' }] }, receipt: {},
    }) } as any;
    await expect(generateLayoutCandidatesV3({ client, brief: 'Title',
      copyBlocks: [{ index: 0, text: 'Title', role: 'title', script: 'latin' }],
      palette: ['#0A1628', '#FFFFFF'], canvasWidth: 1080, canvasHeight: 1350,
    })).rejects.toThrow('at least 2 are required');
  });

  const sampleCopyBlocks: CopyBlockSlotInput[] = [
    {
      index: 0,
      text: 'Advancing Academic Rigor & Institutional Quality',
      role: 'title',
      script: 'latin',
    },
    {
      index: 1,
      text: 'Statutory Standards & Accreditation Benchmarks',
      role: 'subtitle',
      script: 'latin',
    },
    {
      index: 2,
      text: 'The Kurdistan Accrediting Agency for Education establishes rigorous benchmarks for higher education institutions across the Kurdistan Region, ensuring world-class academic excellence.',
      role: 'body',
      script: 'latin',
    },
    {
      index: 3,
      text: 'Law No. 6 of 2022 • kaae.gov.krd',
      role: 'footer',
      script: 'latin',
    },
  ];

  it('computes capacity-aware slot guidance without overflow', () => {
    const slots = sampleCopyBlocks.map((b) => computeCapacitySlot(b, 1080, 1350));
    expect(slots.length).toBe(4);

    // Title slot
    expect(slots[0].role).toBe('title');
    expect(slots[0].charCount).toBe(48);
    expect(slots[0].targetCapacityMax).toBeGreaterThanOrEqual(48);
    expect(slots[0].recommendedNormFontSize[0]).toBeGreaterThan(0.02);

    // Body slot
    expect(slots[2].role).toBe('body');
    expect(slots[2].charCount).toBe(183);
    expect(slots[2].targetCapacityMax).toBeGreaterThanOrEqual(183);
    expect(slots[2].recommendedNormHeight[1]).toBeGreaterThanOrEqual(0.12);
  });

  it('validates LAYOUT_V3_JSON_SCHEMA contains NO $defs or $ref, and has additionalProperties: false', () => {
    const schemaStr = JSON.stringify(LAYOUT_V3_JSON_SCHEMA);
    expect(schemaStr).not.toContain('$defs');
    expect(schemaStr).not.toContain('$ref');

    // Recursively check all objects have additionalProperties: false
    function checkAdditionalProps(obj: any) {
      if (typeof obj !== 'object' || obj === null) return;
      if (obj.type === 'object') {
        expect(obj.additionalProperties).toBe(false);
        if (obj.properties) {
          const propKeys = Object.keys(obj.properties);
          expect(obj.required).toBeDefined();
          for (const key of propKeys) {
            expect(obj.required).toContain(key);
          }
        }
      }
      for (const val of Object.values(obj)) {
        checkAdditionalProps(val);
      }
    }

    checkAdditionalProps(LAYOUT_V3_JSON_SCHEMA);
  });

  it('scales normalized [0..1] candidate layout to valid StudioLayoutV2 conforming to schema', () => {
    const normCandidate: NormalizedLayoutCandidate = {
      id: 'cand-1',
      conceptTitle: 'Monolith Centered Academic Standards',
      compositionArchetype: 'monolith_centered',
      typeScale: { base: 14, ratio: 1.25 },
      grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: '#0A1628' },
      logo: { x: 0.407, y: 0.059, width: 0.185, height: 0.074 },
      art: {
        source: 'generated',
        prompt: 'Subtle geometric guilloche watermark',
        motif: 'guilloche',
        box: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 0.25,
        calmRegion: { x: 0.074, y: 0.15, width: 0.852, height: 0.75 },
      },
      shapes: [
        {
          x: 0.074,
          y: 0.28,
          width: 0.852,
          height: 0.0015,
          kind: 'line',
          color: '#C5A059',
          opacity: 1,
          radius: null,
          strokeWidth: null,
          strokeColor: null,
          role: 'rule',
        },
      ],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 0.074,
          y: 0.16,
          width: 0.852,
          height: 0.09,
          fontSize: 0.031, // ~42px
          lineHeight: 1.3,
          letterSpacing: null,
          fontFamily: 'Cinzel',
          color: '#C5A059',
          align: 'center',
          bold: true,
          italic: false,
          rtl: false,
        },
        {
          copyIndex: 1,
          role: 'subtitle',
          x: 0.111,
          y: 0.31,
          width: 0.778,
          height: 0.05,
          fontSize: 0.016, // ~22px
          lineHeight: 1.4,
          letterSpacing: null,
          fontFamily: 'Verdana',
          color: '#FDF8F3',
          align: 'center',
          bold: false,
          italic: false,
          rtl: false,
        },
        {
          copyIndex: 2,
          role: 'body',
          x: 0.092,
          y: 0.40,
          width: 0.816,
          height: 0.38,
          fontSize: 0.013, // ~18px
          lineHeight: 1.5,
          letterSpacing: null,
          fontFamily: 'Verdana',
          color: '#FDF8F3',
          align: 'center',
          bold: false,
          italic: false,
          rtl: false,
        },
        {
          copyIndex: 3,
          role: 'footer',
          x: 0.074,
          y: 0.90,
          width: 0.852,
          height: 0.035,
          fontSize: 0.009, // ~12px
          lineHeight: 1.4,
          letterSpacing: null,
          fontFamily: 'Verdana',
          color: '#C5A059',
          align: 'center',
          bold: false,
          italic: false,
          rtl: false,
        },
      ],
    };

    const scaled = scaleNormalizedLayoutToV2(normCandidate, 1080, 1350);

    // Verify StudioLayoutV2 schema
    const parseRes = studioLayoutV2Schema.safeParse(scaled);
    expect(parseRes.success).toBe(true);

    // Verify coordinates scaled properly
    expect(scaled.width).toBe(1080);
    expect(scaled.height).toBe(1350);
    expect(scaled.grid.margin).toBe(80); // Math.round(0.074 * 1080) = 80
    expect(scaled.logo.x).toBe(440);
    expect(scaled.text[0].fontSize).toBe(42); // Math.round(0.031 * 1350) = 42
    expect(scaled.text[0].fontFamily).toBe('Cinzel');
    expect(scaled.text[2].fontFamily).toBe('Verdana');

    // Verify design metrics pass
    const metrics = evaluateDesignMetrics(scaled);
    expect(metrics.passed).toBe(true);
    expect(metrics.compositeScore).toBeGreaterThanOrEqual(0.80);

    // Verify slot capacity
    const capCheck = verifySlotCapacity(scaled, sampleCopyBlocks);
    expect(capCheck.ok).toBe(true);
  });

  it('detects twin-card bilateral layout correctly', () => {
    const twinCardLayout: NormalizedLayoutCandidate = {
      id: 'twin-1',
      conceptTitle: 'Bilateral Twin Card Defect',
      compositionArchetype: 'monolith_centered',
      typeScale: { base: 14, ratio: 1.25 },
      grid: { margin: 0.065, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: '#0A1628' },
      logo: { x: 0.45, y: 0.05, width: 0.1, height: 0.08 },
      art: null,
      shapes: [
        {
          x: 0.06,
          y: 0.42,
          width: 0.41,
          height: 0.28,
          kind: 'roundRect',
          color: '#1E3A5F',
          opacity: 1,
          radius: 0.01,
          strokeWidth: null,
          strokeColor: null,
          role: 'panel',
        },
        {
          x: 0.52,
          y: 0.42,
          width: 0.41,
          height: 0.28,
          kind: 'roundRect',
          color: '#1E3A5F',
          opacity: 1,
          radius: 0.01,
          strokeWidth: null,
          strokeColor: null,
          role: 'panel',
        },
      ],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 0.065,
          y: 0.18,
          width: 0.87,
          height: 0.1,
          fontSize: 0.03,
          lineHeight: 1.3,
          letterSpacing: null,
          fontFamily: 'Lora',
          color: '#C5A059',
          align: 'center',
          bold: true,
          italic: false,
          rtl: false,
        },
      ],
    };

    const scaled = scaleNormalizedLayoutToV2(twinCardLayout, 1080, 1350);
    expect(hasTwinCardBlock(scaled)).toBe(true);
  });

  it('detects capacity overflow when text significantly exceeds box dimensions', () => {
    const overflowCandidate: NormalizedLayoutCandidate = {
      id: 'overflow-1',
      conceptTitle: 'Tiny Box Overflow',
      compositionArchetype: 'monolith_centered',
      typeScale: { base: 14, ratio: 1.25 },
      grid: { margin: 0.065, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: '#0A1628' },
      logo: { x: 0.45, y: 0.05, width: 0.1, height: 0.08 },
      art: null,
      shapes: [],
      text: [
        {
          copyIndex: 2, // 168 characters
          role: 'body',
          x: 0.1,
          y: 0.4,
          width: 0.2, // Tiny 216px width
          height: 0.03, // Tiny 40px height
          fontSize: 0.02, // 27px font
          lineHeight: 1.4,
          letterSpacing: null,
          fontFamily: 'Verdana',
          color: '#FDF8F3',
          align: 'left',
          bold: false,
          italic: false,
          rtl: false,
        },
      ],
    };

    const scaled = scaleNormalizedLayoutToV2(overflowCandidate, 1080, 1350);
    const capCheck = verifySlotCapacity(scaled, sampleCopyBlocks);
    expect(capCheck.ok).toBe(false);
    expect(capCheck.overflowIssues.some((s) => s.includes('overflow'))).toBe(true);
  });

  it('measures capacity in the box\'s own face, so a title box a little under one line is not "~1 chars"', () => {
    // Every run logged "capacity is only ~1 chars" for title boxes a little shorter than one line:
    // the estimate floored their lines to none. This copy fits one line, and preparation grows the box.
    const layout = {
      version: 2,
      width: 1080,
      height: 1350,
      genre: 'poster',
      grid: { margin: 80, columns: 6, gutter: 24, baseline: 8 },
      background: { color: '#0A1628' },
      logo: { x: 490, y: 80, width: 100, height: 100 },
      text: [
        {
          copyIndex: 0, role: 'title', x: 90, y: 300, width: 900, height: 50, fontSize: 48, lineHeight: 1.2,
          letterSpacing: null, fontFamily: 'Cinzel', color: '#FDF8F3', align: 'center', bold: true, italic: false, rtl: false,
        },
      ],
      shapes: [],
    } as unknown as StudioLayoutV2;
    const title = (text: string): CopyBlockSlotInput[] => [{ index: 0, text, role: 'title', script: 'latin' }];
    expect(verifySlotCapacity(layout, title('Annual Symposium'))).toEqual({ ok: true, overflowIssues: [] });

    // Copy that needs far more than its box is still reported, in lines and pixels.
    const narrow = { ...layout, text: [{ ...layout.text[0], width: 300 }] } as StudioLayoutV2;
    const { overflowIssues } = verifySlotCapacity(narrow, title('Kurdistan Chancellor Summit 2026'));
    expect(overflowIssues).toHaveLength(1);
    expect(overflowIssues[0]).toMatch(
      /^Slot overflow on copyIndex 0 \(title\): its copy wraps to \d+ line\(s\) needing \d+px; the box is 50px tall$/
    );
  });

  it('confirms 3 distinct layout archetypes pass degeneracy check with geometric distance > 15px', () => {
    // Archetype 1: Monolith Centered
    const l1: NormalizedLayoutCandidate = {
      id: 'c1',
      conceptTitle: 'Monolith Centered',
      compositionArchetype: 'monolith_centered',
      typeScale: { base: 14, ratio: 1.25 },
      grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: '#0A1628' },
      logo: { x: 0.407, y: 0.059, width: 0.185, height: 0.074 },
      art: null,
      shapes: [],
      text: [
        { copyIndex: 0, role: 'title', x: 0.074, y: 0.16, width: 0.852, height: 0.09, fontSize: 0.031, lineHeight: 1.3, letterSpacing: null, fontFamily: 'Cinzel', color: '#C5A059', align: 'center', bold: true, italic: false, rtl: false },
        { copyIndex: 1, role: 'body', x: 0.092, y: 0.40, width: 0.816, height: 0.18, fontSize: 0.013, lineHeight: 1.5, letterSpacing: null, fontFamily: 'Verdana', color: '#FDF8F3', align: 'center', bold: false, italic: false, rtl: false },
      ],
    };

    // Archetype 2: Asymmetric Editorial
    const l2: NormalizedLayoutCandidate = {
      id: 'c2',
      conceptTitle: 'Asymmetric Editorial',
      compositionArchetype: 'asymmetric_editorial',
      typeScale: { base: 16, ratio: 1.333 },
      grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: '#0C2340' },
      logo: { x: 0.074, y: 0.059, width: 0.185, height: 0.074 },
      art: null,
      shapes: [
        { x: 0.074, y: 0.15, width: 0.002, height: 0.75, kind: 'line', color: '#C5A059', opacity: 1, radius: null, strokeWidth: null, strokeColor: null, role: 'rule' },
      ],
      text: [
        { copyIndex: 0, role: 'title', x: 0.111, y: 0.18, width: 0.815, height: 0.12, fontSize: 0.035, lineHeight: 1.25, letterSpacing: null, fontFamily: 'Lora', color: '#C5A059', align: 'left', bold: true, italic: false, rtl: false },
        { copyIndex: 1, role: 'body', x: 0.111, y: 0.45, width: 0.750, height: 0.20, fontSize: 0.014, lineHeight: 1.5, letterSpacing: null, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: false, italic: false, rtl: false },
      ],
    };

    // Archetype 3: Hero Statement Grid
    const l3: NormalizedLayoutCandidate = {
      id: 'c3',
      conceptTitle: 'Hero Statement Grid',
      compositionArchetype: 'hero_statement_grid',
      typeScale: { base: 15, ratio: 1.414 },
      grid: { margin: 0.074, columns: 12, gutter: 0.018, baseline: 0.006 },
      background: { color: '#0A1628' },
      logo: { x: 0.407, y: 0.059, width: 0.185, height: 0.074 },
      art: null,
      shapes: [
        { x: 0.074, y: 0.48, width: 0.852, height: 0.38, kind: 'roundRect', color: '#1E3A5F', opacity: 0.8, radius: 0.015, strokeWidth: null, strokeColor: null, role: 'panel' },
      ],
      text: [
        { copyIndex: 0, role: 'title', x: 0.074, y: 0.18, width: 0.852, height: 0.14, fontSize: 0.038, lineHeight: 1.2, letterSpacing: null, fontFamily: 'Cinzel', color: '#F7B500', align: 'center', bold: true, italic: false, rtl: false },
        { copyIndex: 1, role: 'body', x: 0.111, y: 0.52, width: 0.778, height: 0.25, fontSize: 0.014, lineHeight: 1.5, letterSpacing: null, fontFamily: 'Verdana', color: '#FDF8F3', align: 'left', bold: false, italic: false, rtl: false },
      ],
    };

    const scaledSet = [
      scaleNormalizedLayoutToV2(l1, 1080, 1350),
      scaleNormalizedLayoutToV2(l2, 1080, 1350),
      scaleNormalizedLayoutToV2(l3, 1080, 1350),
    ];

    const degen = checkCandidateSetDegeneracy(scaledSet);
    expect(degen.isDegenerate).toBe(false);
    expect(degen.pairwiseDistances).toBeDefined();
    for (const d of degen.pairwiseDistances) {
      expect(d).toBeGreaterThan(15);
    }
  });
});
