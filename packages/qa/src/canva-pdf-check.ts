/**
 * ADR-258: what a PDF Canva exports can be shown to hold, read from the file alone (no PDF library or
 * tool is installed on the host or in the containers). Measured on two real Canva PDFs (2026-10-02,
 * tasks 0bf7f225 and a4651ddd): one page; a MediaBox in points (810 × 1012.5 for a 1080 × 1350 design);
 * Type0/CIDFontType2 fonts, each embedded (`FontFile2`) with a `ToUnicode` map; the text in one Flate
 * content stream; no object or cross-reference streams.
 *
 * - Structure: page count, page size and aspect, fonts embedded, live text (text operators, not a picture).
 * - Copy: a Latin-script line is found exactly (spacing folded) in the text the ToUnicode maps give.
 *   Arabic-script text cannot be checked this way: Canva writes it as shaped glyphs in visual order, which
 *   map back to fragments (letters merged, reordered or dropped) even when the page is right. Such lines are
 *   reported as `visualOnly`, never as failed; the PNG of the same version is the evidence for them.
 */
import { inflateSync } from 'node:zlib';

export interface PdfExportCheck {
  source: 'canva_exported_pdf';
  pages: number;
  /** The first page's MediaBox width and height in points. */
  pageSizePt: { width: number; height: number } | null;
  fonts: number;
  fontsEmbedded: number;
  /** The page draws text with text operators (copy is live, not flattened to a picture). */
  liveText: boolean;
  images: number;
  /** Latin-script expected lines found / not found in the text layer; Arabic-script ones are visual only. */
  copy: { checked: number; found: number; missing: string[]; visualOnly: number };
  /** true: structure sound and every checkable line found; false: a structural failure or a missing line. */
  copyPass: boolean | null;
  pass: boolean;
  errors: string[];
  /** The text the ToUnicode maps give, spacing folded (Arabic script: glyph fragments in visual order). */
  textLayer: string;
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u;
const fold = (s: string) => s.normalize('NFKC').replace(/[‎‏⁦-⁩⁠​-‍]/gu, '').replace(/\s+/g, ' ').trim();

type Obj = { body: Buffer };
function objects(pdf: Buffer): Map<number, Obj> {
  const out = new Map<number, Obj>();
  const text = pdf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = text.indexOf('endobj', re.lastIndex);
    if (end < 0) break;
    out.set(Number(m[1]), { body: pdf.subarray(re.lastIndex, end) });
    re.lastIndex = end + 6;
  }
  return out;
}
/** Inflated bytes one stream, and all streams together, may reach: a deflate bomb must not exhaust memory. */
const STREAM_LIMIT = 32 * 1024 * 1024;
const TOTAL_STREAM_LIMIT = 256 * 1024 * 1024;
/** ToUnicode entries one map may declare: a CID font has at most 65,536 codes. */
const CMAP_ENTRY_LIMIT = 1 << 20;

function streamOf(body: Buffer, budget: { left: number }): Buffer | null {
  const t = body.toString('latin1');
  const start = /stream\r?\n/.exec(t);
  if (!start) return null;
  const from = start.index + start[0].length;
  const to = t.lastIndexOf('endstream');
  if (to < from) return null;
  let data = body.subarray(from, to);
  if (data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - (data[data.length - 2] === 0x0d ? 2 : 1));
  if (/\/FlateDecode/.test(t.slice(0, start.index))) {
    let inflated: Buffer;
    try {
      inflated = inflateSync(data, { maxOutputLength: Math.max(1, Math.min(STREAM_LIMIT, budget.left)) });
    } catch (err) {
      if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PDF stream exceeds inspection limit');
      return null;
    }
    budget.left -= inflated.length;
    return inflated;
  }
  return data;
}
/**
 * A ToUnicode CMap (PDF 32000-1 9.10.3). A destination is UTF-16BE and may hold several code units (a
 * ligature, or a surrogate pair); a range's destination increments its last code unit, or is an array
 * giving each code its own string.
 */
function toUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  let entries = 0;
  const count = (n: number) => { if ((entries += n) > CMAP_ENTRY_LIMIT) throw new Error('ToUnicode map exceeds inspection limit'); };
  const utf16 = (hex: string) => Buffer.from(hex.length % 4 ? hex.padEnd(hex.length + 4 - (hex.length % 4), '0') : hex, 'hex')
    .swap16().toString('utf16le');
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const [, code, uni] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) { count(1); map.set(parseInt(code, 16), utf16(uni)); }
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const [, a, z, uni, list] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const from = parseInt(a, 16), to = Math.min(parseInt(z, 16), from + 65535);
      if (!(to >= from)) continue;
      count(to - from + 1);
      if (list !== undefined) {
        const items = [...list.matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => utf16(m[1]));
        items.slice(0, to - from + 1).forEach((item, i) => map.set(from + i, item));
        continue;
      }
      const base = utf16(uni!);
      const head = base.slice(0, -1), last = base.charCodeAt(base.length - 1);
      for (let c = from; c <= to; c++) map.set(c, head + String.fromCharCode((last + c - from) & 0xffff));
    }
  }
  return map;
}

export function checkCanvaPdf(
  bytes: Uint8Array,
  expectedCopy: string[] = [],
  /**
   * ADR-275: blocks set in capitals, by copy index. A PDF's text layer holds the capitals Canva drew,
   * so these lines are found without regard to case; every other line is found exactly.
   */
  options: { uppercaseByIndex?: boolean[] } = {}
): PdfExportCheck {
  const pdf = Buffer.from(bytes);
  const errors: string[] = [];
  if (pdf.length > 50 * 1024 * 1024) throw new Error('PDF exceeds inspection limit');
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') errors.push('Not a PDF');
  const objs = objects(pdf);
  const budget = { left: TOTAL_STREAM_LIMIT };
  const bodies = [...objs.values()].map((o) => o.body.toString('latin1'));
  const pages = bodies.filter((b) => /\/Type\s*\/Page(?![s\w])/.test(b));
  const box = pages[0] && /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(pages[0]);
  const pageSizePt = box ? { width: Number(box[3]) - Number(box[1]), height: Number(box[4]) - Number(box[2]) } : null;
  const cidFonts = bodies.filter((b) => /\/Subtype\s*\/(CIDFontType[02]|TrueType|Type1)\b/.test(b) && /\/FontDescriptor/.test(b)).length;
  const descriptors = bodies.filter((b) => /\/Type\s*\/FontDescriptor/.test(b));
  const fontsEmbedded = descriptors.filter((b) => /\/FontFile[23]?\b/.test(b)).length;
  const images = bodies.filter((b) => /\/Subtype\s*\/Image\b/.test(b)).length;

  // Fonts with a ToUnicode map, by object number, and the resource names pages use for them.
  const maps = new Map<number, Map<number, string>>();
  for (const [n, o] of objs) {
    const b = o.body.toString('latin1');
    const ref = /\/Type\s*\/Font\b/.test(b) && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(b);
    const cmap = ref && objs.get(Number(ref[1]));
    const data = cmap && streamOf(cmap.body, budget);
    if (data) maps.set(n, toUnicode(data.toString('latin1')));
  }
  const names = new Map<string, number>();
  for (const b of bodies) for (const [, name, ref] of b.matchAll(/\/([\w.-]+)\s+(\d+)\s+0\s+R/g)) if (maps.has(Number(ref))) names.set(name, Number(ref));
  let liveText = false;
  const pieces: string[] = [];
  /** A literal string's bytes: `\\(`, `\\)`, `\\\\`, `\\n` and octal escapes; the 2-byte codes of an Identity-H font. */
  const literal = (body: string): Buffer => {
    const out: number[] = [];
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c !== 0x5c) { out.push(c & 0xff); continue; }
      const n = body[++i];
      if (n === undefined) break;
      if (/[0-7]/.test(n)) { let oct = n; while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i]; out.push(parseInt(oct, 8) & 0xff); }
      else if (n === 'n') out.push(10); else if (n === 'r') out.push(13); else if (n === 't') out.push(9);
      else if (n === 'b') out.push(8); else if (n === 'f') out.push(12); else if (n === '\r' || n === '\n') { if (n === '\r' && body[i + 1] === '\n') i++; }
      else out.push(n.charCodeAt(0) & 0xff);
    }
    return Buffer.from(out);
  };
  const decode = (codes: Buffer, font: Map<number, string>) => {
    let s = '';
    for (let i = 0; i + 1 < codes.length; i += 2) s += font.get(codes.readUInt16BE(i)) ?? '';
    return s;
  };
  for (const o of objs.values()) {
    const head = o.body.toString('latin1', 0, Math.min(o.body.length, 4096));
    // Pictures are never text, whatever their bytes happen to contain.
    if (/\/Subtype\s*\/Image\b/.test(head) || !/stream\r?\n/.test(head)) continue;
    const data = streamOf(o.body, budget);
    if (!data) continue;
    const ops = data.toString('latin1');
    if (!/\bBT\b/.test(ops) || !/T[jJ]\b|'|"/.test(ops)) continue;
    let font: Map<number, string> | undefined;
    let any = false;
    // Font selections, hex strings, literal strings, and line or block ends. A literal string may hold
    // balanced parentheses unescaped (PDF 32000-1 7.3.4.2), so it is read to its matching ")" by hand.
    const tokens = /\/([\w.-]+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f\s]+)>|(\()|\bET\b|\bT\*|\bTd\b|\bTD\b/g;
    for (let tok = tokens.exec(ops); tok; tok = tokens.exec(ops)) {
      if (tok[1]) font = maps.get(names.get(tok[1]) ?? -1);
      else if (tok[2] !== undefined) { if (font) { pieces.push(decode(Buffer.from(tok[2].replace(/\s+/g, ''), 'hex'), font)); any = true; } }
      else if (tok[3] !== undefined) {
        let depth = 1, i = tokens.lastIndex;
        for (; i < ops.length && depth; i++) {
          if (ops[i] === '\\') i++;
          else if (ops[i] === '(') depth++;
          else if (ops[i] === ')') depth--;
        }
        if (depth) break;
        if (font) { pieces.push(decode(literal(ops.slice(tokens.lastIndex, i - 1)), font)); any = true; }
        tokens.lastIndex = i;
      } else pieces.push(' ');
    }
    if (any) liveText = true;
  }
  const layer = fold(pieces.join(''));
  const squeezed = layer.replace(/\s+/g, '');
  const latin = expectedCopy.filter((line) => fold(line) && !ARABIC.test(line));
  const upperLayer = layer.toUpperCase();
  const upperSqueezed = squeezed.toUpperCase();
  const missing = expectedCopy.map((line, i) => ({ line, caps: options.uppercaseByIndex?.[i] === true }))
    .filter(({ line }) => fold(line) && !ARABIC.test(line))
    .filter(({ line, caps }) => caps
      ? !upperLayer.includes(fold(line).toUpperCase()) && !upperSqueezed.includes(fold(line).replace(/\s+/g, '').toUpperCase())
      : !layer.includes(fold(line)) && !squeezed.includes(fold(line).replace(/\s+/g, '')))
    .map(({ line }) => line);
  const copy = { checked: latin.length, found: latin.length - missing.length, missing, visualOnly: expectedCopy.length - latin.length };

  if (pages.length !== 1) errors.push(`Expected one page, found ${pages.length}`);
  if (!pageSizePt || !(pageSizePt.width > 0 && pageSizePt.height > 0)) errors.push('No page size');
  if (descriptors.length && fontsEmbedded < descriptors.length) errors.push(`${descriptors.length - fontsEmbedded} font(s) not embedded`);
  if (expectedCopy.length && !liveText) errors.push('No live text: the copy may have been flattened to a picture');
  if (missing.length) errors.push(`Copy not found in the PDF: ${missing.map((l) => `'${l.slice(0, 40)}'`).join(', ')}`);
  const copyPass = expectedCopy.length === 0 ? null : (!liveText || missing.length ? false : latin.length ? true : null);
  return { source: 'canva_exported_pdf', pages: pages.length, pageSizePt, fonts: cidFonts, fontsEmbedded, liveText, images, copy, copyPass,
    pass: errors.length === 0, errors, textLayer: layer.slice(0, 4000) };
}
