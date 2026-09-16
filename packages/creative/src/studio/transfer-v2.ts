import { createRequire } from 'node:module';
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs');
import { createHash } from 'node:crypto';
import type { StudioLayoutV2 } from './layout-v2.js';
import type { EditableTransferPlan, TransferLogo, TransferOptions } from '../editable-transfer.js';

export interface TransferV2Options extends TransferOptions {
  artBuffer?: Buffer;
}

export function studioLayoutV2ToTransferPlan(layout: StudioLayoutV2): EditableTransferPlan {
  const isArabicFont = (fontFamily: string) =>
    fontFamily.toLowerCase().includes('arabic') || fontFamily.toLowerCase().includes('vazirmatn');

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
      rtl: isArabicFont(t.fontFamily) || t.align === 'right',
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
      const raw = c.replace('#', '');
      c = `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
    }
    if (!/^#?[a-fA-F0-9]{6}$/.test(c)) throw new Error(`Invalid color: ${color}`);
    return c.replace('#', '');
  };

  if (![layout.width, layout.height].every((n) => Number.isInteger(n) && n >= 320 && n <= 4000)) {
    throw new Error('Unsupported canvas dimensions');
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
    'Plus Jakarta Sans',
    'Vazirmatn',
    'Inter',
    ...(options.extraFonts || []).filter((f) => typeof f === 'string' && /^[A-Za-z0-9 ]{2,40}$/.test(f)),
  ];

  const bounds = (box: { x: number; y: number; width: number; height: number }) => {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.x < 0 ||
      box.y < 0 ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.x + box.width > layout.width ||
      box.y + box.height > layout.height
    ) {
      throw new Error('Layout element exceeds canvas bounds');
    }
  };

  for (const t of layout.text) {
    bounds(t);
    hex(t.color);
    if (!admittedFonts.includes(t.fontFamily) || !Number.isFinite(t.fontSize) || t.fontSize < 12 || t.fontSize > 160) {
      throw new Error(`Unsupported font or unreadable size: ${t.fontFamily} ${t.fontSize}px`);
    }
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
    const artBox = layout.art.box;
    slide.addImage({
      data: `image/png;base64,${options.artBuffer.toString('base64')}`,
      x: artBox.x / 96,
      y: artBox.y / 96,
      w: artBox.width / 96,
      h: artBox.height / 96,
    });
  }

  // 2. Shapes
  for (const shape of layout.shapes) {
    slide.addShape(pptx.ShapeType.rect, {
      x: shape.x / 96,
      y: shape.y / 96,
      w: shape.width / 96,
      h: shape.height / 96,
      fill: { color: hex(shape.color) },
      line: { color: hex(shape.color), transparency: 100 },
    });
  }

  // 3. Text (sorted canonically by copyIndex so PPTX shape tree order matches expected copy order)
  const sortedText = [...layout.text].sort((a, b) => a.copyIndex - b.copyIndex);
  for (const t of sortedText) {
    const isArabic = t.fontFamily === 'Noto Sans Arabic' || t.fontFamily === 'Vazirmatn' || t.align === 'right';
    slide.addText(copy[t.copyIndex], {
      x: t.x / 96,
      y: t.y / 96,
      w: t.width / 96,
      h: t.height / 96,
      fontFace: t.fontFamily,
      fontSize: t.fontSize * 0.75,
      color: hex(t.color),
      align: isArabic ? 'right' : t.align,
      bold: t.bold || false,
      italic: t.italic || false,
      margin: 0,
      lineSpacingMultiple: isArabic ? 1.7 : 1.3,
      breakLine: false,
      vertAnchor: 'top',
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
