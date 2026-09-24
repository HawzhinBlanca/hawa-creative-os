import { PNG } from 'pngjs';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function neutralizeIccProfileName(chunk: Buffer): Buffer {
  const data = chunk.subarray(8, chunk.length - 4);
  const separator = data.indexOf(0);
  if (separator < 1 || separator > 79 || data[separator + 1] !== 0 || data.length < separator + 4) {
    throw new Error('PNG has a malformed color profile chunk');
  }
  const profile = Buffer.concat([Buffer.from('profile\0\0', 'ascii'), data.subarray(separator + 2)]);
  const typeAndData = Buffer.concat([Buffer.from('iCCP', 'ascii'), profile]);
  const result = Buffer.alloc(4 + typeAndData.length + 4);
  result.writeUInt32BE(profile.length, 0);
  typeAndData.copy(result, 4);
  result.writeUInt32BE(crc32(typeAndData), result.length - 4);
  return result;
}

/** Decode the entire final PNG, including CRC/data, before admitting it to a study. */
export function inspectPngExport(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 100 || bytes.length > 100 * 1024 * 1024) throw new Error('PNG export is empty or oversized');
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Export is not a PNG with an IHDR chunk');
  }
  const headerWidth = bytes.readUInt32BE(16);
  const headerHeight = bytes.readUInt32BE(20);
  if (headerWidth < 1 || headerHeight < 1 || headerWidth * headerHeight > 25_000_000) {
    throw new Error('PNG export declares invalid dimensions');
  }
  const image = PNG.sync.read(bytes, { checkCRC: true });
  if (image.width !== headerWidth || image.height !== headerHeight) {
    throw new Error('PNG export has invalid dimensions');
  }
  return { width: image.width, height: image.height };
}

/** Preserve image/color chunks while removing arm-revealing text and camera metadata. */
export function stripPngStudyMetadata(bytes: Buffer): Buffer {
  inspectPngExport(bytes);
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'bKGD']);
  const chunks: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') throw new Error('Animated PNG cannot enter a static blind study');
    if (keep.has(type)) {
      const chunk = bytes.subarray(offset, end);
      chunks.push(type === 'iCCP' ? neutralizeIccProfileName(chunk) : chunk);
    }
    offset = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || offset !== bytes.length) throw new Error('PNG has no final IEND chunk or has trailing data');
  return Buffer.concat(chunks);
}
