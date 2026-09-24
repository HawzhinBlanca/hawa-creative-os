/**
 * scripts/bench_cutout_outline.ts: how long the widest cut-out outline takes (ADR-036 section 2.2,
 * architecture programme 3.2).
 *
 * The acceptance of 3.2 is "a 24 px outline at 2x in under 1 s": librsvg's feMorphology took 23 s
 * for it and timed out the Canva deck. This times exactly that case, the deck's largest layer drawn
 * from a photograph, PNG included, and fails when the median is over the budget.
 *
 * It lives here and not in the suite because a wall-clock limit measures the machine as much as the
 * code: under the suite's parallel load the same computation took 1.1 to 2.0 s against the 1 s limit
 * and failed runs that changed nothing. The suite keeps what does not depend on load (the effect's
 * size and bytes, and that its work does not grow with the outline's width); run this on a quiet
 * machine for the time itself.
 *
 *   npx tsx scripts/bench_cutout_outline.ts                 # 7 runs, 1000 ms budget
 *   npx tsx scripts/bench_cutout_outline.ts --runs 15 --budget-ms 1000
 */
import os from 'node:os';
// pngjs is a dependency of the creative package, not of the root; the renderer re-exports it.
import { PNG } from '../packages/creative/src/studio/render-layout-v2.js';
import { cutoutEffectFragment } from '../packages/creative/src/studio/photo-treatments.js';
import type { PhotoElement } from '../packages/creative/src/studio/layout-v2.js';

function argValue(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

/** A seeded generator, so every run draws the same photograph. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A person 900x1300 on a 1080x1350 poster, at twice the pixels, painted with noisy colour as a real
 * cut-out is (a flat colour compresses to nothing and decodes faster than any photograph). The same
 * picture the suite's size check uses.
 */
function photograph(): Buffer {
  const [width, height] = [1800, 2600];
  const png = new PNG({ width, height });
  const next = random(3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const head = Math.hypot((x - 900) / 300, (y - 500) / 380) <= 1;
      const body = y > 800 && Math.abs(x - 900) < 300 + (y - 800) * 0.4;
      const o = (y * width + x) * 4;
      png.data[o] = Math.floor(next() * 256);
      png.data[o + 1] = Math.floor(next() * 256);
      png.data[o + 2] = Math.floor(next() * 256);
      png.data[o + 3] = head || body ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function main(): void {
  const runs = Math.round(argValue('--runs', 7));
  const budgetMs = argValue('--budget-ms', 1000);
  const person = photograph();
  const rect = { x: 90, y: 40, width: 900, height: 1300 };
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let run = 0; run < runs; run++) {
    // Effects are kept by a hash of their inputs; a colour one unit apart is the same work, computed afresh.
    const color = `#F5B7${(run % 256).toString(16).padStart(2, '0').toUpperCase()}`;
    const photo: PhotoElement = { photoIndex: 0, role: 'portrait', ...rect, treatment: 'cutout', outline: { color, width: 24 } };
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    const fragment = cutoutEffectFragment('outline', photo, person, rect, { width: 1080, height: 1350 }, { target: 'deck' });
    wall.push(performance.now() - started);
    const used = process.cpuUsage(cpuStart);
    cpu.push((used.user + used.system) / 1000);
    const ring = PNG.sync.read(fragment!.raster!);
    if (ring.width !== 1900 || ring.height !== 2650) throw new Error(`the outline's layer is ${ring.width}x${ring.height}, expected 1900x2650`);
  }
  const ms = (v: number) => `${Math.round(v)} ms`;
  console.log(`24 px outline at 2x on the deck's largest layer (1900x2650), ${runs} runs, load average ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}`);
  console.log(`  wall: min ${ms(Math.min(...wall))}, median ${ms(median(wall))}, max ${ms(Math.max(...wall))}`);
  console.log(`  cpu:  min ${ms(Math.min(...cpu))}, median ${ms(median(cpu))}, max ${ms(Math.max(...cpu))} (all threads of this process)`);
  // The first run also compiles the code; the median is what a deck render pays once warm.
  const verdict = median(wall) <= budgetMs;
  console.log(`${verdict ? 'PASS' : 'FAIL'}: median ${ms(median(wall))} against a budget of ${ms(budgetMs)}`);
  if (!verdict) process.exitCode = 1;
}

main();
