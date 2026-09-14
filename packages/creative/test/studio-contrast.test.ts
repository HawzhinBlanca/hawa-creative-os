import { describe, it, expect } from 'vitest';
import {
  evaluateCompositeContrast,
  computeBoxP05Contrast,
  hexToLuminance,
  calculateLuminanceContrastRatio,
} from '../src/studio/composite-contrast.js';
import { renderLayoutV2 } from '../src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import { validateLayoutV2 } from '../src/studio/validate-layout-v2.js';

describe('Design Studio v2: Composite p05 Contrast Evaluation (evaluateCompositeContrast)', () => {
  it('correctly calculates relative luminance and WCAG contrast ratios', () => {
    const whiteLum = hexToLuminance('#FFFFFF');
    const blackLum = hexToLuminance('#000000');
    expect(whiteLum).toBeCloseTo(1.0, 2);
    expect(blackLum).toBeCloseTo(0.0, 2);

    const maxRatio = calculateLuminanceContrastRatio(whiteLum, blackLum);
    expect(maxRatio).toBeCloseTo(21.0, 1);

    const navyLum = hexToLuminance('#0A1628');
    const goldLum = hexToLuminance('#F7B500');
    const goldNavyRatio = calculateLuminanceContrastRatio(goldLum, navyLum);
    expect(goldNavyRatio).toBeGreaterThan(9.0); // Gold on dark navy is high contrast
  });

  it('fails dark-on-dark text with low p05 contrast (< 4.5:1)', () => {
    // Dark-on-dark layout: Royal Navy text (#1E3A5F) over Midnight Navy background (#0A1628)
    const failingLayout: StudioLayoutV2 = {
      version: 2,
      width: 1080,
      height: 1350,
      grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
      background: { color: '#0A1628' },
      shapes: [],
      logo: { x: 86, y: 86, width: 120, height: 120 },
      text: [
        {
          copyIndex: 0,
          role: 'body',
          x: 86,
          y: 300,
          width: 908,
          height: 100,
          fontSize: 18,
          lineHeight: 1.4,
          fontFamily: 'EB Garamond',
          color: '#1E3A5F', // Low contrast dark navy on dark navy
          align: 'left',
        },
      ],
    };

    const render = renderLayoutV2(failingLayout, {
      copyText: { 0: 'This body text is unreadable due to dark-on-dark color selection.' },
    });

    const result = evaluateCompositeContrast(render.noTextPng, failingLayout);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0].copyIndex).toBe(0);
    expect(result.failures[0].p05).toBeLessThan(4.5);
    expect(result.failures[0].p05).toBe(1.58); // Exactly 1.58:1 contrast

    // Server validator integration
    const validation = validateLayoutV2(failingLayout, {
      expectedWidth: 1080,
      expectedHeight: 1350,
      copyCount: 1,
      copyScripts: ['latin'],
      reference: {
        rules: {
          fontFamily: 'EB Garamond',
          palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF', '#FDF8F3', '#D4E2F0'],
        },
        logoAspect: 1.0,
      },
      contrastEvaluator: (box, fontSize, bold) => {
        return result.p05PerBox[0];
      },
    });

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.code).toBe('CONTRAST');
    }
  });

  it('passes when high-contrast text and scrim plate are applied (p05 >= 4.5:1)', () => {
    // Scrim-fixed layout: Ivory / Cream text (#FDF8F3) over Midnight Navy scrim plate
    const passingLayout: StudioLayoutV2 = {
      version: 2,
      width: 1080,
      height: 1350,
      grid: { margin: 86, columns: 6, gutter: 20, baseline: 8 },
      background: { color: '#0A1628' },
      art: {
        source: 'procedural',
        motif: 'gradient-wash',
        box: { x: 0, y: 0, width: 1080, height: 1350 },
        opacity: 0.8,
        scrim: {
          color: '#0A1628',
          opacityStart: 0.85,
          opacityEnd: 0.95,
          direction: 'vertical',
        },
        calmRegion: { x: 86, y: 86, width: 908, height: 1178 },
      },
      shapes: [
        {
          x: 86,
          y: 280,
          width: 908,
          height: 2,
          kind: 'line',
          color: '#F7B500',
          role: 'rule',
        },
      ],
      logo: { x: 86, y: 86, width: 120, height: 120 },
      text: [
        {
          copyIndex: 0,
          role: 'title',
          x: 86,
          y: 320,
          width: 908,
          height: 100,
          fontSize: 44,
          lineHeight: 1.2,
          fontFamily: 'EB Garamond',
          color: '#F7B500', // Gold on navy scrim
          align: 'left',
          bold: true,
        },
        {
          copyIndex: 1,
          role: 'body',
          x: 86,
          y: 440,
          width: 908,
          height: 120,
          fontSize: 20,
          lineHeight: 1.4,
          fontFamily: 'EB Garamond',
          color: '#FDF8F3', // Academic cream on navy scrim
          align: 'left',
        },
      ],
    };

    const render = renderLayoutV2(passingLayout, {
      copyText: {
        0: 'Quality Assurance & Accreditation in Education',
        1: 'High-contrast text protected by an authoritative scrim layer over composite background.',
      },
    });

    const result = evaluateCompositeContrast(render.noTextPng, passingLayout);
    expect(result.passed).toBe(true);
    expect(result.failures.length).toBe(0);
    expect(result.p05PerBox[0]).toBeGreaterThanOrEqual(3.0); // Large title
    expect(result.p05PerBox[1]).toBeGreaterThanOrEqual(4.5); // Body copy >= 4.5:1
    expect(result.p05PerBox[1]).toBeGreaterThan(10.0); // Typically ~15-18:1

    // Server validator integration
    const validation = validateLayoutV2(passingLayout, {
      expectedWidth: 1080,
      expectedHeight: 1350,
      copyCount: 2,
      copyScripts: ['latin', 'latin'],
      reference: {
        rules: {
          fontFamily: 'EB Garamond',
          palette: ['#0A1628', '#1E3A5F', '#F7B500', '#FFFFFF', '#FDF8F3', '#D4E2F0'],
        },
        logoAspect: 1.0,
      },
      contrastEvaluator: (box, fontSize, bold) => {
        return fontSize >= 32 ? result.p05PerBox[0] : result.p05PerBox[1];
      },
    });

    expect(validation.ok).toBe(true);
  });
});
