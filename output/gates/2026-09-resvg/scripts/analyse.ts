#!/usr/bin/env tsx
/**
 * Scores the resvg gate's renders against ADR-036 section 2.3 and writes the evidence: a JSON of
 * every number, the 30 lowest-SSIM pairs, the Kurdish sheet and the flagged lines as PNGs.
 *
 *   npx tsx output/gates/2026-09-resvg/scripts/analyse.ts --work <dir> --out output/gates/2026-09-resvg
 *
 * Reads <work>/jobs.json, <work>/out/container/results.jsonl (and <work>/out/host/results.jsonl
 * when the Mac run exists). The PNGs are read from <work>/out/<tag>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Job } from './cases.js';
import {
  columnProfile,
  contentShare,
  diffMap,
  downscale,
  hstack,
  inkBox,
  onChecker,
  profileCorrelation,
  readPng,
  ssim,
  vstack,
  writePng,
  type Rgba,
} from './image-metrics.js';

interface Row {
  job: string;
  renderer: 'rsvg' | 'resvg';
  rep: number | 'warm';
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  ms: number;
  rssKb: number | null;
  stderr: string;
  pngBytes: number;
  sha256: string | null;
}

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WORK = path.resolve(arg('--work') ?? '');
const OUT = path.resolve(arg('--out') ?? '');
if (!arg('--work') || !arg('--out')) throw new Error('--work <dir> --out <dir> are required');

/**
 * Word order counts as changed below this profile correlation. Set after looking at both sides of
 * the line on the first run: the 174 reversed-word controls score at most 0.674, and lines drawn in
 * the same order with no resvg warning score at least 0.886 (the lowest is Amiri's mirrored
 * parentheses in "(K-12)", drawn taller by resvg). 0.8 sits between them. The count at 0.9, the value
 * first tried, is reported too.
 */
const WORD_ORDER_CORR = 0.8;
const LATIN_PX = 1;
const ARABIC_PX = 2;

const jobs: Job[] = JSON.parse(fs.readFileSync(path.join(WORK, 'jobs.json'), 'utf8'));
const byId = new Map(jobs.map((j) => [j.id, j]));

function loadRows(tag: string): Row[] {
  const file = path.join(WORK, 'out', tag, 'results.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.rep !== 'warm');
}

const rows = loadRows('container');
const hostRows = loadRows('host');
const rowsOf = new Map<string, Row[]>();
for (const r of rows) rowsOf.set(r.job, [...(rowsOf.get(r.job) ?? []), r]);
const pick = (job: string, renderer: string, rep = 1) => rowsOf.get(job)?.find((r) => r.renderer === renderer && r.rep === rep);
const pngPath = (tag: string, job: string, renderer: string, rep: number) => path.join(WORK, 'out', tag, `${job}.${renderer}.${rep}.png`);
const cache = new Map<string, Rgba>();
function png(tag: string, job: string, renderer: string, rep = 1): Rgba | null {
  const p = pngPath(tag, job, renderer, rep);
  if (cache.has(p)) return cache.get(p)!;
  if (!fs.existsSync(p)) return null;
  const img = readPng(fs.readFileSync(p));
  if (cache.size > 40) cache.clear();
  cache.set(p, img);
  return img;
}

const failed = (r: Row | undefined) => !r || r.status !== 0 || r.signal !== null || r.timedOut || !r.sha256;

function warningKind(stderr: string): string[] {
  const kinds = new Set<string>();
  for (const line of stderr.split('\n').filter(Boolean)) {
    if (/font|glyph|character|Fallback from|usvg::text/i.test(line)) kinds.add('font');
    else if (/image|decode|load|format|href/i.test(line)) kinds.add('decode');
    else kinds.add('other');
  }
  return [...kinds];
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  // Nearest-rank: the smallest value with at least q of the sample at or below it.
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// ---------------------------------------------------------------------------------------------
// Canvases

interface CanvasResult {
  id: string;
  cls: string;
  note?: string;
  rsvgFailed: boolean;
  resvgFailed: boolean;
  rsvgStderr: string;
  resvgStderr: string;
  resvgWarningKinds: string[];
  rsvgWarningKinds: string[];
  ssim: number | null;
  blank: boolean;
  contentRsvg: number | null;
  contentResvg: number | null;
  resvgRepeatIdentical: boolean;
  rsvgRepeatIdentical: boolean;
  hostIdentical: boolean | null;
  msRsvg: number[];
  msResvg: number[];
  rssRsvg: number | null;
  rssResvg: number | null;
  bake?: { boxDelta: number | null; coverageRatio: number | null };
}

const canvases: CanvasResult[] = [];
let done = 0;
for (const job of jobs.filter((j) => j.kind === 'canvas')) {
  const r1 = pick(job.id, 'rsvg', 1);
  const r2 = pick(job.id, 'rsvg', 2);
  const v1 = pick(job.id, 'resvg', 1);
  const v2 = pick(job.id, 'resvg', 2);
  const a = failed(r1) ? null : png('container', job.id, 'rsvg');
  const b = failed(v1) ? null : png('container', job.id, 'resvg');
  const res: CanvasResult = {
    id: job.id,
    cls: job.cls,
    note: job.note,
    rsvgFailed: failed(r1) || failed(r2),
    resvgFailed: failed(v1) || failed(v2),
    rsvgStderr: r1?.stderr ?? '',
    resvgStderr: v1?.stderr ?? '',
    resvgWarningKinds: warningKind(v1?.stderr ?? ''),
    rsvgWarningKinds: warningKind(r1?.stderr ?? ''),
    ssim: null,
    blank: false,
    contentRsvg: null,
    contentResvg: null,
    resvgRepeatIdentical: Boolean(v1?.sha256 && v1.sha256 === v2?.sha256),
    rsvgRepeatIdentical: Boolean(r1?.sha256 && r1.sha256 === r2?.sha256),
    hostIdentical: null,
    msRsvg: [r1, r2].filter((r) => r && !failed(r)).map((r) => r!.ms),
    msResvg: [v1, v2].filter((r) => r && !failed(r)).map((r) => r!.ms),
    rssRsvg: Math.max(r1?.rssKb ?? 0, r2?.rssKb ?? 0) || null,
    rssResvg: Math.max(v1?.rssKb ?? 0, v2?.rssKb ?? 0) || null,
  };
  const host = hostRows.find((h) => h.job === job.id && h.renderer === 'resvg' && h.rep === 1);
  if (host && v1?.sha256) res.hostIdentical = host.sha256 === v1.sha256;
  if (a && b && a.width === b.width && a.height === b.height) {
    res.ssim = ssim(a, b);
    res.contentRsvg = contentShare(a);
    res.contentResvg = contentShare(b);
    // A silent blank: resvg exits 0 but draws far less than rsvg does.
    res.blank = res.contentRsvg > 0.01 && res.contentResvg < 0.5 * res.contentRsvg;
    if (job.cls === 'bake') {
      const ba = inkBox(a);
      const bb = inkBox(b);
      res.bake = {
        boxDelta: ba && bb ? Math.max(Math.abs(ba.left - bb.left), Math.abs(ba.right - bb.right), Math.abs(ba.top - bb.top), Math.abs(ba.bottom - bb.bottom)) : null,
        coverageRatio: ba && bb ? bb.pixels / ba.pixels : null,
      };
    }
  }
  // A canvas where rsvg draws and resvg writes no PNG is counted by resvgFailed (a crash), not as
  // blank: blank is kept for a PNG that exists and is nearly empty.
  canvases.push(res);
  if (++done % 50 === 0) console.log(`canvases ${done}`);
}

// ---------------------------------------------------------------------------------------------
// Lines

interface LineResult {
  id: string;
  parent: string;
  parentCls: string;
  script: 'arabic' | 'latin';
  text: string;
  failed: boolean;
  resvgStderr: string;
  inkRsvg: boolean;
  inkResvg: boolean;
  dLeft: number | null;
  dRight: number | null;
  dTop: number | null;
  dBottom: number | null;
  maxDelta: number | null;
  widthRatio: number | null;
  corr: number | null;
  withinTolerance: boolean;
  wordOrderChanged: boolean;
}

const lines: LineResult[] = [];
for (const job of jobs.filter((j) => j.cls === 'line')) {
  const r = pick(job.id, 'rsvg');
  const v = pick(job.id, 'resvg');
  const parent = byId.get(job.parent!)!;
  const res: LineResult = {
    id: job.id,
    parent: job.parent!,
    parentCls: parent.cls,
    script: job.script!,
    text: job.text ?? '',
    failed: failed(r) || failed(v),
    resvgStderr: v?.stderr ?? '',
    inkRsvg: false,
    inkResvg: false,
    dLeft: null,
    dRight: null,
    dTop: null,
    dBottom: null,
    maxDelta: null,
    widthRatio: null,
    corr: null,
    withinTolerance: false,
    wordOrderChanged: false,
  };
  const a = res.failed ? null : png('container', job.id, 'rsvg');
  const b = res.failed ? null : png('container', job.id, 'resvg');
  if (a && b) {
    const ba = inkBox(a);
    const bb = inkBox(b);
    res.inkRsvg = Boolean(ba);
    res.inkResvg = Boolean(bb);
    if (ba && bb) {
      res.dLeft = bb.left - ba.left;
      res.dRight = bb.right - ba.right;
      res.dTop = bb.top - ba.top;
      res.dBottom = bb.bottom - ba.bottom;
      res.maxDelta = Math.max(Math.abs(res.dLeft), Math.abs(res.dRight), Math.abs(res.dTop), Math.abs(res.dBottom));
      res.widthRatio = (bb.right - bb.left + 1) / (ba.right - ba.left + 1);
      res.corr = profileCorrelation(columnProfile(a), columnProfile(b), ba.left, bb.left).corr;
      res.withinTolerance = res.maxDelta <= (res.script === 'arabic' ? ARABIC_PX : LATIN_PX);
      res.wordOrderChanged = res.corr < WORD_ORDER_CORR;
    }
  }
  lines.push(res);
}
console.log(`lines ${lines.length}`);

// The controls: rsvg's own line against the same line with its words reversed.
const controls: Array<{ id: string; corr: number | null }> = [];
for (const job of jobs.filter((j) => j.cls === 'control')) {
  const a = png('container', job.controlOf!, 'rsvg');
  const c = png('container', job.id, 'rsvg');
  const ba = a && inkBox(a);
  const bc = c && inkBox(c);
  controls.push({ id: job.id, corr: a && c && ba && bc ? profileCorrelation(columnProfile(a), columnProfile(c), ba.left, bc.left).corr : null });
}

// ---------------------------------------------------------------------------------------------
// EXIF: which orientations each renderer turns by itself (exif-raw-N against exif-raw-1)

const exif: Record<string, Record<string, number | null>> = { rsvg: {}, resvg: {} };
for (const renderer of ['rsvg', 'resvg'] as const) {
  const ref = png('container', 'exif-raw-1', renderer);
  for (let o = 1; o <= 8; o++) {
    const img = png('container', `exif-raw-${o}`, renderer);
    exif[renderer][o] = ref && img ? Math.round(ssim(ref, img) * 1000) / 1000 : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Summaries

const renderClasses = [...new Set(canvases.map((c) => c.cls))];
const allMsR = canvases.flatMap((c) => c.msRsvg);
const allMsV = canvases.flatMap((c) => c.msResvg);
const perClass: Record<string, unknown> = {};
for (const cls of renderClasses) {
  const cs = canvases.filter((c) => c.cls === cls);
  const ss = cs.map((c) => c.ssim).filter((s): s is number => s !== null);
  const msR = cs.flatMap((c) => c.msRsvg);
  const msV = cs.flatMap((c) => c.msResvg);
  perClass[cls] = {
    cases: cs.length,
    rsvgFailures: cs.filter((c) => c.rsvgFailed).length,
    resvgFailures: cs.filter((c) => c.resvgFailed).length,
    resvgWarned: cs.filter((c) => c.resvgStderr).length,
    rsvgWarned: cs.filter((c) => c.rsvgStderr).length,
    resvgBlank: cs.filter((c) => c.blank).length,
    ssimMedian: quantile(ss, 0.5),
    ssimMin: ss.length ? Math.min(...ss) : null,
    ssimBelow099: ss.filter((s) => s < 0.99).length,
    ssimBelow097: ss.filter((s) => s < 0.97).length,
    resvgRepeatIdentical: cs.filter((c) => c.resvgRepeatIdentical).length,
    rsvgRepeatIdentical: cs.filter((c) => c.rsvgRepeatIdentical).length,
    msRsvg: { p50: quantile(msR, 0.5), p95: quantile(msR, 0.95), max: Math.max(...msR) },
    msResvg: { p50: quantile(msV, 0.5), p95: quantile(msV, 0.95), max: Math.max(...msV) },
    rssKbRsvgMax: Math.max(...cs.map((c) => c.rssRsvg ?? 0)),
    rssKbResvgMax: Math.max(...cs.map((c) => c.rssResvg ?? 0)),
  };
}

const lineSummary = (sel: LineResult[]) => {
  const measured = sel.filter((l) => l.maxDelta !== null);
  return {
    lines: sel.length,
    failed: sel.filter((l) => l.failed).length,
    inkMissingInResvg: sel.filter((l) => l.inkRsvg && !l.inkResvg).length,
    measured: measured.length,
    withinTolerance: measured.filter((l) => l.withinTolerance).length,
    outsideTolerance: measured.filter((l) => !l.withinTolerance).length,
    maxDeltaMedian: quantile(measured.map((l) => l.maxDelta!), 0.5),
    maxDeltaP95: quantile(measured.map((l) => l.maxDelta!), 0.95),
    maxDeltaMax: measured.length ? Math.max(...measured.map((l) => l.maxDelta!)) : null,
    horizontalShiftMedian: quantile(measured.map((l) => ((l.dLeft ?? 0) + (l.dRight ?? 0)) / 2), 0.5),
    wordOrderFlagged: measured.filter((l) => l.wordOrderChanged).length,
    wordOrderFlaggedAt090: measured.filter((l) => l.corr! < 0.9).length,
    corrMin: measured.length ? Math.min(...measured.map((l) => l.corr!)) : null,
    corrP05: quantile(measured.map((l) => l.corr!), 0.05),
    resvgWarned: sel.filter((l) => l.resvgStderr).length,
  };
};

const warningCatalogue: Record<string, number> = {};
for (const c of canvases) {
  for (const line of c.resvgStderr.split('\n').filter(Boolean)) {
    const key = line.replace(/[^\s]\/U\+[0-9A-F]+/g, '<char>').replace(/\d+/g, 'N').slice(0, 160);
    warningCatalogue[`resvg: ${key}`] = (warningCatalogue[`resvg: ${key}`] ?? 0) + 1;
  }
  for (const line of c.rsvgStderr.split('\n').filter(Boolean)) {
    const key = line.replace(/\d+/g, 'N').slice(0, 160);
    warningCatalogue[`rsvg: ${key}`] = (warningCatalogue[`rsvg: ${key}`] ?? 0) + 1;
  }
}

const gateCanvases = canvases.filter((c) => c.cls !== 'stress');
const ss = gateCanvases.map((c) => c.ssim).filter((s): s is number => s !== null);
const rssRatios = gateCanvases.filter((c) => c.rssRsvg && c.rssResvg).map((c) => c.rssResvg! / c.rssRsvg!);
const summary = {
  generatedAt: new Date().toISOString(),
  canvases: canvases.length,
  gateCanvases: gateCanvases.length,
  lines: lines.length,
  perClass,
  overall: {
    resvgCrashes: gateCanvases.filter((c) => c.resvgFailed).map((c) => c.id),
    rsvgCrashes: canvases.filter((c) => c.rsvgFailed).map((c) => c.id),
    resvgBlank: gateCanvases.filter((c) => c.blank).map((c) => c.id),
    resvgWarnedCanvases: gateCanvases.filter((c) => c.resvgStderr).length,
    resvgWarnedByKind: {
      font: gateCanvases.filter((c) => c.resvgWarningKinds.includes('font')).length,
      decode: gateCanvases.filter((c) => c.resvgWarningKinds.includes('decode')).length,
      other: gateCanvases.filter((c) => c.resvgWarningKinds.includes('other')).length,
    },
    rsvgWarnedCanvases: gateCanvases.filter((c) => c.rsvgStderr).length,
    ssimMedian: quantile(ss, 0.5),
    ssimMin: Math.min(...ss),
    ssimBelow099: ss.filter((s) => s < 0.99).length,
    ssimBelow097: ss.filter((s) => s < 0.97).length,
    resvgRepeatIdentical: `${gateCanvases.filter((c) => c.resvgRepeatIdentical).length}/${gateCanvases.length}`,
    rsvgRepeatIdentical: `${gateCanvases.filter((c) => c.rsvgRepeatIdentical).length}/${gateCanvases.length}`,
    hostVsContainer: hostRows.length
      ? `${canvases.filter((c) => c.hostIdentical === true).length} identical of ${canvases.filter((c) => c.hostIdentical !== null).length} compared`
      : 'not run',
    hostDifferent: canvases.filter((c) => c.hostIdentical === false).map((c) => c.id),
    msRsvg: { p50: quantile(allMsR, 0.5), p95: quantile(allMsR, 0.95), max: Math.max(...allMsR) },
    msResvg: { p50: quantile(allMsV, 0.5), p95: quantile(allMsV, 0.95), max: Math.max(...allMsV) },
    resvgOver5s: gateCanvases.filter((c) => c.msResvg.some((m) => m > 5000)).map((c) => c.id),
    rssKbRsvgMax: Math.max(...gateCanvases.map((c) => c.rssRsvg ?? 0)),
    rssKbResvgMax: Math.max(...gateCanvases.map((c) => c.rssResvg ?? 0)),
    rssRatioPerCaseMedian: quantile(rssRatios, 0.5),
    rssRatioPerCaseMax: Math.max(...rssRatios),
    bakes: canvases
      .filter((c) => c.bake)
      .map((c) => ({ id: c.id, ssim: c.ssim, boxDelta: c.bake!.boxDelta, coverageRatio: c.bake!.coverageRatio })),
  },
  lineSummary: {
    all: lineSummary(lines),
    latin: lineSummary(lines.filter((l) => l.script === 'latin')),
    arabic: lineSummary(lines.filter((l) => l.script === 'arabic')),
    arabicNoResvgWarning: lineSummary(lines.filter((l) => l.script === 'arabic' && !l.resvgStderr)),
    latinNoResvgWarning: lineSummary(lines.filter((l) => l.script === 'latin' && !l.resvgStderr)),
    storedLatin: lineSummary(lines.filter((l) => l.script === 'latin' && l.parentCls === 'stored')),
    storedArabic: lineSummary(lines.filter((l) => l.script === 'arabic' && l.parentCls === 'stored')),
    kurdishMatrix: lineSummary(lines.filter((l) => l.parentCls === 'kurdish')),
    latinMatrix: lineSummary(lines.filter((l) => l.parentCls === 'latin')),
  },
  wordOrderDetector: {
    threshold: WORD_ORDER_CORR,
    controls: controls.length,
    controlsDetected: controls.filter((c) => c.corr !== null && c.corr < WORD_ORDER_CORR).length,
    controlCorrMax: Math.max(...controls.map((c) => c.corr ?? -1)),
    controlCorrMedian: quantile(controls.map((c) => c.corr ?? -1), 0.5),
  },
  exifOrientationSsimAgainstTag1: exif,
  warningCatalogue: Object.fromEntries(Object.entries(warningCatalogue).sort((a, b) => b[1] - a[1])),
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ summary, canvases, lines, controls }, null, 1));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.overall, (k, v) => (k === 'bakes' ? undefined : v), 2));

// ---------------------------------------------------------------------------------------------
// Sheets

function fit(img: Rgba, maxW: number, maxH: number): Rgba {
  const s = Math.min(1, maxW / img.width, maxH / img.height);
  return s === 1 ? img : downscale(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

const lowestDir = path.join(OUT, 'lowest-ssim');
fs.rmSync(lowestDir, { recursive: true, force: true });
fs.mkdirSync(lowestDir, { recursive: true });
const lowest = canvases
  .filter((c) => c.ssim !== null)
  .sort((a, b) => a.ssim! - b.ssim!)
  .slice(0, 30);
lowest.forEach((c, i) => {
  const a = png('container', c.id, 'rsvg')!;
  const b = png('container', c.id, 'resvg')!;
  const panels = [onChecker(a), onChecker(b), diffMap(a, b)].map((p) => fit(p, 320, 400));
  fs.writeFileSync(path.join(lowestDir, `${String(i + 1).padStart(2, '0')}-${c.id}.png`), writePng(hstack(panels)));
});

const kurdishDir = path.join(OUT, 'kurdish-sheet');
fs.rmSync(kurdishDir, { recursive: true, force: true });
fs.mkdirSync(kurdishDir, { recursive: true });
for (const c of canvases.filter((x) => x.cls === 'kurdish')) {
  const a = png('container', c.id, 'rsvg');
  const b = png('container', c.id, 'resvg');
  if (!a || !b) continue;
  fs.writeFileSync(path.join(kurdishDir, `${c.id}.png`), writePng(hstack([fit(a, 540, 675), fit(b, 540, 675)])));
}

// Every line outside tolerance or flagged for word order, rsvg above resvg, grouped into sheets.
const flaggedDir = path.join(OUT, 'flagged-lines');
fs.rmSync(flaggedDir, { recursive: true, force: true });
fs.mkdirSync(flaggedDir, { recursive: true });
const flagged = lines
  .filter((l) => l.maxDelta !== null && (!l.withinTolerance || l.wordOrderChanged))
  .sort((x, y) => (y.maxDelta ?? 0) - (x.maxDelta ?? 0));
for (let s = 0; s < Math.min(flagged.length, 60); s += 12) {
  const panels: Rgba[] = [];
  for (const l of flagged.slice(s, s + 12)) {
    const a = png('container', l.id, 'rsvg');
    const b = png('container', l.id, 'resvg');
    if (!a || !b) continue;
    panels.push(fit(onChecker(a), 1080, 200), fit(onChecker(b), 1080, 200));
  }
  if (panels.length) fs.writeFileSync(path.join(flaggedDir, `sheet-${String(s / 12 + 1).padStart(2, '0')}.png`), writePng(vstack(panels, 6)));
}
fs.writeFileSync(
  path.join(flaggedDir, 'index.json'),
  JSON.stringify(
    flagged.slice(0, 60).map((l, i) => ({ sheet: Math.floor(i / 12) + 1, row: (i % 12) + 1, id: l.id, script: l.script, text: l.text, maxDelta: l.maxDelta, dLeft: l.dLeft, dRight: l.dRight, dTop: l.dTop, dBottom: l.dBottom, corr: l.corr })),
    null,
    1
  )
);
console.log(`sheets written to ${OUT}`);
