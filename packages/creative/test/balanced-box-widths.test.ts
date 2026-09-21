import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { balancedBoxWidths, balanceLineBreaks, measureWrappedLines, type StudioLayoutV2 } from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cheap-tier-stroke-slab-brief_08.json', import.meta.url), 'utf8')
) as { layout: StudioLayoutV2 };

/** One text block, in a face the repo ships, at a width chosen by the test. */
function block(copy: string, width: number, fontFamily: string, align: 'left' | 'center' | 'right' = 'center') {
  const layout: StudioLayoutV2 = JSON.parse(JSON.stringify(fixture.layout));
  const t = { ...layout.text[0], copyIndex: 0, x: 100, width, fontSize: 64, fontFamily, align, bold: false, italic: false };
  layout.text = [t];
  layout.shapes = [];
  return { layout, copy: { 0: copy } };
}

/** The first width, scanning down, at which greedy wrapping strands the last word alone. */
function widthWithWidow(copy: string, fontFamily: string): number {
  for (let w = 1000; w > 200; w -= 5) {
    const { layout, copy: c } = block(copy, w, fontFamily);
    const out = balancedBoxWidths(layout, c);
    if (out[0] !== undefined) return w;
  }
  throw new Error(`no widow found for "${copy}"`);
}

describe('balancedBoxWidths: narrow the box so a block does not end on a stranded word', () => {
  for (const [name, copy, font] of [
    ['an English title', 'National Quality Assurance Covenant', 'Playfair Display'],
    ['a Sorani title', 'پێوەرە نیشتمانییەکانی کوالیتی خوێندن', 'Noto Sans Arabic'],
  ] as const) {
    it(`${name}: keeps the line count, narrows the box, and survives a 3% difference in measurement`, () => {
      const w = widthWithWidow(copy, font);
      const { layout, copy: c } = block(copy, w, font);
      const linesBefore = measureWrappedLines(layout, c)[0];
      const chosen = balancedBoxWidths(layout, c)[0];
      expect(chosen).toBeLessThan(w);
      expect(linesBefore).toBeGreaterThanOrEqual(2);

      // Canva measures type a little differently: the same line count must hold either side.
      for (const factor of [0.97, 1, 1.03]) {
        const at = block(copy, Math.round(chosen * factor), font);
        expect(measureWrappedLines(at.layout, at.copy)[0]).toBe(linesBefore);
      }
      // And the narrowed box no longer has a widow to fix.
      const after = block(copy, chosen, font);
      expect(balancedBoxWidths(after.layout, after.copy)[0]).toBeUndefined();
    });
  }

  it('leaves alone a single line, a block without a widow, and copy with its own line breaks', () => {
    const one = block('Covenant', 900, 'Playfair Display');
    expect(balancedBoxWidths(one.layout, one.copy)).toEqual({});
    const manual = block('National Quality\nAssurance Covenant', 600, 'Playfair Display');
    expect(balancedBoxWidths(manual.layout, manual.copy)).toEqual({});
  });

  it('never proposes a box narrower than the longest word', () => {
    const copy = 'A Internationalisation';
    const { layout, copy: c } = block(copy, 500, 'Playfair Display');
    const chosen = balancedBoxWidths(layout, c)[0];
    if (chosen !== undefined) {
      const at = block('Internationalisation', chosen, 'Playfair Display');
      expect(measureWrappedLines(at.layout, at.copy)[0]).toBe(1);
    }
  });
});

describe('balanceLineBreaks: the narrowed block keeps its anchor', () => {
  const copyText = 'National Quality Assurance Covenant';
  const w = widthWithWidow(copyText, 'Playfair Display');

  for (const align of ['left', 'center', 'right'] as const) {
    it(`${align}-aligned`, () => {
      const { layout, copy } = block(copyText, w, 'Playfair Display', align);
      const before = layout.text[0];
      const out = balanceLineBreaks(layout, { text: copy, scripts: {} } as any).text[0];
      expect(out.width).toBeLessThan(before.width);
      expect(out.height).toBe(before.height);
      expect(out.fontSize).toBe(before.fontSize);
      if (align === 'left') expect(out.x).toBe(before.x);
      if (align === 'right') expect(out.x + out.width).toBeCloseTo(before.x + before.width, 6);
      if (align === 'center') expect(out.x + out.width / 2).toBeCloseTo(before.x + before.width / 2, 6);
      // The input is not mutated: a rejected change must leave the caller's layout as it was.
      expect(layout.text[0].width).toBe(before.width);
    });
  }

  it('returns the same layout when there is nothing to fix', () => {
    const { layout, copy } = block('Covenant', 900, 'Playfair Display');
    expect(balanceLineBreaks(layout, { text: copy, scripts: {} } as any)).toBe(layout);
  });
});
