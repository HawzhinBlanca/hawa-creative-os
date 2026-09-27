import { describe, it, expect } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { encodeEditableTransfer, type EditableTransferPlan } from '../src/editable-transfer.js';
import { encodeStudioTransferV2 } from '../src/studio/transfer-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const copy = ['مرحباً بالعالم\nالموعد 8:30 PM', 'کوردی — NOVA', 'Cafe\u0301 2026'];
const text = copy.map((_, copyIndex) => ({
  copyIndex, x: 80, y: 100 + copyIndex * 240, width: 920, height: 180,
  fontSize: 32, fontFamily: copyIndex < 2 ? 'Noto Sans Arabic' : 'Verdana',
  color: '#000000', align: 'center' as const, rtl: copyIndex < 2,
}));
const plan: EditableTransferPlan = { width: 1080, height: 1080, background: '#FFFFFF', shapes: [], text };
const layout: StudioLayoutV2 = {
  version: 2, width: 1080, height: 1080, background: { color: '#FFFFFF' },
  grid: { columns: 12, margin: 80, gutter: 16, baseline: 8 }, shapes: [],
  logo: { x: 0, y: 0, width: 10, height: 10 },
  text: text.map(t => ({ ...t, role: 'body', lineHeight: 1.7,
    // Exercise paragraph runs as well as plain text in Studio.
    ...(t.copyIndex === 0 ? { accentColor: '#333333' } : {}),
  })),
};

for (const version of ['planner', 'studio'] as const) {
  const encode = (copyLocales?: string[]) => {
    const options = { extraFonts: ['Noto Sans Arabic'], copyLocales };
    return version === 'planner'
      ? encodeEditableTransfer(structuredClone(plan), copy, undefined, options)
      : encodeStudioTransferV2(structuredClone(layout), copy, undefined, options);
  };
  const slide = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['ppt/slides/slide1.xml']);
  describe(`${version} transfer language provenance`, () => {
    it('does not label unspecified Arabic, Sorani or Latin copy as Kurdish or US English', async () => {
      const out = await encode();
      const xml = slide(out.bytes);
      expect(xml).not.toMatch(/lang="(?:ku|en-US)"/);
      expect(xml).toContain('lang="und"');
      expect(out.manifest).toMatchObject({ copy, copyLocales: ['und', 'und', 'und'] });
      expect(xml).toContain('Cafe\u0301 2026');
      expect(xml).toContain('rtl="1"');
    });
    it('keeps explicit Arabic, Central Kurdish and English languages on their own copy indices and runs', async () => {
      const out = await encode(['ar-IQ', 'ckb', 'en-GB']);
      const xml = slide(out.bytes);
      const boxes = [...xml.matchAll(/<p:sp>.*?<\/p:sp>/gs)].map(m => m[0]).filter(s => s.includes('<a:t>'));
      expect(boxes).toHaveLength(3);
      for (const [i, locale] of ['ar-IQ', 'ckb', 'en-GB'].entries()) {
        expect([...boxes[i].matchAll(/\blang="([^"]+)"/g)].map(m => m[1]))
          .toEqual(expect.arrayContaining([locale]));
        expect([...boxes[i].matchAll(/\blang="([^"]+)"/g)].every(m => m[1] === locale)).toBe(true);
      }
      expect(out.manifest).toMatchObject({ copyLocales: ['ar-IQ', 'ckb', 'en-GB'], copy });
    });
    it.each([['ar'], ['ar', 'ckb', 'en', 'fr'], ['ar', 'ckb', 'en" dirty="0'], ['ar', 'ckb', '']])(
      'refuses misbound or invalid locale metadata %j', async (...locales) => {
        await expect(encode(locales)).rejects.toThrow(/copy locales|locale/i);
      },
    );
  });
}
