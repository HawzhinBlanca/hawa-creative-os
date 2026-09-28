import { createHash } from 'node:crypto';
import { imagePixelSize } from './photo-crop.js';
import { sniffImageType, imageFileExtension } from './image-type.js';
import { svgToPngAsync } from './render-layout-v2.js';
import { uprightPhoto } from './photo-upright.js';

/** Prepared within the caller's frozen client scope. These pixels never enter shipping assets. */
export interface LayoutVisualInput {
  kind: 'approved_example' | 'content_photo';
  label: string;
  notes?: string;
  sourceSha256: string;
  dataUrl: string;
}

/** Reuse the admitted local renderer, with bounded dimensions and no remote fetch or model call. */
export async function layoutConditioningImage(bytes: Buffer): Promise<Pick<LayoutVisualInput, 'dataUrl' | 'sourceSha256'>> {
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const upright = await uprightPhoto(bytes);
  const type = sniffImageType(upright.bytes);
  const size = imagePixelSize(upright.bytes);
  if (!size || !type || !['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
    throw new Error('LAYOUT_VISUAL_INPUT_INVALID');
  }
  if (Math.max(size.width, size.height) <= 768 && upright.bytes.length <= 3 * 1024 * 1024) {
    return { sourceSha256, dataUrl: `data:${type};base64,${upright.bytes.toString('base64')}` };
  }
  const scale = Math.min(1, 768 / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const file = `input.${imageFileExtension(type)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}"><image xlink:href="${file}" width="${width}" height="${height}" preserveAspectRatio="none"/></svg>`;
  const png = await svgToPngAsync(svg, width, height, undefined, { [file]: upright.bytes });
  return { sourceSha256, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}
