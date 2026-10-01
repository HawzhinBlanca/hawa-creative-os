import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fontkitNs from 'fontkit';
import { PNG } from 'pngjs';
import { pinnedFontconfigFile, pinnedSystemFontFiles, rasteriserEnv, symbolFirstFamilies } from '../src/studio/font-environment.js';
import { probeFontInkWidth } from '../src/studio/render-layout-v2.js';

/**
 * The copy gate (classifyCopyScript in apps/core/src/services/canva-design-planner.ts, and the same
 * check in design-studio-service.ts) admits arrows, maths, geometric shapes, miscellaneous symbols and
 * dingbats, so a contact line such as "☎ 0750 123 4567  ✉ info@example.org" reaches the renderer.
 * The image used to draw those from fonts-dejavu-core under /usr/share/fonts; pinning the rasteriser
 * to assets/fonts took that away, and ☎ and ✉ came out as hex boxes. The pinned set now carries a
 * symbols-only cut of DejaVu Sans (scripts/generate_symbol_fallback_faces.py) that Latin families fall
 * back to first.
 */

const fk = ((fontkitNs as any).default || fontkitNs) as any;
const FONTS = fileURLToPath(new URL('../assets/fonts/', import.meta.url));

/** The ranges classifyCopyScript admits outside the Latin and Arabic letters. */
const GATE_SYMBOL_RANGES: Array<[number, number]> = [
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
  [0x2100, 0x214f],
  [0x2190, 0x21ff],
  [0x2200, 0x22ff],
  [0x25a0, 0x25ff],
  [0x2600, 0x27bf],
];

function visibleFaces(): any[] {
  const xml = fs.readFileSync(pinnedFontconfigFile(FONTS), 'utf8');
  const dirs = [...xml.matchAll(/<dir>([^<]*)<\/dir>/g)].map((m) => m[1]);
  return dirs.flatMap((d) =>
    fs
      .readdirSync(d)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => fk.openSync(path.join(d, f)))
  );
}

function available(tool: string, arg = '--version'): boolean {
  try {
    execFileSync(tool, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Ink extent (px) of a PNG: the box around every pixel darker than mid-grey. */
function inkBox(png: Buffer): { width: number; height: number } {
  const img = PNG.sync.read(png);
  let minX = img.width;
  let maxX = -1;
  let minY = img.height;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] > 128 && img.data[i] < 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? { width: 0, height: 0 } : { width: maxX - minX + 1, height: maxY - minY + 1 };
}

describe('pinned fonts cover the symbols the copy gate admits', () => {
  it('draws the contact and list symbols classifyCopyScript lets through (U+2600-27BF)', () => {
    const faces = visibleFaces();
    const missing = [...'☎✉✈✆✔➤'].filter((ch) => !faces.some((f: any) => f.hasGlyphForCodePoint(ch.codePointAt(0))));
    expect(missing).toEqual([]);
  });

  it('covers every admitted symbol the production image drew before the fonts were pinned, save one', () => {
    // Measured in hawa-core:canva-only-20260913 with fontkit: the fonts its old fonts.conf listed drew
    // 1036 admitted code points in these ranges (803 of them only through fonts-dejavu-core). The one
    // not carried over is U+27BF, which only DejaVu Sans Mono Bold has.
    const faces = visibleFaces();
    let drawable = 0;
    for (const [from, to] of GATE_SYMBOL_RANGES) {
      for (let cp = from; cp <= to; cp++) if (faces.some((f: any) => f.hasGlyphForCodePoint(cp))) drawable++;
    }
    expect(drawable).toBeGreaterThanOrEqual(1036 - 1);
  });

  it('keeps the symbol faces to symbols and their spaces, without Latin or Kurdish letters', () => {
    for (const file of ['HawaSymbols-Regular.ttf', 'HawaSymbols-Bold.ttf']) {
      const font = fk.openSync(path.join(FONTS, file));
      expect(font.familyName, file).toBe('Hawa Symbols');
      // fontkit lists U+FFFF from the format-4 cmap's closing segment, which every such cmap has.
      const points: number[] = font.characterSet.filter((cp: number) => cp !== 0xffff);
      const outside = points.filter((cp) => !GATE_SYMBOL_RANGES.some(([a, b]) => cp >= a && cp <= b));
      expect(outside.map((cp) => cp.toString(16)).sort(), file).toEqual(['20','a0']);
    }
    expect(fs.readFileSync(path.join(FONTS, 'LICENSE-DejaVu.txt'), 'utf8')).toMatch(/Bitstream Vera/);
  });

  it.skipIf(!available('rsvg-convert'))('draws symbols a face lacks from the symbol face, not as hex boxes or from Inter', () => {
    const symbols = fk.openSync(path.join(FONTS, 'HawaSymbols-Regular.ttf'));
    const env = rasteriserEnv(pinnedFontconfigFile(FONTS));
    // ☎ ✉ were hex boxes once the image's DejaVu was out of sight. ✓ ★ were drawn from Inter, which has
    // them, in a Cinzel or Verdana line, where the image drew DejaVu's.
    const cases: Array<[string, string]> = [
      ['Verdana', '☎'],
      ['Verdana', '✉'],
      ['Verdana', '★'],
      ['Cinzel', '✓'],
      ['Cinzel', '★'],
      ['Noto Sans Arabic', '☎'],
    ];
    for (const [family, ch] of cases) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">` +
        `<rect width="300" height="200" fill="#fff"/>` +
        `<text x="50" y="140" font-family="${family}" font-size="100" fill="#000">${ch}</text></svg>`;
      const png = execFileSync('rsvg-convert', ['-f', 'png'], { input: svg, env, maxBuffer: 16 * 1024 * 1024 });
      expect(symbols.hasGlyphForCodePoint(ch.codePointAt(0)), ch).toBe(true);
      const glyph = symbols.glyphForCodePoint(ch.codePointAt(0));
      const scale = 100 / symbols.unitsPerEm;
      const expected = { width: (glyph.bbox.maxX - glyph.bbox.minX) * scale, height: (glyph.bbox.maxY - glyph.bbox.minY) * scale };
      const drawn = inkBox(png);
      // Antialiasing adds up to a pixel either side. Both sides are checked because the hex box pango
      // draws for a missing glyph at this size (71 x 81 px) happens to be as wide as ✉.
      const message = `${family} ${ch}: drawn ${drawn.width} x ${drawn.height} px, symbol face ${expected.width.toFixed(1)} x ${expected.height.toFixed(1)} px`;
      expect(Math.abs(drawn.width - expected.width), message).toBeLessThanOrEqual(3);
      expect(Math.abs(drawn.height - expected.height), message).toBeLessThanOrEqual(3);
    }
  });

  it.skipIf(!available('rsvg-convert'))('leaves the Kurdish footer bullet to the face the image drew it with', () => {
    // Noto Sans Arabic has no "•". A stored footer, "هەولێر • … • kaae.gov.krd", re-renders
    // byte-identical only if it is still drawn by the face fontconfig's order gives it, which is why
    // only Latin families put the symbol faces first.
    const draw = (fontsDir: string) =>
      execFileSync('rsvg-convert', ['-f', 'png'], {
        input:
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="#fff"/>` +
          `<text x="200" y="80" font-family="Noto Sans Arabic" font-size="48" text-anchor="middle" fill="#000">هەولێر • ٢٠٢٦</text></svg>`,
        env: rasteriserEnv(pinnedFontconfigFile(fontsDir)),
      });
    const withoutSymbols = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-nosymbols-'));
    try {
      for (const f of fs.readdirSync(FONTS).filter((f) => f.endsWith('.ttf') && !f.startsWith('HawaSymbols-'))) {
        fs.copyFileSync(path.join(FONTS, f), path.join(withoutSymbols, f));
      }
      expect(draw(FONTS).equals(draw(withoutSymbols))).toBe(true);
    } finally {
      fs.rmSync(withoutSymbols, { recursive: true, force: true });
    }
  });

  it.skipIf(!available('rsvg-convert'))('leaves Vazirmatn as the face drawn for a family that does not exist', () => {
    // A face without letters can never rank first for a family fontconfig lacks; if it did, every
    // stand-in check would compare against a face that draws nothing but symbols.
    const check = probeFontInkWidth('Vazirmatn', { script: 'arabic' });
    expect(check.measured, check.message).toBe(true);
    expect(check.sameAsSentinel, check.message).toBe(true);
    expect(check.ok, check.message).toBe(true);
  });
});

describe('the committed fonts.conf (FONTCONFIG_FILE in the core image)', () => {
  it.skipIf(!available('fc-list', '--version'))('lists only the fonts folder and the Verdana files, like the generated one', () => {
    const listed = execFileSync('fc-list', [':', 'file'], {
      env: { ...process.env, FONTCONFIG_FILE: path.join(FONTS, 'fonts.conf') },
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => line.replace(/:\s*$/, '').trim())
      .filter(Boolean);
    const outside = listed.filter((file) => path.dirname(file) !== path.resolve(FONTS));
    expect(outside.sort()).toEqual(pinnedSystemFontFiles().sort());
    const committed = fs.readdirSync(FONTS).filter((f) => /\.(ttf|otf)$/i.test(f));
    expect(listed.filter((file) => path.dirname(file) === path.resolve(FONTS)).map((f) => path.basename(f)).sort()).toEqual(committed.sort());
  });

  it('puts the symbol faces first for the same Latin families as the generated one', () => {
    const xml = fs.readFileSync(path.join(FONTS, 'fonts.conf'), 'utf8');
    const tested = [...xml.matchAll(/<test name="family" compare="eq"><string>([^<]*)<\/string><\/test>/g)].map((m) => m[1]);
    // Crimson Pro joined 2026-10-01 (ADR-238: KAAE's 2025 guideline titles).
    expect(tested.sort()).toEqual(['Cinzel', 'Crimson Pro', 'Inter', 'Playfair Display', 'Plus Jakarta Sans', 'Verdana']);
    expect(symbolFirstFamilies(FONTS)).toEqual(
      pinnedSystemFontFiles().length ? ['Cinzel', 'Crimson Pro', 'Inter', 'Playfair Display', 'Plus Jakarta Sans', 'Verdana'] : ['Cinzel', 'Crimson Pro', 'Inter', 'Playfair Display', 'Plus Jakarta Sans']
    );
  });
});
