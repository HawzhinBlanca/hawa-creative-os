import { createRequire } from 'node:module';
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs');
import { createHash } from 'node:crypto';
import type { StudioLayoutV2 } from './layout-v2.js';
import { ARABIC_SCRIPT_FAMILIES } from './render-layout-v2.js';
import type { EditableTransferPlan, TransferLogo, TransferOptions } from '../editable-transfer.js';

export interface TransferV2Options extends TransferOptions {
  artBuffer?: Buffer;
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
      bold: t.bold,
      italic: t.italic,
      opacity: t.opacity,
      letterSpacing: t.letterSpacing,
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
  if (layout.art && options.artBuffer) {
    const artBox = layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
    // The layer's opacity travels with the image, as the render applies it. Without it Canva drew
    // generated art at full strength and procedural textures twice as strong as judged.
    const opacity = typeof layout.art.opacity === 'number' ? layout.art.opacity : 1;
    slide.addImage({
      data: `image/png;base64,${options.artBuffer.toString('base64')}`,
      x: artBox.x / 96,
      y: artBox.y / 96,
      w: artBox.width / 96,
      h: artBox.height / 96,
      ...(opacity < 1 ? { transparency: Math.round((1 - opacity) * 100) } : {}),
    });
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
      slide.addShape(pptx.ShapeType.line, {
        ...geom,
        h: 0,
        rotate,
        line: {
          color: hex(shape.strokeColor || shape.color),
          width: Math.max(0.75, (shape.strokeWidth ?? Math.max(1, shape.height)) * 0.75),
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

  // 3. Text (sorted canonically by copyIndex so PPTX shape tree order matches expected copy order)
  const sortedText = [...layout.text].sort((a, b) => a.copyIndex - b.copyIndex);
  for (const t of sortedText) {
    const isArabic = t.rtl === true || ARABIC_SCRIPT_FAMILIES.has(t.fontFamily);
    const textTransparency = t.opacity !== undefined && t.opacity !== null ? Math.round((1 - t.opacity) * 100) : 0;
    slide.addText(copy[t.copyIndex], {
      x: t.x / 96,
      y: t.y / 96,
      w: t.width / 96,
      h: t.height / 96,
      fontFace: t.fontFamily,
      fontSize: t.fontSize * 0.75,
      color: hex(t.color),
      transparency: textTransparency,
      ...(t.letterSpacing !== undefined && t.letterSpacing !== null ? { charSpacing: t.letterSpacing } : {}),
      align: isArabic ? 'right' : t.align,
      bold: t.bold || false,
      italic: t.italic || false,
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
