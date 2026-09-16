import { describe, it, expect } from 'vitest';
import {
  validateLayoutV2,
  type LayoutValidationContext,
} from '../src/studio/validate-layout-v2.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

const KAAE_PALETTE = [
  '#0A1628', // Midnight Navy
  '#1E3A5F', // Royal Navy
  '#4770A3', // KAAE Primary Blue
  '#D4E2F0', // Sky Ice Blue
  '#F7B500', // Kurdistan Sun Gold
  '#FDF8F3', // Academic Cream
  '#FFFFFF', // Pure White
];

const BASE_CONTEXT: LayoutValidationContext = {
  expectedWidth: 1080,
  expectedHeight: 1350,
  copyCount: 4,
  copyScripts: ['latin', 'latin', 'latin', 'latin'],
  reference: {
    rules: {
      fontFamily: 'Verdana',
      palette: KAAE_PALETTE,
      scriptFonts: {
        arabic: 'Noto Sans Arabic',
      },
    },
    logoAspect: 1.0, // 1:1 aspect
  },
  draftFont: 'Verdana',
};

function createPassingLayout(width = 1080, height = 1350, arabicIndices: number[] = []): StudioLayoutV2 {
  const shortEdge = Math.min(width, height);
  const margin = Math.floor(shortEdge * 0.08); // 8% safe margin
  const logoWidth = Math.max(100, Math.ceil(0.085 * width));
  const minBody = Math.ceil(0.016 * width);
  const bodySize = Math.max(20, minBody);
  const titleSize = Math.ceil(bodySize * 2.5);
  const subtitleSize = Math.ceil(bodySize * 1.4);
  const eyebrowSize = Math.max(12, Math.floor(bodySize * 0.8));

  const logoClearSpaceY = margin + logoWidth + Math.ceil(0.55 * logoWidth);
  const ruleY = logoClearSpaceY + 10;
  const eyebrowY = ruleY + 15;
  const titleY = eyebrowY + 35;
  const subtitleY = titleY + 100;
  const bodyY = subtitleY + 60;

  return {
    version: 2,
    width,
    height,
    grid: { margin, columns: 6, gutter: 20, baseline: 8 },
    background: { color: '#0A1628' },
    art: {
      source: 'generated',
      prompt: 'Abstract geometric architectural arches with subtle golden illumination',
      box: { x: 0, y: 0, width, height },
      opacity: 0.2,
      calmRegion: { x: margin, y: margin, width: width - 2 * margin, height: height - 2 * margin },
    },
    shapes: [
      {
        x: margin,
        y: ruleY,
        width: width - 2 * margin,
        height: 2,
        kind: 'line',
        color: '#F7B500',
        role: 'rule',
      },
    ],
    logo: {
      x: margin,
      y: margin,
      width: logoWidth,
      height: logoWidth,
    },
    text: [
      {
        copyIndex: 0,
        role: 'eyebrow',
        x: margin,
        y: eyebrowY,
        width: width - 2 * margin,
        height: 30,
        fontSize: eyebrowSize,
        lineHeight: arabicIndices.includes(0) ? 1.7 : 1.3,
        fontFamily: 'Verdana',
        color: '#D4E2F0',
        align: 'left',
      },
      {
        copyIndex: 1,
        role: 'title',
        x: margin,
        y: titleY,
        width: width - 2 * margin,
        height: 90,
        fontSize: titleSize,
        lineHeight: arabicIndices.includes(1) ? 1.7 : 1.2,
        fontFamily: 'Verdana',
        color: '#F7B500',
        align: 'left',
        bold: true,
      },
      {
        copyIndex: 2,
        role: 'subtitle',
        x: margin,
        y: subtitleY,
        width: width - 2 * margin,
        height: 50,
        fontSize: subtitleSize,
        lineHeight: arabicIndices.includes(2) ? 1.7 : 1.3,
        fontFamily: 'Verdana',
        color: '#FFFFFF',
        align: 'left',
      },
      {
        copyIndex: 3,
        role: 'body',
        x: margin,
        y: bodyY,
        width: width - 2 * margin,
        height: 100,
        fontSize: bodySize,
        lineHeight: arabicIndices.includes(3) ? 1.7 : 1.4,
        fontFamily: 'Verdana',
        color: '#FDF8F3',
        align: 'left',
      },
    ],
  };
}

describe('Design Studio v2: Layout Validation Engine (validateLayoutV2)', () => {
  describe('Format conformance: passing layouts across all 5 standard aspect ratios', () => {
    it('passes 1080x1350 (4:5 Portrait)', () => {
      const layout = createPassingLayout(1080, 1350);
      const res = validateLayoutV2(layout, { ...BASE_CONTEXT, expectedWidth: 1080, expectedHeight: 1350 });
      expect(res.ok).toBe(true);
    });

    it('passes 1080x1080 (1:1 Square)', () => {
      const layout = createPassingLayout(1080, 1080);
      const res = validateLayoutV2(layout, { ...BASE_CONTEXT, expectedWidth: 1080, expectedHeight: 1080 });
      expect(res.ok).toBe(true);
    });

    it('passes 1080x1920 (9:16 Story)', () => {
      const layout = createPassingLayout(1080, 1920);
      const res = validateLayoutV2(layout, { ...BASE_CONTEXT, expectedWidth: 1080, expectedHeight: 1920 });
      expect(res.ok).toBe(true);
    });

    it('passes 1240x1754 (A4 Document)', () => {
      const layout = createPassingLayout(1240, 1754);
      const res = validateLayoutV2(layout, { ...BASE_CONTEXT, expectedWidth: 1240, expectedHeight: 1754 });
      expect(res.ok).toBe(true);
    });

    it('passes 1920x1080 (16:9 Landscape Screen)', () => {
      const layout = createPassingLayout(1920, 1080);
      const res = validateLayoutV2(layout, { ...BASE_CONTEXT, expectedWidth: 1920, expectedHeight: 1080 });
      expect(res.ok).toBe(true);
    });
  });

  describe('Adversarial Hard-Fail Cases (14 Codes)', () => {
    it('code DIMENSIONS_CHANGED: rejects when width or height differ from request', () => {
      const layout = createPassingLayout();
      layout.width = 1200;
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('DIMENSIONS_CHANGED');
    });

    it('code COPY_PLACEMENT: rejects missing or duplicated copyIndex', () => {
      const layout = createPassingLayout();
      layout.text[1].copyIndex = 0; // Duplicate index 0, missing index 1
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('COPY_PLACEMENT');
    });

    it('code FONT_NOT_ADMITTED: rejects unadmitted Latin font', () => {
      const layout = createPassingLayout();
      layout.text[0].fontFamily = 'Comic Sans MS';
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('FONT_NOT_ADMITTED');
    });

    it('code PALETTE: rejects non-brand hex color in shapes or text', () => {
      const layout = createPassingLayout();
      layout.shapes[0].color = '#FF0055'; // Non-brand neon pink
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('PALETTE');
    });

    it('code BOUNDS: rejects element or margin violating safe margin (6% short edge)', () => {
      const layout = createPassingLayout();
      layout.grid.margin = 30; // 30 < 0.06 * 1080 (64.8 px)
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('BOUNDS');
    });

    it('code OVERLAP: rejects text-text or rule-text collision', () => {
      const layout = createPassingLayout();
      layout.text[1].y = layout.text[0].y + 10; // title collides with eyebrow
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('OVERLAP');
    });

    it('code MIN_SIZE: rejects body text smaller than 1.6% width or title < 2.2x body', () => {
      const layout = createPassingLayout();
      layout.text[3].fontSize = 15; // 15 < 1080 * 0.016 (17.28px)
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('MIN_SIZE');
    });

    it('code LINE_HEIGHT: rejects Latin line-height outside [1.2, 1.5] or Arabic outside [1.6, 1.9]', () => {
      const layout = createPassingLayout();
      layout.text[1].lineHeight = 1.0; // Latin line height too tight (< 1.2)
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('LINE_HEIGHT');
    });

    it('code LETTER_SPACING: rejects letter-spacing on Arabic or body copy', () => {
      const layout = createPassingLayout();
      layout.text[3].letterSpacing = 0.05; // Body text must not have letter-spacing
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('LETTER_SPACING');
    });

    it('code HIERARCHY: rejects subtitle larger than title or body larger than date', () => {
      const layout = createPassingLayout();
      layout.text[2].fontSize = 52; // Subtitle (52) > Title (48)
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('HIERARCHY');
    });

    it('code LOGO: rejects width < 8% or clear space violation', () => {
      const layout = createPassingLayout();
      layout.logo.width = 60; // 60 < max(100, 0.08 * 1080 = 86)
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('LOGO');
    });

    it('code ART_SAFETY: rejects forbidden words (person, face, logo) in prompt or text outside calmRegion', () => {
      const layout = createPassingLayout();
      layout.art!.prompt = 'A portrait of an academic leader facing forward'; // Forbidden "portrait"
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('ART_SAFETY');
    });

    it('code CONTRAST: rejects text box with insufficient contrast (< 4.5:1 for body)', () => {
      const layout = createPassingLayout();
      const res = validateLayoutV2(layout, {
        ...BASE_CONTEXT,
        contrastEvaluator: (box, fontSize) => (fontSize === 20 ? 2.8 : 8.5), // body has 2.8:1 < 4.5:1
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('CONTRAST');
    });

    it('code COUNTS: rejects text or shape arrays exceeding 40 elements', () => {
      const layout = createPassingLayout();
      for (let i = 0; i < 45; i++) {
        layout.shapes.push({
          x: 100,
          y: 100,
          width: 20,
          height: 2,
          kind: 'line',
          color: '#F7B500',
          role: 'accent',
        });
      }
      const res = validateLayoutV2(layout, BASE_CONTEXT);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('COUNTS');
    });
  });

  describe('Arabic Script Normalization', () => {
    it('normalizes Arabic blocks to Noto Sans Arabic, right-aligned, rtl:true', () => {
      const layout = createPassingLayout(1080, 1350, [2, 3]);
      const context: LayoutValidationContext = {
        ...BASE_CONTEXT,
        copyScripts: ['latin', 'latin', 'arabic', 'arabic'],
      };
      const res = validateLayoutV2(layout, context);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.layout.text[2].fontFamily).toBe('Noto Sans Arabic');
        expect(res.layout.text[2].align).toBe('right');
        expect(res.layout.text[2].rtl).toBe(true);
      }
    });
  });
});
