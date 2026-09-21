/**
 * Strict Provider Policy Enforcement (ADR-030).
 * Rejects non-allowlisted models and providers before network access.
 */

export const ALLOWED_MODELS = [
  'gpt-6-astra',
  'gpt-image-2.5-sunburst',
  // Admitted to production for the judge role alone, on measurement rather than on price.
  // See PRODUCTION_MODELS.judge below for the experiment and its numbers.
  'gpt-4.1-mini',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/** The models production runs on. Changing these changes what every proof is evidence about. */
export const PRODUCTION_MODELS = {
  layout: 'gpt-6-astra',
  critique: 'gpt-6-astra',
  /**
   * The judge is the one stage that invents nothing: it compares two already-rendered posters on
   * five named dimensions and is handed the deterministic metric scores as stated facts. It was
   * 27% of a run's cost — $0.171 of $0.629 per design, measured over 16 production runs in
   * hawa.design_studio_calls — for four calls that only pick between candidates already made.
   *
   * Moved down on evidence, not on price. `scripts/experiments/judge-model-agreement.ts` replays
   * the judgments of past production runs: the candidates still carry the exact preview PNGs their
   * judge saw, and design_studio_judgments stores its per-dimension votes, so the expensive side of
   * the comparison was already bought. Replaying 24 stored comparisons on 2026-09-20:
   *
   *   gpt-4.1-mini vs the stored gpt-6-astra verdicts  75% winner, 75% per-dimension  $0.068
   *   gpt-6-astra  vs the stored gpt-6-astra verdicts  67% winner, 71% per-dimension  $0.847
   *
   * The cheap model agrees with the expensive judge's own past verdicts MORE than that judge agrees
   * with itself. The quarter of comparisons that move are not a quality gap; they are the noise
   * floor of asking any model to separate two candidates that both passed hard QA and are close.
   * Legibility is the clearest case: the expensive model reproduces its own legibility vote only
   * 38% of the time, i.e. worse than chance on a binary choice, which is why the deterministic
   * textLegibility metric — not the judge — is what that dimension should rest on.
   *
   * Reliability was measured separately, on the pipeline's own canary, which has a known right
   * answer: a layout against a deliberately degraded copy of itself. Both models caught it 12 times
   * out of 12, in both presentation orders. A cheaper judge here is not a blinder one.
   *
   * HAWA_MODEL_JUDGE still overrides this for one run or one deployment.
   */
  judge: 'gpt-4.1-mini',
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
 * `HAWA_MODEL_TIER` decides when set. Otherwise the tier follows the environment, which both Dockerfiles
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
  if (role === 'image') return resolveImageSettings(process.env, tier).model;
  // HAWA_MODEL_LAYOUT, HAWA_MODEL_CRITIQUE, HAWA_MODEL_JUDGE, HAWA_MODEL_TEXT override the tier for
  // one role. The allowlist still applies at dispatch: an override it refuses fails the call loudly.
  const override = (process.env[`HAWA_MODEL_${role.toUpperCase()}`] || '').trim();
  if (override) return override;
  return tier === 'dev' ? DEV_MODELS[role] : PRODUCTION_MODELS[role];
}

/**
 * Image generation, one setting per parameter, each overridable from the environment:
 * HAWA_IMAGE_PROVIDER (openai | google), HAWA_IMAGE_MODEL, HAWA_IMAGE_SIZE, HAWA_IMAGE_QUALITY,
 * HAWA_IMAGE_ASPECT. Google's image models are allowed for artwork only; every text, layout,
 * critique and judge call stays on OpenAI (ADR-030).
 *
 * Prices (2026-09-18, the providers' published pages): gpt-image-2.5-sunburst $30 per 1M image
 * output tokens; gemini-3.1-flash-lite-image $0.0336 per 1K image; gemini-3.1-flash-image $0.067
 * per 1K; gemini-3-pro-image $0.134 per 1K or 2K.
 */
export type ImageProvider = 'openai' | 'google';

export const IMAGE_MODELS: Record<ImageProvider, readonly string[]> = {
  openai: ['gpt-image-2.5-sunburst'],
  google: ['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image'],
};

const IMAGE_SIZES: Record<ImageProvider, RegExp> = {
  // OpenAI: WxH, each a multiple of 16 up to 3840, or auto.
  openai: /^(auto|\d{3,4}x\d{3,4})$/,
  google: /^(512px|1K|2K|4K)$/,
};
const IMAGE_QUALITIES: Record<ImageProvider, readonly string[]> = {
  openai: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
  google: ['auto'],
};
const IMAGE_ASPECTS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export interface ImageSettings {
  provider: ImageProvider;
  model: string;
  /** OpenAI: WxH. Google: 512px, 1K, 2K or 4K. */
  size: string;
  /** OpenAI only; Google has no quality setting. */
  quality: string;
  /** Google only; OpenAI takes the shape from `size`. */
  aspectRatio: string;
}

const IMAGE_DEFAULTS: Record<ImageProvider, Omit<ImageSettings, 'provider'>> = {
  openai: { model: 'gpt-image-2.5-sunburst', size: '1024x1024', quality: 'auto', aspectRatio: '1:1' },
  google: { model: 'gemini-3.1-flash-lite-image', size: '1K', quality: 'auto', aspectRatio: '1:1' },
};

export class ImageSettingsError extends Error {
  readonly code = 'IMAGE_SETTINGS_INVALID';
}

/**
 * The image settings in force. Defaults: OpenAI's model at 1024x1024; `auto` quality on the
 * production tier (what OpenAI picks when none is sent) and `medium` on the cheap tier, where a
 * background texture drawn at a quarter opacity does not need more. Throws on a value the
 * provider does not accept, so a typo fails the art call loudly instead of sending a request the
 * provider refuses.
 */
export function resolveImageSettings(
  env: Record<string, string | undefined> = process.env,
  tier: ModelTier = activeModelTier()
): ImageSettings {
  const read = (name: string) => (env[name] || '').trim();
  const provider = (read('HAWA_IMAGE_PROVIDER') || 'openai').toLowerCase();
  if (provider !== 'openai' && provider !== 'google') {
    throw new ImageSettingsError(`HAWA_IMAGE_PROVIDER must be openai or google, not '${provider}'`);
  }
  const d = IMAGE_DEFAULTS[provider];
  const settings: ImageSettings = {
    provider,
    model: read('HAWA_IMAGE_MODEL') || d.model,
    size: read('HAWA_IMAGE_SIZE') || d.size,
    quality: read('HAWA_IMAGE_QUALITY').toLowerCase() || (provider === 'openai' && tier === 'dev' ? 'medium' : d.quality),
    aspectRatio: read('HAWA_IMAGE_ASPECT') || d.aspectRatio,
  };
  if (!IMAGE_MODELS[provider].includes(settings.model)) {
    throw new ImageSettingsError(`HAWA_IMAGE_MODEL '${settings.model}' is not a ${provider} image model: ${IMAGE_MODELS[provider].join(', ')}`);
  }
  if (!IMAGE_SIZES[provider].test(settings.size)) {
    throw new ImageSettingsError(`HAWA_IMAGE_SIZE '${settings.size}' is not a ${provider} size`);
  }
  if (!IMAGE_QUALITIES[provider].includes(settings.quality)) {
    throw new ImageSettingsError(`HAWA_IMAGE_QUALITY '${settings.quality}' is not one of ${IMAGE_QUALITIES[provider].join(', ')}`);
  }
  if (!IMAGE_ASPECTS.includes(settings.aspectRatio)) {
    throw new ImageSettingsError(`HAWA_IMAGE_ASPECT '${settings.aspectRatio}' is not one of ${IMAGE_ASPECTS.join(', ')}`);
  }
  return settings;
}

/** An image model is allowed only on its own provider's list. */
export function assertImageModelAllowed(provider: string, model: string): void {
  const allowed = IMAGE_MODELS[provider as ImageProvider];
  if (!allowed || !allowed.includes(model)) throw new DisallowedProviderError(`${provider}/${model}`);
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
  // Allow explicit test fixtures when executing in dev/testing tier
  if (
    activeModelTier() === 'dev' &&
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
