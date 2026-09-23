import { imagePixelSize, jpegOrientation } from './photo-crop.js';
import { svgToPngAsync, type RenderLayoutOptions } from './render-layout-v2.js';

/**
 * A client photo turned upright once, as it comes into a run, so everything after it (the brief's
 * look at it, the face detector, the cut-out, the crop, the preview and the Canva deck) sees the same
 * upright pixels. A phone photo is often stored on its side with an EXIF tag saying how to turn it;
 * the renderer ignored the tag, so the photo was drawn and baked sideways (2026-09-24 review).
 *
 * Only a JPEG whose tag says to turn it is redrawn, through the same rasteriser the renderer uses, as
 * a PNG of the upright size; every other photo is returned as it came.
 */

/** Where stored pixel (x, y) goes in the upright picture, per EXIF orientation, as an SVG matrix. */
function orientationMatrix(orientation: number, w: number, h: number): string | undefined {
  switch (orientation) {
    case 2: return `matrix(-1,0,0,1,${w},0)`;
    case 3: return `matrix(-1,0,0,-1,${w},${h})`;
    case 4: return `matrix(1,0,0,-1,0,${h})`;
    case 5: return `matrix(0,1,1,0,0,0)`;
    case 6: return `matrix(0,1,-1,0,${h},0)`;
    case 7: return `matrix(0,-1,-1,0,${h},${w})`;
    case 8: return `matrix(0,-1,1,0,0,${w})`;
    default: return undefined;
  }
}

export async function uprightPhotoDataUrl(dataUrl: string, options?: RenderLayoutOptions): Promise<string> {
  const m = /^data:image\/(jpe?g);base64,(.+)$/i.exec(dataUrl);
  if (!m) return dataUrl;
  const bytes = Buffer.from(m[2], 'base64');
  const orientation = jpegOrientation(bytes);
  const size = imagePixelSize(bytes);
  const matrix = size ? orientationMatrix(orientation, size.width, size.height) : undefined;
  if (!size || !matrix) return dataUrl;
  const turned = orientation >= 5;
  const width = turned ? size.height : size.width;
  const height = turned ? size.width : size.height;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image xlink:href="${dataUrl}" x="0" y="0" width="${size.width}" height="${size.height}" preserveAspectRatio="none" transform="${matrix}"/>` +
    `</svg>`;
  const png = await svgToPngAsync(svg, width, height, options);
  return `data:image/png;base64,${png.toString('base64')}`;
}
