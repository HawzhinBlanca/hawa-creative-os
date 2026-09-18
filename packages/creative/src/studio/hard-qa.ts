import type { StudioLayoutV2 } from './layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from './validate-layout-v2.js';
import { computeLayoutMetrics, overlappingPairs, type LayoutMetrics } from './layout-metrics.js';
import { findAsymmetricSeparators } from './layout-generator-v3.js';
import { declaredBackgroundColour, declaredTextContrast } from './composite-contrast.js';
import { measureWrappedLines } from './render-layout-v2.js';
import { requiredContrast } from './house-rules.js';

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
  /** The copy of each block, by copyIndex. With it, a block whose copy wraps taller than its box fails. */
  copyText?: Record<number, string>;
}

export interface HardQaOutcome {
  passed: boolean;
  defectCodes: string[];
  /** One readable line per defect, for a repair model or a person. */
  messages: string[];
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
  const messages: string[] = [];
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
      messages.push(`MIN_SIZE: block ${t.copyIndex} (${t.role}) is ${t.fontSize}px; minimum 12px, body at least ${minBodyPx}px`);
    }
  }

  const validation = validateLayoutV2(layout, validationContext);
  if (!validation.ok) {
    if (!defectCodes.includes(validation.code)) {
      defectCodes.push(validation.code);
    }
    messages.push(`${validation.code}: ${validation.message}`);
  } else if (validation.layout) {
    // Preserve layout normalization (e.g. script font) only if validated OK
    checked = validation.layout;
  }

  // Compute metrics if not present to ensure metrics report describes what ships
  const metrics = existingMetrics || computeLayoutMetrics(checked);

  if (metrics.overlapCount > 0) {
    defectCodes.push('OVERLAP');
    const pairs = overlappingPairs(checked);
    messages.push(
      pairs.length
        ? `OVERLAP: ${pairs.length} overlapping pair(s): ${pairs.join('; ')}`
        : `OVERLAP: ${metrics.overlapCount} overlapping pair(s) of text, logo or shapes`
    );
  }

  // Calibrated against six confirmed KAAE exemplars (range 0.792 - 1.000, mean 0.949)
  // An alignment score < 0.70 represents severe raggedness / off-grid drift that violates institutional dignity
  if (metrics.alignmentScore < 0.70) {
    defectCodes.push('POOR_GRID_ALIGNMENT');
    messages.push(`POOR_GRID_ALIGNMENT: alignment ${metrics.alignmentScore} below 0.70 — element edges and centres do not line up on the grid or with each other`);
  }

  // A divider that sits far closer to one of the two blocks it separates. The v3 generator centres
  // these unconditionally, so this fires only for a layout that reached QA without that
  // normalisation. It is a hard gate rather than a weighted metric because no deterministic metric
  // responds to separator position at all: recentring all 31 separators across the eighteen T5
  // layouts changed every one of the thirteen metric scores by exactly 0.0000.
  const asymmetric = findAsymmetricSeparators(checked.shapes || [], checked.text || []);
  if (asymmetric.length > 0) {
    defectCodes.push('ASYMMETRIC_SEPARATOR');
    messages.push(`ASYMMETRIC_SEPARATOR: ${asymmetric.length} divider(s) sit much closer to one of the two blocks they separate`);
  }

  // The next two checks measure the layout as it ships. The validator's normalised copy (`checked`)
  // sets every Sorani block in the reference's script face, right-aligned (ADR-028), but the studio
  // transfers the layout it judged: measured on that copy, 8 Kurdish titles in Amiri "overflowed"
  // only because Noto Sans Arabic sets wider.

  // Every block reads against the surface behind it. The validator's contrast rule runs only when
  // given an evaluator, and no production caller ever passed one, so navy text on a navy panel
  // passed QA: 9 of the 20 T5 designs, and 2 or 3 in every 20 on the cheap tier.
  for (const t of layout.text) {
    const ratio = declaredTextContrast(layout, t);
    const required = requiredContrast(t.fontSize, Boolean(t.bold));
    if (ratio < required) {
      if (!defectCodes.includes('CONTRAST')) defectCodes.push('CONTRAST');
      messages.push(
        `CONTRAST: block ${t.copyIndex} (${t.role}) ${t.color} on ${declaredBackgroundColour(layout, t)} is ` +
          `${ratio.toFixed(2)}:1; it needs ${required}:1`
      );
    }
  }

  // A block's copy must fit its box at its own leading. The renderer centres the lines in the box,
  // so copy taller than its box spills onto the blocks above and below. Preparation grows boxes,
  // but not when no arrangement has room: T5 brief_17 kept a 210px title in a 130px box.
  if (ctx.copyText) {
    const lines = measureWrappedLines(layout, ctx.copyText);
    for (const t of layout.text) {
      const count = lines[t.copyIndex] ?? 1;
      const needed = Math.ceil(count * t.fontSize * t.lineHeight);
      if (needed > t.height + 1) {
        if (!defectCodes.includes('COPY_OVERFLOW')) defectCodes.push('COPY_OVERFLOW');
        messages.push(
          `COPY_OVERFLOW: block ${t.copyIndex} (${t.role}) wraps to ${count} line(s) needing ${needed}px; its box is ${t.height}px tall`
        );
      }
    }
  }

  return { passed: defectCodes.length === 0, defectCodes, messages, metrics, layout: checked };
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
