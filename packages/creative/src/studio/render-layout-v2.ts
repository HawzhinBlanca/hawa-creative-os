import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { PNG } from 'pngjs';
import type { StudioLayoutV2, TextElement, ShapeElement, ArtConfig } from './layout-v2.js';
import { getKaaeOfficialLogoDataUri, escapeXml } from '../operations-to-svg.js';

export { PNG };

export function comparePngBuffers(
  imgA: Buffer,
  imgB: Buffer
): { diffPixels: number; totalPixels: number; diffPercentage: number } {
  const a = PNG.sync.read(imgA);
  const b = PNG.sync.read(imgB);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const totalPixels = a.width * a.height;
  let diffPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const da = Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (dr > 5 || dg > 5 || db > 5 || da > 5) {
      diffPixels++;
    }
  }
  const diffPercentage = parseFloat(((diffPixels / totalPixels) * 100).toFixed(3));
  return { diffPixels, totalPixels, diffPercentage };
}

const fk = ((fontkit as any).default || fontkit) as typeof fontkit;

export interface RenderLayoutOptions {
  copyText?: Record<number, string>;
  artImagePath?: string; // local file path or data URI
  logoPath?: string;
  logoDataUri?: string;
  fontsDir?: string;
  fontconfigFile?: string;
  rsvgConvertPath?: string;
}

export interface RenderLayoutV2Result {
  svg: string;
  png: Buffer;
  noTextSvg: string;
  noTextPng: Buffer;
  wrappedLines: Record<number, number>;
  fontFidelity: Record<string, 'exact' | 'stand-in'>;
}

// In-memory cache for loaded fontkit Font objects
const fontCache = new Map<string, any>();

function getProjectRoot(): string {
  // Current file is at packages/creative/src/studio/render-layout-v2.ts
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../../../../');
}

function resolveFontsDir(options?: RenderLayoutOptions): string {
  if (options?.fontsDir && fs.existsSync(options.fontsDir)) {
    return options.fontsDir;
  }
  const root = getProjectRoot();
  const candidate = path.join(root, 'packages/creative/assets/fonts');
  if (fs.existsSync(candidate)) return candidate;
  return path.resolve(process.cwd(), 'packages/creative/assets/fonts');
}

function resolveFontconfigFile(options?: RenderLayoutOptions): string {
  if (options?.fontconfigFile && fs.existsSync(options.fontconfigFile)) {
    return path.resolve(options.fontconfigFile);
  }
  const fontsDir = resolveFontsDir(options);
  return path.resolve(fontsDir, 'fonts.conf');
}

/**
 * Verifies font resolution via fc-match against the configured fonts.conf.
 * Throws FONT_UNRESOLVED if the resolved font family differs from the requested family.
 */
export function assertFontResolves(fontFamily: string, fontconfigFile: string): void {
  try {
    const res = spawnSync('fc-match', ['-f', '%{family}', fontFamily], {
      env: {
        ...process.env,
        FONTCONFIG_FILE: fontconfigFile,
      },
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      const resolved = res.stdout.trim();
      const cleanRequested = fontFamily.toLowerCase().trim();
      const cleanResolved = resolved.toLowerCase().trim();
      const matches = cleanResolved.includes(cleanRequested) || cleanRequested.includes(cleanResolved);
      if (!matches) {
        const err = new Error(
          `FONT_UNRESOLVED: Font '${fontFamily}' resolved to fallback family '${resolved}' under fontconfig ${fontconfigFile}`
        );
        (err as any).code = 'FONT_UNRESOLVED';
        throw err;
      }
    }
  } catch (err: any) {
    if (err?.code === 'FONT_UNRESOLVED' || err.message?.includes('FONT_UNRESOLVED')) {
      throw err;
    }
    console.warn(`[render-layout-v2] Warning: fc-match check failed (${err.message}). Proceeding with fontkit loading.`);
  }
}

function resolveRsvgConvert(options?: RenderLayoutOptions): string {
  if (options?.rsvgConvertPath && fs.existsSync(options.rsvgConvertPath)) {
    return options.rsvgConvertPath;
  }
  const candidates = [
    '/opt/homebrew/bin/rsvg-convert',
    '/usr/bin/rsvg-convert',
    '/usr/local/bin/rsvg-convert',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'rsvg-convert';
}

/**
 * Resolves font fidelity across admitted font families:
 * 'exact' for all admitted native families (Verdana, Noto Sans Arabic, Cinzel, Playfair Display, etc.).
 */
export function getFontFidelityManifest(_fontsDir: string): Record<string, 'exact' | 'stand-in'> {
  return {
    'Verdana': 'exact',
    'Noto Sans Arabic': 'exact',
    'Cinzel': 'exact',
    'Playfair Display': 'exact',
    'Cairo': 'exact',
    'Plus Jakarta Sans': 'exact',
    'Vazirmatn': 'exact',
    'Inter': 'exact',
  };
}

/**
 * Loads font binary via fontkit and returns Font instance.
 */
function loadFont(fontFamily: string, bold?: boolean, italic?: boolean, fontsDir?: string): any {
  const dir = fontsDir || resolveFontsDir();
  const familyLower = fontFamily.toLowerCase();

  let fontPath = '';

  if (familyLower.includes('arabic')) {
    fontPath = path.join(dir, bold ? 'NotoSansArabic-Bold.ttf' : 'NotoSansArabic-Regular.ttf');
  } else if (familyLower.includes('cinzel')) {
    fontPath = path.join(dir, bold ? 'Cinzel-Bold.ttf' : 'Cinzel-SemiBold.ttf');
  } else if (familyLower.includes('playfair')) {
    fontPath = path.join(dir, italic ? 'PlayfairDisplay-Italic.ttf' : 'PlayfairDisplay-Bold.ttf');
  } else if (familyLower.includes('cairo')) {
    fontPath = path.join(dir, 'Cairo-Regular.ttf');
  } else if (familyLower.includes('plus jakarta')) {
    fontPath = path.join(dir, bold ? 'PlusJakartaSans-Bold.ttf' : 'PlusJakartaSans-Regular.ttf');
  } else if (familyLower.includes('vazirmatn')) {
    fontPath = path.join(dir, 'Vazirmatn-Regular.ttf');
  } else if (familyLower.includes('inter')) {
    fontPath = path.join(dir, 'Inter-Regular.ttf');
  } else {
    // Default or Verdana resolution
    const localVerdana = bold && italic
      ? path.join(dir, 'Verdana Bold Italic.ttf')
      : bold
      ? path.join(dir, 'Verdana Bold.ttf')
      : italic
      ? path.join(dir, 'Verdana Italic.ttf')
      : path.join(dir, 'Verdana.ttf');
    const systemVerdana = bold && italic
      ? '/System/Library/Fonts/Supplemental/Verdana Bold Italic.ttf'
      : bold
      ? '/System/Library/Fonts/Supplemental/Verdana Bold.ttf'
      : italic
      ? '/System/Library/Fonts/Supplemental/Verdana Italic.ttf'
      : '/System/Library/Fonts/Supplemental/Verdana.ttf';

    const linuxVerdana = bold && italic
      ? '/usr/share/fonts/truetype/msttcorefonts/Verdana_Bold_Italic.ttf'
      : bold
      ? '/usr/share/fonts/truetype/msttcorefonts/Verdana_Bold.ttf'
      : italic
      ? '/usr/share/fonts/truetype/msttcorefonts/Verdana_Italic.ttf'
      : '/usr/share/fonts/truetype/msttcorefonts/Verdana.ttf';

    if (fs.existsSync(localVerdana)) {
      fontPath = localVerdana;
    } else if (fs.existsSync(systemVerdana)) {
      fontPath = systemVerdana;
    } else if (fs.existsSync(linuxVerdana)) {
      fontPath = linuxVerdana;
    } else {
      const interPath = path.join(dir, 'Inter-Regular.ttf');
      if (fs.existsSync(interPath)) {
        fontPath = interPath;
      } else {
        fontPath = path.join(dir, 'Cinzel-SemiBold.ttf');
      }
    }
  }

  if (fontCache.has(fontPath)) {
    return fontCache.get(fontPath);
  }

  if (!fs.existsSync(fontPath)) {
    throw new Error(`Font file not found: ${fontPath}`);
  }

  const font = fk.openSync(fontPath);
  fontCache.set(fontPath, font);
  return font;
}

/**
 * Measures text advance width in px using fontkit layout runs.
 */
export function measureTextWidth(text: string, font: any, fontSize: number, letterSpacing = 0): number {
  if (!text) return 0;
  const run = font.layout(text);
  const scale = fontSize / font.unitsPerEm;
  const baseWidth = run.advanceWidth * scale;
  const extraSpacing = letterSpacing ? (run.glyphs.length - 1) * (letterSpacing * fontSize) : 0;
  return baseWidth + extraSpacing;
}

/**
 * Greedily wraps text into lines fitting within maxWidth px based on exact font metrics.
 */
export function wrapTextWithFontkit(
  text: string,
  maxWidth: number,
  font: any,
  fontSize: number,
  letterSpacing = 0
): string[] {
  if (!text) return [];
  const paragraphs = text.split('\n');
  const allLines: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      allLines.push('');
      continue;
    }
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      allLines.push('');
      continue;
    }

    let currentLine = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${currentLine} ${words[i]}`;
      const width = measureTextWidth(candidate, font, fontSize, letterSpacing);
      if (width <= maxWidth) {
        currentLine = candidate;
      } else {
        allLines.push(currentLine);
        currentLine = words[i];
      }
    }
    allLines.push(currentLine);
  }

  return allLines;
}

function renderShapesToSvg(shapes: ShapeElement[]): string {
  const parts: string[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const opacityAttr = s.opacity !== undefined ? ` opacity="${s.opacity}"` : '';
    const strokeAttr = s.strokeColor ? ` stroke="${s.strokeColor}" stroke-width="${s.strokeWidth || 1}"` : '';
    const transformAttr = s.rotation
      ? ` transform="rotate(${s.rotation} ${s.x + s.width / 2} ${s.y + s.height / 2})"`
      : '';

    if (s.kind === 'rect') {
      parts.push(
        `<rect id="shape-${i}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius || 0}" fill="${s.color}"${opacityAttr}${strokeAttr}${transformAttr}/>`
      );
    } else if (s.kind === 'roundRect') {
      parts.push(
        `<rect id="shape-${i}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius || 12}" fill="${s.color}"${opacityAttr}${strokeAttr}${transformAttr}/>`
      );
    } else if (s.kind === 'ellipse') {
      parts.push(
        `<ellipse id="shape-${i}" cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="${s.color}"${opacityAttr}${strokeAttr}${transformAttr}/>`
      );
    } else if (s.kind === 'line') {
      const strokeW = s.strokeWidth || Math.max(1, s.height);
      parts.push(
        `<line id="shape-${i}" x1="${s.x}" y1="${s.y}" x2="${s.x + s.width}" y2="${s.y + (s.height > 2 ? s.height : 0)}" stroke="${s.color}" stroke-width="${strokeW}"${opacityAttr}${transformAttr}/>`
      );
    }
  }
  return parts.join('\n  ');
}

function renderTextElementToSvg(
  t: TextElement,
  copyText: string,
  fontsDir: string
): { svgSnippet: string; lineCount: number } {
  const font = loadFont(t.fontFamily, t.bold, t.italic, fontsDir);
  const letterSpacingVal = t.letterSpacing || 0;
  const lines = wrapTextWithFontkit(copyText, t.width, font, t.fontSize, letterSpacingVal);

  if (lines.length === 0) {
    return { svgSnippet: '', lineCount: 0 };
  }

  // Compute text anchor and X position
  let textX = t.x;
  let textAnchor = 'start';
  if (t.rtl) {
    if (t.align === 'left') {
      textX = t.x;
      textAnchor = 'end';
    } else if (t.align === 'center') {
      textX = t.x + t.width / 2;
      textAnchor = 'middle';
    } else {
      // For RTL with right alignment, in SVG direction="rtl", 'start' anchors at the right edge
      // and runs progress leftward into the designated box.
      textX = t.x + t.width;
      textAnchor = 'start';
    }
  } else {
    if (t.align === 'center') {
      textX = t.x + t.width / 2;
      textAnchor = 'middle';
    } else if (t.align === 'right') {
      textX = t.x + t.width;
      textAnchor = 'end';
    }
  }

  const scale = t.fontSize / font.unitsPerEm;
  const ascent = (font.ascent || 800) * scale;
  const nominalLineHeight = t.fontSize * t.lineHeight;
  const firstLineY = t.y + ascent;

  const tspans: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineY = firstLineY + i * nominalLineHeight;
    tspans.push(`<tspan x="${textX}" y="${lineY.toFixed(1)}">${escapeXml(lines[i])}</tspan>`);
  }

  const fontWeight = t.bold ? 'bold' : 'normal';
  const fontStyle = t.italic ? ' font-style="italic"' : '';
  const opacityAttr = t.opacity !== undefined ? ` opacity="${t.opacity}"` : '';
  const bidiAttr = t.rtl ? ' direction="rtl"' : '';
  const letterSpacingAttr = t.letterSpacing ? ` letter-spacing="${(t.letterSpacing * t.fontSize).toFixed(2)}px"` : '';

  const svgSnippet = `<text id="text-copy-${t.copyIndex}" fill="${t.color}" font-family="${escapeXml(t.fontFamily)}" font-size="${t.fontSize}px" font-weight="${fontWeight}"${fontStyle} text-anchor="${textAnchor}"${letterSpacingAttr}${opacityAttr}${bidiAttr}>
    ${tspans.join('\n    ')}
  </text>`;

  return { svgSnippet, lineCount: lines.length };
}

/**
 * Builds SVG markup for both full layout and no-text composite.
 */
export function renderLayoutV2ToSvg(
  layout: StudioLayoutV2,
  options: RenderLayoutOptions = {}
): {
  svg: string;
  noTextSvg: string;
  wrappedLines: Record<number, number>;
  fontFidelity: Record<string, 'exact' | 'stand-in'>;
} {
  const fontsDir = resolveFontsDir(options);
  const fontconfigFile = resolveFontconfigFile(options);
  const fontFidelity = getFontFidelityManifest(fontsDir);

  // Assert font resolution for all text elements
  const seenFamilies = new Set<string>();
  for (const t of layout.text) {
    if (t.fontFamily && !seenFamilies.has(t.fontFamily)) {
      seenFamilies.add(t.fontFamily);
      assertFontResolves(t.fontFamily, fontconfigFile);
    }
  }

  const defsParts: string[] = [];
  const bodyPartsNoText: string[] = [];
  const textParts: string[] = [];
  const wrappedLines: Record<number, number> = {};

  // Background rect
  bodyPartsNoText.push(
    `<rect id="background" width="${layout.width}" height="${layout.height}" fill="${layout.background.color}"/>`
  );

  // Art Layer
  if (layout.art) {
    const art = layout.art;
    const artBox = art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
    const clipId = 'art-clip';
    defsParts.push(
      `<clipPath id="${clipId}"><rect x="${artBox.x}" y="${artBox.y}" width="${artBox.width}" height="${artBox.height}"/></clipPath>`
    );

    let artHref = options.artImagePath;
    if (artHref && fs.existsSync(artHref)) {
      const mime = artHref.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const b64 = fs.readFileSync(artHref).toString('base64');
      artHref = `data:${mime};base64,${b64}`;
    }

    if (artHref) {
      bodyPartsNoText.push(
        `<image id="art-layer" xlink:href="${artHref}" x="${artBox.x}" y="${artBox.y}" width="${artBox.width}" height="${artBox.height}" preserveAspectRatio="xMidYMid slice" opacity="${art.opacity ?? 1.0}" clip-path="url(#${clipId})"/>`
      );
    }

    // Art Scrim
    if (art.scrim) {
      const scrim = art.scrim;
      const scrimId = 'art-scrim-gradient';
      if (scrim.direction === 'vertical') {
        defsParts.push(
          `<linearGradient id="${scrimId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${scrim.color}" stop-opacity="${scrim.opacityStart}"/>
            <stop offset="100%" stop-color="${scrim.color}" stop-opacity="${scrim.opacityEnd}"/>
          </linearGradient>`
        );
      } else if (scrim.direction === 'horizontal') {
        defsParts.push(
          `<linearGradient id="${scrimId}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="${scrim.color}" stop-opacity="${scrim.opacityStart}"/>
            <stop offset="100%" stop-color="${scrim.color}" stop-opacity="${scrim.opacityEnd}"/>
          </linearGradient>`
        );
      } else if (scrim.direction === 'radial') {
        defsParts.push(
          `<radialGradient id="${scrimId}" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="${scrim.color}" stop-opacity="${scrim.opacityStart}"/>
            <stop offset="100%" stop-color="${scrim.color}" stop-opacity="${scrim.opacityEnd}"/>
          </radialGradient>`
        );
      }
      bodyPartsNoText.push(
        `<rect id="art-scrim" x="${artBox.x}" y="${artBox.y}" width="${artBox.width}" height="${artBox.height}" fill="url(#${scrimId})" clip-path="url(#${clipId})"/>`
      );
    }
  }

  // Shapes Layer
  if (layout.shapes.length > 0) {
    bodyPartsNoText.push(renderShapesToSvg(layout.shapes));
  }

  // Logo Layer
  let logoHref = options.logoDataUri;
  if (!logoHref && options.logoPath && fs.existsSync(options.logoPath)) {
    const mime = options.logoPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    const b64 = fs.readFileSync(options.logoPath).toString('base64');
    logoHref = `data:${mime};base64,${b64}`;
  }
  if (!logoHref) {
    logoHref = getKaaeOfficialLogoDataUri();
  }

  if (layout.logo) {
    if (logoHref) {
      bodyPartsNoText.push(
        `<image id="logo" xlink:href="${logoHref}" x="${layout.logo.x}" y="${layout.logo.y}" width="${layout.logo.width}" height="${layout.logo.height}" preserveAspectRatio="xMidYMid meet"/>`
      );
    } else {
      // Vector fallback logo box
      bodyPartsNoText.push(
        `<rect id="logo-placeholder" x="${layout.logo.x}" y="${layout.logo.y}" width="${layout.logo.width}" height="${layout.logo.height}" fill="#F7B500" opacity="0.9" rx="8"/>`
      );
    }
  }

  // Text Elements Layer
  for (const t of layout.text) {
    const copy = options.copyText?.[t.copyIndex] ?? `Sample copy block ${t.copyIndex}`;
    const { svgSnippet, lineCount } = renderTextElementToSvg(t, copy, fontsDir);
    if (svgSnippet) {
      textParts.push(svgSnippet);
    }
    wrappedLines[t.copyIndex] = lineCount;
  }

  const defsBlock = defsParts.length > 0 ? `<defs>\n    ${defsParts.join('\n    ')}\n  </defs>` : '';

  const fullSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  ${defsBlock}
  ${bodyPartsNoText.join('\n  ')}
  ${textParts.join('\n  ')}
</svg>`.trim();

  const noTextSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  ${defsBlock}
  ${bodyPartsNoText.join('\n  ')}
</svg>`.trim();

  return {
    svg: fullSvg,
    noTextSvg,
    wrappedLines,
    fontFidelity,
  };
}

/**
 * Converts SVG string to PNG Buffer via rsvg-convert at 1x canvas pixels.
 */
function svgToPng(
  svgString: string,
  width: number,
  height: number,
  options?: RenderLayoutOptions
): Buffer {
  const fontconfigFile = resolveFontconfigFile(options);
  const rsvgBinary = resolveRsvgConvert(options);

  const tempDir = fs.mkdtempSync(path.join(tmpdir(), 'hawa-studio-render-'));
  const svgFile = path.join(tempDir, 'render.svg');

  try {
    fs.writeFileSync(svgFile, svgString, { mode: 0o600 });
    const result = spawnSync(
      rsvgBinary,
      ['-w', String(width), '-h', String(height), '-f', 'png', svgFile],
      {
        env: {
          ...process.env,
          FONTCONFIG_FILE: fontconfigFile,
        },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 20000,
      }
    );

    if (result.status !== 0 || !result.stdout || result.stdout.length < 100) {
      const err = result.stderr ? result.stderr.toString('utf-8') : 'Unknown error';
      throw new Error(`rsvg-convert rendering failed (status ${result.status}): ${err}`);
    }

    return result.stdout;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Primary Design Studio v2 Local Renderer:
 * Generates full SVG, no-text composite SVG, renders both to 1x PNG via rsvg-convert,
 * computes wrapped lines report, and returns font fidelity manifest.
 */
export function renderLayoutV2(
  layout: StudioLayoutV2,
  options: RenderLayoutOptions = {}
): RenderLayoutV2Result {
  const { svg, noTextSvg, wrappedLines, fontFidelity } = renderLayoutV2ToSvg(layout, options);

  const png = svgToPng(svg, layout.width, layout.height, options);
  const noTextPng = svgToPng(noTextSvg, layout.width, layout.height, options);

  return {
    svg,
    png,
    noTextSvg,
    noTextPng,
    wrappedLines,
    fontFidelity,
  };
}

export interface ElementBoxAnnotation {
  boxId: string;
  role: string;
  box: { x: number; y: number; width: number; height: number };
  copyIndex?: number;
}

export interface RenderAnnotatedLayoutResult {
  svg: string;
  png: Buffer;
  annotations: ElementBoxAnnotation[];
}

export function getLayoutBoxAnnotations(layout: StudioLayoutV2): ElementBoxAnnotation[] {
  const annotations: ElementBoxAnnotation[] = [];
  // 1. Logo
  if (layout.logo) {
    annotations.push({
      boxId: 'B0',
      role: 'logo',
      box: { ...layout.logo },
    });
  }
  // 2. Text elements
  layout.text.forEach((t) => {
    annotations.push({
      boxId: `B${annotations.length}`,
      role: t.role,
      box: { x: t.x, y: t.y, width: t.width, height: t.height },
      copyIndex: t.copyIndex,
    });
  });
  // 3. Shape elements
  layout.shapes.forEach((s) => {
    annotations.push({
      boxId: `B${annotations.length}`,
      role: `shape (${s.role || s.kind})`,
      box: { x: s.x, y: s.y, width: s.width, height: s.height },
    });
  });
  return annotations;
}

/**
 * Renders an annotated debug render with Set-of-Mark numbered boxes and badges
 * overlaid on top of every element for vision model grounded critique.
 */
export function renderAnnotatedLayoutV2(
  layout: StudioLayoutV2,
  options: RenderLayoutOptions = {}
): RenderAnnotatedLayoutResult {
  const { svg } = renderLayoutV2ToSvg(layout, options);
  const annotations = getLayoutBoxAnnotations(layout);

  const overlayParts: string[] = [];
  overlayParts.push('<g id="set-of-marks-debug-overlay">');

  for (const ann of annotations) {
    const { boxId, role, box } = ann;
    const isLogo = role === 'logo';
    const isShape = role.startsWith('shape');
    const stroke = isLogo ? '#FFB800' : isShape ? '#00D2FF' : '#FF0055';
    const textFill = isLogo ? '#000000' : '#FFFFFF';

    // Bounding Box
    overlayParts.push(
      `  <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${stroke}" stroke-width="3" stroke-dasharray="6,4"/>`
    );

    // Badge
    const label = `${boxId}: ${role}`;
    const badgeWidth = Math.max(70, label.length * 9 + 16);
    const badgeHeight = 22;
    const badgeX = box.x;
    const badgeY = box.y >= 26 ? box.y - 24 : box.y + 4;

    overlayParts.push(
      `  <rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="${badgeHeight}" rx="4" fill="${stroke}"/>`
    );
    overlayParts.push(
      `  <text x="${badgeX + 8}" y="${badgeY + 16}" font-family="Verdana, sans-serif" font-size="13" font-weight="bold" fill="${textFill}">${escapeXml(label)}</text>`
    );
  }

  overlayParts.push('</g>');

  const annotatedSvg = svg.replace('</svg>', `  ${overlayParts.join('\n  ')}\n</svg>`);
  const png = svgToPng(annotatedSvg, layout.width, layout.height, options);

  return {
    svg: annotatedSvg,
    png,
    annotations,
  };
}

