import { assert, describe, it, expect } from 'vitest';
import {
  getContrastRatio,
  evaluateContrastCompliance,
  getSafeZoneSpec,
  checkSafeZoneViolations,
  checkTextContainerOverflow,
  DeterministicQAEngine,
} from '../src/index.js';
import type { QARequest, RequestContext } from '@hawa/contracts';

describe('QA: Contrast, Layout Bounds & Safe Zone Validation', () => {
  describe('WCAG 2.2 Relative Luminance & Contrast', () => {
    it('calculates exact 21:1 ratio for black on white', () => {
      const ratio = getContrastRatio('#000000', '#ffffff');
      expect(Math.round(ratio)).toBe(21);
    });

    it('calculates 1:1 ratio for identical colors', () => {
      const ratio = getContrastRatio('#164a3a', '#164a3a');
      expect(ratio).toBeCloseTo(1.0, 2);
    });

    it('verifies Aster Forest Green on Cream passes WCAG AAA', () => {
      // Aster palette: Forest #164a3a, Cream #f4ecdd
      const res = evaluateContrastCompliance('#164a3a', '#f4ecdd', 16, false);
      expect(res.ratio).toBeGreaterThan(7.0);
      expect(res.passesAA).toBe(true);
      expect(res.passesAAA).toBe(true);
    });

    it('flags insufficient contrast for yellow on white', () => {
      const res = evaluateContrastCompliance('#ffff00', '#ffffff', 14, false);
      expect(res.ratio).toBeLessThan(1.5);
      expect(res.passesAA).toBe(false);
      expect(res.passesAAA).toBe(false);
    });

    it('applies relaxed threshold for large text', () => {
      // #949494 on white has ~3.1:1 ratio: fails normal text (<4.5:1) but passes large text (>=3.0:1)
      const resNormal = evaluateContrastCompliance('#949494', '#ffffff', 16, false);
      const resLarge = evaluateContrastCompliance('#949494', '#ffffff', 24, false);

      expect(resNormal.passesAA).toBe(false);
      expect(resLarge.passesAA).toBe(true);
    });

    it('correctly resolves named CSS color keywords and 4-digit hex codes', () => {
      const ratioKeyword = getContrastRatio('white', 'black');
      expect(Math.round(ratioKeyword)).toBe(21);

      const ratioHex4 = getContrastRatio('#fff', '#000');
      expect(Math.round(ratioHex4)).toBe(21);

      const ratioTransparent = getContrastRatio('#000000', 'transparent');
      expect(Math.round(ratioTransparent)).toBe(21);

      const ratioInvalid = getContrastRatio('#not-a-color', '#fff');
      expect(Number.isFinite(ratioInvalid)).toBe(true);
      expect(ratioInvalid).toBeGreaterThanOrEqual(1.0);
    });

    it('supports modern CSS Level 4 space-separated rgb and percentage rgb notations', () => {
      const ratioSpace = getContrastRatio('rgb(255 255 255)', '#000000');
      expect(Math.round(ratioSpace)).toBe(21);

      const ratioPercentage = getContrastRatio('rgb(100%, 100%, 100%)', '#000000');
      expect(Math.round(ratioPercentage)).toBe(21);
    });
  });

  describe('Safe Zone Specifications & Violations', () => {
    it('gracefully guards against non-positive dimensions without zero division', () => {
      const specZero = getSafeZoneSpec(0, 0);
      expect(specZero.topMarginPx).toBeGreaterThan(0);
      expect(specZero.bottomMarginPx).toBeGreaterThan(0);

      const specNegative = getSafeZoneSpec(-100, -200);
      expect(specNegative.topMarginPx).toBeGreaterThan(0);

      const nodes = [{ id: 'headline', role: 'headline', text: 'Title', x: 100, y: 100, width: 200, height: 50 }];
      const violations = checkSafeZoneViolations(nodes, 1080, 0);
      // Valid node should not have negative safeLimit or false breach
      for (const v of violations) {
        expect(v.safeLimit).toBeGreaterThan(0);
      }
    });
    it('computes 9:16 vertical story safe zones for native platform UI', () => {
      const spec = getSafeZoneSpec(1080, 1920);
      expect(spec.topMarginPx).toBeGreaterThanOrEqual(240); // Profile and status bar
      expect(spec.bottomMarginPx).toBeGreaterThanOrEqual(330); // Action sheet / reply bar
      expect(spec.leftMarginPx).toBeGreaterThanOrEqual(60);
    });

    it('detects top and bottom breaches in 9:16 format', () => {
      const nodes = [
        { id: 'headline', role: 'headline', text: 'Top Title', x: 100, y: 50, width: 800, height: 60 }, // Breaches top (<250px)
        { id: 'cta_btn', role: 'cta', text: 'Book Now', x: 200, y: 1750, width: 400, height: 80 }, // Breaches bottom (>1580px)
        { id: 'center_body', role: 'body', text: 'Safe Content', x: 100, y: 800, width: 880, height: 200 }, // Safe
      ];

      const violations = checkSafeZoneViolations(nodes, 1080, 1920);
      expect(violations).toHaveLength(2);
      expect(violations.some((v) => v.nodeId === 'headline' && v.breachEdge === 'top')).toBe(true);
      expect(violations.some((v) => v.nodeId === 'cta_btn' && v.breachEdge === 'bottom')).toBe(true);
    });

    it('passes clean layouts within 5% margins on 1:1 square feeds', () => {
      const nodes = [
        { id: 'title', role: 'headline', text: 'Square Offer', x: 100, y: 100, width: 880, height: 120 },
        { id: 'logo', role: 'logo_primary', x: 800, y: 800, width: 180, height: 180 },
      ];

      const violations = checkSafeZoneViolations(nodes, 1080, 1080);
      expect(violations).toHaveLength(0);
    });
  });

  describe('Text Container Overflow Calculation', () => {
    it('detects vertical text clipping when copy exceeds container height', () => {
      const overflowingNode = {
        id: 'long_body',
        text: 'ئەمە دەقێکی درێژە کە بە تەواوی لە ناو ئەم بۆکسە بچووکە جێگای نابێتەوە و پێویستی بە دێڕی زۆرتر هەیە تا پیشان بدرێت.',
        fontSize: 24,
        width: 200,
        height: 30, // Way too short for 100+ characters at 24px
      };

      const res = checkTextContainerOverflow(overflowingNode);
      expect(res.overflows).toBe(true);
      expect(res.estimatedHeight).toBeGreaterThan(res.containerHeight);
    });

    it('confirms clean fit when container has ample space', () => {
      const fittingNode = {
        id: 'short_title',
        text: 'ئۆفەری کورت',
        fontSize: 20,
        width: 400,
        height: 80,
      };

      const res = checkTextContainerOverflow(fittingNode);
      expect(res.overflows).toBe(false);
    });

    it('safely handles zero width, zero fontSize, and non-string text without throwing or NaN', () => {
      const resZero = checkTextContainerOverflow({
        id: 'zero_node',
        text: '',
        fontSize: 0,
        width: 0,
        height: 0,
      });
      expect(resZero.overflows).toBe(false);
      expect(Number.isFinite(resZero.estimatedHeight)).toBe(true);

      const resNullText = checkTextContainerOverflow({
        id: 'null_text',
        text: null as any,
        fontSize: 16,
        width: 200,
        height: 50,
      });
      expect(resNullText.overflows).toBe(false);
    });
  });

  describe('DeterministicQAEngine Extended Checks', () => {
    it('executes full QA run including safe zones and contrast', async () => {
      const engine = new DeterministicQAEngine();
      const ctx: RequestContext = {
        tenantId: 't1',
        actor: { type: 'system', id: 'sys' },
        correlationId: 'c1', deadline: new Date(Date.now() + 60000).toISOString(), idempotencyKey: 'qa-contrast-fixture',
      };

      const request: QARequest = {
        taskId: 'task-contrast-1',
        designRevisionId: 'rev-1',
        document: { documentId: 'doc-contrast-1', sourceRevision: 1, sourceSha256: '1'.repeat(64), studio: 'canva', studioVersion: '1', schemaVersion: '1' },
        sourceHash: '1'.repeat(64), renders: [], profile: { name: 'strict', version: '1', rules: {} },
        brief: {
          variants: [{ width: 1080, height: 1080 }],
          exactCopy: [{ text: 'پیرۆزە' }],
        },
        clientDna: {
          assets: [{ sha256: 'logo_sha_123', role: 'logo_primary' }],
        },
        manifest: {
          fonts: [], assets: [], warnings: [],
          pages: [{ id: 'p1', name: 'Square', width: 1080, height: 1080, unit: 'px' }],
          nodes: [
            {
              id: 'n1',
              text: 'پیرۆزە',
              box: { x: 100, y: 100, width: 400, height: 80 },
              fill: '#164a3a',
            } as any,
            {
              id: 'n2',
              assetSha256: 'logo_sha_123',
              box: { x: 800, y: 100, width: 120, height: 120 },
            } as any,
          ],
        },
        repairCycle: 0,
      };

      const res = await engine.run(ctx, request);
      expect(res.ok).toBe(true); assert(res.ok);
      if (!res.ok) return;

      const checkIds = res.value.checks.map((c) => c.id);
      expect(checkIds).toContain('check_layout_dimensions');
      expect(checkIds).toContain('check_exact_copy');
      expect(checkIds).toContain('check_bidi_integrity');
      expect(checkIds).toContain('check_brand_assets');
      expect(checkIds).toContain('check_safe_zones');
      expect(checkIds).toContain('check_contrast_compliance');
      expect(res.value.criticalPass).toBe(true);
    });
  });
});
