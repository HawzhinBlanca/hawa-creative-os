import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG, probeFontInkWidth, probeFontScripts } from '../src/studio/render-layout-v2.js';
import { pinnedFontconfigFile } from '../src/studio/font-environment.js';
import { resolveRsvgConvert } from '../src/studio/renderer-identity.js';

const assets = resolve(import.meta.dirname, '../assets/fonts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder() { const dir = mkdtempSync(join(tmpdir(), 'hawa-raster-cache-')); dirs.push(dir); return dir; }
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function wrapper(dir: string, tail?: string) {
  const file = join(dir, 'rsvg-convert');
  const source = `#!/bin/sh\nexec ${quote(resolveRsvgConvert())} "$@"\n${tail ?? ''}`;
  writeFileSync(file, source, { mode: 0o755 });
  return { file, source };
}
function withOneFont(dir: string, name: string) {
  const fontDir = join(dir, name);
  // mkdtemp provides an existing directory without exposing any production file to mutation.
  const nested = mkdtempSync(`${fontDir}-`);
  copyFileSync(join(assets, name), join(nested, name));
  return nested;
}
function image(file: string, width: number) {
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 16 + width; x++) {
    const i = (y * 64 + x) * 4;
    png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
  }
  writeFileSync(file, PNG.sync.write(png));
}
function syntheticRenderer(dir: string, sentinel: string, normal: string, extra = '') {
  const file = join(dir, 'rsvg-convert');
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'rsvg cache fixture 1'; exit; fi\n${extra}\nif /usr/bin/grep -q ZZHawaNoSuchFamilyZZ "$3"; then cat ${quote(sentinel)}; else cat ${quote(normal)}; fi\n`, { mode: 0o755 });
  return file;
}

describe('current raster-probe cache basis (ADR201)', () => {
  it('refuses a warmed measurement after renderer failure and recovers after restoration through script fidelity', () => {
    const dir = folder(); const rsvg = wrapper(dir);
    const options = { rsvgConvertPath: rsvg.file, script: 'arabic' as const };
    const before = probeFontInkWidth('Amiri', options);
    expect(before.measured, before.message).toBe(true);
    const stamp = statSync(rsvg.file);
    writeFileSync(rsvg.file, '#!/bin/sh\nexit 3\n');
    utimesSync(rsvg.file, stamp.atime, stamp.mtime);
    expect(probeFontScripts('Amiri', options).arabic.verdict).toBe('unmeasured');
    writeFileSync(rsvg.file, rsvg.source);
    expect(probeFontInkWidth('Amiri', options).measured).toBe(true);
  });

  it('refreshes after same-path executable byte changes with restored mtime even when pixels agree', () => {
    const dir = folder(); const rsvg = wrapper(dir);
    const options = { rsvgConvertPath: rsvg.file, script: 'arabic' as const };
    const before = probeFontInkWidth('Amiri', options); const stamp = statSync(rsvg.file);
    writeFileSync(rsvg.file, rsvg.source + '# changed executable bytes\n');
    utimesSync(rsvg.file, stamp.atime, stamp.mtime);
    const after = probeFontInkWidth('Amiri', options);
    expect(after.measured).toBe(true);
    expect(after).not.toBe(before);
    expect(after.renderedInkPx).toBe(before.renderedInkPx);
  });

  it('observes replaced, missing, corrupt and restored measured files at one path', () => {
    const dir = folder(); const measured = join(dir, 'measured.ttf');
    copyFileSync(join(assets, 'Amiri-Regular.ttf'), measured);
    const options = { fontFile: measured, script: 'arabic' as const };
    const before = probeFontInkWidth('Amiri', options); const stamp = statSync(measured);
    copyFileSync(join(assets, 'NotoSansArabic-Regular.ttf'), measured);
    utimesSync(measured, stamp.atime, stamp.mtime);
    const after = probeFontInkWidth('Amiri', options);
    expect(after.expectedInkPx).not.toBe(before.expectedInkPx);
    expect(after.ok).toBe(false);
    unlinkSync(measured);
    expect(probeFontInkWidth('Amiri', options).unmeasuredReason).toBe('unopenable');
    writeFileSync(measured, 'not a font');
    expect(probeFontInkWidth('Amiri', options).unmeasuredReason).toBe('unopenable');
    copyFileSync(join(assets, 'Amiri-Regular.ttf'), measured);
    expect(probeFontInkWidth('Amiri', options).expectedInkPx).toBe(before.expectedInkPx);
  });

  it('observes changes behind a custom include even when the top-level configuration is unchanged', () => {
    const dir = folder(); const a = withOneFont(dir, 'Amiri-Regular.ttf');
    const b = withOneFont(dir, 'NotoSansArabic-Regular.ttf');
    const include = join(dir, 'included.conf'); const config = join(dir, 'fonts.conf');
    writeFileSync(include, readFileSync(pinnedFontconfigFile(a, [])));
    writeFileSync(config, `<?xml version="1.0"?><fontconfig><include>${include}</include></fontconfig>`);
    const options = { fontconfigFile: config, script: 'arabic' as const };
    const before = probeFontInkWidth('Amiri', options);
    expect(before.measured).toBe(true);
    writeFileSync(include, readFileSync(pinnedFontconfigFile(b, [])));
    const after = probeFontInkWidth('Amiri', options);
    expect(after.measured).toBe(true);
    expect(after.renderedInkPx).not.toBe(before.renderedInkPx);
    expect(after.sameAsSentinel).toBe(true);
    expect(after.ok).toBe(false);
  });

  it('refreshes the shared sentinel after executable replacement before a different family query', () => {
    const dir = folder(); const narrow = join(dir, 'narrow.png'); const wide = join(dir, 'wide.png');
    image(narrow, 16); image(wide, 32);
    const file = syntheticRenderer(dir, narrow, wide);
    const options = { rsvgConvertPath: file, script: 'latin' as const, sizePx: 43 };
    expect(probeFontInkWidth('Inter', options).sameAsSentinel).toBe(false);
    syntheticRenderer(dir, wide, wide);
    expect(probeFontInkWidth('Cinzel', options).sameAsSentinel).toBe(true);
  });

  it('does not cache a failed sentinel and recovers under unchanged executable bytes', () => {
    const dir = folder(); const png = join(dir, 'out.png'); const flag = join(dir, 'fail');
    image(png, 32); writeFileSync(flag, 'synthetic transient failure');
    const extra = `if /usr/bin/grep -q ZZHawaNoSuchFamilyZZ "$3" && [ -f ${quote(flag)} ]; then exit 3; fi`;
    const file = syntheticRenderer(dir, png, png, extra);
    const options = { rsvgConvertPath: file, script: 'latin' as const, sizePx: 44 };
    const failed = probeFontInkWidth('Inter', options);
    expect(failed.measured).toBe(false);
    expect(failed.unmeasuredReason).toBe('no-rasteriser');
    unlinkSync(flag);
    expect(probeFontInkWidth('Inter', options).sameAsSentinel).toBe(true);
  });

  it('retains unchanged generated-input hits and a caller-provided current generated configuration', () => {
    const dir = folder(); const rsvg = wrapper(dir);
    const options = { rsvgConvertPath: rsvg.file, script: 'arabic' as const, sizePx: 45 };
    const before = probeFontInkWidth('Amiri', options);
    expect(before.measured).toBe(true);
    expect(probeFontInkWidth('Amiri', options)).toBe(before);
    const config = pinnedFontconfigFile(assets);
    expect(probeFontInkWidth('Amiri', { ...options, fontconfigFile: config })).toBe(before);
  });
});
