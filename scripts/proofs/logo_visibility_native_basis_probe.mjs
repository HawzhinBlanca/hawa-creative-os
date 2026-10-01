/** ADR172 offline renderer-basis experiment. Never grants Canva, readability or production admission. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve, posix } from 'node:path';
import { compileLogoVisibility } from '../../packages/creative/dist/studio/art-direction/logo-visibility.js';
import { readRenderedLogoVisibility } from '../../packages/creative/dist/studio/art-direction/logo-ground.js';
const require = createRequire(new URL('../../packages/creative/package.json', import.meta.url));
const { unzipSync, zipSync } = require('fflate'), { PNG } = require('pngjs');
const hash = b => createHash('sha256').update(b).digest('hex');
const mode = process.argv[2], actual = resolve(process.argv[3] || '/tmp/hawa-w3-pinned-controls-20261001');
if (!process.argv[4]) throw new Error('Supply a separate basis input/output directory.');
const basis = resolve(process.argv[4]), controls = JSON.parse(readFileSync(join(actual, 'CONTROLS.json')));
const dimensions = [['portrait', 'pale-portrait'], ['wide', 'pale-wide-rtl']];

if (mode === 'prepare') {
  if (existsSync(basis)) throw new Error('Refusing an existing basis directory.');
  const prepared = [];
  for (const [format, name] of dimensions) {
    const control = controls.controls.find(c => c.name === name);
    if (!control) throw new Error(`Missing retained control: ${name}`);
    const bytes = readFileSync(join(actual, name + '.pptx'));
    if (hash(bytes) !== control.pptxSha256) throw new Error('Changed source PPTX.');
    const zip = unzipSync(bytes), slide = Buffer.from(zip['ppt/slides/slide1.xml']).toString();
    const rels = Buffer.from(zip['ppt/slides/_rels/slide1.xml.rels']).toString();
    const relations = new Map([...rels.matchAll(/<Relationship\s+[^>]*\/>/g)].map(m => {
      const id = m[0].match(/\bId="([^"]+)"/)?.[1], target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
      return [id, target ? posix.normalize('ppt/slides/' + target) : ''];
    }));
    const pictures = [...slide.matchAll(/<p:pic>.*?<\/p:pic>/gs)].map(m => m[0]);
    const matches = pictures.filter(p => {
      const file = relations.get(p.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1]);
      return file?.startsWith('ppt/media/') && zip[file] && hash(zip[file]) === control.logoHash;
    });
    if (matches.length !== 1) throw new Error('Require one byte-verified official logo picture.');
    const group = slide.match(/<p:spTree>(<p:nvGrpSpPr>.*?<\/p:nvGrpSpPr><p:grpSpPr>.*?<\/p:grpSpPr>)/s)?.[1];
    if (!group) throw new Error('Unknown generated slide geometry.');
    const layout = JSON.parse(readFileSync(join(actual, name + '.layout.json')));
    const template = JSON.parse(readFileSync(join(actual, name + '.template.json')));
    for (const [ground, color] of [['white', 'FFFFFF'], ['black', '000000']]) {
      const isolated = slide.replace(/<p:spTree>.*?<\/p:spTree>/s, `<p:spTree>${group}${matches[0]}</p:spTree>`)
        .replace(/<p:bg>.*?<\/p:bg>/s, `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></p:bgPr></p:bg>`);
      const changed = { ...zip, 'ppt/slides/slide1.xml': Buffer.from(isolated) }, input = zipSync(changed);
      const key = `basis-${format}-${ground}`;
      prepared.push({ name: key, originalName: name, ground, width: control.width, height: control.height,
        originalPptxSha256: control.pptxSha256, pptxSha256: hash(input), logoHash: control.logoHash,
        pictureXmlSha256: hash(Buffer.from(matches[0])), template, layout, input });
    }
  }
  mkdirSync(basis, { recursive: true });
  for (const p of prepared) {
    writeFileSync(join(basis, p.name + '.pptx'), p.input);
    writeFileSync(join(basis, p.name + '.layout.json'), JSON.stringify({ ...p.layout, text: [] }));
    writeFileSync(join(basis, p.name + '.template.json'), JSON.stringify(p.template));
    delete p.input; delete p.layout; delete p.template;
  }
  writeFileSync(join(basis, 'CONTROLS.json'), JSON.stringify({ controls: prepared, providerCalls: 0,
    scope: 'Exact source picture/transform retained; only other slide objects removed and two known matte grounds substituted.' }, null, 2) + '\n');
  console.log(JSON.stringify({ prepared: prepared.length, originalSourceAssetBytesChanged: false, out: basis }));
} else if (mode === 'measure') {
  const refs = JSON.parse(readFileSync(join(basis, 'CONTROLS.json')));
  const resultName = process.argv[5] || 'BASIS_DIAGNOSIS.json';
  if (!/^BASIS_[A-Z_0-9]+\.json$/.test(resultName) || existsSync(join(basis, resultName))) {
    throw new Error('Require a fresh, bounded diagnosis filename; previous evidence is retained.');
  }
  if (!controls.nativeExport || !refs.nativeExport ||
      controls.nativeExport.renderer !== refs.nativeExport.renderer ||
      JSON.stringify(controls.nativeExport.options) !== JSON.stringify(refs.nativeExport.options) ||
      controls.nativeExport.fontconfigSha256 !== refs.nativeExport.fontconfigSha256 ||
      JSON.stringify(controls.nativeExport.fontInventory) !== JSON.stringify(refs.nativeExport.fontInventory)) {
    throw new Error('Native source and actual renderer/export/font basis differ.');
  }
  const readings = [], basisEvidence = [], negatives = [];
  for (const [format, name] of dimensions) {
    const original = controls.controls.find(c => c.name === name);
    for (const ground of ['black', 'white']) {
      const ref = refs.controls.find(c => c.name === `basis-${format}-${ground}`);
      if (!original || !ref || ref.originalName !== name || ref.originalPptxSha256 !== original.pptxSha256 ||
          ref.logoHash !== original.logoHash || ref.nativeInputPptxSha256 !== ref.pptxSha256 ||
          hash(readFileSync(join(basis, ref.name + '.pptx'))) !== ref.pptxSha256 ||
          !ref.nativeOutput || hash(readFileSync(join(basis, ref.name + '-native.png'))) !== ref.nativeOutput.pngSha256 ||
          hash(readFileSync(join(basis, ref.name + '.pdf'))) !== ref.nativeOutput.pdfSha256) {
        throw new Error('Missing or changed native source-basis binding.');
      }
    }
    const template = JSON.parse(readFileSync(join(actual, name + '.template.json'))), r = template.region;
    const black = PNG.sync.read(readFileSync(join(basis, `basis-${format}-black-native.png`)));
    const white = PNG.sync.read(readFileSync(join(basis, `basis-${format}-white-native.png`)));
    if (black.width !== white.width || black.height !== white.height) throw new Error('Inconsistent matte canvas.');
    const source = new PNG({ width: r.width, height: r.height });
    let inconsistentAlpha = 0;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const i = ((r.y + y) * black.width + r.x + x) * 4, j = (y * r.width + x) * 4;
      const delta = [0, 1, 2].map(c => white.data[i + c] - black.data[i + c]).sort((a, b) => a - b);
      if (delta[2] - delta[0] > 2 || delta[0] < -2) inconsistentAlpha++;
      const alpha = Math.max(0, Math.min(1, 1 - delta[1] / 255));
      for (let c = 0; c < 3; c++) source.data[j + c] = alpha > 0 ? Math.max(0, Math.min(255, Math.round(black.data[i + c] / alpha))) : 0;
      source.data[j + 3] = Math.round(alpha * 255);
    }
    if (inconsistentAlpha) throw new Error(`Dual-matte alpha is not consistent at ${inconsistentAlpha} source pixels.`);
    const native = { ...template, signature: compileLogoVisibility(source) };
    basisEvidence.push({ format, region: r, originalFeatureCount: template.signature.components.flat().length,
      nativeFeatureCount: native.signature.components.flat().length, nativeComponentCount: native.signature.components.length,
      signatureSha256: hash(Buffer.from(JSON.stringify(native.signature))), alphaInconsistencyPixels: inconsistentAlpha,
      whitePngSha256: hash(readFileSync(join(basis, `basis-${format}-white-native.png`))),
      blackPngSha256: hash(readFileSync(join(basis, `basis-${format}-black-native.png`))) });
    for (const c of controls.controls.filter(c => format === 'portrait' ? c.width === 1080 : c.width === 1920)) {
      if (c.logoHash !== original.logoHash) throw new Error('Native source belongs to another logo.');
      const bytes = readFileSync(join(actual, c.name + '-native.png'));
      if (hash(bytes) !== c.native.pngSha256) throw new Error('Changed actual native artifact.');
      const layout = JSON.parse(readFileSync(join(actual, c.name + '.layout.json')));
      readings.push({ name: c.name, reading: readRenderedLogoVisibility(bytes, layout.logo, native) });
      const untouched = PNG.sync.read(bytes);
      const smallest = [...native.signature.components].sort((a, b) => a.length - b.length)[0];
      const points = smallest.flatMap(f => [f.a, f.b]);
      const smallBox = { x0: Math.min(...points.map(p => p % r.width)), x1: Math.max(...points.map(p => p % r.width)) + 1,
        y0: Math.min(...points.map(p => Math.floor(p / r.width))), y1: Math.max(...points.map(p => Math.floor(p / r.width))) + 1 };
      const damages = ['absent', 'centre-erased', 'mirrored', 'unrelated-checkerboard'];
      if (native.signature.components.length > 1) damages.push('smallest-component-erased');
      for (const damage of damages) {
        const corrupted = PNG.sync.read(bytes);
        const x0 = damage === 'centre-erased' ? Math.floor(.3 * r.width) : damage === 'smallest-component-erased' ? smallBox.x0 : 0;
        const x1 = damage === 'centre-erased' ? Math.ceil(.65 * r.width) : damage === 'smallest-component-erased' ? smallBox.x1 : r.width;
        const y0 = damage === 'smallest-component-erased' ? smallBox.y0 : 0;
        const y1 = damage === 'smallest-component-erased' ? smallBox.y1 : r.height;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = ((r.y + y) * corrupted.width + r.x + x) * 4;
          if (damage === 'mirrored') {
            const from = ((r.y + y) * corrupted.width + r.x + r.width - 1 - x) * 4;
            untouched.data.copy(corrupted.data, i, from, from + 4);
          } else {
            const value = damage === 'unrelated-checkerboard' ? (((x >> 1) + (y >> 1)) % 2 ? 235 : 20) : 255;
            corrupted.data[i] = corrupted.data[i + 1] = corrupted.data[i + 2] = value; corrupted.data[i + 3] = 255;
          }
        }
        const reading = readRenderedLogoVisibility(PNG.sync.write(corrupted), layout.logo, native);
        negatives.push({ name: c.name, damage, reading, refused: !reading.passed });
      }
    }
  }
  const result = { date: '2026-10-01', scope: 'Offline renderer-basis diagnosis only; no native readability, glyph, Canva or production admission.',
    providerCalls: 0, unchangedThresholds: { overall: .9, component: .8 }, sourceAssetBytesChanged: false,
    coordinateSearch: false, maskedActualPixels: false, nativeExport: refs.nativeExport,
    basisEvidence, readings, negatives, allPositivePassed: readings.every(r => r.reading.passed),
    allCorruptionsRefused: negatives.every(r => r.refused),
    limitations: ['A native reference has different feature selection; human/archive detail-preservation calibration is still required.',
      'Dual-matte images isolate source alpha; actual acceptance reads the whole source-aligned logo region without a mask.',
      'The production local source template and all thresholds remain unchanged.'] };
  writeFileSync(join(basis, resultName), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ positive: readings.length, positivePassed: readings.filter(r => r.reading.passed).length,
    corruptions: negatives.length, corruptionsRefused: negatives.filter(r => r.refused).length, out: join(basis, resultName) }));
  if (!result.allPositivePassed || !result.allCorruptionsRefused) process.exitCode = 1;
} else throw new Error('Use prepare or measure.');
