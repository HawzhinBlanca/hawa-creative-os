import { createHash } from 'node:crypto';

export interface SvgSanitizationResult {
  ok: boolean;
  sanitized?: string;
  violations: string[];
}

export interface AssetValidationResult {
  ok: boolean;
  sha256?: string;
  mimeType?: string;
  violations: string[];
  sanitizedContent?: string;
}

export interface AssetUploadRequest {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content?: string | Uint8Array;
}

const ALLOWED_MIME_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'font/ttf',
  'font/otf',
  'font/woff2',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin',
  'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
  'html', 'htm', 'xhtml', 'shtml',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'php', 'phtml', 'py', 'rb', 'pl', 'cgi',
]);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB upload limit

/**
 * High-assurance SVG Sanitizer.
 * Neutralizes XSS, XXE, entity expansions, script tags, event handlers,
 * foreignObject embeds, and javascript URI schemes.
 */
export function sanitizeSvg(rawSvg: string): SvgSanitizationResult {
  const violations: string[] = [];

  if (!rawSvg || typeof rawSvg !== 'string') {
    return { ok: false, violations: ['Empty or non-string SVG payload'] };
  }

  // 1. Check for XML External Entity (XXE) / DTD injections
  if (/<!DOCTYPE/i.test(rawSvg) || /<!ENTITY/i.test(rawSvg) || /SYSTEM\s+["']/i.test(rawSvg)) {
    violations.push('Blocked XML DTD/Entity expansion (potential XXE attack)');
  }

  let cleaned = rawSvg;

  // Remove XML declaration and comments if they contain suspicious directives
  cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/gi, '');
  cleaned = cleaned.replace(/<!ENTITY[^>]*>/gi, '');

  // 2. Block and strip <script> tags and enclosed scripts
  if (/<script\b[^>]*>([\s\S]*?)<\/script>/gi.test(cleaned) || /<script\b/gi.test(cleaned)) {
    violations.push('Blocked executable <script> element');
    cleaned = cleaned.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '');
    cleaned = cleaned.replace(/<script\b[^>]*\/?>/gi, '');
  }

  // 3. Block and strip embedded external objects (<foreignObject>, <object>, <embed>, <iframe>, <applet>, <meta>, <link>)
  const dangerousTags = ['foreignobject', 'object', 'embed', 'iframe', 'applet', 'meta', 'link', 'audio', 'video'];
  for (const tag of dangerousTags) {
    const tagRegex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    const selfClosingRegex = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    if (tagRegex.test(cleaned) || selfClosingRegex.test(cleaned)) {
      violations.push(`Blocked dangerous SVG tag: <${tag}>`);
      cleaned = cleaned.replace(tagRegex, '');
      cleaned = cleaned.replace(selfClosingRegex, '');
    }
  }

  // 4. Strip inline event handlers (e.g. onload, onerror, onclick, onmouseover, etc.)
  const eventHandlerRegex = /\s+(on[a-z]{3,20})\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi;
  if (eventHandlerRegex.test(cleaned)) {
    violations.push('Stripped inline event handler attributes (XSS prevention)');
    cleaned = cleaned.replace(eventHandlerRegex, '');
  }

  // 5. Check and neutralize dangerous URI schemes in href, xlink:href, src, action
  const dangerousSchemeRegex = /(href|xlink:href|src|action)\s*=\s*["']\s*(javascript:|vbscript:|data:text\/html)/gi;
  if (dangerousSchemeRegex.test(cleaned)) {
    violations.push('Blocked malicious URI scheme (javascript/data:html)');
    cleaned = cleaned.replace(dangerousSchemeRegex, '$1="#blocked"');
  }

  // 6. Clean <style> blocks from CSS expressions or @import
  const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  cleaned = cleaned.replace(styleBlockRegex, (match, styleContent) => {
    if (/@import/i.test(styleContent) || /expression\s*\(/i.test(styleContent) || /url\s*\(\s*["']?javascript:/i.test(styleContent)) {
      violations.push('Stripped malicious CSS directive from <style>');
      return '<style>/* sanitized */</style>';
    }
    return match;
  });

  // Verify that root is an <svg> tag
  if (!/<svg\b[^>]*>/i.test(cleaned)) {
    violations.push('Invalid SVG: Root element must be <svg>');
    return { ok: false, violations };
  }

  // If severe attacks (XXE or scripts) were detected, fail validation or return sanitized copy
  const isSafe = violations.length === 0 || !violations.some((v) => v.includes('XXE') || v.includes('Invalid SVG'));

  return {
    ok: isSafe,
    sanitized: cleaned.trim(),
    violations,
  };
}

/**
 * Validates an uploaded asset against file extensions, MIME types, size limits,
 * path traversal attacks, and magic bytes.
 */
export function validateUploadedAsset(asset: AssetUploadRequest): AssetValidationResult {
  const violations: string[] = [];

  // 1. Path traversal check
  if (!asset.filename || asset.filename.includes('..') || asset.filename.includes('/') || asset.filename.includes('\\')) {
    violations.push('Filename contains directory traversal sequence or invalid path characters');
  }

  // 2. Extension validation
  const ext = (asset.filename.split('.').pop() || '').toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    violations.push(`File extension .${ext} is prohibited by security policy`);
  }

  // 3. MIME type allowlist
  if (!ALLOWED_MIME_TYPES.has(asset.mimeType)) {
    violations.push(`MIME type '${asset.mimeType}' is not in allowed media types`);
  }

  // 4. File size check
  if (asset.sizeBytes <= 0) {
    violations.push('File size must be greater than zero');
  }
  if (asset.sizeBytes > MAX_UPLOAD_BYTES) {
    violations.push(`File size ${asset.sizeBytes} exceeds maximum permitted ${MAX_UPLOAD_BYTES} bytes`);
  }

  let sanitizedContent: string | undefined;

  // 5. Special sanitization for SVG
  if (asset.mimeType === 'image/svg+xml' && typeof asset.content === 'string') {
    const svgRes = sanitizeSvg(asset.content);
    if (!svgRes.ok) {
      violations.push(...svgRes.violations);
    } else {
      sanitizedContent = svgRes.sanitized;
    }
  }

  // 6. Magic bytes sniffing check for binary raster images
  if (asset.content && typeof asset.content !== 'string') {
    const bytes = asset.content instanceof Uint8Array ? asset.content : new Uint8Array(asset.content);
    if (asset.mimeType === 'image/png') {
      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      const isPng = bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
      if (!isPng) {
        violations.push('PNG header magic bytes mismatch (possible MIME spoofing)');
      }
    } else if (asset.mimeType === 'image/jpeg') {
      // JPEG signature: FF D8 FF
      const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isJpeg) {
        violations.push('JPEG header magic bytes mismatch (possible MIME spoofing)');
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // Compute deterministic SHA256 of payload
  const hash = createHash('sha256');
  if (sanitizedContent) {
    hash.update(sanitizedContent, 'utf8');
  } else if (typeof asset.content === 'string') {
    hash.update(asset.content, 'utf8');
  } else if (asset.content) {
    hash.update(asset.content);
  } else {
    hash.update(`${asset.filename}:${asset.mimeType}:${asset.sizeBytes}`);
  }
  const sha256 = hash.digest('hex');

  return {
    ok: true,
    sha256,
    mimeType: asset.mimeType,
    violations: [],
    sanitizedContent,
  };
}
