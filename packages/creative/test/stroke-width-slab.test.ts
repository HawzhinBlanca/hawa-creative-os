import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  prepareGeneratedLayoutV3,
  evaluateHardQa,
  maxStrokeWidth,
  scaleNormalizedLayoutToV2,
  type NormalizedLayoutCandidate,
  type StudioLayoutV2,
} from '../src/index.js';

/**
 * A 2px rule reaching the design as a stroke twice as wide as the canvas.
 *
 * The generator denormalised every strokeWidth as `strokeWidth * canvasWidth`, but the model
 * routinely answers in pixels: across the 200 designs stored under output/proofs/2026-09-18-*,
 * 114 shapes carry a strokeWidth and 38 of them are 1080, 1240, 2160, 2480 or 3840 — in every case
 * exactly 1x or 2x their own canvas width. 31 of those 38 designs still passed hard QA after
 * preparation, because nothing looked at the stroke at all, and transfer-v2 turns the value into
 * points at 0.75x, so a 2160px stroke leaves for Canva as a 1620pt outline.
 */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-tier-stroke-slab-brief_08.json', import.meta.url), 'utf8')
) as { source: string; copy: string[]; layout: StudioLayoutV2 };

const PALETTE = ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'];
const copy = {
  text: Object.fromEntries(fixture.copy.map((b, i) => [i, b])),
  scripts: Object.fromEntries(fixture.copy.map((_, i) => [i, 'arabic' as const])),
};
const W = fixture.layout.width;
const H = fixture.layout.height;
const canvas = { width: W, height: H, logoAspect: 1, palette: PALETTE };
const qaContext = {
  width: W,
  height: H,
  copyScripts: fixture.copy.map(() => 'arabic' as const),
  latinFont: 'Verdana',
  arabicFont: 'Noto Sans Arabic',
  palette: PALETTE,
  logoAspect: 1,
  copyText: copy.text,
};
const clone = () => JSON.parse(JSON.stringify(fixture.layout)) as StudioLayoutV2;
const rule = (layout: StudioLayoutV2) => layout.shapes.find((s) => s.role === 'rule');

describe('an oversized stroke paints a slab across the design', () => {
  it('the stored winner carries a stroke twice the width of its canvas', () => {
    const stored = fixture.layout.shapes[0];
    expect(stored.role).toBe('rule');
    expect(stored.height).toBe(3);
    expect(stored.strokeWidth).toBe(2160);
    expect(stored.strokeWidth!).toBe(2 * W);
  });

  it('hard QA reports the oversized stroke and the paint escaping the box', () => {
    const qa = evaluateHardQa(clone(), qaContext);
    expect(qa.defectCodes).toContain('OVERSIZED_STROKE');
    expect(qa.defectCodes).toContain('SHAPE_PAINT_ESCAPES_BOX');
    expect(qa.passed).toBe(false);
    expect(qa.messages.join(' ')).toContain('2160px');
  });

  it('repairs the stroke while refusing the fixture’s unmeasured mixed-script fallback', () => {
    const prepared = prepareGeneratedLayoutV3(clone(), copy, canvas);
    expect(rule(prepared)).toBeDefined();
    // 2160 is 2 x the 1080px canvas width, so the model asked for a 2px rule.
    expect(rule(prepared)!.strokeWidth).toBe(2);
    const qa = evaluateHardQa(prepared, qaContext);
    expect(qa.defectCodes).not.toContain('OVERSIZED_STROKE');
    expect(qa.defectCodes).not.toContain('SHAPE_PAINT_ESCAPES_BOX');
    expect(qa.passed).toBe(false);
    expect(qa.defectCodes).toEqual(['COPY_UNMEASURED']);
    expect(qa.textMeasurements.some((m) => m.status === 'unmeasured' && m.reason === 'MISSING_GLYPHS')).toBe(true);
  });

  it('clamps a stroke that is not an undone denormalisation, and QA accepts what it leaves', () => {
    // 400 is neither a plausible rule nor a multiple of the canvas width, so there is no intent to
    // recover; it is simply held to what the shape may carry.
    const layout = clone();
    layout.shapes[0].strokeWidth = 400;
    const prepared = prepareGeneratedLayoutV3(layout, copy, canvas);
    expect(rule(prepared)!.strokeWidth).toBeLessThanOrEqual(maxStrokeWidth('rule', W, H));
    expect(evaluateHardQa(prepared, qaContext).defectCodes).not.toContain('OVERSIZED_STROKE');
    expect(evaluateHardQa(prepared, qaContext).defectCodes).not.toContain('SHAPE_PAINT_ESCAPES_BOX');
  });

  it('leaves a stroke inside the role maximum exactly as the design has it', () => {
    // The whole legitimate range in the stored corpus: every stroke that was written as a fraction
    // scaled to between 1px and 5px.
    for (const width of [1, 2, 3, 4, 5]) {
      const layout = clone();
      layout.shapes[0].strokeWidth = width;
      const prepared = prepareGeneratedLayoutV3(layout, copy, canvas);
      expect(rule(prepared)!.strokeWidth).toBe(width);
      const qa = evaluateHardQa(prepared, qaContext);
      expect(qa.passed).toBe(false);
      expect(qa.defectCodes).toEqual(['COPY_UNMEASURED']);
    }
  });
});

/**
 * Scaling is where the value is first read. Every legitimate stroke in the stored corpus scaled to
 * 1-5px, so the model had written a fraction of at most 0.0046; every broken one came from a plain
 * 1 or 2. The two populations are more than two hundred times apart.
 */
describe('scaleNormalizedLayoutToV2 reads strokeWidth in the unit the model used', () => {
  const candidate = (strokeWidth: number | null): NormalizedLayoutCandidate =>
    ({
      id: 'stroke-probe',
      conceptTitle: 'Stroke probe',
      compositionArchetype: 'monolith_centered',
      typeScale: { base: 16, ratio: 1.333 },
      grid: { margin: 0.074, columns: 12, gutter: 0.02, baseline: 0.006 },
      background: { color: '#0A1628' },
      shapes: [
        {
          x: 0.1,
          y: 0.36,
          width: 0.8,
          height: 0.002,
          kind: 'line',
          color: '#F7B500',
          opacity: 1,
          radius: null,
          strokeWidth,
          strokeColor: '#F7B500',
          role: 'rule',
        },
      ],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 0.1,
          y: 0.4,
          width: 0.8,
          height: 0.1,
          fontSize: 0.05,
          lineHeight: 1.2,
          letterSpacing: null,
          fontFamily: 'Cinzel',
          color: '#FDF8F3',
          align: 'center',
          bold: true,
          italic: false,
          rtl: false,
        },
      ],
      logo: { x: 0.44, y: 0.06, width: 0.12, height: 0.12 },
      art: null,
    }) as NormalizedLayoutCandidate;

  it('reads a plain 2 as two pixels, not as two canvas widths', () => {
    expect(scaleNormalizedLayoutToV2(candidate(2), 1920, 1080).shapes[0].strokeWidth).toBe(2);
  });

  it('still reads a small fraction as a share of the canvas width', () => {
    expect(scaleNormalizedLayoutToV2(candidate(0.002), 1080, 1350).shapes[0].strokeWidth).toBe(2);
  });

  it('never returns a stroke above the role maximum', () => {
    for (const raw of [0.5, 40, 900, 4000]) {
      const scaled = scaleNormalizedLayoutToV2(candidate(raw), 1080, 1350).shapes[0];
      expect(scaled.strokeWidth!).toBeLessThanOrEqual(maxStrokeWidth('rule', 1080, 1350));
      expect(scaled.strokeWidth!).toBeGreaterThanOrEqual(1);
    }
  });

  it('leaves a shape without a stroke alone', () => {
    expect(scaleNormalizedLayoutToV2(candidate(null), 1080, 1350).shapes[0].strokeWidth).toBeUndefined();
  });
});

describe('a shape whose paint escapes its declared box', () => {
  it('fails QA even when the stroke itself is within the role maximum', () => {
    const layout = clone();
    // Nothing else in the pipeline measures anything but the declared box, so a border painted
    // well outside it is invisible to overlap, to the metrics and to the safe-area check.
    layout.shapes[0] = {
      ...layout.shapes[0],
      kind: 'rect',
      role: 'panel',
      x: 200,
      y: 1000,
      width: 2,
      height: 2,
      strokeWidth: 20,
      strokeColor: '#F7B500',
    };
    const qa = evaluateHardQa(layout, qaContext);
    expect(qa.defectCodes).not.toContain('OVERSIZED_STROKE');
    expect(qa.defectCodes).toContain('SHAPE_PAINT_ESCAPES_BOX');
  });
});
