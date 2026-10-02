/**
 * ADR-257: where each text frame of a captured one-page PPTX sits on the slide, and the colour,
 * size and weight each of its runs declares. The export QC measures these against the PNG capture of
 * the same Canva version: the frames give the boxes, the PNG the pixels behind them.
 *
 * Canva puts most text inside groups whose child space is scaled (`a:chOff`/`a:chExt`), and its run
 * sizes are in that child space too, so a frame's box and its type size are both carried through
 * every group's transform. Rotation and flips are applied as the box's axis-aligned bounds. A colour
 * is read from the run, then the frame's list style for the paragraph's level, then the shape style;
 * a theme colour (`a:schemeClr`) or a modified one is reported as unresolved, not guessed.
 */
import { parsePptxXml, unzipPptxParts } from './canva-pptx-check.js';

export interface PptxBox { x: number; y: number; width: number; height: number }

export interface PptxRunStyle {
  text: string;
  /** `#RRGGBB`, or null when it could not be resolved (`colorNote` says why). */
  color: string | null;
  colorNote?: string;
  /** The declared size in points, in the frame's own space; multiply by the frame's `scale`. */
  fontSizePt: number | null;
  bold: boolean;
}

export interface PptxTextFrame {
  shapeId: string;
  text: string;
  /** Axis-aligned bounds on the slide, in EMU. */
  box: PptxBox;
  /** How much the enclosing groups scale the frame's contents (1 outside any group). */
  scale: number;
  runs: PptxRunStyle[];
}

export interface PptxTextLayout {
  /** Slide size in EMU (`p:sldSz`). */
  slideWidth: number;
  slideHeight: number;
  frames: PptxTextFrame[];
  /** Text frames with no position of their own (inherited from a layout placeholder). */
  unplaced: Array<{ shapeId: string; text: string; reason: string }>;
}

type Node = Record<string, any>;
/** [a, b, c, d, e, f]: (x, y) -> (a x + c y + e, b x + d y + f). */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const tagOf = (node: Node): string | undefined => Object.keys(node).find((key) => key !== ':@');
const kids = (node: Node | undefined): Node[] => {
  const tag = node && tagOf(node);
  const value = tag ? node![tag] : undefined;
  return Array.isArray(value) ? value : [];
};
const child = (node: Node | undefined, tag: string): Node | undefined => kids(node).find((n) => tagOf(n) === tag);
const path = (node: Node | undefined, ...tags: string[]): Node | undefined =>
  tags.reduce<Node | undefined>((at, tag) => child(at, tag), node);
const attr = (node: Node | undefined, name: string): string | undefined => {
  const value = node?.[':@']?.[`@_${name}`];
  return value === undefined || value === null ? undefined : String(value);
};
const num = (node: Node | undefined, name: string, fallback = 0): number => {
  const value = Number(attr(node, name));
  return Number.isFinite(value) ? value : fallback;
};
const truthy = (value: string | undefined) => value === '1' || value === 'true';

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

interface Xfrm { x: number; y: number; cx: number; cy: number; chX: number; chY: number; chCx: number; chCy: number; rot: number; flipH: boolean; flipV: boolean }

function readXfrm(owner: Node | undefined): Xfrm | undefined {
  const xfrm = child(owner, 'a:xfrm');
  const off = child(xfrm, 'a:off');
  const ext = child(xfrm, 'a:ext');
  if (!xfrm || !off || !ext) return undefined;
  const chOff = child(xfrm, 'a:chOff');
  const chExt = child(xfrm, 'a:chExt');
  return {
    x: num(off, 'x'), y: num(off, 'y'), cx: num(ext, 'cx'), cy: num(ext, 'cy'),
    chX: num(chOff, 'x'), chY: num(chOff, 'y'), chCx: num(chExt, 'cx'), chCy: num(chExt, 'cy'),
    rot: num(xfrm, 'rot') / 60000, flipH: truthy(attr(xfrm, 'flipH')), flipV: truthy(attr(xfrm, 'flipV')),
  };
}

/** Rotation and flips about the box's centre, in its parent's space. */
function aboutCentre(f: Xfrm): Matrix {
  const cx = f.x + f.cx / 2, cy = f.y + f.cy / 2;
  const rad = (f.rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const turn: Matrix = [cos, sin, -sin, cos, 0, 0];
  const flip: Matrix = [f.flipH ? -1 : 1, 0, 0, f.flipV ? -1 : 1, 0, 0];
  return multiply(translate(cx, cy), multiply(turn, multiply(flip, translate(-cx, -cy))));
}

function boundsOf(m: Matrix, f: Xfrm): PptxBox {
  const corners = [[f.x, f.y], [f.x + f.cx, f.y], [f.x, f.y + f.cy], [f.x + f.cx, f.y + f.cy]]
    .map(([x, y]) => apply(m, x, y));
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** A colour element (`a:srgbClr`, `a:sysClr`, `a:schemeClr`, …) as `#RRGGBB`, or why not. */
function colourElement(element: Node | undefined): { color: string | null; note?: string } {
  const tag = element && tagOf(element);
  if (!element || !tag) return { color: null, note: 'empty colour' };
  const modifiers = kids(element).filter((m) => !(tagOf(m) === 'a:alpha' && num(m, 'val', 0) >= 100000));
  if (modifiers.length) return { color: null, note: `colour modified by ${modifiers.map((m) => tagOf(m)).join(', ')}` };
  const hex = tag === 'a:srgbClr' ? attr(element, 'val') : tag === 'a:sysClr' ? attr(element, 'lastClr') : undefined;
  if (hex && /^[0-9a-f]{6}$/i.test(hex)) return { color: `#${hex.toUpperCase()}` };
  if (tag === 'a:schemeClr') return { color: null, note: `theme colour ${attr(element, 'val') || ''}`.trim() };
  return { color: null, note: `unsupported colour ${tag.slice(2)}` };
}

/** The text fill a run-properties element declares, undefined when it declares none. */
function fillColour(props: Node | undefined): { color: string | null; note?: string } | undefined {
  if (!props) return undefined;
  if (child(props, 'a:noFill')) return { color: null, note: 'no fill (invisible text)' };
  for (const other of ['a:gradFill', 'a:pattFill', 'a:blipFill']) {
    if (child(props, other)) return { color: null, note: `${other.slice(2)} text colour` };
  }
  const solid = child(props, 'a:solidFill');
  return solid ? colourElement(kids(solid)[0]) : undefined;
}

function textOf(node: Node | undefined): string {
  return kids(node).filter((n) => tagOf(n) === 'a:t')
    .flatMap((t) => kids(t)).map((n) => String(n['#text'] ?? '')).join('');
}

function readFrame(shape: Node, matrix: Matrix, scale: number): { frame?: PptxTextFrame; unplaced?: PptxTextLayout['unplaced'][number] } | undefined {
  const body = child(shape, 'p:txBody');
  if (!body) return undefined;
  const shapeId = attr(path(shape, 'p:nvSpPr', 'p:cNvPr'), 'id') || '';
  const listStyle = child(body, 'a:lstStyle');
  const fontRef = path(shape, 'p:style', 'a:fontRef');
  const shapeStyleColour = kids(fontRef).length ? colourElement(kids(fontRef)[0]) : undefined;
  const runs: PptxRunStyle[] = [];
  const paragraphs: string[] = [];
  for (const paragraph of kids(body).filter((n) => tagOf(n) === 'a:p')) {
    const level = Math.min(9, Math.max(1, num(child(paragraph, 'a:pPr'), 'lvl', 0) + 1));
    const levelDefaults = path(listStyle, `a:lvl${level}pPr`, 'a:defRPr');
    let line = '';
    for (const run of kids(paragraph).filter((n) => tagOf(n) === 'a:r' || tagOf(n) === 'a:fld')) {
      const text = textOf(run);
      line += text;
      if (!text.trim()) continue;
      const props = child(run, 'a:rPr');
      const colour = fillColour(props) || fillColour(levelDefaults) || shapeStyleColour
        || { color: null, note: 'no colour declared (inherited from the theme or master)' };
      const size = Number(attr(props, 'sz') ?? attr(levelDefaults, 'sz'));
      runs.push({
        text, color: colour.color, ...(colour.note ? { colorNote: colour.note } : {}),
        fontSizePt: Number.isFinite(size) && size > 0 ? size / 100 : null,
        bold: truthy(attr(props, 'b') ?? attr(levelDefaults, 'b')),
      });
    }
    paragraphs.push(line);
  }
  const text = paragraphs.join('\n');
  if (!text.trim()) return undefined;
  const xfrm = readXfrm(child(shape, 'p:spPr'));
  if (!xfrm) return { unplaced: { shapeId, text, reason: 'no position of its own (inherited from a layout placeholder)' } };
  return { frame: { shapeId, text, box: boundsOf(multiply(matrix, aboutCentre(xfrm)), xfrm), scale, runs } };
}

/** Reads the text frames of a captured one-page PPTX: where they sit and how their runs are coloured. */
export function readPptxTextLayout(bytes: Uint8Array): PptxTextLayout {
  const files = unzipPptxParts(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name) || name === 'ppt/presentation.xml');
  const slides = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slides.length !== 1 || !files['ppt/presentation.xml']) throw new Error('Only one-page PPTX is admitted');
  const presentation = parsePptxXml(files['ppt/presentation.xml']).find((n: Node) => tagOf(n) === 'p:presentation');
  const size = child(presentation, 'p:sldSz');
  const slideWidth = num(size, 'cx'), slideHeight = num(size, 'cy');
  if (!(slideWidth > 0 && slideHeight > 0)) throw new Error('The PPTX declares no slide size');
  const slide = parsePptxXml(files[slides[0]]).find((n: Node) => tagOf(n) === 'p:sld');
  const tree = path(slide, 'p:cSld', 'p:spTree');
  const layout: PptxTextLayout = { slideWidth, slideHeight, frames: [], unplaced: [] };

  const walk = (container: Node | undefined, matrix: Matrix, scale: number, depth: number) => {
    if (depth > 32) throw new Error('Groups nested too deep');
    for (const node of kids(container)) {
      const tag = tagOf(node);
      if (tag === 'p:sp') {
        const read = readFrame(node, matrix, scale);
        if (read?.frame) layout.frames.push(read.frame);
        if (read?.unplaced) layout.unplaced.push(read.unplaced);
      } else if (tag === 'p:grpSp') {
        const f = readXfrm(child(node, 'p:grpSpPr'));
        if (!f) { walk(node, matrix, scale, depth + 1); continue; }
        const sx = f.chCx > 0 ? f.cx / f.chCx : 1, sy = f.chCy > 0 ? f.cy / f.chCy : 1;
        const toParent = multiply(aboutCentre(f), multiply(translate(f.x, f.y), multiply([sx, 0, 0, sy, 0, 0], translate(-f.chX, -f.chY))));
        walk(node, multiply(matrix, toParent), scale * Math.sqrt(Math.abs(sx * sy)), depth + 1);
      }
    }
  };
  walk(tree, IDENTITY, 1, 0);
  return layout;
}
