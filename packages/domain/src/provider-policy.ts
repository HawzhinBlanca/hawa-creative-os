/**
 * Strict Provider Policy Enforcement (ADR-030).
 * Rejects non-allowlisted models and providers before network access.
 */

export const ALLOWED_MODELS = [
  'gpt-6-astra',
  'gpt-image-2.5-sunburst',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const ALLOWED_PROVIDERS = ['openai'] as const;

export const DISABLED_PROVIDERS = [
  'anthropic',
  'google',
  'gemini',
  'claude',
  'local',
] as const;

export class DisallowedProviderError extends Error {
  readonly code = 'DISALLOWED_PROVIDER_ERROR';

  constructor(modelOrProvider: string) {
    super(`Model or provider '${modelOrProvider}' is rejected by strict OpenAI-only policy (ADR-030). Only gpt-6-astra and gpt-image-2.5-sunburst are permitted.`);
    this.name = 'DisallowedProviderError';
  }
}

/**
 * Asserts that a model identifier is strictly permitted by the runtime policy.
 * Rejects before network dispatch.
 */
export function assertModelAllowed(model: string): void {
  // Allow explicit test fixtures when executing within unit test runner
  if (
    process.env.NODE_ENV === 'test' &&
    (model.startsWith('mock-') || model.startsWith('test-') || model.startsWith('fixture-'))
  ) {
    return;
  }

  const normalized = (model || '').trim().toLowerCase();

  // Explicit check for disabled providers/models
  if (
    normalized.includes('claude') ||
    normalized.includes('opus') ||
    normalized.includes('fable') ||
    normalized.includes('gemini') ||
    normalized.includes('anthropic')
  ) {
    throw new DisallowedProviderError(model);
  }

  if (!ALLOWED_MODELS.includes(model as AllowedModel)) {
    throw new DisallowedProviderError(model);
  }
}

/**
 * Asserts that a provider name is allowed.
 */
export function assertProviderAllowed(provider: string): void {
  const normalized = (provider || '').trim().toLowerCase();
  if (normalized !== 'openai') {
    throw new DisallowedProviderError(provider);
  }
}
