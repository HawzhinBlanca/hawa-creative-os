/** Local W2 controls. Does not call providers or imply Canva qualification. Build first. */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { renderLayoutV2 } from '../../packages/creative/dist/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../../packages/creative/dist/studio/transfer-v2.js';
const require = createRequire(new URL('../../packages/creative/package.json', import.meta.url));
const { PNG } = require('pngjs');
const { unzipSync, strFromU8 } = require('fflate');
const out = resolve(process.argv[2] || '/tmp/hawa-background-controls');
mkdirSync(out, { recursive: true });
const logoBytes = readFileSync(new URL('../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url));
const logo = { bytes: logoBytes, sha256: createHash('sha256').update(logoBytes).digest('hex'), mimeType: 'image/png' };
const photograph = new PNG({ width: 320, height: 240 });
for (let i = 0; i < photograph.data.length; i += 4) {
  photograph.data[i] = 190; photograph.data[i + 1] = 75; photograph.data[i + 2] = 65; photograph.data[i + 3] = 255;
}
const photo = PNG.sync.write(photograph), controls = [];
for (const direction of ['to-right', 'to-bottom', 'to-left', 'to-top']) {
  const layout = { version: 2, width: 800, height: 1000, grid: { margin: 60, columns: 12, gutter: 16, baseline: 8 },
    background: { color: '#0A1628', field: { kind: 'linear', direction, stops: [{ at: 0, color: '#0A1628' }, { at: 1, color: '#1E3A5F' }] } },
    shapes: [], logo: { x: 620, y: 60, width: 100, height: 100 },
    photos: [{ photoIndex: 0, role: 'hero', x: 450, y: 650, width: 300, height: 225 }],
    text: [{ copyIndex: 0, role: 'title', x: 60, y: 300, width: 680, height: 100, fontFamily: 'Verdana', lineHeight: 1.3, fontSize: 40, color: '#FFFFFF', align: 'left', bold: true }] };
  const rendered = renderLayoutV2(layout, { copyText: { 0: 'Background control' }, logoDataUri: `data:image/png;base64,${logoBytes.toString('base64')}`, photoFiles: [{ bytes: photo }] });
  const encoded = await encodeStudioTransferV2(layout, ['Background control'], logo, { photos: [{ bytes: photo, mimeType: 'image/png' }] });
  const files = unzipSync(encoded.bytes), xml = strFromU8(files['ppt/slides/slide1.xml']);
  const media = Object.entries(files).filter(([path]) => path.startsWith('ppt/media/') && !path.endsWith('/'));
  const hashes = media.map(([, bytes]) => createHash('sha256').update(bytes).digest('hex'));
  if (!hashes.includes(logo.sha256) || !hashes.includes(createHash('sha256').update(photo).digest('hex'))) throw new Error('Native source identity changed');
  if (!xml.includes('<a:gradFill') || !xml.includes('<a:t>Background control</a:t>')) throw new Error('Missing native field or live copy');
  writeFileSync(join(out, `${direction}.png`), rendered.png);
  writeFileSync(join(out, `${direction}.pptx`), encoded.bytes);
  writeFileSync(join(out, `${direction}.layout.json`), JSON.stringify(layout, null, 2) + '\n');
  const composite = PNG.sync.read(rendered.noTextPng);
  const pixel = (x, y) => [...composite.data.slice((y * composite.width + x) * 4, (y * composite.width + x) * 4 + 3)];
  const samples = [[20, 20], [780, 20], [20, 980], [780, 980], [600, 760]].map(([x, y]) => ({ x, y, rgb: pixel(x, y) }));
  controls.push({ direction, nativeGradient: true, nativeSourceHashes: hashes, previewSamples: samples,
    pptxSha256: encoded.sha256, previewSha256: createHash('sha256').update(rendered.png).digest('hex') });
}
writeFileSync(join(out, 'CONTROLS.json'), JSON.stringify({ controls, providerCalls: 0, canvaQualification: 'not_run' }, null, 2) + '\n');
console.log(JSON.stringify({ out, controls: controls.length, sourceIdentity: 'passed', canvaQualification: 'not_run' }));
