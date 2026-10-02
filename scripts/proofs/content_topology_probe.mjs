/** Synthetic W4 diagnostic controls, zero providers; not human/Canva qualification. Build first. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { solveRecipe } from '../../packages/creative/dist/studio/art-direction/solver.js';
import { renderLayoutV2 } from '../../packages/creative/dist/studio/render-layout-v2.js';
import { encodeStudioTransferV2 } from '../../packages/creative/dist/studio/transfer-v2.js';
import { evaluateHardQa } from '../../packages/creative/dist/studio/hard-qa.js';
const require = createRequire(new URL('../../packages/creative/package.json', import.meta.url));
const { PNG } = require('pngjs'), { unzipSync, strFromU8 } = require('fflate');
const out = resolve(process.argv[2] || '/tmp/hawa-topology-controls'); mkdirSync(out, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const logoBytes = readFileSync(new URL('../../packages/creative/assets/logos/kaae-official-logo.png', import.meta.url));
const logo = { bytes: logoBytes, sha256: digest(logoBytes), mimeType: 'image/png' };
const palette = ['#112B24', '#355A45', '#BA813D', '#F7F4EB', '#FFFFFF', '#101815'];
const sources = Array.from({ length: 10 }, (_, n) => {
  const width = n % 3 ? 1600 : 1800, height = n % 3 ? 1400 : 1200;
  const p = new PNG({ width, height });
  const rgb = [[138, 167, 174], [195, 146, 105], [113, 154, 125], [169, 146, 177], [174, 161, 125], [115, 158, 178]][n % 6];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const k = (y * width + x) * 4;
    const light = (Math.floor(x / (width / 4)) + Math.floor(y / (height / 3))) % 2 ? 12 : 0;
    for (let c = 0; c < 3; c++) p.data[k + c] = rgb[c] + light;
    p.data[k + 3] = 255;
  }
  return { photoIndex: n, width, height, regionStatus: 'measured', regions: [], bytes: PNG.sync.write(p), mimeType: 'image/png' };
});
const controls = [];
for (const [recipe, width, height, count] of [['editorial_split',1080,1350,1], ['photo_diptych',1080,1080,2],
 ['photo_sequence',1920,1080,6], ['photo_mosaic',1920,1080,6], ['hero_storyboard',1920,1080,6]]) {
  const photos = sources.slice(0, count), copy = {0:'Design for the content',1:'A measured editorial composition',2:'example.org'};
  const layout = solveRecipe({ width, height, photos, palette, logoAspect: 1, copy: { text: copy },
    photoSelection: { mode: 'all', minimum: count, insisted: true },
    choice: { recipe, heroPhotoIndex: 0, texturePhotoIndex: null, cutoutPhotoIndex: null,
      supportingPhotoIndices: photos.slice(1).map(p => p.photoIndex),
      slots: [{copyIndex:0,slot:'title'},{copyIndex:1,slot:'body'},{copyIndex:2,slot:'cta'}], params: {surfaceTone:'cream'} } });
  const renderOptions = { copyText: copy, photoFiles: photos, logoDataUri: `data:image/png;base64,${logoBytes.toString('base64')}` };
  const rendered = renderLayoutV2(layout, renderOptions);
  const qa = evaluateHardQa(layout, { width, height, palette, copyText: copy, copyScripts: ['latin','latin','latin'], latinFont:'Verdana', arabicFont:'Noto Sans Arabic',
    logoAspect:1, photoCount:count, photoSelection:{mode:'all',minimum:count,insisted:true}, photoRegions:photos, renderedComposite:rendered.noTextPng });
  if (!qa.passed) throw new Error(`${recipe}: ${qa.messages.join('; ')}`);
  const transfer = await encodeStudioTransferV2(layout, Object.values(copy), logo, { photos });
  const zip = unzipSync(transfer.bytes), xml = strFromU8(zip['ppt/slides/slide1.xml']);
  const media = Object.entries(zip).filter(([path]) => path.startsWith('ppt/media/') && !path.endsWith('/')).map(([,bytes]) => digest(bytes));
  if (!media.includes(logo.sha256) || photos.some(p => !media.includes(digest(p.bytes))) || Object.values(copy).some(s => !xml.includes(s))) throw new Error('Native source/copy identity changed');
  writeFileSync(join(out, recipe+'.png'), rendered.png); writeFileSync(join(out,recipe+'.pptx'), transfer.bytes);
  writeFileSync(join(out, recipe+'.layout.json'), JSON.stringify(layout,null,2)+'\n');
  controls.push({ recipe, width, height, photos:count, sourceHashes:photos.map(p=>digest(p.bytes)), logoHash:logo.sha256, liveCopy:Object.values(copy),
    pptxSha256:transfer.sha256, previewSha256:digest(rendered.png), hardQaPassed:true, nativeIdentityPassed:true });
}
writeFileSync(join(out,'CONTROLS.json'), JSON.stringify({controls,providerCalls:0,inputs:'synthetic geometric controls and explicit official test logo; not customer design qualification',canvaQualification:'not_run'},null,2)+'\n');
console.log(JSON.stringify({out,controls:controls.length,sourceIdentity:'passed',canvaQualification:'not_run'}));
