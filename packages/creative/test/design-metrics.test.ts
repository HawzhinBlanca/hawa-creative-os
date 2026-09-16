import { describe, it, expect } from 'vitest';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';
import {
  evaluateDesignMetrics,
  checkCandidateSetDegeneracy,
} from '../src/studio/design-metrics.js';

import {
  SIX_CONFIRMED_EXEMPLARS,
  SIX_DROPPED_NEGATIVE_FIXTURES,
  BAD_BILATERAL_GRID,
  BAD_LOW_CONTRAST,
  BAD_OFF_GRID,
  DEGENERATE_SET,
} from './fixtures/design-metrics-fixtures.js';

describe('P01 — Deterministic Design Metrics (arXiv 2402.06945 & LaySPA)', () => {
  it('calibrates all SIX owner-confirmed exemplars in top band (composite >= 0.80, all passing)', () => {
    expect(SIX_CONFIRMED_EXEMPLARS.length).toBe(6);

    for (let i = 0; i < SIX_CONFIRMED_EXEMPLARS.length; i++) {
      const ex = SIX_CONFIRMED_EXEMPLARS[i];
      const report = evaluateDesignMetrics(ex);

      if (!report.passed || report.compositeScore < 0.80) {
        console.log(`Exemplar ${i + 1} failed:`, {
          score: report.compositeScore,
          failingMetrics: report.failingMetrics,
          gridDetails: report.metrics.gridAppropriateness,
          regularityDetails: report.metrics.regularity,
          typeScaleDetails: report.metrics.typeScale,
        });
      }

      expect(report.compositeScore).toBeGreaterThanOrEqual(0.80);
      expect(report.passed).toBe(true);
      expect(report.failingMetrics.length).toBe(0);
      expect(report.executionTimeMs).toBeLessThan(50); // Hard runtime limit < 50ms
    }
  });

  it('fails all SIX dropped review entries on their specific named defects (negative fixtures)', () => {
    expect(SIX_DROPPED_NEGATIVE_FIXTURES.length).toBe(6);

    for (const item of SIX_DROPPED_NEGATIVE_FIXTURES) {
      const report = evaluateDesignMetrics(item.layout as StudioLayoutV2);
      expect(report.passed).toBe(false);
      expect(report.failingMetrics).toContain(item.expectedFailingMetric);
    }
  });

  it('fails low-contrast candidate with named textLegibility failure', () => {
    const report = evaluateDesignMetrics(BAD_LOW_CONTRAST);
    expect(report.passed).toBe(false);
    expect(report.metrics.textLegibility.passed).toBe(false);
    expect(report.failingMetrics).toContain('textLegibility');

    const issues = (report.metrics.textLegibility.details as any)?.failingIssues || [];
    expect(issues.some((s: string) => s.includes('contrast'))).toBe(true);
  });

  it('fails off-grid candidate on gridAppropriateness', () => {
    const report = evaluateDesignMetrics(BAD_OFF_GRID);
    expect(report.passed).toBe(false);
    expect(report.metrics.gridAppropriateness.passed).toBe(false);
    expect(report.failingMetrics).toContain('gridAppropriateness');
  });

  it('fails boxy bilateral grid candidate on typefacePairing (Arimo F12 violation)', () => {
    const report = evaluateDesignMetrics(BAD_BILATERAL_GRID);
    expect(report.passed).toBe(false);
    expect(report.metrics.typefacePairing.passed).toBe(false);
    expect(report.failingMetrics).toContain('typefacePairing');
  });

  it('detects and flags hand-built degenerate set of three near-identical layouts', () => {
    const setCheck = checkCandidateSetDegeneracy(DEGENERATE_SET);
    expect(setCheck.isDegenerate).toBe(true);
    expect(setCheck.reason).toBeDefined();
    expect(setCheck.reason).toContain('near-identical');
  });

  it('verifies non-degenerate candidate set passes degeneracy check', () => {
    const nonDegenerateSet = [SIX_CONFIRMED_EXEMPLARS[0], SIX_CONFIRMED_EXEMPLARS[1], SIX_CONFIRMED_EXEMPLARS[2]];
    const setCheck = checkCandidateSetDegeneracy(nonDegenerateSet);
    expect(setCheck.isDegenerate).toBe(false);
  });

  it('computes occlusion metric with art layer calm region correctly', () => {
    const layoutWithArt: StudioLayoutV2 = {
      ...SIX_CONFIRMED_EXEMPLARS[0],
      art: {
        source: 'generated',
        box: { x: 0, y: 0, width: 1080, height: 1080 },
        opacity: 0.3,
        calmRegion: { x: 50, y: 150, width: 980, height: 900 },
      },
    };

    const report = evaluateDesignMetrics(layoutWithArt);
    expect(report.metrics.occlusion.passed).toBe(true);
    expect(report.metrics.occlusion.score).toBeGreaterThanOrEqual(0.85);

    // Now violate calm region
    const layoutViolatingCalm: StudioLayoutV2 = {
      ...SIX_CONFIRMED_EXEMPLARS[0],
      art: {
        source: 'generated',
        box: { x: 0, y: 0, width: 1080, height: 1080 },
        opacity: 0.3,
        calmRegion: { x: 50, y: 150, width: 200, height: 200 }, // very small calm region
      },
    };

    const violatingReport = evaluateDesignMetrics(layoutViolatingCalm);
    expect(violatingReport.metrics.occlusion.score).toBeLessThan(0.85);
    expect(violatingReport.metrics.occlusion.passed).toBe(false);
  });
});
