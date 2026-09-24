#!/usr/bin/env tsx
/**
 * Renders cut-out outlines and glows as they were (SVG filters: feMorphology, feGaussianBlur) and as
 * they are (a picture computed from the person's alpha), both through rsvg-convert, and compares
 * where their edges fall along every row and every column (ADR-036 section 2.2, PLAN 3.2).
 *
 *   npx tsx scripts/compare_cutout_outlines.ts [--base-commit <ref>] [--base <dir>] [--out <dir>] [--quick]
 *
 * --base-commit  the commit whose packages/creative/src is "before" (default 79b70e0, the last with
 *                feMorphology); unpacked with `git archive` into a folder under packages/creative/,
 *                so its imports resolve against the package's node_modules, and removed afterwards.
 * --base         a folder already holding the old sources at packages/creative/src (under
 *                packages/creative/), instead of --base-commit.
 * --out          where the report and the pictures go (default output/cutout-outline-compare).
 * --quick        two outline widths and one glow, for a smoke run.
 *
 * The treatment set is built here, with no client's photograph, from shapes whose exact distance
 * is known: a rectangular body (the unit tests' person); a head, neck and sloping shoulders (curves
 * and diagonals); the same with a soft matte and wisps of hair at 20-38% alpha; a body with an arm
 * held away from it (a thin limb and a narrow notch); and a disc. Each is matted at the layout's own
 * pixels (baked at 1x) and at twice them (baked at 2x). Every outline width in the set and three
 * glows are drawn around each.
 *
 * Per case, both layers are rendered by rsvg at the deck's bake size, and the 2x ones also at the
 * preview's 1x. Along every row and every column the 50% crossings of the layer's alpha are found
 * (to a fraction of a pixel), and three things are measured, in device pixels:
 *
 *   exact    how far each outer crossing of the new outline lies from the exact Euclidean offset of
 *            the shape (where its distance equals the width): the new outline's own error. Crossings
 *            whose nearest point of the shape lies below the matte's bottom (where the photograph
 *            cut the person off) have no reference and are only counted;
 *   axis     old against new, where the scanline is the edge's normal and the edge is straight for
 *            the whole width either way (the exact nearest point of the shape lies along the
 *            scanline, within 1 degree, and a square twice the outline's width around it holds no
 *            other part of the shape): a square dilation (feMorphology) and a round one draw the same edge
 *            there, so this is the like-for-like comparison, as a shift along the scanline;
 *   other    old against new everywhere else on the outer edge, along the edge's normal. A square
 *            dilation reaches sqrt(2) times the width along a diagonal and fills notches a round one
 *            leaves, so these move inward by design, by up to (sqrt(2) - 1) times the width;
 *   inner    where the layer meets the person's opaque core, along the normal.
 *
 * A glow is compared as alpha: the largest and the mean difference in 0..255.
 *
 * It also times each old bake (rsvg) against the new picture (computed, including the PNG encode),
 * and checks that at the bake scale rsvg draws the embedded picture exactly.
 * Exits 1 when a new outline's outer edge is more than 1 device pixel from the exact offset, or an
 * axis crossing moves by more than 1 device pixel.
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = { baseCommit: '79b70e0', out: path.join(ROOT, 'output/cutout-outline-compare'), quick: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-commit') args.baseCommit = argv[++i];
    else if (a === '--base') args.base = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--quick') args.quick = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** The old sources, unpacked from git under packages/creative/ so their imports resolve. */
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

function stats(values: number[], unmatched = 0): EdgeStats {
  const sorted = [...values].sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 0;
  return { count: values.length, unmatched, max: r(sorted.at(-1) ?? 0), p95: r(p95), over1: values.filter((s) => s > 1).length };
}

interface Frame {
  /** The layer's rect in layout pixels, and the device pixels per layout pixel it is rendered at. */
  rect: Box;
  scale: number;
  width: number;
  height: number;
  /** The person's rect, where the shape's coordinates start. */
  person: Box;
  shape: Shape;
  /** The outline's width in layout pixels. */
  outline: number;
}

/**
 * The measures described at the top, for one outline layer rendered old and new. A crossing is on
 * the inner edge when the shape is within half a device pixel of it on its low side's end (the
 * layer stops where the person's core starts), and on the outer edge otherwise.
 */
function edgeShifts(oldA: Float32Array, newA: Float32Array, f: Frame) {
  const exact: number[] = [];
  const axis: number[] = [];
  const other: number[] = [];
  const inner: number[] = [];
  let unmatched = 0;
  let belowCut = 0;
  const w = f.outline;
  // The shape's distance at a layout point, and its gradient: the direction away from the nearest point.
  const sdAt = (X: number, Y: number) => f.shape.sd(X - f.person.x, Y - f.person.y);
  const normal = (X: number, Y: number) => {
    const h = 0.05;
    const gx = sdAt(X + h, Y) - sdAt(X - h, Y);
    const gy = sdAt(X, Y + h) - sdAt(X, Y - h);
    const n = Math.hypot(gx, gy) || 1;
    return [gx / n, gy / n];
  };
  const cos1 = Math.cos(Math.PI / 180);
  /**
   * Whether the square of half-size `half` around (X, Y), sampled every `g`, holds no part of the
   * shape except behind the straight edge `d` away along -(nx, ny): no other feature (an arm, the
   * far side of a notch) is near enough for a square dilation to reach where a round one does not.
   */
  const squareClear = (X: number, Y: number, nx: number, ny: number, d: number, half: number, g: number) => {
    for (let u = -half; u <= half; u += g) {
      for (let v = -half; v <= half; v += g) {
        if (-(u * nx + v * ny) > d - 2 * g) continue;
        if (sdAt(X + u, Y + v) <= 0) return false;
      }
    }
    return true;
  };
  for (const vertical of [false, true]) {
    const lines = vertical ? f.width : f.height;
    const count = vertical ? f.height : f.width;
    const step = vertical ? f.width : 1;
    for (let line = 0; line < lines; line++) {
      const start = vertical ? line : line * f.width;
      const before = crossings(oldA, start, step, count);
      const after = crossings(newA, start, step, count);
      for (const c of after) {
        // The crossing in layout pixels.
        const along = f.rect[vertical ? 'y' : 'x'] + c.pos / f.scale;
        const across = f.rect[vertical ? 'x' : 'y'] + (line + 0.5) / f.scale;
        const [X, Y] = vertical ? [across, along] : [along, across];
        const d = sdAt(X, Y);
        const isInner = d < w / 2;
        let best = Infinity;
        for (const o of before) if (o.dir === c.dir) best = Math.min(best, Math.abs(o.pos - c.pos));
        const [nx, ny] = normal(X, Y);
        const cosine = Math.abs(vertical ? ny : nx);
        // The matte stops at the person's bottom, where the photograph cut them off; where the
        // shape's nearest point lies below it, the matte has no such point and no reference applies.
        const cut = Y - ny * d > f.person.y + f.person.height;
        if (!isInner && cut) belowCut++;
        else if (!isInner) exact.push(Math.abs(d - w) * f.scale);
        // A crossing with no counterpart within 50 px is a feature one of them does not draw at all.
        if (best > 50) {
          unmatched++;
          continue;
        }
        if (isInner) {
          inner.push(best * cosine);
          continue;
        }
        // Like for like: the nearest point lies along the scanline, and a square of the outline's
        // size around the crossing reaches no other part of the shape than a round one does.
        const [px, py] = [X - nx * d, Y - ny * d];
        const straight =
          cosine >= cos1 &&
          [-1, -0.5, 0.5, 1].every((t) => {
            // Along the edge at the nearest point, the shape's distance stays that of a straight edge.
            const [ex, ey] = [px - ny * t * w, py + nx * t * w];
            return Math.abs(sdAt(ex + nx * d, ey + ny * d) - d) < 0.05 / f.scale;
          }) &&
          squareClear(X, Y, nx, ny, d, 2 * w, Math.min(1 / f.scale, w / 8));
        if (straight) axis.push(best);
        else other.push(best * cosine);
      }
    }
  }
  return { exact: stats(exact), belowCut, axis: stats(axis), other: stats(other), inner: stats(inner), unmatched };
}

function alphaDifference(oldA: Float32Array, newA: Float32Array) {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < oldA.length; i++) {
    const d = Math.abs(oldA[i] - newA[i]) * 255;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseDir = args.base ?? unpackBase(args.baseCommit);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-outline-compare-'));
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
      for (const resolution of [1, 2]) {
        const asset = matte(shape, resolution);
        const placed = cutoutPlacement(BOX, asset).person;
        const cases: Array<{ kind: 'outline' | 'glow'; photo: PhotoElement; label: string; outline: number }> = [
          ...widths.map((w) => ({ kind: 'outline' as const, label: `outline ${w}`, outline: w, photo: { ...cutout, outline: { color: '#F5B700', width: w } } as PhotoElement })),
          ...glows.map((g) => ({
            kind: 'glow' as const,
            label: `glow ${g.radius}${g.outline ? ` around outline ${g.outline}` : ''}`,
            outline: g.outline ?? 0,
            photo: { ...cutout, glow: { color: '#FFFFFF', radius: g.radius }, ...(g.outline ? { outline: { color: '#F5B700', width: g.outline } } : {}) } as PhotoElement,
          })),
        ];
        for (const c of cases) {
          const before = old.cutoutEffectFragment(c.kind, c.photo, asset.png, placed, CANVAS)!;
          const started = performance.now();
          const after = fresh.cutoutEffectFragment(c.kind, c.photo, asset.png, placed, CANVAS)!;
          const computeMs = performance.now() - started;
          const scale = fresh.photoBakeScale(after);
          // Both layers at the deck's bake size, and the 2x ones at the preview's 1x too.
          for (const s of scale > 1 ? [scale, 1] : [scale]) {
            const size = { width: Math.round(after.rect.width * s), height: Math.round(after.rect.height * s) };
            const oldBake = rsvg(old.photoFragmentDocument(before, size), size.width, size.height, scratch);
            const newBake = rsvg(fresh.photoFragmentDocument(after, size), size.width, size.height, scratch);
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
              const edges = edgeShifts(alphaOf(oldBake.png), alphaOf(newBake.png), {
                rect: after.rect, scale: s, width: size.width, height: size.height, person: placed, shape, outline: c.outline,
              });
              Object.assign(row, edges);
              if (edges.exact.max > 1 || edges.axis.max > 1) failures++;
            } else {
              Object.assign(row, alphaDifference(alphaOf(oldBake.png), alphaOf(newBake.png)));
            }
            rows.push(row);
            console.log(JSON.stringify(row));
          }
        }
      }
    }
    const outlines = rows.filter((r) => String(r.effect).startsWith('outline'));
    const glowRows = rows.filter((r) => String(r.effect).startsWith('glow'));
    const worst = (key: 'exact' | 'axis' | 'other' | 'inner', field: 'max' | 'p95') => Math.max(...outlines.map((r) => (r[key] as EdgeStats)[field]));
    const total = (key: 'exact' | 'axis' | 'other' | 'inner', field: 'count' | 'over1') => outlines.reduce((a, r) => a + (r[key] as EdgeStats)[field], 0);
    const summary = {
      rsvg: version,
      base: args.base ?? args.baseCommit,
      cases: rows.length,
      outline: {
        exactMaxPx: worst('exact', 'max'),
        exactCrossings: total('exact', 'count'),
        exactOver1Px: total('exact', 'over1'),
        exactSkippedBelowCut: outlines.reduce((a, r) => a + (r.belowCut as number), 0),
        axisMaxShiftPx: worst('axis', 'max'),
        axisCrossings: total('axis', 'count'),
        axisOver1Px: total('axis', 'over1'),
        otherMaxShiftPx: worst('other', 'max'),
        otherP95WorstCasePx: worst('other', 'p95'),
        otherCrossings: total('other', 'count'),
        otherOver1Px: total('other', 'over1'),
        innerMaxShiftPx: worst('inner', 'max'),
        innerP95WorstCasePx: worst('inner', 'p95'),
        innerOver1Px: total('inner', 'over1'),
        unmatched: outlines.reduce((a, r) => a + (r.unmatched as number), 0),
      },
      glow: {
        maxLevels: Math.max(...glowRows.map((r) => r.maxLevels as number)),
        worstMeanLevels: Math.max(...glowRows.map((r) => r.meanLevels as number)),
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
    fs.rmSync(scratch, { recursive: true, force: true });
    if (!args.base) fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

await main();
