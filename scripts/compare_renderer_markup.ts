#!/usr/bin/env tsx
/**
 * Renders the same designs with the renderer as it was and as it is, and compares the pixels, on the
 * host's rsvg-convert and on the production core image's (ADR-036 section 2.1, PLAN 0.5).
 *
 *   npx tsx scripts/compare_renderer_markup.ts --base <dir> [--image <docker image>] [--runs <runDir> ...]
 *       [--out <dir>] [--limit <n>] [--timing]
 *
 * --base   a folder holding the old renderer's sources at packages/creative/src (for example
 *          `git archive -o base.tar <commit> packages/creative/src` unpacked there). Placed under
 *          packages/creative/ so its imports resolve against the package's node_modules.
 * --image  the production core image to rasterise in as well (read-only `docker run`); omitted, the
 *          host only.
 * --runs   stored qualification runs (folders with briefs/<id>/layout.json and brief.json). The
 *          committed fixture designs are always included.
 * --timing also time the full-size logo against the pre-scaled one.
 *
 * What it proves, per design and per rasteriser:
 *   old         today's markup (whitespace between tspans, direction="rtl", the logo scaled in place)
 *   stripped    the old SVG with only the whitespace inside <text> removed
 *   new         the renderer now
 * `new` must equal `stripped` pixel for pixel outside the logo box, so every difference between `new`
 * and `old` is either a line the whitespace fix moved (it differs between `old` and `stripped` too) or
 * the logo; logo differences are counted separately. Kurdish lines aligned right, centre and left,
 * with Latin and digits in them, are rendered the same way.
 *
 * The prepared layouts come from the current preparation in every production mode (plain, ornament,
 * each committed style reference), exactly as scripts/proofs/reprepare_stored_runs.mjs builds them.
 * No model calls. Exits 1 when any design differs where it must not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as creative from '../packages/creative/src/index.js';
import * as fresh from '../packages/creative/src/studio/render-layout-v2.js';
import { inlineSvgFiles } from '../packages/creative/src/studio/svg-files.js';
// pngjs is a dependency of the creative package, not of the root; the renderer re-exports it.
const { PNG } = fresh;
import type { StudioLayoutV2 } from '../packages/creative/src/studio/layout-v2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.join(ROOT, 'packages/creative/assets/fonts');
const IMAGE_FONTCONFIG = '/app/packages/creative/assets/fonts/fonts.conf';
const ARABIC = /[\u0600-\u06FF]/;

interface Args {
  base: string;
  image?: string;
  runs: string[];
  out: string;
  limit: number;
  timing: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { base: '', runs: [], out: path.join(ROOT, 'output/renderer-markup-compare'), limit: Infinity, timing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = path.resolve(argv[++i]);
    else if (a === '--image') args.image = argv[++i];
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--timing') args.timing = true;
    else if (a === '--runs') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.runs.push(path.resolve(argv[++i]));
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!args.base) throw new Error('--base <dir with packages/creative/src of the old renderer> is required');
  return args;
}

interface Design {
  id: string;
  layout: StudioLayoutV2;
  copy: Record<number, string>;
}

/** The committed fixture designs and every stored design of the given runs, raw (before preparation). */
function rawDesigns(runs: string[]): Array<{ id: string; layout: StudioLayoutV2; blocks: string[] }> {
  const out: Array<{ id: string; layout: StudioLayoutV2; blocks: string[] }> = [];
  const fixtures = path.join(ROOT, 'packages/creative/test/fixtures');
  const ref = JSON.parse(fs.readFileSync(path.join(fixtures, 'reference-k12-89c242f2.json'), 'utf8'));
  (ref.layouts as StudioLayoutV2[]).forEach((layout, i) => {
    for (const lang of ['ckb', 'en'] as const) out.push({ id: `fixture:reference-${lang}-${i}`, layout, blocks: ref.copy[lang] });
  });
  for (const name of ['cheap-tier-dead-band-8fb76534.json', 'cheap-tier-overflow-1f392e16.json', 'cheap-tier-stroke-slab-brief_08.json']) {
    const f = JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
    out.push({ id: `fixture:${name.replace('.json', '')}`, layout: f.layout, blocks: f.copy });
  }
  for (const run of runs) {
    const briefs = path.join(run, 'briefs');
    if (!fs.existsSync(briefs)) continue;
    for (const id of fs.readdirSync(briefs).sort()) {
      const layoutPath = path.join(briefs, id, 'layout.json');
      const briefPath = path.join(briefs, id, 'brief.json');
      if (!fs.existsSync(layoutPath) || !fs.existsSync(briefPath)) continue;
      const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
      const blocks: string[] = [];
      for (const b of brief.copyBlocks) blocks[b.copyIndex] = b.text;
      out.push({ id: `${path.basename(run)}:${id}`, layout: JSON.parse(fs.readFileSync(layoutPath, 'utf8')), blocks });
    }
  }
  return out;
}

/** Each raw design prepared in each production mode, as the layouts stage prepares it. */
async function preparedDesigns(runs: string[], limit: number): Promise<Design[]> {
  // @ts-ignore -- a plain .mjs proof script with no type declarations
  const gate = await import('./proofs/reprepare_stored_runs.mjs');
  const reference = creative.studioReferenceFromRaw(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/creative/assets/kaae-reference.json'), 'utf8'))
  );
  const logoPng = fs.readFileSync(path.join(ROOT, 'packages/creative/assets/logos/kaae-official-logo.png'));
  const logoAspect = logoPng.readUInt32BE(16) / (logoPng.readUInt32BE(20) || 1);
  const modes = gate.productionModes(creative) as Array<{ name: string; options: Record<string, unknown> }>;
  const out: Design[] = [];
  for (const raw of rawDesigns(runs)) {
    if (out.length >= limit) break;
    const text: Record<number, string> = {};
    const scripts: Record<number, 'arabic' | 'latin'> = {};
    raw.blocks.forEach((t, i) => {
      text[i] = t;
      scripts[i] = ARABIC.test(t) ? 'arabic' : 'latin';
    });
    for (const mode of modes) {
      const layout = creative.prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(raw.layout)), { text, scripts }, {
        width: raw.layout.width,
        height: raw.layout.height,
        logoAspect,
        palette: reference.palette,
        ...mode.options,
      } as any);
      out.push({ id: `${raw.id}@${mode.name}`, layout, copy: text });
    }
  }
  return out;
}

/** Kurdish lines with Latin and digits, right, centre and left aligned, in both Kurdish faces. */
function kurdishLineDesigns(): Design[] {
  const copy = {
    0: 'دەستەی متمانەپێدانی کوردستان بۆ پەروەردە KAAE ٢٠٢٦ و ساڵی 2026 لە هەولێر',
    1: 'کۆنفرانسی نێودەوڵەتی Quality Assurance ٣ی تشرینی یەکەم',
  };
  const out: Design[] = [];
  for (const family of ['Noto Sans Arabic', 'IBM Plex Sans Arabic']) {
    for (const align of ['right', 'center', 'left'] as const) {
      out.push({
        id: `kurdish:${family}:${align}`,
        copy,
        layout: {
          version: 2,
          width: 1080,
          height: 1080,
          grid: { margin: 72, columns: 6, gutter: 24, baseline: 8 },
          background: { color: '#0A1628' },
          shapes: [],
          logo: { x: 72, y: 72, width: 120, height: 120 },
          text: [
            { copyIndex: 0, role: 'title', x: 140, y: 260, width: 800, height: 320, fontSize: 56, lineHeight: 1.4, fontFamily: family, color: '#FFFFFF', align, bold: true, rtl: true },
            { copyIndex: 1, role: 'body', x: 140, y: 640, width: 800, height: 200, fontSize: 34, lineHeight: 1.5, fontFamily: family, color: '#F7B500', align, rtl: true },
          ],
        } as unknown as StudioLayoutV2,
      });
    }
  }
  return out;
}

/** The old SVG with only the character data between tspans (and just inside <text>) removed. */
function stripTextWhitespace(svg: string): string {
  return svg.replace(/(<text\b[^>]*>)([\s\S]*?)(<\/text>)/g, (_m, open: string, body: string, close: string) => {
    return open + body.replace(/^\s+/, '').replace(/\s+$/, '').replace(/>\s+</g, '><') + close;
  });
}

interface Rasteriser {
  name: string;
  render(svgFile: string, width: number, height: number): Buffer;
  close(): void;
}

function hostRasteriser(): Rasteriser {
  const bin = fs.existsSync('/opt/homebrew/bin/rsvg-convert') ? '/opt/homebrew/bin/rsvg-convert' : 'rsvg-convert';
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  return {
    name: `host ${version}`,
    render(svgFile, width, height) {
      const r = spawnSync(bin, ['-w', String(width), '-h', String(height), '-f', 'png', svgFile], {
        env: { ...process.env, FONTCONFIG_FILE: path.join(FONTS, 'fonts.conf') },
        maxBuffer: 256 * 1024 * 1024,
      });
      if (r.status !== 0) throw new Error(`host rsvg failed: ${r.stderr}`);
      return r.stdout;
    },
    close() {},
  };
}

/** A throwaway container of the production image, used only to run its rsvg-convert. */
function imageRasteriser(image: string, mountDir: string): Rasteriser {
  const name = `hawa-p05-compare-${process.pid}`;
  const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-v', `${mountDir}:/w:ro`, '--entrypoint', 'sleep', image, '7200'], { encoding: 'utf8' });
  if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);
  const version = spawnSync('docker', ['exec', name, 'rsvg-convert', '--version'], { encoding: 'utf8' }).stdout.split('\n')[0];
  return {
    name: `image ${image} ${version}`,
    render(svgFile, width, height) {
      const inside = `/w/${path.relative(mountDir, svgFile)}`;
      const r = spawnSync('docker', ['exec', '-e', `FONTCONFIG_FILE=${IMAGE_FONTCONFIG}`, name, 'rsvg-convert', '-w', String(width), '-h', String(height), '-f', 'png', inside], {
        maxBuffer: 256 * 1024 * 1024,
      });
      if (r.status !== 0) throw new Error(`image rsvg failed: ${r.stderr}`);
      return r.stdout;
    },
    close() {
      spawnSync('docker', ['kill', name]);
    },
  };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixels that differ at all, each marked with its largest channel difference. */
function diffMask(a: Buffer, b: Buffer): { width: number; height: number; mask: Uint8Array; count: number } {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) throw new Error('size mismatch');
  const mask = new Uint8Array(pa.width * pa.height);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (pa.data[o] !== pb.data[o] || pa.data[o + 1] !== pb.data[o + 1] || pa.data[o + 2] !== pb.data[o + 2] || pa.data[o + 3] !== pb.data[o + 3]) {
      mask[i] = Math.max(1, Math.abs(pa.data[o] - pb.data[o]), Math.abs(pa.data[o + 1] - pb.data[o + 1]), Math.abs(pa.data[o + 2] - pb.data[o + 2]), Math.abs(pa.data[o + 3] - pb.data[o + 3]));
      count++;
    }
  }
  return { width: pa.width, height: pa.height, mask, count };
}

const inBox = (i: number, width: number, box?: Box) => {
  if (!box) return false;
  const x = i % width;
  const y = Math.floor(i / width);
  return x >= Math.floor(box.x) - 1 && x <= Math.ceil(box.x + box.width) + 1 && y >= Math.floor(box.y) - 1 && y <= Math.ceil(box.y + box.height) + 1;
};

interface Row {
  id: string;
  rasteriser: string;
  newVsOld: number;
  newVsStripped: number;
  newVsStrippedOutsideLogo: number;
  newVsStrippedInLogo: number;
  logoMaxDelta: number;
  whitespaceMoved: number;
  unexplained: number;
  blocksMoved: number;
  noTextVsOldOutsideLogo: number;
  noTextInLogo: number;
}

/** The logo image element's href, when the SVG draws a pre-scaled PNG in it. */
function logoHref(svg: string): string | undefined {
  return /<image id="logo" xlink:href="(data:image\/png;base64,[^"]+)"[^>]*preserveAspectRatio="none"/.exec(svg)?.[1];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const oldModulePath = path.join(args.base, 'packages/creative/src/studio/render-layout-v2.ts');
  if (!fs.existsSync(oldModulePath)) throw new Error(`no old renderer at ${oldModulePath}`);
  const old = (await import(pathToFileURL(oldModulePath).href)) as typeof fresh;

  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });
  const rasterisers: Rasteriser[] = [hostRasteriser()];
  if (args.image) rasterisers.push(imageRasteriser(args.image, args.out));

  const designs = [...kurdishLineDesigns(), ...(await preparedDesigns(args.runs, args.limit))];
  console.log(`designs: ${designs.length} (${kurdishLineDesigns().length} Kurdish line sets; the rest stored designs x production modes)`);
  for (const r of rasterisers) console.log(`rasteriser: ${r.name}`);

  const rows: Row[] = [];
  // The production image scales the logo with its own rsvg, so its pre-scaled PNG is made there too.
  const imageLogos = new Map<string, string>();
  try {
    let n = 0;
    for (const d of designs) {
      n++;
      const opts = { copyText: d.copy };
      // A renderer from ADR-035 on reads its pictures as files beside the SVG; the markup compared
      // and the SVGs rasterised here are written alone, so the pictures are put back inline.
      const self = (r: { svg: string; noTextSvg: string; files?: Record<string, Buffer> }) => ({
        svg: inlineSvgFiles(r.svg, r.files),
        noTextSvg: inlineSvgFiles(r.noTextSvg, r.files),
      });
      const o = self(old.renderLayoutV2ToSvg(d.layout, opts));
      const f = self(fresh.renderLayoutV2ToSvg(d.layout, opts));
      const stripped = stripTextWhitespace(o.svg);
      const slug = String(n).padStart(3, '0');
      const files: Record<string, string> = {};
      const write = (name: string, svg: string) => {
        const file = path.join(args.out, `${slug}-${name}.svg`);
        fs.writeFileSync(file, svg);
        files[name] = file;
      };
      write('old', o.svg);
      write('stripped', stripped);
      write('new', f.svg);
      write('old-notext', o.noTextSvg);
      write('new-notext', f.noTextSvg);

      for (const r of rasterisers) {
        let newFile = files.new;
        let newNoTextFile = files['new-notext'];
        const href = logoHref(f.svg);
        if (href && r !== rasterisers[0] && d.layout.logo) {
          const box = d.layout.logo;
          const key = `${box.width}x${box.height}`;
          if (!imageLogos.has(key)) {
            const w = Math.max(1, Math.round(box.width));
            const h = Math.max(1, Math.round(box.height));
            const logoFile = path.join(args.out, 'logo.png');
            fs.copyFileSync(path.join(ROOT, 'packages/creative/assets/logos/kaae-official-logo.png'), logoFile);
            const job = path.join(args.out, `logo-${key}.svg`);
            fs.writeFileSync(
              job,
              `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${box.width} ${box.height}">` +
                `<image xlink:href="logo.png" x="0" y="0" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid meet"/></svg>`
            );
            imageLogos.set(key, `data:image/png;base64,${r.render(job, w, h).toString('base64')}`);
          }
          const swap = (svg: string) => svg.split(href).join(imageLogos.get(key)!);
          newFile = path.join(args.out, `${slug}-new-image.svg`);
          newNoTextFile = path.join(args.out, `${slug}-new-notext-image.svg`);
          fs.writeFileSync(newFile, swap(f.svg));
          fs.writeFileSync(newNoTextFile, swap(f.noTextSvg));
        }
        const w = d.layout.width;
        const h = d.layout.height;
        const pOld = r.render(files.old, w, h);
        const pStripped = r.render(files.stripped, w, h);
        const pNew = r.render(newFile, w, h);
        const pOldNoText = r.render(files['old-notext'], w, h);
        const pNewNoText = r.render(newNoTextFile, w, h);

        const logo = d.layout.logo as Box | undefined;
        const nvo = diffMask(pNew, pOld);
        const nvs = diffMask(pNew, pStripped);
        const ovs = diffMask(pOld, pStripped);
        const nt = diffMask(pNewNoText, pOldNoText);
        let outsideLogo = 0;
        let logoMaxDelta = 0;
        let inLogo = 0;
        let unexplained = 0;
        for (let i = 0; i < nvs.mask.length; i++) {
          if (nvs.mask[i]) {
            if (inBox(i, nvs.width, logo)) {
              inLogo++;
              logoMaxDelta = Math.max(logoMaxDelta, nvs.mask[i]);
            }
            else outsideLogo++;
          }
          // A pixel the new render changed that the whitespace strip did not change and that is not the logo.
          if (nvo.mask[i] && !ovs.mask[i] && !inBox(i, nvo.width, logo)) unexplained++;
        }
        let ntOutside = 0;
        let ntIn = 0;
        for (let i = 0; i < nt.mask.length; i++) if (nt.mask[i]) (inBox(i, nt.width, logo) ? ntIn++ : ntOutside++);
        // Blocks the whitespace fix moved: text boxes (widened by a line's worth) where old and stripped differ.
        let blocksMoved = 0;
        for (const t of d.layout.text) {
          const pad = t.fontSize;
          const box = { x: t.x - pad, y: t.y - pad, width: t.width + 2 * pad, height: t.height + 2 * pad };
          let moved = false;
          for (let i = 0; i < ovs.mask.length && !moved; i++) if (ovs.mask[i] && inBox(i, ovs.width, box)) moved = true;
          if (moved) blocksMoved++;
        }
        rows.push({
          id: d.id,
          rasteriser: r.name,
          newVsOld: nvo.count,
          newVsStripped: nvs.count,
          newVsStrippedOutsideLogo: outsideLogo,
          newVsStrippedInLogo: inLogo,
          logoMaxDelta,
          whitespaceMoved: ovs.count,
          unexplained,
          blocksMoved,
          noTextVsOldOutsideLogo: ntOutside,
          noTextInLogo: ntIn,
        });
      }
      if (n % 10 === 0) console.log(`  ${n}/${designs.length}`);
    }
  } finally {
    for (const r of rasterisers) r.close();
  }

  const report: Record<string, unknown> = { base: args.base, designs: designs.length, rows };
  let failed = 0;
  for (const r of rasterisers) {
    const mine = rows.filter((row) => row.rasteriser === r.name);
    const sum = (k: keyof Row) => mine.reduce((s, row) => s + (row[k] as number), 0);
    const bad = mine.filter((row) => row.newVsStrippedOutsideLogo > 0 || row.unexplained > 0 || row.noTextVsOldOutsideLogo > 0);
    failed += bad.length;
    const summary = {
      rasteriser: r.name,
      designs: mine.length,
      identicalToOld: mine.filter((row) => row.newVsOld === 0).length,
      differOnlyByWhitespaceFixOrLogo: mine.filter((row) => row.newVsOld > 0 && row.newVsStrippedOutsideLogo === 0 && row.unexplained === 0).length,
      newEqualsStrippedOutsideLogo: mine.filter((row) => row.newVsStrippedOutsideLogo === 0).length,
      designsWithLogoPixelsChanged: mine.filter((row) => row.newVsStrippedInLogo > 0).length,
      logoPixelsChanged: sum('newVsStrippedInLogo'),
      logoLargestChannelDifference: Math.max(0, ...mine.map((row) => row.logoMaxDelta)),
      blocksMovedByWhitespaceFix: sum('blocksMoved'),
      pixelsMovedByWhitespaceFix: sum('whitespaceMoved'),
      kurdishLineSets: mine
        .filter((row) => row.id.startsWith('kurdish:'))
        .map((row) => `${row.id}: new vs old ${row.newVsOld} px, new vs stripped ${row.newVsStripped} px (logo ${row.newVsStrippedInLogo})`),
      failures: bad.map((row) => row.id),
    };
    report[r.name] = summary;
    console.log(JSON.stringify(summary, null, 2));
  }

  if (args.timing) report.timing = await timeLogo(old, args);
  fs.writeFileSync(path.join(args.out, 'REPORT.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${path.join(args.out, 'REPORT.json')}`);
  if (failed) {
    console.error(`${failed} design renders differ where the change must not move anything`);
    process.exit(1);
  }
}

/** Median time of one full render with the logo scaled in place (old) and pre-scaled (new). */
async function timeLogo(old: typeof fresh, args: Args) {
  const layout = kurdishLineDesigns()[0].layout;
  const copy = kurdishLineDesigns()[0].copy;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const time = async (fn: () => Promise<unknown>, n = 15) => {
    await fn();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = process.hrtime.bigint();
      await fn();
      out.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return median(out);
  };
  const oldMs = await time(() => old.renderLayoutV2Async(layout, { copyText: copy }));
  const newMs = await time(() => fresh.renderLayoutV2Async(layout, { copyText: copy }));
  const result: Record<string, number | string> = { hostOldRenderMs: oldMs, hostNewRenderMs: newMs, hostSavedMs: oldMs - newMs };

  if (args.image) {
    // Rasterisation alone inside the production image: the old and new SVG of one design, timed by
    // node in the container so docker's own start-up is not in the numbers.
    const dir = path.join(args.out, 'timing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.svg'), old.renderLayoutV2ToSvg(layout, { copyText: copy }).svg);
    const prescaledOnHost = fresh.renderLayoutV2ToSvg(layout, { copyText: copy }).svg;
    fs.writeFileSync(path.join(dir, 'new.svg'), prescaledOnHost);
    fs.writeFileSync(
      path.join(dir, 'time.mjs'),
      `import { execFileSync } from 'node:child_process';\n` +
        `const env = { ...process.env, FONTCONFIG_FILE: '${IMAGE_FONTCONFIG}' };\n` +
        `const run = (f) => execFileSync('rsvg-convert', ['-w', '1080', '-h', '1080', '-f', 'png', f], { env, maxBuffer: 1 << 28 });\n` +
        `const med = (f) => { run(f); const xs = []; for (let i = 0; i < 15; i++) { const t = process.hrtime.bigint(); run(f); xs.push(Number(process.hrtime.bigint() - t) / 1e6); } xs.sort((a, b) => a - b); return xs[7]; };\n` +
        `console.log(JSON.stringify({ old: med('/w/old.svg'), new: med('/w/new.svg') }));\n`
    );
    const r = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/w:ro`, '--entrypoint', 'node', args.image, '/w/time.mjs'], { encoding: 'utf8' });
    if (r.status === 0) {
      const t = JSON.parse(r.stdout.trim());
      result.imageOldRasteriseMs = t.old;
      result.imageNewRasteriseMs = t.new;
      result.imageSavedPerRasteriseMs = t.old - t.new;
      result.imageSavedPerRenderMs = 2 * (t.old - t.new);
      result.note = 'a render rasterises twice (the design and its no-text composite)';
    } else {
      result.imageError = r.stderr.slice(0, 400);
    }
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
