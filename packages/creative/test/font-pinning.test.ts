import { KAAE_TEST_LOGO } from './fixtures/kaae-render-options.js';
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkitNs from 'fontkit';
import { PNG } from 'pngjs';
import {
  ADMITTED_FONT_FAMILIES,
  fontFamilyScript,
  fontFileFor,
  probeFontFidelity,
  probeFontInkWidth,
  probeFontScripts,
  renderLayoutV2,
  renderLayoutV2Async,
  renderLayoutV2ToSvg,
  svgToPngAsync,
} from '../src/studio/render-layout-v2.js';
import { pinnedFontconfigFile, pinnedSystemFontFiles } from '../src/studio/font-environment.js';
import { renderOperationsToPng } from '../src/operations-to-svg.js';
import type { StudioLayoutV2, TextElement } from '../src/studio/layout-v2.js';

/**
 * Measurement and drawing use the same font files (ADR-036, follow-up to Phase 0.5). Each block below
 * failed on the renderer as it was at 79b70e0:
 * - Inter-Regular.ttf was variable (opsz 14-32); pango drew display sizes at a larger optical size
 *   than fontkit measured, about 7% narrower at 60 px.
 * - The Macs drew Noto Sans Arabic from ~/Library/Fonts through CoreText, 9.4% narrower, because
 *   pango's CoreText backend never reads FONTCONFIG_FILE.
 * - Vazirmatn was called a stand-in because its probe equalled the fallback face's, which it is.
 */

const fk = ((fontkitNs as any).default || fontkitNs) as typeof fontkitNs;
const FONTS = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function layoutWith(text: Partial<TextElement>[]): StudioLayoutV2 {
  return {
    version: 2, logo: { x: 40, y: 40, width: 60, height: 40 },
    width: 1000,
    height: 600,
    grid: { margin: 40, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#FFFFFF' },
    shapes: [],
    text: text.map((t, i) => ({
      role: 'body',
      copyIndex: i,
      x: 100,
      y: 100 + i * 150,
      width: 800,
      height: 120,
      fontFamily: 'Verdana',
      fontSize: 40,
      lineHeight: 1.2,
      color: '#000000',
      align: 'left',
      rtl: false,
      ...t,
    })) as TextElement[],
  } as StudioLayoutV2;
}

describe('Inter is shipped as static faces', () => {
  const inter = fs.readdirSync(FONTS).filter((f) => /^Inter-.*\.ttf$/.test(f));

  it('has no variation axes in any Inter file, one file per weight the product asks for, and its licence', () => {
    expect(inter.sort()).toEqual(
      ['Inter-Black.ttf', 'Inter-Bold.ttf', 'Inter-ExtraBold.ttf', 'Inter-Medium.ttf', 'Inter-Regular.ttf', 'Inter-SemiBold.ttf']
    );
    const weights: Record<string, number> = {
      'Inter-Regular.ttf': 400,
      'Inter-Medium.ttf': 500,
      'Inter-SemiBold.ttf': 600,
      'Inter-Bold.ttf': 700,
      'Inter-ExtraBold.ttf': 800,
      'Inter-Black.ttf': 900,
    };
    for (const file of inter) {
      const font = fk.openSync(path.join(FONTS, file)) as any;
      expect(Object.keys(font.variationAxes || {}), file).toEqual([]);
      expect(font['OS/2'].usWeightClass, file).toBe(weights[file]);
      expect(font.getName('preferredFamily') || font.familyName, file).toBe('Inter');
    }
    expect(fs.readFileSync(path.join(FONTS, 'OFL-Inter.txt'), 'utf8')).toMatch(/Inter Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it('is drawn at the width fontkit measures, within 1%, at 24, 40, 60 and 96 px', () => {
    for (const sizePx of [24, 40, 60, 96]) {
      const check = probeFontInkWidth('Inter', { sizePx, script: 'latin' });
      expect(check.measured, check.message).toBe(true);
      expect(check.fontFile).toBe(path.join(FONTS, 'Inter-Regular.ttf'));
      expect(Math.abs(check.deviation), `${sizePx}px: ${check.message}`).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('the rasteriser sees only the pinned font files', () => {
  it('generates a fontconfig that lists the fonts folder and the registry\'s system files, and nothing else', () => {
    const conf = pinnedFontconfigFile(FONTS);
    const xml = fs.readFileSync(conf, 'utf8');
    const dirs = [...xml.matchAll(/<dir>([^<]*)<\/dir>/g)].map((m) => m[1]);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toBe(path.resolve(FONTS));
    // The second folder holds links to the registry's systemPaths (Verdana) and nothing else.
    const linked = fs.readdirSync(dirs[1]).map((f) => fs.readlinkSync(path.join(dirs[1], f)));
    expect(linked.sort()).toEqual(pinnedSystemFontFiles().sort());
    for (const target of linked) expect(path.basename(target)).toMatch(/^Verdana/);
    expect(xml).not.toMatch(/Library\/Fonts|\/usr\/share\/fonts<|\/usr\/local\/share\/fonts/);
    expect(xml).toContain('<glob>*.woff2</glob>');
  });

  it('draws every admitted family from its own file on this host, within 1% (the Mac\'s Noto Sans Arabic included)', () => {
    for (const family of ADMITTED_FONT_FAMILIES) {
      const script = fontFamilyScript(family);
      const check = probeFontInkWidth(family, { script });
      if (!check.measured) {
        // Only Verdana may be absent, on a host without the Microsoft core fonts; say so rather than pass silently.
        expect(family, check.message).toBe('Verdana');
        expect(fs.existsSync(check.fontFile), check.message).toBe(false);
        continue;
      }
      expect(Math.abs(check.deviation), check.message).toBeLessThanOrEqual(0.01);
    }
    const noto = probeFontInkWidth('Noto Sans Arabic', { script: 'arabic' });
    expect(noto.measured).toBe(true);
    expect(noto.fontFile).toBe(path.join(FONTS, 'NotoSansArabic-Regular.ttf'));
    expect(Math.abs(noto.deviation), noto.message).toBeLessThanOrEqual(0.01);
  });

  it('runs every rsvg-convert the renderer spawns on the pinned fontconfig and pango\'s fontconfig backend', async () => {
    const dir = tempDir('hawa-fake-rsvg-');
    const log = path.join(dir, 'env.log');
    const pngFile = path.join(dir, 'out.png');
    const img = new PNG({ width: 64, height: 64 });
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 7919) % 251;
    fs.writeFileSync(pngFile, PNG.sync.write(img));
    const fake = path.join(dir, 'rsvg-convert');
    fs.writeFileSync(
      fake,
      // ADR201 identifies the executable before raster cache reuse; --version is not a render.
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'rsvg font-pin fixture 1'; exit; fi\necho "FONTCONFIG_FILE=$FONTCONFIG_FILE PANGOCAIRO_BACKEND=$PANGOCAIRO_BACKEND" >> '${log}'\ncat '${pngFile}'\n`,
      { mode: 0o755 }
    );
    const layout = layoutWith([{ fontFamily: 'Verdana' }]);
    const copyText = { 0: 'Handgloves' };
    renderLayoutV2(layout, { logoDataUri: KAAE_TEST_LOGO, copyText, rsvgConvertPath: fake });
    await renderLayoutV2Async(layout, { logoDataUri: KAAE_TEST_LOGO, copyText, rsvgConvertPath: fake });
    await svgToPngAsync('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', 4, 4, { rsvgConvertPath: fake });
    probeFontInkWidth('Amiri', { rsvgConvertPath: fake, sizePx: 33 });
    // The operation previews call rsvg-convert by name, so it is found on PATH.
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
    try {
      renderOperationsToPng([], 64, 64);
    } finally {
      process.env.PATH = savedPath;
    }

    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const pinned = pinnedFontconfigFile(FONTS);
    for (const line of lines) expect(line).toBe(`FONTCONFIG_FILE=${pinned} PANGOCAIRO_BACKEND=fc`);
  });
});

describe('the generated fontconfig folder', () => {
  /** Runs `fn` with the temp folder pointed at a scratch folder of its own, as a temp cleaner would see it. */
  function withTmpdir<T>(fn: (tmp: string) => T): T {
    const tmp = tempDir('hawa-tmpdir-');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      return fn(tmp);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  }
  /** A fonts folder of its own, so the generated config is keyed apart from every other test's. */
  function fontsFolder(): string {
    const dir = tempDir('hawa-fonts-');
    fs.copyFileSync(path.join(FONTS, 'Vazirmatn-Regular.ttf'), path.join(dir, 'Vazirmatn-Regular.ttf'));
    return dir;
  }

  it('rebuilds a folder a temp cleaner left without its fonts.conf instead of failing every render', () => {
    withTmpdir((tmp) => {
      const fonts = fontsFolder();
      const conf = pinnedFontconfigFile(fonts);
      expect(conf.startsWith(tmp)).toBe(true);
      const folder = path.dirname(conf);
      fs.mkdirSync(path.join(folder, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'cache', 'left-behind'), 'x');
      fs.unlinkSync(conf);
      expect(pinnedFontconfigFile(fonts)).toBe(conf);
      expect(fs.readFileSync(conf, 'utf8')).toContain(`<dir>${path.resolve(fonts)}</dir>`);
    });
  });

  it('never generates into a folder another user could have planted (a link, or writable by others)', () => {
    withTmpdir((tmp) => {
      const planted = tempDir('hawa-planted-');
      fs.chmodSync(planted, 0o777);
      const uid = process.getuid ? process.getuid() : undefined;
      for (const name of ['hawa-fontconfig', uid === undefined ? 'hawa-fontconfig' : `hawa-fontconfig-${uid}`]) {
        if (!fs.existsSync(path.join(tmp, name))) fs.symlinkSync(planted, path.join(tmp, name));
      }
      const conf = pinnedFontconfigFile(fontsFolder());
      expect(conf.startsWith(tmp)).toBe(true);
      const root = path.dirname(path.dirname(conf));
      const st = fs.lstatSync(root);
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.mode & 0o022).toBe(0);
      if (uid !== undefined) expect(st.uid).toBe(uid);
      expect(fs.readdirSync(planted)).toEqual([]);
    });
  });

  it('links two system files that share a file name without colliding', () => {
    withTmpdir(() => {
      const a = tempDir('hawa-sys-a-');
      const b = tempDir('hawa-sys-b-');
      for (const d of [a, b]) fs.copyFileSync(path.join(FONTS, 'Vazirmatn-Regular.ttf'), path.join(d, 'Vazirmatn-Regular.ttf'));
      const files = [path.join(a, 'Vazirmatn-Regular.ttf'), path.join(b, 'Vazirmatn-Regular.ttf')];
      const conf = pinnedFontconfigFile(fontsFolder(), files);
      const system = path.join(path.dirname(conf), 'system');
      const linked = fs.readdirSync(system).map((f) => fs.readlinkSync(path.join(system, f)));
      expect(linked.sort()).toEqual([...files].sort());
    });
  });
});

describe('font fidelity per script', () => {
  it('reports each script by what the rasteriser draws for it', () => {
    const vazirmatn = probeFontScripts('Vazirmatn');
    expect(vazirmatn.arabic.verdict, vazirmatn.arabic.ink.message).toBe('exact');
    expect(vazirmatn.latin.verdict, vazirmatn.latin.ink.message).toBe('exact');
    expect(probeFontFidelity('Vazirmatn')).toBe('exact');

    const noto = probeFontScripts('Noto Sans Arabic');
    expect(noto.arabic.verdict, noto.arabic.ink.message).toBe('exact');
    expect(noto.latin.verdict).toBe('uncovered');

    const inter = probeFontScripts('Inter');
    expect(inter.latin.verdict, inter.latin.ink.message).toBe('exact');
    expect(inter.arabic.verdict).toBe('uncovered');
  });

  it('does not call a family a stand-in for being the fallback face, and still catches a missing family', () => {
    // Only Vazirmatn draws Kurdish here, so it is also what a family that does not exist gets: the
    // situation in the production image, where the byte test called Vazirmatn a stand-in.
    const dir = tempDir('hawa-font-fallback-');
    fs.copyFileSync(path.join(FONTS, 'Vazirmatn-Regular.ttf'), path.join(dir, 'Vazirmatn-Regular.ttf'));
    const own = probeFontInkWidth('Vazirmatn', { fontsDir: dir, script: 'arabic' });
    expect(own.sameAsSentinel, own.message).toBe(true);
    expect(own.ok, own.message).toBe(true);
    expect(probeFontScripts('Vazirmatn', { fontsDir: dir }).arabic.verdict).toBe('exact');

    // Noto Sans Arabic is not in that folder: the fallback (Vazirmatn) is drawn, and its ink is not Noto's.
    const missing = probeFontInkWidth('Noto Sans Arabic', {
      fontsDir: dir,
      fontFile: path.join(FONTS, 'NotoSansArabic-Regular.ttf'),
      script: 'arabic',
    });
    expect(missing.sameAsSentinel, missing.message).toBe(true);
    expect(missing.ok, missing.message).toBe(false);
  });

  it('rasterises one shared sentinel per sample and size, not one per family', () => {
    const dir = tempDir('hawa-count-rsvg-');
    const log = path.join(dir, 'calls.log');
    const pngFile = path.join(dir, 'out.png');
    const img = new PNG({ width: 64, height: 64 });
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 7919) % 251;
    fs.writeFileSync(pngFile, PNG.sync.write(img));
    const fake = path.join(dir, 'rsvg-convert');
    fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'rsvg sentinel-count fixture 1'; exit; fi\necho call >> '${log}'\ncat '${pngFile}'\n`, { mode: 0o755 });
    const families = ['Inter', 'Cinzel', 'Playfair Display'];
    for (const family of families) probeFontInkWidth(family, { rsvgConvertPath: fake, script: 'latin', sizePx: 41 });
    // One probe per family and one sentinel for all three (the canvas no longer depends on the family).
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(families.length + 1);
  });

  it('draws a Kurdish Vazirmatn block in Vazirmatn instead of replacing it with Noto Sans Arabic', () => {
    const layout = layoutWith([{ fontFamily: 'Vazirmatn', rtl: true, align: 'right' }]);
    const { svg } = renderLayoutV2ToSvg(layout, { logoDataUri: KAAE_TEST_LOGO, copyText: { 0: 'کوردستان ڕێکخراوی ئەندازیاران' } });
    expect(svg).toContain('font-family="Vazirmatn"');
    expect(fontFileFor('Vazirmatn')).toBe(path.join(FONTS, 'Vazirmatn-Regular.ttf'));
  });
});
