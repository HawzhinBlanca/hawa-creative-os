#!/usr/bin/env tsx
/**
 * Checks the gate's own measurements against cases with known answers before they are trusted on
 * renders. Exits 1 on the first wrong answer.
 *
 *   npx tsx output/gates/2026-09-resvg/scripts/selftest.ts
 */
import assert from 'node:assert/strict';
import { columnProfile, contentShare, inkBox, profileCorrelation, readPng, ssim, ssimChannel, writePng, type Rgba } from './image-metrics.js';

function flat(width: number, height: number, rgba: [number, number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let o = 0; o < data.length; o += 4) data.set(rgba, o);
  return { width, height, data };
}

function rect(img: Rgba, x0: number, y0: number, w: number, h: number, rgba: [number, number, number, number]): Rgba {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(rgba, (y * img.width + x) * 4);
  return img;
}

// A deterministic textured picture: a smooth gradient with a pattern of blocks.
function textured(width: number, height: number, shift = 0): Rgba {
  const img = flat(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xs = x - shift;
      const v = (xs * 3 + y * 2 + (((xs >> 3) + (y >> 3)) % 2 ? 60 : 0)) % 256;
      img.data.set([v, 255 - v, (v * 7) % 256, 255], (y * width + x) * 4);
    }
  }
  return img;
}

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok  ${name}`);
}

check('SSIM of an image with itself is 1', () => {
  const a = textured(120, 90);
  assert.equal(ssim(a, a), 1);
});

check('SSIM of flat black against flat white is C1 / (255^2 + C1)', () => {
  const n = 20 * 20;
  const black = new Float64Array(n);
  const white = new Float64Array(n).fill(255);
  const c1 = (0.01 * 255) ** 2;
  assert.ok(Math.abs(ssimChannel(black, white, 20, 20) - c1 / (255 * 255 + c1)) < 1e-12);
});

check('SSIM falls with noise and falls further with more', () => {
  const a = textured(160, 120);
  const noisy = (amp: number) => {
    const b: Rgba = { width: a.width, height: a.height, data: new Uint8Array(a.data) };
    let seed = 7;
    for (let o = 0; o < b.data.length; o += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const d = ((seed % 1000) / 1000 - 0.5) * 2 * amp;
      for (let c = 0; c < 3; c++) b.data[o + c] = Math.max(0, Math.min(255, Math.round(b.data[o + c] + d)));
    }
    return b;
  };
  const s4 = ssim(a, noisy(4));
  const s40 = ssim(a, noisy(40));
  assert.ok(s4 < 1 && s4 > 0.9, `light noise ${s4}`);
  assert.ok(s40 < s4, `heavy noise ${s40} vs light ${s4}`);
});

check('SSIM sees a transparency difference that is invisible on one ground', () => {
  // Black at alpha 0 against black at alpha 255: identical on black, different on white.
  const a = flat(40, 40, [0, 0, 0, 0]);
  const b = rect(flat(40, 40, [0, 0, 0, 0]), 10, 10, 20, 20, [0, 0, 0, 255]);
  assert.ok(ssim(a, b) < 0.9);
});

check('PNG round trip keeps every byte', () => {
  const a = textured(33, 17);
  assert.deepEqual(readPng(writePng(a)).data, a.data);
});

check('ink box is the inclusive box of pixels at least half opaque', () => {
  const img = rect(flat(100, 50, [0, 0, 0, 0]), 10, 5, 30, 20, [255, 255, 255, 255]);
  rect(img, 60, 30, 5, 5, [255, 255, 255, 100]);
  assert.deepEqual(inkBox(img), { left: 10, top: 5, right: 39, bottom: 24, pixels: 600 });
});

check('column profiles: a shifted line correlates near 1, the same words reordered do not', () => {
  // Three "words" of widths 40, 12 and 26 with 10 px gaps, then reordered.
  const line = (widths: number[], x0: number) => {
    const img = flat(200, 30, [0, 0, 0, 0]);
    let x = x0;
    for (const w of widths) {
      for (let i = 0; i < w; i += 3) rect(img, x + i, 5 + (i % 7), 2, 18 - (i % 5), [255, 255, 255, 255]);
      x += w + 10;
    }
    return img;
  };
  const a = line([40, 12, 26], 20);
  const shifted = line([40, 12, 26], 23);
  const reordered = line([26, 12, 40], 20);
  const pa = columnProfile(a);
  const same = profileCorrelation(pa, columnProfile(shifted), inkBox(a)!.left, inkBox(shifted)!.left);
  const swapped = profileCorrelation(pa, columnProfile(reordered), inkBox(a)!.left, inkBox(reordered)!.left);
  assert.ok(same.corr > 0.999, `shifted ${same.corr}`);
  assert.ok(swapped.corr < 0.8, `reordered ${swapped.corr}`);
});

check('content share counts pixels unlike the top-left one', () => {
  const img = rect(flat(10, 10, [10, 20, 30, 255]), 0, 5, 10, 5, [200, 20, 30, 255]);
  assert.equal(contentShare(img), 0.5);
});

console.log(`${checks} checks passed`);
