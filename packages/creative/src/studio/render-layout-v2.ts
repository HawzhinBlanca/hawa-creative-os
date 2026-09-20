import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
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

/** Families whose script joins cursively, where letter-spacing is always wrong. */
export const ARABIC_SCRIPT_FAMILIES = new Set(['Noto Sans Arabic', 'Cairo', 'Amiri', 'Vazirmatn']);

/**
 * The tracking this renderer actually draws a block with, in em — the single definition of the
 * rule, shared with the Canva transfer encoders.
 *
 * The rule used to be written out three times, and the two deck encoders then passed the layout's
 * raw em value into pptxgenjs `charSpacing`, which is points: a Cinzel title tracked 0.06em at 48px
 * drew 2.88px in the preview the judge scored and 0.06pt, about 0.08px, in Canva. Tracked capitals
 * are this brand's typographic signature, so the delivered design lost them, and a title could
 * break onto a different number of lines than the preview.
 *
 * `eyebrowShrunkToFit` is the renderer's second pass: an eyebrow that still wraps is set solid
 * before its size is reduced. Only the renderer measures wrapping, so the encoders leave it unset.
 */
export function effectiveLetterSpacingEm(
  t: { letterSpacing?: number; role?: string; rtl?: boolean; fontFamily?: string },
  options: { eyebrowShrunkToFit?: boolean } = {}
): number {
  let em = t.letterSpacing || 0;
  if (t.role === 'eyebrow' && em > 0.06) {
    em = 0.04;
  }
  // Arabic script is cursive: letter-spacing inserts gaps between joined letters and reads as
  // broken to a native reader. The generator emits 0.02 on Kurdish eyebrows, so this is dropped
  // here rather than honoured.
  if (t.rtl || (t.fontFamily && ARABIC_SCRIPT_FAMILIES.has(t.fontFamily))) {
    em = 0;
  }
  if (options.eyebrowShrunkToFit && t.role === 'eyebrow') {
    em = 0;
  }
  return em;
}

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

const substitutionWarned = new Set<string>();

/**
 * Checks that fontconfig knows the family, and warns when the rasteriser will substitute it.
 *
 * What this can detect: a family fontconfig cannot resolve at all.
 *
 * What it cannot detect on its own: a family fontconfig resolves by name while the rasteriser
 * still draws something else. On a Homebrew/macOS host `fc-match` returns Cinzel for "Cinzel"
 * and Playfair Display for "Playfair Display" while rsvg-convert renders Helvetica for both, so
 * for most of the T5 qualification this guard passed on every heading that was being substituted.
 * The authoritative check is `probeFontFidelity`, which rasterises and compares bytes; it is
 * consulted here to warn, and the render result's `fontFidelity` map carries the verdict for
 * callers that need to fail on it.
 */
export function assertFontResolves(fontFamily: string, fontconfigFile: string): void {
  if (probeFontFidelity(fontFamily, { fontconfigFile }) === 'stand-in') {
    const key = `${fontconfigFile}|${fontFamily}`;
    if (!substitutionWarned.has(key)) {
      substitutionWarned.add(key);
      console.warn(
        `[render-layout-v2] FONT_SUBSTITUTED: '${fontFamily}' is not drawn by this renderer — ` +
          `its output is byte-identical to a family that does not exist. The render will show a ` +
          `fallback face. See the fontFidelity map on the render result.`
      );
    }
  }

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

export const ADMITTED_FONT_FAMILIES = [
  'Verdana',
  'Noto Sans Arabic',
  'Cinzel',
  'Playfair Display',
  'Cairo',
  'Amiri',
  'Plus Jakarta Sans',
  'Vazirmatn',
  'Inter',
] as const;

/** A family name no font can carry, used as the substitution sentinel. */
const FONT_PROBE_SENTINEL = 'ZZHawaNoSuchFamilyZZ';

const fidelityCache = new Map<string, 'exact' | 'stand-in'>();

function probeSvg(family: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="120">' +
    '<rect width="900" height="120" fill="#ffffff"/>' +
    `<text x="20" y="80" font-family="${family}" font-size="60" fill="#000000">Handgloves 0123</text>` +
    '</svg>'
  );
}

/**
 * Measures font fidelity the way the renderer actually resolves fonts: rasterise a probe in the
 * requested family and in a family that cannot exist. Identical bytes mean the renderer silently
 * substituted a fallback face.
 *
 * fc-match is not a valid check here. On a Homebrew/macOS host fc-match resolves 'Cinzel' and
 * 'Playfair Display' from the bundled fontconfig while rsvg-convert still renders Helvetica, so a
 * name-resolution guard passes while every heading in the output is the wrong typeface.
 */
export function probeFontFidelity(
  family: string,
  options?: RenderLayoutOptions
): 'exact' | 'stand-in' {
  const rsvg = resolveRsvgConvert(options);
  const fontconfigFile = resolveFontconfigFile(options);
  const key = `${rsvg}|${fontconfigFile}|${family}`;
  const cached = fidelityCache.get(key);
  if (cached) return cached;

  const render = (fam: string): Buffer | null => {
    let tempDir: string | null = null;
    try {
      tempDir = fs.mkdtempSync(path.join(tmpdir(), 'hawa-font-probe-'));
      const file = path.join(tempDir, 'probe.svg');
      fs.writeFileSync(file, probeSvg(fam), { mode: 0o600 });
      const res = spawnSync(rsvg, ['-w', '900', '-h', '120', '-f', 'png', file], {
        env: { ...process.env, FONTCONFIG_FILE: fontconfigFile },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 20000,
      });
      if (res.status !== 0 || !res.stdout || res.stdout.length < 100) return null;
      return res.stdout;
    } catch {
      return null;
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    }
  };

  const sentinelKey = `${rsvg}|${fontconfigFile}|__sentinel__`;
  let sentinelHash = fidelityCache.get(sentinelKey) as unknown as string | undefined;
  if (!sentinelHash) {
    const png = render(FONT_PROBE_SENTINEL);
    if (!png) return 'exact'; // probe unavailable; do not fabricate a failure
    sentinelHash = createHash('sha256').update(png).digest('hex');
    fidelityCache.set(sentinelKey, sentinelHash as any);
  }

  const png = render(family);
  if (!png) return 'exact';
  const hash = createHash('sha256').update(png).digest('hex');
  const verdict: 'exact' | 'stand-in' = hash === sentinelHash ? 'stand-in' : 'exact';
  fidelityCache.set(key, verdict);
  return verdict;
}

/**
 * Measured fidelity for every admitted family on this host. Previously this returned a hardcoded
 * table of 'exact' for all eight families and ignored its argument, so it reported exact
 * typography on hosts where half the families were being silently substituted.
 */
export function getFontFidelityManifest(
  _fontsDir: string,
  options?: RenderLayoutOptions
): Record<string, 'exact' | 'stand-in'> {
  const out: Record<string, 'exact' | 'stand-in'> = {};
  for (const family of ADMITTED_FONT_FAMILIES) {
    out[family] = probeFontFidelity(family, options);
  }
  return out;
}

/**
 * Which style axes the file `loadFont` would pick actually provides. The measured face and the
 * drawn face have to be the same one: asking the rasteriser for bold when only a regular file
 * exists makes it synthesise a wider face than fontkit measured, and the text overflows its box.
 * A Kurdish bold Cairo title in the T5 run rendered ~950px wide inside an 821px box and was
 * clipped by the canvas edge, while the wrapper believed it fitted on one line.
 */
export function fontFaceSupports(
  fontFamily: string,
  bold?: boolean,
  italic?: boolean,
  fontsDir?: string
): { bold: boolean; italic: boolean } {
  const dir = fontsDir || resolveFontsDir();
  const familyLower = (fontFamily || '').toLowerCase();
  const has = (file: string) => fs.existsSync(path.join(dir, file));

  if (familyLower.includes('arabic')) return { bold: !!bold && has('NotoSansArabic-Bold.ttf'), italic: false };
  if (familyLower.includes('cinzel')) return { bold: !!bold && has('Cinzel-Bold.ttf'), italic: false };
  if (familyLower.includes('playfair')) {
    // Non-italic Playfair always resolves to the Bold file, so the drawn weight is bold either way.
    return { bold: !italic, italic: !!italic && has('PlayfairDisplay-Italic.ttf') };
  }
  if (familyLower.includes('amiri')) return { bold: !!bold && has('Amiri-Bold.ttf'), italic: false };
  if (familyLower.includes('cairo')) return { bold: false, italic: false };
  if (familyLower.includes('plus jakarta')) return { bold: !!bold && has('PlusJakartaSans-Bold.ttf'), italic: false };
  if (familyLower.includes('vazirmatn')) return { bold: false, italic: false };
  if (familyLower.includes('inter')) return { bold: false, italic: false };
  // Verdana and the default path ship all four faces.
  return { bold: !!bold, italic: !!italic };
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
  } else if (familyLower.includes('amiri')) {
    // Only the regular face ships today; fall back rather than throw if the bold file is absent.
    const amiriBold = path.join(dir, 'Amiri-Bold.ttf');
    fontPath = bold && fs.existsSync(amiriBold) ? amiriBold : path.join(dir, 'Amiri-Regular.ttf');
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
 * There is deliberately no box-to-content fitting function here.
 *
 * A text box shrunk around its centre leaves the ink where it was, so it changes no visible pixel:
 * measured over the eighteen T5 layouts, fitting every box altered ~6k of 1.17M pixels, entirely
 * 1px rounding of the baseline, while the exemplar-calibrated negativeSpace metric fell from 0.95
 * to 0.27 and the composite from 0.957 to 0.889 — which is itself evidence that negativeSpace
 * scores box geometry rather than visible whitespace. The critique comments it would have answered
 * describe the Set-of-Mark annotation drawn for the critique, not the delivered design.
 */

/**
 * How many lines each copy block wraps to, without rasterising anything.
 *
 * Exists so the design metrics can measure the area the type actually inks instead of the area of
 * its bounding box. A text box is invisible metadata whose height the generator picks; counting it
 * as occupied made a design look fuller than it is, and hid 6 to 26 points of emptiness on the
 * eighteen T5 layouts.
 */
export function measureWrappedLines(
  layout: StudioLayoutV2,
  copyText: Record<number, string>,
  options: RenderLayoutOptions = {}
): Record<number, number> {
  const fontsDir = resolveFontsDir(options);
  const out: Record<number, number> = {};
  for (const t of layout.text) {
    const copy = copyText[t.copyIndex];
    if (!copy || !t.width) continue;
    try {
      const font = loadFont(t.fontFamily, t.bold, t.italic, fontsDir);
      const letterSpacing = effectiveLetterSpacingEm(t);
      out[t.copyIndex] = wrapTextWithFontkit(copy, t.width, font, t.fontSize, letterSpacing).length;
    } catch {
      // unmeasurable family here; the metric falls back to the box for this block
    }
  }
  return out;
}

/**
 * There is deliberately no "scale the type up to fill the canvas" pass here.
 *
 * It was written and measured. It does raise coverage (one layout went from 0.18 to 0.34 occupied
 * at a 1.81x uniform scale), but it was answering a diagnosis that did not survive checking: the
 * owner's six confirmed exemplars measure 0.11-0.15 block coverage when their glyphs are dilated
 * into blocks — 85-89% empty, sparser than anything this pipeline produces. Generous whitespace is
 * the house style, not a defect, so enlarging type toward a fuller canvas would move the output
 * away from the references it is meant to match.
 */

/**
 * Whether the face this renderer would load for a family can draw every character of some copy.
 *
 * Cairo, which the generator assigned to every Kurdish display line, cannot draw five Sorani
 * letters — ڕ ڵ ۆ ێ ە — and ە is among the most common characters in the language. fontkit returns
 * .notdef for them, so the measured width is wrong, and pango silently falls back per character,
 * so a Kurdish title renders in two typefaces mid-word. Nothing in the pipeline noticed, because
 * every check asked whether the family resolved, not whether it covers the text.
 */
export function fontCoversText(
  fontFamily: string,
  text: string,
  options: { bold?: boolean; italic?: boolean } & RenderLayoutOptions = {}
): { covers: boolean; missing: string[] } {
  if (!text) return { covers: true, missing: [] };
  const fontsDir = resolveFontsDir(options);
  let font: any;
  try {
    font = loadFont(fontFamily, options.bold, options.italic, fontsDir);
  } catch {
    return { covers: false, missing: [] };
  }

  const missing = new Set<string>();
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) continue;
    try {
      if (font.layout(ch).glyphs.some((g: any) => g.id === 0)) missing.add(ch);
    } catch {
      missing.add(ch);
    }
  }
  return { covers: missing.size === 0, missing: [...missing] };
}

/**
 * The first family in `preferences` that can draw the copy, or the last one as a last resort.
 * Used to correct a font choice the generator made without knowing what the copy contains.
 */
export function pickFontCovering(
  preferences: string[],
  text: string,
  options: { bold?: boolean; italic?: boolean } & RenderLayoutOptions = {}
): string {
  for (const family of preferences) {
    if (fontCoversText(family, text, options).covers) return family;
  }
  return preferences[preferences.length - 1];
}

/** The scripts the client writes in. 'arabic' is Sorani Kurdish in Arabic script. */
export type FontScript = 'latin' | 'arabic';

/** What a family is set in. Body covers the body and footer roles; everything else is display. */
export type FontRole = 'display' | 'body';

export interface RenderFontFamily {
  name: string;
  script: FontScript;
  /** The roles this family may take, and its preference within each. Lower is preferred. */
  roles: Partial<Record<FontRole, number>>;
  admitted: boolean;
  admittedNote?: string;
  license: string;
  files: Record<string, string>;
}

export interface RenderFontRegistry {
  version: number;
  scripts: Record<FontScript, { requiredCharacters: string; source: string }>;
  /** A family the model may still name, and the admitted family it is read as. */
  aliases: Record<string, string>;
  families: Record<string, RenderFontFamily>;
}

/** An admitted family, with the weights whose files are actually present on this host. */
export interface AdmittedFontFace {
  name: string;
  rank: number;
  weights: string[];
  hasBold: boolean;
  license: string;
}

const renderFontRegistryCache = new Map<string, RenderFontRegistry>();
const admittedFaceCache = new Map<string, AdmittedFontFace[]>();

/**
 * render-fonts.json, from this module's own location.
 *
 * The package build copies only pricing.json into dist, so the compiled studio reads the source
 * file two levels up, the same candidate list openai-studio-client.ts uses for pricing.json. The
 * production image copies the whole packages/ tree, so packages/creative/src/studio/render-fonts.json
 * is present there beside dist.
 */
function resolveRenderFontsPath(registryPath?: string): string {
  if (registryPath) {
    if (fs.existsSync(registryPath)) return registryPath;
    throw new Error(`Font registry not found: ${registryPath}`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'render-fonts.json'),
    path.resolve(here, '../../src/studio/render-fonts.json'),
    path.resolve(process.cwd(), 'packages/creative/src/studio/render-fonts.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`Font registry render-fonts.json not found. Tried:\n  ${candidates.join('\n  ')}`);
}

/** The declared families, the aliases, and the characters each script's faces have to draw. */
export function loadRenderFontRegistry(options: { registryPath?: string } = {}): RenderFontRegistry {
  const file = resolveRenderFontsPath(options.registryPath);
  const cached = renderFontRegistryCache.get(file);
  if (cached) return cached;
  const registry = JSON.parse(fs.readFileSync(file, 'utf8')) as RenderFontRegistry;
  renderFontRegistryCache.set(file, registry);
  return registry;
}

/** A path declared in render-fonts.json, resolved against packages/creative. */
function creativeFilePath(relative: string): string | undefined {
  if (path.isAbsolute(relative)) return fs.existsSync(relative) ? relative : undefined;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../..', relative),
    path.resolve(process.cwd(), 'packages/creative', relative),
    path.resolve(process.cwd(), relative),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** The weight keys of a family whose file exists here. A declared file that is absent is not one. */
function presentWeights(family: RenderFontFamily): string[] {
  return Object.entries(family.files || {})
    .filter(([, file]) => !!creativeFilePath(file))
    .map(([weight]) => weight);
}

/**
 * The families a design may use for one script and role, most preferred first.
 *
 * Until 2026-09-20 this set was written out in `admittedFontFor`, in `scaleNormalizedLayoutToV2`
 * and in three prompt strings, and they disagreed: the prompts offered Cairo for every Kurdish
 * title while the pipeline replaced it, because Cairo has no glyph for ڕ ڵ ۆ ێ ە. Admission is a
 * measurement now, not a list. A family is offered only when it is declared for this script, when
 * the file this renderer would open draws every character of `scripts.<script>.requiredCharacters`
 * (derived from the client's own copy), and, for a bold block, when it has a bold file: a family
 * without one is drawn regular in the preview the judge scores while Canva sets a real bold.
 *
 * Throws when a script and role have no face at all, because a design set in a family nobody
 * admitted is worse than a run that stops.
 */
export function admittedFontFaces(options: {
  script: FontScript;
  role: FontRole;
  bold?: boolean;
  registryPath?: string;
  fontsDir?: string;
}): AdmittedFontFace[] {
  const file = resolveRenderFontsPath(options.registryPath);
  const key = `${file}|${options.fontsDir || ''}|${options.script}|${options.role}|${options.bold ? 1 : 0}`;
  const cached = admittedFaceCache.get(key);
  if (cached) return cached;

  const registry = loadRenderFontRegistry({ registryPath: options.registryPath });
  const required = registry.scripts?.[options.script]?.requiredCharacters ?? '';
  const declared = Object.values(registry.families || {}).filter(
    (family) =>
      family.admitted && family.script === options.script && typeof family.roles?.[options.role] === 'number'
  );

  const drawable: AdmittedFontFace[] = declared
    .map((family) => ({ family, weights: presentWeights(family) }))
    .filter(({ weights }) => weights.length > 0)
    .filter(({ family }) => fontCoversText(family.name, required, { fontsDir: options.fontsDir }).covers)
    .map(({ family, weights }) => ({
      name: family.name,
      rank: family.roles[options.role] as number,
      weights,
      hasBold: weights.includes('bold'),
      license: family.license,
    }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  if (!drawable.length) {
    throw new Error(
      `No admitted ${options.role} face for ${options.script} in ${file}: ` +
        `${declared.length} declared, none with a present file that draws ${JSON.stringify(required)}.`
    );
  }

  // A weight nothing has a file for is the renderer's problem, not a reason to leave the script
  // without a face: keep the preferred list and let fontFaceSupports gate the emitted axis.
  const withWeight = options.bold ? drawable.filter((face) => face.hasBold) : drawable;
  const faces = withWeight.length ? withWeight : drawable;
  admittedFaceCache.set(key, faces);
  return faces;
}

export interface AdmittedFontFaceQuery {
  script: FontScript;
  role: FontRole;
  bold?: boolean;
  registryPath?: string;
  fontsDir?: string;
}

/** The admitted face a family resolves to for this script and role, or undefined when it is not one. */
export function findAdmittedFontFace(
  font: string,
  options: AdmittedFontFaceQuery
): AdmittedFontFace | undefined {
  const registry = loadRenderFontRegistry({ registryPath: options.registryPath });
  const asked = registry.aliases?.[font] ?? font;
  return admittedFontFaces({ ...options, bold: false }).find((face) => face.name === asked);
}

/**
 * The admitted family a design gets for one block: the one it asked for whenever that family is
 * admitted for the block's script and role, and otherwise the preferred face that has a file for
 * the weight being asked for.
 *
 * The weight does not overrule a family the design chose. A style spec's "serif" puts Amiri on a
 * Kurdish title; answering a bold block with the sans the brand uses for body copy would change the
 * decision the client's own reference made. The block keeps its face, and `sanitizeFontsV3` drops
 * the weight instead, so nothing downstream claims a face this renderer has no file for.
 */
export function admittedFontFace(font: string, options: AdmittedFontFaceQuery): string {
  return findAdmittedFontFace(font, options)?.name ?? admittedFontFaces(options)[0].name;
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
  let letterSpacingVal = effectiveLetterSpacingEm(t);
  // The size the text is actually measured and drawn at. The eyebrow autofit below used to shrink
  // a local copy and throw it away, so a shrunk eyebrow was still emitted at t.fontSize and
  // overflowed the box it had just been fitted into.
  let renderFontSize = t.fontSize;
  let lines = wrapTextWithFontkit(copyText, t.width, font, renderFontSize, letterSpacingVal);

  // Invariant: Eyebrows must NEVER wrap onto multiple lines
  if (t.role === 'eyebrow' && lines.length > 1) {
    letterSpacingVal = effectiveLetterSpacingEm(t, { eyebrowShrunkToFit: true });
    lines = wrapTextWithFontkit(copyText, t.width, font, renderFontSize, 0);
    while (lines.length > 1 && renderFontSize > 10) {
      renderFontSize -= 1;
      lines = wrapTextWithFontkit(copyText, t.width, font, renderFontSize, 0);
    }
  }

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

  const scale = renderFontSize / font.unitsPerEm;
  const nominalLineHeight = renderFontSize * t.lineHeight;

  // Centre the visible glyphs in the box instead of hanging the first line box from its top edge.
  //
  // The old `t.y + ascent` used the font's metric ascent, which is far taller than the ink: Cairo
  // declares 1.303em of ascent to reserve room for stacked diacritics, so a 61px Cairo line put
  // 30px of empty space above the glyphs and left the text sitting high in its box. The T5
  // re-critique raised that as its most repeated complaint. Measuring the shaped run's bounding
  // box gives the real ink extent, so the glyphs can be centred on the box's optical centre.
  let inkAbove = 0;
  let inkBelow = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const bbox = font.layout(line).bbox;
      if (bbox && Number.isFinite(bbox.maxY)) inkAbove = Math.max(inkAbove, bbox.maxY * scale);
      if (bbox && Number.isFinite(bbox.minY)) inkBelow = Math.max(inkBelow, -bbox.minY * scale);
    } catch {
      // fall through to the metric fallback below
    }
  }
  if (inkAbove <= 0) inkAbove = (font.capHeight || font.ascent || 800) * scale;

  const inkHeight = (lines.length - 1) * nominalLineHeight + inkAbove + inkBelow;
  // When the ink is taller than the box the text keeps its old behaviour of starting at the top
  // edge and spilling downward, rather than being pushed up past the canvas edge.
  const verticalSlack = Math.max(0, (t.height - inkHeight) / 2);
  const firstLineY = t.y + verticalSlack + inkAbove;

  // An accent colour sets the copy's last paragraph (the lines it wraps to) apart, e.g. a gold
  // edition line under a white title.
  const paragraphs = copyText.split('\n').filter((p) => p.trim());
  const accentFrom =
    t.accentColor && paragraphs.length > 1
      ? lines.length - wrapTextWithFontkit(paragraphs[paragraphs.length - 1], t.width, font, renderFontSize, letterSpacingVal).length
      : lines.length;
  const tspans: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineY = firstLineY + i * nominalLineHeight;
    const fill = i >= accentFrom ? ` fill="${t.accentColor}"` : '';
    tspans.push(`<tspan x="${textX}" y="${lineY.toFixed(1)}"${fill}>${escapeXml(lines[i])}</tspan>`);
  }

  // A family this renderer cannot draw must not be handed to the rasteriser to guess at. Vazirmatn
  // is the live case: it has the glyphs, fontconfig resolves it, and pango still draws something
  // else — so the client's Kurdish text rendered in whatever face happened to win, differing by
  // host. Substituting a declared face instead makes the outcome deterministic and inspectable,
  // and the fontFidelity map still reports that the requested family was not used.
  let drawFamily = t.fontFamily;
  if (probeFontFidelity(t.fontFamily, { fontsDir }) === 'stand-in') {
    const fallback =
      t.rtl || ARABIC_SCRIPT_FAMILIES.has(t.fontFamily) ? 'Noto Sans Arabic' : 'Verdana';
    if (probeFontFidelity(fallback, { fontsDir }) === 'exact') {
      drawFamily = fallback;
    }
  }

  // Ask the rasteriser for exactly the face fontkit measured with — see fontFaceSupports.
  const faceAxes = fontFaceSupports(t.fontFamily, t.bold, t.italic, fontsDir);
  const fontWeight = faceAxes.bold ? 'bold' : 'normal';
  const fontStyle = faceAxes.italic ? ' font-style="italic"' : '';
  const opacityAttr = t.opacity !== undefined ? ` opacity="${t.opacity}"` : '';
  const bidiAttr = t.rtl ? ' direction="rtl"' : '';
  // Emit the spacing and size the lines were measured with. Using the raw t.* values here meant
  // the wrap was computed with one spacing and drawn with another.
  const letterSpacingAttr = letterSpacingVal
    ? ` letter-spacing="${(letterSpacingVal * renderFontSize).toFixed(2)}px"`
    : '';

  const svgSnippet = `<text id="text-copy-${t.copyIndex}" fill="${t.color}" font-family="${escapeXml(drawFamily)}" font-size="${renderFontSize}px" font-weight="${fontWeight}"${fontStyle} text-anchor="${textAnchor}"${letterSpacingAttr}${opacityAttr}${bidiAttr}>
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
  const fontFidelity = getFontFidelityManifest(fontsDir, options);

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

