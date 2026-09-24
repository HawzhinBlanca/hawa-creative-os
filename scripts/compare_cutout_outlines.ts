#!/usr/bin/env tsx
/**
 * Renders cut-out outlines and glows as they were (SVG filters: feMorphology, feGaussianBlur) and as
 * they are (a picture computed from the person's alpha), both through rsvg-convert, and compares
 * where their edges fall along every row and every column (ADR-036 section 2.2, PLAN 3.2).
 *
 *   npx tsx scripts/compare_cutout_outlines.ts [--base-commit <ref>] [--base <dir>] [--out <dir>] [--quick] [--corners round]
 *
 * --base-commit  the commit whose packages/creative/src is "before" (default 79b70e0, the last with
 *                feMorphology); unpacked with `git archive` into packages/creative/.compare-base-*
 *                (gitignored), so its imports resolve against the package's node_modules, and
 *                removed afterwards, on Ctrl-C too.
 * --base         a folder already holding the old sources at packages/creative/src (under
 *                packages/creative/), instead of --base-commit.
 * --out          where the report and the pictures go (default output/cutout-outline-compare).
 * --quick        two outline widths and one glow, for a smoke run.
 * --corners      round: draw the new outlines with round corners (a true distance), the owner's
 *                alternative to today's square ones, for a proof sheet. It is expected to fail the
 *                gate: a round outline comes in at corners and diagonals by up to 0.41 of its width.
 *
 * The treatment set is built here, with no client's photograph: a rectangular body (the unit tests'
 * person); a head, neck and sloping shoulders (curves and diagonals); the same with a soft matte and
 * wisps of hair at 20-38% alpha; a body with an arm held away from it (a thin limb and a narrow
 * notch); and a disc. Each is matted at the layout's own pixels (baked at 1x), at twice them and
 * at three times them (both baked at 2x; the renderer reduces the second by 1.5 there and 3 in the
 * preview). Every outline width in the set and three glows are drawn around each.
 *
 * Per case, the layers the deck places are rendered by rsvg at the deck's bake size, and for the
 * ones baked at 2x the layers the preview draws are rendered at the preview's 1x too. Along every row and every column the 50% crossings of the layer's alpha are found
 * (to a fraction of a pixel), and each crossing of either one is matched with the nearest crossing
 * of the other in the same direction on the same line. The shift is their distance in device
 * pixels, along the scanline; a crossing with no counterpart within 50 px is a feature one of them
 * does not draw at all. A glow is compared as alpha: the largest and the mean difference in 0..255,
 * of the layer alone and as seen with the person drawn over it (see GLOW_MAX_LEVELS).
 *
 * It also times each old bake (rsvg) against the new picture (computed, including the PNG encode),
 * and checks that at the bake scale rsvg draws the embedded picture exactly.
 *
 * Exits 1 unless PLAN 3.2's criterion holds: every outline crossing, outer and inner edge, at the
 * bake scale and at the preview's, within 1 device px of today's, and none unmatched; and every glow,
 * as seen, within GLOW_MAX_LEVELS of today's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fresh from '../packages/creative/src/studio/photo-treatments.js';
import type { Box, PhotoElement } from '../packages/creative/src/studio/layout-v2.js';
import { cutoutPlacement } from '../packages/creative/src/studio/photo-cutout.js';
// pngjs is a dependency of the creative package, not of the root; the renderer re-exports it.
import { PNG } from '../packages/creative/src/studio/render-layout-v2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREATIVE = path.join(ROOT, 'packages/creative');
const RSVG = fs.existsSync('/opt/homebrew/bin/rsvg-convert') ? '/opt/homebrew/bin/rsvg-convert' : 'rsvg-convert';
const CANVAS = { width: 1080, height: 1350 };
/** The photo's box, as in the unit tests; every matte has its aspect, so the person fills it. */
const BOX: Box = { x: 140, y: 440, width: 400, height: 600 };

interface Args {
  baseCommit: string;
  base?: string;
  out: string;
  quick: boolean;
  corners: 'square' | 'round';
}

function parseArgs(argv: string[]): Args {
  const args: Args = { baseCommit: '79b70e0', out: path.join(ROOT, 'output/cutout-outline-compare'), quick: false, corners: 'square' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-commit') args.baseCommit = argv[++i];
    else if (a === '--base') args.base = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--quick') args.quick = true;
    else if (a === '--corners') {
      const corners = argv[++i];
      if (corners !== 'square' && corners !== 'round') throw new Error(`--corners takes square or round, not ${corners}`);
      args.corners = corners;
    }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/**
 * The old sources, unpacked from git under packages/creative/ so their imports resolve. The folder's
 * name is gitignored there, and a Ctrl-C or a kill removes it (see main).
 */
function unpackBase(commit: string): string {
  const dir = fs.mkdtempSync(path.join(CREATIVE, '.compare-base-'));
  const archive = spawnSync('git', ['-C', ROOT, 'archive', '--format=tar', commit, 'packages/creative/src'], { maxBuffer: 1 << 28 });
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  return dir;
}

// --- The treatment set: shapes with exact signed distances (layout px, negative inside) ----------

type Sd = (x: number, y: number) => number;

const box = (x0: number, y0: number, x1: number, y1: number): Sd => (x, y) => {
  const dx = Math.max(x0 - x, x - x1);
  const dy = Math.max(y0 - y, y - y1);
  return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
};
const circle = (cx: number, cy: number, r: number): Sd => (x, y) => Math.hypot(x - cx, y - cy) - r;
const capsule = (ax: number, ay: number, bx: number, by: number, r: number): Sd => (x, y) => {
  const [px, py, vx, vy] = [x - ax, y - ay, bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - vx * t, py - vy * t) - r;
};
const polygon = (points: Array<[number, number]>): Sd => (x, y) => {
  let d = Infinity;
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const [px, py, vx, vy] = [x - ax, y - ay, bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy)));
    d = Math.min(d, Math.hypot(px - vx * t, py - vy * t));
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -d : d;
};
/** The union of shapes: exact outside, which is all an outline needs. */
const union = (...parts: Sd[]): Sd => (x, y) => Math.min(...parts.map((p) => p(x, y)));

interface Shape {
  name: string;
  sd: Sd;
  /** Width of the matte's edge ramp in layout pixels (0: one source pixel of anti-aliasing). */
  soft: number;
  /** Alpha under 0.5 added over the shape (hair wisps), which an outline does not follow. */
  extra?: (x: number, y: number) => number;
}

const [W, H] = [BOX.width, BOX.height];
const headAndShoulders = union(
  circle(W / 2, 0.22 * H, 0.17 * W),
  box(W / 2 - 0.07 * W, 0.3 * H, W / 2 + 0.07 * W, 0.45 * H),
  polygon([[W / 2 - 0.2 * W, 0.42 * H], [W / 2 + 0.2 * W, 0.42 * H], [W / 2 + 0.48 * W, H + 10], [W / 2 - 0.48 * W, H + 10]])
);
const wisps = (x: number, y: number) => {
  let a = 0;
  for (let k = 0; k < 7; k++) {
    const angle = -Math.PI / 2 + (k - 3) * 0.28;
    const [cx, cy, r0] = [W / 2, 0.22 * H, 0.17 * W];
    const strand = capsule(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0, cx + Math.cos(angle) * (r0 + 14), cy + Math.sin(angle) * (r0 + 14), 0.8);
    if (strand(x, y) < 0) a = Math.max(a, 0.2 + 0.03 * k);
  }
  return a;
};

const SHAPES: Shape[] = [
  { name: 'rect-body', sd: box(0.25 * W, (20 / 150) * H, 0.75 * W, H + 10), soft: 0 },
  { name: 'head-shoulders', sd: headAndShoulders, soft: 0 },
  { name: 'soft-matte-hair', sd: headAndShoulders, soft: 3, extra: wisps },
  { name: 'arm-and-notch', sd: union(box(0.35 * W, 0.3 * H, 0.65 * W, H + 10), capsule(0.62 * W, 0.4 * H, 0.9 * W, 0.75 * H, 3)), soft: 1 },
  { name: 'disc', sd: circle(W / 2, H / 2, 0.4 * W), soft: 1 },
];

/** A matte of `shape` with `resolution` source pixels per layout pixel. */
function matte(shape: Shape, resolution: number): { png: Buffer; width: number; height: number } {
  const width = W * resolution;
  const height = H * resolution;
  const png = new PNG({ width, height });
  const span = (soft: number) => Math.max(1 / resolution, soft);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = (i + 0.5) / resolution;
      const y = (j + 0.5) / resolution;
      // The 50% contour is exactly where the distance is zero.
      let a = Math.min(1, Math.max(0, 0.5 - shape.sd(x, y) / span(shape.soft)));
      if (shape.extra) a = Math.max(a, shape.extra(x, y));
      const o = (j * width + i) * 4;
      png.data[o] = 180;
      png.data[o + 1] = 120;
      png.data[o + 2] = 90;
      png.data[o + 3] = Math.round(a * 255);
    }
  }
  return { png: PNG.sync.write(png), width, height };
}

// --- Rendering ---------------------------------------------------------------------------------

function rsvg(svg: string, width: number, height: number, scratch: string): { png: PNG; ms: number } {
  const file = path.join(scratch, 'layer.svg');
  fs.writeFileSync(file, svg);
  const started = performance.now();
  const r = spawnSync(RSVG, ['-w', String(width), '-h', String(height), '-f', 'png', file], { maxBuffer: 1 << 28, timeout: 120_000 });
  const ms = performance.now() - started;
  if (r.status !== 0) throw new Error(`rsvg-convert failed: ${r.stderr}`);
  return { png: PNG.sync.read(r.stdout), ms };
}

function alphaOf(png: PNG): Float32Array {
  const out = new Float32Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) out[i] = png.data[i * 4 + 3] / 255;
  return out;
}

// --- Edges along scanlines ---------------------------------------------------------------------

interface Crossing {
  /** Device pixels from the start of the line, pixel centres at k + 0.5. */
  pos: number;
  dir: 1 | -1;
}

/** The 50% crossings along one line of `count` pixels starting at `start`, `step` apart. */
function crossings(alpha: Float32Array, start: number, step: number, count: number): Crossing[] {
  const out: Crossing[] = [];
  for (let k = 0; k + 1 < count; k++) {
    const a = alpha[start + k * step];
    const b = alpha[start + (k + 1) * step];
    if ((a < 0.5 && b >= 0.5) || (a >= 0.5 && b < 0.5)) out.push({ pos: k + 0.5 + (0.5 - a) / (b - a), dir: a < 0.5 ? 1 : -1 });
  }
  return out;
}

interface EdgeStats {
  count: number;
  unmatched: number;
  max: number;
  p95: number;
  over1: number;
}

function stats(values: number[], unmatched: number): EdgeStats {
  const sorted = [...values].sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 0;
  return { count: values.length, unmatched, max: r(sorted.at(-1) ?? 0), p95: r(p95), over1: values.filter((s) => s > 1).length };
}

/**
 * Every crossing of one layer matched with the nearest crossing of the other, in the same direction
 * on the same row or column, both ways round: an edge the new layer moved, and an edge only one of
 * them draws, both show. The shift is along the scanline, in device pixels, which is at least the
 * shift along the edge's normal, so the criterion is not loosened by measuring it this way.
 */
function edgeShifts(oldA: Float32Array, newA: Float32Array, width: number, height: number): EdgeStats {
  const shifts: number[] = [];
  let unmatched = 0;
  const match = (from: Crossing[], to: Crossing[]) => {
    for (const c of from) {
      let best = Infinity;
      for (const o of to) if (o.dir === c.dir) best = Math.min(best, Math.abs(o.pos - c.pos));
      if (best > 50) unmatched++;
      else shifts.push(best);
    }
  };
  for (const vertical of [false, true]) {
    const lines = vertical ? width : height;
    const count = vertical ? height : width;
    const step = vertical ? width : 1;
    for (let line = 0; line < lines; line++) {
      const start = vertical ? line : line * width;
      const before = crossings(oldA, start, step, count);
      const after = crossings(newA, start, step, count);
      match(after, before);
      match(before, after);
    }
  }
  return stats(shifts, unmatched);
}

/**
 * The largest and the mean difference in alpha, 0..255. With `person` (the person's alpha drawn over
 * the layer), the difference as seen: the layer shows through where the person does not cover it.
 */
function alphaDifference(oldA: Float32Array, newA: Float32Array, person?: Float32Array) {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < oldA.length; i++) {
    const d = Math.abs(oldA[i] - newA[i]) * (person ? 1 - person[i] : 1) * 255;
    max = Math.max(max, d);
    sum += d;
  }
  return { maxLevels: Math.round(max), meanLevels: Math.round((sum / oldA.length) * 100) / 100 };
}

function alphaBytes(png: PNG): Buffer {
  const out = Buffer.alloc(png.width * png.height);
  for (let i = 0; i < out.length; i++) out[i] = png.data[i * 4 + 3];
  return out;
}

// --- Main --------------------------------------------------------------------------------------

/**
 * The person drawn alone over the layer's rect, as the renderer draws them on top of it: the same
 * picture at the same place in both, so it is rendered once, by rsvg.
 */
function personDocument(png: Buffer, person: Box, rect: Box, size: { width: number; height: number }): string {
  return (
    `<svg width="${size.width}" height="${size.height}" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    `<image x="${person.x}" y="${person.y}" width="${person.width}" height="${person.height}" preserveAspectRatio="none" xlink:href="data:image/png;base64,${png.toString('base64')}"/></svg>`
  );
}

/**
 * The largest difference in alpha, in 0..255, a glow may show against today's where it is seen (not
 * under the person): two percent. The three-box blur is the one librsvg itself runs, so what is
 * left is the person's alpha resampled at their edge. The layer alone differs by more there, a few
 * pixels under the person's edge: the core the glow leaves out turns from none to all between 98%
 * and 100% of the person's alpha, so a difference of 1/255 in that alpha is 50/255 of the core.
 */
const GLOW_MAX_LEVELS = 5;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = args.base ?? unpackBase(args.baseCommit);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-outline-compare-'));
  const cleanUp = () => {
    fs.rmSync(scratch, { recursive: true, force: true });
    if (!args.base) fs.rmSync(baseDir, { recursive: true, force: true });
  };
  // A Ctrl-C or a kill would otherwise leave the unpacked sources in the package.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      cleanUp();
      process.exit(130);
    });
  }
  fs.mkdirSync(args.out, { recursive: true });
  const version = spawnSync(RSVG, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  try {
    const old = (await import(pathToFileURL(path.join(baseDir, 'packages/creative/src/studio/photo-treatments.ts')).href)) as typeof fresh;
    const widths = args.quick ? [4, 24] : [1, 2, 4, 8, 12, 20, 24];
    const glows: Array<{ radius: number; outline?: number }> = args.quick ? [{ radius: 30 }] : [{ radius: 10 }, { radius: 30 }, { radius: 30, outline: 24 }];
    const rows: Array<Record<string, unknown>> = [];
    let failures = 0;
    const cutout = { photoIndex: 0, role: 'portrait', ...BOX, treatment: 'cutout' } as const;
    for (const shape of SHAPES) {
      for (const resolution of args.quick ? [1, 2] : [1, 2, 3]) {
        const asset = matte(shape, resolution);
        const placed = cutoutPlacement(BOX, asset).person;
        const cases: Array<{ kind: 'outline' | 'glow'; photo: PhotoElement; label: string }> = [
          ...widths.map((w) => ({ kind: 'outline' as const, label: `outline ${w}`, photo: { ...cutout, outline: { color: '#F5B700', width: w } } as PhotoElement })),
          ...glows.map((g) => ({
            kind: 'glow' as const,
            label: `glow ${g.radius}${g.outline ? ` around outline ${g.outline}` : ''}`,
            photo: { ...cutout, glow: { color: '#FFFFFF', radius: g.radius }, ...(g.outline ? { outline: { color: '#F5B700', width: g.outline } } : {}) } as PhotoElement,
          })),
        ];
        for (const c of cases) {
          // Everything below is synchronous; letting the event loop turn here lets a Ctrl-C or a kill
          // reach the handlers above between cases.
          await new Promise((resolve) => setImmediate(resolve));
          const before = old.cutoutEffectFragment(c.kind, c.photo, asset.png, placed, CANVAS)!;
          const started = performance.now();
          const after = fresh.cutoutEffectFragment(c.kind, c.photo, asset.png, placed, CANVAS, { target: 'deck', outlineCorners: args.corners })!;
          const computeMs = performance.now() - started;
          const preview = fresh.cutoutEffectFragment(c.kind, c.photo, asset.png, placed, CANVAS, { target: 'preview', outlineCorners: args.corners })!;
          const scale = fresh.photoBakeScale(after);
          // The deck's layer at its bake size, and for the 2x ones the preview's layer at 1x too. The
          // old layer is the same filter drawn at either size, as the preview and the deck drew it.
          for (const s of scale > 1 ? [scale, 1] : [scale]) {
            const size = { width: Math.round(after.rect.width * s), height: Math.round(after.rect.height * s) };
            const oldBake = rsvg(old.photoFragmentDocument(before, size), size.width, size.height, scratch);
            const newBake = rsvg(fresh.photoFragmentDocument(s === scale ? after : preview, size), size.width, size.height, scratch);
            const name = `${shape.name}-${resolution}x-${c.label.replace(/ /g, '-')}-at-${s}x`;
            fs.writeFileSync(path.join(args.out, `${name}-old.png`), PNG.sync.write(oldBake.png));
            fs.writeFileSync(path.join(args.out, `${name}-new.png`), PNG.sync.write(newBake.png));
            const row: Record<string, unknown> = {
              shape: shape.name,
              source: `${resolution}x`,
              effect: c.label,
              renderedAt: `${s}x`,
              size: `${size.width}x${size.height}`,
              oldRsvgMs: Math.round(oldBake.ms),
              newRsvgMs: Math.round(newBake.ms),
              ...(s === scale
                ? {
                    newComputeMs: Math.round(computeMs),
                    // At the bake scale rsvg draws the embedded picture pixel for pixel.
                    newPictureExact: alphaBytes(newBake.png).equals(alphaBytes(PNG.sync.read(after.raster!))),
                  }
                : {}),
            };
            if (c.kind === 'outline') {
              const edges = edgeShifts(alphaOf(oldBake.png), alphaOf(newBake.png), size.width, size.height);
              row.edges = edges;
              if (edges.max > 1 || edges.unmatched > 0) failures++;
            } else {
              const person = alphaOf(rsvg(personDocument(asset.png, placed, after.rect, size), size.width, size.height, scratch).png);
              const alone = alphaDifference(alphaOf(oldBake.png), alphaOf(newBake.png));
              const seen = alphaDifference(alphaOf(oldBake.png), alphaOf(newBake.png), person);
              Object.assign(row, { alone, seen });
              if (seen.maxLevels > GLOW_MAX_LEVELS) failures++;
            }
            rows.push(row);
            console.log(JSON.stringify(row));
          }
        }
      }
    }
    const outlines = rows.filter((r) => String(r.effect).startsWith('outline'));
    const glowRows = rows.filter((r) => String(r.effect).startsWith('glow'));
    const edgesOf = (r: Record<string, unknown>) => r.edges as EdgeStats;
    const summary = {
      rsvg: version,
      base: args.base ?? args.baseCommit,
      corners: args.corners,
      cases: rows.length,
      outline: {
        crossings: outlines.reduce((a, r) => a + edgesOf(r).count, 0),
        maxShiftPx: Math.max(...outlines.map((r) => edgesOf(r).max)),
        p95WorstCasePx: Math.max(...outlines.map((r) => edgesOf(r).p95)),
        over1Px: outlines.reduce((a, r) => a + edgesOf(r).over1, 0),
        unmatched: outlines.reduce((a, r) => a + edgesOf(r).unmatched, 0),
      },
      glow: {
        seenMaxLevels: Math.max(...glowRows.map((r) => (r.seen as { maxLevels: number }).maxLevels)),
        seenWorstMeanLevels: Math.max(...glowRows.map((r) => (r.seen as { meanLevels: number }).meanLevels)),
        limitLevels: GLOW_MAX_LEVELS,
        aloneMaxLevels: Math.max(...glowRows.map((r) => (r.alone as { maxLevels: number }).maxLevels)),
        aloneWorstMeanLevels: Math.max(...glowRows.map((r) => (r.alone as { meanLevels: number }).meanLevels)),
      },
      slowestOldRsvgMs: Math.max(...rows.map((r) => r.oldRsvgMs as number)),
      slowestNewComputeMs: Math.max(...rows.map((r) => (r.newComputeMs as number | undefined) ?? 0)),
      newPictureExactEverywhere: rows.every((r) => r.newPictureExact !== false),
      failures,
    };
    fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (failures) process.exitCode = 1;
  } finally {
    cleanUp();
  }
}

await main();
