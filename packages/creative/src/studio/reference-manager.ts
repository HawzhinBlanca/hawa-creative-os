import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface CircularGuardCheck {
  allowed: boolean;
  matchingPath?: string;
  reason?: string;
}

export interface ExemplarEntry {
  rank: number;
  /** office-published: the office's own published post, a photo reference only; not owner-confirmed. */
  status: 'CONFIRMED' | 'pending' | 'dropped' | 'office-published';
  sha256: string;
  path: string;
  filename: string;
  dimensions: ImageDimensions;
  aspectRatio: string;
  format: string;
  fileSizeBytes: number;
  reason: string;
  recommendedFor: string[];
  source?: 'folder_drop' | 'telegram' | 'desk';
  sender?: string;
  addedAt?: string;
  confirmedAt?: string;
  confirmedBy?: string;
  score?: number;
  craftScore?: number;
  representativenessScore?: number;
  receipt?: any;
  recipe?: string;
  subject?: string[];
  photoCount?: number;
  descriptor?: string;
  language?: string;
  pairedWith?: string;
  provenance?: Record<string, string>;
}

export interface KaaeExemplarsManifest {
  version: string;
  status: string;
  curator: string;
  confirmedAt: string;
  confirmationMethod: string;
  totalExemplars: number;
  officePublishedExemplars?: number;
  officePublishedPolicy?: string;
  notice: string;
  additionsPolicy: string;
  exemplars: ExemplarEntry[];
  droppedInReview: {
    reviewedAt: string;
    reviewedBy: string;
    entries: Array<{
      filename: string;
      formerRank: number;
      reason: string;
      reconsideredAt?: string;
      reconsideration?: string;
    }>;
  };
}

/**
 * Parses basic dimensions from PNG, JPEG, WebP, or SVG byte buffer without native dependencies.
 */
export function parseImageDimensions(buffer: Buffer): ImageDimensions {
  // PNG: bytes 16..23 contain 32-bit big-endian width and height
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }

  // WebP: check VP8 / VP8L / VP8X
  if (
    buffer.length >= 30 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunkType = buffer.subarray(12, 16).toString('ascii');
    if (chunkType === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      if (width > 0 && height > 0) return { width, height };
    }
    if (chunkType === 'VP8L' && buffer.length >= 25) {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      if (width > 0 && height > 0) return { width, height };
    }
  }

  // JPEG: scan for SOF markers
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
        if (offset + 8 <= buffer.length) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
        }
      }
      if (offset + 4 > buffer.length) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }

  // SVG: scan root <svg> element
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('utf8');
  if (head.includes('<svg')) {
    const svgTagMatch = head.match(/<svg[^>]*>/i);
    if (svgTagMatch) {
      const tag = svgTagMatch[0];
      const wMatch = tag.match(/\bwidth=["']\s*([0-9.]+)(?:px)?\s*["']/i);
      const hMatch = tag.match(/\bheight=["']\s*([0-9.]+)(?:px)?\s*["']/i);
      const vbMatch = tag.match(
        /\bviewBox=["']\s*([0-9.-]+)[,\s]+([0-9.-]+)[,\s]+([0-9.-]+)[,\s]+([0-9.-]+)\s*["']/i
      );
      const width = wMatch ? parseFloat(wMatch[1]) : vbMatch ? parseFloat(vbMatch[3]) : 0;
      const height = hMatch ? parseFloat(hMatch[1]) : vbMatch ? parseFloat(vbMatch[4]) : 0;
      if (width > 0 && height > 0) {
        return { width: Math.round(width), height: Math.round(height) };
      }
    }
  }

  return { width: 1080, height: 1080 };
}

export function computeAspectRatioString(width: number, height: number): string {
  const ratio = width / height;
  if (Math.abs(ratio - 1.0) < 0.05) return '1:1';
  if (Math.abs(ratio - 0.8) < 0.05) return '4:5';
  if (Math.abs(ratio - 0.5625) < 0.05) return '9:16';
  if (Math.abs(ratio - 1.7778) < 0.05) return '16:9';
  if (Math.abs(ratio - 0.707) < 0.05) return 'A4';
  return `${width}:${height}`;
}

export class ReferenceLibraryManager {
  private workspaceRoot: string;
  private manifestPath: string;
  private referencesDir: string;

  constructor(customWorkspaceRoot?: string, customManifestPath?: string, customReferencesDir?: string) {
    this.workspaceRoot = customWorkspaceRoot || process.cwd();
    this.manifestPath =
      customManifestPath ||
      path.resolve(this.workspaceRoot, 'packages/creative/assets/kaae-exemplars.json');
    this.referencesDir =
      customReferencesDir ||
      path.resolve(this.workspaceRoot, 'data/kaae-graphics/references');
  }

  public getManifest(): KaaeExemplarsManifest {
    if (!fs.existsSync(this.manifestPath)) {
      throw new Error(`Manifest not found at: ${this.manifestPath}`);
    }
    return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
  }

  public saveManifest(manifest: KaaeExemplarsManifest): void {
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  /**
   * Hard guard: checks whether the candidate file sha256 matches any file
   * generated under `output/` or known script render outputs.
   */
  public checkCircularOutputGuard(fileBuffer: Buffer): CircularGuardCheck {
    const candidateSha = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // 1. Check known generated circular assets
    const circularBasenames = [
      'KAAE_Commences_2026_Cycle_1080x1350.png',
      'KAAE_Commences_2026_Cycle_1080x1350.svg',
    ];

    for (const base of circularBasenames) {
      const checkPath = path.join(this.referencesDir, base);
      if (fs.existsSync(checkPath)) {
        try {
          const buf = fs.readFileSync(checkPath);
          const s = crypto.createHash('sha256').update(buf).digest('hex');
          if (s === candidateSha) {
            return {
              allowed: false,
              matchingPath: `data/kaae-graphics/references/${base}`,
              reason: `Candidate file matches known system-generated deliverable "${base}". Circular calibration is prohibited by P01/P11 policy.`,
            };
          }
        } catch {
          // ignore read error
        }
      }
    }

    // 2. Recursively scan output/ directory
    const outputDir = path.resolve(this.workspaceRoot, 'output');
    if (fs.existsSync(outputDir)) {
      const match = this.scanDirForSha(outputDir, candidateSha);
      if (match) {
        const relMatch = path.relative(this.workspaceRoot, match);
        return {
          allowed: false,
          matchingPath: relMatch,
          reason: `Candidate file matches generated output file "${relMatch}". System-produced designs cannot be added as references.`,
        };
      }
    }

    return { allowed: true };
  }

  private scanDirForSha(dir: string, targetSha: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const sub = this.scanDirForSha(fullPath, targetSha);
        if (sub) return sub;
      } else if (ent.isFile()) {
        try {
          // Check files up to 50MB
          const stat = fs.statSync(fullPath);
          if (stat.size > 0 && stat.size < 50 * 1024 * 1024) {
            const buf = fs.readFileSync(fullPath);
            const sha = crypto.createHash('sha256').update(buf).digest('hex');
            if (sha === targetSha) {
              return fullPath;
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  /**
   * Adds a candidate reference file as 'pending' via one of three entry points.
   */
  public addPendingReference(params: {
    source: 'folder_drop' | 'telegram' | 'desk';
    fileBuffer: Buffer;
    filename: string;
    sender?: string;
    reason?: string;
    recommendedFor?: string[];
  }): {
    success: boolean;
    refused?: boolean;
    reason?: string;
    matchingPath?: string;
    entry?: ExemplarEntry;
  } {
    // 1. Run circular output guard
    const guard = this.checkCircularOutputGuard(params.fileBuffer);
    if (!guard.allowed) {
      return {
        success: false,
        refused: true,
        matchingPath: guard.matchingPath,
        reason: guard.reason,
      };
    }

    const sha256 = crypto.createHash('sha256').update(params.fileBuffer).digest('hex');
    const dims = parseImageDimensions(params.fileBuffer);
    const aspect = computeAspectRatioString(dims.width, dims.height);

    // Ensure references directory exists
    fs.mkdirSync(this.referencesDir, { recursive: true });
    const destPath = path.join(this.referencesDir, params.filename);
    fs.writeFileSync(destPath, params.fileBuffer);

    const manifest = this.getManifest();

    // Check if entry with same sha or filename already exists
    const existingIndex = manifest.exemplars.findIndex(
      e => e.sha256 === sha256 || e.filename === params.filename
    );

    const newEntry: ExemplarEntry = {
      rank: manifest.exemplars.length + 1,
      status: 'pending',
      sha256,
      path: `data/kaae-graphics/references/${params.filename}`,
      filename: params.filename,
      dimensions: dims,
      aspectRatio: aspect,
      format: aspect,
      fileSizeBytes: params.fileBuffer.length,
      reason: params.reason || `Pending owner review; submitted via ${params.source}`,
      recommendedFor: params.recommendedFor || ['feed_announcement'],
      source: params.source,
      sender: params.sender || (params.source === 'desk' ? 'desk_operator' : undefined),
      addedAt: new Date().toISOString().split('T')[0],
    };

    if (existingIndex >= 0) {
      // Overwrite / update pending
      manifest.exemplars[existingIndex] = newEntry;
    } else {
      manifest.exemplars.push(newEntry);
    }

    // Preserve droppedInReview intact
    this.saveManifest(manifest);

    return {
      success: true,
      entry: newEntry,
    };
  }

  /**
   * Confirmation gate: owner confirms a pending reference, assigning its rank.
   */
  public confirmReference(
    filenameOrSha: string,
    params: {
      confirmedBy: string;
      confirmedAt?: string;
      targetRank?: number;
      reason?: string;
      recommendedFor?: string[];
    }
  ): {
    success: boolean;
    error?: string;
    entry?: ExemplarEntry;
    confirmedCount?: number;
  } {
    const manifest = this.getManifest();
    const entry = manifest.exemplars.find(
      e => e.filename === filenameOrSha || e.sha256 === filenameOrSha
    );

    if (!entry) {
      return {
        success: false,
        error: `Exemplar not found: ${filenameOrSha}`,
      };
    }

    entry.status = 'CONFIRMED';
    entry.confirmedAt = params.confirmedAt || new Date().toISOString().split('T')[0];
    entry.confirmedBy = params.confirmedBy;
    if (params.reason) entry.reason = params.reason;
    if (params.recommendedFor) entry.recommendedFor = params.recommendedFor;

    // Filter confirmed entries for ranking. Office-published photo references keep their own
    // place after the confirmed set; confirming one moves it into the confirmed ranking.
    const confirmed = manifest.exemplars.filter(e => e.status !== 'pending' && e.status !== 'dropped' && e.status !== 'office-published');
    const officePublished = manifest.exemplars.filter(e => e.status === 'office-published');
    const pending = manifest.exemplars.filter(e => e.status === 'pending');

    // Remove current entry from confirmed list if present, then re-insert at targetRank
    const otherConfirmed = confirmed.filter(e => e.sha256 !== entry.sha256);
    const targetRank = params.targetRank ? Math.max(1, Math.min(params.targetRank, otherConfirmed.length + 1)) : otherConfirmed.length + 1;

    otherConfirmed.splice(targetRank - 1, 0, entry);

    // Re-assign ranks 1..N strictly according to owner order
    otherConfirmed.forEach((e, idx) => {
      e.rank = idx + 1;
    });

    officePublished.forEach((e, idx) => {
      e.rank = otherConfirmed.length + idx + 1;
    });

    manifest.exemplars = [...otherConfirmed, ...officePublished, ...pending];
    manifest.totalExemplars = otherConfirmed.length;

    this.saveManifest(manifest);

    // Retrieval refreshes from the complete manifest hash; no disk vector cache.

    return {
      success: true,
      entry,
      confirmedCount: manifest.totalExemplars,
    };
  }
}
