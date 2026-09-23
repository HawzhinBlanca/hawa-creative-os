import type { PhotoFocus } from './layout-v2.js';

/**
 * Where a framed photo is cropped. A framed photo fills its box with the largest part of the
 * picture that has the box's shape. Until 2026-09-23 that part was always the middle, and a centred
 * crop of a tall portrait into a square or wide box cuts off the head. A face detector now supplies
 * a point of each photo to keep in view (`PhotoElement.focus`), and `coverCrop` is the one rule the
 * preview and the Canva transfer both crop by, so the design the judge scored and the design the
 * client edits show the same part of the photograph.
 *
 * The pixel-size readers live here, not in the transfer, because the renderer needs them too and
 * the transfer already imports the renderer.
 */

/** A rectangle of a source image, in the image's own pixels: what `coverCrop` keeps. */
export interface CoverCropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function positiveSize(s: { width: number; height: number }): boolean {
  return Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0;
}

/** A share of an axis, held to 0..1; anything that is not a number is the centre. */
function share(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/**
 * The part of an image that cover-fits a box: the box's aspect, as large as the image allows, and
 * placed so the focus point (a share of the image's width and height) is as near its centre as the
 * image's edges let it be. With no focus it is the centred crop, which is what SVG's
 * `xMidYMid slice` and pptxgenjs's `cover` sizing draw.
 *
 * A box or an image without a positive, finite size throws: there is nothing to crop, and drawing
 * the photo some other way would hide that.
 */
export function coverCrop(
  box: { width: number; height: number },
  image: { width: number; height: number },
  focus?: { x: number; y: number }
): CoverCropRect {
  if (!positiveSize(box)) throw new RangeError(`Photo box has no usable size: ${box.width}x${box.height}`);
  if (!positiveSize(image)) throw new RangeError(`Photo has no usable size: ${image.width}x${image.height}`);
  // Compared cross-multiplied, so an image with exactly the box's aspect keeps all of itself.
  const wider = image.width * box.height > image.height * box.width;
  const sw = wider ? Math.min(image.width, (image.height * box.width) / box.height) : image.width;
  const sh = wider ? image.height : Math.min(image.height, (image.width * box.height) / box.width);
  const place = (extent: number, kept: number, at: number | undefined) =>
    at === undefined ? (extent - kept) / 2 : Math.min(extent - kept, Math.max(0, share(at) * extent - kept / 2));
  return { sx: place(image.width, sw, focus?.x), sy: place(image.height, sh, focus?.y), sw, sh };
}

/**
 * A focus point a caller or a model supplied, made one the layout schema accepts: each share held
 * to 0..1, and anything that is not a pair of finite numbers dropped. A detector's 1.0000001 then
 * moves the crop by nothing, instead of failing the schema check and discarding the whole design.
 */
export function photoFocusOrUndefined(value: unknown): PhotoFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: share(x), y: share(y) };
}

/**
 * Pixel size of a PNG or a baseline/progressive JPEG, or null. Read from the header, not decoded.
 * These are the stored pixels: a JPEG's EXIF orientation is not applied.
 */
export function imagePixelSize(buffer: Buffer): { width: number; height: number } | null {
  const png = pngPixelSize(buffer);
  if (png) return png;
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    const len = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * The pixel size in a PNG's IHDR chunk, or null when the buffer is not a PNG. Read from the header
 * rather than decoded, because the only thing the deck needs from the art is its aspect.
 */
export function pngPixelSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Pixel size of the PNG or JPEG in a base64 `data:` URI, or null. The preview holds photos only as
 * data URIs, and a focused crop is computed in the photo's own pixels.
 */
export function dataUriPixelSize(uri: string): { width: number; height: number } | null {
  const comma = uri.indexOf(',');
  if (comma < 0 || !/^data:[^,]*;base64$/i.test(uri.slice(0, comma))) return null;
  return imagePixelSize(Buffer.from(uri.slice(comma + 1), 'base64'));
}
