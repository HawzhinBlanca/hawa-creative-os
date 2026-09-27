import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkitNs from 'fontkit';
import { PNG } from 'pngjs';
import {
  renderLayoutV2,
  renderLayoutV2ToSvg,
  renderLayoutV2Async,
  comparePngBuffers,
  fontFileFor,
  probeFontInkWidth,
  probeFontFidelity,
  logoPrescaleStats,
  svgToPngAsync,
} from '../src/studio/render-layout-v2.js';
import { renderOperationsToSvg, getKaaeOfficialLogoDataUri } from '../src/operations-to-svg.js';
import { sniffImageType, relabelDataUri } from '../src/studio/image-type.js';
import { uprightPhotoDataUrl } from '../src/studio/photo-upright.js';
import type { StudioLayoutV2, TextElement } from '../src/studio/layout-v2.js';

import { inlineSvgFiles } from '../src/studio/svg-files.js';
/**
 * The render's markup with its picture files put back inline: pictures are files beside the SVG
 * (ADR-035), and these assertions read the markup as the one document it used to be.
 */
const inlinedSvgOf = (...args: Parameters<typeof renderLayoutV2ToSvg>) => {
  const r = renderLayoutV2ToSvg(...args);
  return { ...r, svg: inlineSvgFiles(r.svg, r.files), noTextSvg: inlineSvgFiles(r.noTextSvg, r.files) };
};

/**
 * ADR-036 section 2.1: SVG the rasteriser cannot misread. Each block below failed on the renderer as it
 * was at f143aa9.
 */

const fk = ((fontkitNs as any).default || fontkitNs) as typeof fontkitNs;
const FONTS = fileURLToPath(new URL('../assets/fonts/', import.meta.url));

function layoutWith(text: Partial<TextElement>[], extra: Partial<StudioLayoutV2> = {}): StudioLayoutV2 {
  return {
    version: 2,
    width: 1000,
    height: 600,
    grid: { margin: 40, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#FFFFFF' },
    shapes: [],
    text: text.map((t, i) => ({
      copyIndex: i,
      role: 'title',
      x: 100,
      y: 60,
      width: 800,
      height: 200,
      fontSize: 40,
      lineHeight: 2,
      fontFamily: 'Verdana',
      color: '#000000',
      align: 'left',
      ...t,
    })) as TextElement[],
    ...extra,
  } as StudioLayoutV2;
}

/** The inner markup of every <text> element in an SVG. */
const textBodies = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]);

/** The leftmost and rightmost dark column between two rows. */
function inkColumns(png: Buffer, y0: number, y1: number): { left: number; right: number } {
  const img = PNG.sync.read(png);
  let left = Infinity;
  let right = -Infinity;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(img.height, Math.ceil(y1)); y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4] < 128) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { left, right };
}

describe('text markup the rasteriser cannot misread', () => {
  it('puts no whitespace between tspans and no whitespace-only text inside <text>', () => {
    const { svg } = inlinedSvgOf(
      layoutWith([
        { align: 'center' },
        { align: 'right', y: 300, accentColor: '#F7B500', accentText: 'Quality' },
        { align: 'right', y: 420, rtl: true, fontFamily: 'Noto Sans Arabic' },
      ]),
      {
        copyText: {
          0: 'Kurdistan Accrediting Agency for Education and Quality Assurance',
          1: 'Mandatory Quality Standards for every institution',
          2: 'دەستەی متمانەپێدانی کوردستان بۆ پەروەردە ٢٠٢٦ KAAE',
        },
      }
    );
    const bodies = textBodies(svg);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).not.toMatch(/^\s/);
      expect(body).not.toMatch(/\s$/);
      expect(body).not.toMatch(/>\s+</);
    }
  });

  it('sets right-to-left lines as U+202B … U+202C with left-to-right anchors, not direction="rtl"', () => {
    const copy = 'دەستەی متمانەپێدانی کوردستان بۆ پەروەردە ٢٠٢٦ KAAE';
    const cases = [
      { align: 'right' as const, anchor: 'end', x: 900 },
      { align: 'center' as const, anchor: 'middle', x: 500 },
      { align: 'left' as const, anchor: 'start', x: 100 },
    ];
    for (const c of cases) {
      const { svg } = inlinedSvgOf(layoutWith([{ align: c.align, rtl: true, fontFamily: 'Noto Sans Arabic', width: 800 }]), {
        copyText: { 0: copy },
      });
      expect(svg).not.toContain('direction=');
      expect(svg).toContain(`text-anchor="${c.anchor}"`);
      const spans = [...svg.matchAll(/<tspan x="([\d.]+)"[^>]*>([^<]*)<\/tspan>/g)];
      expect(spans.length).toBeGreaterThan(0);
      for (const [, x, content] of spans) {
        expect(Number(x)).toBe(c.x);
        expect(content.startsWith('\u202B')).toBe(true);
        expect(content.endsWith('\u202C')).toBe(true);
      }
    }
  });

  it('draws a centred and an end-anchored line where the box and the font say (7 and 14 px off before)', () => {
    const copy = 'Accreditation Standards Office Hours';
    const width = 560;
    for (const align of ['center', 'right'] as const) {
      const layout = layoutWith([{ align, width, x: 200 }]);
      const { png, svg } = renderLayoutV2(layout, { copyText: { 0: copy } });
      const first = /<tspan x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/tspan>/.exec(svg)!;
      const lineY = Number(first[2]);
      const line = first[3];
      expect(svg.match(/<tspan /g)!.length).toBeGreaterThan(1); // the first line is followed by another

      const font = fk.openSync(fontFileFor('Verdana', false, false)!) as any;
      const run = font.layout(line);
      const scale = 40 / font.unitsPerEm;
      const advance = run.advanceWidth * scale;
      const anchorX = align === 'center' ? 200 + width / 2 : 200 + width;
      const start = align === 'center' ? anchorX - advance / 2 : anchorX - advance;
      const expectLeft = start + run.bbox.minX * scale;
      const expectRight = start + run.bbox.maxX * scale;

      const ink = inkColumns(png, lineY - 32, lineY + 10);
      expect(Math.abs(ink.left - expectLeft), `${align}: ink starts at ${ink.left}, font says ${expectLeft.toFixed(1)}`).toBeLessThan(2);
      expect(Math.abs(ink.right - expectRight), `${align}: ink ends at ${ink.right}, font says ${expectRight.toFixed(1)}`).toBeLessThan(2);
    }
  });

  it('operations-to-svg: a blank line is spacing on the next line, not a whitespace-only tspan', () => {
    const svg = renderOperationsToSvg(
      [
        {
          op: 'addText', nodeId: 'body', pageId: 'p1', role: 'body',
          text: 'First paragraph\n\nSecond paragraph',
          x: 40, y: 40, width: 1000, height: 400,
          style: { fontSize: 20, lineHeight: 1.5 },
        },
      ] as any,
      1080,
      1350
    );
    const [body] = textBodies(svg);
    expect(body).not.toMatch(/>\s+</);
    expect(body).not.toMatch(/<tspan[^>]*>\s+<\/tspan>/);
    const dys = [...body.matchAll(/dy="([\d.]+)"/g)].map((m) => Number(m[1]));
    // The second paragraph sits a line plus the blank line's 0.8 of a line below the first, as before.
    expect(dys).toEqual([0, 30 + 24]);
  });
});

describe('image types from magic bytes', () => {
  const png = fs.readFileSync(new URL('../assets/logos/kaae-official-logo.png', import.meta.url));
  const jpeg = fs.readFileSync(new URL('./fixtures/red-left-blue-right.jpg', import.meta.url));
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(18)]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
  const svgLogo = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

  it('names PNG, JPEG, WebP, GIF and SVG by their bytes and nothing else', () => {
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(webp)).toBe('image/webp');
    expect(sniffImageType(gif)).toBe('image/gif');
    expect(sniffImageType(svgLogo)).toBe('image/svg+xml');
    expect(sniffImageType(Buffer.from('PK\u0003\u0004 not a picture'))).toBeUndefined();
    expect(relabelDataUri(`data:image/png;base64,${jpeg.toString('base64')}`).startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('types the art, the logo and the photos from their bytes, whatever the file is called or declared', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-image-type-'));
    try {
      const artJpgHoldingPng = path.join(dir, 'art.jpg');
      fs.writeFileSync(artJpgHoldingPng, png);
      const logoPngHoldingSvg = path.join(dir, 'logo.png');
      fs.writeFileSync(logoPngHoldingSvg, svgLogo);
      const layout = layoutWith([], {
        art: { box: { x: 0, y: 0, width: 1000, height: 600 }, opacity: 1 } as any,
        logo: { x: 20, y: 20, width: 100, height: 100 },
        photos: [{ photoIndex: 0, role: 'portrait', x: 600, y: 200, width: 200, height: 200 }] as any,
      });
      const { svg } = inlinedSvgOf(layout, {
        artImagePath: artJpgHoldingPng,
        logoPath: logoPngHoldingSvg,
        photoDataUris: [`data:image/png;base64,${jpeg.toString('base64')}`],
      });
      expect(/<image id="art-layer" xlink:href="data:([^;]+);/.exec(svg)?.[1]).toBe('image/png');
      expect(/<image id="logo" xlink:href="data:([^;]+);/.exec(svg)?.[1]).toBe('image/svg+xml');
      expect(/<image id="photo-0" xlink:href="data:([^;]+);/.exec(svg)?.[1]).toBe('image/jpeg');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns a JPEG upright even when it was declared as a PNG', async () => {
    const exif = Buffer.from('45786966000' + '04d4d002a00000008000101120003000000010006000000000000', 'hex');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(exif.length + 2);
    const tagged = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, exif, jpeg.subarray(2)]);
    const upright = await uprightPhotoDataUrl(`data:image/png;base64,${tagged.toString('base64')}`);
    const pixels = PNG.sync.read(Buffer.from(upright.split(',')[1], 'base64'));
    expect([pixels.width, pixels.height]).toEqual([8, 16]);
  });
});

describe('the logo is scaled once per logo and size, not on every render', () => {
  const box = { x: 80, y: 60, width: 160, height: 120 };
  const layout = () => layoutWith([], { logo: { ...box }, background: { color: '#0A1628' } });
  // A render draws only the logo it is handed (ADR-038: there is no KAAE default any more).
  const kaae = { logoDataUri: getKaaeOfficialLogoDataUri() };

  it('embeds the logo at the size it is drawn, and reuses it', () => {
    const before = logoPrescaleStats();
    const a = inlinedSvgOf(layout(), kaae).svg;
    const b = inlinedSvgOf(layout(), kaae).svg;
    const after = logoPrescaleStats();
    const href = /<image id="logo" xlink:href="data:image\/png;base64,([^"]+)"/.exec(a)?.[1];
    expect(href).toBeDefined();
    const img = PNG.sync.read(Buffer.from(href!, 'base64'));
    expect([img.width, img.height]).toEqual([160, 120]);
    expect(b).toBe(a);
    expect(after.scaled - before.scaled).toBeLessThanOrEqual(1);
    expect(after.reused - before.reused).toBeGreaterThanOrEqual(1);
  });

  it('draws the same pixels as scaling the full-size logo inside the design', async () => {
    // Both logos are files beside the SVG (ADR-035): the full-size one as a data URI is 2 MB.
    const { svg, noTextSvg, files } = renderLayoutV2ToSvg(layout(), kaae);
    const original = Buffer.from(getKaaeOfficialLogoDataUri().split(',')[1], 'base64');
    const unscaled = svg.replace(
      /<image id="logo"[^>]*\/>/,
      `<image id="logo" xlink:href="logo-full.png" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" preserveAspectRatio="xMidYMid meet"/>`
    );
    expect(unscaled).not.toBe(svg);
    const [now, then] = await Promise.all([
      svgToPngAsync(svg, 1000, 600, undefined, files),
      svgToPngAsync(unscaled, 1000, 600, undefined, { ...files, 'logo-full.png': original }),
    ]);
    const diff = comparePngBuffers(now, then);
    expect(diff.diffPixels, `${diff.diffPixels} of ${diff.totalPixels} pixels differ by more than 5`).toBe(0);
    expect(noTextSvg).toContain('id="logo"');
  });

  it('draws no logo it was not handed, and never KAAE\'s', () => {
    const { svg } = inlinedSvgOf(layout(), {});
    expect(svg).not.toContain('<image id="logo"');
    expect(svg).toContain('id="logo-placeholder"');
    expect(svg).not.toContain('#F7B500');
    const kaaeBytes = getKaaeOfficialLogoDataUri().split(',')[1].slice(0, 200);
    expect(svg).not.toContain(kaaeBytes);
  });

  it('draws the logo of the client it renders for', () => {
    const other = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5" cx="5" cy="5"/></svg>').toString('base64')}`;
    const { svg } = inlinedSvgOf(layout(), { logoDataUri: other });
    expect(svg).toContain(`xlink:href="${other}"`);
  });

  it('leaves a vector logo as it is', () => {
    const vector = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>').toString('base64')}`;
    const { svg } = inlinedSvgOf(layout(), { logoDataUri: vector });
    expect(svg).toContain(`xlink:href="${vector}"`);
  });

  it('the async render pre-scales without blocking and gives the same bytes', async () => {
    const sync = renderLayoutV2(layout(), kaae);
    const async = await renderLayoutV2Async(layout(), kaae);
    expect(async.svg).toBe(sync.svg);
    expect(Buffer.compare(async.png, sync.png)).toBe(0);
  });
});

describe('the font check: rendered ink width against fontkit', () => {
  it('passes when rsvg draws the file the pipeline measures with', () => {
    for (const family of ['IBM Plex Sans Arabic', 'Amiri']) {
      const check = probeFontInkWidth(family);
      expect(check.measured, check.message).toBe(true);
      expect(check.ok, check.message).toBe(true);
      expect(check.fontFile).toBe(fontFileFor(family, false, false));
      expect(Math.abs(check.deviation)).toBeLessThan(0.02);
    }
  });

  it('fails, naming the file and both widths, when rsvg draws a different face than that file', () => {
    // The pipeline measures with Noto Sans Arabic's file while the rasteriser draws Amiri.
    const noto = path.join(FONTS, 'NotoSansArabic-Regular.ttf');
    const check = probeFontInkWidth('Amiri', { fontFile: noto });
    expect(check.measured).toBe(true);
    expect(check.ok).toBe(false);
    expect(check.message).toContain(noto);
    expect(check.message).toContain(`${check.renderedInkPx}px`);
    expect(check.message).toContain(`${check.expectedInkPx.toFixed(1)}px`);
  });

  it('marks the family a stand-in in the fidelity probe when the file beside the renderer is another face', () => {
    // A fonts folder whose NotoSansArabic-Regular.ttf is really Amiri: fontkit measures Amiri, while
    // the rasteriser still draws Noto Sans Arabic from the real folder. Before this check the probe
    // compared the render only with a family that cannot exist, and called this exact. The folder's
    // own fonts.conf is named explicitly: the renderer's default is now a generated file listing only
    // the folder itself, where this mismatch cannot arise.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-font-ink-'));
    try {
      fs.copyFileSync(path.join(FONTS, 'Amiri-Regular.ttf'), path.join(dir, 'NotoSansArabic-Regular.ttf'));
      fs.writeFileSync(
        path.join(dir, 'fonts.conf'),
        `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <dir>${FONTS}</dir>\n  <dir>/usr/share/fonts</dir>\n  <dir>/System/Library/Fonts</dir>\n  <dir>/System/Library/Fonts/Supplemental</dir>\n  <cachedir>${path.join(dir, 'cache')}</cachedir>\n</fontconfig>\n`
      );
      expect(probeFontFidelity('Noto Sans Arabic', { fontsDir: dir, fontconfigFile: path.join(dir, 'fonts.conf') })).toBe('stand-in');
      expect(probeFontFidelity('IBM Plex Sans Arabic', { fontsDir: FONTS })).toBe('exact');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Skipped on the Macs until pango was put on its fontconfig backend (PANGOCAIRO_BACKEND=fc): on
  // CoreText it never read FONTCONFIG_FILE, so a fontconfig swap could not reach the rasteriser.
  it('fails when fontconfig points the family at a different file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-font-swap-'));
    try {
      fs.copyFileSync(path.join(FONTS, 'Amiri-Regular.ttf'), path.join(dir, 'Amiri-Regular.ttf'));
      const conf = path.join(dir, 'fonts.conf');
      fs.writeFileSync(
        conf,
        `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <dir>${dir}</dir>\n  <cachedir>${path.join(dir, 'cache')}</cachedir>\n  <match target="pattern"><test name="family"><string>Noto Sans Arabic</string></test><edit name="family" mode="assign" binding="strong"><string>Amiri</string></edit></match>\n</fontconfig>\n`
      );
      const check = probeFontInkWidth('Noto Sans Arabic', { fontconfigFile: conf, fontsDir: FONTS });
      expect(check.measured).toBe(true);
      expect(check.ok, check.message).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
