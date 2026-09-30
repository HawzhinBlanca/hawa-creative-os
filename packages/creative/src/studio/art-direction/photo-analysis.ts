import { PNG } from 'pngjs';
import { imageFileExtension, sniffImageType } from '../image-type.js';
import { imagePixelSize } from '../photo-crop.js';
import { svgToPngAsync } from '../render-layout-v2.js';
import type { QuietArea } from './recipes.js';

/**
 * ADR-170: what a photo's own pixels say about it, measured locally with no model call: how sharp
 * it is, where it is calm enough for a title, where its detail is, and its resolution. The brief
 * call reads the photos too (subject fit, the shot, a quiet area); these numbers check that reading
 * and rank the hero where the brief leaves a tie (rulebook item 10).
 *
 * The photo is drawn small by the renderer's own rsvg-convert and decoded with pngjs, both already
 * in the repository: no image library is added. Deterministic for the same bytes and rasteriser.
 */

/** The long side the analysis reads a photo at: enough for edges, cheap to walk. */
export const ANALYSIS_EDGE = 256;

export interface PhotoAnalysis {
  width: number;
  height: number;
  megapixels: number;
  /** 0..1 from the variance of the Laplacian (log scale): under ~0.45 reads soft. */
  sharpness: number;
  /** The calmest third of the photo, if one is clearly calmer than the photo as a whole. */
  quiet: QuietArea;
  /** Mean luminance (0..1) of that third, or of the photo when none is calm. */
  quietLuminance: number;
  /** The centre of the photo's detail, as shares of its width and height. */
  salient: { x: number; y: number };
  /** Edge energy of each third relative to the whole photo (1 = average). */
  bands: Record<Exclude<QuietArea, 'none'>, number>;
}

/** Luminance 0..1 of each pixel of a decoded PNG, row by row. */
function greyOf(png: PNG): Float64Array {
  const out = new Float64Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    const r = png.data[i * 4] / 255, g = png.data[i * 4 + 1] / 255, b = png.data[i * 4 + 2] / 255;
    out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return out;
}

/** The analysis of an already-decoded small picture, with the source's own pixel size. */
export function analysePixels(png: PNG, source: { width: number; height: number }): PhotoAnalysis {
  const w = png.width;
  const h = png.height;
  const grey = greyOf(png);
  const at = (x: number, y: number) => grey[y * w + x];
  let lapSum = 0, lapSq = 0, count = 0;
  const grad = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = at(x, y);
      const lap = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4 * c;
      lapSum += lap; lapSq += lap * lap; count++;
      const gx = at(x + 1, y) - at(x - 1, y);
      const gy = at(x, y + 1) - at(x, y - 1);
      grad[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  const mean = count ? lapSum / count : 0;
  // In 8-bit units, as the Laplacian variance is usually quoted.
  const variance = count ? (lapSq / count - mean * mean) * 255 * 255 : 0;
  const sharpness = Math.max(0, Math.min(1, Math.log10(1 + variance) / 3.3));

  const bandEnergy = (x0: number, y0: number, x1: number, y1: number) => {
    let e = 0, l = 0, n = 0;
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) { e += grad[y * w + x]; l += at(x, y); n++; }
    }
    return { energy: n ? e / n : 0, luminance: n ? l / n : 0 };
  };
  const whole = bandEnergy(0, 0, w, h);
  const thirdW = Math.round(w / 3), thirdH = Math.round(h / 3);
  const raw = {
    top: bandEnergy(0, 0, w, thirdH),
    bottom: bandEnergy(0, h - thirdH, w, h),
    left: bandEnergy(0, 0, thirdW, h),
    right: bandEnergy(w - thirdW, 0, w, h),
  };
  const rel = (e: number) => (whole.energy > 0 ? Math.round((e / whole.energy) * 1000) / 1000 : 1);
  const bands = { top: rel(raw.top.energy), bottom: rel(raw.bottom.energy), left: rel(raw.left.energy), right: rel(raw.right.energy) };
  const calmest = (Object.keys(bands) as Array<keyof typeof bands>).sort((a, b) => bands[a] - bands[b])[0];
  const quiet: QuietArea = bands[calmest] <= 0.7 ? calmest : 'none';

  let sx = 0, sy = 0, sw = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const g = grad[y * w + x];
      const weight = g * g;
      sx += weight * x; sy += weight * y; sw += weight;
    }
  }
  const salient = sw > 0 ? { x: round3(sx / sw / w), y: round3(sy / sw / h) } : { x: 0.5, y: 0.5 };

  return {
    width: source.width,
    height: source.height,
    megapixels: Math.round(((source.width * source.height) / 1e6) * 100) / 100,
    sharpness: round3(sharpness),
    quiet,
    quietLuminance: round3(quiet === 'none' ? whole.luminance : raw[quiet].luminance),
    salient,
    bands,
  };
}

/** Draws the photo at ANALYSIS_EDGE on its long side and analyses it. */
export async function analysePhotoAsync(bytes: Buffer, options: { rsvgConvertPath?: string } = {}): Promise<PhotoAnalysis> {
  const type = sniffImageType(bytes);
  const size = imagePixelSize(bytes);
  if (!type || !size) throw new Error('PHOTO_ANALYSIS_UNREADABLE: the photo type or size could not be read');
  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(size.width, size.height));
  const width = Math.max(8, Math.round(size.width * scale));
  const height = Math.max(8, Math.round(size.height * scale));
  const file = `photo.${imageFileExtension(type)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}"><image xlink:href="${file}" width="${width}" height="${height}" preserveAspectRatio="none"/></svg>`;
  const png = await svgToPngAsync(svg, width, height, options.rsvgConvertPath ? { rsvgConvertPath: options.rsvgConvertPath } : undefined, { [file]: bytes });
  return analysePixels(PNG.sync.read(png), size);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
