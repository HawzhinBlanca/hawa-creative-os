/**
 * What a file sent on Telegram is, read from its bytes. Telegram's own mime_type is what the
 * sender's phone claimed, and a photo is always re-encoded as JPEG, but a file keeps its format.
 */
export function sniffImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

export function isPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
}
