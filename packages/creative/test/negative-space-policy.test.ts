import { describe, expect, it } from 'vitest';
import {
  NEGATIVE_SPACE_POLICY,
  negativeSpacePolicyIdentity,
  negativeSpacePassingInterval,
  negativeSpaceSingleFactorLimits,
  negativeSpacePromptGuidance,
  scoreNegativeSpace,
} from '../src/studio/negative-space-policy.js';
import { computeNegativeSpace, evaluateDesignMetrics } from '../src/studio/design-metrics.js';
import { buildLayoutV3SystemPrompt } from '../src/studio/layout-generator-v3.js';
import type { StudioLayoutV2 } from '../src/studio/layout-v2.js';

/**
 * ADR-125. The generator was told "0.35 to 0.58" and "never leave 40% of the canvas empty" while
 * the checker it is ranked by passes measured-line emptiness from 0.36 to 0.84. One versioned
 * definition now produces both the prompt statement and the score.
 */

// Recorded when policy version 2026-09-28.1 was introduced. Changing any number, measure or
// threshold changes this digest, so the policy version must change with it.
const RECORDED_POLICY_DIGESTS: Record<string, string> = {
  '2026-09-28.1': '34666d51025648a2a502d20a417b47c76ee8615f1b1e3a5a3b3b05d548078b5e',
};

/** The design-precision probe's layout: four one-line text boxes of 600x180 and a 200x100 logo. */
function probeLayout(): StudioLayoutV2 {
  return {
    version: 2, width: 1000, height: 1000,
    background: { color: '#ffffff' }, grid: { margin: 50, columns: 6, gutter: 20, baseline: 8 },
    logo: { x: 400, y: 850, width: 200, height: 100 }, shapes: [],
    text: [0, 1, 2, 3].map((i) => ({ copyIndex: i, role: 'body' as const, x: 200, y: 50 + i * 200,
      width: 600, height: 180, fontSize: 50, lineHeight: 1.5, fontFamily: 'Verdana', color: '#000000', align: 'left' as const })),
  };
}

describe('one versioned negative-space policy (ADR-125)', () => {
  it('pins the policy definition to its version', () => {
    const identity = negativeSpacePolicyIdentity();
    expect(identity.id).toBe('studio.negative-space');
    expect(identity.version).toBe(NEGATIVE_SPACE_POLICY.version);
    expect(identity.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(RECORDED_POLICY_DIGESTS[identity.version]).toBe(identity.sha256);
  });

  it('derives the passing range from the scoring function, per measure', () => {
    expect(negativeSpacePassingInterval('measured_lines')).toEqual({ min: 0.36, max: 0.84 });
    expect(negativeSpacePassingInterval('declared_boxes')).toEqual({ min: 0.25, max: 0.65 });
    for (const measure of ['measured_lines', 'declared_boxes'] as const) {
      const { min, max } = negativeSpacePassingInterval(measure);
      for (let f = 0; f <= 1.0001; f += 0.005) {
        const fraction = Number(f.toFixed(3));
        const passes = scoreNegativeSpace({ fraction, internalGapFraction: 0, bottomVoid: 0, measure }) >= NEGATIVE_SPACE_POLICY.passScore;
        expect(passes, `${measure} fraction ${fraction}`).toBe(fraction >= min && fraction <= max);
      }
    }
    const limits = negativeSpaceSingleFactorLimits();
    expect(limits.internalGap.penaltyAbove).toBe(0.22);
    expect(limits.bottomVoid.penaltyAbove).toBe(0.25);
    // From the preferred plateau, the gap and the bottom void alone fail just past these values.
    expect(scoreNegativeSpace({ fraction: 0.6, internalGapFraction: limits.internalGap.failsAbove, bottomVoid: 0, measure: 'measured_lines' })).toBeGreaterThanOrEqual(0.7);
    expect(scoreNegativeSpace({ fraction: 0.6, internalGapFraction: limits.internalGap.failsAbove + 0.005, bottomVoid: 0, measure: 'measured_lines' })).toBeLessThan(0.7);
    expect(scoreNegativeSpace({ fraction: 0.6, internalGapFraction: 0, bottomVoid: limits.bottomVoid.failsAbove, measure: 'measured_lines' })).toBeGreaterThanOrEqual(0.7);
    expect(scoreNegativeSpace({ fraction: 0.6, internalGapFraction: 0, bottomVoid: limits.bottomVoid.failsAbove + 0.005, measure: 'measured_lines' })).toBeLessThan(0.7);
  });

  it('tells the generator the checker definition, not a different band', () => {
    const prompt = buildLayoutV3SystemPrompt();
    const guidance = negativeSpacePromptGuidance();
    expect(prompt).toContain(guidance);
    expect(prompt).not.toContain('0.35 to 0.58');
    expect(prompt).not.toContain('Never leave 40% of the canvas empty');
    expect(prompt).not.toContain('> 0.20 of canvas height');
    expect(guidance).toContain(`${NEGATIVE_SPACE_POLICY.id} ${NEGATIVE_SPACE_POLICY.version}`);
    for (const value of ['0.36', '0.84', '0.44', '0.78', '0.22', '0.29', '0.25', '0.34']) expect(guidance).toContain(value);
    // The explicit measurement semantics, including what the measure does not count.
    expect(guidance).toMatch(/measured line count/);
    expect(guidance).toMatch(/Photographs and artwork are not counted/);
  });

  it('scores through the policy and records the definition with every result', () => {
    const lines = { 0: 1, 1: 1, 2: 1, 3: 1 };
    const measured = computeNegativeSpace(probeLayout(), lines);
    const declared = computeNegativeSpace(probeLayout());
    // Values reproduced by the 2026-09-28 design-precision probe; the refactor changes no decision.
    expect(measured).toMatchObject({ score: 0.867, passed: true, details: { fraction: 0.8, internalGapFraction: 0.02, bottomVoid: 0.05 } });
    expect(measured.details).toMatchObject({ measure: 'measured_lines', policyId: 'studio.negative-space', policyVersion: NEGATIVE_SPACE_POLICY.version,
      policySha256: negativeSpacePolicyIdentity().sha256 });
    expect(declared.details).toMatchObject({ measure: 'declared_boxes', fraction: 0.548 });
    expect(evaluateDesignMetrics(probeLayout(), { wrappedLines: lines }).metrics.negativeSpace).toEqual(measured);
    const fraction = Number(measured.details?.fraction);
    const interval = negativeSpacePassingInterval('measured_lines');
    // The prompt and the checker now agree on this design: inside the stated range, and it passes.
    expect(fraction >= interval.min && fraction <= interval.max).toBe(measured.passed);
  });
});
