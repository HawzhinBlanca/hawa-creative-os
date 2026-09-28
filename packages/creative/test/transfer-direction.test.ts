import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { encodeStudioTransferV2, studioLayoutV2ToTransferPlan } from '../src/studio/transfer-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const copy = ['NOVA ONE — بۆ هەنگاوی داهاتوو\nکاتژمێر 8:30 PM'];
function layout(fontFamily: string, rtl: boolean | undefined, accent = false): StudioLayoutV2 {
  return {
    version: 2, width: 1080, height: 1080, background: { color: '#FFFFFF' },
    grid: { margin: 60, columns: 12, gutter: 24, baseline: 8 }, shapes: [],
    logo: { x: 0, y: 0, width: 10, height: 10 },
    text: [{ copyIndex: 0, role: 'body', x: 60, y: 80, width: 900, height: 800,
      fontSize: 32, lineHeight: 1.7, fontFamily, color: '#14253D', align: 'left', rtl, letterSpacing: 0.04,
      ...(accent ? { accentColor: '#A23E16' } : {}),
    }],
  };
}
const slide = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['ppt/slides/slide1.xml']);

describe('Studio explicit paragraph direction', () => {
  it.each(['Noto Sans Arabic', 'Cairo', 'Amiri'])('respects explicit LTR in %s, including every accented paragraph', async font => {
    for (const accent of [false, true]) {
      const source = layout(font, false, accent);
      expect(studioLayoutV2ToTransferPlan(source).text[0].rtl).toBe(false);
      const encoded = await encodeStudioTransferV2(source, copy, undefined, { copyLocales: ['und'] });
      expect(encoded.manifest.plan.text[0].rtl).toBe(false);
      expect(encoded.manifest.copy).toEqual(copy);
      const xml = slide(encoded.bytes);
      expect(xml).not.toMatch(/\brtl="(?:1|true)"/);
      expect(xml).not.toMatch(/\bspc="[1-9]/); // Cursive typography is independent of paragraph direction.
      expect(xml).toContain('<a:spcPts val="4080"/>'); // Preserve the configured 1.7 line pitch.
      expect(xml).toContain('NOVA ONE — بۆ هەنگاوی داهاتوو');
      expect(xml).toContain('کاتژمێر 8:30 PM');
      if (accent) expect(xml).toContain('val="A23E16"');
    }
  });

  it.each([true, undefined])('retains RTL when explicitly requested or inherited by old Arabic-font layouts (%s)', async rtl => {
    const source = layout('Cairo', rtl, true);
    const encoded = await encodeStudioTransferV2(source, copy);
    expect(encoded.plan.text[0].rtl).toBe(true);
    expect([...slide(encoded.bytes).matchAll(/<a:pPr\b[^>]*>/g)].map(match => match[0]))
      .toEqual([expect.stringContaining('rtl="1"'), expect.stringContaining('rtl="1"')]);
  });

  it('honors explicit RTL independently of font family and alignment', async () => {
    const encoded = await encodeStudioTransferV2(layout('Verdana', true, true), ['NOVA ONE\n8:30 PM']);
    expect(encoded.plan.text[0].rtl).toBe(true);
    expect(slide(encoded.bytes)).toContain('rtl="1"');
  });
});
