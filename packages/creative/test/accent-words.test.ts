import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  renderLayoutV2ToSvg,
  applyStyleSpec,
  accentWordRange,
  NEUTRAL_STYLE_SPEC,
  encodeStudioTransferV2,
  type StudioLayoutV2,
} from '../src/index.js';
import { accentTextRuns } from '../src/studio/transfer-v2.js';

/**
 * "Make MEET KAAE AT gold" on a title written on one line. The accent worked only on paragraphs,
 * so a one-line title could not be accented at all: a live edit of the SAGACON design on
 * 2026-09-23 reported the first line gold and drew it white.
 */
const GOLD = '#F7B500';
const COPY = { 0: 'MEET KAAE AT SAGACON 2026', 1: 'September 25, 2026' };

const layout = (): StudioLayoutV2 =>
  ({
    version: 2,
    width: 1080,
    height: 1350,
    grid: { margin: 72, columns: 12, gutter: 24, baseline: 8 },
    background: { color: '#0A1628' },
    shapes: [],
    text: [
      { x: 72, y: 200, width: 900, height: 260, copyIndex: 0, role: 'title', fontSize: 96, lineHeight: 1.2, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left', bold: true },
      { x: 72, y: 600, width: 700, height: 60, copyIndex: 1, role: 'date', fontSize: 40, lineHeight: 1.3, fontFamily: 'Verdana', color: '#FFFFFF', align: 'left' },
    ],
    logo: { x: 900, y: 1180, width: 108, height: 108 },
  }) as StudioLayoutV2;

describe('named accent words', () => {
  it('finds the words as a whole-word sequence, and nothing for words not in the copy', () => {
    expect(accentWordRange('MEET KAAE AT SAGACON 2026', 'MEET KAAE AT')).toEqual({ from: 0, to: 3 });
    expect(accentWordRange('MEET KAAE AT SAGACON 2026', 'SAGACON 2026')).toEqual({ from: 3, to: 5 });
    expect(accentWordRange('MEET KAAE AT SAGACON 2026', 'KAAE ATS')).toBeUndefined();
    expect(accentWordRange('MEET KAAE AT SAGACON 2026', '')).toBeUndefined();
  });

  it('draws exactly those words in the accent colour', () => {
    const l = layout();
    Object.assign(l.text[0], { accentColor: GOLD, accentText: 'MEET KAAE AT' });
    const { svg } = renderLayoutV2ToSvg(l, { copyText: COPY });
    const gold = [...svg.matchAll(new RegExp(`<tspan[^>]*fill="${GOLD}"[^>]*>([^<]*)</tspan>`, 'g'))].map((m) => m[1]).join(' ');
    expect(gold.replace(/ /g, ' ').trim()).toBe('MEET KAAE AT');
    expect(svg).toContain('SAGACON');
  });

  it('writes them as their own coloured run in the Canva deck', async () => {
    expect(accentTextRuns(['MEET KAAE AT SAGACON 2026'], 'MEET KAAE AT')).toEqual([
      { text: 'MEET KAAE AT', accent: true, breakLine: false },
      { text: ' SAGACON 2026', accent: false, breakLine: false },
    ]);
    const l = layout();
    Object.assign(l.text[0], { accentColor: GOLD, accentText: 'MEET KAAE AT' });
    const { bytes } = await encodeStudioTransferV2(l, [COPY[0], COPY[1]]);
    const files = unzipSync(bytes);
    const slide = strFromU8(files['ppt/slides/slide1.xml']);
    const goldRun = slide.match(/<a:r><a:rPr[^>]*>(?:(?!<\/a:rPr>).)*F7B500(?:(?!<\/a:r>).)*<a:t>([^<]*)<\/a:t>/s);
    expect(goldRun?.[1]).toBe('MEET KAAE AT');
  });

  it("a reference's gold first line names the first drawn line's words when the title has no break", () => {
    const l = layout();
    applyStyleSpec(l, { text: COPY }, { ...NEUTRAL_STYLE_SPEC, titleColor: 'light', accentFirstTitleLine: true }, ['#0A1628', '#F7B500', '#FFFFFF']);
    const title = l.text[0];
    expect(title.accentColor).toBe(GOLD);
    expect(title.accentText).toBeTruthy();
    expect('MEET KAAE AT SAGACON 2026'.startsWith(title.accentText!)).toBe(true);
    expect(title.accentText).not.toBe('MEET KAAE AT SAGACON 2026');
  });
});
