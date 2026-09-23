import { describe, it, expect } from 'vitest';
import { studioFailureCode } from '../src/canva-draft-workflow.js';

describe('the code a failed studio run is recorded under', () => {
  it('names an exhausted provider account and a refused key, not a generic failure', () => {
    expect(studioFailureCode({ diagnostic: 'Studio v3 failed at stage briefing: OpenAI HTTP 429 insufficient_quota: You exceeded your current quota' })).toBe('MODEL_CREDIT_EXHAUSTED');
    expect(studioFailureCode({ message: 'OpenAI HTTP 401 invalid_api_key' })).toBe('MODEL_KEY_REFUSED');
    expect(studioFailureCode({ diagnostic: 'Studio v3 failed: Winner failed hard QA: OVERLAP' })).toBe('HARD_QA_REFUSED');
    expect(studioFailureCode({ diagnostic: 'something else' })).toBe('STUDIO_FAILED');
  });
});
