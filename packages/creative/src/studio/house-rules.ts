/**
 * The house typography and layout rules production's hard QA enforces, defined once.
 *
 * The validator rejects a design that breaks them; the pipeline's preparation conforms a
 * generated design to them. They used to live only as literals inside the validator, and the
 * generator was never told them: every Sorani design the production model made set its leading
 * like Latin, which the validator requires to be 1.6–1.9, so every Kurdish v3 design would have
 * failed production QA.
 */
export const HOUSE_RULES = {
  /** Every text box and the logo sit inside a margin of this share of the canvas's short edge. */
  safeMarginShare: 0.06,
  lineHeight: {
    latin: { min: 1.2, max: 1.5 },
    /** Sorani needs the extra leading for its marks above and below the line. */
    arabic: { min: 1.6, max: 1.9 },
  },
  /** Latin display tracking, in em. Sorani and body copy take none. */
  letterSpacingMaxEm: 0.1,
  minFontPx: 12,
  /** Body copy is at least this share of the canvas width. */
  minBodyShareOfWidth: 0.016,
  /** The title is at least this multiple of the body size. */
  titleToBodyMin: 2.2,
  /**
   * Text against the surface behind it: WCAG AA's ratios, with the validator's size bands for
   * large text.
   */
  contrast: { normal: 4.5, large: 3.0, largeMinPx: 32, largeBoldMinPx: 24 },
  logo: {
    minWidthPx: 100,
    minWidthShareOfCanvas: 0.08,
    /** Free space around the logo, as a share of its height, with no text or rule inside. */
    clearSpaceShareOfHeight: 0.5,
    /** Largest relative deviation from the official aspect. */
    aspectTolerance: 0.01,
  },
  /**
   * Safe margins for 9:16 vertical stories (e.g. 1080x1920).
   * Platform UI danger zones (header profile, reply bar, swipe controls).
   */
  storySafeZone: {
    topShare: 0.14,    // ~270px on 1920h
    bottomShare: 0.20, // ~384px on 1920h
    sideShare: 0.06,
  },
} as const;

/** Pixels a measured line may exceed its box before hard QA reports COPY_OVERFLOW for width. */
export const COPY_WIDTH_TOLERANCE_PX = 4;

export function isStoryFormat(width: number, height: number): boolean {
  return height / width >= 1.7;
}

export function getSafeZoneBox(
  width: number,
  height: number,
  margin?: number
): { x: number; y: number; width: number; height: number } {
  if (isStoryFormat(width, height)) {
    const top = Math.round(height * HOUSE_RULES.storySafeZone.topShare);
    const bottom = Math.round(height * HOUSE_RULES.storySafeZone.bottomShare);
    const side = Math.round(width * HOUSE_RULES.storySafeZone.sideShare);
    return {
      x: side,
      y: top,
      width: width - 2 * side,
      height: height - top - bottom,
    };
  }
  const m = margin ?? Math.floor(HOUSE_RULES.safeMarginShare * Math.min(width, height));
  return {
    x: m,
    y: m,
    width: width - 2 * m,
    height: height - 2 * m,
  };
}

/**
 * Words a generated art prompt may not contain. Image models draw what a prompt names, even in
 * "no text" or "behind the hero text", and the brand's generated art carries no lettering, marks or
 * people.
 */
export const FORBIDDEN_ART_WORDS = [
  'text',
  'letters',
  'numbers',
  'logo',
  'emblem',
  'flag',
  'seal',
  'face',
  'person',
  'people',
  'portrait',
] as const;

/** The contrast a block of this size and weight needs against the surface behind it. */
export function requiredContrast(fontSize: number, bold: boolean): number {
  const c = HOUSE_RULES.contrast;
  return fontSize >= c.largeMinPx || (bold && fontSize >= c.largeBoldMinPx) ? c.large : c.normal;
}

export function minLogoWidth(canvasWidth: number): number {
  return Math.max(HOUSE_RULES.logo.minWidthPx, Math.round(HOUSE_RULES.logo.minWidthShareOfCanvas * canvasWidth));
}

/** The box around the logo that must hold no text and no rule. */
export function logoClearZone(logo: { x: number; y: number; width: number; height: number }, clientMinimumPx = 0) {
  const cs = Math.max(HOUSE_RULES.logo.clearSpaceShareOfHeight * logo.height, clientMinimumPx);
  return { x: logo.x - cs, y: logo.y - cs, width: logo.width + 2 * cs, height: logo.height + 2 * cs };
}
