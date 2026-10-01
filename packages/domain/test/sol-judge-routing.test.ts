import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_MODELS,
  DEV_MODELS,
  PRODUCTION_MODELS,
  assertModelAllowed,
  modelSupportsReasoningEffort,
  resolveModel,
} from '../src/provider-policy.js';

/**
 * ADR-237 (owner, 2026-10-01): top-quality designs use the top model everywhere a model judges or
 * looks at a design. The judge (and parity, which rides the judge role) moves from gpt-4.1-mini to
 * gpt-6.1-sol on the production tier. The development tier keeps its cheap models.
 */
describe('ADR-237: every model that looks at a design is Sol in production', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('resolves every production role that reads or judges a render to gpt-6.1-sol', () => {
    delete process.env.HAWA_MODEL_JUDGE;
    delete process.env.HAWA_MODEL_CRITIQUE;
    expect(PRODUCTION_MODELS.judge).toBe('gpt-6.1-sol');
    expect(resolveModel('judge', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('critique', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('layout', 'production')).toBe('gpt-6.1-sol');
    expect(resolveModel('text', 'production')).toBe('gpt-6.1-sol');
  });

  it('dispatches the production judge with reasoning_effort, as the other Sol roles are', () => {
    expect(() => assertModelAllowed(PRODUCTION_MODELS.judge)).not.toThrow();
    expect(modelSupportsReasoningEffort(PRODUCTION_MODELS.judge)).toBe(true);
  });

  it('leaves the development tier exactly as it was', () => {
    delete process.env.HAWA_MODEL_JUDGE;
    delete process.env.HAWA_MODEL_CRITIQUE;
    delete process.env.HAWA_MODEL_LAYOUT;
    delete process.env.HAWA_MODEL_TEXT;
    expect(DEV_MODELS).toEqual({
      layout: 'o4-mini',
      critique: 'gpt-4.1-mini',
      judge: 'gpt-4.1-mini',
      text: 'gpt-4.1-mini',
      image: 'gpt-image-2.5-sunburst',
    });
    expect(resolveModel('judge', 'dev')).toBe('gpt-4.1-mini');
    expect(resolveModel('critique', 'dev')).toBe('gpt-4.1-mini');
  });

  it('keeps gpt-4.1-mini admitted for the dev tier, an explicit rollback and historical receipts', () => {
    expect(ALLOWED_MODELS).toContain('gpt-4.1-mini');
    process.env.HAWA_MODEL_JUDGE = 'gpt-4.1-mini';
    expect(resolveModel('judge', 'production')).toBe('gpt-4.1-mini');
  });
});
