import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { unzipSync, strFromU8 } from 'fflate';
import { encodeStudioTransferV2, scrimShapesForBox } from '../src/studio/transfer-v2.js';
import { artFrameForBox, canvasBoxToArtPixels } from '../src/studio/art-generator-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import deadBandFixture from './fixtures/cheap-tier-dead-band-8fb76534.json' with { type: 'json' };

/** A solid PNG of the given pixel size, so the encoder reads a real IHDR. */
function solidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 30;
    png.data[i + 1] = 54;
    png.data[i + 2] = 93;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function slideXml(bytes: Buffer): string {
  return strFromU8(unzipSync(new Uint8Array(bytes))['ppt/slides/slide1.xml']);
}

/** pptxgenjs writes geometry in EMU: 914400 per inch, and the layout is 96px to the inch. */
function emu(px: number): number {
  return Math.round((px / 96) * 914400);
}

const STORY: StudioLayoutV2 = {
  version: 2,
  width: 1080,
  height: 1920,
  grid: { margin: 64, columns: 12, gutter: 16, baseline: 8 },
  background: { color: '#0A1628' },
  shapes: [],
  logo: { x: 64, y: 64, width: 200, height: 80 },
  text: [
    {
      copyIndex: 0,
      role: 'title',
      x: 64,
      y: 800,
      width: 952,
      height: 200,
      fontSize: 64,
      lineHeight: 1.3,
      fontFamily: 'Cinzel',
      color: '#FFFFFF',
      align: 'center',
      bold: true,
    },
  ],
};

const COPY = ['Annual Assembly 2026'];

describe('the art layer reaches the deck as the renderer draws it', () => {
  it('crops a square art image to the canvas box instead of stretching it', async () => {
    // The renderer draws the art with preserveAspectRatio="xMidYMid slice": the image covers the
    // box and the overflow is cropped evenly. gpt-image-2.5-sunburst returns 1024x1024 on the dev
    // tier that production runs, so on this 9:16 story a stretched placement squeezes every feature
    // by 1920/1080 = 1.78x against the judged preview.
    const layout: StudioLayoutV2 = {
      ...STORY,
      art: {
        source: 'generated',
        prompt: 'Abstract architectural line geometry',
        box: { x: 0, y: 0, width: 1080, height: 1920 },
        opacity: 0.3,
        calmRegion: { x: 64, y: 700, width: 952, height: 400 },
      },
    };

    const encoded = await encodeStudioTransferV2(layout, COPY, undefined, {
      artBuffer: solidPng(512, 512),
    });
    const xml = slideXml(encoded.bytes);

    // Covering a 9:16 box with a 1:1 image keeps the central 1080/1920 = 56.25% of its width:
    // 21.875% is cropped from each side, and nothing from the top or bottom.
    expect(xml).toContain('<a:srcRect l="21875" r="21875" t="0" b="0"/>');
    expect(xml).not.toContain('<a:stretch><a:fillRect/></a:stretch>');
    // The placed extent is the art box itself, so the image still fills the canvas.
    expect(xml).toContain(`<a:ext cx="${emu(1080)}" cy="${emu(1920)}"/>`);
  });

  it('leaves art already drawn at the box aspect uncropped', async () => {
    // Procedural motifs are rendered at the art box's own size (art.stage), so cover must be a
    // no-op for them: any crop here would be a regression the motif lane would pay for.
    const layout: StudioLayoutV2 = {
      ...STORY,
      art: {
        source: 'procedural',
        motif: 'thin-rules',
        box: { x: 0, y: 960, width: 1080, height: 960 },
        opacity: 0.4,
        calmRegion: { x: 64, y: 1000, width: 952, height: 400 },
      },
    };

    const encoded = await encodeStudioTransferV2(layout, COPY, undefined, {
      artBuffer: solidPng(1080, 960),
    });
    const xml = slideXml(encoded.bytes);

    expect(xml).toContain('<a:srcRect l="0" r="0" t="0" b="0"/>');
    expect(xml).toContain(`<a:ext cx="${emu(1080)}" cy="${emu(960)}"/>`);
  });

  it('carries the art layer opacity once, as the render applies it', async () => {
    const layout: StudioLayoutV2 = {
      ...STORY,
      art: {
        source: 'procedural',
        motif: 'guilloche',
        box: { x: 0, y: 0, width: 1080, height: 1920 },
        opacity: 0.35,
        calmRegion: { x: 64, y: 700, width: 952, height: 400 },
      },
    };

    const encoded = await encodeStudioTransferV2(layout, COPY, undefined, {
      artBuffer: solidPng(1080, 1920),
    });
    // transparency 65% -> alphaModFix amt = (100 - 65) * 1000.
    expect(slideXml(encoded.bytes)).toContain('<a:alphaModFix amt="35000"/>');
  });
});

describe('the declared art scrim reaches the deck', () => {
  const withScrim: StudioLayoutV2 = {
    ...STORY,
    art: {
      source: 'generated',
      prompt: 'Abstract architectural line geometry',
      box: { x: 0, y: 0, width: 1080, height: 1920 },
      opacity: 0.3,
      scrim: {
        color: '#123456',
        opacityStart: 0.8,
        opacityEnd: 0.0,
        direction: 'vertical',
      },
      calmRegion: { x: 64, y: 700, width: 952, height: 400 },
    },
  };

  it('writes the scrim into the slide in its own colour and opacities', async () => {
    const encoded = await encodeStudioTransferV2(withScrim, COPY, undefined, {
      artBuffer: solidPng(512, 512),
    });
    const xml = slideXml(encoded.bytes);

    // The scrim colour appears nowhere else in this layout, so finding it proves the scrim shipped.
    expect(xml).toContain('<a:srgbClr val="123456">');

    const bands = scrimShapesForBox(withScrim.art!.box, withScrim.art!.scrim!);
    expect(bands.length).toBeGreaterThan(1);
    for (const band of bands) {
      const alpha = (100 - Math.round((1 - band.opacity) * 100)) * 1000;
      expect(xml).toContain(`<a:alpha val="${alpha}"/>`);
    }
    // Top band darkest, bottom band lightest: the ramp runs the way the gradient does.
    expect(bands[0].opacity).toBeGreaterThan(bands[bands.length - 1].opacity);
    expect(bands[0].y).toBe(0);
  });

  it('draws the scrim even when no art image was produced, as the renderer does', async () => {
    const encoded = await encodeStudioTransferV2(withScrim, COPY);
    expect(slideXml(encoded.bytes)).toContain('<a:srgbClr val="123456">');
  });

  it('tiles a vertical scrim across the whole box with no gaps and no overlap', () => {
    const bands = scrimShapesForBox(
      { x: 0, y: 100, width: 1080, height: 900 },
      { color: '#0A1628', opacityStart: 0.6, opacityEnd: 0.1, direction: 'vertical' }
    );
    expect(bands[0].y).toBe(100);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].y).toBe(bands[i - 1].y + bands[i - 1].height);
      expect(bands[i].x).toBe(0);
      expect(bands[i].width).toBe(1080);
    }
    const last = bands[bands.length - 1];
    expect(last.y + last.height).toBe(1000);
  });

  it('samples a horizontal scrim along x', () => {
    const bands = scrimShapesForBox(
      { x: 40, y: 0, width: 800, height: 600 },
      { color: '#0A1628', opacityStart: 0.0, opacityEnd: 0.5, direction: 'horizontal' }
    );
    expect(bands[0].x).toBe(40);
    expect(bands[bands.length - 1].x + bands[bands.length - 1].width).toBe(840);
    expect(bands[0].opacity).toBeLessThan(bands[bands.length - 1].opacity);
    for (const band of bands) {
      expect(band.y).toBe(0);
      expect(band.height).toBe(600);
    }
  });

  it('collapses a flat scrim to a single rectangle', () => {
    const bands = scrimShapesForBox(
      { x: 0, y: 0, width: 100, height: 100 },
      { color: '#0A1628', opacityStart: 0.4, opacityEnd: 0.4, direction: 'vertical' }
    );
    expect(bands).toEqual([
      { kind: 'rect', x: 0, y: 0, width: 100, height: 100, color: '#0A1628', opacity: 0.4 },
    ]);
  });

  it('builds a centre-dark radial scrim so the composited alpha follows the gradient', () => {
    const shapes = scrimShapesForBox(
      { x: 0, y: 0, width: 1000, height: 1000 },
      { color: '#0A1628', opacityStart: 0.8, opacityEnd: 0.1, direction: 'radial' }
    );
    // Outside the inscribed ellipse an SVG radial gradient clamps to its last stop, so a base
    // rectangle carries it and the ellipses stack inward.
    expect(shapes[0]).toMatchObject({ kind: 'rect', x: 0, y: 0, width: 1000, height: 1000, opacity: 0.1 });
    const ellipses = shapes.filter((s) => s.kind === 'ellipse');
    expect(ellipses.length).toBeGreaterThan(1);
    // Painting the same colour repeatedly gives 1 - product(1 - alpha); at the centre that must
    // land on the innermost sample of the ramp, 0.8 - 0.7/(2 x 12 steps).
    const centre = shapes.reduce((acc, s) => acc + s.opacity * (1 - acc), 0);
    expect(centre).toBeCloseTo(0.8 - 0.7 / 24, 6);
    // Each ellipse is concentric with the box and smaller than the one before it.
    for (let i = 1; i < ellipses.length; i++) {
      expect(ellipses[i].width).toBeLessThan(ellipses[i - 1].width);
      expect(ellipses[i].x + ellipses[i].width / 2).toBeCloseTo(500, 6);
      expect(ellipses[i].y + ellipses[i].height / 2).toBeCloseTo(500, 6);
    }
  });
});

describe('a delivered design, as it was stored', () => {
  // The winner of task 8fb76534: a 1080x1350 canvas whose art layer is the whole canvas at 0.25.
  const stored = deadBandFixture as { copy: string[]; layout: StudioLayoutV2 };

  it('crops the square art the image model returns into the stored 4:5 canvas', async () => {
    const encoded = await encodeStudioTransferV2(structuredClone(stored.layout), stored.copy, undefined, {
      // What gpt-image-2.5-sunburst returns on the dev tier this run used.
      artBuffer: solidPng(1024, 1024),
    });
    const xml = slideXml(encoded.bytes);

    // Covering 1080x1350 with a 1:1 image keeps the central 1080/1350 = 80% of its width.
    expect(xml).toContain('<a:srcRect l="10000" r="10000" t="0" b="0"/>');
    expect(xml).toContain(`<a:ext cx="${emu(1080)}" cy="${emu(1350)}"/>`);
    // The stored layer opacity of 0.25 still travels with the image, applied once.
    expect(xml).toContain('<a:alphaModFix amt="25000"/>');
  });

  it('carries a scrim declared on that same stored design', async () => {
    const layout = structuredClone(stored.layout);
    layout.art!.scrim = { color: '#123456', opacityStart: 0.75, opacityEnd: 0.05, direction: 'vertical' };

    const encoded = await encodeStudioTransferV2(layout, stored.copy, undefined, {
      artBuffer: solidPng(1024, 1024),
    });
    const xml = slideXml(encoded.bytes);

    expect(xml).toContain('<a:srgbClr val="123456">');
    // The stored design's own two shapes, its three text frames, and the scrim's steps.
    const bands = scrimShapesForBox(layout.art!.box, layout.art!.scrim!);
    expect(xml.match(/<p:sp>/g)).toHaveLength(2 + 3 + bands.length);
  });
});

describe('the art is asked for in the frame it will be cropped into', () => {
  it('asks for a landscape frame for a landscape box, not a portrait one', () => {
    expect(artFrameForBox({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      size: '1536x1024',
      aspectDesc: '3:2 horizontal landscape',
    });
    expect(artFrameForBox({ x: 0, y: 0, width: 1080, height: 1920 })).toEqual({
      size: '1024x1536',
      aspectDesc: '2:3 vertical portrait',
    });
    expect(artFrameForBox({ x: 0, y: 0, width: 1080, height: 1080 })).toEqual({
      size: '1024x1024',
      aspectDesc: '1:1 square',
    });
  });

  it('reads the calm region where the cover crop actually puts it', () => {
    // A 1024x1024 image covering a 1080x1350 box is scaled by 1350/1024 and loses 1024 - 1080/1.318
    // = 204.8px of width, 102.4px from each side. The stretched mapping used to read from x = 0.
    const calm = canvasBoxToArtPixels(
      { x: 0, y: 0, width: 1080, height: 1350 },
      { x: 0, y: 0, width: 1080, height: 1350 },
      { width: 1024, height: 1024 }
    );
    expect(calm.x).toBeCloseTo(102.4, 1);
    expect(calm.y).toBeCloseTo(0, 6);
    expect(calm.width).toBeCloseTo(819.2, 1);
    expect(calm.height).toBeCloseTo(1024, 6);
  });

  it('is the identity when the art was drawn at its box size', () => {
    expect(
      canvasBoxToArtPixels({ x: 100, y: 200, width: 300, height: 400 }, { x: 0, y: 0, width: 1080, height: 960 }, { width: 1080, height: 960 })
    ).toEqual({ x: 100, y: 200, width: 300, height: 400 });
  });
});

describe('a design without an art layer is untouched', () => {
  it('adds no image, no crop and no extra shape', async () => {
    const layout: StudioLayoutV2 = {
      ...STORY,
      shapes: [
        { kind: 'rect', x: 64, y: 700, width: 952, height: 400, color: '#1E3A5F', role: 'panel' },
      ],
    };

    const encoded = await encodeStudioTransferV2(layout, COPY);
    const xml = slideXml(encoded.bytes);

    expect(xml).not.toContain('<p:pic>');
    expect(xml).not.toContain('<a:srcRect');
    // Exactly the declared panel and the one text frame: no scrim rectangles behind them.
    expect(xml.match(/<p:sp>/g)).toHaveLength(2);
    expect(encoded.manifest.artSha256).toBeNull();
  });
});
