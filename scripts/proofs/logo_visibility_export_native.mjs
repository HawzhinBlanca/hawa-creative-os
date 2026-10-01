/** Offline ADR172 diagnostic only: pinned fonts and explicit PDF settings; no Canva admission. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defaultFontsDir, fontFileInventory, pinnedFontconfigFile } from '../../packages/creative/dist/studio/font-environment.js';

const input = resolve(process.argv[2] || '/tmp/hawa-w3-logo-controls-20260930');
if (!process.argv[3]) throw new Error('Supply a fresh output directory; original controls are retained.');
const out = resolve(process.argv[3]);
if (existsSync(out)) throw new Error('Refusing an existing output directory.');
const proof = JSON.parse(readFileSync(join(input, 'CONTROLS.json'), 'utf8'));
if (!Array.isArray(proof.controls) || proof.controls.length < 1 || proof.controls.length > 8 ||
    new Set(proof.controls.map(c => c.name)).size !== proof.controls.length ||
    proof.controls.some(c => typeof c.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(c.name))) {
  throw new Error('Invalid bounded diagnostic control inventory.');
}
for (const c of proof.controls) for (const ext of ['.pptx', '.layout.json', '.template.json']) {
  if (!existsSync(join(input, c.name + ext))) throw new Error(`Missing retained input: ${c.name}${ext}`);
}
const fontsDir = defaultFontsDir(), fontconfig = pinnedFontconfigFile(fontsDir);
const env = { ...process.env, FONTCONFIG_FILE: fontconfig };
const options = {
  UseLosslessCompression: { type: 'boolean', value: 'true' },
  ReduceImageResolution: { type: 'boolean', value: 'false' },
};
const profile = mkdtempSync(join(tmpdir(), 'hawa-logo-native-profile-'));
const run = (command, args, commandEnv = env) => execFileSync(command, args, {
  env: commandEnv, timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8',
});
mkdirSync(out, { recursive: true });
proof.nativeExport = {
  input, renderer: run('soffice', ['--version']).trim(),
  options, fontInventory: fontFileInventory(fontsDir),
  fontconfigSha256: createHash('sha256').update(readFileSync(fontconfig)).digest('hex'),
  scope: 'Independent offline diagnostic; family presence cannot establish glyph, ink, bidi, Canva or human fidelity.',
};
for (const c of proof.controls) {
  for (const ext of ['.pptx', '.layout.json', '.template.json']) copyFileSync(join(input, c.name + ext), join(out, c.name + ext));
  c.nativeInputPptxSha256 = createHash('sha256').update(readFileSync(join(out, c.name + '.pptx'))).digest('hex');
  if (c.pptxSha256 !== c.nativeInputPptxSha256) throw new Error(`Changed native input: ${c.name}`);
  process.stdout.write(run('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to',
    `pdf:impress_pdf_Export:${JSON.stringify(options)}`, '--outdir', out, join(out, c.name + '.pptx')]));
  run('pdftoppm', ['-r', '96', '-png', '-singlefile', join(out, c.name + '.pdf'), join(out, c.name + '-native')]);
  c.nativeOutput = {
    pngSha256: createHash('sha256').update(readFileSync(join(out, c.name + '-native.png'))).digest('hex'),
    pdfSha256: createHash('sha256').update(readFileSync(join(out, c.name + '.pdf'))).digest('hex'),
  };
  delete c.native;
}
delete proof.nativeVisibilityPassed;
proof.nativeTypographyQualification = 'PENDING_ACTUAL_FONT_NAME_READBACK';
writeFileSync(join(out, 'CONTROLS.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ out, controls: proof.controls.length, providerCalls: 0, sourceUnchanged: true }));
