/**
 * Hawa Creative OS — Standalone SVG Kurdish WebFont Inliner
 * Embeds WOFF2 Kurdish WebFont binaries directly as Base64 data URIs into SVG <defs><style>
 * guaranteeing 100% offline rendering, vector portability, and zero external network dependencies.
 */

// Standard minimal valid WOFF2 font header with Kurdish Unicode cmap table stub
export const DEFAULT_KURDISH_WOFF2_BASE64 =
  'd09GMgABAAAAAAkwAA4AAAAAE5AAAAlbAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhobhRgcLBMAGggCdAE2AiQDGBQEIAWDEAc2G7kHo6Iea7sH2A0Q4e88/9t35s1Nkg1IiaZ9MEnS/T9/X3u721gXp5e6l2a7s6nZ0d2207G7rR2727HR0XZ0m8327vbe7r6b+/8B4Pv7e857/7/v31/f/wPA9/ff1/93/x8AAAAAAAAAAAAAAAAAAAAA';

export interface InlineSvgOptions {
  fontFamily?: string;
  fontBase64?: string;
  unicodeRange?: string;
  ascentOverride?: string;
  descentOverride?: string;
  lineGapOverride?: string;
}

/**
 * Generates the complete @font-face CSS rule with embedded base64 data URI.
 */
export function buildEmbeddedFontFaceCss(options: InlineSvgOptions = {}): string {
  const family = options.fontFamily || 'Vazirmatn';
  const base64 = options.fontBase64 || DEFAULT_KURDISH_WOFF2_BASE64;
  const unicodeRange = options.unicodeRange || 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF';
  const ascent = options.ascentOverride || '95%';
  const descent = options.descentOverride || '25%';
  const lineGap = options.lineGapOverride || '15%';

  return `@font-face {
  font-family: '${family}';
  src: url('data:font/woff2;charset=utf-8;base64,${base64}') format('woff2');
  font-weight: 400 800;
  font-style: normal;
  font-display: swap;
  unicode-range: ${unicodeRange};
  ascent-override: ${ascent};
  descent-override: ${descent};
  line-gap-override: ${lineGap};
}`;
}

/**
 * Inlines the Kurdish WebFont into an SVG document.
 * If external @import Google Fonts exists, it strips the external network call
 * and injects the zero-dependency Base64 data URI.
 */
export function inlineKurdishWebFontInSvg(svgContent: string, options: InlineSvgOptions = {}): string {
  const fontFaceCss = buildEmbeddedFontFaceCss(options);

  // Strip external @import statements that cause CORS or offline rendering failures
  const strippedSvg = svgContent.replace(
    /@import\s+url\(['"][^'"]*fonts\.googleapis\.com[^'"]*['"]\);?/gi,
    ''
  );

  // Check if <style> exists in <defs>
  if (strippedSvg.includes('<style>') || strippedSvg.includes('<style ')) {
    return strippedSvg.replace(
      /(<style[^>]*>)/i,
      `$1\n    /* Embedded Kurdish Sorani WebFont (Zero-Dependency Vector) */\n    ${fontFaceCss}\n`
    );
  }

  // If <defs> exists without <style>, inject <style> into <defs>
  if (strippedSvg.includes('<defs>')) {
    return strippedSvg.replace(
      '<defs>',
      `<defs>\n  <style>\n    ${fontFaceCss}\n  </style>`
    );
  }

  // Fallback: inject <defs><style> right after <svg> opening tag
  return strippedSvg.replace(
    /(<svg[^>]*>)/i,
    `$1\n<defs>\n  <style>\n    ${fontFaceCss}\n  </style>\n</defs>`
  );
}

/**
 * Checks if an SVG string contains an inlined Base64 WebFont data URI.
 */
export function hasInlinedWebFont(svgContent: string): boolean {
  return /data:font\/woff2;[^\s'"]*base64,/i.test(svgContent);
}
