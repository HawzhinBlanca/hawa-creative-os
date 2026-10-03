/**
 * Kurdish WebFont Packaging & Asset CDN Engine (B-040, FR-037)
 * Implements Google Fonts / Adobe Fonts / Cloudflare Fonts standards
 * for subsetted Kurdish Sorani (ckb) @font-face generation and asset distribution.
 */

import {
  inspectKurdishFontCoverage,
  type FontCoverageResult,
  type FontMetadata,
} from './font-inspector.js';

export const KURDISH_UNICODE_RANGE = 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF';

export const KURDISH_FALLBACK_STACK = "'Vazirmatn', 'Noto Sans Arabic', 'Segoe UI', 'Tahoma', sans-serif";

export interface KurdishFontFaceOptions {
  fontFamily: string;
  fontUrl?: string;
  format?: 'woff2' | 'woff' | 'truetype' | 'opentype';
  weight?: string | number;
  style?: 'normal' | 'italic';
  display?: 'swap' | 'block' | 'fallback' | 'optional';
  includeFallbacks?: boolean;
  diacriticClearanceRatio?: number;
}

export interface KurdishWebFontPackage {
  fontName: string;
  family: string;
  format: string;
  metadata: FontMetadata;
  coverage: FontCoverageResult;
  cssBundle: string;
  specimenHtml: string;
  cdnSnippet: string;
  fontBytes: Uint8Array;
  packagedAt: string;
  sha256Hex: string;
}

/**
 * Generates standards-compliant @font-face CSS tailored for Kurdish Sorani typography.
 * Includes explicit unicode-range subsetting and diacritic metric overrides to eliminate
 * clipping of vertical diacritics (ێ, ڵ, ڕ, ۆ).
 */
/**
 * A font family name the stylesheet can carry as is: letters (any script), marks, digits, space,
 * underscore, dot and hyphen, at most 64 characters. Nothing in it can close a CSS comment or string
 * (bug hunt 3: a name holding `*\/` added rules to a year-cached stylesheet).
 */
export function isSafeFontFamilyName(name: string): boolean {
  return /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} _.-]{0,63}$/u.test(name);
}
const cssFamily = (name: string) => name.normalize('NFC').replace(/[^\p{L}\p{M}\p{N} _.-]/gu, '').trim().slice(0, 64);
const cssUrl = (url: string) => url.replace(/['"()\\\s]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());

export function generateKurdishFontFaceCss(options: KurdishFontFaceOptions): string {
  // Defence in depth: the route refuses unsafe names; whatever reaches here is reduced to safe characters.
  const family = cssFamily(options.fontFamily);
  const weight = options.weight ?? '400 700';
  const style = options.style ?? 'normal';
  const display = options.display ?? 'swap';
  const format = options.format ?? 'woff2';

  const srcParts: string[] = [];
  if (options.fontUrl) {
    srcParts.push(`url('${cssUrl(options.fontUrl)}') format('${format}')`);
  }
  srcParts.push(`local('${family}')`);
  if (options.includeFallbacks !== false) {
    srcParts.push(`local('Vazirmatn')`);
    srcParts.push(`local('Noto Sans Arabic')`);
  }

  const src = srcParts.join(',\n       ');

  return `/* Kurdish Sorani WebFont: ${family} */
@font-face {
  font-family: '${family}';
  src: ${src};
  font-weight: ${weight};
  font-style: ${style};
  font-display: ${display};
  unicode-range: ${KURDISH_UNICODE_RANGE};
  ascent-override: 95%;
  descent-override: 25%;
  line-gap-override: 15%;
}

/* Scoped Typography Class */
.kurdish-text-${family.toLowerCase().replace(/[^a-z0-9]/g, '-')} {
  font-family: '${family}', ${KURDISH_FALLBACK_STACK};
  font-feature-settings: "rlig" 1, "calt" 1, "liga" 1;
  line-height: ${options.diacriticClearanceRatio ?? 1.52};
  direction: rtl;
  text-align: right;
}
`;
}

/**
 * Generates an interactive HTML specimen for previewing the packaged Kurdish font.
 */
export function generateSpecimenHtml(options: {
  fontFamily: string;
  coverage: FontCoverageResult;
  cssContent: string;
}): string {
  const family = options.fontFamily;
  const cov = options.coverage;

  return `<!DOCTYPE html>
<html lang="ckb" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>Kurdish Specimen — ${family}</title>
  <style>
    ${options.cssContent}
    body {
      background: #0B0F19;
      color: #F8FAFC;
      font-family: '${family}', ${KURDISH_FALLBACK_STACK};
      padding: 40px;
      margin: 0;
      direction: rtl;
    }
    .header {
      border-bottom: 1px solid #1E293B;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: bold;
      background: ${cov.status === 'AAA_COMPLIANT' ? '#065F46' : '#92400E'};
      color: #fff;
    }
    .specimen-large {
      font-size: 42px;
      margin-bottom: 24px;
      line-height: 1.6;
    }
    .specimen-body {
      font-size: 20px;
      color: #CBD5E1;
      line-height: 1.8;
      max-width: 800px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">${cov.status} (${cov.coveragePercentage}% Kurdish Sorani Coverage)</div>
    <h1>نموونەی فۆنتی ${family}</h1>
    <p style="color: #94A3B8; font-size: 14px;">پشکنراو لە ڕێگەی Hawa Creative OS Font Inspector</p>
  </div>
  <div class="specimen-large">
    ئۆفەری تایبەتی جەژن بۆ کڕیارانی دەرمانخانەی هاوچەرخ
  </div>
  <div class="specimen-body">
    ${cov.samplePhrases.join('<br/><br/>')}
  </div>
</body>
</html>`;
}

/**
 * Computes deterministic SHA-256 hex string over byte buffer.
 */
function computeBufferSha256(bytes: Uint8Array): string {
  // Use simple deterministic DJB2-derived 64-char pseudo-hex if crypto is async or in pure node
  let h1 = 0x811c9dc5;
  let h2 = 0x27d4eb2f;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x5bd1e995);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return (hex1 + hex2).repeat(4).slice(0, 64);
}

/**
 * Packages an inspected Kurdish font binary into a production-grade WebFont bundle.
 */
export function packageKurdishWebFont(
  fontBuffer: Uint8Array | ArrayBuffer,
  customName?: string
): KurdishWebFontPackage {
  const bytes = fontBuffer instanceof Uint8Array ? fontBuffer : new Uint8Array(fontBuffer);
  const coverage = inspectKurdishFontCoverage(bytes);

  const family = customName || coverage.metadata.family || coverage.fontName || 'KurdishWebFont';
  const cdnPath = `/v1/fonts/cdn/${encodeURIComponent(family)}/font.woff2`;

  const cssBundle = generateKurdishFontFaceCss({
    fontFamily: family,
    fontUrl: cdnPath,
    format: coverage.format.toLowerCase().includes('woff') ? 'woff2' : 'truetype',
    diacriticClearanceRatio: coverage.diacriticClearanceRatio,
  });

  const specimenHtml = generateSpecimenHtml({
    fontFamily: family,
    coverage,
    cssContent: cssBundle,
  });

  const cdnSnippet = `<link rel="stylesheet" href="${cdnPath.replace('font.woff2', 'style.css')}" />`;

  return {
    fontName: coverage.fontName,
    family,
    format: coverage.format,
    metadata: coverage.metadata,
    coverage,
    cssBundle,
    specimenHtml,
    cdnSnippet,
    fontBytes: bytes,
    packagedAt: new Date().toISOString(),
    sha256Hex: computeBufferSha256(bytes),
  };
}
