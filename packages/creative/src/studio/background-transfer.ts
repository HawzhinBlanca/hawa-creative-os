import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { backgroundFieldDrawingMl, type BackgroundField } from './background-field.js';

export const BACKGROUND_FIELD_OBJECT = 'Hawa background field';

/** Replace exactly one encoder-owned placeholder; never inject untrusted OOXML. */
export function encodeNativeBackgroundField(bytes: Buffer, field: BackgroundField | undefined): Buffer {
  if (!field) return bytes;
  const gradient = backgroundFieldDrawingMl(field);
  const files = unzipSync(bytes);
  const path = 'ppt/slides/slide1.xml';
  if (!files[path]) throw new Error('BACKGROUND_TRANSFER: slide missing');
  let replaced = 0;
  const xml = strFromU8(files[path]).replace(/<p:sp>[^]*?<\/p:sp>/g, shape => {
    if (!shape.includes(`name="${BACKGROUND_FIELD_OBJECT}"`)) return shape;
    const fills = shape.match(/<a:solidFill>[^]*?<\/a:solidFill>/g) ?? [];
    // The first fill is the shape's own; a line can carry another. Require the placeholder.
    const firstFill = fills[0];
    if (!firstFill) throw new Error('BACKGROUND_TRANSFER: placeholder fill missing');
    replaced++;
    return shape.replace(firstFill, gradient);
  });
  if (replaced !== 1) throw new Error('BACKGROUND_TRANSFER: expected exactly one native field');
  files[path] = strToU8(xml);
  return Buffer.from(zipSync(files));
}
