import { describe, expect, it, afterEach } from 'vitest';
import {
  ALLOWED_MODELS,
  PRODUCTION_MODELS,
  assertModelAllowed,
  resolveModel,
} from '../src/provider-policy.js';

/**
 * The judge's tier is an owner decision with a recorded reason, so it cannot change by accident.
 *
 * 2026-09-20: the judge moved to gpt-4.1-mini on an agreement replay against the old gpt-6-astra
 * judge (scripts/experiments/judge-model-agreement.ts: 75% agreement with the stored verdicts, 67%
 * for the expensive judge against itself, the canary caught 12 of 12 by both).
 *
 * 2026-10-01, ADR-237: the owner decided that top-quality designs use the top model everywhere a
 * model judges or looks at a design. The replay measured agreement with an older judge, not which
 * poster is better, so it does not stand against that decision. The judge is gpt-6.1-sol again on
 * the production tier; gpt-4.1-mini stays the dev tier's judge and an explicit rollback.
 */
describe('the production judge is the owner-selected top model (ADR-237)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('resolves the judge to gpt-6.1-sol, like every other production role that reads a design', () => {
    delete process.env.HAWA_MODEL_JUDGE;
    expect(resolveModel('judge', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('layout', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('critique', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('text', 'production')).toBe('gpt-6.1-sol');
  });

  it('admits the judge model to the production allowlist, so the call is not refused at dispatch', () => {
    // Without this the change is worse than useless: resolveModel hands back a model that
    // assertModelAllowed then rejects, and every production run dies at the judge.
    delete process.env.HAWA_MODEL_TIER;
    process.env.NODE_ENV = 'production';
    expect(() => assertModelAllowed(PRODUCTION_MODELS.judge)).not.toThrow();
    // The previous judge stays admitted for the dev tier, a rollback and historical receipts.
    expect(ALLOWED_MODELS).toContain('gpt-4.1-mini');
    expect(() => assertModelAllowed('gpt-4.1-mini')).not.toThrow();
    expect(() => assertModelAllowed('gpt-6-astra')).not.toThrow();
  });

  it('still refuses another provider in production, cheap or not', () => {
    delete process.env.HAWA_MODEL_TIER;
    process.env.NODE_ENV = 'production';
    for (const model of ['claude-fable-5-1', 'gemini-3.1-flash-image', 'gpt-4o-mini']) {
      expect(() => assertModelAllowed(model)).toThrow();
    }
  });

  it('lets one deployment or one run override the judge without touching the allowlist rules', () => {
    process.env.HAWA_MODEL_JUDGE = 'gpt-4.1-mini';
    expect(resolveModel('judge', 'production')).toBe('gpt-4.1-mini');
    process.env.HAWA_MODEL_JUDGE = 'gpt-6-astra';
    expect(resolveModel('judge', 'production')).toBe('gpt-6-astra');
  });
});
