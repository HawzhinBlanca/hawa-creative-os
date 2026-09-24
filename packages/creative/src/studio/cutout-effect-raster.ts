import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import type { Box, Hex } from './layout-v2.js';
import { hexToRgb } from './color-science.js';

/**
 * The outline and the glow around a cut-out person, drawn in our code as a picture (ADR-036 section
 * 2.2). They used to be SVG filters: the outline an feMorphology dilation, which librsvg ran in 23 s
 * for a 24 px outline baked at 2x (the Canva deck timed out at 20 s), capped at 10 device pixels a
 * step, and which resvg draws wrongly. Drawn here, the preview and the deck embed the same PNG, and
 * no renderer's filter code is involved.
 *
 *   outline  every pixel within `width` of the person's silhouette, by an exact Euclidean distance
 *            transform (Felzenszwalb and Huttenlocher, linear time) of the person's alpha, with the
 *            silhouette's edge placed to a fraction of a pixel from the alpha itself, so the band's
 *            outer edge is anti-aliased;
 *   glow     the silhouette (grown by the outline's width when there is one, so the glow lights the
 *            outline's outer edge) blurred as SVG's feGaussianBlur blurs: three box blurs a row and a
 *            column, of the sizes the SVG specification gives for the standard deviation.
 *
 * Either one leaves out the person's opaque core and follows the person's fade, as the filters did.
 * Every step is plain arithmetic on typed arrays in a fixed order, so the same inputs give the same
 * bytes.
 */

/**
 * The person's opaque core, which an outline or a glow leaves out, is where their alpha is above
 * 98%: alpha * CORE_SLOPE + CORE_INTERCEPT, held to 0..1. Under the soft edge of the matte (hair)
 * the effect is whole, so person and outline meet with no gap; under the opaque person it is absent,
 * so a faded person fades into the background, not into the outline's colour.
 */
const CORE_SLOPE = 50;
const CORE_INTERCEPT = 1 - CORE_SLOPE;

/** A pixel is inside the silhouette when the person covers at least half of it. */
const INSIDE_ALPHA = 0.5;

/** The pixel grid an effect is drawn on: its top-left in layout pixels, its size in device pixels. */
export interface EffectGrid {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Device pixels per layout pixel, a whole number. */
  scale: number;
}

/** A linear fade, as the SVG gradient draws it: opaque at (x1, y1), clear at (x2, y2), padded beyond. */
export interface FadeRamp {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CutoutEffectRasterInput {
  /** The person's RGBA PNG, as the renderer draws it at `personRect`. */
  png: Buffer;
  personRect: Box;
  /** The grid the effect is computed on; the person beyond it is not seen. */
  grid: EffectGrid;
  /** The part of the grid the PNG shows, in layout pixels: whole pixels inside the grid. */
  crop: Box;
  color: Hex;
  /** The outline's width in layout pixels: the band itself, or what the glow is grown by first. */
  outlineWidth: number;
  /** The glow's Gaussian standard deviation in layout pixels; absent for an outline. */
  glowSigma?: number;
  fade?: FadeRamp;
}

/** The person's alpha as 0..1, row by row. */
function decodeAlpha(png: Buffer): { alpha: Float32Array; width: number; height: number } {
  const image = PNG.sync.read(png);
  const alpha = new Float32Array(image.width * image.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = image.data[i * 4 + 3] / 255;
  return { alpha, width: image.width, height: image.height };
}

/** For each output pixel, the source pixels it reads and their weights. */
interface Taps {
  start: Int32Array;
  count: Int32Array;
  index: Int32Array;
  weight: Float64Array;
}

/**
 * Resampling weights along one axis, from the person's `srcCount` pixels drawn over
 * [rectStart, rectStart + rectLength) to `dstCount` grid pixels starting at `origin`.
 *
 * A tent filter as wide as a source pixel when enlarging (bilinear, as the renderer draws an
 * enlarged picture) and as wide as a device pixel when reducing, so every source pixel counts. The
 * picture is transparent past its edges, so weights that fall outside it still count toward the
 * total and a pixel half over the picture's edge is half covered.
 */
function resampleTaps(dstCount: number, origin: number, scale: number, rectStart: number, rectLength: number, srcCount: number): Taps {
  const sourcePerDevice = srcCount / (rectLength * scale);
  const support = Math.max(1, sourcePerDevice);
  const start = new Int32Array(dstCount);
  const count = new Int32Array(dstCount);
  const index: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i < dstCount; i++) {
    const centre = origin + (i + 0.5) / scale;
    const u = ((centre - rectStart) * srcCount) / rectLength;
    const first = Math.ceil(u - 0.5 - support);
    const last = Math.floor(u - 0.5 + support);
    let total = 0;
    start[i] = index.length;
    for (let k = first; k <= last; k++) {
      const w = 1 - Math.abs(k + 0.5 - u) / support;
      if (w <= 0) continue;
      total += w;
      if (k >= 0 && k < srcCount) {
        index.push(k);
        weight.push(w);
      }
    }
    count[i] = index.length - start[i];
    for (let t = start[i]; t < index.length; t++) weight[t] /= total;
  }
  return { start, count, index: Int32Array.from(index), weight: Float64Array.from(weight) };
}

/** The person's alpha on the grid: coverage 0..1 of each device pixel, as the renderer would draw it. */
export function personAlphaOnGrid(png: Buffer, personRect: Box, grid: EffectGrid): Float32Array {
  const source = decodeAlpha(png);
  const cols = resampleTaps(grid.width, grid.x, grid.scale, personRect.x, personRect.width, source.width);
  const rows = resampleTaps(grid.height, grid.y, grid.scale, personRect.y, personRect.height, source.height);
  // Only the source rows some grid row reads are resampled across.
  const neededRow = new Uint8Array(source.height);
  for (let t = 0; t < rows.index.length; t++) neededRow[rows.index[t]] = 1;
  const across = new Float32Array(source.height * grid.width);
  for (let sy = 0; sy < source.height; sy++) {
    if (!neededRow[sy]) continue;
    const src = sy * source.width;
    const dst = sy * grid.width;
    for (let x = 0; x < grid.width; x++) {
      let sum = 0;
      const end = cols.start[x] + cols.count[x];
      for (let t = cols.start[x]; t < end; t++) sum += cols.weight[t] * source.alpha[src + cols.index[t]];
      across[dst + x] = sum;
    }
  }
  const out = new Float32Array(grid.width * grid.height);
  for (let y = 0; y < grid.height; y++) {
    const dst = y * grid.width;
    const end = rows.start[y] + rows.count[y];
    for (let t = rows.start[y]; t < end; t++) {
      const w = rows.weight[t];
      const src = rows.index[t] * grid.width;
      for (let x = 0; x < grid.width; x++) out[dst + x] += w * across[src + x];
    }
  }
  return out;
}

/**
 * The exact Euclidean feature transform of a binary image: for every pixel, the index (y * width +
 * x) of a nearest pixel that is set, or -1 when none is. Felzenszwalb and Huttenlocher's separable
 * algorithm ("Distance Transforms of Sampled Functions", 2012): the nearest set pixel in each column
 * by two scans, then along each row the lower envelope of the parabolas (x - q)^2 + column
 * distance^2. Linear in the number of pixels; the squared distances are whole numbers, exact in
 * doubles, so the result does not depend on the platform.
 */
export function euclideanFeatureTransform(inside: Uint8Array, width: number, height: number): Int32Array {
  const nearest = new Int32Array(width * height);
  // Columns: the row of the nearest set pixel above or below, or -1.
  for (let x = 0; x < width; x++) {
    let last = -1;
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      if (inside[i]) last = y;
      nearest[i] = last;
    }
    last = -1;
    for (let y = height - 1; y >= 0; y--) {
      const i = y * width + x;
      if (inside[i]) last = y;
      const above = nearest[i];
      if (last >= 0 && (above < 0 || last - y < y - above)) nearest[i] = last;
    }
  }
  // Rows: the lower envelope of the parabolas rooted at the columns that have a set pixel.
  const f = new Float64Array(width);
  const v = new Int32Array(width);
  const z = new Float64Array(width + 1);
  const row = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let k = -1;
    for (let q = 0; q < width; q++) {
      const ny = nearest[base + q];
      if (ny < 0) continue;
      f[q] = (y - ny) * (y - ny);
      if (k < 0) {
        k = 0;
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        continue;
      }
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    if (k < 0) {
      row.fill(-1);
    } else {
      let j = 0;
      for (let q = 0; q < width; q++) {
        while (z[j + 1] < q) j++;
        row[q] = nearest[base + v[j]] * width + v[j];
      }
    }
    nearest.set(row, base);
  }
  return nearest;
}

/**
 * Coverage 0..1 of each grid pixel by the silhouette grown by `width` device pixels: 1 inside the
 * silhouette, and outside it `width + 0.5 - d` held to 0..1, where d is the distance from the pixel's
 * centre to the silhouette's edge. That is the band's outer edge anti-aliased across one pixel.
 *
 * The edge is placed to a fraction of a pixel: along the step from the nearest inside pixel q toward
 * this one, the alpha falls through one half between q and its neighbour, and linear interpolation
 * of the two alphas says where. For an edge the renderer enlarged (a bilinear ramp) that is exact;
 * for a hard edge it is within a tenth of a pixel.
 */
export function grownSilhouette(alpha: Float32Array, gridWidth: number, gridHeight: number, width: number): Float32Array {
  const count = gridWidth * gridHeight;
  const inside = new Uint8Array(count);
  for (let i = 0; i < count; i++) inside[i] = alpha[i] >= INSIDE_ALPHA ? 1 : 0;
  const feature = euclideanFeatureTransform(inside, gridWidth, gridHeight);
  const out = new Float32Array(count);
  // No edge estimate moves the edge more than a diagonal step, so past this nothing is covered.
  const reach = width + 0.5 + Math.SQRT2;
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const i = y * gridWidth + x;
      if (inside[i]) {
        out[i] = 1;
        continue;
      }
      const q = feature[i];
      if (q < 0) continue;
      const qx = q % gridWidth;
      const qy = (q - qx) / gridWidth;
      const dx = x - qx;
      const dy = y - qy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist - reach >= 0) continue;
      const sx = Math.round(dx / dist);
      const sy = Math.round(dy / dist);
      const nx = qx + sx;
      const ny = qy + sy;
      const aq = alpha[q];
      const an = nx >= 0 && nx < gridWidth && ny >= 0 && ny < gridHeight ? alpha[ny * gridWidth + nx] : 0;
      const fraction = an < INSIDE_ALPHA && aq > an ? (aq - INSIDE_ALPHA) / (aq - an) : 0.5;
      const edge = dist - (fraction * (sx * dx + sy * dy)) / dist;
      const c = width + 0.5 - edge;
      out[i] = c >= 1 ? 1 : c > 0 ? c : 0;
    }
  }
  return out;
}

/**
 * The box sizes SVG's feGaussianBlur uses for a standard deviation of `sigma` device pixels (Filter
 * Effects Module, feGaussianBlur): d = floor(sigma * 3 * sqrt(2 * pi) / 4 + 0.5); three boxes of d
 * centred when d is odd; when it is even, two of d offset half a pixel either way and one of d + 1.
 * Each box as [reach before the pixel, reach after it].
 */
export function gaussianBoxes(sigma: number): Array<[number, number]> {
  const d = Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5);
  if (d < 1) return [];
  if (d % 2 === 1) {
    const r = (d - 1) / 2;
    return [[r, r], [r, r], [r, r]];
  }
  const h = d / 2;
  return [[h, h - 1], [h - 1, h], [h, h]];
}

/** One box blur along rows (step 1) or columns (step width), transparent past the grid. */
function boxPass(src: Float32Array, dst: Float32Array, lines: number, length: number, lineStep: number, step: number, before: number, after: number): void {
  const size = before + after + 1;
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    let sum = 0;
    // The window for position 0 is [-before, after]; positions below 0 are transparent.
    for (let k = 0; k <= Math.min(after, length - 1); k++) sum += src[base + k * step];
    for (let p = 0; p < length; p++) {
      dst[base + p * step] = sum / size;
      const enter = p + after + 1;
      const leave = p - before;
      if (enter < length) sum += src[base + enter * step];
      if (leave >= 0) sum -= src[base + leave * step];
    }
  }
}

/** A Gaussian blur of `sigma` device pixels, as feGaussianBlur's three boxes a row and a column. */
export function gaussianBlur(values: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const boxes = gaussianBoxes(sigma);
  let a = Float32Array.from(values);
  let b = new Float32Array(values.length);
  for (const [before, after] of boxes) {
    boxPass(a, b, height, width, width, 1, before, after);
    [a, b] = [b, a];
  }
  for (const [before, after] of boxes) {
    boxPass(a, b, width, height, 1, width, before, after);
    [a, b] = [b, a];
  }
  return a;
}

/**
 * The effect as an RGBA PNG covering `crop` at the grid's scale: the colour everywhere it shows, its
 * alpha the outline's or the glow's coverage, less the person's opaque core, times the fade.
 */
export function cutoutEffectRaster(input: CutoutEffectRasterInput): Buffer {
  const { grid, crop } = input;
  const scale = grid.scale;
  const alpha = personAlphaOnGrid(input.png, input.personRect, grid);
  const outlinePx = input.outlineWidth * scale;
  let coverage = input.glowSigma === undefined || outlinePx > 0 ? grownSilhouette(alpha, grid.width, grid.height, outlinePx) : alpha;
  if (input.glowSigma !== undefined) coverage = gaussianBlur(coverage, grid.width, grid.height, input.glowSigma * scale);

  const left = Math.round((crop.x - grid.x) * scale);
  const top = Math.round((crop.y - grid.y) * scale);
  const width = Math.round(crop.width * scale);
  const height = Math.round(crop.height * scale);
  const png = new PNG({ width, height });
  const [r, g, b] = hexToRgb(input.color);
  const fade = input.fade;
  const fadeDx = fade ? fade.x2 - fade.x1 : 0;
  const fadeDy = fade ? fade.y2 - fade.y1 : 0;
  const fadeLength2 = fadeDx * fadeDx + fadeDy * fadeDy;
  for (let y = 0; y < height; y++) {
    const gy = top + y;
    const layoutY = grid.y + (gy + 0.5) / scale;
    for (let x = 0; x < width; x++) {
      const gx = left + x;
      const i = gy * grid.width + gx;
      const core = Math.min(1, Math.max(0, alpha[i] * CORE_SLOPE + CORE_INTERCEPT));
      let a = coverage[i] * (1 - core);
      if (fade && a > 0) {
        const layoutX = grid.x + (gx + 0.5) / scale;
        const t = fadeLength2 > 0 ? ((layoutX - fade.x1) * fadeDx + (layoutY - fade.y1) * fadeDy) / fadeLength2 : 0;
        a *= 1 - Math.min(1, Math.max(0, t));
      }
      const byte = Math.round(a * 255);
      if (byte <= 0) continue;
      const o = (y * width + x) * 4;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = byte;
    }
  }
  return PNG.sync.write(png);
}

/**
 * The preview and the deck draw the same effect from the same inputs, usually moments apart; the
 * last few are kept so the second is not computed again. The key is a hash of every input, so a
 * hit is the same bytes a computation would give.
 */
const RASTER_CACHE_LIMIT = 4;
const rasterCache = new Map<string, Buffer>();

export function cutoutEffectRasterCached(input: CutoutEffectRasterInput): Buffer {
  const { png, ...rest } = input;
  const key = createHash('sha256').update(png).update(JSON.stringify(rest)).digest('hex');
  const hit = rasterCache.get(key);
  if (hit) {
    rasterCache.delete(key);
    rasterCache.set(key, hit);
    return hit;
  }
  const out = cutoutEffectRaster(input);
  rasterCache.set(key, out);
  while (rasterCache.size > RASTER_CACHE_LIMIT) rasterCache.delete(rasterCache.keys().next().value as string);
  return out;
}
