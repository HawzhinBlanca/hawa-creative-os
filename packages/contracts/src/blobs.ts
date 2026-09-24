/**
 * The content-addressed file store (ADR-035): the parts Core, the worker and the renderer share.
 *
 * A picture or a design source is stored once, as a file named by the sha256 of its bytes, and rows
 * and payloads carry a small reference to it instead of the bytes. Nothing here touches the disk or
 * the database (that is packages/db/src/blobs), so any package can depend on it.
 */

/** The media types the store accepts, with the extension each file gets on disk. */
export const BLOB_MEDIA_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
} as const;

export type BlobMediaType = keyof typeof BLOB_MEDIA_TYPES;
export type BlobExtension = (typeof BLOB_MEDIA_TYPES)[BlobMediaType];

/** The largest file the store takes; the same bound as the CHECK on hawa.blobs.size (migration 019). */
export const BLOB_MAX_BYTES = 100 * 1024 * 1024;

/** What a row or a payload carries instead of the bytes: about 110 bytes as JSON. */
export interface BlobRef {
  sha256: string;
  mediaType: BlobMediaType;
  size: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

export function isBlobMediaType(value: unknown): value is BlobMediaType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BLOB_MEDIA_TYPES, value);
}

export function blobExtension(mediaType: BlobMediaType): BlobExtension {
  if (!isBlobMediaType(mediaType)) throw new Error(`Not a blob media type: ${String(mediaType)}`);
  return BLOB_MEDIA_TYPES[mediaType];
}

/**
 * A reference read from untrusted JSON (a payload, a request body): returned only when every field is
 * well formed, so a hash can never carry a path separator into a file name or a redirect.
 */
export function parseBlobRef(value: unknown): BlobRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!isSha256Hex(v.sha256) || !isBlobMediaType(v.mediaType)) return undefined;
  if (typeof v.size !== 'number' || !Number.isInteger(v.size) || v.size < 1 || v.size > BLOB_MAX_BYTES) return undefined;
  return { sha256: v.sha256, mediaType: v.mediaType, size: v.size };
}

/**
 * The file's path relative to the store root: `sha256/<first two hex>/<hex>.<ext>`. Built only from a
 * checked hash and the extension map, never from anything a caller spelled.
 */
export function blobRelPath(ref: Pick<BlobRef, 'sha256' | 'mediaType'>): string {
  if (!isSha256Hex(ref.sha256)) throw new Error('A blob hash must be 64 lowercase hex characters');
  return `sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}.${blobExtension(ref.mediaType)}`;
}

/**
 * The media type the bytes themselves say they are, from their first bytes, or undefined. A PPTX is a
 * ZIP, so any ZIP passes as one: the check stops a JPEG stored as a PNG, not a ZIP stored as a PPTX.
 */
export function sniffBlobMediaType(bytes: Uint8Array): BlobMediaType | undefined {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return undefined;
}
