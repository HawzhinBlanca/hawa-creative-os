#!/usr/bin/env node
/**
 * Renders every job of the resvg gate with rsvg-convert and with the resvg CLI, one process at a
 * time, and records per render: exit status, stderr (warnings), wall time, peak RSS and the PNG's
 * hash. Plain Node, no dependencies, so it runs inside the measurement image (Node 22) as well as on
 * the Mac.
 *
 *   node render.mjs --work /work --tag container [--renderers rsvg,resvg] [--resvg /usr/local/bin/resvg]
 *        [--rsvg rsvg-convert] [--time /usr/bin/time] [--canvas-reps 2] [--kinds canvas,line]
 *
 * Each canvas is rendered --canvas-reps times by each renderer, the renderers interleaved, so both
 * see the same machine load; the repeats give the determinism check and the timing sample. Lines
 * are rendered once each.
 *
 * rsvg-convert is called as production calls it (render-layout-v2.ts svgToPngAsync): -w -h -f png,
 * FONTCONFIG_FILE set to the bundled fonts.conf. resvg is called as ADR-036 section 2.4 would:
 * --skip-system-fonts, every font file with --use-font-file in the fixed order below, and
 * --resources-dir the SVG's own folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = {
  work: '/work',
  tag: 'container',
  renderers: ['rsvg', 'resvg'],
  resvg: '/usr/local/bin/resvg',
  rsvg: 'rsvg-convert',
  time: '/usr/bin/time',
  canvasReps: 2,
  kinds: ['canvas', 'line'],
  fontconfig: '/app/packages/creative/assets/fonts/fonts.conf',
  timeoutMs: 60000,
  only: '',
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const v = argv[++i];
  if (a === '--work') args.work = v;
  else if (a === '--tag') args.tag = v;
  else if (a === '--renderers') args.renderers = v.split(',');
  else if (a === '--resvg') args.resvg = v;
  else if (a === '--rsvg') args.rsvg = v;
  else if (a === '--time') args.time = v;
  else if (a === '--canvas-reps') args.canvasReps = Number(v);
  else if (a === '--kinds') args.kinds = v.split(',');
  else if (a === '--fontconfig') args.fontconfig = v;
  else if (a === '--only') args.only = v;
  else throw new Error(`unknown argument ${a}`);
}

// The fixed font order: the families of packages/creative/src/studio/render-fonts.json in the
// order that file lists them, each family's faces regular first, then Inter (bundled, admitted by
// the renderer's own list) and DejaVu Sans, the image's default face, last as the fallback.
const FONT_ORDER = [
  'Verdana.ttf',
  'Verdana_Bold.ttf',
  'Verdana_Italic.ttf',
  'Verdana_Bold_Italic.ttf',
  'NotoSansArabic-Regular.ttf',
  'NotoSansArabic-Bold.ttf',
  'Cinzel-SemiBold.ttf',
  'Cinzel-Bold.ttf',
  'PlayfairDisplay-Bold.ttf',
  'PlayfairDisplay-Italic.ttf',
  'Amiri-Regular.ttf',
  'Amiri-Bold.ttf',
  'IBMPlexSansArabic-Regular.ttf',
  'IBMPlexSansArabic-Bold.ttf',
  'Cairo-Regular.ttf',
  'PlusJakartaSans-Regular.ttf',
  'PlusJakartaSans-Bold.ttf',
  'Vazirmatn-Regular.ttf',
  'Vazirmatn-Bold.ttf',
  'Inter-Regular.ttf',
  'DejaVuSans.ttf',
  'DejaVuSans-Bold.ttf',
];
const fontArgs = FONT_ORDER.flatMap((f) => ['--use-font-file', path.join(args.work, 'fonts', f)]);
for (const f of FONT_ORDER) if (!fs.existsSync(path.join(args.work, 'fonts', f))) throw new Error(`missing font ${f}`);

const jobs = JSON.parse(fs.readFileSync(path.join(args.work, 'jobs.json'), 'utf8')).filter((j) => args.kinds.includes(j.kind) && (!args.only || new RegExp(args.only).test(j.id)));
const outDir = path.join(args.work, 'out', args.tag);
fs.mkdirSync(outDir, { recursive: true });
const resultsFile = path.join(outDir, 'results.jsonl');
fs.writeFileSync(resultsFile, '');

function commandFor(renderer, job, png) {
  const dir = path.join(args.work, 'cases', job.dir);
  const svg = path.join(dir, job.svg);
  if (renderer === 'rsvg') {
    return { bin: args.rsvg, argv: ['-w', String(job.width), '-h', String(job.height), '-f', 'png', '-o', png, svg], env: { ...process.env, FONTCONFIG_FILE: args.fontconfig } };
  }
  return {
    bin: args.resvg,
    argv: ['--skip-system-fonts', ...fontArgs, '--resources-dir', dir, '-w', String(job.width), '-h', String(job.height), svg, png],
    env: process.env,
  };
}

/** GNU time -v's block, which it appends to the command's own stderr. */
function splitTime(stderr) {
  const at = stderr.search(/(Command exited with non-zero status \d+\n)?\tCommand being timed:/);
  if (at < 0) return { own: stderr, rssKb: null };
  const block = stderr.slice(at);
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(block);
  return { own: stderr.slice(0, at), rssKb: rss ? Number(rss[1]) : null };
}

function render(renderer, job, rep) {
  const png = path.join(outDir, `${job.id}.${renderer}.${rep}.png`);
  fs.rmSync(png, { force: true });
  const cmd = commandFor(renderer, job, png);
  const useTime = args.time !== 'none' && job.kind === 'canvas';
  const bin = useTime ? args.time : cmd.bin;
  const argvFull = useTime ? ['-v', cmd.bin, ...cmd.argv] : cmd.argv;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(bin, argvFull, { env: cmd.env, timeout: args.timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  const { own, rssKb } = useTime ? splitTime(stderr) : { own: stderr, rssKb: null };
  const exists = fs.existsSync(png);
  const bytes = exists ? fs.readFileSync(png) : null;
  const row = {
    job: job.id,
    renderer,
    rep,
    status: r.status,
    signal: r.signal,
    timedOut: r.error?.code === 'ETIMEDOUT',
    ms: Math.round(ms * 10) / 10,
    rssKb,
    stderr: own.trim().slice(0, 2000),
    pngBytes: bytes ? bytes.length : 0,
    sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
  };
  fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
  return row;
}

// Warm-up: fontconfig's cache and the page cache, so the first timed render is not an outlier.
if (jobs.length) for (const r of args.renderers) render(r, jobs[0], 'warm');

const started = Date.now();
let n = 0;
for (const job of jobs) {
  const reps = job.kind === 'canvas' ? args.canvasReps : 1;
  const renderers = args.renderers.filter((r) => job.renderers.includes(r));
  for (let rep = 1; rep <= reps; rep++) for (const r of renderers) render(r, job, rep);
  n++;
  if (n % 100 === 0) console.log(`${n}/${jobs.length} jobs, ${Math.round((Date.now() - started) / 1000)} s`);
}
console.log(`done: ${n} jobs in ${Math.round((Date.now() - started) / 1000)} s -> ${resultsFile}`);
