import { describe, it, expect } from 'vitest';
import {
  validateLayoutV2,
  type StudioLayoutV2,
  isFontAdmitted,
  getCanonicalFontPolicy,
  isStoryFormat,
  getSafeZoneBox,
  HOUSE_RULES,
  computeTypeScaleConformance,
} from '../src/index.js';

describe('Task 7: Creative Engine Remediation', () => {
  describe('1. One Font Policy', () => {
    it('proves unified font policy function is exported and validates admitted fonts', () => {
      expect(typeof isFontAdmitted).toBe('function');
      const policy = getCanonicalFontPolicy();
      expect(policy.families.length).toBeGreaterThan(5);

      // Admitted standard fonts
      expect(isFontAdmitted('Inter')).toBe(true);
      expect(isFontAdmitted('Noto Sans Arabic')).toBe(true);
      expect(isFontAdmitted('Cairo')).toBe(true);
      expect(isFontAdmitted('Vazirmatn')).toBe(true);
      expect(isFontAdmitted('Cinzel')).toBe(true);

      // Disallowed font
      expect(isFontAdmitted('ComicSansNotAllowed')).toBe(false);
    });
  });

  describe('2. One Contrast Implementation', () => {
    it('proves brand-kits and vector-compositor use canonical composite-contrast luminance and ratios', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const __dirname = path.dirname(fileURLToPath(import.meta.url));

      const brandKitsSrc = fs.readFileSync(path.resolve(__dirname, '../src/brand-kits.ts'), 'utf8');
      expect(brandKitsSrc).toContain("from './studio/composite-contrast.js'");

      const vectorCompSrc = fs.readFileSync(path.resolve(__dirname, '../src/vector-compositor.ts'), 'utf8');
      expect(vectorCompSrc).toContain("from './studio/composite-contrast.js'");
    });
  });

  describe('3. Story Safe Zones (9:16 Vertical)', () => {
    it('identifies 9:16 layouts as story format and computes safe zone boundaries', () => {
      expect(isStoryFormat(1080, 1920)).toBe(true);
      expect(isStoryFormat(1080, 1080)).toBe(false);
      expect(isStoryFormat(1920, 1080)).toBe(false);

      const safeBox = getSafeZoneBox(1080, 1920);
      expect(safeBox.y).toBeGreaterThanOrEqual(250); // Top danger zone (~270px)
      expect(safeBox.y + safeBox.height).toBeLessThanOrEqual(1920 - 350); // Bottom danger zone (~384px)
    });

    it('rejects story layouts where text or logo intrudes into top or bottom platform danger zones', () => {
      const storyLayoutWithIntrudingHeader: StudioLayoutV2 = {
        version: 2,
        width: 1080,
        height: 1920,
        grid: { margin: 65, columns: 6, gutter: 20, baseline: 8 },
        background: { color: '#0A1628' },
        shapes: [],
        logo: { x: 450, y: 70, width: 180, height: 180 }, // In top danger zone (y < 268)
        text: [
          {
            copyIndex: 0,
            role: 'title',
            x: 100,
            y: 400,
            width: 880,
            height: 120,
            fontSize: 48,
            lineHeight: 1.3,
            color: '#FFFFFF',
            fontFamily: 'Inter',
            align: 'center',
          },
        ],
      };

      const res = validateLayoutV2(storyLayoutWithIntrudingHeader, {
        expectedWidth: 1080,
        expectedHeight: 1920,
        copyCount: 1,
        copyScripts: ['latin'],
        reference: {
          rules: {
            fontFamily: 'Inter',
            palette: ['#0A1628', '#FFFFFF'],
            scriptFonts: { arabic: 'Cairo' },
          },
          logoAspect: 1.0,
        },
      });

      expect(res.ok).toBe(false);
      expect((res as any).code).toBe('BOUNDS');
      expect((res as any).message).toMatch(/story/i);
    });
  });

  describe('4. Medium-Aware Type Scale', () => {
    it('evaluates type scale conformance with format-adapted ratios', () => {
      const a4DocLayout: StudioLayoutV2 = {
        version: 2,
        width: 1240,
        height: 1754,
        grid: { margin: 100, columns: 6, gutter: 20, baseline: 8 },
        background: { color: '#FFFFFF' },
        shapes: [],
        logo: { x: 100, y: 100, width: 120, height: 120 },
        text: [
          { copyIndex: 0, role: 'title', x: 100, y: 250, width: 1040, height: 60, fontSize: 32, lineHeight: 1.3, color: '#000000', fontFamily: 'Inter', align: 'left' },
          { copyIndex: 1, role: 'body', x: 100, y: 330, width: 1040, height: 40, fontSize: 16, lineHeight: 1.4, color: '#333333', fontFamily: 'Inter', align: 'left' },
        ],
      };

      const result = computeTypeScaleConformance(a4DocLayout);
      expect(result.metric).toBe('typeScale');
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });
  });
});
