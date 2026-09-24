/**
 * The type of an image, read from its first bytes.
 *
 * The renderer used to take it from the file name (`art.png` → PNG, anything else → JPEG; `logo.svg`
 * → SVG, anything else → PNG) or from the MIME type the sender declared. Neither says what the bytes
 * are: a phone sends a JPEG named `.png`, a client uploads a PNG the chat declares as JPEG, and
 * librsvg picks its decoder from the declared type, so a mislabelled picture is either decoded by the
 * wrong loader or dropped without an error (ADR-036 section 2.1). The bytes are the only witness.
 */

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';

/** PNG, JPEG, WebP and GIF by their signatures; SVG by its opening markup. Undefined for anything else. */
export function sniffImageType(bytes: Buffer | Uint8Array | undefined | null): ImageType | undefined {
  if (!bytes || bytes.length < 4) return undefined;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  // SVG is text: a byte-order mark, then whitespace, an XML declaration, comments or a doctype may
  // come before the root element. Only the head is read.
  const head = b.toString('utf8', 0, Math.min(b.length, 2048)).replace(/^﻿/, '');
  if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return undefined;
}

/** The file extension rsvg expects beside an SVG for this type. */
export function imageFileExtension(type: ImageType): 'png' | 'jpg' | 'webp' | 'gif' | 'svg' {
  switch (type) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/svg+xml': return 'svg';
  }
}

/** A base64 data URI for image bytes, typed from the bytes. Throws when they are not an image we know. */
export function imageDataUri(bytes: Buffer, what = 'image'): string {
  const type = sniffImageType(bytes);
  if (!type) throw new Error(`${what} is not a PNG, JPEG, WebP, GIF or SVG (first bytes ${bytes.subarray(0, 8).toString('hex')})`);
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/** The bytes of a base64 data URI, or undefined when it is not one. */
export function dataUriBytes(uri: string): Buffer | undefined {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return undefined;
  return Buffer.from(uri.slice(comma + 1), 'base64');
}

/**
 * The same base64 data URI with its declared type replaced by the one its bytes carry. Only the first
 * bytes are decoded, so a large photo is not copied to learn its type. A URI that is not base64, or
 * whose bytes are not a known image, is returned as it came: nothing better can be said about it.
 */
export function relabelDataUri(uri: string): string {
  if (!uri || !uri.startsWith('data:')) return uri;
  const comma = uri.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return uri;
  // 2,732 base64 characters decode to 2,049 bytes: enough for every signature, including an SVG head.
  const head = Buffer.from(uri.slice(comma + 1, comma + 1 + 2732), 'base64');
  const type = sniffImageType(head);
  if (!type) return uri;
  const declared = uri.slice(5, comma).replace(/;base64$/i, '').toLowerCase();
  if (declared === type) return uri;
  return `data:${type};base64,${uri.slice(comma + 1)}`;
}
