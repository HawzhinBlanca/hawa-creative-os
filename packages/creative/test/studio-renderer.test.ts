import { describe, it, expect } from 'vitest';
import {
  renderLayoutV2,
  comparePngBuffers,
  assertFontResolves,
} from '../src/studio/render-layout-v2.js';
import path from 'node:path';
import {
  LATIN_LAYOUT,
  LATIN_COPY,
  SORANI_LAYOUT,
  SORANI_COPY,
  MIXED_LAYOUT,
  MIXED_COPY,
  MORNING_REQUEST_LAYOUT,
  MORNING_REQUEST_COPY,
} from '../../../scripts/render_studio_v2_proofs.js';

describe('Design Studio v2: Local Renderer (renderLayoutV2) & Goldens', () => {
  it('renders Latin golden layout with Verdana, exact line wrapping, and ≤ 1.0% diff', () => {
    const res1 = renderLayoutV2(LATIN_LAYOUT, { copyText: LATIN_COPY });
    expect(res1.png.length).toBeGreaterThan(20000);
    expect(res1.noTextPng.length).toBeGreaterThan(10000);
    expect(res1.wrappedLines).toEqual({ 0: 1, 1: 2, 2: 1, 3: 2, 4: 1 });
    expect(res1.fontFidelity['Verdana']).toBe('exact');

    const res2 = renderLayoutV2(LATIN_LAYOUT, { copyText: LATIN_COPY });
    const diff = comparePngBuffers(res1.png, res2.png);
    expect(diff.diffPercentage).toBeLessThanOrEqual(1.0);
    expect(diff.diffPercentage).toBe(0.0);
  });

  it('renders Sorani Kurdish golden layout with Noto Sans Arabic, RTL bidi, and ≤ 1.0% diff', () => {
    const res1 = renderLayoutV2(SORANI_LAYOUT, { copyText: SORANI_COPY });
    expect(res1.png.length).toBeGreaterThan(20000);
    expect(res1.noTextPng.length).toBeGreaterThan(10000);
    expect(res1.wrappedLines).toEqual({ 0: 1, 1: 2, 2: 1, 3: 2, 4: 1 });
    expect(res1.fontFidelity['Noto Sans Arabic']).toBe('exact');
    expect(res1.svg).toContain('direction="rtl"');
    expect(res1.svg).toContain('text-anchor="start"');
    expect(res1.svg).toContain('Noto Sans Arabic');

    const res2 = renderLayoutV2(SORANI_LAYOUT, { copyText: SORANI_COPY });
    const diff = comparePngBuffers(res1.png, res2.png);
    expect(diff.diffPercentage).toBeLessThanOrEqual(1.0);
    expect(diff.diffPercentage).toBe(0.0);
  });

  it('renders Mixed Latin + Sorani golden layout and verifies ≤ 1.0% diff', () => {
    const res1 = renderLayoutV2(MIXED_LAYOUT, { copyText: MIXED_COPY });
    expect(res1.png.length).toBeGreaterThan(20000);
    expect(res1.wrappedLines).toEqual({ 0: 1, 1: 1, 2: 1, 3: 2, 4: 1 });

    const res2 = renderLayoutV2(MIXED_LAYOUT, { copyText: MIXED_COPY });
    const diff = comparePngBuffers(res1.png, res2.png);
    expect(diff.diffPercentage).toBeLessThanOrEqual(1.0);
    expect(diff.diffPercentage).toBe(0.0);
  });

  it('renders 2026-09-14 morning request copy at 1080x1350 with exact wrapped line metrics', () => {
    const res1 = renderLayoutV2(MORNING_REQUEST_LAYOUT, { copyText: MORNING_REQUEST_COPY });
    expect(res1.png.length).toBeGreaterThan(50000);
    expect(res1.wrappedLines).toEqual({
      0: 1,
      1: 2,
      2: 1,
      3: 2,
      4: 5,
      5: 3,
      6: 2,
      7: 1,
    });

    const res2 = renderLayoutV2(MORNING_REQUEST_LAYOUT, { copyText: MORNING_REQUEST_COPY });
    const diff = comparePngBuffers(res1.png, res2.png);
    expect(diff.diffPercentage).toBeLessThanOrEqual(1.0);
    expect(diff.diffPercentage).toBe(0.0);
  });

  it('throws FONT_UNRESOLVED when requested font family resolves to a fallback family', () => {
    const fontsConf = path.resolve(process.cwd(), 'packages/creative/assets/fonts/fonts.conf');
    expect(() => {
      assertFontResolves('UnknownNonExistentFamily', fontsConf);
    }).toThrow(/FONT_UNRESOLVED/);
  });
});
