import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import {
  scaleNormalizedLayoutToV2,
  type NormalizedLayoutCandidate,
} from '../src/studio/layout-generator-v3.js';
import { renderLayoutV2ToSvg } from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const fk = ((fontkit as any).default || fontkit) as typeof fontkit;
// Resolved from this file, not the working directory: `pnpm --filter` runs vitest inside the
// package while `pnpm test` runs it from the repo root, and a cwd-relative path passes in one and
// fails in the other.
const FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');

function textBlock(over: Partial<any> = {}) {
  return {
    copyIndex: 0,
    role: 'title' as const,
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.1,
    fontSize: 0.03,
    lineHeight: 1.3,
    letterSpacing: null,
    fontFamily: 'Cinzel',
    color: '#FDF8F3',
    align: 'center' as const,
    bold: true,
    italic: false,
    rtl: false,
    ...over,
  };
}

function candidate(over: Partial<NormalizedLayoutCandidate> = {}): NormalizedLayoutCandidate {
  return {
    id: 'cand-spacing',
    conceptTitle: 'Spacing fixture',
    compositionArchetype: 'monolith_centered',
    typeScale: { base: 14, ratio: 1.25 },
    grid: { margin: 0.06, columns: 6, gutter: 0.02, baseline: 0.006 },
    background: { color: '#0A1628' },
    logo: { x: 0.4, y: 0.04, width: 0.2, height: 0.08 },
    art: null,
    shapes: [],
    text: [textBlock()],
    ...over,
  } as NormalizedLayoutCandidate;
}

function rule(over: Partial<any> = {}) {
  return {
    x: 0.1,
    y: 0.3,
    width: 0.8,
    height: 0.002,
    kind: 'line' as const,
    color: '#C5A059',
    opacity: 1,
    radius: null,
    strokeWidth: null,
    strokeColor: null,
    role: 'rule' as const,
    ...over,
  };
}

describe('separator centring in the generator', () => {
  // The model routinely leaves a divider lopsided in the gap it divides; the T5 re-critique
  // raised that asymmetry nine times across eighteen designs.
  it('centres a lopsided rule in the gap between the blocks it divides', () => {
    const scaled = scaleNormalizedLayoutToV2(
      candidate({
        // title 0.10-0.20, subtitle 0.40-0.50, so the gap runs 0.20-0.40 and the rule at 0.23
        // sits far closer to the block above it.
        shapes: [rule({ y: 0.23 })],
        text: [
          textBlock({ copyIndex: 0, y: 0.1, height: 0.1 }),
          textBlock({ copyIndex: 1, role: 'subtitle', y: 0.4, height: 0.1, fontSize: 0.018 }),
        ],
      }),
      1000,
      1000
    );

    const r = scaled.shapes[0];
    const above = scaled.text[0].y + scaled.text[0].height;
    const below = scaled.text[1].y;
    const padTop = r.y - above;
    const padBottom = below - (r.y + r.height);

    expect(Math.abs(padTop - padBottom)).toBeLessThanOrEqual(1);
    expect(r.y).toBeGreaterThan(230); // moved down from its original 230
  });

  it('leaves a panel where the model put it', () => {
    const scaled = scaleNormalizedLayoutToV2(
      candidate({
        shapes: [rule({ y: 0.23, height: 0.2, kind: 'rect', role: 'panel' })],
        text: [
          textBlock({ copyIndex: 0, y: 0.05, height: 0.1 }),
          textBlock({ copyIndex: 1, role: 'subtitle', y: 0.6, height: 0.1, fontSize: 0.018 }),
        ],
      }),
      1000,
      1000
    );
    expect(scaled.shapes[0].y).toBe(230);
  });

  it('leaves a rule that a text block overlaps vertically', () => {
    const scaled = scaleNormalizedLayoutToV2(
      candidate({
        // An underline sitting inside the title's own box must not be dragged into a gap.
        shapes: [rule({ y: 0.18 })],
        text: [
          textBlock({ copyIndex: 0, y: 0.1, height: 0.1 }),
          textBlock({ copyIndex: 1, role: 'subtitle', y: 0.4, height: 0.1, fontSize: 0.018 }),
        ],
      }),
      1000,
      1000
    );
    expect(scaled.shapes[0].y).toBe(180);
  });

  it('leaves a rule with no text block on one side', () => {
    const scaled = scaleNormalizedLayoutToV2(
      candidate({
        shapes: [rule({ y: 0.8 })],
        text: [textBlock({ copyIndex: 0, y: 0.1, height: 0.1 })],
      }),
      1000,
      1000
    );
    expect(scaled.shapes[0].y).toBe(800);
  });
});

describe('Arabic script typography in the generator', () => {
  it('drops letter-spacing on RTL blocks, which breaks cursive joining', () => {
    const scaled = scaleNormalizedLayoutToV2(
      candidate({
        text: [
          textBlock({ copyIndex: 0, rtl: true, fontFamily: 'Cairo', letterSpacing: 0.02 }),
          textBlock({ copyIndex: 1, role: 'subtitle', rtl: false, letterSpacing: 0.02, y: 0.5 }),
        ],
      }),
      1000,
      1000
    );
    expect(scaled.text[0].letterSpacing).toBe(0);
    expect(scaled.text[1].letterSpacing).toBeGreaterThan(0);
  });
});

describe('ink centring in the renderer', () => {
  function singleBlockLayout(over: Partial<any> = {}): StudioLayoutV2 {
    return {
      version: 2,
      width: 1000,
      height: 1000,
      genre: 'poster',
      grid: { margin: 60, columns: 6, gutter: 20, baseline: 6 },
      background: { color: '#0A1628' },
      shapes: [],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 100,
          y: 200,
          width: 800,
          height: 300,
          fontSize: 40,
          lineHeight: 1.4,
          fontFamily: 'Verdana',
          color: '#FDF8F3',
          align: 'center',
          bold: false,
          italic: false,
          rtl: false,
          ...over,
        },
      ],
    } as unknown as StudioLayoutV2;
  }

  function baselineOf(svg: string): number {
    const m = svg.match(/<tspan[^>]*y="([\d.]+)"/);
    expect(m).not.toBeNull();
    return Number(m![1]);
  }

  it('centres the visible glyphs, not the line box, inside the text box', () => {
    const layout = singleBlockLayout();
    const t: any = layout.text[0];
    const copy = 'Quality Standards';
    const { svg } = renderLayoutV2ToSvg(layout, { copyText: { 0: copy } });
    const baseline = baselineOf(svg);

    const font = fk.openSync(path.join(FONTS_DIR, 'Verdana.ttf'));
    const scale = t.fontSize / font.unitsPerEm;
    const bbox = (font as any).layout(copy).bbox;
    const inkAbove = bbox.maxY * scale;
    const inkBelow = -bbox.minY * scale;

    const inkTop = baseline - inkAbove;
    const inkBottom = baseline + inkBelow;
    const padTop = inkTop - t.y;
    const padBottom = t.y + t.height - inkBottom;

    expect(padTop).toBeGreaterThan(0);
    expect(Math.abs(padTop - padBottom)).toBeLessThanOrEqual(1);
  });

  it('pushes the baseline below the old metric-ascent position for a tall box', () => {
    const layout = singleBlockLayout();
    const t: any = layout.text[0];
    const { svg } = renderLayoutV2ToSvg(layout, { copyText: { 0: 'Quality Standards' } });
    const baseline = baselineOf(svg);

    const font = fk.openSync(path.join(FONTS_DIR, 'Verdana.ttf'));
    const metricAscent = (font.ascent || 800) * (t.fontSize / font.unitsPerEm);
    expect(baseline).toBeGreaterThan(t.y + metricAscent);
  });

  it('keeps text at the box top when the ink is taller than the box', () => {
    // A box far too short for the copy must still start at its top edge and spill downward,
    // rather than being centred up past the canvas edge.
    const layout = singleBlockLayout({ height: 10, y: 0 });
    const { svg } = renderLayoutV2ToSvg(layout, {
      copyText: { 0: 'Quality Standards Under Institutional Law' },
    });
    const baseline = baselineOf(svg);
    expect(baseline).toBeGreaterThan(0);

    const font = fk.openSync(path.join(FONTS_DIR, 'Verdana.ttf'));
    const t: any = layout.text[0];
    const bbox = (font as any).layout('Quality').bbox;
    const inkAbove = bbox.maxY * (t.fontSize / font.unitsPerEm);
    // No vertical slack was added: the first baseline sits exactly one ink-ascent below the top.
    expect(Math.abs(baseline - inkAbove)).toBeLessThanOrEqual(1);
  });
});

describe('Canva transfer fidelity', () => {
  it('encodes every shape kind, opacity and stroke without falling back to a filled rect', async () => {
    const { encodeEditableTransfer } = await import('../src/editable-transfer.js');
    const plan = {
      width: 1080,
      height: 1350,
      background: '#0A1628',
      text: [
        {
          copyIndex: 0,
          x: 60,
          y: 200,
          width: 960,
          height: 100,
          fontSize: 32,
          fontFamily: 'Verdana',
          color: '#FDF8F3',
          align: 'center' as const,
          lineHeight: 1.6,
        },
      ],
      shapes: [
        { x: 60, y: 350, width: 960, height: 2, color: '#C5A059', kind: 'line' as const, strokeWidth: 2 },
        { x: 60, y: 400, width: 300, height: 200, color: '#162B48', kind: 'rect' as const, opacity: 0.4 },
        { x: 400, y: 400, width: 200, height: 200, color: '#162B48', kind: 'ellipse' as const },
        {
          x: 650,
          y: 400,
          width: 300,
          height: 200,
          color: '#162B48',
          kind: 'roundRect' as const,
          radius: 24,
          strokeColor: '#C5A059',
          strokeWidth: 1,
        },
      ],
    };
    const out = await encodeEditableTransfer(plan, ['Official KAAE Announcement']);
    expect(out.bytes).toBeInstanceOf(Buffer);
    expect(out.bytes.length).toBeGreaterThan(1000);
    expect(out.manifest.plan.shapes[0].kind).toBe('line');
  });

  it('marks a centre-aligned Amiri block RTL and an English right-aligned block LTR', async () => {
    const { studioLayoutV2ToTransferPlan } = await import('../src/studio/transfer-v2.js');
    const layout = {
      version: 2,
      width: 1080,
      height: 1080,
      genre: 'poster',
      grid: { margin: 60, columns: 6, gutter: 20, baseline: 6 },
      background: { color: '#0A1628' },
      shapes: [],
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 60,
          y: 100,
          width: 960,
          height: 120,
          fontSize: 48,
          lineHeight: 1.3,
          fontFamily: 'Amiri',
          color: '#FDF8F3',
          align: 'center',
          bold: true,
          italic: false,
          rtl: true,
        },
        {
          copyIndex: 1,
          role: 'footer',
          x: 60,
          y: 900,
          width: 960,
          height: 40,
          fontSize: 16,
          lineHeight: 1.4,
          fontFamily: 'Verdana',
          color: '#C5A059',
          align: 'right',
          bold: false,
          italic: false,
          rtl: false,
        },
      ],
    } as unknown as StudioLayoutV2;

    const plan = studioLayoutV2ToTransferPlan(layout);
    // Amiri was absent from the old family test, so a centre-aligned Kurdish title reached Canva
    // without rtlMode; an English right-aligned footer was marked Kurdish by its alignment alone.
    expect(plan.text[0].rtl).toBe(true);
    expect(plan.text[1].rtl).toBe(false);
    expect(plan.text[0].lineHeight).toBe(1.3);
  });
});

describe('separator asymmetry detector', () => {
  it('flags a lopsided separator and clears once it is centred', async () => {
    const { findAsymmetricSeparators, centerSeparatorsInGaps } = await import(
      '../src/studio/layout-generator-v3.js'
    );
    const shapes: any[] = [
      { x: 100, y: 238, width: 800, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 100, y: 100, width: 800, height: 100, role: 'title' },
      { copyIndex: 1, x: 100, y: 400, width: 800, height: 100, role: 'subtitle' },
    ];

    const before = findAsymmetricSeparators(shapes, text);
    expect(before).toHaveLength(1);
    expect(before[0].padTop).toBe(38);
    expect(before[0].padBottom).toBe(160);
    expect(before[0].skew).toBeGreaterThan(0.25);

    centerSeparatorsInGaps(shapes, text);
    expect(findAsymmetricSeparators(shapes, text)).toHaveLength(0);
  });

  it('does not flag a few pixels of skew in a tight gap', async () => {
    const { findAsymmetricSeparators } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [
      { x: 100, y: 222, width: 800, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 100, y: 100, width: 800, height: 100, role: 'title' },
      { copyIndex: 1, x: 100, y: 250, width: 800, height: 100, role: 'subtitle' },
    ];
    // 22px above, 26px below: visible to a measuring script, invisible to a reader.
    expect(findAsymmetricSeparators(shapes, text)).toHaveLength(0);
  });

  it('ignores a separator with no text block on one side', async () => {
    const { findAsymmetricSeparators } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [
      { x: 100, y: 900, width: 800, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    ];
    const text: any[] = [{ copyIndex: 0, x: 100, y: 100, width: 800, height: 100, role: 'title' }];
    expect(findAsymmetricSeparators(shapes, text)).toHaveLength(0);
  });
});
