import type { StudioLayoutV2 } from './layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from './validate-layout-v2.js';
import { computeLayoutMetrics, type LayoutMetrics } from './layout-metrics.js';
import { findAsymmetricSeparators } from './layout-generator-v3.js';

/**
 * The studio's hard QA gate, shared so the qualification applies exactly the gate a production
 * design must pass. The qualification used to apply only its own print-ready checks, so a design
 * it counted as print-ready could still be rejected in production, and nothing measured how often.
 */

export interface HardQaContext {
  width: number;
  height: number;
  /** The script of each copy block, by copyIndex. */
  copyScripts: Array<'latin' | 'arabic'>;
  latinFont: string;
  arabicFont: string;
  palette: string[];
  logoAspect: number;
}

export interface HardQaOutcome {
  passed: boolean;
  defectCodes: string[];
  metrics: LayoutMetrics;
  /** The layout as validated — validation may normalise it, e.g. a script font. */
  layout: StudioLayoutV2;
}

export function evaluateHardQa(
  layout: StudioLayoutV2,
  ctx: HardQaContext,
  existingMetrics?: LayoutMetrics | null
): HardQaOutcome {
  const defectCodes: string[] = [];
  let checked = layout;

  const validationContext: LayoutValidationContext = {
    expectedWidth: ctx.width,
    expectedHeight: ctx.height,
    copyCount: ctx.copyScripts.length,
    copyScripts: ctx.copyScripts,
    reference: {
      rules: {
        fontFamily: ctx.latinFont,
        palette: ctx.palette,
        scriptFonts: {
          arabic: ctx.arabicFont,
        },
      },
      logoAspect: ctx.logoAspect || 1.0,
    },
    draftFont: ctx.latinFont || 'Verdana',
  };

  // Explicit check for unreadable font sizes: fail QA, do NOT mutatively rewrite font sizes
  const minBodyPx = Math.ceil(0.016 * ctx.width);
  for (const t of layout.text) {
    if (t.fontSize < 12 || (t.role === 'body' && t.fontSize < minBodyPx)) {
      if (!defectCodes.includes('MIN_SIZE')) defectCodes.push('MIN_SIZE');
      if (!defectCodes.includes('UNREADABLE_FONT_SIZE')) defectCodes.push('UNREADABLE_FONT_SIZE');
    }
  }

  const validation = validateLayoutV2(layout, validationContext);
  if (!validation.ok) {
    if (!defectCodes.includes(validation.code)) {
      defectCodes.push(validation.code);
    }
  } else if (validation.layout) {
    // Preserve layout normalization (e.g. script font) only if validated OK
    checked = validation.layout;
  }

  // Compute metrics if not present to ensure metrics report describes what ships
  const metrics = existingMetrics || computeLayoutMetrics(checked);

  if (metrics.overlapCount > 0) {
    defectCodes.push('OVERLAP');
  }

  // Calibrated against six confirmed KAAE exemplars (range 0.792 - 1.000, mean 0.949)
  // An alignment score < 0.70 represents severe raggedness / off-grid drift that violates institutional dignity
  if (metrics.alignmentScore < 0.70) {
    defectCodes.push('POOR_GRID_ALIGNMENT');
  }

  // A divider that sits far closer to one of the two blocks it separates. The v3 generator centres
  // these unconditionally, so this fires only for a layout that reached QA without that
  // normalisation. It is a hard gate rather than a weighted metric because no deterministic metric
  // responds to separator position at all: recentring all 31 separators across the eighteen T5
  // layouts changed every one of the thirteen metric scores by exactly 0.0000.
  if (findAsymmetricSeparators(checked.shapes || [], checked.text || []).length > 0) {
    defectCodes.push('ASYMMETRIC_SEPARATOR');
  }

  return { passed: defectCodes.length === 0, defectCodes, metrics, layout: checked };
}

export interface StudioReferenceRules {
  palette: string[];
  latinFont: string;
  arabicFont: string;
  /** The reference's colour-usage guidance, given to the model as house rules. */
  promotedRules: string;
}

/**
 * Reads a client reference pack the way the studio does. Shared so the qualification designs
 * with the client's palette and fonts; it used a hard-coded palette with a gold (#C5A059) that is
 * not in KAAE's, so its designs could not be checked against the palette production enforces.
 */
export function studioReferenceFromRaw(rawRef: any): StudioReferenceRules {
  const rules: StudioReferenceRules = {
    palette: ['#0A1628', '#1E3A5F', '#4770A3', '#F7B500', '#FDF8F3', '#FFFFFF', '#1A1A1A'],
    latinFont: 'Verdana',
    arabicFont: 'Noto Sans Arabic',
    promotedRules: 'Keep title clear and centered. Do not crowd logo. Preserve hierarchy.',
  };
  if (rawRef?.rules?.palette) rules.palette = rawRef.rules.palette;
  if (rawRef?.rules?.fontFamily) rules.latinFont = rawRef.rules.fontFamily;
  if (rawRef?.rules?.scriptFonts?.arabic) rules.arabicFont = rawRef.rules.scriptFonts.arabic;
  if (rawRef?.rules?.colorUsage) rules.promotedRules = rawRef.rules.colorUsage;
  return rules;
}
