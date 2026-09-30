import { afterEach, describe, expect, it } from 'vitest';
import { assertModelAllowed, modelSupportsReasoningEffort, resolveModel } from '../src/provider-policy.js';
import { StudioSubstepReplay } from '../src/studio-substeps.js';

describe('ADR-148 Sol remains an explicit candidate', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it('permits evaluation but refuses production before measured promotion', () => {
    process.env.HAWA_MODEL_TIER = 'dev';
    expect(() => assertModelAllowed('gpt-6.1-sol')).not.toThrow();
    expect(modelSupportsReasoningEffort('gpt-6.1-sol')).toBe(true);
    process.env.HAWA_MODEL_TEXT = 'gpt-6.1-sol';
    expect(resolveModel('text', 'dev')).toBe('gpt-6.1-sol');
    process.env.HAWA_MODEL_TIER = 'production';
    expect(() => assertModelAllowed('gpt-6.1-sol')).toThrow();
    delete process.env.HAWA_MODEL_TEXT;
    expect(resolveModel('text', 'production')).toBe('gpt-6-astra');
    expect(resolveModel('judge', 'production')).toBe('gpt-4.1-mini');
    expect(() => assertModelAllowed('jev-1.13.0')).toThrow();
    expect(() => assertModelAllowed('gpt-6.1-sol-latest')).toThrow();
  });

  it('holds retained Astra work when a caller tries to resume it with Sol', () => {
    const digest = 'a'.repeat(64);
    const replay = new StudioSubstepReplay([{
      callId: 'saved-astra', substep: 'layout/concept-1', attempt: 1, ordinal: 1,
      stage: 'laying_out', provider: 'openai', model: 'gpt-6-astra', status: 'ok',
      retained: true, costBasis: 'usage', usd: 0.01, errorCode: null,
      requestSha256: digest, bindingSha256: digest,
    }]);
    expect(replay.next({ substep: 'layout/concept-1', stage: 'laying_out', provider: 'openai',
      model: 'gpt-6.1-sol', kind: 'structured', requestSha256: digest, bindingSha256: digest,
    })).toMatchObject({ action: 'hold' });
  });
});
