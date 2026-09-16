import { describe, it, expect } from 'vitest';
import {
  assertModelAllowed,
  assertProviderAllowed,
  DisallowedProviderError,
  ALLOWED_MODELS,
} from '../src/provider-policy.js';

describe('Provider Policy (ADR-030 & G01)', () => {
  it('permits strictly allowlisted OpenAI models', () => {
    expect(() => assertModelAllowed('gpt-6-astra')).not.toThrow();
    expect(() => assertModelAllowed('gpt-image-2.5-sunburst')).not.toThrow();
  });

  it('rejects legacy Anthropic Claude models before network access', () => {
    expect(() => assertModelAllowed('claude-opus-5')).toThrow(DisallowedProviderError);
    expect(() => assertModelAllowed('claude-fable-5-1')).toThrow(DisallowedProviderError);
    expect(() => assertModelAllowed('claude-3-5-sonnet-20241022')).toThrow(DisallowedProviderError);
  });

  it('rejects Google Gemini models before network access', () => {
    expect(() => assertModelAllowed('gemini-3-pro-image')).toThrow(DisallowedProviderError);
    expect(() => assertModelAllowed('gemini-2.0-flash')).toThrow(DisallowedProviderError);
    expect(() => assertModelAllowed('gemini-1.5-pro')).toThrow(DisallowedProviderError);
  });

  it('rejects non-allowlisted OpenAI models before network access', () => {
    expect(() => assertModelAllowed('gpt-4o')).toThrow(DisallowedProviderError);
    expect(() => assertModelAllowed('o1-preview')).toThrow(DisallowedProviderError);
  });

  it('rejects non-OpenAI providers', () => {
    expect(() => assertProviderAllowed('anthropic')).toThrow(DisallowedProviderError);
    expect(() => assertProviderAllowed('google')).toThrow(DisallowedProviderError);
    expect(() => assertProviderAllowed('local')).toThrow(DisallowedProviderError);
    expect(() => assertProviderAllowed('openai')).not.toThrow();
  });
});
