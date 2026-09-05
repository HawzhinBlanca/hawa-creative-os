import { describe, it, expect } from 'vitest';
import { ZipBundler, computeCrc32 } from '../src/services/zipBundler.ts';

describe('ZipBundler (PKZIP 2.0 Client-Side Generator)', () => {
  it('computes accurate IEEE 802.3 CRC32 checksums', () => {
    const encoder = new TextEncoder();
    // Known test vectors
    expect(computeCrc32(encoder.encode('123456789'))).toBe(0xcbf43926);
    expect(computeCrc32(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('generates a valid binary .zip archive with standard headers and signatures', async () => {
    const bundler = new ZipBundler();
    bundler.addText('README.txt', 'Hawa Creative OS Delivery Package\nInvariant #2 Verified');
    bundler.addText('manifest.json', JSON.stringify({ version: '1.0.0', client: 'Aster' }));
    bundler.addBinary('pixel.bin', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const zipBlob = bundler.generateZipBlob();
    expect(zipBlob).toBeDefined();
    expect(zipBlob.type).toBe('application/zip');
    expect(zipBlob.size).toBeGreaterThan(100);

    const buffer = await zipBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Verify Local File Header Signature: 0x04034b50 (PK\x03\x04)
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);

    // Verify End of Central Directory Signature: 0x06054b50 (PK\x05\x06) exists in tail
    let foundEocd = false;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        foundEocd = true;
        const view = new DataView(buffer, i);
        expect(view.getUint16(8, true)).toBe(3);  // 3 entries
        expect(view.getUint16(10, true)).toBe(3); // 3 total entries
        break;
      }
    }
    expect(foundEocd).toBe(true);
  });
});
