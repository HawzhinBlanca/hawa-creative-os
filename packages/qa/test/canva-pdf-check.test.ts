import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { checkCanvaPdf } from '../src/canva-pdf-check.js';

/**
 * ADR-258: a PDF read back from its file alone, built here as Canva writes one (measured on three real
 * exports, 2026-10-02): one page, Type0 fonts over CIDFontType2 with an embedded FontFile2 and a ToUnicode
 * map, text in a Flate content stream as literal strings of 2-byte codes (and sometimes hex strings).
 */
interface Line { text: string; hex?: boolean }
function pdf(options: { pages?: number; lines?: Line[]; embedded?: boolean; mediaBox?: string; imageWithBT?: boolean } = {}): Buffer {
  const lines = options.lines ?? [];
  // One code per distinct character, from 3 (as Canva's subsets do), and its ToUnicode map.
  const chars = [...new Set(lines.flatMap((l) => Array.from(l.text)))];
  const code = new Map(chars.map((c, i) => [c, i + 3]));
  const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n${chars.length} beginbfchar\n${chars.map((c) =>
    `<${hex4(code.get(c)!)}> <${Buffer.from(c, 'utf16le').swap16().toString('hex').toUpperCase()}>`).join('\n')}\nendbfchar\nendcmap end end`;
  const literal = (t: string) => {
    const bytes = Buffer.alloc(Array.from(t).length * 2);
    Array.from(t).forEach((c, i) => bytes.writeUInt16BE(code.get(c)!, i * 2));
    return '(' + [...bytes].map((b) => b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b)).join('') + ')';
  };
  const hexed = (t: string) => `<${Array.from(t).map((c) => hex4(code.get(c)!)).join('')}>`;
  const content = lines.map((l, i) => `BT\n/F21 40 Tf\n1 0 0 -1 0 ${100 + i * 60} Tm\n${l.hex ? hexed(l.text) : literal(l.text)} Tj\nET`).join('\n');
  const objs: string[] = [];
  const stream = (dict: string, data: Buffer) => `<< ${dict} /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream`;
  const pageCount = options.pages ?? 1;
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${10 + i} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objs[3] = stream('', deflateSync(Buffer.from(content, 'latin1')));
  objs[4] = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Inter /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>';
  objs[5] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Inter /FontDescriptor 7 0 R >>';
  objs[6] = stream('', deflateSync(Buffer.from(cmap, 'latin1')));
  objs[7] = `<< /Type /FontDescriptor /FontName /ABCDEF+Inter${options.embedded === false ? '' : ' /FontFile2 8 0 R'} >>`;
  objs[8] = stream('', deflateSync(Buffer.from('font program')));
  objs[9] = options.imageWithBT ? `<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /Length 12 >>\nstream\nBT (zz) Tj ET\nendstream` : '<< >>';
  for (let i = 0; i < pageCount; i++) {
    objs[10 + i] = `<< /Type /Page /Parent 2 0 R /MediaBox [${options.mediaBox ?? '0.0 7.50003 810.0 1020.0'}] /Resources << /Font << /F21 4 0 R >> /XObject << /X9 9 0 R >> >> /Contents 3 0 R >>`;
  }
  const body = objs.map((o, n) => (o === undefined ? '' : `${n} 0 obj\n${o}\nendobj\n`)).join('');
  return Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

describe('checkCanvaPdf (ADR-258)', () => {
  it('reads one page, its size, embedded fonts and the copy from literal and hex strings', () => {
    const r = checkCanvaPdf(pdf({ lines: [{ text: 'MEET KAAE AT' }, { text: 'SAGACON 2026', hex: true }, { text: 'Erbil (Main Hall) \\ 2026' }] }),
      ['MEET KAAE AT SAGACON 2026', 'Erbil (Main Hall) \\ 2026']);
    expect(r).toMatchObject({ pages: 1, pageSizePt: { width: 810, height: 1012.49997 }, fontsEmbedded: 1, liveText: true,
      copy: { checked: 2, found: 2, missing: [], visualOnly: 0 }, copyPass: true, pass: true, errors: [] });
  });

  it('a Latin line missing from the PDF fails the copy, naming it', () => {
    const r = checkCanvaPdf(pdf({ lines: [{ text: 'MEET KAAE AT' }] }), ['MEET KAAE AT', 'September 25, 2026']);
    expect(r).toMatchObject({ copyPass: false, pass: false, copy: { missing: ['September 25, 2026'] } });
    expect(r.errors[0]).toContain("'September 25, 2026'");
  });

  it('Arabic-script copy is visual only, never failed from the text layer', () => {
    const r = checkCanvaPdf(pdf({ lines: [{ text: 'K-12' }] }), ['چاپی 2.0']);
    expect(r).toMatchObject({ copy: { checked: 0, visualOnly: 1, missing: [] }, copyPass: null, pass: true });
  });

  it('two pages, a font not embedded, or copy with no live text each fail the structure', () => {
    expect(checkCanvaPdf(pdf({ pages: 2, lines: [{ text: 'A title' }] }), ['A title']).errors).toContain('Expected one page, found 2');
    expect(checkCanvaPdf(pdf({ embedded: false, lines: [{ text: 'A title' }] }), ['A title']).errors).toContain('1 font(s) not embedded');
    const flat = checkCanvaPdf(pdf({ lines: [] }), ['A title']);
    expect(flat).toMatchObject({ liveText: false, copyPass: false, pass: false });
    expect(flat.errors).toContain('No live text: the copy may have been flattened to a picture');
  });

  it('a picture whose bytes happen to contain text operators is never read as text', () => {
    const r = checkCanvaPdf(pdf({ imageWithBT: true, lines: [] }), []);
    expect(r.liveText).toBe(false);
    expect(r.textLayer).toBe('');
  });

  it('a file that is not a PDF says so', () => {
    expect(checkCanvaPdf(Buffer.from('PK\u0003\u0004 not a pdf'), []).errors).toContain('Not a PDF');
  });
});
