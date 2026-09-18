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
    // Asserted relative to the content: balanceCanvasMargins may shift the whole composition.
    expect(scaled.shapes[0].y - scaled.text[0].y).toBe(180);
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
    expect(scaled.shapes[0].y - scaled.text[0].y).toBe(80);
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
    expect(scaled.shapes[0].y - scaled.text[0].y).toBe(700);
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

describe('separator boundaries: panels count, panel edges are intent', () => {
  it('centres against a panel edge, not the text block behind it', async () => {
    const { centerSeparatorsInGaps } = await import('../src/studio/layout-generator-v3.js');
    // Body text ends at 794, a panel wraps it and ends at 827, the footer starts at 934.
    // Centring against the text alone put the rule at 864 — dead centre of 794..934 and visibly
    // lopsided, because a reader sees the panel edge at 827 as where the content ends.
    const shapes: any[] = [
      { x: 130, y: 643, width: 821, height: 184, kind: 'rect', color: '#162B48', role: 'panel' },
      { x: 324, y: 864, width: 432, height: 1, kind: 'line', color: '#C5A059', role: 'rule' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 173, y: 675, width: 734, height: 119, role: 'body' },
      { copyIndex: 1, x: 108, y: 934, width: 864, height: 38, role: 'footer' },
    ];
    centerSeparatorsInGaps(shapes, text);
    expect(shapes[1].y).toBe(880); // 827 + (107 - 1) / 2
  });

  it('leaves a rule flush with a panel top edge exactly where it is', async () => {
    const { centerSeparatorsInGaps, findAsymmetricSeparators } = await import(
      '../src/studio/layout-generator-v3.js'
    );
    // Every one of the seven residual cases in the T5 set was this: a panel's own top rule,
    // sitting at 0px from the panel. Centring them pulled each one off its panel.
    const shapes: any[] = [
      { x: 76, y: 1067, width: 929, height: 155, kind: 'rect', color: '#162B48', role: 'panel' },
      { x: 76, y: 1067, width: 929, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 130, y: 830, width: 821, height: 149, role: 'body' },
      { copyIndex: 1, x: 108, y: 1116, width: 864, height: 54, role: 'footer' },
    ];
    expect(centerSeparatorsInGaps(shapes, text)).toBe(0);
    expect(shapes[1].y).toBe(1067);
    expect(findAsymmetricSeparators(shapes, text)).toHaveLength(0);
  });

  it('still centres a rule that divides two text blocks inside a panel', async () => {
    const { centerSeparatorsInGaps } = await import('../src/studio/layout-generator-v3.js');
    // The panel contains the rule, so it is a container rather than a boundary.
    const shapes: any[] = [
      { x: 100, y: 100, width: 800, height: 600, kind: 'rect', color: '#162B48', role: 'panel' },
      { x: 150, y: 260, width: 700, height: 2, kind: 'line', color: '#C5A059', role: 'rule' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 150, y: 150, width: 700, height: 100, role: 'title' },
      { copyIndex: 1, x: 150, y: 450, width: 700, height: 100, role: 'body' },
    ];
    centerSeparatorsInGaps(shapes, text);
    expect(shapes[1].y).toBe(349); // 250 + (200 - 2) / 2
  });
});

describe('lone text block centring inside a panel', () => {
  const panel = { x: 100, y: 600, width: 800, height: 200, kind: 'rect', color: '#162B48', role: 'panel' };

  it('centres a panel with exactly one text block in it', async () => {
    const { centerLoneTextInPanels } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [{ ...panel }];
    const text: any[] = [{ copyIndex: 0, x: 150, y: 640, width: 700, height: 100, role: 'body' }];
    expect(centerLoneTextInPanels(shapes, text)).toBe(1);
    expect(text[0].y).toBe(650); // 600 + (200 - 100) / 2
  });

  it('leaves a panel holding several blocks alone', async () => {
    const { centerLoneTextInPanels } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [{ ...panel }];
    const text: any[] = [
      { copyIndex: 0, x: 150, y: 620, width: 700, height: 60, role: 'body' },
      { copyIndex: 1, x: 150, y: 700, width: 700, height: 60, role: 'footer' },
    ];
    // Redistributing a stack is a composition decision, not a centring one.
    expect(centerLoneTextInPanels(shapes, text)).toBe(0);
    expect(text[0].y).toBe(620);
  });

  it('does not move a block onto another shape inside the same panel', async () => {
    const { centerLoneTextInPanels } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [
      { ...panel },
      { x: 150, y: 645, width: 700, height: 20, kind: 'rect', color: '#C5A059', role: 'frame' },
    ];
    const text: any[] = [{ copyIndex: 0, x: 150, y: 690, width: 700, height: 100, role: 'body' }];
    expect(centerLoneTextInPanels(shapes, text)).toBe(0);
    expect(text[0].y).toBe(690);
  });

  it('leaves a block that is already centred', async () => {
    const { centerLoneTextInPanels } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [{ ...panel }];
    const text: any[] = [{ copyIndex: 0, x: 150, y: 650, width: 700, height: 100, role: 'body' }];
    expect(centerLoneTextInPanels(shapes, text)).toBe(0);
  });
});

describe('separator marks that are not thin lines', () => {
  it('centres a circular accent dividing two blocks', async () => {
    const { centerSeparatorsInGaps } = await import('../src/studio/layout-generator-v3.js');
    // brief_08 in the T5 set: a 22x22 ellipse accent sitting 34px below the subtitle and 59px
    // above the body. A thinness test skipped it, so the critique kept raising it.
    const shapes: any[] = [
      { x: 529, y: 743, width: 22, height: 22, kind: 'ellipse', color: '#C5A059', role: 'accent' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 97, y: 608, width: 886, height: 101, role: 'subtitle' },
      { copyIndex: 1, x: 130, y: 824, width: 821, height: 176, role: 'body' },
    ];
    centerSeparatorsInGaps(shapes, text);
    expect(shapes[0].y).toBe(756); // 709 + (115 - 22) / 2
  });

  it('leaves an accent that fills most of the gap, since it is a block not a mark', async () => {
    const { centerSeparatorsInGaps } = await import('../src/studio/layout-generator-v3.js');
    const shapes: any[] = [
      { x: 100, y: 215, width: 800, height: 60, kind: 'rect', color: '#162B48', role: 'accent' },
    ];
    const text: any[] = [
      { copyIndex: 0, x: 100, y: 100, width: 800, height: 100, role: 'title' },
      { copyIndex: 1, x: 100, y: 300, width: 800, height: 100, role: 'body' },
    ];
    // 60px tall in a 100px gap is more than a third of it: a band, not a divider.
    expect(centerSeparatorsInGaps(shapes, text)).toBe(0);
    expect(shapes[0].y).toBe(215);
  });
});

describe('drifted text block snapping', () => {
  const shared = (copyIndex: number, role: string, y: number) => ({
    copyIndex, role, x: 130, y, width: 821, height: 60,
  });

  it('snaps a block that drifted off a span three others share', async () => {
    const { snapDriftedTextBlocks } = await import('../src/studio/layout-generator-v3.js');
    // brief_11: a footer at 103..913 against its neighbours' 130..951 — the same width to within
    // 11px, simply out of position.
    const text: any[] = [
      shared(0, 'eyebrow', 100),
      shared(1, 'title', 200),
      shared(2, 'subtitle', 300),
      { copyIndex: 3, role: 'footer', x: 103, y: 400, width: 810, height: 60 },
    ];
    expect(snapDriftedTextBlocks(text)).toBe(1);
    expect(text[3].x).toBe(130);
    expect(text[3].width).toBe(821);
  });

  it('leaves a block given a measure of its own', async () => {
    const { snapDriftedTextBlocks } = await import('../src/studio/layout-generator-v3.js');
    // A body inset 65px inside a panel is a design decision, and the critique accepted all 21 of
    // these across the T5 set. Distance alone cannot tell them apart — width can.
    const text: any[] = [
      shared(0, 'eyebrow', 100),
      shared(1, 'title', 200),
      shared(2, 'subtitle', 300),
      { copyIndex: 3, role: 'body', x: 173, y: 400, width: 734, height: 60 },
    ];
    expect(snapDriftedTextBlocks(text)).toBe(0);
    expect(text[3].x).toBe(173);
  });

  it('does nothing without a shared span to snap to', async () => {
    const { snapDriftedTextBlocks } = await import('../src/studio/layout-generator-v3.js');
    const text: any[] = [
      { copyIndex: 0, role: 'title', x: 100, y: 100, width: 800, height: 60 },
      { copyIndex: 1, role: 'body', x: 120, y: 200, width: 790, height: 60 },
      { copyIndex: 2, role: 'footer', x: 140, y: 300, width: 780, height: 60 },
      { copyIndex: 3, role: 'eyebrow', x: 160, y: 400, width: 770, height: 60 },
    ];
    expect(snapDriftedTextBlocks(text)).toBe(0);
  });
});

describe('canvas margin balance', () => {
  const layout = (over: any = {}) => ({
    width: 1080,
    height: 1080,
    grid: { margin: 76, columns: 6, gutter: 20, baseline: 6 },
    shapes: [],
    text: [
      { copyIndex: 0, role: 'eyebrow', x: 108, y: 76, width: 864, height: 40 },
      { copyIndex: 1, role: 'footer', x: 108, y: 885, width: 864, height: 38 },
    ],
    ...over,
  });

  it('shifts the composition so the space above and below match', async () => {
    const { balanceCanvasMargins } = await import('../src/studio/layout-generator-v3.js');
    const l: any = layout(); // top 76, bottom 1080 - 923 = 157
    expect(balanceCanvasMargins(l)).toBe(1);
    const top = Math.min(...l.text.map((t: any) => t.y));
    const bottom = l.height - Math.max(...l.text.map((t: any) => t.y + t.height));
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
    expect(top).toBeGreaterThanOrEqual(l.grid.margin);
  });

  it('leaves an already balanced composition alone', async () => {
    const { balanceCanvasMargins } = await import('../src/studio/layout-generator-v3.js');
    const l: any = layout({
      text: [
        { copyIndex: 0, role: 'eyebrow', x: 108, y: 100, width: 864, height: 40 },
        { copyIndex: 1, role: 'footer', x: 108, y: 940, width: 864, height: 40 },
      ],
    });
    expect(balanceCanvasMargins(l)).toBe(0);
  });

  it('never lifts the composition above the grid margin', async () => {
    const { balanceCanvasMargins } = await import('../src/studio/layout-generator-v3.js');
    // Bottom-heavy the other way: content starts at 300 with only 40px below it.
    const l: any = layout({
      text: [
        { copyIndex: 0, role: 'eyebrow', x: 108, y: 300, width: 864, height: 40 },
        { copyIndex: 1, role: 'footer', x: 108, y: 1000, width: 864, height: 40 },
      ],
    });
    balanceCanvasMargins(l);
    expect(Math.min(...l.text.map((t: any) => t.y))).toBeGreaterThanOrEqual(l.grid.margin);
  });

  it('neither measures nor moves a full-bleed background', async () => {
    const { balanceCanvasMargins } = await import('../src/studio/layout-generator-v3.js');
    const l: any = layout({
      shapes: [{ x: 0, y: 0, width: 1080, height: 1080, kind: 'rect', color: '#0A1628', role: 'panel' }],
    });
    expect(balanceCanvasMargins(l)).toBe(1);
    expect(l.shapes[0].y).toBe(0);
  });
});

describe('fonts must be able to draw the copy they are given', () => {
  it('knows Cairo cannot draw the Sorani letters and Amiri can', async () => {
    const { fontCoversText } = await import('../src/studio/render-layout-v2.js');
    const sorani = 'ڕاگەیاندنی بەڕێوەبەرایەتی کوالیتی خوێندن';
    const cairo = fontCoversText('Cairo', sorani);
    expect(cairo.covers).toBe(false);
    expect(cairo.missing.join('')).toMatch(/[ەۆێڕڵ]/);
    expect(fontCoversText('Amiri', sorani).covers).toBe(true);
    expect(fontCoversText('Noto Sans Arabic', sorani).covers).toBe(true);
  });

  it('moves a Kurdish display block off a font that cannot draw it', async () => {
    const { correctFontsThatCannotDrawTheCopy } = await import(
      '../src/studio/layout-generator-v3.js'
    );
    const layout: any = {
      width: 1080,
      height: 1080,
      text: [
        { copyIndex: 0, role: 'title', x: 100, y: 100, width: 800, height: 100, fontSize: 48, lineHeight: 1.3, fontFamily: 'Cairo', rtl: true },
      ],
    };
    expect(correctFontsThatCannotDrawTheCopy(layout, { 0: 'کوالیتی خوێندن' })).toBe(1);
    expect(layout.text[0].fontFamily).toBe('Amiri');
  });

  it('leaves a Latin run inside an Arabic block alone, since that is script fallback', async () => {
    const { correctFontsThatCannotDrawTheCopy } = await import(
      '../src/studio/layout-generator-v3.js'
    );
    // Noto Sans Arabic has no Latin glyphs, and a Kurdish footer ending in a URL is legitimately
    // set with fallback for the Latin run. Only failure on the block's own script is a defect.
    const layout: any = {
      width: 1080,
      height: 1080,
      text: [
        { copyIndex: 0, role: 'footer', x: 100, y: 900, width: 800, height: 40, fontSize: 16, lineHeight: 1.4, fontFamily: 'Noto Sans Arabic', rtl: true },
      ],
    };
    expect(correctFontsThatCannotDrawTheCopy(layout, { 0: 'هەولێر • kaae.gov.krd' })).toBe(0);
    expect(layout.text[0].fontFamily).toBe('Noto Sans Arabic');
  });

  it('keeps the generator choice when it works', async () => {
    const { correctFontsThatCannotDrawTheCopy } = await import(
      '../src/studio/layout-generator-v3.js'
    );
    const layout: any = {
      width: 1080,
      height: 1080,
      text: [
        { copyIndex: 0, role: 'title', x: 100, y: 100, width: 800, height: 100, fontSize: 48, lineHeight: 1.3, fontFamily: 'Playfair Display', rtl: false },
      ],
    };
    expect(correctFontsThatCannotDrawTheCopy(layout, { 0: 'Mandatory Quality Standards' })).toBe(0);
    expect(layout.text[0].fontFamily).toBe('Playfair Display');
  });
});

describe('the editable deck must accept the fonts the generator emits', () => {
  it('encodes a Kurdish design set in Amiri', async () => {
    const { encodeEditableTransfer } = await import('../src/editable-transfer.js');
    // Amiri became the right-to-left display default because it is the only bundled font covering
    // the Sorani letters — and it was missing from the deck's admitted font list, so every Kurdish
    // design threw "Unsupported font or unreadable size" and produced no deliverable at all.
    const plan = {
      width: 1080,
      height: 1920,
      background: '#0A1628',
      text: [
        {
          copyIndex: 0, x: 130, y: 400, width: 821, height: 200,
          fontSize: 48, fontFamily: 'Amiri', color: '#FDF8F3',
          align: 'right' as const, rtl: true, lineHeight: 1.3,
        },
        {
          copyIndex: 1, x: 130, y: 900, width: 821, height: 160,
          fontSize: 27, fontFamily: 'Noto Sans Arabic', color: '#FDF8F3',
          align: 'right' as const, rtl: true, lineHeight: 1.5,
        },
      ],
      shapes: [
        { x: 130, y: 700, width: 821, height: 2, color: '#C5A059', kind: 'line' as const },
      ],
    };
    const out = await encodeEditableTransfer(plan, ['کوالیتی خوێندن', 'پێویسته هەموو کۆلێژ و زانکۆکان']);
    expect(out.bytes.length).toBeGreaterThan(1000);
    expect(out.manifest.rtlBlocks).toEqual([0, 1]);
  });

  it('every font the generator can assign is admitted by the deck', async () => {
    const { encodeEditableTransfer } = await import('../src/editable-transfer.js');
    // The generator picks from these; any one of them missing downstream breaks the deliverable.
    const families = ['Verdana', 'Cinzel', 'Playfair Display', 'Noto Sans Arabic', 'Cairo', 'Amiri'];
    for (const fontFamily of families) {
      const plan = {
        width: 1080,
        height: 1080,
        background: '#0A1628',
        text: [
          {
            copyIndex: 0, x: 100, y: 100, width: 800, height: 120,
            fontSize: 32, fontFamily, color: '#FDF8F3', align: 'center' as const, lineHeight: 1.4,
          },
        ],
        shapes: [],
      };
      const out = await encodeEditableTransfer(plan, ['Sample']);
      expect(out.bytes.length, `${fontFamily} must encode`).toBeGreaterThan(1000);
    }
  });
});

describe('negativeSpace: the band travels with the measure', () => {
  const W = 1080, H = 1350, MARGIN = 76, COLS = 6, GUT = 26;
  const colW = (W - 2 * MARGIN - (COLS - 1) * GUT) / COLS;
  const span = (n: number) => Math.round(n * colW + (n - 1) * GUT);
  const COPY: Record<number, string> = {
    0: 'Kurdistan Accrediting Agency for Education',
    1: 'Mandatory Quality Standards 2026',
    2: 'Institutional Excellence Under Law No. 6',
    3: 'All universities must publish audited accreditation reports by the end of Q3.',
    4: 'Erbil • September 2026 • kaae.gov.krd',
  };
  const T = (i: number, role: string, x: number, y: number, w: number, h: number, size: number, align: string, font = 'Verdana') => ({
    copyIndex: i, role, x, y, width: w, height: h, fontSize: size, lineHeight: 1.35,
    fontFamily: font, color: '#FDF8F3', align, bold: false, italic: false, rtl: false,
  });
  const layout = (widths: number[], align: string) => ({
    version: 2, width: W, height: H, genre: 'poster',
    grid: { margin: MARGIN, columns: COLS, gutter: GUT, baseline: 14 },
    background: { color: '#0A1628' },
    logo: { x: MARGIN, y: 90, width: 200, height: 120 },
    shapes: [{ x: MARGIN, y: 730, width: span(widths[3]), height: 260, kind: 'rect', color: '#162B48', role: 'panel' }],
    text: [
      T(0, 'eyebrow', MARGIN, 260, span(widths[0]), 40, 18, align, 'Cinzel'),
      T(1, 'title', MARGIN, 360, span(widths[1]), 180, 54, align, 'Playfair Display'),
      T(2, 'subtitle', MARGIN, 580, span(widths[2]), 70, 26, align, 'Playfair Display'),
      T(3, 'body', MARGIN, 760, span(widths[3]), 200, 22, align),
      T(4, 'footer', MARGIN, 1180, span(widths[4]), 44, 16, align),
    ],
  }) as any;

  it('stops preferring a full-width centred composition over an asymmetric one', async () => {
    const { evaluateDesignMetrics } = await import('../src/studio/design-metrics.js');
    const { measureWrappedLines } = await import('../src/studio/render-layout-v2.js');
    const centred = layout([6, 6, 6, 6, 6], 'center');
    const asym = layout([4, 5, 4, 4, 4], 'left');

    const boxGap =
      evaluateDesignMetrics(centred).compositeScore - evaluateDesignMetrics(asym).compositeScore;
    const inkGap =
      evaluateDesignMetrics(centred, { wrappedLines: measureWrappedLines(centred, COPY) }).compositeScore -
      evaluateDesignMetrics(asym, { wrappedLines: measureWrappedLines(asym, COPY) }).compositeScore;

    // Counting boxes gives the centred layout a large unearned advantage; counting type does not.
    expect(boxGap).toBeGreaterThan(0.04);
    expect(Math.abs(inkGap)).toBeLessThan(0.02);
  });

  it('still rejects a crammed layout and a bare one', async () => {
    const { evaluateDesignMetrics } = await import('../src/studio/design-metrics.js');
    const { measureWrappedLines } = await import('../src/studio/render-layout-v2.js');
    const LONG = 'All accredited institutions must publish audited accreditation reports covering governance, curriculum, staffing, facilities and student outcomes before the end of the third quarter.';

    const crammed = layout([6, 6, 6, 6, 6], 'center');
    crammed.text.forEach((t: any) => { t.fontSize = 64; t.height = 300; });
    const crammedCopy = { 0: LONG, 1: LONG, 2: LONG, 3: LONG, 4: LONG };
    const crammedReport = evaluateDesignMetrics(crammed, { wrappedLines: measureWrappedLines(crammed, crammedCopy) });
    expect(crammedReport.metrics.negativeSpace.score).toBeLessThan(0.7);

    const bare = layout([6, 6, 6, 6, 6], 'center');
    bare.text = [bare.text[1]];
    bare.shapes = [];
    delete bare.logo;
    const bareReport = evaluateDesignMetrics(bare, { wrappedLines: measureWrappedLines(bare, { 1: 'Notice' }) });
    expect(bareReport.metrics.negativeSpace.score).toBeLessThan(0.7);
  });
});
