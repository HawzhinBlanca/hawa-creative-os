import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as fontkit from 'fontkit';
import bidiModule, { type Bidi } from 'bidi-js';
import { PNG } from 'pngjs';
import { displayedCopy, type TextElement } from './layout-v2.js';
import { effectiveLetterSpacingEm, fittedTextOf, fontFaceSupports, fontFileFor, wrappedLinesOf, type RenderLayoutOptions } from './render-layout-v2.js';
import { defaultFontsDir } from './font-environment.js';
import { measurePangoText } from './pango-measurement.js';

/**
 * ADR-290: whether the Sorani (Arabic-script) text in a rendered poster is shaped, joined, ordered and
 * wrapped as designed, read from the pixels alone.
 *
 * The copy checks (ADR-258, `checkCanvaPptx`, `checkCanvaPdf`) compare characters, and `countInkLines`
 * counts lines; none of them sees letters drawn unjoined, a line drawn in reverse, a box of a missing
 * glyph, or a face the rasteriser substituted (fc-match and the font probes miss it: see ADR-118 and the
 * font-rendering notes). This check draws each designed line itself and compares the drawing with the
 * line in the picture:
 *
 * - the line is shaped with the very font file the design was measured with (fontkit, which applies the
 *   face's own GSUB joining forms and GPOS mark positions), after the Unicode bidi algorithm (bidi-js)
 *   has split it into directional runs and put them in visual order: digits and Latin inside a Kurdish
 *   line read left to right, as every bidi renderer draws them;
 * - the glyph outlines are rasterised here, with coverage, at the picture's scale;
 * - the picture's ink is read in the block's box: exactly, by unmixing the text colour from the
 *   text-free render when one is given (the Studio renderer makes one), otherwise by distance from the
 *   text colour (a Canva export);
 * - the ink is split into lines (each dot and mark going with the letter it belongs to); each line is
 *   matched with its drawing by normalised cross-correlation of the two, blurred by a small fraction of
 *   the type size, in windows two ems wide, so a single broken join fails its window in a long line.
 *
 * A line that does not match is explained by drawing what a defect would look like and keeping the
 * explanation that matches: the copy re-wrapped (`wrapped-differently`), the letters reversed or the
 * runs in the wrong order (`wrong-direction`), the letters drawn unjoined or in another face
 * (`shaping-mismatch`), or boxes where glyphs should be (`missing-glyphs`). Deterministic, no model, no
 * process spawned by the check itself. Advisory: it never changes a pass or a block (ADR-257's rule).
 */

export type ShapingVerdict = 'ok' | 'wrapped-differently' | 'shaping-mismatch' | 'missing-glyphs' | 'wrong-direction';

export interface ShapingBlockInput {
  /** A name for the block in the report (e.g. `text-copy-0`). */
  id: string;
  /** The lines the design sets the block on, in logical order, as the renderer wrapped them. */
  lines: string[];
  /** The font file the design was measured (and is meant to be drawn) with. */
  fontFile: string;
  /** The type size in the picture's pixels. */
  fontSizePx: number;
  /** Tracking in the picture's pixels (0 for Arabic script: tracking breaks joining). */
  letterSpacingPx?: number;
  /** Line pitch as a multiple of the type size. */
  lineHeight: number;
  /** Faces a character the block's face lacks is drawn from, in order (what the renderer fell back to). */
  fallbackFontFiles?: string[];
  /** The block's box in the picture's pixels. */
  box: { x: number; y: number; width: number; height: number };
  /** Base direction of the block. */
  rtl: boolean;
  /** Every colour the block's ink may be drawn in (the text colour, an accent colour). */
  colors: string[];
  /** Why the block cannot be checked (the renderer could not set it either); reported as unmeasured. */
  unmeasurable?: string;
}

export interface ShapingLineReport {
  /** The designed line's index, or the found line's index when the block wraps differently. */
  index: number;
  verdict: ShapingVerdict;
  /** Lowest windowed correlation between the picture and the designed line (1 is identical). */
  score: number;
  /** Ink width in the picture over the designed line's ink width. */
  widthRatio: number | null;
  /** Why the verdict was given, in words. */
  detail?: string;
}

export interface ShapingBlockReport {
  id: string;
  verdict: ShapingVerdict;
  designedLines: number;
  foundLines: number;
  lines: ShapingLineReport[];
}

export interface TextShapingFidelity {
  /** Every measured block is drawn as designed. */
  pass: boolean;
  blocks: ShapingBlockReport[];
  /** Blocks that could not be measured, with why (no ink found, a glyph the face lacks...). */
  unmeasured: Array<{ id: string; reason: string }>;
  warnings: string[];
  /** Wall time of the check in milliseconds. */
  ms: number;
}

export interface ShapingCheckOptions {
  /** The same picture without its text (the Studio renderer's `noTextPng`): ink is then read exactly. */
  background?: Buffer | ShapingPicture;
}

export interface ShapingPicture { width: number; height: number; data: Uint8Array | Buffer }

/**
 * Correlation every window of a line must reach in a provider's export (no text-free picture: ink read
 * by colour, another rasteriser, the provider's own build of the face). Calibrated in ADR-290.
 */
export const SHAPING_MATCH_SCORE = 0.90;
/** The same for the Studio render, read exactly against its text-free render (ADR-290). */
export const SHAPING_MATCH_SCORE_EXACT = 0.93;
/**
 * How far both inks are blurred before they are compared, in ems: just over a stroke's anti-aliasing for
 * the Studio render; a little more for a provider, whose rasteriser and build of the face draw strokes a
 * hair heavier or lighter (ADR-290 measured the separation at both).
 */
const BLUR_EXACT = 0.035, BLUR_PROVIDER = 0.05;
/** A line whose ink is wider or narrower than its drawing by more than this share is not the line drawn. */
export const SHAPING_WIDTH_TOLERANCE = 0.06;

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
/** Whether text carries Arabic-script letters (the blocks this check is for). */
export const hasArabicScript = (text: string) => ARABIC.test(text);

// ---------------------------------------------------------------------------------------------
// Shaping: bidi runs in visual order, each shaped by fontkit with the run's own direction.
// ---------------------------------------------------------------------------------------------

const fk = ((fontkit as any).default || fontkit) as typeof fontkit;
/**
 * Two parsed copies of each face: one only ever shapes, one only ever draws. fontkit caches a glyph
 * object by id with the code points it was first asked for, and its Arabic shaper reads a glyph's joining
 * type from those code points. Reading the outline of a composite glyph creates its components with no
 * code points: in IBM Plex Sans Arabic the final form of U+06D5 is built on the heh glyph, so after one
 * line with U+06D5 was drawn every later U+0647 shaped as non-joining (a title measured 506 px, not 529).
 * The shaping copy never reads an outline, so what it shapes does not depend on what was drawn before.
 */
const fonts = new Map<string, { sha256: string; shape: any; draw: any }>();
function openFont(file: string, role: 'shape' | 'draw' = 'shape'): any {
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let cached = fonts.get(file);
  if (cached?.sha256 !== sha256) {
    cached = { sha256, shape: fk.create(bytes), draw: fk.create(bytes) };
    if (fonts.size >= 32) fonts.delete(fonts.keys().next().value!);
    fonts.set(file, cached);
  }
  return cached[role];
}

// bidi-js is a CommonJS module whose export is the factory; its types describe an ES default export.
const bidiFactory = (typeof bidiModule === 'function' ? bidiModule : (bidiModule as { default: unknown }).default) as () => Bidi;
let bidi: Bidi | undefined;
const bidiOf = () => (bidi ??= bidiFactory());

/** `loose`: not scored (see shapeLine); `breaks`: a digit, punctuation or symbol, which ends a run of letters. */
interface PlacedGlyph { file: string; id: number; x: number; y: number; advance: number; loose: boolean; breaks: boolean }
export interface ShapedLine { glyphs: PlacedGlyph[]; advance: number; missing: number[] }

/** How a line is turned into glyphs: as designed, or as a defect would draw it. */
export type ShapeMode = 'designed' | 'reversed' | 'base-ltr' | 'unjoined';

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const ZWJ = '\u200D';

/** Arabic letters that join only the letter before them (Unicode joining type R), as ranges. */
const RIGHT_JOINING: Array<[number, number]> = [[0x0622, 0x0625], [0x0627, 0x0627], [0x0629, 0x0629], [0x062F, 0x0632], [0x0648, 0x0648],
  [0x0671, 0x0673], [0x0675, 0x0677], [0x0688, 0x0699], [0x06C0, 0x06C0], [0x06C3, 0x06CB], [0x06CD, 0x06CD], [0x06CF, 0x06CF],
  [0x06D2, 0x06D3], [0x06D5, 0x06D5], [0x06EE, 0x06EF], [0x0759, 0x075B], [0x076B, 0x076C], [0x0771, 0x0771], [0x0773, 0x0774],
  [0x0778, 0x0779], [0x08AA, 0x08AC], [0x08AE, 0x08AE], [0x08B1, 0x08B2], [0x08B9, 0x08B9]];
/**
 * How a character joins (Unicode joining types): D both sides, R the letter before only, C causes
 * joining (tatweel, ZWJ), T transparent (marks), U not at all. Enough of ArabicShaping.txt for the
 * Arabic, Supplement and Extended-A letters.
 */
function joiningType(ch: string): 'D' | 'R' | 'C' | 'T' | 'U' {
  const cp = ch.codePointAt(0)!;
  if (/\p{Mn}/u.test(ch)) return 'T';
  if (cp === 0x0640 || cp === 0x200D) return 'C';
  if (RIGHT_JOINING.some(([a, b]) => cp >= a && cp <= b)) return 'R';
  if ((cp >= 0x0620 && cp <= 0x064A) || (cp >= 0x066E && cp <= 0x06D3) || (cp >= 0x06FA && cp <= 0x06FC) || cp === 0x06FF ||
    (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0x08A0 && cp <= 0x08C8)) return cp === 0x0621 || cp === 0x0674 ? 'U' : 'D';
  return 'U';
}
/** Not a letter, a mark or a space: digits, punctuation, symbols. */
const LOOSE = /[^\p{L}\p{M}\s]/u;

/**
 * Shapes one line. `designed`: the Unicode bidi algorithm with the block's base direction. The defect
 * hypotheses: `reversed` (the characters drawn in reverse, what a renderer that reverses before shaping
 * draws), `base-ltr` (the right-to-left line set with a left-to-right base, so its runs swap places),
 * `unjoined` (every letter in its isolated form).
 *
 * `fontFiles` is the face the block is set in, then the faces a character it lacks is drawn from.
 * Characters drawn from a fallback face, and digits, punctuation and symbols, are marked `loose`: a
 * provider draws them from faces of its own (Canva's Arabic digits are not the bundled file's), so the
 * match does not score them, though they still take their place in the line.
 *
 * Default-ignorable characters (ZWNJ, ZWJ, word joiners) are not handed to fontkit: the text is cut
 * there and each piece shaped alone, which is what a ZWNJ does to joining. fontkit hides them by the
 * code points a cached glyph was first created with, which could hide real spaces in later lines.
 */
export function shapeLine(fontFiles: string | string[], text: string, rtl: boolean, sizePx: number, letterSpacingPx = 0, mode: ShapeMode = 'designed',
  looseFallbackWords = false): ShapedLine {
  const files = Array.isArray(fontFiles) ? fontFiles : [fontFiles];
  const faces = files.map((f) => openFont(f));
  let line = text.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '');
  if (mode === 'reversed') line = Array.from(line).reverse().join('');
  const faceOf = (cp: number) => faces.findIndex((f) => f.glyphForCodePoint(cp).id !== 0);
  const missing = [...new Set(Array.from(line).map((ch) => ch.codePointAt(0)!)
    .filter((cp) => !/[\s\p{Default_Ignorable_Code_Point}]/u.test(String.fromCodePoint(cp)) && faceOf(cp) < 0))];
  const b = bidiOf();
  const base = mode === 'base-ltr' ? 'ltr' : rtl ? 'rtl' : 'ltr';
  const levels = b.getEmbeddingLevels(line, base);
  const mirrored = b.getMirroredCharactersMap(line, levels.levels);
  const chars = line.split('').map((c, i) => mirrored.get(i) ?? c);
  // Level runs in logical order (UTF-16 indices; surrogate pairs share a level).
  const runs: Array<{ start: number; end: number; level: number }> = [];
  for (let i = 0; i < line.length; i++) {
    const level = levels.levels[i];
    const last = runs.at(-1);
    if (last && last.level === level) last.end = i + 1;
    else runs.push({ start: i, end: i + 1, level });
  }
  // Visual order of the runs: the reorder segments say which logical ranges are reversed, in turn.
  const order = Array.from({ length: line.length }, (_, i) => i);
  for (const [start, end] of b.getReorderSegments(line, levels)) {
    const part = order.slice(start, end + 1).reverse();
    order.splice(start, part.length, ...part);
  }
  const visualAt = new Map(order.map((logical, visual) => [logical, visual]));
  const visualRuns = [...runs].sort((a, c) => visualAt.get(a.start)! - visualAt.get(c.start)!);
  const glyphs: PlacedGlyph[] = [];
  let pen = 0;
  for (const run of visualRuns) {
    const rtlRun = run.level % 2 === 1;
    // The run cut into pieces each shaped alone: at an ignorable, where the face changes, where letters
    // meet digits or punctuation, and (unjoined) between every letter and the next.
    const pieces: Array<{ text: string; face: number; loose: boolean; breaks: boolean }> = [];
    const runChars = Array.from(chars.slice(run.start, run.end).join(''));
    // With `looseFallbackWords`, every letter of a word that needs a fallback face is loose: a provider
    // draws such a word from one face of its own, so its neighbours' joined forms differ too.
    const fallbackWord = new Uint8Array(runChars.length);
    if (looseFallbackWords) {
      let from = 0;
      for (let i = 0; i <= runChars.length; i++) {
        if (i < runChars.length && !/\s/.test(runChars[i])) continue;
        if (runChars.slice(from, i).some((c) => /\p{L}/u.test(c) && faceOf(c.codePointAt(0)!) > 0)) fallbackWord.fill(1, from, i);
        from = i + 1;
      }
    }
    for (const [i, ch] of runChars.entries()) {
      if (IGNORABLE.test(ch)) { pieces.push({ text: '', face: -1, loose: false, breaks: false }); continue; }
      const cp = ch.codePointAt(0)!;
      const mark = /\p{M}/u.test(ch);
      const last = pieces.at(-1);
      const face = /\s/.test(ch) && last && last.face >= 0 ? last.face : Math.max(0, faceOf(cp));
      const breaks = LOOSE.test(ch) && !mark;
      const loose = face > 0 || breaks || fallbackWord[i] === 1;
      if (last && last.face >= 0 && (mark || (last.face === face && last.loose === loose && last.breaks === breaks && mode !== 'unjoined'))) last.text += ch;
      else pieces.push({ text: ch, face, loose, breaks });
    }
    // Where a face change cuts a word, each side is shaped with a ZWJ standing for the letter across the
    // cut, so it keeps its joined form (Pango shapes a fallback run with its neighbours as context).
    // The ZWJ's glyph (zero advance) is dropped again: it is the run's visual end on its side.
    const lastJoin = (t: string) => { const c = Array.from(t).reverse().find((x) => joiningType(x) !== 'T'); return c ? joiningType(c) : 'U'; };
    const firstJoin = (t: string) => { const c = Array.from(t).find((x) => joiningType(x) !== 'T'); return c ? joiningType(c) : 'U'; };
    pieces.forEach((piece, i) => {
      const before = pieces[i - 1], after = pieces[i + 1];
      (piece as { lead?: boolean }).lead = Boolean(mode !== 'unjoined' && before?.text && before.face !== piece.face && ['D', 'C'].includes(lastJoin(before.text)) && ['D', 'R', 'C'].includes(firstJoin(piece.text)));
      (piece as { trail?: boolean }).trail = Boolean(mode !== 'unjoined' && after?.text && after.face !== piece.face && ['D', 'C'].includes(lastJoin(piece.text)) && ['D', 'R', 'C'].includes(firstJoin(after.text)));
    });
    for (const piece of rtlRun ? pieces.reverse() : pieces) {
      if (!piece.text) continue;
      const font = faces[piece.face];
      const scale = sizePx / font.unitsPerEm;
      const { lead, trail } = piece as { lead?: boolean; trail?: boolean };
      const shaped = font.layout(`${lead ? ZWJ : ''}${piece.text}${trail ? ZWJ : ''}`, undefined, undefined, undefined, rtlRun ? 'rtl' : 'ltr');
      // In visual order a right-to-left run ends with its first character's glyph and starts with its last.
      const drop = new Set<number>();
      const n = shaped.glyphs.length;
      if (lead) drop.add(rtlRun ? n - 1 : 0);
      if (trail) drop.add(rtlRun ? 0 : n - 1);
      shaped.glyphs.forEach((glyph: any, k: number) => {
        if (drop.has(k)) return;
        const p = shaped.positions[k];
        const advance = p.xAdvance * scale + (p.xAdvance ? letterSpacingPx : 0);
        glyphs.push({ file: files[piece.face], id: glyph.id, x: pen + p.xOffset * scale, y: p.yOffset * scale, advance, loose: piece.loose, breaks: piece.breaks });
        pen += advance;
      });
    }
  }
  return { glyphs, advance: pen, missing };
}

// ---------------------------------------------------------------------------------------------
// Rasterising: glyph outlines flattened to edges, filled non-zero with 4 sub-rows a pixel.
// ---------------------------------------------------------------------------------------------

interface Coverage { width: number; height: number; data: Float32Array }
interface Drawn extends Coverage { ink: { x0: number; x1: number; y0: number; y1: number } | null; loose: Uint8Array; hasLoose: boolean;
  /** Column spans of the runs of letters between digits, punctuation and symbols, in visual order. */
  segments: Array<[number, number]> }

const SUB = 4;

function flatten(commands: Array<{ command: string; args: number[] }>, ox: number, oy: number, scale: number): number[][] {
  // Edges as [x0, y0, x1, y1] in pixels (y down).
  const edges: number[][] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const X = (x: number) => ox + x * scale, Y = (y: number) => oy - y * scale;
  const line = (x: number, y: number) => { edges.push([X(cx), Y(cy), X(x), Y(y)]); cx = x; cy = y; };
  for (const { command, args } of commands) {
    if (command === 'moveTo') { if (cx !== sx || cy !== sy) line(sx, sy); cx = sx = args[0]; cy = sy = args[1]; }
    else if (command === 'lineTo') line(args[0], args[1]);
    else if (command === 'quadraticCurveTo') {
      const [qx, qy, x, y] = args, x0 = cx, y0 = cy;
      const n = Math.max(2, Math.min(16, Math.ceil(Math.hypot(x - x0, y - y0) * scale / 3)));
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; line(u * u * x0 + 2 * u * t * qx + t * t * x, u * u * y0 + 2 * u * t * qy + t * t * y); }
    } else if (command === 'bezierCurveTo') {
      const [ax, ay, bx, by, x, y] = args, x0 = cx, y0 = cy;
      const n = Math.max(2, Math.min(24, Math.ceil(Math.hypot(x - x0, y - y0) * scale / 3)));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        line(u * u * u * x0 + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x, u * u * u * y0 + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y);
      }
    } else if (command === 'closePath') { if (cx !== sx || cy !== sy) line(sx, sy); }
  }
  if (cx !== sx || cy !== sy) line(sx, sy);
  return edges;
}

/** Fills edges into a coverage map (non-zero winding), exact across a row, 4 samples down a pixel. */
function fill(edges: number[][], width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const live = edges.filter((e) => e[1] !== e[3]).map(([x0, y0, x1, y1]) => y0 < y1 ? { x0, y0, x1, y1, dir: 1 } : { x0: x1, y0: y1, x1: x0, y1: y0, dir: -1 });
  live.sort((a, b) => a.y0 - b.y0);
  const row = new Float32Array(width + 1);
  for (let py = 0; py < height; py++) {
    row.fill(0);
    let any = false;
    for (let s = 0; s < SUB; s++) {
      const y = py + (s + 0.5) / SUB;
      const hits: Array<[number, number]> = [];
      for (const e of live) {
        if (e.y0 > y) break;
        if (e.y1 <= y) continue;
        hits.push([e.x0 + (y - e.y0) * (e.x1 - e.x0) / (e.y1 - e.y0), e.dir]);
      }
      if (hits.length < 2) continue;
      hits.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let k = 0; k < hits.length - 1; k++) {
        wind += hits[k][1];
        if (!wind) continue;
        const a = Math.max(0, hits[k][0]), b = Math.min(width, hits[k + 1][0]);
        if (b <= a) continue;
        any = true;
        const ia = Math.floor(a), ib = Math.floor(b);
        if (ia === ib) { row[ia] += (b - a) / SUB; continue; }
        row[ia] += (ia + 1 - a) / SUB;
        for (let i = ia + 1; i < ib; i++) row[i] += 1 / SUB;
        if (ib < width) row[ib] += (b - ib) / SUB;
      }
    }
    if (!any) continue;
    for (let x = 0; x < width; x++) out[py * width + x] = Math.min(1, row[x]);
  }
  return out;
}

/**
 * Draws a shaped line on its own canvas with a margin of half an em. `ink` is its ink box; `loose`
 * marks the columns of loose glyphs (see shapeLine), which the match does not score.
 */
function drawLine(shaped: ShapedLine, sizePx: number): Drawn {
  // Validate each file's content once for this drawing, rather than reading and hashing the
  // same font again for every glyph. Retain separate shaping/outline faces (ADR-290).
  const faces = new Map([...new Set(shaped.glyphs.map((g) => g.file))].map((f) => [f, openFont(f, 'draw')]));
  const used = [...faces.values()];
  const em = (k: (f: any) => number) => Math.max(sizePx, ...used.map((f) => k(f) * sizePx / f.unitsPerEm));
  const margin = Math.ceil(sizePx * 0.5);
  const top = Math.ceil(em((f) => f.ascent) * 1.1) + margin;
  const bottom = Math.ceil(Math.max(sizePx * 0.4, em((f) => -f.descent) - sizePx * 0.6) * 1.1) + margin;
  const width = Math.ceil(shaped.advance) + 2 * margin + Math.ceil(sizePx * 0.5);
  const height = top + bottom;
  const edges: number[][] = [];
  const loose = new Uint8Array(width);
  const pad = Math.round(sizePx * 0.05);
  const segments: Array<[number, number]> = [];
  let open = false;
  for (const g of shaped.glyphs) {
    const font = faces.get(g.file);
    const scale = sizePx / font.unitsPerEm;
    const glyph = font.getGlyph(g.id);
    const commands = glyph.path?.commands ?? [];
    if (commands.length) edges.push(...flatten(commands, margin + g.x, top - g.y, scale));
    if (!commands.length) continue;
    const box = glyph.bbox;
    const x0 = Math.floor(margin + g.x + box.minX * scale), x1 = Math.ceil(margin + g.x + box.maxX * scale);
    if (g.loose) for (let x = Math.max(0, x0 - pad); x < Math.min(width, x1 + pad); x++) loose[x] = 1;
    // A letter from a fallback face is not scored but stays in its word's run of letters.
    if (g.breaks) open = false;
    else if (open) {
      const last = segments[segments.length - 1];
      last[0] = Math.min(last[0], x0); last[1] = Math.max(last[1], x1);
    } else { segments.push([x0, x1]); open = true; }
  }
  const data = fill(edges, width, height);
  return { width, height, data, ink: inkBox(data, width, height, 0.25), loose, hasLoose: loose.some(Boolean), segments };
}

function inkBox(data: Float32Array, width: number, height: number, at: number) {
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[y * width + x] < at) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, x1: x1 + 1, y0, y1: y1 + 1 };
}

// ---------------------------------------------------------------------------------------------
// The picture's ink.
// ---------------------------------------------------------------------------------------------

const rgbOf = (hex: string) => {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!h) throw new Error(`Not an RGB colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const asPicture = (p: Buffer | ShapingPicture): ShapingPicture => Buffer.isBuffer(p) ? PNG.sync.read(p) : p;

/**
 * The share of each pixel of a region that is the text's ink. With the text-free picture the share is
 * unmixed exactly: the pixel is a blend of the background and one ink colour, and the blend's weight is
 * its projection on the line from one to the other. Without it, the ink is the pixels near an ink colour,
 * fading out over the distance from that colour to the region's background.
 */
function inkCoverage(picture: ShapingPicture, region: { x: number; y: number; width: number; height: number }, colors: number[][], background?: ShapingPicture): Coverage {
  const { width, height } = region;
  const data = new Float32Array(width * height);
  const px = (p: ShapingPicture, x: number, y: number) => { const i = ((y * p.width) + x) * (p.data.length / (p.width * p.height)); return [p.data[i], p.data[i + 1], p.data[i + 2]]; };
  let ground: number[] | undefined;
  if (!background) {
    // The region's background: the median of the pixels far from every ink colour.
    const far: number[][] = [];
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      const p = px(picture, region.x + x, region.y + y);
      if (colors.every((c) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) > 120)) far.push(p);
    }
    const med = (k: number) => { const v = far.map((p) => p[k]).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 255 - colors[0][k]; };
    ground = [med(0), med(1), med(2)];
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = px(picture, region.x + x, region.y + y);
    const g = background ? px(background, region.x + x, region.y + y) : ground!;
    let best = 0;
    for (const c of colors) {
      const d = [c[0] - g[0], c[1] - g[1], c[2] - g[2]];
      const span = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (span < 40 * 40) continue; // ink the colour of its ground cannot be read
      if (background) {
        const a = ((p[0] - g[0]) * d[0] + (p[1] - g[1]) * d[1] + (p[2] - g[2]) * d[2]) / span;
        // The residual off the blend line: a pixel of something else (a photo edge) is not ink.
        const r = [p[0] - g[0] - a * d[0], p[1] - g[1] - a * d[1], p[2] - g[2] - a * d[2]];
        if (Math.hypot(r[0], r[1], r[2]) > 48) continue;
        best = Math.max(best, Math.min(1, Math.max(0, a)));
      } else {
        const dist = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
        best = Math.max(best, Math.min(1, Math.max(0, 1 - dist / Math.sqrt(span))));
      }
    }
    data[y * width + x] = best < 0.12 ? 0 : best;
  }
  return { width, height, data };
}

/**
 * Rows of ink grouped into lines. Gaps under a third of the type size join (Arabic dots and marks sit
 * that close to their letters). A group taller than one line's ink by most of a line pitch holds more
 * than one line whose marks touch (a Sorani title set at 1.6 does): it is split at the emptiest rows
 * near where the pitch puts the line breaks.
 */
function lineBands(cov: Coverage, sizePx: number, pitchPx: number, lineInkPx: number): Array<[number, number]> {
  const rows: number[] = [];
  for (let y = 0; y < cov.height; y++) { let n = 0; for (let x = 0; x < cov.width; x++) n += cov.data[y * cov.width + x]; rows.push(n); }
  const need = Math.max(1.5, cov.width * 0.003);
  const runs: Array<[number, number]> = [];
  let start = -1;
  rows.forEach((n, i) => {
    const on = n >= need;
    if (on && start < 0) start = i;
    if (start >= 0 && (!on || i === rows.length - 1)) { runs.push([start, on ? i : i - 1]); start = -1; }
  });
  const joined: Array<[number, number]> = [];
  for (const run of runs) {
    const last = joined.at(-1);
    if (last && run[0] - last[1] <= Math.max(3, sizePx * 0.3)) last[1] = run[1];
    else joined.push([run[0], run[1]]);
  }
  const split: Array<[number, number]> = [];
  for (const [top, bottom] of joined) {
    const h = bottom - top + 1;
    const k = pitchPx > 0 ? Math.max(1, Math.round((h - lineInkPx) / pitchPx) + 1) : 1;
    if (k === 1) { split.push([top, bottom]); continue; }
    let from = top;
    for (let j = 1; j < k; j++) {
      const guess = Math.round(top + (h * j) / k), reach = Math.round(pitchPx / 3);
      let cut = guess;
      for (let y = Math.max(from + 1, guess - reach); y <= Math.min(bottom - 1, guess + reach); y++) if (rows[y] < rows[cut]) cut = y;
      split.push([from, cut]); from = cut + 1;
    }
    split.push([from, bottom]);
  }
  return split.filter(([a, b]) => b - a + 1 >= sizePx * 0.35);
}

/**
 * Each line's ink on its own. The picture's ink is cut into connected pieces (a letter group, a dot, a
 * mark), and each piece goes to the line whose middle is nearest its own: a dot under the last letter of
 * one line sits in the rows above the next, where a cut by rows would hand it to the wrong line. Pieces
 * more than an em from every line are not this block's.
 */
function splitLines(cov: Coverage, bands: Array<[number, number]>, sizePx: number): Array<{ cov: Coverage; ink: ReturnType<typeof inkBox> }> {
  const { width, height, data } = cov;
  const centre = bands.map(([a, b]) => {
    let m = 0, my = 0;
    for (let y = a; y <= b; y++) { let n = 0; for (let x = 0; x < width; x++) n += data[y * width + x]; m += n; my += n * y; }
    return m ? my / m : (a + b) / 2;
  });
  const owner = new Int16Array(width * height).fill(-1);
  const seen = new Uint8Array(width * height);
  interface Piece { members: number[]; cy: number; x0: number; x1: number; y0: number; y1: number; line: number }
  const pieces: Piece[] = [];
  for (let i = 0; i < data.length; i++) {
    if (seen[i] || data[i] <= 0) continue;
    const members: number[] = [];
    const stack = [i]; seen[i] = 1;
    let m = 0, my = 0, x0 = width, x1 = 0, y0 = height, y1 = 0;
    while (stack.length) {
      const j = stack.pop()!; members.push(j);
      const x = j % width, y = (j - x) / width;
      m += data[j]; my += data[j] * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[j - 1] && data[j - 1] > 0) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < width - 1 && !seen[j + 1] && data[j + 1] > 0) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && !seen[j - width] && data[j - width] > 0) { seen[j - width] = 1; stack.push(j - width); }
      if (y < height - 1 && !seen[j + width] && data[j + width] > 0) { seen[j + width] = 1; stack.push(j + width); }
    }
    pieces.push({ members, cy: my / m, x0, x1, y0, y1, line: -1 });
  }
  const nearestLine = (cy: number) => {
    let best = -1, distance = Infinity;
    centre.forEach((c, k) => { if (Math.abs(c - cy) < distance) { distance = Math.abs(c - cy); best = k; } });
    return distance <= sizePx ? best : -1;
  };
  // Letter bodies go to the line whose middle is nearest; a dot or a mark goes with the body it sits on
  // or under (it may be nearer the middle of the next line, whose rows it reaches into).
  const isBody = (p: Piece) => p.y1 - p.y0 + 1 >= sizePx * 0.3 || p.x1 - p.x0 + 1 >= sizePx * 0.6;
  for (const p of pieces) if (isBody(p)) p.line = nearestLine(p.cy);
  const bodies = pieces.filter((p) => isBody(p) && p.line >= 0);
  for (const p of pieces) {
    if (isBody(p)) continue;
    let best: Piece | undefined, distance = Infinity;
    for (const b of bodies) {
      const dx = Math.max(0, b.x0 - p.x1, p.x0 - b.x1), dy = Math.max(0, b.y0 - p.y1, p.y0 - b.y1);
      const d = Math.hypot(dx, dy);
      if (d < distance) { distance = d; best = b; }
    }
    p.line = best && distance <= sizePx * 0.6 ? best.line : nearestLine(p.cy);
  }
  for (const p of pieces) if (p.line >= 0) for (const j of p.members) owner[j] = p.line;
  return bands.map((_, k) => {
    let top = height, bottom = -1;
    for (let i = 0; i < owner.length; i++) if (owner[i] === k) { const y = (i - (i % width)) / width; if (y < top) top = y; if (y > bottom) bottom = y; }
    if (bottom < 0) return { cov: { width, height: 1, data: new Float32Array(width) }, ink: null };
    const pad = Math.round(sizePx * 0.35);
    const t = Math.max(0, top - pad), b = Math.min(height, bottom + 1 + pad);
    const out = new Float32Array(width * (b - t));
    for (let y = t; y < b; y++) for (let x = 0; x < width; x++) { const i = y * width + x; if (owner[i] === k) out[(y - t) * width + x] = data[i]; }
    const c: Coverage = { width, height: b - t, data: out };
    return { cov: c, ink: inkBox(out, width, b - t, 0.25) };
  });
}

// ---------------------------------------------------------------------------------------------
// Comparing a found line with a drawn one.
// ---------------------------------------------------------------------------------------------

function blur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const r = Math.round(radius);
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let pass = 0; pass < 2; pass++) {
    const from = pass ? out : src;
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += from[y * width + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x++) {
        tmp[y * width + x] = acc / (2 * r + 1);
        acc += from[y * width + Math.min(width - 1, x + r + 1)] - from[y * width + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y++) {
        out[y * width + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(height - 1, y + r + 1) * width + x] - tmp[Math.max(0, y - r) * width + x];
      }
    }
  }
  return out;
}

interface Moments { width: number; sum: Float64Array; square: Float64Array }

/** Summed-area tables preserve all pixels, including empty margins used by Pearson correlation. */
function moments(data: Float32Array, width: number, height: number): Moments {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1)), square = new Float64Array(sum.length);
  for (let y = 0; y < height; y++) {
    let s = 0, s2 = 0;
    for (let x = 0; x < width; x++) {
      const p = data[y * width + x], i = (y + 1) * stride + x + 1;
      s += p; s2 += p * p;
      sum[i] = sum[i - stride] + s; square[i] = square[i - stride] + s2;
    }
  }
  return { width: stride, sum, square };
}

function rectangle(m: Moments, data: Float64Array, x0: number, y0: number, x1: number, y1: number): number {
  return data[y1 * m.width + x1] - data[y0 * m.width + x1] - data[y1 * m.width + x0] + data[y0 * m.width + x0];
}

/** Pearson correlation; masked columns are omitted from every moment and from the pixel count. */
function ncc(a: Float32Array, aw: number, b: Float32Array, bw: number, ox: number, oy: number,
  xs: [number, number], ys: [number, number], skip?: Uint8Array, cached?: { a: Moments; b: Moments }): { r: number; mass: number; n: number } {
  let n = 0, sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
  if (cached && !skip) {
    // Every search reuses these four moments; only the cross-product depends on both images.
    // Masked fallback/digit columns use individual column rectangles below.
    const [x0, x1] = xs, [y0, y1] = ys;
    n = (x1 - x0) * (y1 - y0);
    sa = rectangle(cached.a, cached.a.sum, x0, y0, x1, y1);
    saa = rectangle(cached.a, cached.a.square, x0, y0, x1, y1);
    sb = rectangle(cached.b, cached.b.sum, x0 + ox, y0 + oy, x1 + ox, y1 + oy);
    sbb = rectangle(cached.b, cached.b.square, x0 + ox, y0 + oy, x1 + ox, y1 + oy);
    for (let y = y0; y < y1; y++) {
      const ra = y * aw, rb = (y + oy) * bw + ox;
      for (let x = x0; x < x1; x++) sab += a[ra + x] * b[rb + x];
    }
  } else if (cached && skip) {
    const [x0, x1] = xs, [y0, y1] = ys;
    for (let x = x0; x < x1; x++) {
      if (skip[x + ox]) continue;
      n += y1 - y0;
      sa += rectangle(cached.a, cached.a.sum, x, y0, x + 1, y1);
      saa += rectangle(cached.a, cached.a.square, x, y0, x + 1, y1);
      sb += rectangle(cached.b, cached.b.sum, x + ox, y0 + oy, x + ox + 1, y1 + oy);
      sbb += rectangle(cached.b, cached.b.square, x + ox, y0 + oy, x + ox + 1, y1 + oy);
    }
    for (let y = y0; y < y1; y++) {
      const ra = y * aw, rb = (y + oy) * bw + ox;
      for (let x = x0; x < x1; x++) if (!skip[x + ox]) sab += a[ra + x] * b[rb + x];
    }
  } else {
    for (let y = ys[0]; y < ys[1]; y++) {
      const ra = y * aw, rb = (y + oy) * bw + ox;
      for (let x = xs[0]; x < xs[1]; x++) {
        if (skip && skip[x + ox]) continue;
        const p = a[ra + x], q = b[rb + x];
        sa += p; sb += q; sab += p * q; saa += p * p; sbb += q * q; n++;
      }
    }
  }
  if (!n) return { r: 0, mass: 0, n };
  const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va < 1e-9 && vb < 1e-9) return { r: 1, mass: 0, n };
  if (va < 1e-9 || vb < 1e-9) return { r: 0, mass: sa + sb, n };
  return { r: cov / Math.sqrt(va * vb), mass: sa + sb, n };
}

/** Connected pieces of ink (4-neighbour), each with the columns it spans. */
function inkPieces(cov: Coverage): { label: Int32Array; span: Array<[number, number]> } {
  const { width, data } = cov;
  const label = new Int32Array(data.length).fill(-1);
  const span: Array<[number, number]> = [];
  for (let i = 0; i < data.length; i++) {
    if (label[i] >= 0 || data[i] <= 0) continue;
    const k = span.length;
    const stack = [i]; label[i] = k;
    let x0 = width, x1 = 0;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % width;
      if (x < x0) x0 = x; if (x + 1 > x1) x1 = x + 1;
      for (const n of [x > 0 ? j - 1 : -1, x < width - 1 ? j + 1 : -1, j - width, j + width]) {
        if (n < 0 || n >= data.length || label[n] >= 0 || data[n] <= 0) continue;
        label[n] = k; stack.push(n);
      }
    }
    span.push([x0, x1]);
  }
  return { label, span };
}

interface LineMatch { score: number; global: number; widthRatio: number | null; worstWindow: number }

/**
 * Matches a found line (a band of the picture's ink) with a drawn line of the same size. The drawing is
 * placed on the found ink's box and moved by up to a quarter em across and a sixth down for the best
 * fit (`global`). Then each run of letters between loose glyphs finds its own place within an em and a
 * half (a provider's digits or punctuation may be narrower than the bundled face's, which moves every
 * letter after them) and is scored in windows two ems wide, one em apart, each free to move a sixth of
 * an em across and a sixteenth down. The score is the lowest window's correlation: far less slack than a
 * word, so words in the wrong order, letters in another form or another face, and a word the drawing has
 * not still fail.
 */
function matchLine(found: Coverage, foundInk: { x0: number; x1: number; y0: number; y1: number }, drawn: Drawn, sizePx: number, windows = true, blurEm = BLUR_EXACT): LineMatch {
  if (!drawn.ink) return { score: 0, global: 0, widthRatio: null, worstWindow: -1 };
  const widthRatio = (foundInk.x1 - foundInk.x0) / (drawn.ink.x1 - drawn.ink.x0);
  const cxF = (foundInk.x0 + foundInk.x1) / 2, cxD = (drawn.ink.x0 + drawn.ink.x1) / 2;
  const cyF = (foundInk.y0 + foundInk.y1) / 2, cyD = (drawn.ink.y0 + drawn.ink.y1) / 2;
  const { width, height } = found;
  const radius = Math.max(1, sizePx * blurEm);
  const reachX = Math.max(1, Math.round(sizePx * 0.25)), reachY = Math.max(1, Math.round(sizePx * 0.15));
  const localX = Math.max(1, Math.round(sizePx * 1.7)), localY = Math.max(1, Math.round(sizePx / 16));
  const RX = reachX + localX, RY = reachY + localY;
  const F = blur(found.data, width, height, radius);
  // The drawing placed once on the found grid widened by RX/RY (whole-pixel offset of the ink centres);
  // a shift is then an offset into it.
  const ox = Math.round(cxF - cxD), oy = Math.round(cyF - cyD);
  const bw = width + 2 * RX, bh = height + 2 * RY;
  const raw = new Float32Array(bw * bh), skip = new Uint8Array(bw);
  for (let y = 0; y < bh; y++) {
    const v = y - RY - oy;
    if (v < 0 || v >= drawn.height) continue;
    for (let x = 0; x < bw; x++) {
      const u = x - RX - ox;
      if (u < 0 || u >= drawn.width) continue;
      raw[y * bw + x] = drawn.data[v * drawn.width + u];
    }
  }
  for (let x = 0; x < bw; x++) { const u = x - RX - ox; if (u >= 0 && u < drawn.width) skip[x] = drawn.loose[u]; }
  const D = blur(raw, bw, bh, radius);
  const loose = drawn.hasLoose ? skip : undefined;
  const drawingMoments = moments(D, bw, bh);
  const foundMoments = new WeakMap<Float32Array, Moments>();
  foundMoments.set(F, moments(F, width, height));
  // Reading D at (x + RX - dx, y + RY - dy) places the drawing shifted by (dx, dy).
  const at = (dx: number, dy: number, xs: [number, number], ys: [number, number], k?: Uint8Array, from: Float32Array = F) => {
    let a = foundMoments.get(from);
    if (!a) { a = moments(from, width, height); foundMoments.set(from, a); }
    return ncc(from, width, D, bw, RX - dx, RY - dy, xs, ys, k, { a, b: drawingMoments });
  };
  // With loose glyphs, a run of letters is scored on the found pieces of ink that lie mostly in its
  // columns: a provider's digit beside it, wider or placed apart, is not a letter of the run.
  const pieces = drawn.hasLoose ? inkPieces(found) : undefined;
  const only = (c0: number, c1: number) => {
    const keep = pieces!.span.map(([a, b]) => (Math.min(b, c1) - Math.max(a, c0)) >= 0.5 * (b - a));
    const out = new Float32Array(found.data.length);
    for (let i = 0; i < out.length; i++) { const k = pieces!.label[i]; if (k >= 0 && keep[k]) out[i] = found.data[i]; }
    return blur(out, width, height, radius);
  };
  const full: [number, number] = [0, width], rows: [number, number] = [0, height];
  const search = (xs: [number, number], cx: number, cy: number, rx: number, ry: number, k?: Uint8Array) => {
    const step = Math.max(1, Math.round(Math.max(rx, ry) / 4));
    let best = { r: -2, dx: cx, dy: cy, mass: 0, n: 0 };
    const tryAt = (dx: number, dy: number) => { const w = at(dx, dy, xs, rows, k); if (w.n && w.r > best.r) best = { r: w.r, dx, dy, mass: w.mass, n: w.n }; };
    for (let dy = cy - ry; dy <= cy + ry; dy += Math.min(step, Math.max(1, ry))) for (let dx = cx - rx; dx <= cx + rx; dx += step) tryAt(dx, dy);
    if (step > 1) {
      const c = { ...best };
      for (let dy = Math.max(cy - ry, c.dy - step + 1); dy <= Math.min(cy + ry, c.dy + step - 1); dy++)
        for (let dx = Math.max(cx - rx, c.dx - step + 1); dx <= Math.min(cx + rx, c.dx + step - 1); dx++) tryAt(dx, dy);
    }
    return best;
  };
  const best = search(full, 0, 0, reachX, reachY);
  const global = at(best.dx, best.dy, full, rows, loose).r;
  if (!windows) return { score: global, global, widthRatio, worstWindow: -1 };
  const win = Math.max(8, Math.round(sizePx * 2)), hop = Math.max(4, Math.round(sizePx));
  const slack = Math.max(1, Math.round(sizePx * 1.5)), localX2 = Math.max(1, Math.round(sizePx / 6));
  const whole = at(best.dx, best.dy, full, rows, loose).mass;
  const inkSpan = Math.max(1, foundInk.x1 - foundInk.x0);
  let worst = 1, worstAt = -1;
  for (const [k, [a, b]] of drawn.segments.entries()) {
    // The segment's columns on the found grid, at the line's placement.
    const sx0 = a + ox + best.dx - 2, sx1 = b + ox + best.dx + 2;
    const cols = (dx: number): [number, number] => [Math.max(0, sx0 + dx - best.dx), Math.min(width, sx1 + dx - best.dx)];
    let place = { r: -2, dx: best.dx, dy: best.dy };
    const step = Math.max(1, Math.round(slack / 8));
    for (let dx = best.dx - slack; dx <= best.dx + slack; dx += step) for (let dy = best.dy - localY; dy <= best.dy + localY; dy += Math.max(1, localY)) {
      const c = cols(dx); if (c[1] - c[0] < 2) continue;
      const w = at(dx, dy, c, rows, loose); if (w.n && w.r > place.r) place = { r: w.r, dx, dy };
    }
    for (let dx = place.dx - step + 1; dx <= place.dx + step - 1; dx++) {
      const c = cols(dx); if (c[1] - c[0] < 2) continue;
      const w = at(dx, place.dy, c, rows, loose); if (w.n && w.r > place.r) place = { ...place, r: w.r, dx };
    }
    let [c0, c1] = cols(place.dx);
    // The outermost runs of letters reach to the found ink's ends, so ink the drawing has not (a word
    // wrapped onto this line) is scored too.
    const outerLeft = k === 0 && !drawn.loose.subarray(0, Math.max(0, a)).some(Boolean);
    const outerRight = k === drawn.segments.length - 1 && !drawn.loose.subarray(b).some(Boolean);
    if (outerLeft) c0 = Math.max(0, Math.min(c0, foundInk.x0 - 2));
    if (outerRight) c1 = Math.min(width, Math.max(c1, foundInk.x1 + 2));
    const Fs = pieces ? only(c0, c1) : F;
    for (let x = c0; x < c1; x += hop) {
      const x1 = Math.min(c1, x + win);
      if (x1 - x < win / 2 && x > c0) break;
      // The window's columns move with the drawing as it is shifted.
      let r = -2, mass = 0, bx = place.dx, by = place.dy;
      const tryAt = (dx: number, dy: number) => {
        const w = at(dx, dy, [Math.max(0, x + dx - place.dx), Math.min(width, x1 + dx - place.dx)], rows, loose, Fs);
        if (w.n && w.r > r) { r = w.r; mass = w.mass; bx = dx; by = dy; }
      };
      for (let dy = place.dy - localY; dy <= place.dy + localY; dy += 2) for (let dx = place.dx - localX2; dx <= place.dx + localX2; dx += 2) tryAt(dx, dy);
      const cx = bx, cy = by;
      for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) if (dx !== cx || dy !== cy) tryAt(dx, dy);
      // A window holding little scored ink of either says little; it is skipped.
      if (r > -2 && mass >= whole * ((x1 - x) / inkSpan) * 0.25 && r < worst) { worst = r; worstAt = x; }
      if (x1 >= c1) break;
    }
  }
  return { score: worst, global, widthRatio, worstWindow: worstAt };
}

/** A drawn line resampled `s` times its size (a provider sets type a hair larger or smaller). */
function scaleDrawn(d: Drawn, s: number): Drawn {
  if (s === 1) return d;
  const width = Math.ceil(d.width * s), height = Math.ceil(d.height * s);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / s - 0.5, v = (y + 0.5) / s - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= d.width || y0 + 1 >= d.height) continue;
    const w = d.width, a = d.data;
    data[y * width + x] = a[y0 * w + x0] * (1 - fx) * (1 - fy) + a[y0 * w + x0 + 1] * fx * (1 - fy) + a[(y0 + 1) * w + x0] * (1 - fx) * fy + a[(y0 + 1) * w + x0 + 1] * fx * fy;
  }
  const loose = new Uint8Array(width);
  for (let x = 0; x < width; x++) loose[x] = d.loose[Math.min(d.width - 1, Math.floor(x / s))];
  return { width, height, data, ink: inkBox(data, width, height, 0.25), loose, hasLoose: d.hasLoose,
    segments: d.segments.map(([a, b]) => [Math.floor(a * s), Math.ceil(b * s)] as [number, number]) };
}

/**
 * The best match of a found line with a drawing at any of `scales` (1 alone when the picture comes
 * from the renderer that drew the design; a provider's type may be a percent or two off).
 */
function bestMatch(found: Coverage, foundInk: { x0: number; x1: number; y0: number; y1: number }, drawn: Drawn, sizePx: number, scales: number[], windows = true, blurEm = BLUR_EXACT): LineMatch {
  // Scales are ranked on the whole line's correlation; the two best are scored window by window.
  const ranked = scales.length > 1
    ? scales.map((s) => ({ s, g: matchLine(found, foundInk, scaleDrawn(drawn, s), sizePx * s, false, blurEm).global })).sort((a, b) => b.g - a.g).map((x) => x.s)
    : scales;
  let best: LineMatch | undefined;
  for (const s of windows ? ranked.slice(0, 2) : ranked.slice(0, 1)) {
    const m = matchLine(found, foundInk, scaleDrawn(drawn, s), sizePx * s, windows, blurEm);
    if (!best || m.score > best.score) best = m;
  }
  return { ...best!, widthRatio: drawn.ink ? (foundInk.x1 - foundInk.x0) / (drawn.ink.x1 - drawn.ink.x0) : null };
}

/**
 * Boxes drawn where a glyph is missing ("tofu"): two upright strokes of the same height (over half an
 * em), between a quarter of an em and an em apart, joined by straight strokes along their tops and
 * bottoms, the inside mostly empty (renderers may write the code point's digits inside). No Arabic
 * letter makes this shape: an alef has no crossbars, a closed loop is not half an em tall.
 */
function tofuBoxes(cov: Coverage, sizePx: number): number {
  const { width, height, data } = cov;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] >= 0.3;
  // Each column's longest upright run of ink.
  const runs: Array<[number, number] | null> = [];
  for (let x = 0; x < width; x++) {
    let best: [number, number] | null = null, start = -1;
    for (let y = 0; y <= height; y++) {
      if (y < height && on(x, y)) { if (start < 0) start = y; continue; }
      if (start >= 0 && (!best || y - start > best[1] - best[0])) best = [start, y - 1];
      start = -1;
    }
    runs.push(best && best[1] - best[0] + 1 >= sizePx * 0.55 && best[1] - best[0] + 1 <= sizePx * 1.3 ? best : null);
  }
  const across = (y: number, x0: number, x1: number) => {
    let n = 0;
    for (let x = x0; x <= x1; x++) if (on(x, y - 1) || on(x, y) || on(x, y + 1)) n++;
    return n / (x1 - x0 + 1);
  };
  let boxes = 0;
  for (let x = 0; x < width; x++) {
    const a = runs[x];
    if (!a) continue;
    for (let x2 = x + Math.ceil(sizePx * 0.25); x2 <= Math.min(width - 1, x + sizePx); x2++) {
      const b = runs[x2];
      if (!b || Math.abs(a[0] - b[0]) > 2 || Math.abs(a[1] - b[1]) > 2) continue;
      if (across(Math.min(a[0], b[0]) + 1, x, x2) < 0.9 || across(Math.max(a[1], b[1]) - 1, x, x2) < 0.9) continue;
      // Hollow: most of the inside (a sixth of the box in from each side) is empty.
      const ix0 = x + Math.ceil((x2 - x) / 6), ix1 = x2 - Math.ceil((x2 - x) / 6);
      const iy0 = Math.max(a[0], b[0]) + Math.ceil((a[1] - a[0]) / 6), iy1 = Math.min(a[1], b[1]) - Math.ceil((a[1] - a[0]) / 6);
      let inked = 0, cells = 0;
      for (let y = iy0; y <= iy1; y++) for (let xx = ix0; xx <= ix1; xx++) { cells++; if (on(xx, y)) inked++; }
      if (cells && inked / cells <= 0.4) { boxes++; x = x2; break; }
    }
  }
  return boxes;
}

// ---------------------------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------------------------

const words = (lines: string[]) => lines.join(' ').split(/\s+/).filter(Boolean);
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Checks every block's lines in a picture (a Studio render, or the PNG of a Canva export).
 * Blocks are given in the picture's pixels: see `textShapingBlocks` for a Studio layout.
 */
export function checkTextShaping(picture: Buffer | ShapingPicture, blocks: ShapingBlockInput[], options: ShapingCheckOptions = {}): TextShapingFidelity {
  const started = performance.now();
  const png = asPicture(picture);
  const background = options.background ? asPicture(options.background) : undefined;
  if (background && (background.width !== png.width || background.height !== png.height)) throw new Error('The text-free picture is not the size of the picture');
  const reports: ShapingBlockReport[] = [];
  // The renderer that drew the design draws type at its size; a provider's may be a little off.
  const scales = background ? [1] : [0.975, 1, 1.025];
  const threshold = background ? SHAPING_MATCH_SCORE_EXACT : SHAPING_MATCH_SCORE;
  const blurEm = background ? BLUR_EXACT : BLUR_PROVIDER;
  const unmeasured: TextShapingFidelity['unmeasured'] = [];
  for (const block of blocks) {
    if (block.unmeasurable) { unmeasured.push({ id: block.id, reason: block.unmeasurable }); continue; }
    const lines = block.lines.map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const size = block.fontSizePx;
    const spacing = block.letterSpacingPx ?? 0;
    const faces = [block.fontFile, ...(block.fallbackFontFiles ?? [])];
    const missing = [...new Set(lines.flatMap((l) => shapeLine(faces, l, block.rtl, size, spacing).missing))];
    if (missing.length) {
      unmeasured.push({ id: block.id, reason: `the face has no glyph for ${missing.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')} (drawn with a fallback face)` });
      continue;
    }
    // The box, widened by half a line above and below and a quarter em aside (Canva moves frames a little).
    const padY = size * 0.75, padX = size * 0.25;
    const x0 = Math.max(0, Math.floor(block.box.x - padX)), x1 = Math.min(png.width, Math.ceil(block.box.x + block.box.width + padX));
    const y0 = Math.max(0, Math.floor(block.box.y - padY)), y1 = Math.min(png.height, Math.ceil(block.box.y + block.box.height + padY));
    if (x1 - x0 < 4 || y1 - y0 < 4) { unmeasured.push({ id: block.id, reason: 'the box lies off the picture' }); continue; }
    const region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const cov = inkCoverage(png, region, block.colors.map(rgbOf), background);
    // Ink inside another block's box is that block's (a title's marks reach into the padding of the line
    // below), unless the two boxes overlap.
    const overlaps = (a: ShapingBlockInput['box'], b: ShapingBlockInput['box']) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const other of blocks) {
      if (other === block || overlaps(other.box, block.box)) continue;
      const ox0 = Math.max(0, Math.floor(other.box.x) - x0), ox1 = Math.min(region.width, Math.ceil(other.box.x + other.box.width) - x0);
      const oy0 = Math.max(0, Math.floor(other.box.y) - y0), oy1 = Math.min(region.height, Math.ceil(other.box.y + other.box.height) - y0);
      for (let y = oy0; y < oy1; y++) cov.data.fill(0, y * region.width + Math.max(0, ox0), y * region.width + Math.max(0, ox1));
    }
    const drawCache = new Map<string, Drawn>();
    const draw = (text: string, mode: ShapeMode = 'designed') => {
      const key = `${mode}\u0000${text}`;
      if (!drawCache.has(key)) drawCache.set(key, drawLine(shapeLine(faces, text, block.rtl, size, spacing, mode, !background), size));
      return drawCache.get(key)!;
    };
    // One line's ink height (the median of the designed lines'), for telling lines whose marks touch apart.
    const lineInk = lines.map((l) => { const d = draw(l); return d.ink ? d.ink.y1 - d.ink.y0 : size; }).sort((a, b) => a - b)[lines.length >> 1];
    // Lines whose middle lies in the box (a quarter em of slack): ink further out is not this block's.
    const bands = lineBands(cov, size, block.lineHeight * size, lineInk)
      .filter(([a, b]) => { const mid = (a + b) / 2 + y0; return mid >= block.box.y - size * 0.25 && mid <= block.box.y + block.box.height + size * 0.25; });
    if (!bands.length) { unmeasured.push({ id: block.id, reason: 'no ink of the text colour in the box' }); continue; }
    const found = splitLines(cov, bands, size);
    const advanceOf = (text: string) => { const d = draw(text); return d.ink ? d.ink.x1 - d.ink.x0 : 0; };
    const lineReports: ShapingLineReport[] = [];
    const sameCount = found.length === lines.length;
    // The words a found line holds when the copy is wrapped differently: the run of the block's words
    // whose drawing is as wide as the found ink and matches it, if any.
    const all = words(lines);
    const rewrap = (f: (typeof found)[number]): { text: string; m: LineMatch } | undefined => {
      if (!f.ink) return undefined;
      const fw = f.ink.x1 - f.ink.x0;
      const tried: Array<{ text: string; w: number }> = [];
      for (let a = 0; a < all.length; a++) for (let b = a + 1; b <= all.length; b++) {
        const text = all.slice(a, b).join(' ');
        const w = advanceOf(text);
        if (Math.abs(w / fw - 1) <= SHAPING_WIDTH_TOLERANCE) tried.push({ text, w });
        if (w > fw * 1.2) break;
      }
      tried.sort((p, q) => Math.abs(p.w - fw) - Math.abs(q.w - fw));
      for (const t of tried.slice(0, 4)) {
        if (bestMatch(f.cov, f.ink, draw(t.text), size, scales, false, blurEm).global < threshold) continue;
        const m = bestMatch(f.cov, f.ink, draw(t.text), size, scales, true, blurEm);
        if (m.score >= threshold) return { text: t.text, m };
      }
      return undefined;
    };
    const explain = (f: (typeof found)[number], text: string, m: LineMatch): { verdict: ShapingVerdict; detail: string } => {
      if (tofuBoxes(f.cov, size) > 0) return { verdict: 'missing-glyphs', detail: 'boxes are drawn where glyphs should be' };
      const tries: Array<{ mode: ShapeMode; verdict: ShapingVerdict; detail: string }> = [
        { mode: 'reversed', verdict: 'wrong-direction', detail: 'the letters are drawn in reverse order' },
        { mode: 'base-ltr', verdict: 'wrong-direction', detail: 'the runs are ordered left to right' },
        { mode: 'unjoined', verdict: 'shaping-mismatch', detail: 'the letters are drawn unjoined' },
      ];
      let best: { verdict: ShapingVerdict; detail: string; score: number } | undefined;
      for (const t of tries) {
        const alt = draw(text, t.mode);
        // Base-ltr draws the same as designed when the line has one direction only.
        if (t.mode === 'base-ltr' && alt.width === draw(text).width && alt.data.every((v, i) => v === draw(text).data[i])) continue;
        const am = bestMatch(f.cov, f.ink!, alt, size, scales, false, blurEm);
        if (am.global > m.global + 0.05 && am.score > (best?.score ?? 0) && am.global >= 0.75) best = { verdict: t.verdict, detail: t.detail, score: am.score };
      }
      if (best) return best;
      return { verdict: 'shaping-mismatch', detail: m.widthRatio !== null && Math.abs(m.widthRatio - 1) > SHAPING_WIDTH_TOLERANCE
        ? `glyphs differ from the face and the line is ${Math.round(m.widthRatio * 100)}% as wide (a substituted face?)`
        : 'glyphs differ from the face (broken joining, marks or a substituted face)' };
    };
    if (sameCount) {
      lines.forEach((text, i) => {
        const f = found[i];
        if (!f.ink) { lineReports.push({ index: i, verdict: 'shaping-mismatch', score: 0, widthRatio: null, detail: 'no ink' }); return; }
        const m = bestMatch(f.cov, f.ink, draw(text), size, scales, true, blurEm);
        // The width is held to the face only where the line has no loose glyphs (another face's digits
        // and punctuation may be narrower).
        const widthOk = m.widthRatio !== null && (draw(text).hasLoose || Math.abs(m.widthRatio - 1) <= SHAPING_WIDTH_TOLERANCE);
        if (m.score >= threshold && widthOk) { lineReports.push({ index: i, verdict: 'ok', score: round(m.score), widthRatio: round(m.widthRatio!) }); return; }
        const other = lines.length > 1 || (m.widthRatio !== null && m.widthRatio < 1 - SHAPING_WIDTH_TOLERANCE) ? rewrap(f) : undefined;
        if (other && other.text !== text) {
          lineReports.push({ index: i, verdict: 'wrapped-differently', score: round(m.score), widthRatio: m.widthRatio === null ? null : round(m.widthRatio), detail: `the line holds ${other.text.split(' ').length} word(s) the design wraps elsewhere` });
          return;
        }
        const why = explain(f, text, m);
        lineReports.push({ index: i, verdict: why.verdict, score: round(m.score), widthRatio: m.widthRatio === null ? null : round(m.widthRatio), detail: why.detail });
      });
    } else {
      // Another number of lines: each found line is matched with the run of words it holds, if any.
      found.forEach((f, i) => {
        const other = rewrap(f);
        lineReports.push(other
          ? { index: i, verdict: 'wrapped-differently', score: round(other.m.score), widthRatio: other.m.widthRatio === null ? null : round(other.m.widthRatio), detail: `${found.length} line(s) found, ${lines.length} designed; this one is shaped correctly` }
          : { index: i, verdict: 'wrapped-differently', score: 0, widthRatio: null, detail: `${found.length} line(s) found, ${lines.length} designed; this one matches no run of the copy's words` });
      });
    }
    const failing = lineReports.find((l) => l.verdict !== 'ok');
    // The block's verdict: its worst line's, missing glyphs and direction first.
    const rank: ShapingVerdict[] = ['missing-glyphs', 'wrong-direction', 'shaping-mismatch', 'wrapped-differently', 'ok'];
    const verdict = failing ? rank.find((v) => lineReports.some((l) => l.verdict === v))! : 'ok';
    reports.push({ id: block.id, verdict, designedLines: lines.length, foundLines: found.length, lines: lineReports });
  }
  const warnings = reports.filter((r) => r.verdict !== 'ok').map((r) => `${r.id}: ${r.verdict.replace('-', ' ')} (${r.lines.filter((l) => l.verdict !== 'ok').length} of ${r.lines.length} line(s))`);
  return { pass: reports.every((r) => r.verdict === 'ok'), blocks: reports, unmeasured, warnings, ms: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------------------------------------
// A Studio layout's blocks.
// ---------------------------------------------------------------------------------------------

/** A text block as a Studio layout or the Canva transfer plan (`manifest.plan.text`) records it. */
export type ShapingTextBlock = Omit<TextElement, 'role'> & Partial<Pick<TextElement, 'role'>>;

/**
 * The blocks of a Studio layout (or of the transfer plan a Canva design was imported from) to check, in
 * the pixels of a picture `scale` times the layout's size: 1 for the Studio render, the export's width
 * over the layout's for a Canva PNG. Each block carries the lines and the size the renderer drew it
 * with, the file it measured it with, and the faces the renderer fell back to for characters that file
 * lacks (asked of the same Pango helper the renderer asks: ADR-118). Only blocks whose copy has
 * Arabic-script letters, unless `allScripts`. `colors` adds ink colours by copy index (a run coloured
 * apart in the deck).
 */
export function textShapingBlocks(layout: { text?: ShapingTextBlock[] }, copyText: Record<number, string>,
  options: RenderLayoutOptions & { scale?: number; allScripts?: boolean; colors?: Record<number, string[]> } = {}): ShapingBlockInput[] {
  const scale = options.scale ?? 1;
  const fontsDir = options.fontsDir || defaultFontsDir();
  const blocks: ShapingBlockInput[] = [];
  for (const block of layout.text ?? []) {
    const t: TextElement = { ...block, role: block.role ?? 'body' };
    const typed = copyText[t.copyIndex];
    if (typed === undefined || !typed.trim()) continue;
    const copy = displayedCopy(t, typed);
    if (!options.allScripts && !hasArabicScript(copy)) continue;
    const fontFile = fontFileFor(t.fontFamily, t.bold, t.italic, fontsDir, t.fontWeight);
    const box = { x: t.x * scale, y: t.y * scale, width: t.width * scale, height: t.height * scale };
    let fit: { fontSize: number; letterSpacingEm: number }, lines: string[];
    try {
      fit = fittedTextOf(t, typed, { ...options, fontsDir });
      lines = wrappedLinesOf({ ...t, fontSize: fit.fontSize, letterSpacing: fit.letterSpacingEm }, typed, { ...options, fontsDir });
    } catch (err) {
      // A character no bundled face has (PANGO_MISSING_GLYPHS): the renderer refuses to set the block.
      blocks.push({ id: `text-copy-${t.copyIndex}`, lines: [copy], fontFile, fontSizePx: t.fontSize * scale, lineHeight: t.lineHeight, box,
        rtl: Boolean(t.rtl), colors: [t.color], unmeasurable: `the renderer cannot set it (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    const fitted: TextElement = { ...t, fontSize: fit.fontSize, letterSpacing: fit.letterSpacingEm };
    const spacingEm = effectiveLetterSpacingEm(fitted);
    blocks.push({
      id: `text-copy-${t.copyIndex}`,
      lines,
      fontFile,
      ...(faceLacks(fontFile, copy) ? { fallbackFontFiles: fallbackFaces(t, copy, fit.fontSize, spacingEm, fontsDir, fontFile) } : {}),
      fontSizePx: fit.fontSize * scale,
      letterSpacingPx: spacingEm * fit.fontSize * scale,
      lineHeight: t.lineHeight,
      box,
      rtl: Boolean(t.rtl),
      colors: [...new Set([t.color, ...(t.accentColor ? [t.accentColor] : []), ...(options.colors?.[t.copyIndex] ?? [])])],
    });
  }
  return blocks;
}

function faceLacks(fontFile: string, copy: string): boolean {
  const font = openFont(fontFile);
  return Array.from(copy).some((ch) => !/[\s\p{Default_Ignorable_Code_Point}]/u.test(ch) && font.glyphForCodePoint(ch.codePointAt(0)!).id === 0);
}

/** The files Pango drew a block from besides its own face, as the renderer's fallback shaping reports them. */
function fallbackFaces(t: TextElement, copy: string, size: number, spacingEm: number, fontsDir: string, own: string): string[] {
  try {
    const axes = fontFaceSupports(t.fontFamily, t.bold, t.italic, fontsDir);
    const measured = measurePangoText({ text: copy, family: t.fontFamily, size, width: t.width, spacingPx: Number((spacingEm * size).toFixed(2)),
      rtl: Boolean(t.rtl), bold: axes.bold, italic: axes.italic, fontsDir });
    const files = measured.lines.flatMap((l) => l.fonts.map((f) => f.name.startsWith('package/') ? path.join(fontsDir, f.name.slice(8)) : f.name.slice(7)));
    return [...new Set(files)].filter((f) => path.resolve(f) !== path.resolve(own));
  } catch {
    return [];
  }
}
