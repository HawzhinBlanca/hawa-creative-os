/**
 * The image measurements of the resvg gate, on decoded RGBA pixels. No dependency beyond pngjs,
 * which the creative package already carries (and re-exports from its renderer).
 *
 *   ssim         mean structural similarity (Wang et al. 2004) of two images' luma, over a 7x7 uniform
 *                window (scikit-image's default), K1 = 0.01, K2 = 0.03, L = 255. Each image is laid
 *                on black and on white, and the lower of the two scores is kept, so a difference in
 *                transparency counts as much as one in colour.
 *   inkBox       the bounding box of pixels at least half opaque: a drawn text line's ink.
 *   columnProfile  the ink in each column, for telling a reordered line from a re-rasterised one.
 */
import { PNG } from '../../../../packages/creative/src/studio/render-layout-v2.js';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export function readPng(bytes: Buffer): Rgba {
  const p = PNG.sync.read(bytes);
  return { width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) };
}

export function writePng(img: Rgba): Buffer {
  const p = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(p.data);
  return PNG.sync.write(p);
}

/** Rec. 601 luma of the image laid on a flat ground of grey level `ground`. */
export function lumaOn(img: Rgba, ground: number): Float64Array {
  const out = new Float64Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, o = 0; i < out.length; i++, o += 4) {
    const a = d[o + 3] / 255;
    const y = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    out[i] = y * a + ground * (1 - a);
  }
  return out;
}

/** Summed-area table with a zero row and column in front, for O(1) window sums. */
function integral(values: Float64Array, width: number, height: number, f: (v: number, i: number) => number): Float64Array {
  const w1 = width + 1;
  const s = new Float64Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      row += f(values[i], i);
      s[(y + 1) * w1 + x + 1] = s[y * w1 + x + 1] + row;
    }
  }
  return s;
}

/** Mean SSIM of two single-channel images of the same size, 7x7 uniform window, valid windows only. */
export function ssimChannel(a: Float64Array, b: Float64Array, width: number, height: number, win = 7): number {
  if (width < win || height < win) win = Math.max(1, Math.min(width, height));
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const sa = integral(a, width, height, (v) => v);
  const sb = integral(b, width, height, (v) => v);
  const saa = integral(a, width, height, (v) => v * v);
  const sbb = integral(b, width, height, (v) => v * v);
  const sab = integral(a, width, height, (v, i) => v * b[i]);
  const w1 = width + 1;
  const n = win * win;
  // Sample covariance (n - 1), as scikit-image does by default.
  const cov = n / (n - 1);
  const box = (s: Float64Array, x: number, y: number) => s[(y + win) * w1 + x + win] - s[y * w1 + x + win] - s[(y + win) * w1 + x] + s[y * w1 + x];
  let total = 0;
  let count = 0;
  for (let y = 0; y + win <= height; y++) {
    for (let x = 0; x + win <= width; x++) {
      const ma = box(sa, x, y) / n;
      const mb = box(sb, x, y) / n;
      const va = (box(saa, x, y) / n - ma * ma) * cov;
      const vb = (box(sbb, x, y) / n - mb * mb) * cov;
      const vab = (box(sab, x, y) / n - ma * mb) * cov;
      total += ((2 * ma * mb + C1) * (2 * vab + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

/** SSIM of two RGBA images: luma on black and on white, the lower kept. */
export function ssim(a: Rgba, b: Rgba): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const onBlack = ssimChannel(lumaOn(a, 0), lumaOn(b, 0), a.width, a.height);
  const onWhite = ssimChannel(lumaOn(a, 255), lumaOn(b, 255), a.width, a.height);
  return Math.min(onBlack, onWhite);
}

export interface InkBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  pixels: number;
}

/** Bounding box of pixels with alpha >= threshold (inclusive edges), or null when there are none. */
export function inkBox(img: Rgba, threshold = 128): InkBox | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let pixels = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] >= threshold) {
        pixels++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return pixels ? { left, top, right, bottom, pixels } : null;
}

/** Summed alpha per column, in units of fully opaque pixels. */
export function columnProfile(img: Rgba): Float64Array {
  const p = new Float64Array(img.width);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) p[x] += img.data[(y * img.width + x) * 4 + 3] / 255;
  return p;
}

/**
 * The best Pearson correlation of two column profiles over shifts of up to `maxShift` columns, after
 * lining up their first inked columns. A line drawn by another rasteriser correlates near 1; the same
 * line with its words reordered does not, because the gaps between words move.
 */
export function profileCorrelation(a: Float64Array, b: Float64Array, aLeft: number, bLeft: number, maxShift = 6): { corr: number; shift: number } {
  let best = { corr: -1, shift: 0 };
  const base = bLeft - aLeft;
  for (let s = base - maxShift; s <= base + maxShift; s++) {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let x = 0; x < a.length; x++) {
      const xb = x + s;
      const va = a[x];
      const vb = xb >= 0 && xb < b.length ? b[xb] : 0;
      n++;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
    const cov = sab / n - (sa / n) * (sb / n);
    const den = Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
    const corr = den > 0 ? cov / den : 0;
    if (corr > best.corr) best = { corr, shift: s - base };
  }
  return best;
}

/** Share of pixels that differ from the top-left pixel by more than 8 in any channel: how much is drawn. */
export function contentShare(img: Rgba): number {
  const d = img.data;
  let n = 0;
  for (let o = 0; o < d.length; o += 4) {
    if (Math.abs(d[o] - d[0]) > 8 || Math.abs(d[o + 1] - d[1]) > 8 || Math.abs(d[o + 2] - d[2]) > 8 || Math.abs(d[o + 3] - d[3]) > 8) n++;
  }
  return n / (img.width * img.height);
}

/** Area-average downscale by an integer-free factor (box filter over the covered source pixels). */
export function downscale(img: Rgba, width: number, height: number): Rgba {
  const out = new Uint8Array(width * height * 4);
  const fx = img.width / width;
  const fy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < img.height; sy++) {
        for (let sx = x0; sx < x1 && sx < img.width; sx++) {
          const o = (sy * img.width + sx) * 4;
          const al = img.data[o + 3];
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = n ? Math.round(a / n) : 0;
    }
  }
  return { width, height, data: out };
}

/** The image laid on a checkerboard, so transparency shows in a contact sheet. */
export function onChecker(img: Rgba): Rgba {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const g = ((x >> 3) + (y >> 3)) % 2 ? 200 : 235;
      const a = img.data[o + 3] / 255;
      out[o] = Math.round(img.data[o] * a + g * (1 - a));
      out[o + 1] = Math.round(img.data[o + 1] * a + g * (1 - a));
      out[o + 2] = Math.round(img.data[o + 2] * a + g * (1 - a));
      out[o + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** |luma difference| x 4 in red on black: where the two renders disagree. */
export function diffMap(a: Rgba, b: Rgba): Rgba {
  const la = lumaOn(a, 128);
  const lb = lumaOn(b, 128);
  const out = new Uint8Array(a.width * a.height * 4);
  for (let i = 0; i < la.length; i++) {
    const d = Math.min(255, Math.abs(la[i] - lb[i]) * 4);
    out[i * 4] = d;
    out[i * 4 + 1] = d > 0 ? 32 : 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return { width: a.width, height: a.height, data: out };
}

/** Panels side by side on a dark ground with a gap, tops aligned. */
export function hstack(panels: Rgba[], gap = 12): Rgba {
  const width = panels.reduce((s, p) => s + p.width, 0) + gap * (panels.length + 1);
  const height = Math.max(...panels.map((p) => p.height)) + 2 * gap;
  const data = new Uint8Array(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = 40;
    data[o + 1] = 40;
    data[o + 2] = 40;
    data[o + 3] = 255;
  }
  let x0 = gap;
  for (const p of panels) {
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const s = (y * p.width + x) * 4;
        const d = ((y + gap) * width + x0 + x) * 4;
        data[d] = p.data[s];
        data[d + 1] = p.data[s + 1];
        data[d + 2] = p.data[s + 2];
        data[d + 3] = 255;
      }
    }
    x0 += p.width + gap;
  }
  return { width, height, data };
}

/** Panels stacked top to bottom, left aligned. */
export function vstack(panels: Rgba[], gap = 12): Rgba {
  const width = Math.max(...panels.map((p) => p.width));
  const height = panels.reduce((s, p) => s + p.height, 0) + gap * (panels.length - 1);
  const data = new Uint8Array(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = 40;
    data[o + 1] = 40;
    data[o + 2] = 40;
    data[o + 3] = 255;
  }
  let y0 = 0;
  for (const p of panels) {
    for (let y = 0; y < p.height; y++) data.set(p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4), ((y0 + y) * width) * 4);
    y0 += p.height + gap;
  }
  return { width, height, data };
}
