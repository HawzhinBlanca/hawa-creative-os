import { describe, expect, it, afterEach } from 'vitest';
import {
  ALLOWED_MODELS,
  PRODUCTION_MODELS,
  assertModelAllowed,
  resolveModel,
} from '../src/provider-policy.js';

/**
 * The judging stage was 27% of a production run — $0.171 of $0.629 per design, measured over 16
 * runs in hawa.design_studio_calls — for four calls that pick between candidates already made.
 *
 * It moved to a cheap model on evidence: scripts/experiments/judge-model-agreement.ts replayed 24
 * stored production judgments (the candidates still carry the preview PNGs their judge saw, and
 * design_studio_judgments stores its per-dimension votes) and found gpt-4.1-mini agreeing with the
 * expensive judge's own past verdicts 75% of the time, where the expensive judge replayed against
 * itself agreed only 67%. Both caught the degraded-copy canary 12 times out of 12 in both orders.
 *
 * These tests exist so that decision cannot be undone by accident — reverting the model, or
 * dropping it from the allowlist, has to be deliberate and has to come with new evidence.
 */
describe('the judge runs on the cheap tier in production, by measurement', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('resolves the judge to gpt-4.1-mini while the owner-selected design roles use Sol 6.1', () => {
    expect(resolveModel('judge', 'production')).toBe('gpt-4.1-mini');
    expect(resolveModel('layout', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('critique', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('text', 'production')).toBe('gpt-6.1-sol');
  });

  it('admits the judge model to the production allowlist, so the call is not refused at dispatch', () => {
    // Without this the change is worse than useless: resolveModel hands back a model that
    // assertModelAllowed then rejects, and every production run dies at the judge.
    delete process.env.HAWA_MODEL_TIER;
    process.env.NODE_ENV = 'production';
    expect(ALLOWED_MODELS).toContain('gpt-4.1-mini');
    expect(() => assertModelAllowed(PRODUCTION_MODELS.judge)).not.toThrow();
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
    process.env.HAWA_MODEL_JUDGE = 'gpt-6-astra';
    expect(resolveModel('judge', 'production')).toBe('gpt-6-astra');
  });
});
