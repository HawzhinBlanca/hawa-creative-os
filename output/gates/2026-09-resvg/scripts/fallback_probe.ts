#!/usr/bin/env tsx
/**
 * Diagnoses resvg's font fallback outside the gate: one Verdana line with Sorani in it and one Noto
 * Sans Arabic line with Latin in it, rendered with several font setups, so the owner can see whether
 * the missing glyphs are a matter of configuration or of resvg itself.
 *
 *   npx tsx output/gates/2026-09-resvg/scripts/fallback_probe.ts <resvg binary> <fonts dir> <out dir> [<gate image>]
 *
 * Each line is rendered on its own canvas as well as together, because a verdict read off the
 * combined picture missed a whole dropped line once: resvg printed only a "No match" warning and
 * drew nothing for the Verdana line. A line counts as drawn only when it has ink and resvg reported
 * neither a missing character ("No fonts with a ... character", drawn as a .notdef box or nothing)
 * nor a missing family ("No match for ..."), and, when the gate image is given, only when its ink
 * box is within 2 px of rsvg-convert's in that image (the production renderer and fontconfig). The
 * box check catches a line drawn whole in the wrong face: with --use-fonts-dir resvg draws both
 * lines, Latin included, in Amiri, and reports only a "Fallback" warning. Writes
 * <out dir>/fallback-probe.json and the combined renders stacked as <out dir>/resvg-fallback-probe.png
 * (rsvg's reference on top when the gate image is given, then one panel per setup in SETUPS order).
 * Exits 0 either way: the verdict is data for REPORT.md, which check_report.ts compares against it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inkBox, readPng, vstack, writePng, type Rgba } from './image-metrics.js';

const [resvg, fontsDir, outDir, gateImage] = process.argv.slice(2);
if (!resvg || !fontsDir || !outDir) throw new Error('usage: fallback_probe.ts <resvg> <fonts dir> <out dir>');
fs.mkdirSync(outDir, { recursive: true });

const LINES = [
  { id: 'verdana-with-sorani', family: 'Verdana', text: 'KAAE 2026 کوردستان' },
  { id: 'noto-with-latin', family: 'Noto Sans Arabic', text: 'کوردستان Quality (K-12)' },
];

// The setups tried so far, plus the gate's own full list in its fixed order (render.mjs FONT_ORDER).
const GATE_ORDER = [
  'Verdana.ttf', 'Verdana_Bold.ttf', 'Verdana_Italic.ttf', 'Verdana_Bold_Italic.ttf',
  'NotoSansArabic-Regular.ttf', 'NotoSansArabic-Bold.ttf', 'Cinzel-SemiBold.ttf', 'Cinzel-Bold.ttf',
  'PlayfairDisplay-Bold.ttf', 'PlayfairDisplay-Italic.ttf', 'Amiri-Regular.ttf', 'Amiri-Bold.ttf',
  'IBMPlexSansArabic-Regular.ttf', 'IBMPlexSansArabic-Bold.ttf', 'Cairo-Regular.ttf',
  'PlusJakartaSans-Regular.ttf', 'PlusJakartaSans-Bold.ttf', 'Vazirmatn-Regular.ttf', 'Vazirmatn-Bold.ttf',
  'Inter-Regular.ttf', 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf',
];
const files = (names: string[]) => names.flatMap((n) => ['--use-font-file', path.join(fontsDir, n)]);
const SETUPS: { id: string; args: string[] }[] = [
  { id: 'verdana-then-noto', args: files(['Verdana.ttf', 'NotoSansArabic-Regular.ttf']) },
  { id: 'noto-then-verdana', args: files(['NotoSansArabic-Regular.ttf', 'Verdana.ttf']) },
  { id: 'fonts-dir', args: ['--use-fonts-dir', fontsDir] },
  { id: 'dejavu-and-noto', args: files(['DejaVuSans.ttf', 'NotoSansArabic-Regular.ttf']) },
  { id: 'gate-order', args: files(GATE_ORDER) },
];

function svg(lines: typeof LINES): string {
  const h = 100 * lines.length;
  const texts = lines
    .map((l, i) => `<text x="20" y="${70 + 100 * i}" font-family="${l.family}" font-size="40" fill="#000">${l.text}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${h}">${texts}</svg>`;
}

function render(name: string, lines: typeof LINES, setup: (typeof SETUPS)[number]) {
  const svgPath = path.join(outDir, `${name}.svg`);
  const pngPath = path.join(outDir, `${name}.png`);
  fs.writeFileSync(svgPath, svg(lines));
  fs.rmSync(pngPath, { force: true });
  const r = spawnSync(resvg, ['--skip-system-fonts', ...setup.args, svgPath, pngPath], { encoding: 'utf8' });
  const warnings = [...new Set((r.stderr || '').split('\n').map((s) => s.trim()).filter(Boolean))];
  const png = fs.existsSync(pngPath) ? readPng(fs.readFileSync(pngPath)) : null;
  return { status: r.status, warnings, png };
}

// The reference: each line through rsvg-convert with the production fontconfig, in the gate image.
// Read-only use of a locally built image; the out dir is mounted, nothing else.
const reference = new Map<string, ReturnType<typeof inkBox>>();
let referenceBoth: Rgba | null = null;
if (gateImage) {
  for (const line of LINES) fs.writeFileSync(path.join(outDir, `rsvg-${line.id}.svg`), svg([line]));
  fs.writeFileSync(path.join(outDir, 'rsvg-both.svg'), svg(LINES));
  const script = [...LINES.map((l) => l.id), 'both'].map((id) => `rsvg-convert -f png -o /work/rsvg-${id}.png /work/rsvg-${id}.svg`).join(' && ');
  const r = spawnSync('docker', ['run', '--rm', '-v', `${path.resolve(outDir)}:/work`, '-e', 'FONTCONFIG_FILE=/app/packages/creative/assets/fonts/fonts.conf', gateImage, 'sh', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`rsvg reference failed: ${r.stderr}`);
  for (const line of LINES) reference.set(line.id, inkBox(readPng(fs.readFileSync(path.join(outDir, `rsvg-${line.id}.png`)))));
  referenceBoth = readPng(fs.readFileSync(path.join(outDir, 'rsvg-both.png')));
}

const results = SETUPS.map((setup) => {
  const lines = LINES.map((line) => {
    const { status, warnings, png } = render(`${setup.id}-${line.id}`, [line], setup);
    const box = png ? inkBox(png) : null;
    const missingChars = warnings.filter((w) => /No fonts with/.test(w)).length;
    const missingFamily = warnings.some((w) => /No match for/.test(w));
    const ref = reference.get(line.id);
    const boxDelta = ref && box ? Math.max(Math.abs(ref.left - box.left), Math.abs(ref.right - box.right), Math.abs(ref.top - box.top), Math.abs(ref.bottom - box.bottom)) : null;
    return {
      line: line.id,
      status,
      warnings,
      inkWidth: box ? box.right - box.left + 1 : 0,
      inkPixels: box ? box.pixels : 0,
      missingChars,
      missingFamily,
      rsvgInkWidth: ref ? ref.right - ref.left + 1 : null,
      boxDeltaVsRsvg: boxDelta,
      drawn: status === 0 && !!box && missingChars === 0 && !missingFamily && (!gateImage || (boxDelta !== null && boxDelta <= 2)),
    };
  });
  const combined = render(`${setup.id}-both`, LINES, setup);
  return { setup: setup.id, lines, bothDrawn: lines.every((l) => l.drawn), combined: combined.png };
});

// The combined renders stacked, on white, for the report's sample.
const sheet = vstack(
  [...(referenceBoth ? [referenceBoth] : []), ...results.map((r) => r.combined!)].map((img) => {
    const out = { width: img.width, height: img.height, data: new Uint8Array(img.data.length) };
    for (let o = 0; o < img.data.length; o += 4) {
      const a = img.data[o + 3] / 255;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(img.data[o + c] * a + 255 * (1 - a));
      out.data[o + 3] = 255;
    }
    return out;
  }),
);
fs.writeFileSync(path.join(outDir, 'resvg-fallback-probe.png'), writePng(sheet));

const json = results.map(({ combined: _c, ...r }) => r);
fs.writeFileSync(path.join(outDir, 'fallback-probe.json'), JSON.stringify({ reference: gateImage ? `rsvg-convert in ${gateImage}` : null, resvg: spawnSync(resvg, ['--version'], { encoding: 'utf8' }).stdout.trim(), setups: json }, null, 2) + '\n');
for (const r of json) {
  console.log(`${r.bothDrawn ? 'BOTH DRAWN' : 'FAILS     '}  ${r.setup}`);
  for (const l of r.lines) console.log(`    ${l.drawn ? 'drawn  ' : 'NOT    '} ${l.line}: ink ${l.inkWidth} px (rsvg ${l.rsvgInkWidth ?? '-'}, box delta ${l.boxDeltaVsRsvg ?? '-'}), ${l.missingChars} missing-character warnings${l.missingFamily ? ', family not found' : ''}`);
}
const anyBoth = json.filter((r) => r.bothDrawn).map((r) => r.setup);
console.log(anyBoth.length ? `setups drawing both lines: ${anyBoth.join(', ')}` : 'no tested font setup draws both lines correctly');
