import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  cutoutEffectRaster,
  euclideanFeatureTransform,
  gaussianBlur,
  gaussianBoxes,
  grownSilhouette,
  type CutoutEffectRasterInput,
} from '../src/studio/cutout-effect-raster.js';
import { cutoutEffectFragment } from '../src/studio/photo-treatments.js';
import type { PhotoElement } from '../src/studio/layout-v2.js';

/**
 * The outline and glow drawn in our code (ADR-036 section 2.2): an exact Euclidean distance
 * transform, SVG's own box approximation of a Gaussian blur, the same bytes for the same inputs, and
 * fast enough that the widest outline at 2x is well inside the Canva deck's time limit.
 */

/** A seeded generator, so a failing mask can be reproduced. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function rgbaPng(width: number, height: number, alpha: (x: number, y: number) => number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      png.data[o] = 200;
      png.data[o + 1] = 30;
      png.data[o + 2] = 30;
      png.data[o + 3] = Math.round(alpha(x, y) * 255);
    }
  }
  return PNG.sync.write(png);
}

describe('the Euclidean feature transform', () => {
  it('finds a nearest set pixel for every pixel, exactly as a search of them all does', () => {
    const next = random(7);
    for (const [width, height, density] of [[1, 1, 1], [7, 1, 0.3], [1, 9, 0.3], [23, 17, 0.02], [31, 29, 0.2], [40, 12, 0.6], [16, 16, 0]] as const) {
      const inside = new Uint8Array(width * height).map(() => (next() < density ? 1 : 0));
      const feature = euclideanFeatureTransform(inside, width, height);
      const set = [...inside.keys()].filter((i) => inside[i]);
      for (let i = 0; i < inside.length; i++) {
        if (!set.length) {
          expect(feature[i]).toBe(-1);
          continue;
        }
        const [x, y] = [i % width, Math.floor(i / width)];
        const d2 = (j: number) => (j % width - x) ** 2 + (Math.floor(j / width) - y) ** 2;
        const best = Math.min(...set.map(d2));
        expect(inside[feature[i]]).toBe(1);
        expect(d2(feature[i])).toBe(best);
      }
    }
  });
});

describe('the outline band', () => {
  it('puts the outer edge at the width past a hard edge anywhere within a pixel', () => {
    // A column of cells whose coverage says where a vertical edge crosses them.
    for (const edge of [10, 10.25, 10.5, 10.8]) {
      const width = 40;
      const alpha = new Float32Array(width).map((_, x) => Math.min(1, Math.max(0, x + 1 - edge)));
      for (const w of [1, 4, 8.5]) {
        const band = grownSilhouette(alpha, width, 1, w);
        // Everything right of the outer edge is covered, so the uncovered length is where it lies.
        const outer = width - band.reduce((a, b) => a + b, 0);
        expect(Math.abs(outer - (edge - w))).toBeLessThanOrEqual(0.1);
      }
    }
  });

  it('is exactly the width past an edge the renderer enlarged, whose alpha ramps across pixels', () => {
    // Bilinear enlargement by 4 of a hard edge at 40: alpha 0.125, 0.375, 0.625, 0.875 around it.
    const width = 80;
    const alpha = new Float32Array(width).map((_, x) => Math.min(1, Math.max(0, (x + 0.5 - 40) / 4 + 0.5)));
    const band = grownSilhouette(alpha, width, 1, 10);
    expect(width - band.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 5);
  });
});

describe('the glow blur', () => {
  it('uses the box sizes SVG\'s feGaussianBlur specifies', () => {
    // d = floor(sigma * 3 * sqrt(2 pi) / 4 + 0.5): 1.88 per sigma.
    expect(gaussianBoxes(0.2)).toEqual([]);
    expect(gaussianBoxes(1)).toEqual([[1, 0], [0, 1], [1, 1]]); // d = 2
    expect(gaussianBoxes(1.5)).toEqual([[1, 1], [1, 1], [1, 1]]); // d = 3
    expect(gaussianBoxes(10)).toEqual([[9, 9], [9, 9], [9, 9]]); // d = 19
    expect(gaussianBoxes(60)).toEqual([[56, 56], [56, 56], [56, 56]]); // d = 113
    expect(gaussianBoxes(8)).toEqual([[7, 7], [7, 7], [7, 7]]); // d = 15
    expect(gaussianBoxes(4)).toEqual([[4, 3], [3, 4], [4, 4]]); // d = 8
  });

  it('keeps a point\'s weight, spreads it evenly, and matches a Gaussian of that sigma', () => {
    const size = 201;
    const point = new Float32Array(size * size);
    point[100 * size + 100] = 1;
    const sigma = 12;
    const blurred = gaussianBlur(point, size, size, sigma);
    expect(blurred.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
    expect(blurred[100 * size + 100 - 7]).toBeCloseTo(blurred[100 * size + 100 + 7], 6);
    expect(blurred[(100 - 7) * size + 100]).toBeCloseTo(blurred[100 * size + 100 - 7], 6);
    // The row through the centre, normalised, against the Gaussian profile.
    const row = Array.from({ length: size }, (_, x) => blurred[100 * size + x]);
    const peak = row[100];
    for (const offset of [0, 6, 12, 24]) {
      expect(Math.abs(row[100 + offset] / peak - Math.exp(-(offset ** 2) / (2 * sigma ** 2)))).toBeLessThan(0.05);
    }
  });
});

describe('the effect picture', () => {
  const person = rgbaPng(100, 150, (x, y) => (x >= 25 && x < 75 && y >= 20 ? 1 : 0));
  const input = (extra: Partial<CutoutEffectRasterInput> = {}): CutoutEffectRasterInput => ({
    png: person,
    personRect: { x: 140.4, y: 440, width: 400, height: 600 },
    grid: { x: 110, y: 410, width: 460 * 2, height: 630 * 2, scale: 2 },
    crop: { x: 120, y: 420, width: 440, height: 620 },
    color: '#F5B700',
    outlineWidth: 12,
    ...extra,
  });

  it('is the same bytes for the same inputs, computed twice', () => {
    for (const extra of [{}, { glowSigma: 9 }, { outlineWidth: 0, glowSigma: 4 }, { fade: { x1: 0, y1: 900, x2: 0, y2: 1040 } }]) {
      const a = cutoutEffectRaster(input(extra));
      const b = cutoutEffectRaster(input(extra));
      expect(a.equals(b)).toBe(true);
    }
  });

  it('leaves out the person\'s opaque core and follows the fade', () => {
    const ring = PNG.sync.read(cutoutEffectRaster(input({ fade: { x1: 0, y1: 890, x2: 0, y2: 1040 } })));
    const at = (x: number, y: number) => ring.data[((Math.round((y - 420) * 2)) * ring.width + Math.round((x - 120) * 2)) * 4 + 3];
    // The body's left edge is x 240.4: the outline to its left, nothing under the body.
    expect(at(234, 700)).toBe(255);
    expect(at(300, 700)).toBe(0);
    // Halfway down the fade the outline is half there; at its end, gone.
    expect(Math.abs(at(234, 965) - 128)).toBeLessThanOrEqual(2);
    expect(at(234, 1039.6)).toBeLessThanOrEqual(1);
  });

  it('draws a 24 px outline at 2x, at the deck\'s largest layer, in under a second including the PNG', () => {
    // A person 900x1300 on a 1080x1350 poster with twice the pixels: the outline's layer is 950x1325
    // layout pixels, just under PHOTO_BAKE_MAX_PIXELS at 2x (5 million device pixels).
    const W = 1800;
    const H = 2600;
    const silhouette = rgbaPng(W, H, (x, y) => {
      const head = Math.hypot((x - 900) / 300, (y - 500) / 380) <= 1;
      const body = y > 800 && Math.abs(x - 900) < 300 + (y - 800) * 0.4;
      return head || body ? 1 : 0;
    });
    const photo: PhotoElement = { photoIndex: 0, role: 'portrait', x: 90, y: 40, width: 900, height: 1300, treatment: 'cutout', outline: { color: '#F5B700', width: 24 } };
    const started = performance.now();
    const fragment = cutoutEffectFragment('outline', photo, silhouette, { x: 90, y: 40, width: 900, height: 1300 }, { width: 1080, height: 1350 })!;
    const elapsed = performance.now() - started;
    const ring = PNG.sync.read(fragment.raster!);
    expect({ width: ring.width, height: ring.height }).toEqual({ width: 1900, height: 2650 });
    expect(elapsed).toBeLessThan(1000);
  });
});
