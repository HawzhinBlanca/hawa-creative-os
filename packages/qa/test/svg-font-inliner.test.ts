import { describe, it, expect } from 'vitest';
import {
  inlineKurdishWebFontInSvg,
  hasInlinedWebFont,
  buildEmbeddedFontFaceCss,
  DEFAULT_KURDISH_WOFF2_BASE64,
} from '../src/svg-font-inliner.js';

describe('Standalone SVG Kurdish WebFont Inliner', () => {
  const sampleSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700&display=swap');
    </style>
  </defs>
  <rect width="1080" height="1080" fill="#01585F"/>
  <text x="100" y="200" fill="#FFFFFF" font-family="Vazirmatn">سڵاو لە جیهان</text>
</svg>`;

  it('builds valid @font-face CSS rule with Base64 WOFF2 data URI', () => {
    const css = buildEmbeddedFontFaceCss({ fontFamily: 'Vazirmatn' });
    expect(css).toContain("@font-face");
    expect(css).toContain("font-family: 'Vazirmatn'");
    expect(css).toContain("data:font/woff2;charset=utf-8;base64,");
    expect(css).toContain("ascent-override: 95%");
    expect(css).toContain("descent-override: 25%");
  });

  it('inlines Kurdish WebFont directly into SVG, stripping external @import network URLs', () => {
    const inlined = inlineKurdishWebFontInSvg(sampleSvg);

    expect(hasInlinedWebFont(inlined)).toBe(true);
    expect(inlined).not.toContain("fonts.googleapis.com");
    expect(inlined).toContain("data:font/woff2;charset=utf-8;base64," + DEFAULT_KURDISH_WOFF2_BASE64);
    expect(inlined).toContain("سڵاو لە جیهان");
  });

  it('injects <defs><style> if SVG lacks them', () => {
    const minimalSvg = `<svg viewBox="0 0 100 100"><text>Kurdish</text></svg>`;
    const inlined = inlineKurdishWebFontInSvg(minimalSvg);

    expect(hasInlinedWebFont(inlined)).toBe(true);
    expect(inlined).toContain("<defs>");
    expect(inlined).toContain("<style>");
    expect(inlined).toContain("@font-face");
  });

  it('correctly detects inlined and non-inlined SVGs with hasInlinedWebFont', () => {
    expect(hasInlinedWebFont(sampleSvg)).toBe(false);
    const inlined = inlineKurdishWebFontInSvg(sampleSvg);
    expect(hasInlinedWebFont(inlined)).toBe(true);
  });
});
