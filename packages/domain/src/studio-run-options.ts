/**
 * One vocabulary for a Studio run's tier and imagery (ADR-159). Intake once accepted
 * 'fast' | 'quality' and 'none' | 'abstract' | 'photographic', which the Studio never knew: a
 * 'fast' tier failed the design_studio_runs CHECK and an 'abstract' imagery was recorded as given.
 * Those older names are still read (a stored request may carry them) and mapped here, once.
 */
export const STUDIO_TIERS = ['standard', 'premium'] as const;
export type StudioTier = (typeof STUDIO_TIERS)[number];
export const STUDIO_IMAGERY = ['auto', 'none', 'generated'] as const;
export type StudioImagery = (typeof STUDIO_IMAGERY)[number];

const LEGACY_TIERS: Record<string, StudioTier> = { fast: 'standard', quality: 'premium' };
const LEGACY_IMAGERY: Record<string, StudioImagery> = { abstract: 'generated', photographic: 'generated' };

/** `undefined` when absent, `null` when present but not a tier. */
export function parseStudioTier(value: unknown): StudioTier | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  return (STUDIO_TIERS as readonly string[]).includes(value) ? value as StudioTier : LEGACY_TIERS[value] ?? null;
}

/** `undefined` when absent, `null` when present but not an imagery setting. */
export function parseStudioImagery(value: unknown): StudioImagery | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  return (STUDIO_IMAGERY as readonly string[]).includes(value) ? value as StudioImagery : LEGACY_IMAGERY[value] ?? null;
}
