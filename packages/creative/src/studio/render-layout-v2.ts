import { gradientSvgDef } from './shape-gradient.js';
import { ornamentSvg } from './brand-elements.js';
import { measurePangoText, measurementRuntimeIdentity, type PangoMeasurement, type MeasurementRuntimeIdentity } from './pango-measurement.js';
import { lineGeometry } from './line-geometry.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import { PNG } from 'pngjs';
import type { StudioLayoutV2, TextElement, ShapeElement, ArtConfig, Box, OverlayElement } from './layout-v2.js';
import { photoLayers, type PhotoCutoutAsset } from './photo-cutout.js';
import { coverCrop, dataUriPixelSize, imagePixelSize, photoZoomFactor, type CoverCropRect } from './photo-crop.js';
import { dataUriBytes, imageDataUri, imageFileExtension, relabelDataUri, sniffImageType } from './image-type.js';
import {
  croppedPhotoSvg,
  cutoutEffectFragment,
  cutoutPersonFragment,
  cutoutPhotoTreated,
  framedPhotoFragment,
  framedPhotoTreated,
  type PhotoFragment,
} from './photo-treatments.js';
import { escapeXml } from '../operations-to-svg.js';
import { SvgFiles, checkInlineDataUris } from './svg-files.js';
import { pinnedFontconfigFile, rasteriserEnv, fontFileInventory, pinnedSystemFontFiles, type FontFileIdentity } from './font-environment.js';
import { resolveRsvgConvert, rendererRuntimeIdentity, type RendererRuntimeIdentity } from './renderer-identity.js';
import { layoutPlacements, type LayoutPlacements } from './placement-map.js';

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
  /**
   * Content photos' bytes, by photoIndex, drawn from files beside the SVG (ADR-035). A placed photo
   * with neither these nor a data URI draws as a labelled slot.
   */
  photoFiles?: Array<{ bytes: Buffer; mediaType?: string } | undefined>;
  /**
   * @deprecated Pass photoFiles. Content photos as data: URIs, by photoIndex, used where photoFiles
   * has none; their bytes are written beside the SVG as files all the same.
   */
  photoDataUris?: string[];
  /**
   * The person cut out of each content photo, by photoIndex. Used only for a photo placed with
   * `treatment: 'cutout'`; such a photo with no cut-out here is drawn framed from photoDataUris.
   */
  photoCutouts?: Array<PhotoCutoutAsset | undefined>;
  fontsDir?: string;
  fontconfigFile?: string;
  rsvgConvertPath?: string;
}

export interface RenderLayoutV2Result {
  /** Reads `files` by name: to open it alone, inline them with `inlineSvgFiles` (svg-files.ts). */
  svg: string;
  png: Buffer;
  noTextSvg: string;
  noTextPng: Buffer;
  /** The pictures both SVGs read, by file name, written beside them when they are rasterised. */
  files: Record<string, Buffer>;
  wrappedLines: Record<number, number>;
  fontFidelity: Record<string, 'exact' | 'stand-in'>;
  /** Where the art's calm region and each photo's crop land in the bytes drawn (ADR-123). */
  placements: LayoutPlacements;
}

/** The bytes the renderer draws for the art and each photo, read from the same options it reads. */
function placementsFor(layout: StudioLayoutV2, options: RenderLayoutOptions): LayoutPlacements {
  const art = options.artImagePath
    ? options.artImagePath.startsWith('data:') ? dataUriBytes(options.artImagePath)
      : fs.existsSync(options.artImagePath) ? fs.readFileSync(options.artImagePath) : undefined
    : undefined;
  const photos = (layout.photos ?? []).reduce<Array<Buffer | undefined>>((all, p) => {
    const uri = options.photoDataUris?.[p.photoIndex];
    all[p.photoIndex] = options.photoFiles?.[p.photoIndex]?.bytes ?? (uri ? dataUriBytes(uri) : undefined);
    return all;
  }, []);
  return layoutPlacements(layout, { art, photos, cutouts: options.photoCutouts });
}

// In-memory cache for loaded fontkit Font objects
const fontCache = new Map<string, { fingerprint: string; sha256: string; font: any }>();

/** Families whose script joins cursively, where letter-spacing is always wrong. */
export const ARABIC_SCRIPT_FAMILIES = new Set([
  'Noto Sans Arabic',
  'Cairo',
  'Amiri',
  'Vazirmatn',
  // Admitted 2026-09-20. Arabic script joins cursively in every family that draws it, so this list
  // has to grow with render-fonts.json or a new Sorani face silently gets Latin letter-spacing
  // applied to joined letters. It should be derived from the registry's script field rather than
  // written out; until it is, adding a family here is part of admitting one.
  'IBM Plex Sans Arabic',
]);

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

/**
 * The fontconfig file every rasterisation uses: the caller's, or one generated to list only the
 * fonts folder and the registry's system files (font-environment.ts). The committed fonts.conf used
 * to be the default, and it listed the system folders too, so a face installed on the host could be
 * drawn in place of the file fontkit measures with.
 */
function resolveFontconfigFile(options?: RenderLayoutOptions): string {
  if (options?.fontconfigFile && fs.existsSync(options.fontconfigFile)) {
    return path.resolve(options.fontconfigFile);
  }
  return pinnedFontconfigFile(resolveFontsDir(options));
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
  // Substitution only: a face drawn from a different file is warned by probeFontFidelity itself,
  // with the file and both widths, and is not "byte-identical to a family that does not exist".
  if (probeFontSubstitution(fontFamily, { fontconfigFile }) === 'stand-in') {
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
      env: rasteriserEnv(fontconfigFile),
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
  // Admitted 2026-09-20. getFontFidelityManifest probes only what this list names, so a family
  // missing from it is never measured for substitution — the exact blindness that let Vazirmatn
  // sit in the registry for days while the renderer drew something else for it.
  'IBM Plex Sans Arabic',
  // Admitted 2026-10-01 (ADR-238): the serif of KAAE's 2025 guideline titles.
  'Crimson Pro',
] as const;

/** A family name no font can carry, used as the substitution sentinel. */
const FONT_PROBE_SENTINEL = 'ZZHawaNoSuchFamilyZZ';

/** Rasterises a probe SVG at its own size, or null when the rasteriser is unavailable or fails. */
function rasteriseProbe(svg: string, rsvg: string, fontconfigFile: string): Buffer | null {
  let tempDir: string | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'hawa-font-probe-'));
    const file = path.join(tempDir, 'probe.svg');
    fs.writeFileSync(file, svg, { mode: 0o600 });
    const res = spawnSync(rsvg, ['-f', 'png', file], {
      env: rasteriserEnv(fontconfigFile),
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
}

/** The samples the ink check draws, one per script the pipeline sets. */
export const FONT_INK_SAMPLES = {
  arabic: 'کوردستان ڕێکخراوی ئەندازیاران ٢٠٢٦',
  latin: 'Handgloves Quality 2026',
} as const;
export type FontProbeScript = keyof typeof FONT_INK_SAMPLES;
/**
 * Drawn when a face lacks part of the script's own sample: Cairo has no glyph for the Sorani letters
 * ڕ ڵ ۆ ێ ە, so its Kurdish would be partly drawn by another face, while its Arabic letters can still
 * be checked against its own file.
 */
export const FONT_INK_BASIC_SAMPLES: Partial<Record<FontProbeScript, string>> = {
  arabic: 'نقابة المهندسين في كوردستان ٢٠٢٦',
};
export const FONT_PROBE_SCRIPTS: readonly FontProbeScript[] = ['latin', 'arabic'];
/** How far the drawn ink may be from fontkit's before the face is called a different one. */
export const FONT_INK_TOLERANCE = 0.02;
/**
 * The tolerance when the probe is byte-identical to the sentinel, i.e. when the family is also the
 * face the rasteriser falls back to. In the image, fontconfig's fallback for a family that does not
 * exist is Vazirmatn, so Vazirmatn's probes equal the sentinel's and the byte test alone called it a
 * stand-in, while its Kurdish ink was 834 px against fontkit's 834.1. Identical bytes then only say
 * "this is the fallback face"; the ink says whether that face is the file, and it has to match closely.
 */
export const FONT_INK_SENTINEL_TOLERANCE = 0.005;
const FONT_INK_SIZE = 60;

export interface FontInkCheck {
  family: string;
  /** The file the pipeline measures this family with (`fontFileFor`), or the one the caller named. */
  fontFile: string;
  /** The script whose sample was drawn; '' when nothing was. */
  script: FontProbeScript | '';
  sizePx: number;
  sample: string;
  /** False when nothing could be measured: no rasteriser, no file, or a face that draws no sample. */
  measured: boolean;
  /** Why nothing was measured: 'uncovered' when the file has no glyph for some of the sample. */
  unmeasuredReason?: 'unopenable' | 'uncovered' | 'no-rasteriser' | 'no-ink';
  ok: boolean;
  renderedInkPx: number;
  expectedInkPx: number;
  expectedAdvancePx: number;
  /** (rendered - expected) / expected. */
  deviation: number;
  /** The drawn probe is byte-identical to the same sample in a family that cannot exist. */
  sameAsSentinel: boolean;
  message: string;
}

const inkCheckCache = new Map<string, FontInkCheck>();
const sentinelHashCache = new Map<string, string | null>();

/** The part of a fontkit font the ink check reads. */
interface InkFont {
  unitsPerEm: number;
  layout(text: string): { advanceWidth: number; bbox: { minX: number; maxX: number }; glyphs: Array<{ id: number }> };
}

/**
 * The probe canvas for a sample at a size: the same for every family, so one sentinel rasterisation
 * serves them all. Twice the widest run the sample could plausibly make (an em per character) plus a
 * margin, with the run centred, so the ink lands inside it whichever way the rasteriser decides the
 * paragraph runs.
 */
function inkProbeCanvasWidth(sample: string, sizePx: number): number {
  return Math.ceil(Array.from(sample).length * sizePx * 2 + 200);
}

function inkProbeSvg(family: string, sample: string, sizePx: number): string {
  const width = inkProbeCanvasWidth(sample, sizePx);
  const height = Math.ceil(sizePx * 2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>` +
    `<text x="${width / 2}" y="${(sizePx * 1.3).toFixed(1)}" font-family="${escapeXml(family)}" font-size="${sizePx}" text-anchor="middle" fill="#000000">${escapeXml(sample)}</text>` +
    `</svg>`
  );
}

/**
 * Draws a sample string with rsvg-convert and compares the width of its ink with the width fontkit
 * computes for the same string in the file the pipeline measures with.
 *
 * The substitution probe cannot see a rasteriser that draws the right family from the wrong file.
 * The Macs did exactly that: pango drew through CoreText, which found a different Noto Sans Arabic
 * in ~/Library/Fonts (283 px of ink against 302 px for one sample). The renderer now pins its fonts
 * (font-environment.ts); this check is what proves the pin holds on a host.
 *
 * Compared: the width of the drawn ink against the ink width of fontkit's laid-out run (its glyph
 * bounding box at the advances fontkit computed), so side bearings do not count against the face.
 * The advance is reported beside it. `script` picks the sample (by default Kurdish when the face
 * covers it, otherwise Latin); `sizePx` the size, because a variable face can be drawn at a different
 * optical size at each one (Inter was 7% narrower at 60 px than fontkit measured).
 */
export function probeFontInkWidth(
  family: string,
  options: RenderLayoutOptions & { fontFile?: string; script?: FontProbeScript; sizePx?: number } = {}
): FontInkCheck {
  const rsvg = resolveRsvgConvert(options);
  const fontconfigFile = resolveFontconfigFile(options);
  const fontsDir = resolveFontsDir(options);
  const fontFile = options.fontFile || fontFileFor(family, false, false, fontsDir);
  const sizePx = options.sizePx ?? FONT_INK_SIZE;
  const key = `${rsvg}|${fontconfigFile}|${family}|${fontFile}|${options.script ?? ''}|${sizePx}`;
  const cached = inkCheckCache.get(key);
  if (cached) return cached;

  const unmeasured = (reason: NonNullable<FontInkCheck['unmeasuredReason']>, why: string, sample = '', script: FontProbeScript | '' = ''): FontInkCheck => ({
    family,
    fontFile,
    script,
    sizePx,
    sample,
    measured: false,
    unmeasuredReason: reason,
    ok: true,
    renderedInkPx: 0,
    expectedInkPx: 0,
    expectedAdvancePx: 0,
    deviation: 0,
    sameAsSentinel: false,
    message: `FONT_INK_UNMEASURED: '${family}' (${fontFile}): ${why}`,
  });

  let font: InkFont;
  try {
    font = fk.openSync(fontFile) as unknown as InkFont;
  } catch {
    return unmeasured('unopenable', 'the file cannot be opened');
  }
  const covers = (text: string) => {
    try {
      return !font.layout(text).glyphs.some((g) => g.id === 0);
    } catch {
      return false;
    }
  };
  const sampleFor = (s: FontProbeScript) =>
    [FONT_INK_SAMPLES[s], FONT_INK_BASIC_SAMPLES[s]].find((text): text is string => !!text && covers(text));
  const script: FontProbeScript | '' = options.script
    ? sampleFor(options.script) ? options.script : ''
    : sampleFor('arabic') ? 'arabic' : sampleFor('latin') ? 'latin' : '';
  if (!script) {
    const which = options.script ? `the ${options.script} samples` : 'any sample';
    const check = unmeasured('uncovered', `the face does not draw ${which}`);
    inkCheckCache.set(key, check);
    return check;
  }
  const sample = sampleFor(script) as string;

  const run = font.layout(sample);
  const scale = sizePx / font.unitsPerEm;
  const expectedAdvancePx = run.advanceWidth * scale;
  const expectedInkPx = (run.bbox.maxX - run.bbox.minX) * scale;
  const png = rasteriseProbe(inkProbeSvg(family, sample, sizePx), rsvg, fontconfigFile);
  if (!png) return unmeasured('no-rasteriser', 'the rasteriser is unavailable', sample, script);

  // The same sample, canvas and size in a family that cannot exist: what the fallback face draws.
  // The canvas depends only on the sample and the size, so every family shares this rasterisation.
  const sentinelKey = `${rsvg}|${fontconfigFile}|${sizePx}|${sample}`;
  if (!sentinelHashCache.has(sentinelKey)) {
    const sentinel = rasteriseProbe(inkProbeSvg(FONT_PROBE_SENTINEL, sample, sizePx), rsvg, fontconfigFile);
    sentinelHashCache.set(sentinelKey, sentinel ? createHash('sha256').update(sentinel).digest('hex') : null);
  }
  const sameAsSentinel = sentinelHashCache.get(sentinelKey) === createHash('sha256').update(png).digest('hex');

  const img = PNG.sync.read(png);
  let left = Infinity;
  let right = -Infinity;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4] < 128) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right < left) return unmeasured('no-ink', 'the rasteriser drew no ink', sample, script);

  const renderedInkPx = right - left + 1;
  const deviation = (renderedInkPx - expectedInkPx) / expectedInkPx;
  const tolerance = sameAsSentinel ? FONT_INK_SENTINEL_TOLERANCE : FONT_INK_TOLERANCE;
  const ok = Math.abs(deviation) <= tolerance;
  const pct = (Math.abs(deviation) * 100).toFixed(1);
  const fallbackNote = sameAsSentinel ? ' It is also the face drawn for a family that does not exist.' : '';
  const message = ok
    ? `FONT_INK_OK: '${family}' drew ${renderedInkPx}px of ${script} ink at ${sizePx}px, fontkit measures ${expectedInkPx.toFixed(1)}px with ${fontFile} (${pct}% apart)`
    : `FONT_INK_MISMATCH: '${family}': ${rsvg} drew ${renderedInkPx}px of ink for "${sample}" at ${sizePx}px, ` +
      `while fontkit measures ${expectedInkPx.toFixed(1)}px (advance ${expectedAdvancePx.toFixed(1)}px) with ${fontFile}: ` +
      `${pct}% apart, over the ${tolerance * 100}% tolerance.${fallbackNote} The rasteriser is drawing a different face from ` +
      `the file the pipeline wraps and measures with (FONTCONFIG_FILE ${fontconfigFile}).`;
  const check: FontInkCheck = {
    family,
    fontFile,
    script,
    sizePx,
    sample,
    measured: true,
    ok,
    renderedInkPx,
    expectedInkPx,
    expectedAdvancePx,
    deviation,
    sameAsSentinel,
    message,
  };
  inkCheckCache.set(key, check);
  return check;
}

/** probeFontInkWidth that throws its message when the rasteriser draws a different face. */
export function assertFontInkWidth(
  family: string,
  options: RenderLayoutOptions & { fontFile?: string; script?: FontProbeScript; sizePx?: number } = {}
): FontInkCheck {
  const check = probeFontInkWidth(family, options);
  if (check.measured && !check.ok) {
    throw Object.assign(new Error(check.message), { code: 'FONT_INK_MISMATCH' });
  }
  return check;
}

/**
 * What one script of a family is drawn with:
 * - exact: the ink matches the file the pipeline measures with;
 * - stand-in: another face is drawn; `substituted` when it is the rasteriser's fallback face
 *   (byte-identical to a family that does not exist), otherwise a same-named face from another file;
 * - uncovered: the file has no glyphs for the script, so there is nothing to compare;
 * - unmeasured: no rasteriser, or it drew nothing.
 */
export interface FontScriptFidelity {
  verdict: 'exact' | 'stand-in' | 'uncovered' | 'unmeasured';
  substituted: boolean;
  ink: FontInkCheck;
}

/**
 * Fidelity per script: each script is judged by what the rasteriser draws for it.
 *
 * The old probe drew one Latin string and called the family a stand-in when its bytes equalled a
 * family that cannot exist. That judged a Kurdish face by its Latin, and it could not tell "this
 * family is missing" from "this family is the fallback face": in the image both of Vazirmatn's
 * probes equal the sentinel's because Vazirmatn is what fontconfig falls back to.
 */
export function probeFontScripts(
  family: string,
  options: RenderLayoutOptions = {}
): Record<FontProbeScript, FontScriptFidelity> {
  const out = {} as Record<FontProbeScript, FontScriptFidelity>;
  for (const script of FONT_PROBE_SCRIPTS) {
    const ink = probeFontInkWidth(family, { ...options, script });
    const verdict: FontScriptFidelity['verdict'] = !ink.measured
      ? ink.unmeasuredReason === 'uncovered' ? 'uncovered' : 'unmeasured'
      : ink.ok ? 'exact' : 'stand-in';
    out[script] = { verdict, substituted: verdict === 'stand-in' && ink.sameAsSentinel, ink };
  }
  return out;
}

/** The script a family is set in: the registry's word for it, otherwise judged from its name. */
export function fontFamilyScript(family: string): FontProbeScript {
  try {
    const families = (loadRenderFontRegistry().families || {}) as Record<string, { name?: string; script?: string }>;
    const declared =
      families[family] || Object.values(families).find((f) => String(f?.name).toLowerCase() === family.toLowerCase());
    if (declared?.script === 'arabic' || declared?.script === 'latin') return declared.script;
  } catch {
    // no registry: fall through to the name
  }
  return ARABIC_SCRIPT_FAMILIES.has(family) || /arabic/i.test(family) ? 'arabic' : 'latin';
}

/**
 * Whether the rasteriser draws its fallback face instead of this family for text in `script` (by
 * default the family's own script). The renderer's choice of a fallback family reads this, so a
 * family only counts as missing for the script a block is actually set in.
 *
 * fc-match is not a valid check here. On a Homebrew/macOS host fc-match resolves 'Cinzel' and
 * 'Playfair Display' from the bundled fontconfig while rsvg-convert, on pango's CoreText backend,
 * rendered Helvetica, so a name-resolution guard passed while every heading was the wrong typeface.
 */
function probeFontSubstitution(
  family: string,
  options?: RenderLayoutOptions,
  script: FontProbeScript = fontFamilyScript(family)
): 'exact' | 'stand-in' {
  return probeFontScripts(family, options ?? {})[script].substituted ? 'stand-in' : 'exact';
}

const inkMismatchWarned = new Set<string>();

/**
 * Font fidelity the way the renderer actually resolves fonts, judged on the family's own script
 * (`fontFamilyScript`): 'stand-in' when the rasteriser draws that script from another face than the
 * file the pipeline measures with, whether its fallback (`probeFontScripts`) or a same-named face from
 * another file (the Mac's Noto Sans Arabic trap). The mismatch is warned once, naming the file and
 * both widths. `probeFontScripts` has the verdict for every script.
 */
export function probeFontFidelity(
  family: string,
  options?: RenderLayoutOptions
): 'exact' | 'stand-in' {
  const result = probeFontScripts(family, options ?? {})[fontFamilyScript(family)];
  if (result.verdict !== 'stand-in') return 'exact';
  const key = `${result.ink.fontFile}|${family}|${resolveFontconfigFile(options)}`;
  if (!inkMismatchWarned.has(key)) {
    inkMismatchWarned.add(key);
    console.warn(`[render-layout-v2] ${result.ink.message}`);
  }
  return 'stand-in';
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

/** Every admitted family's verdict per script, for reports that need to say which script moved. */
export function getFontFidelityByScript(
  options?: RenderLayoutOptions
): Record<string, Record<FontProbeScript, FontScriptFidelity['verdict']>> {
  const out: Record<string, Record<FontProbeScript, FontScriptFidelity['verdict']>> = {};
  for (const family of ADMITTED_FONT_FAMILIES) {
    const scripts = probeFontScripts(family, options ?? {});
    out[family] = { latin: scripts.latin.verdict, arabic: scripts.arabic.verdict };
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

  // Answer from the registry where it declares the family with a real regular face, for the reason
  // in registryFontFile: the substring chain below matches 'IBM Plex Sans Arabic' on 'arabic' and
  // would report Noto's weights for it.
  //
  // Deliberately limited to families that declare a `regular`. Playfair Display and Cinzel declare
  // none — every render of them opens a Bold or SemiBold file whatever weight is asked for — and
  // the chain below encodes that. Answering those from the registry would quietly change which
  // weight the preview draws, which is a separate defect with its own decision to make (the deck
  // sends `bold: t.bold`, so a non-bold Playfair title is drawn bold here and set regular in
  // Canva). Fixing the Plex mis-mapping must not drag that along with it.
  const declared = registryFontFile(fontFamily, false, false, fontsDir);
  const declaredIsRegular = declared && /-Regular\.[to]tf$/i.test(declared);
  if (declaredIsRegular) {
    return {
      bold: !!bold && !!registryFontFile(fontFamily, true, false, fontsDir)?.match(/-Bold\.[to]tf$/i),
      italic: !!italic && !!registryFontFile(fontFamily, false, true, fontsDir)?.match(/Italic\.[to]tf$/i),
    };
  }

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
 * The file render-fonts.json declares for a family and weight, if it declares one.
 *
 * The substring chain below it resolves by testing `familyLower.includes('arabic')` first, which is
 * true of 'IBM Plex Sans Arabic' — so the moment that family was admitted (2026-09-20) every Plex
 * block was measured and drawn from NotoSansArabic-Regular.ttf while the SVG still declared Plex.
 * The block was wrapped in one face and rasterised in another, and `fontCoversText` validated Plex
 * against Noto's glyph table. Any future family whose name contains an existing family's name would
 * have done the same, so the fix is to ask the registry that already declares every file, and to
 * keep the chain only for families it does not name.
 */
function registryFontFile(
  family: string,
  bold?: boolean,
  italic?: boolean,
  fontsDir?: string
): string | undefined {
  let declared: { files?: Record<string, string> } | undefined;
  try {
    const families = loadRenderFontRegistry().families || {};
    declared =
      (families as any)[family] ||
      Object.values(families).find((f: any) => String(f?.name).toLowerCase() === family.toLowerCase());
  } catch {
    return undefined;
  }
  if (!declared?.files) return undefined;

  // Prefer the exact weight, then the nearest the family actually ships. A family that declares no
  // regular (Playfair Display, Cinzel) still answers, with the face the renderer will really draw.
  const order = italic
    ? [bold ? 'boldItalic' : 'italic', 'italic', 'boldItalic', 'regular', 'semiBold', 'bold']
    : bold
      ? ['bold', 'semiBold', 'regular']
      : ['regular', 'semiBold', 'bold'];
  for (const key of order) {
    const rel = declared.files[key];
    if (!rel) continue;
    const abs = fontsDir ? path.join(fontsDir, path.basename(rel)) : creativeFilePath(rel);
    if (abs && fs.existsSync(abs)) return abs;
  }
  return undefined;
}

/**
 * The font file the pipeline measures a family with: the file fontkit opens for wrapping and ink
 * metrics, and so the file the rasteriser has to draw for the preview to match its own measurements.
 */
export function fontFileFor(fontFamily: string, bold?: boolean, italic?: boolean, fontsDir?: string): string {
  const dir = fontsDir || resolveFontsDir();
  const familyLower = fontFamily.toLowerCase();

  // Only families whose registry entry declares a real regular face resolve from the registry; the
  // chain keeps Playfair Display and Cinzel, which declare none. See fontFaceSupports for why.
  const declaredFile = registryFontFile(fontFamily, bold, italic, fontsDir);
  const declaredRegular = registryFontFile(fontFamily, false, false, fontsDir);
  let fontPath = declaredRegular && /-Regular\.[to]tf$/i.test(declaredRegular) ? declaredFile || '' : '';

  if (fontPath) {
    // Declared in render-fonts.json: that file is the answer, whatever the chain below would say.
  } else if (familyLower.includes('arabic')) {
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

  return fontPath;
}

/**
 * Loads font binary via fontkit and returns Font instance.
 */
function loadFontEntry(fontFamily: string, bold?: boolean, italic?: boolean, fontsDir?: string) {
  const fontPath = fontFileFor(fontFamily, bold, italic, fontsDir);
  const fingerprint = () => {
    const st = fs.statSync(fontPath, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  };
  const before = fingerprint(); // Missing files must never reuse an old object.
  const cached = fontCache.get(fontPath);
  if (cached?.fingerprint === before) return cached;
  const bytes = fs.readFileSync(fontPath);
  if (fingerprint() !== before) throw new Error(`Font changed while loading: ${fontPath}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const font = cached?.sha256 === sha256 ? cached.font : fk.create(bytes);
  if (fontCache.size >= 128 && !fontCache.has(fontPath)) fontCache.delete(fontCache.keys().next().value!);
  const entry = { fingerprint: before, sha256, font };
  fontCache.set(fontPath, entry);
  return entry;
}

function loadFont(fontFamily: string, bold?: boolean, italic?: boolean, fontsDir?: string): any {
  return loadFontEntry(fontFamily, bold, italic, fontsDir).font;
}

export type TextMeasurementFailure = 'MISSING_COPY' | 'EMPTY_COPY' | 'INVALID_GEOMETRY' |
  'FONT_UNAVAILABLE' | 'MISSING_GLYPHS' | 'SHAPING_FAILED';

export type TextMeasurement = { copyIndex: number; fontFamily: string } & (
  { status: 'measured'; method: 'fontkit-wrap-v1' | 'pango-wrap-v1'; shaping?: PangoMeasurement; copySha256: string; fontSha256: string;
    inputSha256: string; lineCount: number; maxLineWidthPx: number; requiredHeightPx: number } |
  { status: 'unmeasured'; reason: TextMeasurementFailure; copySha256?: string; missingCodePoints?: string[] }
);

/** Mandatory fit evidence. Optional metric helpers below are deliberately best-effort instead. */
export function measureTextGeometry(
  layout: StudioLayoutV2,
  copyText: Record<number, string> | undefined,
  options: Pick<RenderLayoutOptions, 'fontsDir'> = {}
): TextMeasurement[] {
  return layout.text.map((t): TextMeasurement => {
    const identity = { copyIndex: t.copyIndex, fontFamily: t.fontFamily };
    const copy = copyText && Object.hasOwn(copyText, t.copyIndex) ? copyText[t.copyIndex] : undefined;
    const copySha256 = typeof copy === 'string' ? createHash('sha256').update(copy).digest('hex') : undefined;
    const failed = (reason: TextMeasurementFailure, missingCodePoints?: string[]): TextMeasurement =>
      ({ ...identity, status: 'unmeasured', reason, ...(copySha256 ? { copySha256 } : {}),
        ...(missingCodePoints ? { missingCodePoints } : {}) });
    if (typeof copy !== 'string') return failed('MISSING_COPY');
    // Default-ignorable controls are preserved in the content hash but cannot make an empty block visible.
    if (!copy.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, '')) return failed('EMPTY_COPY');
    const letterSpacing = effectiveLetterSpacingEm(t);
    if (![t.width, t.height, t.fontSize, t.lineHeight].every((n) => Number.isFinite(n) && n > 0) ||
        !Number.isFinite(letterSpacing) || !Number.isFinite(t.letterSpacing ?? 0)) return failed('INVALID_GEOMETRY');
    let entry: ReturnType<typeof loadFontEntry>;
    try {
      // An explicitly unavailable font directory must not turn into the default directory here.
      if (options.fontsDir && !fs.statSync(options.fontsDir).isDirectory()) return failed('FONT_UNAVAILABLE');
      entry = loadFontEntry(t.fontFamily, t.bold, t.italic, resolveFontsDir(options));
    } catch {
      return failed('FONT_UNAVAILABLE');
    }
    try {
      const { font, sha256: fontSha256 } = entry;
      if (!Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0) return failed('SHAPING_FAILED');
      const visible = [...new Set(Array.from(copy).filter((ch) => !/[\s\p{Default_Ignorable_Code_Point}]/u.test(ch)))];
      const missing = visible.filter((ch) => font.glyphForCodePoint(ch.codePointAt(0)).id === 0)
        .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`);
      const shaping = missing.length ? fallbackMeasurement(t, copy, resolveFontsDir(options)) : undefined;
      if (missing.length && (!shaping || shaping.lines.some(line => line.unknownGlyphs > 0))) {
        const actual = shaping ? [...new Set(shaping.lines.flatMap(line => line.missingCodePoints))].map(cp => `U+${cp.toString(16).toUpperCase()}`) : missing;
        return failed('MISSING_GLYPHS', actual.length ? actual : missing);
      }
      const lines = shaping ? shaping.lines.map(line => line.text) : wrapTextWithFontkit(copy, t.width, font, t.fontSize, letterSpacing);
      const widths = shaping ? shaping.lines.map(line => Math.max(line.width, line.ink.x + line.ink.width) - Math.min(0, line.ink.x)) : lines.map((line) => measureTextWidth(line, font, t.fontSize, letterSpacing));
      const maxLineWidthPx = Math.ceil(Math.max(...widths));
      const inkHeight = shaping ? (lines.length - 1) * t.fontSize * t.lineHeight +
        Math.max(0, ...shaping.lines.map(line => -line.ink.y)) + Math.max(0, ...shaping.lines.map(line => line.ink.y + line.ink.height)) : 0;
      const requiredHeightPx = Math.ceil(Math.max(lines.length * t.fontSize * t.lineHeight, inkHeight));
      if (!lines.length || widths.some((n) => !Number.isFinite(n) || n < 0) ||
          !Number.isFinite(requiredHeightPx) || requiredHeightPx <= 0) return failed('SHAPING_FAILED');
      const method = shaping ? 'pango-wrap-v1' as const : 'fontkit-wrap-v1' as const;
      const inputSha256 = createHash('sha256').update(JSON.stringify({ method, ...(shaping ? { shapingSha256: shaping.inputSha256 } : {}), copySha256,
        fontSha256, width: t.width, height: t.height, fontSize: t.fontSize, lineHeight: t.lineHeight,
        letterSpacing, rtl: t.rtl ?? null, bold: t.bold ?? false, italic: t.italic ?? false })).digest('hex');
      return { ...identity, status: 'measured', method, ...(shaping ? { shaping } : {}), copySha256: copySha256!, fontSha256,
        inputSha256, lineCount: lines.length, maxLineWidthPx, requiredHeightPx };
    } catch {
      return failed('SHAPING_FAILED');
    }
  });
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
      out[t.copyIndex] = sharedTextLines(t, copy, font, fontsDir, t.fontSize, letterSpacing).length;
    } catch {
      // unmeasurable family here; the metric falls back to the box for this block
    }
  }
  return out;
}

/**
 * Box widths that stop a block ending on a single stranded word.
 *
 * Wrapping is greedy, so a title one word too long for its box ends "Statutory Accreditation / Order":
 * 11 of the 20 winners of the 2026-09-18 qualification run end a title or paragraph that way. Breaking
 * the line differently in the preview would not reach the client, because Canva wraps the text itself
 * and receives only the box. So the box is narrowed instead: to a width at which the same copy wraps
 * to the same number of lines with the break moved up, which is what CSS calls `text-wrap: balance`.
 *
 * Canva measures type slightly differently, so the tightest such width is not used. The returned
 * width sits halfway between the tightest width and the widest one that still gives the same breaks,
 * leaving room on both sides before a different break appears.
 *
 * Returns a width only for blocks that have a widow and can lose it; line counts never change.
 */
export function balancedBoxWidths(
  layout: StudioLayoutV2,
  copyText: Record<number, string>,
  options: RenderLayoutOptions = {}
): Record<number, number> {
  const fontsDir = resolveFontsDir(options);
  const out: Record<number, number> = {};
  for (const t of layout.text) {
    const copy = copyText[t.copyIndex];
    if (!copy || !t.width || copy.includes('\n')) continue;
    try {
      const font = loadFont(t.fontFamily, t.bold, t.italic, fontsDir);
      const ls = effectiveLetterSpacingEm(t);
      const wrap = (w: number) => sharedTextLines({...t, width: w}, copy, font, fontsDir, t.fontSize, ls);
      const widthOf = (line: string) => {
        const fallback = fallbackMeasurement({...t, width: 1000000}, line, fontsDir);
        if (fallback?.lines.some(l => l.unknownGlyphs)) throw new Error('PANGO_MISSING_GLYPHS');
        return fallback ? Math.max(...fallback.lines.map(l => l.width)) : measureTextWidth(line, font, t.fontSize, ls);
      };
      const lines = wrap(t.width);
      if (lines.length < 2) continue;
      const last = lines[lines.length - 1];
      const widest = Math.max(...lines.map(widthOf));
      const widow = !/\s/.test(last.trim()) && widthOf(last) < 0.5 * widest;
      if (!widow) continue;

      // Tightest width that keeps the line count. Narrower than the longest word can never work.
      const longestWord = Math.max(...copy.trim().split(/\s+/).map(widthOf));
      let lo = Math.ceil(longestWord);
      let hi = Math.floor(t.width);
      if (lo >= hi || wrap(lo).length < lines.length) continue;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (wrap(mid).length <= lines.length) hi = mid;
        else lo = mid + 1;
      }
      const tight = lo;
      const balanced = wrap(tight);
      if (balanced.length !== lines.length) continue;
      const balancedLast = balanced[balanced.length - 1];
      // Only worth a change if the last line is no longer a stranded word.
      if (!/\s/.test(balancedLast.trim()) && widthOf(balancedLast) < 0.5 * Math.max(...balanced.map(widthOf))) continue;

      // Widest width that still gives exactly these breaks.
      const same = (w: number) => {
        const got = wrap(w);
        return got.length === balanced.length && got.every((l, i) => l === balanced[i]);
      };
      let a = tight;
      let b = Math.floor(t.width);
      while (a < b) {
        const mid = Math.ceil((a + b) / 2);
        if (same(mid)) a = mid;
        else b = mid - 1;
      }
      const chosen = Math.round(tight + (a - tight) / 2);
      if (chosen < t.width) out[t.copyIndex] = chosen;
    } catch {
      // unmeasurable family here; the block keeps its box
    }
  }
  return out;
}

/**
 * Measures the maximum rendered line advance width in px for each text block.
 * Catches horizontal overflow where words or lines exceed t.width.
 */
export function measureMaxLineWidths(
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
      const fallback = fallbackMeasurement(t, copy, fontsDir);
      if (fallback) {
        if (fallback.lines.some(line => line.unknownGlyphs)) throw new Error('PANGO_MISSING_GLYPHS');
        out[t.copyIndex] = Math.ceil(Math.max(...fallback.lines.map(line => line.width)));
        continue;
      }
      const lines = wrapTextWithFontkit(copy, t.width, font, t.fontSize, letterSpacing);
      let maxW = 0;
      for (const line of lines) {
        const w = measureTextWidth(line, font, t.fontSize, letterSpacing);
        if (w > maxW) maxW = w;
      }
      out[t.copyIndex] = Math.ceil(maxW);
    } catch {
      // unmeasurable family here; ignored
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

const renderFontRegistryCache = new Map<string, { sha256: string; registry: RenderFontRegistry }>();
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
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const cached = renderFontRegistryCache.get(file);
  if (cached?.sha256 === sha256) return cached.registry;
  const registry = JSON.parse(bytes.toString('utf8')) as RenderFontRegistry;
  admittedFaceCache.clear();
  renderFontRegistryCache.set(file, { sha256, registry });
  return registry;
}

// Remediating Tech Debt Item 16: Derive script families dynamically from registry
try {
  const defaultRegistry = loadRenderFontRegistry();
  if (defaultRegistry?.families) {
    for (const [name, fam] of Object.entries(defaultRegistry.families)) {
      if (fam.script === 'arabic') {
        ARABIC_SCRIPT_FAMILIES.add(name);
        if (fam.name) ARABIC_SCRIPT_FAMILIES.add(fam.name);
      }
    }
  }
} catch {
  // Retains baseline ARABIC_SCRIPT_FAMILIES fallback
}

/** A path declared in render-fonts.json, resolved against packages/creative or host system. */
function creativeFilePath(relative: string): string | undefined {
  if (path.isAbsolute(relative)) return fs.existsSync(relative) ? relative : undefined;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../..', relative),
    path.resolve(process.cwd(), 'packages/creative', relative),
    path.resolve(process.cwd(), relative),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;

  const baseName = path.basename(relative);
  // macOS ships "Verdana Bold.ttf"; the Debian msttcorefonts package ships "Verdana_Bold.ttf".
  const spellings = [...new Set([baseName, baseName.replace(/ /g, '_')])];
  const systemCandidates = spellings.flatMap((name) => [
    path.join('/System/Library/Fonts/Supplemental', name),
    path.join('/System/Library/Fonts', name),
    path.join('/Library/Fonts', name),
    path.join('/usr/share/fonts/truetype/msttcorefonts', name),
  ]);
  const systemFound = systemCandidates.find((candidate) => fs.existsSync(candidate));
  if (systemFound) return systemFound;

  return undefined;
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

/**
 * Shapes as SVG. `indices` keeps each shape's id its index in `layout.shapes` when the shapes are
 * drawn in two layers (ADR-170): under the photos, and over them (`layer: 'overlay'`).
 */
function renderShapesToSvg(shapes: ShapeElement[], indices?: number[]): { svg: string; defs: string[] } {
  const parts: string[] = [];
  const defs: string[] = [];
  for (let k = 0; k < shapes.length; k++) {
    const s = shapes[k];
    const i = indices ? indices[k] : k;
    const opacityAttr = s.opacity !== undefined ? ` opacity="${s.opacity}"` : '';
    const strokeAttr = s.strokeColor ? ` stroke="${s.strokeColor}" stroke-width="${s.strokeWidth || 1}"` : '';
    const transformAttr = s.rotation
      ? ` transform="rotate(${s.rotation} ${s.x + s.width / 2} ${s.y + s.height / 2})"`
      : '';
    let fill = s.fill === 'none' ? 'none' : s.color;
    // ADR-238: a gradient fill (a title bar, a foot rule, a cover's ground) in place of the flat colour.
    if (s.gradient && s.fill !== 'none' && s.kind !== 'line') {
      defs.push(gradientSvgDef(`shape-gradient-${i}`, s.gradient));
      fill = `url(#shape-gradient-${i})`;
    }
    let filterAttr = '';
    if (s.shadow && s.kind !== 'line') {
      defs.push(shapeShadowFilterSvg(`shape-shadow-${i}`, s));
      filterAttr = ` filter="url(#shape-shadow-${i})"`;
    }

    if (s.kind === 'rect') {
      parts.push(
        `<rect id="shape-${i}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius || 0}" fill="${fill}"${opacityAttr}${strokeAttr}${transformAttr}${filterAttr}/>`
      );
    } else if (s.kind === 'roundRect') {
      parts.push(
        `<rect id="shape-${i}" x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius || 12}" fill="${fill}"${opacityAttr}${strokeAttr}${transformAttr}${filterAttr}/>`
      );
    } else if (s.kind === 'ellipse') {
      parts.push(
        `<ellipse id="shape-${i}" cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="${fill}"${opacityAttr}${strokeAttr}${transformAttr}${filterAttr}/>`
      );
    } else if (s.kind === 'line') {
      const g = lineGeometry(s);
      parts.push(
        `<line id="shape-${i}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" stroke="${s.color}" stroke-width="${g.strokeWidth}"${opacityAttr}${transformAttr}/>`
      );
    }
  }
  return { svg: parts.join('\n  '), defs };
}

/**
 * A plate's or card's soft drop shadow (ADR-170): its alpha blurred, moved down, in the shadow's
 * colour and opacity, under the shape itself. The filter region reaches three blur radii past the
 * shape, so nothing of the blur is cut.
 */
export function shapeShadowFilterSvg(id: string, s: Pick<ShapeElement, 'x' | 'y' | 'width' | 'height' | 'shadow'>): string {
  const sh = s.shadow!;
  const reach = Math.ceil(sh.blur * 3 + sh.offsetY);
  return (
    `<filter id="${id}" filterUnits="userSpaceOnUse" x="${s.x - reach}" y="${s.y - reach}" width="${s.width + 2 * reach}" height="${s.height + 2 * reach}" color-interpolation-filters="sRGB">` +
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${sh.blur / 2}" result="blur"/>` +
    `<feOffset in="blur" dx="0" dy="${sh.offsetY}" result="moved"/>` +
    `<feFlood flood-color="${sh.color}" flood-opacity="${sh.opacity}" result="tone"/>` +
    `<feComposite in="tone" in2="moved" operator="in" result="shadow"/>` +
    `<feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter>`
  );
}

/**
 * An overlay gradient (ADR-170) as SVG: a rect in its colour whose opacity runs through its stops
 * along its direction. The preview draws it here, and the Canva transfer bakes exactly this markup
 * into a transparent PNG of its own, so the photo under it stays a native, swappable picture.
 */
export function overlaySvg(o: OverlayElement, id: string): { defs: string; svg: string } {
  if (o.direction === 'radial') {
    // ADR-180: a logo's soft scrim, strongest at the centre and gone at the edge of the ellipse.
    const radial = [...o.stops]
      .sort((a, b) => a.at - b.at)
      .map((st) => `<stop offset="${st.at}" stop-color="${o.color}" stop-opacity="${st.opacity}"/>`)
      .join('');
    return {
      defs: `<radialGradient id="${id}-gradient" cx="0.5" cy="0.5" r="0.5">${radial}</radialGradient>`,
      svg: `<rect id="${id}" x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="url(#${id}-gradient)"/>`,
    };
  }
  const [x1, y1, x2, y2] =
    o.direction === 'to-bottom' ? [0, 0, 0, 1] : o.direction === 'to-top' ? [0, 1, 0, 0] : o.direction === 'to-right' ? [0, 0, 1, 0] : [1, 0, 0, 0];
  const stops = [...o.stops]
    .sort((a, b) => a.at - b.at)
    .map((st) => `<stop offset="${st.at}" stop-color="${o.color}" stop-opacity="${st.opacity}"/>`)
    .join('');
  return {
    defs: `<linearGradient id="${id}-gradient" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`,
    svg: `<rect id="${id}" x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="url(#${id}-gradient)"/>`,
  };
}

export { overlayOpacityAt } from './art-direction/surfaces.js';

/**
 * The words of `accentText` within the copy, as word indices [from, to): its first occurrence as a
 * whole-word sequence. Undefined when it is empty or not in the copy.
 */
export function accentWordRange(copyText: string, accentText: string | undefined): { from: number; to: number } | undefined {
  const want = String(accentText || '').split(/\s+/).filter(Boolean);
  if (!want.length) return undefined;
  const all = copyText.split(/\s+/).filter(Boolean);
  for (let a = 0; a + want.length <= all.length; a++) {
    if (want.every((w, k) => all[a + k] === w)) return { from: a, to: a + want.length };
  }
  return undefined;
}

/** Actual family emitted into SVG; shared with fallback measurement. */
function drawingFontFamily(t: TextElement, copy: string, fontsDir: string): string {
  const script: FontProbeScript = t.rtl || /[\u0600-\u06FF]/.test(copy) ? 'arabic' : 'latin';
  if (probeFontSubstitution(t.fontFamily, {fontsDir}, script) === 'stand-in') {
    const fallback = t.rtl || ARABIC_SCRIPT_FAMILIES.has(t.fontFamily) ? 'Noto Sans Arabic' : 'Verdana';
    if (probeFontSubstitution(fallback, {fontsDir}, script) === 'exact') return fallback;
  }
  return t.fontFamily;
}

function fallbackMeasurement(t: TextElement, copy: string, fontsDir: string, size=t.fontSize, spacing=effectiveLetterSpacingEm(t)): PangoMeasurement | undefined {
  const font = loadFont(t.fontFamily, t.bold, t.italic, fontsDir);
  const missing = Array.from(copy).some(ch => !/[\s\p{Default_Ignorable_Code_Point}]/u.test(ch) && font.glyphForCodePoint(ch.codePointAt(0)).id === 0);
  if (!missing) return undefined;
  const axes = fontFaceSupports(t.fontFamily, t.bold, t.italic, fontsDir);
  return measurePangoText({text: copy, family: drawingFontFamily(t, copy, fontsDir), size, width: t.width,
    spacingPx: Number((spacing * size).toFixed(2)), rtl: t.rtl ?? false, bold: axes.bold, italic: axes.italic, fontsDir});
}

function sharedTextLines(t: TextElement, copy: string, font: ReturnType<typeof loadFont>, fontsDir: string, size=t.fontSize, spacing=effectiveLetterSpacingEm(t)): string[] {
  const fallback = fallbackMeasurement(t, copy, fontsDir, size, spacing);
  if (!fallback) return wrapTextWithFontkit(copy, t.width, font, size, spacing);
  if (fallback.lines.some(line => line.unknownGlyphs)) throw new Error('PANGO_MISSING_GLYPHS');
  return fallback.lines.map(line => line.text);
}

/** The lines one text element wraps to, as the renderer draws them. */
export function wrappedLinesOf(t: TextElement, copy: string, options: RenderLayoutOptions = {}): string[] {
  const font = loadFont(t.fontFamily, t.bold, t.italic, resolveFontsDir(options));
  return sharedTextLines(t, copy, font, resolveFontsDir(options));
}

/**
 * The size and tracking a text element is drawn at, and the lines it wraps to.
 *
 * Invariant: an eyebrow NEVER wraps onto multiple lines. One that would is drawn without its
 * tracking and, while that is not enough, a pixel smaller at a time down to 10 px. The autofit used
 * to shrink a local copy and throw it away, so a shrunk eyebrow was still emitted at t.fontSize and
 * overflowed the box it had just been fitted into. The transfer reads the size and tracking from here
 * too (fittedTextOf): it wrote the layout's own, so Canva wrapped a shrunk eyebrow onto a second
 * line the approved preview did not have (2026-09-24).
 */
function fitText(t: TextElement, copyText: string, font: ReturnType<typeof loadFont>, fontsDir: string): { fontSize: number; letterSpacingEm: number; lines: string[] } {
  let letterSpacingEm = effectiveLetterSpacingEm(t);
  let fontSize = t.fontSize;
  let lines = sharedTextLines(t, copyText, font, fontsDir, fontSize, letterSpacingEm);
  if (t.role === 'eyebrow' && lines.length > 1) {
    letterSpacingEm = effectiveLetterSpacingEm(t, { eyebrowShrunkToFit: true });
    lines = sharedTextLines(t, copyText, font, fontsDir, fontSize, 0);
    while (lines.length > 1 && fontSize > 10) {
      fontSize -= 1;
      lines = sharedTextLines(t, copyText, font, fontsDir, fontSize, 0);
    }
  }
  return { fontSize, letterSpacingEm, lines };
}

/** The size (px) and tracking (em) the renderer draws one text element at, for the transfer. */
export function fittedTextOf(t: TextElement, copy: string, options: RenderLayoutOptions = {}): { fontSize: number; letterSpacingEm: number } {
  const { fontSize, letterSpacingEm } = fitText(t, copy, loadFont(t.fontFamily, t.bold, t.italic, resolveFontsDir(options)), resolveFontsDir(options));
  return { fontSize, letterSpacingEm };
}

function renderTextElementToSvg(
  t: TextElement,
  copyText: string,
  fontsDir: string
): { svgSnippet: string; lineCount: number } {
  const font = loadFont(t.fontFamily, t.bold, t.italic, fontsDir);
  // The size and tracking the text is actually measured and drawn at (fitText).
  const { fontSize: renderFontSize, letterSpacingEm: letterSpacingVal, lines } = fitText(t, copyText, font, fontsDir);

  if (lines.length === 0) {
    return { svgSnippet: '', lineCount: 0 };
  }

  // Text anchor and X position, with their left-to-right meanings for every line, Kurdish included.
  //
  // A right-to-left line used to be set with direction="rtl", which flips what 'start' and 'end'
  // mean. resvg ignores `direction` (its bidi base level is hard-coded to left-to-right), and any
  // renderer that does the same would run a right-aligned Kurdish line off its box. The line now
  // carries its own direction instead (RIGHT-TO-LEFT EMBEDDING ... POP DIRECTIONAL FORMATTING, below),
  // which every bidi implementation honours; on librsvg 2.54 and 2.62 the pixels are identical to the
  // direction="rtl" markup for right, centre and left alignment (ADR-036).
  let textX = t.x;
  let textAnchor = 'start';
  if (t.align === 'center') {
    textX = t.x + t.width / 2;
    textAnchor = 'middle';
  } else if (t.align === 'right') {
    textX = t.x + t.width;
    textAnchor = 'end';
  }
  const lineText = (line: string) => (t.rtl && line ? `\u202B${escapeXml(line)}\u202C` : escapeXml(line));

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
  const shaped = fallbackMeasurement(t, copyText, fontsDir, renderFontSize, letterSpacingVal);
  if (shaped) {
    inkAbove = Math.max(0, ...shaped.lines.map(line => -line.ink.y));
    inkBelow = Math.max(0, ...shaped.lines.map(line => line.ink.y + line.ink.height));
  }
  for (const line of shaped ? [] : lines) {
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

  // An accent colour sets one paragraph of the copy (the lines it wraps to) apart: the last by
  // default (a gold edition line under a white title), or the first ("MEET KAAE AT" in gold above
  // the event's name, the treatment of the reference on 2026-09-22).
  const paragraphs = copyText.split('\n').filter((p) => p.trim());
  const accented = Boolean(t.accentColor) && paragraphs.length > 1;
  const accentFirst = t.accentParagraph === 'first';
  const wrapped = (p: string) => sharedTextLines(t, p, font, fontsDir, renderFontSize, letterSpacingVal).length;
  const accentFrom = accented && !accentFirst ? lines.length - wrapped(paragraphs[paragraphs.length - 1]) : lines.length;
  const accentUntil = accented && accentFirst ? wrapped(paragraphs[0]) : 0;
  // Named words take precedence: the lines wrap on words, so a running word count says which of
  // each line's words are the accented ones.
  const wordRange = t.accentColor && !t.rtl && !/[\u0600-\u06FF]/.test(copyText) ? accentWordRange(copyText, t.accentText) : undefined;
  const tspans: string[] = [];
  let wordAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineY = firstLineY + i * nominalLineHeight;
    if (wordRange) {
      const words = lines[i].split(/\s+/).filter(Boolean);
      const segments: Array<{ text: string; accent: boolean }> = [];
      for (const w of words) {
        const accent = wordAt >= wordRange.from && wordAt < wordRange.to;
        const last = segments[segments.length - 1];
        if (last && last.accent === accent) last.text += ` ${w}`;
        else segments.push({ text: (last ? '\u00a0' : '') + w, accent });
        wordAt++;
      }
      const parts = segments.map((seg, k) =>
        `<tspan${k === 0 ? ` x="${textX}" y="${lineY.toFixed(1)}"` : ''}${seg.accent ? ` fill="${t.accentColor}"` : ''}>${escapeXml(seg.text)}</tspan>`
      );
      tspans.push(parts.length ? parts.join('') : `<tspan x="${textX}" y="${lineY.toFixed(1)}"></tspan>`);
      continue;
    }
    const fill = i >= accentFrom || i < accentUntil ? ` fill="${t.accentColor}"` : '';
    tspans.push(`<tspan x="${textX}" y="${lineY.toFixed(1)}"${fill}>${lineText(lines[i])}</tspan>`);
  }

  // A family this renderer cannot draw must not be handed to the rasteriser to guess at: drawing
  // the fallback face in its place differed by host. Substituting a declared face instead makes the
  // outcome deterministic and inspectable, and the fontFidelity map still reports that the requested
  // family was not used. The family is judged for the script this block is set in: Vazirmatn used to
  // be replaced here because its Latin probe matched the fallback's, while its Kurdish, which is what
  // a Vazirmatn block carries, was drawn from its own file (it *is* the image's fallback face).
  const drawFamily = drawingFontFamily(t, copyText, fontsDir);

  // Ask the rasteriser for exactly the face fontkit measured with — see fontFaceSupports.
  const faceAxes = fontFaceSupports(t.fontFamily, t.bold, t.italic, fontsDir);
  const fontWeight = faceAxes.bold ? 'bold' : 'normal';
  const fontStyle = faceAxes.italic ? ' font-style="italic"' : '';
  const opacityAttr = t.opacity !== undefined ? ` opacity="${t.opacity}"` : '';
  // Emit the spacing and size the lines were measured with. Using the raw t.* values here meant
  // the wrap was computed with one spacing and drawn with another.
  const letterSpacingAttr = letterSpacingVal
    ? ` letter-spacing="${(letterSpacingVal * renderFontSize).toFixed(2)}px"`
    : '';

  // Nothing but the tspans inside <text>. The newline and indent that used to sit between them are
  // character data: librsvg keeps one space of it at the end of each line, so a centred line moved
  // left by half a space and an end-anchored one by a whole space (7 and 14 px at 40 px Verdana).
  const svgSnippet = `<text id="text-copy-${t.copyIndex}" fill="${t.color}" font-family="${escapeXml(drawFamily)}" font-size="${renderFontSize}px" font-weight="${fontWeight}"${fontStyle} text-anchor="${textAnchor}"${letterSpacingAttr}${opacityAttr}>${tspans.join('')}</text>`;

  return { svgSnippet, lineCount: lines.length };
}

/**
 * One part of a cut-out photo (its shadow or the person) as an SVG image at the exact rect from
 * `cutoutPlacement`, with preserveAspectRatio="none". The rect already has the PNG's aspect, and the
 * transfer places the same rect, so neither side crops or fits anything itself. No clip-path and no
 * corner radius: the person's own transparency is the edge, and the shadow may reach beyond the box.
 */
function cutoutImageSvg(id: string, href: string, r: Box): string {
  return `<image id="${id}" xlink:href="${href}" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" preserveAspectRatio="none"/>`;
}

/**
 * A framed photo cropped to exactly `crop`, the part of the picture `coverCrop` keeps around its
 * focus point and zoom (see `croppedPhotoSvg`, which the treated photos draw with too). The
 * clip-path (the box with its corner radius) is on a group around it, so it applies in the canvas's
 * coordinates as it does for an unfocused photo.
 */
function focusedPhotoSvg(
  id: string,
  clipId: string,
  href: string,
  box: Box,
  pixels: { width: number; height: number },
  crop: CoverCropRect
): string {
  return `<g clip-path="url(#${clipId})">${croppedPhotoSvg(id, href, box, pixels, crop)}</g>`;
}

/** A logo-bearing layout must receive the current client's actual image bytes. */
function resolveLogoHref(options: RenderLayoutOptions): string {
  if (options.logoDataUri) {
    const bytes = dataUriBytes(options.logoDataUri);
    if (!bytes) throw new Error('CLIENT_LOGO_INVALID: logoDataUri must contain base64 image bytes');
    return imageDataUri(bytes, 'client logo');
  }
  if (options.logoPath) {
    if (!fs.existsSync(options.logoPath)) throw new Error('CLIENT_LOGO_UNAVAILABLE: the supplied client logo file is missing');
    return imageDataUri(fs.readFileSync(options.logoPath), `client logo ${options.logoPath}`);
  }
  throw new Error('CLIENT_LOGO_REQUIRED: a logo-bearing layout needs an explicit client logo');
}

/** Check identity-critical render input before a caller starts paid or external work. */
export function assertClientLogoForLayout(layout: StudioLayoutV2, options: RenderLayoutOptions = {}): void {
  if (layout.logo) resolveLogoHref(options);
}

/**
 * Logos scaled to the box they are drawn in, by logo bytes, box and rasteriser: a PNG data URI, or
 * null when scaling failed and the logo is drawn as it came.
 *
 * The KAAE logo is a 2687 px square PNG drawn in a box of about 120 px. rsvg decoded and scaled it
 * inside every render, twice per design (the design and its no-text composite), which cost about
 * 85 ms a render; the same logo in the same box gives the same pixels every time, so it is scaled
 * once. Scaled by the same rasteriser with the same "meet" fit, into a canvas the size of the box,
 * then drawn 1:1: for a box on whole pixels the result is the pixels the full-size logo gave.
 */
const prescaledLogos = new Map<string, string | null>();
const PRESCALED_LOGO_LIMIT = 32;
const logoStats = { scaled: 0, reused: 0 };

/** How many logos this process has scaled, and how many renders reused one. */
export function logoPrescaleStats(): { scaled: number; reused: number } {
  return { ...logoStats };
}

interface LogoPrescaleJob {
  key: string;
  svg: string;
  width: number;
  height: number;
  file: string;
  bytes: Buffer;
}

/** What scaling this logo into this box takes, or undefined when it is vector or no larger than the box. */
function logoPrescaleJob(href: string, box: Box, options?: RenderLayoutOptions): { key: string; job: () => LogoPrescaleJob | undefined } | undefined {
  const comma = href.indexOf(',');
  if (!href.startsWith('data:') || comma < 0) return undefined;
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  // Hashing the encoded payload identifies the logo without decoding it on a cache hit.
  const hash = createHash('sha256').update(href.slice(comma + 1)).digest('hex');
  const key = `${hash}|${box.width}x${box.height}|${resolveRsvgConvert(options)}`;
  return {
    key,
    job: () => {
      const bytes = dataUriBytes(href);
      const type = bytes ? sniffImageType(bytes) : undefined;
      if (!bytes || !type || type === 'image/svg+xml') return undefined;
      const size = imagePixelSize(bytes);
      if (!size || (size.width <= width && size.height <= height)) return undefined;
      const file = `logo.${imageFileExtension(type)}`;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${box.width} ${box.height}">` +
        `<image xlink:href="${file}" x="0" y="0" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid meet"/>` +
        `</svg>`;
      return { key, svg, width, height, file, bytes };
    },
  };
}

function rememberPrescaledLogo(key: string, href: string | null): void {
  prescaledLogos.set(key, href);
  while (prescaledLogos.size > PRESCALED_LOGO_LIMIT) {
    prescaledLogos.delete(prescaledLogos.keys().next().value as string);
  }
}

/** The logo scaled to its box, scaling it now (synchronously) the first time; undefined to draw it as it came. */
function prescaledLogoHref(href: string, box: Box, options?: RenderLayoutOptions): string | undefined {
  const plan = logoPrescaleJob(href, box, options);
  if (!plan) return undefined;
  if (prescaledLogos.has(plan.key)) {
    const cached = prescaledLogos.get(plan.key);
    if (cached) logoStats.reused++;
    return cached ?? undefined;
  }
  const job = plan.job();
  if (!job) {
    rememberPrescaledLogo(plan.key, null);
    return undefined;
  }
  let tempDir: string | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'hawa-logo-'));
    const svgFile = path.join(tempDir, 'logo.svg');
    fs.writeFileSync(svgFile, job.svg, { mode: 0o600 });
    fs.writeFileSync(path.join(tempDir, job.file), job.bytes, { mode: 0o600 });
    const res = spawnSync(resolveRsvgConvert(options), ['-w', String(job.width), '-h', String(job.height), '-f', 'png', svgFile], {
      env: rasteriserEnv(resolveFontconfigFile(options)),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20000,
    });
    const png = res.status === 0 && res.stdout && res.stdout.length >= 100 ? res.stdout : null;
    const out = png ? `data:image/png;base64,${png.toString('base64')}` : null;
    rememberPrescaledLogo(plan.key, out);
    if (out) logoStats.scaled++;
    return out ?? undefined;
  } catch {
    rememberPrescaledLogo(plan.key, null);
    return undefined;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Scales the layout's logo without blocking the event loop, so the render that follows finds it cached. */
async function warmPrescaledLogo(layout: StudioLayoutV2, options: RenderLayoutOptions): Promise<void> {
  if (!layout.logo) return;
  const href = resolveLogoHref(options);
  if (!href) return;
  const plan = logoPrescaleJob(href, layout.logo, options);
  if (!plan || prescaledLogos.has(plan.key)) return;
  const job = plan.job();
  if (!job) {
    rememberPrescaledLogo(plan.key, null);
    return;
  }
  try {
    const png = await svgToPngAsync(job.svg, job.width, job.height, options, { [job.file]: job.bytes });
    rememberPrescaledLogo(plan.key, `data:image/png;base64,${png.toString('base64')}`);
    logoStats.scaled++;
  } catch {
    rememberPrescaledLogo(plan.key, null);
  }
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
  /** The pictures the SVGs read by name; see RenderLayoutV2Result.files. */
  files: Record<string, Buffer>;
  wrappedLines: Record<number, number>;
  fontFidelity: Record<string, 'exact' | 'stand-in'>;
} {
  const fontsDir = resolveFontsDir(options);
  // Every picture is a file beside the SVG, never a data URI in it (ADR-035; svg-files.ts).
  const svgFiles = new SvgFiles();
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

    // Typed from the bytes (image-type.ts): the file name and the declared type are not evidence.
    let artHref = options.artImagePath;
    if (artHref && !artHref.startsWith('data:') && fs.existsSync(artHref)) {
      const bytes = fs.readFileSync(artHref);
      if (!sniffImageType(bytes)) imageDataUri(bytes, `art image ${artHref}`); // throws, naming the file
      artHref = svgFiles.add(bytes, 'art');
    } else if (artHref) {
      artHref = svgFiles.hrefFor(artHref, 'art');
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

  // Shapes Layer: every shape but the overlay ones (ADR-170), which are drawn over the photos below.
  // ADR-238: a cover's gradient ground first, then the brand elements (a sunburst, a triangle
  // pattern) over it, then the other shapes.
  const groundIndices = layout.shapes.map((_, i) => i).filter((i) => layout.shapes[i].layer !== 'overlay' && layout.shapes[i].primitive === 'cover_ground');
  if (groundIndices.length > 0) {
    const ground = renderShapesToSvg(groundIndices.map((i) => layout.shapes[i]), groundIndices);
    defsParts.push(...ground.defs);
    bodyPartsNoText.push(ground.svg);
  }
  (layout.ornaments ?? []).forEach((o, i) => bodyPartsNoText.push(ornamentSvg(o, `ornament-${i}`)));
  const underIndices = layout.shapes.map((_, i) => i).filter((i) => layout.shapes[i].layer !== 'overlay' && layout.shapes[i].primitive !== 'cover_ground');
  const overIndices = layout.shapes.map((_, i) => i).filter((i) => layout.shapes[i].layer === 'overlay');
  if (underIndices.length > 0) {
    const under = renderShapesToSvg(underIndices.map((i) => layout.shapes[i]), underIndices);
    defsParts.push(...under.defs);
    bodyPartsNoText.push(under.svg);
  }

  // Photos Layer: above the art, its scrim and the shapes, below the logo and text. Panels are
  // card backgrounds; drawn over a photo they hid it (2026-09-22, both portraits under a navy card). Drawn with the same
  // xMidYMid slice the art uses, so the transfer's `cover` sizing matches what the judge scored; a
  // photo with a focus point is drawn as the crop `coverCrop` gives, which the transfer crops to too.
  // A cut-out person keeps the id `photo-<index>` a framed photo has, so code that finds a photo by
  // id finds it; its shadow is `photo-shadow-<index>`, and its glow and outline, drawn under it,
  // `photo-glow-<index>` and `photo-outline-<index>`.
  //
  // A photo with a treatment (a mask, a fade, a filter, an outline or a glow) is drawn from its
  // fragment in photo-treatments.ts, which the transfer rasterises for the deck, so the two show the
  // same pixels. A photo without one is drawn here exactly as before. A cut-out's picture is a
  // definition its person, outline and glow share, written into the defs once.
  const fragmentDefs = new Set<string>();
  const drawFragment = (fragment: PhotoFragment) => {
    svgFiles.merge(fragment.files);
    if (fragment.defs && !fragmentDefs.has(fragment.defs)) {
      fragmentDefs.add(fragment.defs);
      defsParts.push(fragment.defs);
    }
    bodyPartsNoText.push(fragment.svg);
  };
  for (const layer of photoLayers(layout.photos ?? [], options.photoCutouts)) {
    const p = layer.photo;
    if (layer.kind === 'cutout-glow' || layer.kind === 'cutout-outline') {
      const effect = cutoutEffectFragment(layer.kind === 'cutout-glow' ? 'glow' : 'outline', p, layer.png, layer.rect, layout);
      if (effect) drawFragment(effect);
      continue;
    }
    if (layer.kind === 'cutout-person' && cutoutPhotoTreated(p)) {
      drawFragment(cutoutPersonFragment(p, layer.png, layer.rect));
      continue;
    }
    if (layer.kind !== 'framed') {
      const id = layer.kind === 'cutout-shadow' ? `photo-shadow-${p.photoIndex}` : `photo-${p.photoIndex}`;
      bodyPartsNoText.push(cutoutImageSvg(id, svgFiles.add(layer.png, layer.kind === 'cutout-shadow' ? 'shadow' : 'cutout'), layer.rect));
      continue;
    }
    // The photo's bytes, from photoFiles or else a (legacy) data URI; its pixel size is read from them.
    const given = options.photoFiles?.[p.photoIndex]?.bytes;
    const declaredHref = given ? undefined : options.photoDataUris?.[p.photoIndex];
    const bytes = given ?? (declaredHref ? dataUriBytes(declaredHref) : undefined);
    const href = bytes && bytes.length ? svgFiles.add(bytes, 'photo') : declaredHref ? relabelDataUri(declaredHref) : undefined;
    const photoPixels = () => (bytes && bytes.length ? imagePixelSize(bytes) : href ? dataUriPixelSize(href) : null);
    if (href && framedPhotoTreated(p)) {
      drawFragment(framedPhotoFragment(p, href, photoPixels()));
      continue;
    }
    const clipId = `photo-clip-${p.photoIndex}`;
    const rx = Math.max(0, Math.min(p.radius ?? 0, Math.min(p.width, p.height) / 2));
    bodyPartsNoText.push(
      `<clipPath id="${clipId}"><rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${rx}" ry="${rx}"/></clipPath>`
    );
    // A focus point or a zoom moves the crop to keep that part of the photo in view; a photo with
    // neither, or whose size cannot be read from its data (WebP), is the centred slice it always was.
    const cropped = Boolean(p.focus) || photoZoomFactor(p.zoom) > 1;
    const pixels = href && cropped ? photoPixels() : null;
    if (href && pixels && cropped) {
      bodyPartsNoText.push(focusedPhotoSvg(`photo-${p.photoIndex}`, clipId, href, p, pixels, coverCrop(p, pixels, p.focus, p.zoom)));
    } else if (href) {
      bodyPartsNoText.push(
        `<image id="photo-${p.photoIndex}" xlink:href="${href}" x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
      );
    } else {
      bodyPartsNoText.push(
        `<rect id="photo-slot-${p.photoIndex}" x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${rx}" ry="${rx}" fill="#888888" opacity="0.5"/>`
      );
    }
  }

  // ADR-170: the fades and scrims over the photos, then the plates, cards, tabs, pills and frames
  // that sit over them, all under the logo and the text.
  (layout.overlays ?? []).forEach((o, i) => {
    const drawn = overlaySvg(o, `overlay-${i}`);
    defsParts.push(drawn.defs);
    bodyPartsNoText.push(drawn.svg);
  });
  if (overIndices.length > 0) {
    const over = renderShapesToSvg(overIndices.map((i) => layout.shapes[i]), overIndices);
    defsParts.push(...over.defs);
    bodyPartsNoText.push(over.svg);
  }

  // Logo Layer
  if (layout.logo) {
    const logoHref = resolveLogoHref(options);
    const prescaled = logoHref ? prescaledLogoHref(logoHref, layout.logo, options) : undefined;
    if (prescaled) {
      // Already fitted into exactly this box ("meet" applied when it was scaled), so drawn 1:1.
      bodyPartsNoText.push(
        `<image id="logo" xlink:href="${svgFiles.hrefFor(prescaled, 'logo')}" x="${layout.logo.x}" y="${layout.logo.y}" width="${layout.logo.width}" height="${layout.logo.height}" preserveAspectRatio="none"/>`
      );
    } else if (logoHref) {
      bodyPartsNoText.push(
        `<image id="logo" xlink:href="${svgFiles.hrefFor(logoHref, 'logo')}" x="${layout.logo.x}" y="${layout.logo.y}" width="${layout.logo.width}" height="${layout.logo.height}" preserveAspectRatio="xMidYMid meet"/>`
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
    files: svgFiles.files,
    wrappedLines,
    fontFidelity,
  };
}

/** A name the SVG reads a sibling file by: one plain file name, so nothing is written outside the folder. */
function safeSiblingName(name: string): string {
  if (!/^[a-z0-9-]+\.[a-z]+$/i.test(name)) throw new Error(`svgToPng: unsafe file name ${name}`);
  return name;
}

/**
 * Converts SVG string to PNG Buffer via rsvg-convert at 1x canvas pixels.
 */
function svgToPng(
  svgString: string,
  width: number,
  height: number,
  options?: RenderLayoutOptions,
  /** Files written beside the SVG, which it reads by name (see svgToPngAsync). */
  files?: Record<string, Buffer>
): Buffer {
  checkInlineDataUris(svgString, 'svgToPng');
  const fontconfigFile = resolveFontconfigFile(options);
  const rsvgBinary = resolveRsvgConvert(options);

  const tempDir = fs.mkdtempSync(path.join(tmpdir(), 'hawa-studio-render-'));
  const svgFile = path.join(tempDir, 'render.svg');

  try {
    fs.writeFileSync(svgFile, svgString, { mode: 0o600 });
    for (const [name, bytes] of Object.entries(files || {})) {
      fs.writeFileSync(path.join(tempDir, safeSiblingName(name)), bytes, { mode: 0o600 });
    }
    const result = spawnSync(
      rsvgBinary,
      ['-w', String(width), '-h', String(height), '-f', 'png', svgFile],
      {
        env: rasteriserEnv(fontconfigFile),
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
  const { svg, noTextSvg, files, wrappedLines, fontFidelity } = renderLayoutV2ToSvg(layout, options);

  const png = svgToPng(svg, layout.width, layout.height, options, files);
  const noTextPng = svgToPng(noTextSvg, layout.width, layout.height, options, files);

  return {
    svg,
    png,
    noTextSvg,
    noTextPng,
    files,
    wrappedLines,
    fontFidelity,
    placements: placementsFor(layout, options),
  };
}

/**
 * svgToPng without stopping the process. spawnSync holds the event loop for the whole rasterisation,
 * about half a second to several seconds a design: while Core rendered, /health, the Desk, Telegram
 * intake and every other studio run waited. The work is identical; only the waiting differs.
 *
 * Exported for the Canva transfer, which rasterises a treated photo's fragment with it: the deck's
 * baked photo then comes from the same rasteriser as the preview the judge scored.
 */
export async function svgToPngAsync(
  svgString: string,
  width: number,
  height: number,
  options?: RenderLayoutOptions,
  /** Files written beside the SVG, which it can reference by name (rsvg reads files in its own folder). */
  files?: Record<string, Buffer>
): Promise<Buffer> {
  checkInlineDataUris(svgString, 'svgToPngAsync');
  const fontconfigFile = resolveFontconfigFile(options);
  const rsvgBinary = resolveRsvgConvert(options);
  const tempDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'hawa-studio-render-'));
  const svgFile = path.join(tempDir, 'render.svg');
  try {
    await fs.promises.writeFile(svgFile, svgString, { mode: 0o600 });
    for (const [name, bytes] of Object.entries(files || {})) {
      await fs.promises.writeFile(path.join(tempDir, safeSiblingName(name)), bytes, { mode: 0o600 });
    }
    return await new Promise<Buffer>((resolve, reject) => {
      execFile(
        rsvgBinary,
        ['-w', String(width), '-h', String(height), '-f', 'png', svgFile],
        { env: rasteriserEnv(fontconfigFile), maxBuffer: 64 * 1024 * 1024, timeout: 20000, encoding: 'buffer' },
        (error, stdout, stderr) => {
          if (error || !stdout || stdout.length < 100) {
            const detail = stderr && stderr.length ? stderr.toString('utf-8') : error?.message || 'Unknown error';
            reject(new Error(`rsvg-convert rendering failed (status ${(error as any)?.code ?? 0}): ${detail}`));
            return;
          }
          resolve(stdout);
        }
      );
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * renderLayoutV2 for a server: the same bytes, without blocking the event loop, and with the two
 * rasterisations (the design and its no-text composite) running side by side.
 */
export async function renderLayoutV2Async(layout: StudioLayoutV2, options: RenderLayoutOptions = {}): Promise<RenderLayoutV2Result> {
  await warmPrescaledLogo(layout, options);
  const { svg, noTextSvg, files, wrappedLines, fontFidelity } = renderLayoutV2ToSvg(layout, options);
  const [png, noTextPng] = await Promise.all([
    svgToPngAsync(svg, layout.width, layout.height, options, files),
    svgToPngAsync(noTextSvg, layout.width, layout.height, options, files),
  ]);
  return { svg, png, noTextSvg, noTextPng, files, wrappedLines, fontFidelity, placements: placementsFor(layout, options) };
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
  // 4. Client photos, so the critique can name them
  (layout.photos ?? []).forEach((p) => {
    annotations.push({
      boxId: `B${annotations.length}`,
      role: `photo (${p.role})`,
      box: { x: p.x, y: p.y, width: p.width, height: p.height },
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
  const { svg, files } = renderLayoutV2ToSvg(layout, options);
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
  const png = svgToPng(annotatedSvg, layout.width, layout.height, options, files);

  return {
    svg: annotatedSvg,
    png,
    annotations,
  };
}


export interface RenderFontInputs {
  /** 2 since ADR-123 added the renderer; version 1 named fonts and the measurement helper only. */
  version: 2;
  sha256: string;
  registrySha256: string;
  measurement?: MeasurementRuntimeIdentity | { unavailable: true };
  /** The rasteriser and operating system that draw (ADR-123); unavailable is recorded, not guessed. */
  renderer: RendererRuntimeIdentity | { unavailable: true };
  files: FontFileIdentity[];
}
let lastFontBasis: string | undefined;

/**
 * Recovery evidence for the fonts, the measurement helper and the rasteriser/OS release that draw
 * them (ADR-116/118/123). Version strings and executable hashes, not every shared-library byte, and
 * not native Canva fidelity.
 */
export function captureRenderFontInputs(options: {
  fontsDir?: string; registryPath?: string; systemFiles?: string[]; rsvgConvertPath?: string; osIdentityFiles?: string[];
} = {}): RenderFontInputs {
  const registrySha256 = createHash('sha256').update(fs.readFileSync(resolveRenderFontsPath(options.registryPath))).digest('hex');
  const files = fontFileInventory(options.fontsDir ?? resolveFontsDir(), options.systemFiles ?? pinnedSystemFontFiles());
  let measurement: RenderFontInputs['measurement'];
  try { measurement = measurementRuntimeIdentity(); } catch { measurement = { unavailable: true }; }
  let renderer: RenderFontInputs['renderer'];
  try { renderer = rendererRuntimeIdentity({ rsvgConvertPath: options.rsvgConvertPath, osIdentityFiles: options.osIdentityFiles }); }
  catch { renderer = { unavailable: true }; }
  const basis = { version: 2 as const, registrySha256, files, measurement, renderer };
  const sha256 = createHash('sha256').update(JSON.stringify(basis)).digest('hex');
  if (lastFontBasis !== undefined && lastFontBasis !== sha256) {
    fontCache.clear(); inkCheckCache.clear(); sentinelHashCache.clear();
    admittedFaceCache.clear(); substitutionWarned.clear();
  }
  lastFontBasis = sha256;
  return { ...basis, sha256 };
}
