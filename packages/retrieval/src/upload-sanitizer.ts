import crypto from 'node:crypto';
import type { Result, AppError, SHA256 } from '@hawa/contracts';

export interface UntrustedUploadInput {
  filename: string;
  mimeType: string;
  content: Uint8Array | Buffer | string;
  maxBytes?: number;
}

export interface SanitizedAssetOutput {
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: SHA256;
  sanitizedContent: Buffer;
  warnings: string[];
}

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
  'application/pdf',
  'font/woff2',
  'font/ttf',
  'font/otf',
]);

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB ceiling

/**
 * Sanitizes and validates untrusted client uploads (CV-09, FR-012, FR-066).
 * Strips active execution payloads from SVGs and validates byte boundaries.
 */
export function sanitizeUntrustedUpload(
  input: UntrustedUploadInput
): Result<SanitizedAssetOutput, AppError> {
  // 1. MIME Validation
  if (!ALLOWED_MIME_TYPES.has(input.mimeType.toLowerCase())) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_MIME_TYPE',
        message: `MIME type "${input.mimeType}" is not permitted for client assets`,
        retryable: false,
        safeAction: 'Upload a supported image (PNG, SVG, WEBP, JPEG) or document (PDF)',
      },
    };
  }

  // 2. Size Bounding
  const maxBytes = input.maxBytes || DEFAULT_MAX_BYTES;
  const rawBuf =
    typeof input.content === 'string'
      ? Buffer.from(input.content, 'utf8')
      : Buffer.from(input.content);

  if (rawBuf.length === 0) {
    return {
      ok: false,
      error: {
        code: 'EMPTY_UPLOAD',
        message: 'Uploaded asset file is 0 bytes',
        retryable: false,
        safeAction: 'Provide non-empty asset file',
      },
    };
  }

  if (rawBuf.length > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Uploaded asset size ${rawBuf.length} exceeds ceiling ${maxBytes}`,
        retryable: false,
        safeAction: 'Compress or resize asset before upload',
      },
    };
  }

  const warnings: string[] = [];
  let cleanBuf = rawBuf;

  // 3. SVG Security Sanitization (Defense against XSS and XML entity bombs)
  if (input.mimeType.toLowerCase() === 'image/svg+xml') {
    let svgText = rawBuf.toString('utf8');

    // Neutralize dangerous tags and handlers
    if (/<script[\s>]/i.test(svgText) || /onload\s*=/i.test(svgText) || /javascript:/i.test(svgText)) {
      warnings.push('Active script execution payload neutralized from SVG asset');
      svgText = svgText
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/onload\s*=\s*["'][^"']*["']/gi, '')
        .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""');
    }

    // Neutralize XML DOCTYPE external entities (XXE)
    if (/<!DOCTYPE[\s\S]*?\[[\s\S]*?ENTITY[\s\S]*?\]>/i.test(svgText)) {
      warnings.push('XML DTD entity declarations neutralized from SVG');
      svgText = svgText.replace(/<!DOCTYPE[\s\S]*?>/i, '');
    }

    cleanBuf = Buffer.from(svgText, 'utf8');
  }

  // 4. Compute cryptographic SHA-256
  const sha256 = crypto.createHash('sha256').update(cleanBuf).digest('hex') as SHA256;

  return {
    ok: true,
    value: {
      filename: input.filename.replace(/[^a-zA-Z0-9._-]/g, '_'),
      mimeType: input.mimeType,
      byteSize: cleanBuf.length,
      sha256,
      sanitizedContent: cleanBuf,
      warnings,
    },
  };
}
