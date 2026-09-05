/**
 * Hawa Creative OS — Zero-Dependency Client-Side ZIP Packager
 * 
 * Implements standard PKZIP 2.0 (RFC 1950 / APPNOTE.TXT) with CRC-32 verification
 * and uncompressed Store method (0x0000). Produces 100% compliant .zip archives
 * compatible with macOS Archive Utility, Windows Explorer, Linux unzip, and 7-Zip.
 */

// Pre-computed CRC32 lookup table (IEEE 802.3)
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[n] = c;
}

export function computeCrc32(data: Uint8Array): number {
  let crc = 0 ^ (-1);
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

export interface ZipEntry {
  filename: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

export class ZipBundler {
  private files: { filename: string; data: Uint8Array }[] = [];

  /**
   * Add a text file or JSON string
   */
  addText(filename: string, content: string): this {
    const encoder = new TextEncoder();
    this.files.push({
      filename,
      data: encoder.encode(content),
    });
    return this;
  }

  /**
   * Add raw binary buffer (e.g. from Canvas toBlob arrayBuffer)
   */
  addBinary(filename: string, data: Uint8Array): this {
    this.files.push({ filename, data });
    return this;
  }

  /**
   * Add a Blob (e.g. PNG image blob)
   */
  async addBlob(filename: string, blob: Blob): Promise<this> {
    const buffer = await blob.arrayBuffer();
    this.files.push({
      filename,
      data: new Uint8Array(buffer),
    });
    return this;
  }

  /**
   * Build the complete .zip binary archive as a standard browser Blob
   */
  generateZipBlob(): Blob {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const entries: ZipEntry[] = [];
    let currentOffset = 0;

    const now = new Date();
    // MS-DOS Time: bits 15-11: Hours (0-23), 10-5: Minutes, 4-0: Seconds / 2
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (Math.floor(now.getSeconds() / 2))) & 0xFFFF;
    // MS-DOS Date: bits 15-9: Year - 1980, 8-5: Month (1-12), 4-0: Day (1-31)
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    // 1. Write Local File Headers + File Data
    for (const file of this.files) {
      const filenameBytes = encoder.encode(file.filename);
      const crc = computeCrc32(file.data);
      const size = file.data.length;

      const header = new Uint8Array(30 + filenameBytes.length);
      const view = new DataView(header.buffer);

      // Local file header signature: 0x04034b50 (PK\x03\x04)
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);         // Version needed: 2.0
      view.setUint16(6, 0x0800, true);     // Flags: bit 11 set = UTF-8 filename
      view.setUint16(8, 0, true);          // Compression method: 0 (Stored)
      view.setUint16(10, dosTime, true);
      view.setUint16(12, dosDate, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, size, true);      // Compressed size
      view.setUint32(22, size, true);      // Uncompressed size
      view.setUint16(26, filenameBytes.length, true);
      view.setUint16(28, 0, true);         // Extra field length: 0

      header.set(filenameBytes, 30);

      entries.push({
        filename: file.filename,
        data: file.data,
        crc,
        offset: currentOffset,
      });

      parts.push(header);
      parts.push(file.data);
      currentOffset += header.length + file.data.length;
    }

    const centralDirOffset = currentOffset;
    let centralDirSize = 0;

    // 2. Write Central Directory Headers
    for (const entry of entries) {
      const filenameBytes = encoder.encode(entry.filename);
      const size = entry.data.length;

      const cdHeader = new Uint8Array(46 + filenameBytes.length);
      const view = new DataView(cdHeader.buffer);

      // Central file header signature: 0x02014b50 (PK\x01\x02)
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 0x0314, true);     // Version made by: Unix, PKZIP 2.0
      view.setUint16(6, 20, true);         // Version needed: 2.0
      view.setUint16(8, 0x0800, true);     // Flags: UTF-8 filename
      view.setUint16(10, 0, true);         // Compression: 0 (Stored)
      view.setUint16(12, dosTime, true);
      view.setUint16(14, dosDate, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, size, true);
      view.setUint32(24, size, true);
      view.setUint16(28, filenameBytes.length, true);
      view.setUint16(30, 0, true);         // Extra field length
      view.setUint16(32, 0, true);         // File comment length
      view.setUint16(34, 0, true);         // Disk number start
      view.setUint16(36, 0, true);         // Internal attributes
      view.setUint32(38, 0o100644 << 16, true); // External attributes (regular file 0644)
      view.setUint32(42, entry.offset, true);   // Relative offset of local header

      cdHeader.set(filenameBytes, 46);
      parts.push(cdHeader);
      centralDirSize += cdHeader.length;
      currentOffset += cdHeader.length;
    }

    // 3. Write End of Central Directory (EOCD) Record
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);

    // End of central dir signature: 0x06054b50 (PK\x05\x06)
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(4, 0, true);               // Number of this disk
    eocdView.setUint16(6, 0, true);               // Disk where CD starts
    eocdView.setUint16(8, entries.length, true);  // Number of CD records on this disk
    eocdView.setUint16(10, entries.length, true); // Total number of CD records
    eocdView.setUint32(12, centralDirSize, true); // Size of central directory
    eocdView.setUint32(16, centralDirOffset, true); // Offset of central directory
    eocdView.setUint16(20, 0, true);              // Comment length

    parts.push(eocd);

    return new Blob(parts as any[], { type: 'application/zip' });
  }

  /**
   * Helper to trigger browser download
   */
  download(filename: string): void {
    const blob = this.generateZipBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
