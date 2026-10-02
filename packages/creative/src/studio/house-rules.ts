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
  /**
   * ADR-275: display leading. A title set at least `minShareOfWidth` of the canvas width is display
   * type, and display type may be set tighter than `lineHeight` above: the office's heavy-sans caps
   * titles run at about 0.95-1.0, and its Sorani titles at about 1.3-1.4. Body copy and every
   * smaller or non-title block keep the ranges above.
   *
   * A Latin display block may go down to 0.95 outright (capitals have no descenders; mixed case at
   * that leading is still held to the measured ink check whenever QA has the copy). A Sorani display
   * block may go down to 1.3 only when the measured ink of each pair of its lines keeps
   * `inkClearanceEm` apart: the marks above and below Sorani letters must not collide, and that is a
   * property of the copy and the face, not of a ratio.
   */
  displayLineHeight: {
    roles: ['title'] as readonly string[],
    minShareOfWidth: 0.06,
    latin: { min: 0.95, max: 1.5 },
    arabic: { min: 1.3, max: 1.9 },
    /** The least gap, in em of the block's size, between the ink of one line and the next. */
    inkClearanceEm: 0.02,
  },
  /** Latin display tracking, in em. Sorani and body copy take none. */
  letterSpacingMaxEm: 0.1,
  /**
   * ADR-275: tracking for a Latin block set in capitals. At display size capitals are set solid or
   * slightly tight; a small capitals label (an eyebrow, a tab) is opened up, here within the house's
   * 0.1em maximum (the research's +5-12%, capped at the house limit). Arabic script takes none.
   */
  capsTracking: {
    displayEm: { min: -0.03, max: 0 },
    labelEm: { min: 0.05, max: 0.1 },
    /** A capitals block at or under this share of the width is a label. */
    labelMaxShareOfWidth: 0.035,
  },
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

/**
 * ADR-275: whether a block is display type: a title (the display roles) at least
 * `displayLineHeight.minShareOfWidth` of the canvas width.
 */
export function isDisplayText(t: { role: string; fontSize: number }, canvasWidth: number): boolean {
  const d = HOUSE_RULES.displayLineHeight;
  return d.roles.includes(t.role) && Number.isFinite(canvasWidth) && canvasWidth > 0 && t.fontSize >= d.minShareOfWidth * canvasWidth;
}

/**
 * ADR-275: the leading a block may take, by script, role and size. `inkCheckedBelow` is the body
 * range's minimum: a block set tighter than it has to show measured ink clearance between its lines
 * (always for Arabic script; for Latin whenever the copy is at hand).
 */
export function lineHeightRange(
  script: 'latin' | 'arabic',
  t: { role: string; fontSize: number },
  canvasWidth: number
): { min: number; max: number; inkCheckedBelow: number; display: boolean } {
  const body = HOUSE_RULES.lineHeight[script];
  const display = isDisplayText(t, canvasWidth);
  const range = display ? HOUSE_RULES.displayLineHeight[script] : body;
  return { min: range.min, max: range.max, inkCheckedBelow: body.min, display };
}

/**
 * ADR-275: the tracking (em) a Latin block set in capitals may take: display size solid to slightly
 * tight, a small label opened up, anything between within the house limit.
 */
export function capsTrackingRange(t: { role: string; fontSize: number }, canvasWidth: number): { min: number; max: number; kind: 'display' | 'label' | 'text' } {
  const c = HOUSE_RULES.capsTracking;
  if (isDisplayText(t, canvasWidth)) return { ...c.displayEm, kind: 'display' };
  if (t.fontSize <= c.labelMaxShareOfWidth * canvasWidth && t.role !== 'body') return { ...c.labelEm, kind: 'label' };
  return { min: -HOUSE_RULES.letterSpacingMaxEm, max: HOUSE_RULES.letterSpacingMaxEm, kind: 'text' };
}

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

/**
 * ADR-238: whether a layout's logo clear space is the client guideline's own (a cover composed from
 * its page grammar), rather than the stronger of it and the house's. ADR-271: a poster composed from
 * the grammar keeps the guideline's own too (KAAE: the height of the K, p.4).
 */
export function usesGuidelineClearSpace(layout: { composition?: { grammar: 'page' | 'cover' | 'poster' } }): boolean {
  return layout.composition?.grammar === 'cover' || layout.composition?.grammar === 'poster';
}

export function minLogoWidth(canvasWidth: number): number {
  return Math.max(HOUSE_RULES.logo.minWidthPx, Math.round(HOUSE_RULES.logo.minWidthShareOfCanvas * canvasWidth));
}

/**
 * The box around the logo that must hold no text and no rule: the stronger of the house's half its
 * height and the client's own minimum. With `clientOnly` (ADR-238: a cover composed from the
 * client's guideline, which sets its own clear space, KAAE's K height) the client's minimum alone,
 * when it names one; the house's 100px minimum width still applies through the LOGO check.
 */
export function logoClearZone(logo: { x: number; y: number; width: number; height: number }, clientMinimumPx = 0, options: { clientOnly?: boolean } = {}) {
  const cs = options.clientOnly && clientMinimumPx > 0 ? clientMinimumPx : Math.max(HOUSE_RULES.logo.clearSpaceShareOfHeight * logo.height, clientMinimumPx);
  return { x: logo.x - cs, y: logo.y - cs, width: logo.width + 2 * cs, height: logo.height + 2 * cs };
}
