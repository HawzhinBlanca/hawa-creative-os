import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { expectedArtFrame, planArtRegion, landArtRegion, photoCropPlacement, layoutPlacements } from '../src/studio/placement-map.js';
import { canvasBoxToArtPixels } from '../src/studio/art-generator-v3.js';
import { coverCrop } from '../src/studio/photo-crop.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2, PhotoElement } from '../src/studio/layout-v2.js';

// ADR-123: a region the layout reserves is described to the image provider in the provider's own
// frame, and checked against where the renderer's cover crop actually puts it.
const box = { x: 0, y: 0, width: 1080, height: 1350 };
const bottom = { x: 0, y: 945, width: 1080, height: 405 };

function twoColourPng(width: number, height: number, inside: (x: number, y: number) => boolean): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, red = inside(x, y);
    png.data[i] = red ? 220 : 20; png.data[i + 1] = 20; png.data[i + 2] = red ? 20 : 220; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
/** The renderer refuses a layout without the client's actual logo; a small synthetic one sits in the corner. */
const logoDataUri = () => `data:image/png;base64,${twoColourPng(8, 8, () => false).toString('base64')}`;
const layout = (art: StudioLayoutV2['art'], photos: PhotoElement[] = []): StudioLayoutV2 => ({
  version: 2, width: 1080, height: 1350, grid: { margin: 60, columns: 6, gutter: 24, baseline: 8 },
  background: { color: '#FFFFFF' }, shapes: [], text: [], logo: { x: 0, y: 0, width: 8, height: 8 }, ...(art ? { art } : {}), photos,
});

describe('provider frame and reserved region mapping', () => {
  it('reads the frame the provider is actually asked for', () => {
    expect(expectedArtFrame({ provider: 'openai', size: '1024x1024', aspectRatio: '1:1' }, box)).toEqual({ width: 1024, height: 1024, assumed: false });
    expect(expectedArtFrame({ provider: 'openai', size: '1536x1024', aspectRatio: '1:1' }, box)).toEqual({ width: 1536, height: 1024, assumed: false });
    expect(expectedArtFrame({ provider: 'google', size: '1K', aspectRatio: '16:9' }, box)).toEqual({ width: 16, height: 9, assumed: false });
    expect(expectedArtFrame({ provider: 'openai', size: 'auto', aspectRatio: '1:1' }, box)).toEqual({ width: 1080, height: 1350, assumed: true });
  });

  it('describes the calm region in the provider frame after the renderer cover crop', () => {
    const plan = planArtRegion({ box, calmRegion: bottom }, { width: 1024, height: 1024, assumed: false });
    // 1024 square covering 1080x1350: scale 1350/1024, 135 layout px lost from each side.
    expect(plan.prompted!.x).toBeCloseTo(0.1, 6); expect(plan.prompted!.y).toBeCloseTo(0.7, 6);
    expect(plan.prompted!.width).toBeCloseTo(0.8, 6); expect(plan.prompted!.height).toBeCloseTo(0.3, 6);
    expect(plan.description).toBe('from 10% to 90% across and 70% to 100% down the image');
    expect(plan.aspect).toBe('1:1');
    const legacy = canvasBoxToArtPixels(bottom, box, { width: 1024, height: 1024 });
    expect(plan.prompted!.x * 1024).toBeCloseTo(legacy.x, 6); expect(plan.prompted!.y * 1024).toBeCloseTo(legacy.y, 6);
  });

  it('checks the generated output and the final layout against the prompted region', () => {
    const plan = planArtRegion({ box, calmRegion: bottom }, { width: 1024, height: 1024, assumed: false });
    expect(landArtRegion({ box, calmRegion: bottom }, { width: 1024, height: 1024 }, plan)).toMatchObject({ status: 'landed_as_prompted', containedShare: 1 });
    // The provider returned another frame: the words it was given described a different area.
    expect(landArtRegion({ box, calmRegion: bottom }, { width: 1536, height: 1024 }, plan)).toMatchObject({ status: 'frame_mismatch' });
    // A later layout moved the text area to the top after the art was made for the bottom.
    const moved = landArtRegion({ box, calmRegion: { x: 0, y: 0, width: 1080, height: 405 } }, { width: 1024, height: 1024 }, plan);
    expect(moved).toMatchObject({ status: 'moved', containedShare: 0 });
    expect(landArtRegion({ box, calmRegion: bottom }, null, plan)).toMatchObject({ status: 'unreadable', landed: null });
    expect(landArtRegion({ box, calmRegion: bottom }, { width: 1024, height: 1024 }, undefined)).toMatchObject({ status: 'not_prompted' });
    // An assumed frame is verified by the output it produced.
    const assumed = planArtRegion({ box, calmRegion: bottom }, { width: 1080, height: 1350, assumed: true });
    expect(landArtRegion({ box, calmRegion: bottom }, { width: 1024, height: 1024 }, assumed)).toMatchObject({ status: 'frame_mismatch' });
  });

  it('is what the real rasteriser draws where the calm region lands', () => {
    const plan = planArtRegion({ box, calmRegion: bottom }, { width: 1024, height: 1024, assumed: false });
    const p = plan.prompted!;
    const art = twoColourPng(1024, 1024, (x, y) => x >= p.x * 1024 && x < (p.x + p.width) * 1024 && y >= p.y * 1024);
    const result = renderLayoutV2(layout({ source: 'generated', box, calmRegion: bottom, opacity: 1 }), { logoDataUri: logoDataUri(), artImagePath: `data:image/png;base64,${art.toString('base64')}` });
    expect(result.placements.art).toMatchObject({ output: { width: 1024, height: 1024 }, status: 'not_prompted', crop: coverCrop(box, { width: 1024, height: 1024 }) });
    expect(result.placements.art!.landed!.y).toBeCloseTo(0.7, 6);
    const drawn = PNG.sync.read(result.noTextPng);
    const at = (x: number, y: number) => { const i = (y * drawn.width + x) * 4; return [drawn.data[i], drawn.data[i + 2]]; };
    for (const [x, y] of [[20, 960], [540, 1340], [1060, 1000]]) expect(at(x, y)[0]).toBeGreaterThan(180);
    for (const [x, y] of [[20, 920], [540, 400], [1060, 900]]) expect(at(x, y)[1]).toBeGreaterThan(180);
  });
});

describe('declared photo crop focus', () => {
  const portrait: PhotoElement = { photoIndex: 0, role: 'portrait', x: 100, y: 100, width: 400, height: 400, focus: { x: 0.5, y: 0.1 } };
  it('records the focus crop the renderer applies and says when it cannot apply it', () => {
    expect(photoCropPlacement(portrait, { width: 400, height: 800 }, true)).toMatchObject({
      mode: 'cover', focusApplied: true, crop: coverCrop(portrait, { width: 400, height: 800 }, portrait.focus),
    });
    expect(photoCropPlacement(portrait, null, true)).toMatchObject({ mode: 'centred_unknown_size', focusApplied: false, crop: null });
    expect(photoCropPlacement({ ...portrait, focus: undefined }, null, true)).toMatchObject({ mode: 'centred_unknown_size', focusApplied: true });
    expect(photoCropPlacement(portrait, null, false)).toMatchObject({ mode: 'missing', focusApplied: false });
    expect(photoCropPlacement({ ...portrait, treatment: 'cutout' }, { width: 400, height: 800 }, true)).toMatchObject({ mode: 'cutout', crop: null });
  });

  it('reports the placements from the render for the photo bytes it drew', () => {
    const photo = twoColourPng(400, 800, (_x, y) => y < 200);
    const placed = layoutPlacements(layout(undefined, [portrait]), { photos: [photo] });
    expect(placed.photos[0]).toMatchObject({ photoIndex: 0, mode: 'cover', focusApplied: true, source: { width: 400, height: 800 } });
    expect(placed.photos[0].crop!.sy).toBe(0);
    const rendered = renderLayoutV2(layout(undefined, [portrait]), { logoDataUri: logoDataUri(), photoFiles: [{ bytes: photo, mediaType: 'image/png' }] });
    expect(rendered.placements.photos).toEqual(placed.photos);
    const drawn = PNG.sync.read(rendered.noTextPng);
    // Source rows 0..199 are red; the focus crop starts at row 0, a centred crop at row 200.
    const i = (200 * drawn.width + 300) * 4;
    expect(drawn.data[i]).toBeGreaterThan(180);
  });
});
