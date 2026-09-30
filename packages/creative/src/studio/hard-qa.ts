import { evaluateThumbnailLayout } from './thumbnail-rules.js';
import type { StudioLayoutV2 } from './layout-v2.js';
import { HERO_SOFT_UPSCALE, photoRecipeOf } from './layout-v2.js';
import { validateLayoutV2, type LayoutValidationContext } from './validate-layout-v2.js';
import { computeLayoutMetrics, overlappingPairs, type LayoutMetrics } from './layout-metrics.js';
import { findAsymmetricSeparators } from './layout-generator-v3.js';
import { declaredBackgroundColour, declaredTextContrast, measuredInkContrast } from './composite-contrast.js';
import { checkCopyCompleteness, instructionLanguageFindings, type CopyOrigin, type ReviewFinding } from './copy-completeness.js';
import { omittedPhotoIndices, recipePhotoMinimum, type PhotoSelection } from './photo-selection.js';
import { measureTextGeometry, type TextMeasurement, type RenderLayoutOptions } from './render-layout-v2.js';
import { requiredContrast, COPY_WIDTH_TOLERANCE_PX } from './house-rules.js';
import { maxStrokeWidth, STROKE_PAINT_TOLERANCE_PX } from './studio-normalize.js';
import { logoBackingExcess } from './art-direction/logo-ground.js';

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
  admittedDisplayFonts?: { latin: string[]; arabic: string[] };
  palette: string[];
  logoAspect: number;
  logoMinimumWidthPx?: number;
  logoClearSpacePx?: number;
  /** Required for successful QA. Missing content produces COPY_UNMEASURED, never guessed geometry. */
  copyText?: Record<number, string>;
  /** Use the same explicit font directory as the renderer, when supplied. */
  textMeasurementOptions?: Pick<RenderLayoutOptions, 'fontsDir'>;
  /**
   * The client photographs the request carries. Without it QA read every request as having none
   * and refused every design that placed the client's photos (2026-09-22, run b7fc5555).
   */
  photoCount?: number;
  /**
   * The client's playbook (ADR-127). A video thumbnail also answers to the thumbnail rules: nothing
   * under the platform's badge or buttons, and a hook legible at listing size.
   */
  playbook?: 'institutional-announcement' | 'video-thumbnail';
  /**
   * ADR-157: whether the requester let the design choose among the photos. Absent is `all`: every
   * photo placed, as before.
   */
  photoSelection?: PhotoSelection;
  /** The requester's own instructions, for the language finding. Never a gate. */
  instructions?: string;
  /** Where the copy came from, when known: copy at the caption limit may have been cut. */
  copyOrigin?: CopyOrigin;
  /**
   * ADR-157: the no-text composite of the render that ships (art, photos, panels, no copy). When
   * given, every block is also held to its contrast measured on those pixels under its own lines,
   * not only against the colour the layout declares behind it.
   */
  renderedComposite?: Buffer;
  /** The renderer's font fidelity for this host (`RenderLayoutV2Result.fontFidelity`). */
  fontFidelity?: Record<string, 'exact' | 'stand-in'>;
}

export interface HardQaOutcome {
  passed: boolean;
  defectCodes: string[];
  /** One readable line per defect, for a repair model or a person. */
  messages: string[];
  metrics: LayoutMetrics;
  /** The layout as validated — validation may normalise it, e.g. a script font. */
  layout: StudioLayoutV2;
  textMeasurements: TextMeasurement[];
  /**
   * ADR-157: what a person should look at before approving, none of which blocks the design:
   * copy that may be cut short, a language the instructions name and the copy lacks, a face the
   * renderer substituted. Shown at office review.
   */
  findings: ReviewFinding[];
  /** The 5th-percentile contrast of each block measured under its lines, when a composite was given. */
  measuredContrast?: Record<number, number>;
  /** Photos the design leaves out, by photoIndex: only ever non-empty when the requester let it choose. */
  omittedPhotos: number[];
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
        admittedDisplayFonts: ctx.admittedDisplayFonts,
      },
      logoAspect: ctx.logoAspect || 1.0,
      logoMinimumWidthPx: ctx.logoMinimumWidthPx,
      logoClearSpacePx: ctx.logoClearSpacePx,
    },
    draftFont: ctx.latinFont || 'Verdana',
    photoCount: ctx.photoCount ?? 0,
    ...(ctx.photoSelection ? { photoSelection: ctx.photoSelection } : {}),
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

  // Compute metrics if not present or if layout was normalized, ensuring report describes what ships
  const layoutNormalized = Boolean(checked !== layout && JSON.stringify(checked) !== JSON.stringify(layout));
  const metrics = (!layoutNormalized && existingMetrics) ? existingMetrics : computeLayoutMetrics(checked);

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

  // A stroke is painted centred on the shape's path, so half of it falls outside the box the layout
  // declares, and nothing else here measures anything but that box. The generator used to read
  // every strokeWidth as a share of the canvas width, so a plain "2" became a 2160px band across
  // the whole poster. 38 of the 200 designs stored on 2026-09-18 carry one; 34 still carried it
  // after preparation, and 31 of those 34 passed this gate. transfer-v2 turns the value into points
  // at 0.75x, so one reached Canva as a 1620pt outline. Preparation repairs these, so this fires
  // only for a layout that reached QA without it.
  const strokeShapes = checked.shapes || [];
  for (let i = 0; i < strokeShapes.length; i++) {
    const s = strokeShapes[i];
    if (s.strokeWidth === null || s.strokeWidth === undefined) continue;
    const roleMax = maxStrokeWidth(s.role, checked.width, checked.height);
    if (s.strokeWidth > roleMax) {
      if (!defectCodes.includes('OVERSIZED_STROKE')) defectCodes.push('OVERSIZED_STROKE');
      messages.push(
        `OVERSIZED_STROKE: shape ${i} (${s.kind}, ${s.role}) carries a ${s.strokeWidth}px stroke; ` +
          `a ${s.role} may be at most ${roleMax}px on a ${checked.width}x${checked.height} canvas`
      );
    }
    const escape = s.strokeWidth / 2;
    const tolerated = Math.max(STROKE_PAINT_TOLERANCE_PX, Math.min(s.width, s.height));
    if (escape > tolerated) {
      if (!defectCodes.includes('SHAPE_PAINT_ESCAPES_BOX')) defectCodes.push('SHAPE_PAINT_ESCAPES_BOX');
      messages.push(
        `SHAPE_PAINT_ESCAPES_BOX: shape ${i} (${s.kind}, ${s.role}) declares a ${s.width}x${s.height} box but its ` +
          `${s.strokeWidth}px stroke paints up to ${Math.round(escape)}px outside it`
      );
    }
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
  const textMeasurements = measureTextGeometry(layout, ctx.copyText, ctx.textMeasurementOptions);
  for (const [index, measurement] of textMeasurements.entries()) {
    const t = layout.text[index];
    if (measurement.status === 'unmeasured') {
      if (!defectCodes.includes('COPY_UNMEASURED')) defectCodes.push('COPY_UNMEASURED');
      messages.push(`COPY_UNMEASURED: block ${t.copyIndex} (${t.role}) ${measurement.reason}` +
        (measurement.missingCodePoints ? `: ${measurement.missingCodePoints.join(', ')}` : ''));
      continue;
    }
    const count = measurement.lineCount;
    const needed = measurement.requiredHeightPx;
    if (needed > t.height + 1) {
      if (!defectCodes.includes('COPY_OVERFLOW')) defectCodes.push('COPY_OVERFLOW');
      messages.push(
        `COPY_OVERFLOW: block ${t.copyIndex} (${t.role}) wraps to ${count} line(s) needing ${needed}px; its box is ${t.height}px tall`
      );
    }
    const actualWidth = measurement.maxLineWidthPx;
    if (actualWidth > t.width + COPY_WIDTH_TOLERANCE_PX) {
      if (!defectCodes.includes('COPY_OVERFLOW')) defectCodes.push('COPY_OVERFLOW');
      messages.push(
        `COPY_OVERFLOW: block ${t.copyIndex} (${t.role}) text exceeds box width (${actualWidth}px > ${t.width}px); word or line runs past box boundary`
      );
    }
  }

  // The declared colours say nothing about art, a photo or a gradient under the copy, and the
  // measured p05 the render stage stored was never read by any gate (audit 2026-09-30 #20). With the
  // shipping render's no-text composite, each block is also held to the contrast of the pixels
  // under its own lines. Only the declared check ran before, so a block it passes can fail here.
  let measuredContrast: Record<number, number> | undefined;
  const unmeasured: ReviewFinding[] = [];
  if (ctx.renderedComposite) {
    try {
      measuredContrast = measuredInkContrast(ctx.renderedComposite, layout, textMeasurements);
    } catch (err) {
      // Said, never silent: the declared check above still applies.
      unmeasured.push({
        code: 'CONTRAST_UNMEASURED',
        severity: 'warning',
        message: `CONTRAST_UNMEASURED: the render could not be read (${err instanceof Error ? err.message : String(err)}); contrast was judged on the declared colours only.`,
      });
    }
  }
  // ADR-170: text over a photo is admitted only on a surface and only when its contrast is measured
  // on the pixels that ship. Without the render, it is unproven, and unproven is a defect here.
  if (!measuredContrast) {
    const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    for (const t of layout.text) {
      if (!(layout.photos || []).some((p) => hit(p, t))) continue;
      if (!defectCodes.includes('CONTRAST')) defectCodes.push('CONTRAST');
      messages.push(`CONTRAST: block ${t.copyIndex} (${t.role}) lies over a photograph and its contrast was not measured on the rendered pixels`);
    }
  }
  for (const t of measuredContrast ? layout.text : []) {
    const p05 = measuredContrast?.[t.copyIndex];
    const required = requiredContrast(t.fontSize, Boolean(t.bold));
    if (p05 === undefined || p05 >= required) continue;
    if (!defectCodes.includes('CONTRAST')) defectCodes.push('CONTRAST');
    messages.push(
      `CONTRAST: block ${t.copyIndex} (${t.role}) ${t.color} measures ${p05.toFixed(2)}:1 (5th percentile) against ` +
        `the rendered pixels under its lines; it needs ${required}:1`
    );
  }

  // The client's copy reads in the order they wrote it. A block set above one that precedes it in
  // the same column changes their content: on the cheap tier all three candidates of task 3c3a422b
  // (2026-09-18) put the guest's name above the title the client wrote first.
  const reordered = copyOrderViolations(layout);
  if (reordered.length > 0) {
    defectCodes.push('COPY_ORDER');
    messages.push(`COPY_ORDER: ${reordered.join('; ')}; stack blocks top to bottom in copyIndex order, as the client wrote them`);
  }

  // The layout returned is the layout measured, which is the whole point of the two checks above.
  //
  // It used to return `checked`, the validator's normalised copy, while CONTRAST and COPY_OVERFLOW
  // deliberately measured `layout` — and `runQAStage` assigns the return straight onto the winner
  // (`winner.currentLayout = outcome.layout`), which is what the transfer then encodes. So the
  // design that shipped was not the design that was measured, and not the design the judge chose.
  // Proved 2026-09-21: a centred Sorani title in Amiri passes here with no defects, then ships as
  // Noto Sans Arabic right-aligned, wrapping to three lines in a box sized for two — re-running
  // this same gate on what actually ships returns COPY_OVERFLOW. Thirty width/size combinations
  // behave that way, and the reference-driven `typeface` and centred-title decisions are erased
  // along with it.
  //
  // Returning `layout` makes the comment above true. The normalisation is not lost so much as no
  // longer needed here: in the v3 path `sanitizeFontsV3` has already put every block in an admitted
  // face for its script and set `rtl`, so `checked` is normally identical. When it is not, that
  // difference is reported rather than applied, because a script rewrite after judging is a
  // finding, not a repair.
  const rewritten = checked !== layout
    ? layout.text
        .map((t, i) => {
          const c = checked.text[i];
          if (!c) return '';
          const changes = [
            c.fontFamily !== t.fontFamily ? `font ${t.fontFamily}->${c.fontFamily}` : '',
            c.align !== t.align ? `align ${t.align}->${c.align}` : '',
            c.rtl !== t.rtl ? `rtl ${t.rtl}->${c.rtl}` : '',
          ].filter(Boolean);
          return changes.length ? `block ${t.copyIndex} (${t.role}): ${changes.join(', ')}` : '';
        })
        .filter(Boolean)
    : [];
  if (rewritten.length) {
    messages.push(
      `SCRIPT_NORMALISATION_DIVERGENCE (reported, not applied): the validator would have rewritten ` +
        `${rewritten.join('; ')}. The layout measured and returned is the one that was judged; the ` +
        `rewrite is not applied, because applying it after judging ships a design nobody scored.`
    );
  }

  if (ctx.playbook === 'video-thumbnail') {
    const thumbnail = evaluateThumbnailLayout(checked, { width: ctx.width, height: ctx.height });
    for (const code of thumbnail.defectCodes) if (!defectCodes.includes(code)) defectCodes.push(code);
    messages.push(...thumbnail.messages);
  }

  // ADR-180 (owner, 2026-09-30: "current design has logo background"): nothing behind the logo may
  // reach past its clear space, and a solid tab stays thin; the navy square filled the whole box.
  const backingExcess = logoBackingExcess(checked, ctx.logoClearSpacePx ?? 0);
  if (backingExcess > 1) {
    defectCodes.push('LOGO_BACKING');
    messages.push(`LOGO_BACKING: what is drawn behind the logo reaches ${backingExcess}px past the thin tab or clear-space box it may cover`);
  }

  const findings = [...reviewFindings(layout, ctx), ...unmeasured];
  // Photos a design left out where leaving them out was allowed, for office review: the requester let
  // it choose (ADR-157), or a recipe followed the house style and no words of the requester bound
  // every photo (ADR-180).
  const recipeChose = Boolean(photoRecipeOf(layout)) && recipePhotoMinimum(ctx.photoSelection, ctx.photoCount ?? 0) < (ctx.photoCount ?? 0);
  const omittedPhotos = ctx.photoSelection?.mode === 'choose' || recipeChose ? omittedPhotoIndices(layout.photos, ctx.photoCount ?? 0) : [];

  return {
    passed: defectCodes.length === 0, defectCodes, messages, metrics, layout, textMeasurements, findings, omittedPhotos,
    ...(measuredContrast ? { measuredContrast } : {}),
  };
}

/**
 * ADR-157: the review findings of a design, which never fail it. Copy-level findings are the same
 * for every candidate of a run; a substituted face depends on the candidate's own type choices.
 */
export function reviewFindings(
  layout: Pick<StudioLayoutV2, 'text'> & Partial<Pick<StudioLayoutV2, 'artDirection'>>,
  ctx: Pick<HardQaContext, 'copyText' | 'instructions' | 'copyOrigin' | 'fontFidelity'>
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (ctx.copyText) {
    findings.push(...checkCopyCompleteness(ctx.copyText, { origin: ctx.copyOrigin }));
    findings.push(...instructionLanguageFindings(ctx.instructions, Object.values(ctx.copyText)));
  }
  // A face the renderer cannot draw is replaced by a declared stand-in, so the preview the judge
  // scored is not set in the face the design names, and the Canva deck (which names it) will differ.
  // It used to be only a console warning.
  const substituted = [...new Set(layout.text.map((t) => t.fontFamily))].filter((f) => ctx.fontFidelity?.[f] === 'stand-in');
  for (const family of substituted) {
    const blocks = layout.text.filter((t) => t.fontFamily === family).map((t) => t.copyIndex);
    findings.push({
      code: 'FONT_SUBSTITUTED',
      severity: 'warning',
      message: `FONT_SUBSTITUTED: the renderer drew a stand-in for ${family} (block${blocks.length === 1 ? '' : 's'} ${blocks.join(', ')}); the preview does not show the face the design names.`,
    });
  }
  // ADR-170: a hero shown much larger than its own pixels looks soft (the album's 1280x853 photos
  // stretched 1.6x over a 1080x1350 canvas in the live trials). A warning, never a failure.
  const upscale = layout.artDirection?.heroUpscale;
  if (typeof upscale === 'number' && upscale > HERO_SOFT_UPSCALE) {
    findings.push({
      code: 'HERO_UPSCALED',
      severity: 'warning',
      message: `HERO_UPSCALED: the main photo is shown at ${upscale.toFixed(1)}x its own size and may look soft; a larger original would be sharper.`,
    });
  }
  return findings;
}

/**
 * Blocks set above a block that precedes them in the copy, within the same column. Blocks side by
 * side (a date beside a venue) share no column and are never compared; a few pixels of offset
 * between blocks on one baseline are allowed.
 */
export function copyOrderViolations(layout: Pick<StudioLayoutV2, 'text'>): string[] {
  const blocks = [...(layout.text || [])].sort((a, b) => a.copyIndex - b.copyIndex);
  const sameColumn = (a: { x: number; width: number }, b: { x: number; width: number }) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.25 * Math.min(a.width, b.width);
  const found: string[] = [];
  for (let j = 1; j < blocks.length; j++) {
    const later = blocks[j];
    const earlier = blocks.slice(0, j).find((b) => b.copyIndex < later.copyIndex && sameColumn(b, later) && later.y + 4 < b.y);
    if (earlier) found.push(`block ${later.copyIndex} (${later.role}) sits above block ${earlier.copyIndex} (${earlier.role})`);
  }
  return found;
}

export interface StudioReferenceRules {
  palette: string[];
  latinFont: string;
  arabicFont: string;
  /** The reference's colour-usage guidance, given to the model as house rules. */
  promotedRules: string;
  /**
   * ADR-170: the client's house art-direction rules (rules.artDirection), short sentences given to
   * the art-director layout call and the judge as data. Empty when the reference names none.
   */
  artDirectionRules: string[];
}

/** A reference's art-direction rules: at most 16 non-empty strings of at most 240 characters. */
export function artDirectionRulesFromRaw(rawRef: any): string[] {
  const list = rawRef?.rules?.artDirection;
  if (!Array.isArray(list)) return [];
  return list.filter((r: unknown): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim().slice(0, 240)).slice(0, 16);
}

/**
 * Reads a client reference pack the way the studio does. Shared so the qualification designs
 * with the client's palette and fonts; it used a hard-coded palette with a gold (#C5A059) that is
 * not in KAAE's, so its designs could not be checked against the palette production enforces.
 */
export function studioReferenceFromRaw(rawRef: any): StudioReferenceRules {
  // A reference pack names its client's palette. One that does not is refused: this used to fill in
  // KAAE's palette, so any other client's design would have been made in KAAE's colours (ADR-127).
  if (!Array.isArray(rawRef?.rules?.palette) || rawRef.rules.palette.length === 0) {
    throw new Error('The client reference pack names no palette (rules.palette); a design cannot be made in borrowed colours.');
  }
  const rules: StudioReferenceRules = {
    palette: rawRef.rules.palette,
    latinFont: 'Verdana',
    arabicFont: 'Noto Sans Arabic',
    promotedRules: 'Keep title clear and centered. Do not crowd logo. Preserve hierarchy.',
    artDirectionRules: artDirectionRulesFromRaw(rawRef),
  };
  if (rawRef?.rules?.palette) rules.palette = rawRef.rules.palette;
  if (rawRef?.rules?.fontFamily) rules.latinFont = rawRef.rules.fontFamily;
  if (rawRef?.rules?.scriptFonts?.arabic) rules.arabicFont = rawRef.rules.scriptFonts.arabic;
  if (rawRef?.rules?.colorUsage) rules.promotedRules = rawRef.rules.colorUsage;
  return rules;
}
