/**
 * Strict Provider Policy Enforcement (ADR-030).
 * Rejects non-allowlisted models and providers before network access.
 */

export const ALLOWED_MODELS = [
  'gpt-6-astra',
  'gpt-image-2.5-sunburst',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/** The models production runs on. Changing these changes what every proof is evidence about. */
export const PRODUCTION_MODELS = {
  layout: 'gpt-6-astra',
  critique: 'gpt-6-astra',
  judge: 'gpt-6-astra',
  text: 'gpt-6-astra',
  image: 'gpt-image-2.5-sunburst',
} as const;

/**
 * The cheap tier for development, so iterating does not cost production rates.
 *
 * gpt-4.1-mini was verified against this project's key on 2026-09-18: it accepts strict
 * json_schema structured outputs and image_url vision inputs, which the layout, critique and judge
 * stages all require. It rejects `reasoning_effort`, so that parameter is gated by capability
 * rather than sent blindly. gpt-4.1-nano is not licensed to this project; o4-mini would accept
 * reasoning_effort but costs several times more for no benefit here.
 *
 * No cheaper image model is licensed to this project, so the image role stays on the production
 * model — the art lane is not on the hot path today, and a dev run that touches it pays full rate.
 */
export const DEV_MODELS = {
  // Layout invents the composition, so the dev tier keeps a reasoning model here even though it
  // costs several times more than the alternatives: design quality is decided at this stage.
  layout: 'o4-mini',
  // Critique and judge read a render and score it. Cheaper is fine, and both accept vision.
  critique: 'gpt-4.1-mini',
  judge: 'gpt-4.1-mini',
  text: 'gpt-4.1-mini',
  image: 'gpt-image-2.5-sunburst',
} as const;

export const DEV_ALLOWED_MODELS = [
  ...ALLOWED_MODELS,
  'gpt-4.1-mini',
  'gpt-4o-mini',
  'o4-mini',
] as const;

export type ModelTier = 'production' | 'dev';

/**
 * Which tier is active.
 *
 * `HAWA_MODEL_TIER` decides when set. Otherwise the tier follows NODE_ENV, which both Dockerfiles
 * and the compose file pin to `production`: so the deployed containers always run the production
 * models, and anything run outside them — scripts, local dev, tests — gets the cheap tier without
 * anyone having to remember a flag. The fail-safe direction is deliberate: a missing variable
 * cannot silently downgrade production, it can only downgrade development.
 */
export function activeModelTier(): ModelTier {
  const explicit = (process.env.HAWA_MODEL_TIER || '').trim().toLowerCase();
  if (explicit === 'dev' || explicit === 'development' || explicit === 'cheap') return 'dev';
  if (explicit === 'production' || explicit === 'prod') return 'production';
  return (process.env.NODE_ENV || '').trim().toLowerCase() === 'production' ? 'production' : 'dev';
}

export function isDevModelTier(): boolean {
  return activeModelTier() === 'dev';
}

export type ModelRole = keyof typeof PRODUCTION_MODELS;

/**
 * The model to use for a role under the active tier. Never hardcode a model name at a call site.
 *
 * Roles exist so the dev tier can spend where it affects the design and save where it does not:
 * layout generation invents the composition, while critique and judge only read one back.
 */
export function resolveModel(role: ModelRole, tier: ModelTier = activeModelTier()): string {
  return tier === 'dev' ? DEV_MODELS[role] : PRODUCTION_MODELS[role];
}

/** Models that reject `reasoning_effort`; sending it to them is a 400. */
const REASONING_EFFORT_MODELS = new Set(['gpt-6-astra', 'o4-mini']);

export function modelSupportsReasoningEffort(model: string): boolean {
  const normalized = (model || '').trim().toLowerCase();
  for (const supported of REASONING_EFFORT_MODELS) {
    if (normalized.startsWith(supported)) return true;
  }
  return false;
}

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

  // The allowlist widens only on the dev tier, and never to another provider: every entry in
  // DEV_ALLOWED_MODELS is an OpenAI model, so ADR-030's OpenAI-only rule still holds.
  const permitted: readonly string[] = isDevModelTier() ? DEV_ALLOWED_MODELS : ALLOWED_MODELS;
  if (!permitted.includes(model)) {
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
