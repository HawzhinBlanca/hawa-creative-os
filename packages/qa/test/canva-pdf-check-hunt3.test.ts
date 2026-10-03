import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { checkCanvaPdf } from '../src/canva-pdf-check.js';

/**
 * Hunt 3 (2026-10-03): the PDF readback on files a PDF writer may legally produce and the earlier tests
 * did not build: ToUnicode ranges with several code units or the array form, balanced parentheses left
 * unescaped in a literal string, short copy lines found inside longer ones, and oversized streams.
 */
const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
const utf16 = (s: string) => Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase();

function pdf(content: string, cmap: string, extra: Buffer[] = []): Buffer {
  const stream = (data: Buffer) => `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream`;
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [10 0 R] /Count 1 >>';
  objs[3] = stream(deflateSync(Buffer.from(content, 'latin1')));
  objs[4] = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Inter /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>';
  objs[5] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Inter /FontDescriptor 7 0 R >>';
  objs[6] = stream(deflateSync(Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n${cmap}\nendcmap end end`, 'latin1')));
  objs[7] = '<< /Type /FontDescriptor /FontName /ABCDEF+Inter /FontFile2 8 0 R >>';
  objs[8] = stream(deflateSync(Buffer.from('font program')));
  extra.forEach((data, i) => { objs[20 + i] = `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream`; });
  objs[10] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 810 1012.5] /Resources << /Font << /F21 4 0 R >> >> /Contents 3 0 R >>';
  const body = objs.map((o, n) => (o === undefined ? '' : `${n} 0 obj\n${o}\nendobj\n`)).join('');
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}
/** A one-to-one bfchar map from code 3 for the characters of `lines`, and each line as a hex string. */
function simple(lines: string[]) {
  const chars = [...new Set(lines.flatMap((l) => Array.from(l)))];
  const code = new Map(chars.map((c, i) => [c, i + 3]));
  const cmap = `${chars.length} beginbfchar\n${chars.map((c) => `<${hex4(code.get(c)!)}> <${utf16(c)}>`).join('\n')}\nendbfchar`;
  const content = lines.map((l, i) => `BT\n/F21 40 Tf\n1 0 0 -1 0 ${100 + i * 60} Tm\n<${Array.from(l).map((c) => hex4(code.get(c)!)).join('')}> Tj\nET`).join('\n');
  return { cmap, content, code };
}

describe('ToUnicode ranges (PDF 32000-1 9.10.3)', () => {
  it('reads a range whose destination has several code units, and the array form', () => {
    // <0010> maps to "fi" (a ligature), <0011> to an emoji (a surrogate pair): one-entry ranges.
    // <0020>..<0022> map through the array form to "K", "A", "E".
    const cmap = '2 beginbfrange\n<0010> <0010> <00660069>\n<0011> <0011> <D83CDF89>\nendbfrange\n' +
      '1 beginbfrange\n<0020> <0022> [<004B> <0041> <0045>]\nendbfrange\n' +
      '2 beginbfchar\n<0003> <0020>\n<0004> <0067>\nendbfchar';
    const content = 'BT /F21 40 Tf <001000040003002100200021002200030011> Tj ET';
    const r = checkCanvaPdf(pdf(content, cmap), ['fig AKAE 🎉']);
    expect(r.textLayer).toBe('fig AKAE 🎉');
    expect(r).toMatchObject({ copyPass: true, pass: true });
  });
});

describe('literal strings', () => {
  it('reads balanced parentheses a writer left unescaped', () => {
    // Code 0x0028 is the byte pair 00 28: "(" inside the string. Balanced pairs need no escape.
    const cmap = '3 beginbfchar\n<0028> <0041>\n<0029> <0042>\n<0003> <0043>\nendbfchar';
    const content = 'BT /F21 40 Tf (\u0000(\u0000\u0003\u0000)) Tj ET';
    const r = checkCanvaPdf(pdf(content, cmap), ['ACB']);
    expect(r.textLayer).toBe('ACB');
    expect(r.copyPass).toBe(true);
  });
});

describe('each copy line is found once, in its own place', () => {
  it('a short line found only inside a longer line is missing', () => {
    const { cmap, content } = simple(['KAAE SUMMIT 2026']);
    const r = checkCanvaPdf(pdf(content, cmap), ['KAAE', 'KAAE SUMMIT 2026']);
    expect(r.copy.missing).toEqual(['KAAE']);
    expect(r.copyPass).toBe(false);
    // Both drawn: both found.
    const both = simple(['KAAE', 'KAAE SUMMIT 2026']);
    expect(checkCanvaPdf(pdf(both.content, both.cmap), ['KAAE', 'KAAE SUMMIT 2026']).copyPass).toBe(true);
  });

  it('a line the copy holds twice must be drawn twice', () => {
    const once = simple(['Erbil', 'Join us']);
    expect(checkCanvaPdf(pdf(once.content, once.cmap), ['Erbil', 'Join us', 'Erbil']).copy.missing).toEqual(['Erbil']);
    const twice = simple(['Erbil', 'Join us', 'Erbil']);
    expect(checkCanvaPdf(pdf(twice.content, twice.cmap), ['Erbil', 'Join us', 'Erbil']).copyPass).toBe(true);
  });

  it('still finds a line Canva set on two lines, and in any order', () => {
    const { cmap, content } = simple(['SUMMIT', 'Peer Review', 'Week']);
    expect(checkCanvaPdf(pdf(content, cmap), ['Peer Review Week', 'SUMMIT']).copyPass).toBe(true);
  });
});

describe('inspection limits', () => {
  it('refuses a stream that inflates past the limit instead of exhausting memory', () => {
    const { cmap, content } = simple(['A title']);
    const bomb = deflateSync(Buffer.alloc(80 * 1024 * 1024));
    expect(() => checkCanvaPdf(pdf(content, cmap, [bomb]), ['A title'])).toThrow(/inspection limit/);
  });

  it('refuses a ToUnicode map that declares more codes than a font can hold', () => {
    const ranges = Array.from({ length: 64 }, (_, i) => `<0000> <FFFF> <${hex4(i * 16)}>`).join('\n');
    const content = 'BT /F21 40 Tf <0003> Tj ET';
    expect(() => checkCanvaPdf(pdf(content, `64 beginbfrange\n${ranges}\nendbfrange`), ['A'])).toThrow(/inspection limit/);
  });
});
