/**
 * Hawa Creative OS — Canonical Unified Font Policy
 * Single source of truth for admitted font families across generation, transfer, and QA.
 */
import { loadRenderFontRegistry } from './studio/render-layout-v2.js';

export interface FontPolicy {
  families: string[];
  aliases: Record<string, string>;
  scripts: Record<string, { requiredCharacters?: string; defaultFamily?: string }>;
}

let cachedPolicy: FontPolicy | null = null;

export function getCanonicalFontPolicy(): FontPolicy {
  if (cachedPolicy) return cachedPolicy;
  try {
    const registry = loadRenderFontRegistry();
    const families = Object.keys(registry.families || {});
    const aliases = registry.aliases || {};
    const scripts = registry.scripts || {};
    cachedPolicy = { families, aliases, scripts };
    return cachedPolicy;
  } catch {
    // Fallback if render-fonts.json is unavailable
    const fallbackFamilies = [
      'Inter',
      'Cairo',
      'Noto Sans Arabic',
      'Noto Naskh Arabic',
      'Vazirmatn',
      'Amiri',
      'Cinzel',
      'Verdana',
      'Playfair Display',
      'Montserrat',
      'Lora',
      'Bodoni Moda',
      'Plus Jakarta Sans',
      'Arial',
      'Georgia',
      'Times New Roman',
    ];
    cachedPolicy = {
      families: fallbackFamilies,
      aliases: {},
      scripts: {},
    };
    return cachedPolicy;
  }
}

export const CANONICAL_BRAND_FONTS = [
  'Inter',
  'Arial',
  'Georgia',
  'Times New Roman',
  'Montserrat',
  'Bodoni Moda',
  'Noto Naskh Arabic',
];

export function isFontAdmitted(
  fontFamily: string,
  options?: { extraFonts?: string[] }
): boolean {
  if (!fontFamily || typeof fontFamily !== 'string') return false;
  const policy = getCanonicalFontPolicy();
  const normalized = policy.aliases[fontFamily] || fontFamily;

  if (
    policy.families.includes(normalized) ||
    policy.families.includes(fontFamily) ||
    CANONICAL_BRAND_FONTS.includes(fontFamily) ||
    CANONICAL_BRAND_FONTS.includes(normalized)
  ) {
    return true;
  }

  // Check extraFonts if permitted
  if (options?.extraFonts && options.extraFonts.includes(fontFamily)) {
    return true;
  }

  return false;
}
