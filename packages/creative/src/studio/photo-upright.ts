import { imagePixelSize, jpegOrientation } from './photo-crop.js';
import { svgToPngAsync, type RenderLayoutOptions } from './render-layout-v2.js';
import { dataUriBytes, sniffImageType } from './image-type.js';

/**
 * A client photo turned upright once, as it comes into a run, so everything after it (the brief's
 * look at it, the face detector, the cut-out, the crop, the preview and the Canva deck) sees the same
 * upright pixels. A phone photo is often stored on its side with an EXIF tag saying how to turn it;
 * the renderer ignored the tag, so the photo was drawn and baked sideways (2026-09-24 review).
 *
 * Only a JPEG whose tag says to turn it is redrawn, through the same rasteriser the renderer uses, as
 * a PNG; every other photo is returned as it came, unless it is too large to render (below).
 *
 * A redrawn photo is kept small enough to embed: rsvg refuses any attribute over 10,000,000 bytes, and
 * a 12 MP phone photo redrawn full size as PNG came to 16.7 MB, so every render of its design failed and
 * the run with them (review of 2026-09-24). The long side is held to UPRIGHT_MAX_SIDE, and smaller again
 * until the data URL fits PHOTO_DATA_URL_MAX. A photo sent as a large file that needs no turn is shrunk
 * the same way: embedded as it came it failed the renders too. The photo is read from a file beside the
 * SVG, not embedded in it, so a large one can be read at all.
 */

/** The longest side of a redrawn photo: a design uses a photo at most about this big. */
export const UPRIGHT_MAX_SIDE = 2048;
/** The largest photo data URL passed on to the renderer, well under rsvg's 10 MB attribute limit. */
export const PHOTO_DATA_URL_MAX = 7 * 1024 * 1024;

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

/** The length of the base64 data URL of `size` bytes labelled `mediaType`: what the 7 MB rule measured. */
export function dataUrlLength(size: number, mediaType: string): number {
  return `data:${mediaType};base64,`.length + 4 * Math.ceil(size / 3);
}

/**
 * The photo upright and small enough to render, as bytes (ADR-035: the renderer reads it as a file
 * beside the SVG). The decisions are the ones the data-URL form made: the 7 MB rule is measured on
 * the length the photo's data URL would have (`dataUrlLength`, or `declaredLength` when the caller
 * holds the data URL itself), so moving to files changes no pixels. Dropping that rule belongs to the
 * ADR-036 gate. `changed` is false, and the bytes are the ones given, when nothing needed doing.
 */
export async function uprightPhoto(
  bytes: Buffer,
  options?: RenderLayoutOptions,
  declaredLength?: number
): Promise<{ bytes: Buffer; mediaType: string; changed: boolean }> {
  // What the photo is comes from its bytes, not the type the sender declared: a JPEG declared as a
  // PNG kept its sideways EXIF turn, and its sibling file was named for the wrong decoder (ADR-036).
  const type = sniffImageType(bytes);
  const unchanged = { bytes, mediaType: type ?? 'application/octet-stream', changed: false };
  if (type !== 'image/jpeg' && type !== 'image/png') return unchanged;
  const isJpeg = type === 'image/jpeg';
  const size = imagePixelSize(bytes);
  if (!size) return unchanged;
  const orientation = isJpeg ? jpegOrientation(bytes) : 1;
  const matrix = orientationMatrix(orientation, size.width, size.height);
  if (!matrix && (declaredLength ?? dataUrlLength(bytes.length, type)) <= PHOTO_DATA_URL_MAX) return unchanged;
  const turned = orientation >= 5;
  const width = turned ? size.height : size.width;
  const height = turned ? size.width : size.height;
  const file = isJpeg ? 'photo.jpg' : 'photo.png';
  for (const side of [UPRIGHT_MAX_SIDE, 1536, 1024]) {
    const scale = Math.min(1, side / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${width} ${height}">` +
      `<image xlink:href="${file}" x="0" y="0" width="${size.width}" height="${size.height}" preserveAspectRatio="none"${matrix ? ` transform="${matrix}"` : ''}/>` +
      `</svg>`;
    const png = await svgToPngAsync(svg, w, h, options, { [file]: bytes });
    if (dataUrlLength(png.length, 'image/png') <= PHOTO_DATA_URL_MAX) return { bytes: png, mediaType: 'image/png', changed: true };
  }
  // Nothing small enough: the photo as it came, which renders unless it is itself too large.
  return unchanged;
}

/** uprightPhoto for a caller holding a data URL (the studio keeps them for model calls). */
export async function uprightPhotoDataUrl(dataUrl: string, options?: RenderLayoutOptions): Promise<string> {
  const bytes = dataUriBytes(dataUrl);
  if (!bytes) return dataUrl;
  const out = await uprightPhoto(bytes, options, dataUrl.length);
  return out.changed ? `data:${out.mediaType};base64,${out.bytes.toString('base64')}` : dataUrl;
}
