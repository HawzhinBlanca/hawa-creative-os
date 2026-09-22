import { lineGeometry } from './line-geometry.js';
import { createRequire } from 'node:module';
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs');
import { createHash } from 'node:crypto';
import type { ArtConfig, Box, Hex, StudioLayoutV2 } from './layout-v2.js';
import { ARABIC_SCRIPT_FAMILIES, effectiveLetterSpacingEm, fontFaceSupports } from './render-layout-v2.js';
import type { EditableTransferPlan, TransferLogo, TransferOptions } from '../editable-transfer.js';

/**
 * Joins a hyphenated or slashed compound — "K-12", "2025/2026" — with invisible word joiners
 * (U+2060), so Canva cannot break the line inside it. The preview breaks lines only at spaces, while
 * Canva also breaks after a hyphen: a Kurdish title set "(K-" at the end of one line and "12)" at
 * the start of the next (task 8fb76534, 2026-09-19). Only the Canva deck gets the joiners; the copy
 * itself, and every check made on it, is unchanged.
 */
export function keepCompoundsWhole(text: string): string {
  return (text || '').replace(/(?<=[\p{L}\p{N}])([-\u2010/])(?=[\p{L}\p{N}])/gu, '\u2060$1\u2060');
}

export interface TransferV2Options extends TransferOptions {
  artBuffer?: Buffer;
  /** Content photos by photoIndex. A placed photo with no bytes is refused: the deck must show what the client sent. */
  photos?: Array<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }>;
}

/** Pixel size of a PNG or a baseline/progressive JPEG, or null. Only the aspect is needed. */
export function imagePixelSize(buffer: Buffer): { width: number; height: number } | null {
  const png = pngPixelSize(buffer);
  if (png) return png;
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    const len = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * The pixel size in a PNG's IHDR chunk, or null when the buffer is not a PNG. Read from the header
 * rather than decoded, because the only thing the deck needs from the art is its aspect.
 */
export function pngPixelSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** One flat piece of the scrim, in layout pixels. */
export interface ScrimShape {
  kind: 'rect' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  color: Hex;
  opacity: number;
}

/** The alpha a single step of the scrim may span before the ramp is cut into more steps. */
const SCRIM_OPACITY_STEP = 0.05;
/** Every step is a layer the client has to scroll past in Canva, so the ramp is capped. */
const SCRIM_MAX_STEPS = 12;
/** pptx alpha is whole percent, so anything under half a percent would be written as invisible. */
const SCRIM_MIN_VISIBLE_OPACITY = 0.005;

function scrimStepCount(start: number, end: number): number {
  const delta = Math.abs(start - end);
  if (delta < SCRIM_MIN_VISIBLE_OPACITY) return 1;
  return Math.min(SCRIM_MAX_STEPS, Math.max(2, Math.ceil(delta / SCRIM_OPACITY_STEP)));
}

/**
 * The art scrim as flat shapes the deck can hold.
 *
 * The renderer draws it as one SVG gradient rect over the art box. PPTX has `a:gradFill`, but
 * pptxgenjs 4.0.1 cannot write it (`ShapeFillProps.type` is only 'none' | 'solid'), so the ramp is
 * approximated by pieces of constant alpha, each sampled at its own midpoint. Residual difference
 * against the preview: the deck's scrim is stepped, not continuous, by at most
 * |opacityStart - opacityEnd| / 12; and the pieces are separate objects in Canva rather than one
 * shape with a gradient fill.
 *
 * Vertical and horizontal scrims tile the box, so each piece carries its target alpha directly.
 * A radial scrim nests, and stacking the same colour gives 1 - product(1 - alpha), so each ring
 * carries only what it has to add on top of the rings already under it.
 */
export function scrimShapesForBox(box: Box, scrim: NonNullable<ArtConfig['scrim']>): ScrimShape[] {
  const { color, opacityStart: start, opacityEnd: end, direction } = scrim;
  const steps = scrimStepCount(start, end);
  const at = (t: number) => start + (end - start) * t;

  if (steps === 1) {
    return [{ kind: 'rect', x: box.x, y: box.y, width: box.width, height: box.height, color, opacity: at(0.5) }];
  }

  if (direction === 'radial') {
    // Nested ellipses can only darken inward. A radial scrim that grows stronger outward has no
    // representation here at all, so it collapses to its mean rather than being drawn inside out.
    if (start < end) {
      return [{ kind: 'rect', x: box.x, y: box.y, width: box.width, height: box.height, color, opacity: at(0.5) }];
    }
    const shapes: ScrimShape[] = [];
    // Outside the inscribed ellipse an SVG radial gradient clamps to its last stop, so a plain
    // rectangle at that stop sits under the rings and fills the corners.
    if (end >= SCRIM_MIN_VISIBLE_OPACITY) {
      shapes.push({ kind: 'rect', x: box.x, y: box.y, width: box.width, height: box.height, color, opacity: end });
    }
    let composited = end;
    for (let j = steps - 1; j >= 0; j--) {
      const own = composited >= 1 ? 0 : (at((j + 0.5) / steps) - composited) / (1 - composited);
      if (own < SCRIM_MIN_VISIBLE_OPACITY) continue;
      const fraction = (j + 1) / steps;
      shapes.push({
        kind: 'ellipse',
        x: box.x + (box.width * (1 - fraction)) / 2,
        y: box.y + (box.height * (1 - fraction)) / 2,
        width: box.width * fraction,
        height: box.height * fraction,
        color,
        opacity: own,
      });
      composited += own * (1 - composited);
    }
    return shapes;
  }

  const shapes: ScrimShape[] = [];
  for (let i = 0; i < steps; i++) {
    const opacity = at((i + 0.5) / steps);
    if (opacity < SCRIM_MIN_VISIBLE_OPACITY) continue;
    if (direction === 'horizontal') {
      // Edges are rounded off the running total, not accumulated, so the pieces tile the box.
      const x0 = box.x + Math.round((box.width * i) / steps);
      const x1 = box.x + Math.round((box.width * (i + 1)) / steps);
      shapes.push({ kind: 'rect', x: x0, y: box.y, width: x1 - x0, height: box.height, color, opacity });
    } else {
      const y0 = box.y + Math.round((box.height * i) / steps);
      const y1 = box.y + Math.round((box.height * (i + 1)) / steps);
      shapes.push({ kind: 'rect', x: box.x, y: y0, width: box.width, height: y1 - y0, color, opacity });
    }
  }
  return shapes;
}

export function effectiveBold(t: { fontFamily: string; bold?: boolean; italic?: boolean }): boolean {
  if ((t.fontFamily || '').toLowerCase().includes('playfair')) {
    return fontFaceSupports(t.fontFamily, t.bold, t.italic).bold;
  }
  return Boolean(t.bold);
}

export function studioLayoutV2ToTransferPlan(layout: StudioLayoutV2): EditableTransferPlan {
  // The layout's own rtl flag decides direction, with the cursive-script families as a safety net.
  // The previous test — an Arabic-ish family name OR right alignment — got this wrong both ways:
  // it missed Amiri entirely, so a centre-aligned Kurdish Amiri title reached Canva without
  // rtlMode (9 of the 18 T5 layouts), and it marked an English right-aligned footer as Kurdish.
  const isRtlBlock = (t: { rtl?: boolean; fontFamily: string }) =>
    t.rtl === true || ARABIC_SCRIPT_FAMILIES.has(t.fontFamily);

  return {
    width: layout.width,
    height: layout.height,
    background: layout.background.color,
    shapes: layout.shapes.map((s) => ({
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      color: s.color,
      kind: s.kind,
      opacity: s.opacity,
      radius: s.radius,
      rotation: s.rotation,
      strokeWidth: s.strokeWidth,
      strokeColor: s.strokeColor,
    })),
    text: [...layout.text]
      .sort((a, b) => a.copyIndex - b.copyIndex)
      .map((t) => ({
      copyIndex: t.copyIndex,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      fontSize: t.fontSize,
      fontFamily: t.fontFamily,
      color: t.color,
      align: t.align,
      bold: effectiveBold(t),
      italic: Boolean(t.italic),
      opacity: t.opacity,
      // The tracking as drawn, in em, not the model's raw request: the plan is both the manifest's
      // record of the delivered design and an input the v1 encoder accepts, and a plan carrying a
      // value the renderer never used describes a design nobody ever saw.
      letterSpacing: effectiveLetterSpacingEm(t),
      lineHeight: t.lineHeight,
      rtl: isRtlBlock(t),
    })),
    logo: layout.logo
      ? {
          x: layout.logo.x,
          y: layout.logo.y,
          width: layout.logo.width,
          height: layout.logo.height,
        }
      : undefined,
  };
}

export async function encodeStudioTransferV2(
  layout: StudioLayoutV2,
  copy: string[],
  logo?: TransferLogo,
  options: TransferV2Options = {}
) {
  const hex = (color: string) => {
    let c = color.trim();
    if (/^#?[a-fA-F0-9]{3}$/.test(c)) {
      c = '#' + c.replace('#', '').split('').map((ch) => ch + ch).join('');
    }
    if (!/^#?[a-fA-F0-9]{6}$/.test(c)) {
      throw new Error(`Invalid hex color: ${color}`);
    }
    return c.replace('#', '').toUpperCase();
  };

  if (!Number.isFinite(layout.width) || !Number.isFinite(layout.height) || layout.width <= 0 || layout.height <= 0) {
    throw new Error('Invalid layout canvas size');
  }
  if (!copy.length || copy.length > 40 || copy.some((t) => !t || t.length > 10000)) {
    throw new Error('Missing or excessive factual copy');
  }
  if (
    layout.text.length !== copy.length ||
    new Set(layout.text.map((t) => t.copyIndex)).size !== copy.length ||
    layout.text.some((t) => !Number.isInteger(t.copyIndex) || t.copyIndex < 0 || t.copyIndex >= copy.length)
  ) {
    throw new Error('Every exact-copy block must appear once');
  }

  const admittedFonts = [
    'Arial',
    'Georgia',
    'Verdana',
    'Times New Roman',
    'Noto Sans Arabic',
    'Cinzel',
    'Playfair Display',
    'Montserrat',
    'Lora',
    'Bodoni Moda',
    'Cairo',
    'Amiri',
    'Plus Jakarta Sans',
    'Vazirmatn',
    'Inter',
    ...(options.extraFonts || []).filter((f) => typeof f === 'string' && /^[A-Za-z0-9 ]{2,40}$/.test(f)),
  ];

  const fontMap = new Map<string, string>();
  for (const font of admittedFonts) {
    fontMap.set(font.toLowerCase().trim(), font);
  }

  const EPSILON = 0.5;
  const bounds = (box: { x: number; y: number; width: number; height: number }) => {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.x < -EPSILON ||
      box.y < -EPSILON ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.x + box.width > layout.width + EPSILON ||
      box.y + box.height > layout.height + EPSILON
    ) {
      throw new Error('Layout element exceeds canvas bounds');
    }
    box.x = Math.max(0, box.x);
    box.y = Math.max(0, box.y);
    if (box.x + box.width > layout.width) {
      box.width = Math.max(1, layout.width - box.x);
    }
    if (box.y + box.height > layout.height) {
      box.height = Math.max(1, layout.height - box.y);
    }
  };

  const maxFontSize = Math.max(240, Math.round(0.25 * layout.height));
  for (const t of layout.text) {
    bounds(t);
    hex(t.color);
    const canonicalFont = fontMap.get(t.fontFamily?.toLowerCase()?.trim());
    if (!canonicalFont || !Number.isFinite(t.fontSize) || t.fontSize < 12 || t.fontSize > maxFontSize) {
      throw new Error(`Unsupported font or unreadable size: ${t.fontFamily} ${t.fontSize}px`);
    }
    t.fontFamily = canonicalFont;
    if (!['left', 'center', 'right'].includes(t.align)) {
      throw new Error(`Invalid text alignment: ${t.align}`);
    }
  }

  if (layout.shapes.length > 40) throw new Error('Excessive shapes');
  for (const shape of layout.shapes) {
    bounds(shape);
    hex(shape.color);
  }

  if (logo && !layout.logo) throw new Error('Required logo omitted');
  if (layout.logo) {
    bounds(layout.logo);
    if (logo && createHash('sha256').update(logo.bytes).digest('hex') !== logo.sha256) {
      throw new Error('Logo hash mismatch');
    }
  }

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'HAWA_STUDIO', width: layout.width / 96, height: layout.height / 96 });
  pptx.layout = 'HAWA_STUDIO';
  pptx.author = 'Hawa Design Studio v2';
  pptx.subject = 'Editable Canva transfer; source copy is immutable';

  const slide = pptx.addSlide();
  slide.background = { color: hex(layout.background.color) };

  // 1. Art layer (if provided)
  if (layout.art) {
    const artBox = layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
    if (![artBox.x, artBox.y, artBox.width, artBox.height].every(Number.isFinite) || artBox.width <= 0 || artBox.height <= 0) {
      throw new Error('Invalid art box');
    }

    if (options.artBuffer) {
      // The layer's opacity travels with the image, as the render applies it. Without it Canva drew
      // generated art at full strength and procedural textures twice as strong as judged.
      const opacity = typeof layout.art.opacity === 'number' ? layout.art.opacity : 1;
      // The renderer draws the art with preserveAspectRatio="xMidYMid slice", so it covers the box
      // and the overflow is cropped evenly. Without `sizing: cover` pptxgenjs stretches the image
      // to the box instead: gpt-image-2.5-sunburst returns 1024x1024 on the dev tier production
      // runs, so on a 1080x1920 story the art reached Canva horizontally squeezed by 1.78x against
      // the preview the judge scored: the preview scales the square by max(w,h)/1024 and crops,
      // while the stretch fits the same square to the box.
      const pixels = pngPixelSize(options.artBuffer);
      slide.addImage({
        data: `image/png;base64,${options.artBuffer.toString('base64')}`,
        x: artBox.x / 96,
        y: artBox.y / 96,
        // `cover` reads the image's aspect off these two, and then the sizing box sets the placed
        // extent, so the natural pixel size goes here and the art box goes in `sizing`.
        w: (pixels ? pixels.width : artBox.width) / 96,
        h: (pixels ? pixels.height : artBox.height) / 96,
        ...(pixels ? { sizing: { type: 'cover', w: artBox.width / 96, h: artBox.height / 96 } } : {}),
        ...(opacity < 1 ? { transparency: Math.round((1 - opacity) * 100) } : {}),
      });
    }

    // The renderer draws the scrim whether or not an art image was produced, so the deck does too.
    // It used to carry no scrim at all, which left Canva showing text over unmuted art while the
    // preview that QA and the judge scored had the wash over it.
    if (layout.art.scrim) {
      const scrim = layout.art.scrim;
      hex(scrim.color);
      for (const piece of scrimShapesForBox(artBox, scrim)) {
        slide.addShape(piece.kind === 'ellipse' ? pptx.ShapeType.ellipse : pptx.ShapeType.rect, {
          x: piece.x / 96,
          y: piece.y / 96,
          w: piece.width / 96,
          h: piece.height / 96,
          fill: { color: hex(piece.color), transparency: Math.round((1 - piece.opacity) * 100) },
          line: { color: hex(piece.color), transparency: 100 },
        });
      }
    }
  }

  // 2. Shapes
  for (const shape of layout.shapes) {
    const kind = shape.kind || 'rect';
    const transparency = shape.opacity !== undefined && shape.opacity !== null ? Math.round((1 - shape.opacity) * 100) : 0;
    const geom = {
      x: shape.x / 96,
      y: shape.y / 96,
      w: shape.width / 96,
      h: shape.height / 96,
    };
    const rotate = typeof shape.rotation === 'number' ? shape.rotation : 0;

    if (kind === 'line') {
      // Same reading as the preview: along the long side, through the middle of the short one.
      const g = lineGeometry(shape);
      slide.addShape(pptx.ShapeType.line, {
        x: g.x1 / 96,
        y: g.y1 / 96,
        w: (g.x2 - g.x1) / 96,
        h: (g.y2 - g.y1) / 96,
        rotate,
        line: {
          color: hex(shape.strokeColor || shape.color),
          width: Math.max(0.75, g.strokeWidth * 0.75),
          transparency,
        },
      });
      continue;
    }

    const type = kind === 'ellipse'
      ? pptx.ShapeType.ellipse
      : kind === 'roundRect'
      ? pptx.ShapeType.roundRect
      : pptx.ShapeType.rect;

    slide.addShape(type, {
      ...geom,
      rotate,
      fill: { color: hex(shape.color), transparency },
      line: shape.strokeColor
        ? {
            color: hex(shape.strokeColor),
            width: Math.max(0.75, (shape.strokeWidth || 1) * 0.75),
            transparency: 0,
          }
        : { color: hex(shape.color), transparency: 100 },
      ...(kind === 'roundRect' && shape.radius ? { rectRadius: shape.radius / 96 } : {}),
    });
  }

  // 2b. Client photos, above the shapes and below the text, as the renderer draws them. `cover` with
  // the natural pixel size, as for the art, so Canva crops the way the preview did.
  for (const p of layout.photos ?? []) {
    const photo = options.photos?.[p.photoIndex];
    if (!photo) throw new Error(`Photo ${p.photoIndex} is placed in the layout but no bytes were provided`);
    const pixels = imagePixelSize(photo.bytes);
    const rounding = p.radius ? Math.min(1, p.radius / (Math.min(p.width, p.height) / 2)) : 0;
    slide.addImage({
      data: `${photo.mimeType};base64,${photo.bytes.toString('base64')}`,
      x: p.x / 96,
      y: p.y / 96,
      w: (pixels ? pixels.width : p.width) / 96,
      h: (pixels ? pixels.height : p.height) / 96,
      ...(pixels ? { sizing: { type: 'cover', w: p.width / 96, h: p.height / 96 } } : {}),
      ...(rounding > 0 ? { rounding: true } : {}),
    });
  }

  // 3. Text (sorted canonically by copyIndex so PPTX shape tree order matches expected copy order)
  const sortedText = [...layout.text].sort((a, b) => a.copyIndex - b.copyIndex);
  for (const t of sortedText) {
    const isArabic = t.rtl === true || ARABIC_SCRIPT_FAMILIES.has(t.fontFamily);
    // The layout's tracking is em; pptxgenjs charSpacing is points, written as
    // spc="round(charSpacing * 100)" (hundredths of a point) on the run properties. Passing the em
    // value raw sent a 0.06em title to Canva as 0.06pt, about 0.08px where the preview drew 2.88px.
    const trackingEm = effectiveLetterSpacingEm(t);
    const textTransparency = t.opacity !== undefined && t.opacity !== null ? Math.round((1 - t.opacity) * 100) : 0;
    // A block with an accent colour is written as runs: its last paragraph in that colour.
    const text = keepCompoundsWhole(copy[t.copyIndex]);
    const paragraphs = text.split('\n').filter((p) => p.trim());
    const runs =
      t.accentColor && paragraphs.length > 1
        ? paragraphs.map((p, i) => ({
            text: p,
            // Paragraph properties come from each run: without rtlMode here the Kurdish title's
            // paragraphs lost rtl="1" and Canva set "(K-12)" on the wrong side (task 777c2921).
            options: {
              breakLine: i < paragraphs.length - 1,
              align: t.align,
              ...(isArabic ? { rtlMode: true, lang: 'ku' } : {}),
              ...(i === (t.accentParagraph === 'first' ? 0 : paragraphs.length - 1) ? { color: hex(t.accentColor!) } : {}),
            },
          }))
        : text;
    slide.addText(runs as any, {
      x: t.x / 96,
      y: t.y / 96,
      w: t.width / 96,
      h: t.height / 96,
      fontFace: t.fontFamily,
      fontSize: t.fontSize * 0.75,
      color: hex(t.color),
      transparency: textTransparency,
      ...(trackingEm ? { charSpacing: trackingEm * t.fontSize * 0.75 } : {}),
      // The layout's own alignment, which the preview drew and the judge scored. Every Kurdish block
      // was forced right, so a centred Kurdish title reached Canva flush right (task 8fb76534,
      // 2026-09-19). With rtl="1" the alignment is still absolute: "ctr" centres, "r" is right.
      align: t.align,
      bold: effectiveBold(t),
      italic: Boolean(t.italic),
      margin: 0,
      lineSpacing: Math.round(t.fontSize * (t.lineHeight || (isArabic ? 1.7 : 1.3)) * 0.75 * 100) / 100,
      breakLine: false,
      vertAnchor: 'middle',
      paraSpaceAfterPt: 0,
      fit: 'resize',
      ...(isArabic ? { rtlMode: true, lang: 'ku' } : {}),
    });
  }

  // 4. Logo
  if (layout.logo && logo) {
    slide.addImage({
      data: `${logo.mimeType};base64,${logo.bytes.toString('base64')}`,
      x: layout.logo.x / 96,
      y: layout.logo.y / 96,
      w: layout.logo.width / 96,
      h: layout.logo.height / 96,
    });
  }

  const bytes = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const plan = studioLayoutV2ToTransferPlan(layout);

  return {
    bytes,
    sha256,
    plan,
    manifest: {
      width: layout.width,
      height: layout.height,
      copy,
      copySha256: createHash('sha256').update(JSON.stringify(copy)).digest('hex'),
      logoSha256: logo?.sha256 || null,
      artSha256: options.artBuffer ? createHash('sha256').update(options.artBuffer).digest('hex') : null,
      plan,
      pptxSha256: sha256,
      version: 2,
    },
  };
}
