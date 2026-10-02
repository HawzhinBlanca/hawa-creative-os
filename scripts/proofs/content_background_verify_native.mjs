/** Compare independent PDF rasterizations at 96dpi with the original preview. No Canva claim. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { PNG } = createRequire(new URL('../../packages/creative/package.json', import.meta.url))('pngjs');
const base = resolve(process.argv[2] || '/tmp/hawa-background-controls');
const controls = JSON.parse(readFileSync(join(base, 'CONTROLS.json'), 'utf8'));
for (const c of controls.controls) {
  const layout = JSON.parse(readFileSync(join(base, c.direction + '.layout.json'), 'utf8'));
  const native = PNG.sync.read(readFileSync(join(base, c.direction + '-native.png')));
  const preview = PNG.sync.read(readFileSync(join(base, c.direction + '.png')));
  const pdf = readFileSync(join(base, c.direction + '.pdf'));
  const box = /\/MediaBox\[0 0 ([0-9.]+) ([0-9.]+)\]/.exec(pdf.toString('latin1'));
  if (!box) throw new Error('Control PDF page geometry missing');
  const pdfPixels = { width: Number(box[1]) * 96 / 72, height: Number(box[2]) * 96 / 72 };
  if (Math.abs(pdfPixels.width - layout.width) > .1 || Math.abs(pdfPixels.height - layout.height) > .1 ||
      native.width < layout.width || native.width > layout.width + 1 || native.height < layout.height || native.height > layout.height + 1) {
    throw new Error('Native page dimensions changed beyond PDF point quantization');
  }
  const at = (png, x, y) => [...png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  const difference = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const samples = c.previewSamples.map(s => ({ ...s, nativeRgb: at(native, s.x, s.y), maxChannelDifference: difference(s.rgb, at(native, s.x, s.y)) }));
  if (samples.some(s => s.maxChannelDifference > 3)) throw new Error(`Native background sample differs: ${JSON.stringify(samples)}`);
  const excluded = [...layout.text, layout.logo, ...(layout.photos ?? [])];
  const inside = (x, y) => excluded.some(b => x >= b.x - 2 && x < b.x + b.width + 2 && y >= b.y - 2 && y < b.y + b.height + 2);
  let compared = 0, overTolerance = 0, maxChannelDifference = 0;
  for (let y = 0; y < layout.height; y++) for (let x = 0; x < layout.width; x++) {
    if (inside(x, y)) continue;
    const delta = difference(at(preview, x, y), at(native, x, y));
    compared++; maxChannelDifference = Math.max(maxChannelDifference, delta);
    if (delta > 3) overTolerance++;
  }
  if (overTolerance) throw new Error(`Native field mismatch: ${c.direction}: ${overTolerance}/${compared}; max ${maxChannelDifference}`);
  c.independentNativeRender = { renderer: 'LibreOfficeDev 26.8.0.0.alpha0 PDF -> pdftoppm at 96dpi', samples,
    pdfPixels, rasterPixels: { width: native.width, height: native.height },
    pageRounding: 'PDF point quantization under 0.1px; extra raster fringe excluded',
    comparedBackgroundPixels: compared, overTolerance, maxChannelDifference,
    pdfSha256: createHash('sha256').update(readFileSync(join(base, c.direction + '.pdf'))).digest('hex'), passed: true };
}
controls.nativeFontQualification = 'failed in this independent control: source Verdana substituted with FrankRuhlHofshi-Bold; font-cache warnings retained; background-only proof';
controls.canvaQualification = 'not_run';
writeFileSync(join(base, 'CONTROLS.json'), JSON.stringify(controls, null, 2) + '\n');
console.log(JSON.stringify({ independentNativeControls: controls.controls.length, comparedBackgroundPixels: controls.controls.reduce((s, c) => s + c.independentNativeRender.comparedBackgroundPixels, 0), passed: true, canvaQualification: 'not_run' }));
