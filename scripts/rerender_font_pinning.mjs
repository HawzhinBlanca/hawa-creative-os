#!/usr/bin/env node
/**
 * Before/after evidence for the font pinning (ADR-036 follow-up to Phase 0.5): static Inter faces, a
 * generated fontconfig that lists only the repo's fonts, pango on its fontconfig backend, and font
 * fidelity judged per script. Plain JavaScript so it runs with the node inside the production core
 * image, against whichever build of @hawa/creative is at --creative.
 *
 *   node scripts/rerender_font_pinning.mjs fonts   --creative <pkg dir> --out <file.json>
 *   node scripts/rerender_font_pinning.mjs render  --creative <pkg dir> --runs <run dir>... --out <dir>
 *                                                  [--limit <n>] [--modes plain,ornament]
 *   node scripts/rerender_font_pinning.mjs compare --creative <pkg dir> --before <dir> --after <dir> --out <file.json>
 *
 * fonts    the ink check per admitted family and script, and Inter at 24, 40, 60 and 96 px.
 * render   every stored layout (briefs/<id>/layout.json + brief.json) prepared as the layouts stage
 *          prepares it, in each mode, plus built designs for what the stored runs never use (Inter at
 *          display and text sizes, a Kurdish Vazirmatn block); writes <id>.png and manifest.json.
 * compare  per design: the pixels that differ (any channel by more than 5), and for each text block
 *          the differing pixels inside its box; the wrap counts before and after. Changes outside
 *          every text box are reported separately, because the fonts should move nothing else.
 *
 * In the image (read-only; the "after" build mounted over the image's own package):
 *   docker run --rm -v "$PWD/scripts:/s:ro" -v <runs>:/runs:ro -v <out>:/out <image> \
 *     node /s/rerender_font_pinning.mjs render --creative /app/packages/creative --runs /runs/<run> --out /out/before
 *   docker run --rm -v "$PWD/packages/creative/dist:/app/packages/creative/dist:ro" \
 *     -v "$PWD/packages/creative/src:/app/packages/creative/src:ro" \
 *     -v "$PWD/packages/creative/assets:/app/packages/creative/assets:ro" ... --out /out/after
 * No model calls, no database, no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ARABIC = /[؀-ۿ]/;

function parseArgs(argv) {
  const args = { mode: argv[0], runs: [], limit: Infinity, modes: ['plain', 'ornament'] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--creative') args.creative = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--before') args.before = path.resolve(argv[++i]);
    else if (a === '--after') args.after = path.resolve(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--modes') args.modes = argv[++i].split(',');
    else if (a === '--runs') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.runs.push(path.resolve(argv[++i]));
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!['fonts', 'render', 'compare'].includes(args.mode)) throw new Error('mode must be fonts, render or compare');
  if (!args.creative || !args.out) throw new Error('--creative and --out are required');
  return args;
}

async function loadCreative(dir) {
  const index = await import(pathToFileURL(path.join(dir, 'dist/index.js')).href);
  const renderer = await import(pathToFileURL(path.join(dir, 'dist/studio/render-layout-v2.js')).href);
  return { ...index, ...renderer };
}

function fontsReport(creative) {
  const families = [...creative.ADMITTED_FONT_FAMILIES];
  const out = { perScript: {}, fidelity: {}, inter: [] };
  for (const family of families) {
    out.fidelity[family] = creative.probeFontFidelity(family);
    out.perScript[family] = {};
    for (const script of ['latin', 'arabic']) {
      // The old build has no per-script probe; its ink check picks a sample itself (Kurdish if covered).
      const check = creative.probeFontScripts
        ? creative.probeFontScripts(family)[script].ink
        : script === 'arabic' ? creative.probeFontInkWidth(family) : null;
      const verdict = creative.probeFontScripts ? creative.probeFontScripts(family)[script].verdict : undefined;
      out.perScript[family][script] = check && {
        verdict,
        measured: check.measured,
        sample: check.sample,
        renderedInkPx: check.renderedInkPx,
        expectedInkPx: Number(check.expectedInkPx.toFixed(1)),
        deviationPct: Number((check.deviation * 100).toFixed(2)),
        sameAsSentinel: check.sameAsSentinel,
        fontFile: check.fontFile,
      };
    }
  }
  for (const sizePx of [24, 40, 60, 96]) {
    const check = creative.probeFontInkWidth('Inter', { sizePx, script: 'latin' });
    // An old build ignores sizePx and always draws at 60 px; say which size was really drawn.
    out.inter.push({
      askedPx: sizePx,
      drawnPx: check.sizePx ?? 60,
      renderedInkPx: check.renderedInkPx,
      expectedInkPx: Number(check.expectedInkPx.toFixed(1)),
      deviationPct: Number((check.deviation * 100).toFixed(2)),
    });
  }
  return out;
}

function storedDesigns(runs) {
  const out = [];
  for (const run of runs) {
    const briefs = path.join(run, 'briefs');
    if (!fs.existsSync(briefs)) continue;
    for (const id of fs.readdirSync(briefs).sort()) {
      const layoutPath = path.join(briefs, id, 'layout.json');
      const briefPath = path.join(briefs, id, 'brief.json');
      if (!fs.existsSync(layoutPath) || !fs.existsSync(briefPath)) continue;
      const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
      const text = {};
      const scripts = {};
      for (const b of brief.copyBlocks) {
        text[b.copyIndex] = b.text;
        scripts[b.copyIndex] = b.script || (ARABIC.test(b.text) ? 'arabic' : 'latin');
      }
      out.push({ id: `${path.basename(run)}__${id}`, layout: JSON.parse(fs.readFileSync(layoutPath, 'utf8')), text, scripts });
    }
  }
  return out;
}

/**
 * What the stored runs never draw: Inter at text and display sizes, a Kurdish Vazirmatn block, and
 * contact and list lines with the symbols the copy gate admits (☎ ✉ ✈ ✔ ➤ …), which the image drew
 * from fonts-dejavu-core and the pinned set draws from the HawaSymbols faces.
 */
function builtDesigns() {
  const block = (copyIndex, y, fontSize, fontFamily, align, extra = {}) => ({
    copyIndex, role: 'body', x: 90, y, width: 900, height: fontSize * 1.6, fontSize, lineHeight: 1.2,
    fontFamily, color: '#111111', align, ...extra,
  });
  const base = (text) => ({
    version: 2, width: 1080, height: 1080,
    grid: { margin: 72, columns: 6, gutter: 24, baseline: 8 },
    background: { color: '#FFFFFF' }, shapes: [], text,
  });
  const latin = {
    0: 'Quality Assurance Conference 2026',
    1: 'Accreditation of engineering programmes in Kurdistan',
    2: 'Erbil, 3 October 2026',
    3: 'Registration opens on Monday for every member of the association',
  };
  const out = [];
  for (const align of ['left', 'center', 'right']) {
    out.push({
      id: `built__inter-${align}`,
      text: latin,
      layout: base([
        block(0, 90, 96, 'Inter', align),
        block(1, 330, 60, 'Inter', align),
        block(2, 600, 40, 'Inter', align),
        block(3, 760, 24, 'Inter', align),
      ]),
    });
  }
  out.push({
    id: 'built__vazirmatn-kurdish',
    text: { 0: 'کۆنفرانسی دڵنیایی جۆری ٢٠٢٦', 1: 'دەستەی متمانەپێدانی کوردستان بۆ پەروەردە' },
    layout: base([
      block(0, 200, 64, 'Vazirmatn', 'right', { rtl: true }),
      block(1, 500, 40, 'Vazirmatn', 'center', { rtl: true }),
    ]),
  });
  const symbols = {
    0: '☎ 0750 123 4567  ✉ info@example.org',
    1: '✈ Erbil  ➤ Hall B  ✔ Registered',
    2: '✓ ★ → ☎ ♥ ① ✉ ⚑ ✪ ❶',
    3: '☎ ٠٧٥٠ ١٢٣ ٤٥٦٧  ✉ هەولێر',
  };
  out.push({
    id: 'built__symbols',
    text: symbols,
    layout: base([
      block(0, 90, 48, 'Verdana', 'left'),
      block(1, 300, 48, 'Inter', 'left', { bold: true }),
      block(2, 510, 60, 'Cinzel', 'center'),
      block(3, 760, 48, 'Noto Sans Arabic', 'right', { rtl: true }),
    ]),
  });
  return out;
}

async function render(args, creative) {
  const root = path.resolve(args.creative);
  const reference = creative.studioReferenceFromRaw(JSON.parse(fs.readFileSync(path.join(root, 'assets/kaae-reference.json'), 'utf8')));
  const logoPng = fs.readFileSync(path.join(root, 'assets/logos/kaae-official-logo.png'));
  const logoAspect = logoPng.readUInt32BE(16) / (logoPng.readUInt32BE(20) || 1);
  const ornament = creative.resolveOrnamentSettings({});
  const modeOptions = { plain: {}, ornament: { ornament } };
  fs.mkdirSync(args.out, { recursive: true });
  const manifest = { creative: root, fidelity: null, designs: {} };

  const jobs = [];
  for (const raw of storedDesigns(args.runs).slice(0, args.limit)) {
    for (const mode of args.modes) {
      const layout = creative.prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(raw.layout)), { text: raw.text, scripts: raw.scripts }, {
        width: raw.layout.width, height: raw.layout.height, logoAspect, palette: reference.palette, ...modeOptions[mode],
      });
      jobs.push({ id: `${raw.id}@${mode}`, layout, text: raw.text });
    }
  }
  for (const built of builtDesigns()) jobs.push({ id: built.id, layout: built.layout, text: built.text });

  for (const job of jobs) {
    const res = creative.renderLayoutV2(job.layout, { copyText: job.text });
    manifest.fidelity ??= res.fontFidelity;
    fs.writeFileSync(path.join(args.out, `${job.id}.png`), res.png);
    const drawn = [...res.svg.matchAll(/<text id="text-copy-(\d+)"[^>]*font-family="([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]);
    manifest.designs[job.id] = {
      width: job.layout.width,
      height: job.layout.height,
      wrappedLines: res.wrappedLines,
      svgSha256: createHash('sha256').update(res.svg).digest('hex'),
      pngSha256: createHash('sha256').update(res.png).digest('hex'),
      text: job.layout.text.map((t) => ({
        copyIndex: t.copyIndex, x: t.x, y: t.y, width: t.width, height: t.height,
        fontFamily: t.fontFamily, fontSize: t.fontSize, align: t.align, rtl: !!t.rtl,
        drawnFamily: Object.fromEntries(drawn)[t.copyIndex],
      })),
    };
  }
  fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`rendered ${jobs.length} designs into ${args.out}`);
}

function compare(args, creative) {
  const { PNG } = creative;
  const before = JSON.parse(fs.readFileSync(path.join(args.before, 'manifest.json'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(path.join(args.after, 'manifest.json'), 'utf8'));
  const rows = [];
  for (const id of Object.keys(before.designs)) {
    const b = before.designs[id];
    const a = after.designs[id];
    if (!a) {
      rows.push({ id, missingAfter: true });
      continue;
    }
    const pa = PNG.sync.read(fs.readFileSync(path.join(args.before, `${id}.png`)));
    const pb = PNG.sync.read(fs.readFileSync(path.join(args.after, `${id}.png`)));
    const boxes = b.text.map((t) => ({ ...t, diff: 0 }));
    let diff = 0;
    let outside = 0;
    for (let y = 0; y < pa.height; y++) {
      for (let x = 0; x < pa.width; x++) {
        const i = (y * pa.width + x) * 4;
        if (!(Math.abs(pa.data[i] - pb.data[i]) > 5 || Math.abs(pa.data[i + 1] - pb.data[i + 1]) > 5 ||
          Math.abs(pa.data[i + 2] - pb.data[i + 2]) > 5 || Math.abs(pa.data[i + 3] - pb.data[i + 3]) > 5)) continue;
        diff++;
        // A glyph may overhang its box a little, and a wrong-width line overhangs it more: a box
        // counts its own width again on either side, and a line height above and below.
        const owner = boxes.find((t) => x >= t.x - t.width && x < t.x + 2 * t.width && y >= t.y - t.fontSize && y < t.y + t.height + t.fontSize);
        if (owner) owner.diff++;
        else outside++;
      }
    }
    const wrapChanged = Object.keys({ ...b.wrappedLines, ...a.wrappedLines }).filter((k) => b.wrappedLines[k] !== a.wrappedLines[k]);
    rows.push({
      id,
      identical: b.pngSha256 === a.pngSha256,
      svgIdentical: b.svgSha256 === a.svgSha256,
      diffPixels: diff,
      diffPct: Number(((diff / (pa.width * pa.height)) * 100).toFixed(3)),
      outsideText: outside,
      wrapChanged,
      blocks: boxes
        .filter((t) => t.diff > 0)
        .map((t) => ({
          copyIndex: t.copyIndex, fontFamily: t.fontFamily, fontSize: t.fontSize, align: t.align,
          drawnBefore: t.drawnFamily, drawnAfter: a.text.find((x) => x.copyIndex === t.copyIndex)?.drawnFamily, diffPixels: t.diff,
        })),
    });
  }
  const changed = rows.filter((r) => !r.identical);
  const byFamily = {};
  for (const r of changed) for (const blk of r.blocks || []) {
    byFamily[blk.fontFamily] ??= { blocks: 0, diffPixels: 0 };
    byFamily[blk.fontFamily].blocks++;
    byFamily[blk.fontFamily].diffPixels += blk.diffPixels;
  }
  const summary = {
    designs: rows.length,
    identical: rows.filter((r) => r.identical).length,
    changed: changed.length,
    changedOutsideText: rows.filter((r) => r.outsideText > 0).map((r) => ({ id: r.id, pixels: r.outsideText })),
    wrapChanged: rows.filter((r) => r.wrapChanged?.length).map((r) => ({ id: r.id, blocks: r.wrapChanged })),
    changedBlocksByFamily: byFamily,
    fidelityBefore: before.fidelity,
    fidelityAfter: after.fidelity,
  };
  fs.writeFileSync(args.out, JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const r of changed) {
    console.log(`${r.id}: ${r.diffPixels} px (${r.diffPct}%), outside text ${r.outsideText}; ` +
      (r.blocks || []).map((b) => `#${b.copyIndex} ${b.fontFamily} ${b.fontSize}px ${b.align}${b.drawnBefore !== b.drawnAfter ? ` drawn ${b.drawnBefore}->${b.drawnAfter}` : ''}: ${b.diffPixels}`).join('; '));
  }
}

const args = parseArgs(process.argv.slice(2));
const creative = await loadCreative(args.creative);
if (args.mode === 'fonts') {
  const report = fontsReport(creative);
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} else if (args.mode === 'render') {
  await render(args, creative);
} else {
  compare(args, creative);
}
