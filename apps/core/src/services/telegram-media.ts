/**
 * What a file sent on Telegram is, read from its bytes. Telegram's own mime_type is what the
 * sender's phone claimed, and a photo is always re-encoded as JPEG, but a file keeps its format.
 */
export type SniffedImage = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/heic' | 'image/avif' | 'image/bmp' | 'image/tiff';

export function sniffImageMime(bytes: Buffer): SniffedImage {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  // An iPhone's photo sent as a file is HEIC; BMP and TIFF come from scanners and older software.
  // Labelled JPEG, their bytes reached the model as a JPEG it could not read (review of 2026-09-24).
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (/^(avif|avis)$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  if (bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.length >= 4 && (bytes.readUInt32BE(0) === 0x49492a00 || bytes.readUInt32BE(0) === 0x4d4d002a)) return 'image/tiff';
  return 'image/jpeg';
}

/** The picture formats the design studio, its models and the Canva deck all read. */
export function isUsableImage(mime: SniffedImage): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
}

/** Telegram's Bot API hands a bot no file larger than this. */
export const TELEGRAM_BOT_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export function isPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
}
