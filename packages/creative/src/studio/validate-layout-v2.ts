import type { StudioLayoutV2, Box } from './layout-v2.js';
import { photoRecipeOf } from './layout-v2.js';
import { photosMayOverlap } from './photo-cutout.js';
import { recipePhotoMinimum } from './photo-selection.js';
import { carrierOf, shapePaintsOver } from './art-direction/surfaces.js';
import { HOUSE_RULES, FORBIDDEN_ART_WORDS, minLogoWidth as houseMinLogoWidth, logoClearZone, requiredContrast, isStoryFormat, getSafeZoneBox, usesGuidelineClearSpace } from './house-rules.js';

export interface ValidationReference {
  rules: {
    fontFamily: string;
    palette: string[];
    scriptFonts?: {
      arabic?: string;
    };
    /** When present, only these client-approved display faces may augment the body face. */
    admittedDisplayFonts?: { latin: string[]; arabic: string[] };
  };
  logoAspect: number; // width / height
  logoMinimumWidthPx?: number;
  logoClearSpacePx?: number;
  /**
   * ADR-238: the client's clear space as a share of the logo's height (KAAE: the height of its K,
   * 0.15). The stronger of it, `logoClearSpacePx` and the house's half-height applies.
   */
  logoClearSpaceShareOfHeight?: number;
}

export interface LayoutValidationContext {
  expectedWidth: number;
  expectedHeight: number;
  copyCount: number;
  copyScripts: Array<'latin' | 'arabic' | 'unsupported'>;
  /** Content photos the request carries; each must be placed exactly once. Absent or 0: none may appear. */
  photoCount?: number;
  /**
   * ADR-157: in `choose` mode the requester let the design choose among the photos, so a distinct
   * subset of at least `minimum` is placed. Absent is `all`.
   */
  photoSelection?: { mode: 'all' | 'choose'; minimum: number; insisted?: boolean; counted?: boolean };
  reference: ValidationReference;
  draftFont?: string;
  contrastEvaluator?: (box: Box, fontSize: number, bold: boolean) => number;
}

export type ValidationErrorCode =
  | 'DIMENSIONS_CHANGED'
  | 'COPY_PLACEMENT'
  | 'FONT_NOT_ADMITTED'
  | 'PALETTE'
  | 'BOUNDS'
  | 'OVERLAP'
  | 'MIN_SIZE'
  | 'LINE_HEIGHT'
  | 'LETTER_SPACING'
  | 'HIERARCHY'
  | 'LOGO'
  | 'CONTRAST'
  | 'ART_SAFETY'
  | 'PHOTOS'
  | 'ORNAMENT'
  | 'COUNTS';

export interface ValidationFailure {
  ok: false;
  code: ValidationErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationSuccess {
  ok: true;
  layout: StudioLayoutV2;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

function boxesIntersect(a: Box, b: Box): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function boxContains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function normalizeHex(hex: string): string {
  let clean = hex.trim().toLowerCase();
  if (clean.length === 4) {
    clean = `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  return clean;
}

const FORBIDDEN_ART_REGEX = new RegExp(`\\b(${FORBIDDEN_ART_WORDS.join('|')})\\b`, 'i');

/** Display faces QA admits for Latin copy when the client has no admitted-font list of its own. */
const DEFAULT_ADMITTED_LATIN_DISPLAY = [
  'Cinzel', 'Playfair Display', 'Montserrat', 'Lora', 'Bodoni Moda', 'Cairo', 'Plus Jakarta Sans', 'Vazirmatn', 'Inter', 'Verdana', 'Crimson Pro',
];
const DEFAULT_ADMITTED_ARABIC = ['Noto Sans Arabic', 'Amiri', 'IBM Plex Sans Arabic'];

/**
 * The font families QA admits for each script, as the validator applies them (case-insensitive).
 * Shared so the copy feasibility screen (ADR-125) measures exactly the faces a passing layout
 * could use, and cannot declare copy unsettable in a face QA would have accepted.
 */
export function admittedFamiliesForQa(input: {
  latinFont?: string; arabicFont?: string; draftFont?: string; admittedDisplayFonts?: { latin: string[]; arabic: string[] };
}): { latin: string[]; arabic: string[] } {
  const unique = (names: Array<string | undefined>) => {
    const byKey = new Map<string, string>();
    for (const name of names) if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
    return [...byKey.values()];
  };
  const client = input.admittedDisplayFonts;
  const arabicScriptFont = input.arabicFont || 'Noto Sans Arabic';
  return client
    ? { latin: unique([input.latinFont, ...client.latin]), arabic: unique([arabicScriptFont, ...client.arabic]) }
    : { latin: unique([input.latinFont || 'Verdana', input.draftFont || 'Verdana', 'Verdana', ...DEFAULT_ADMITTED_LATIN_DISPLAY]),
      arabic: unique([...DEFAULT_ADMITTED_ARABIC, input.arabicFont]) };
}

/** The client's own logo clear space in pixels for a logo box (ADR-238), before the house rule. */
export function clientLogoClearSpacePx(logo: Box, reference: Pick<ValidationReference, 'logoClearSpacePx' | 'logoClearSpaceShareOfHeight'>): number {
  return Math.max(reference.logoClearSpacePx ?? 0, (reference.logoClearSpaceShareOfHeight ?? 0) * logo.height);
}

export function validateLayoutV2(
  layout: StudioLayoutV2,
  context: LayoutValidationContext
): ValidationResult {
  // 1. COUNTS
  if ((layout.text?.length ?? 0) > 40) {
    return {
      ok: false,
      code: 'COUNTS',
      message: `Text count ${layout.text.length} exceeds maximum 40`,
    };
  }
  if ((layout.shapes?.length ?? 0) > 40) {
    return {
      ok: false,
      code: 'COUNTS',
      message: `Shapes count ${layout.shapes?.length ?? 0} exceeds maximum 40`,
    };
  }

  // 2. DIMENSIONS_CHANGED
  if (layout.width !== context.expectedWidth || layout.height !== context.expectedHeight) {
    return {
      ok: false,
      code: 'DIMENSIONS_CHANGED',
      message: `Dimensions ${layout.width}x${layout.height} do not match requested ${context.expectedWidth}x${context.expectedHeight}`,
    };
  }

  // 3. COPY_PLACEMENT
  if (layout.text.length !== context.copyCount) {
    return {
      ok: false,
      code: 'COPY_PLACEMENT',
      message: `Expected ${context.copyCount} copy blocks, found ${layout.text.length}`,
    };
  }
  const seenIndices = new Set<number>();
  for (const t of layout.text) {
    if (t.copyIndex < 0 || t.copyIndex >= context.copyCount) {
      return {
        ok: false,
        code: 'COPY_PLACEMENT',
        message: `Invalid copyIndex ${t.copyIndex}; expected 0..${context.copyCount - 1}`,
      };
    }
    if (seenIndices.has(t.copyIndex)) {
      return {
        ok: false,
        code: 'COPY_PLACEMENT',
        message: `Duplicate copyIndex ${t.copyIndex}`,
      };
    }
    seenIndices.add(t.copyIndex);
  }

  // Clone layout for possible normalization
  const normalized: StudioLayoutV2 = JSON.parse(JSON.stringify(layout));

  // 4. FONT_NOT_ADMITTED & Script Normalization
  const clientDisplay = context.reference.rules.admittedDisplayFonts;
  const admitted = admittedFamiliesForQa({
    latinFont: context.reference.rules.fontFamily,
    arabicFont: context.reference.rules.scriptFonts?.arabic,
    draftFont: context.draftFont,
    admittedDisplayFonts: clientDisplay,
  });
  const admittedLatinFonts = new Set(admitted.latin.map((font) => font.toLowerCase()));
  const arabicScriptFont = context.reference.rules.scriptFonts?.arabic || 'Noto Sans Arabic';
  const admittedArabicFonts = new Set(admitted.arabic.map((font) => font.toLowerCase()));
  for (let i = 0; i < normalized.text.length; i++) {
    const t = normalized.text[i];
    const script = context.copyScripts[t.copyIndex] || 'latin';

    if (script === 'arabic') {
      t.rtl = true;
      if (!t.fontFamily || !admittedArabicFonts.has(t.fontFamily.toLowerCase())) {
        if (clientDisplay) return {
          ok: false, code: 'FONT_NOT_ADMITTED',
          message: `Font family '${t.fontFamily}' is not admitted for this client's Arabic-script text`,
        };
        t.fontFamily = arabicScriptFont;
      }
      if (t.align !== 'center' && t.align !== 'right') {
        t.align = 'right';
      }
    } else {
      if (!admittedLatinFonts.has(t.fontFamily.toLowerCase())) {
        return {
          ok: false,
          code: 'FONT_NOT_ADMITTED',
          message: `Font family '${t.fontFamily}' is not admitted for Latin text (must be reference or draft font)`,
        };
      }
    }
  }

  // 5. PALETTE
  const allowedPalette = new Set(context.reference.rules.palette.map(normalizeHex));
  if (!allowedPalette.has(normalizeHex(layout.background.color))) {
    return {
      ok: false,
      code: 'PALETTE',
      message: `Background color ${layout.background.color} is not in reference palette`,
    };
  }
  if (layout.art?.scrim && !allowedPalette.has(normalizeHex(layout.art.scrim.color))) {
    return {
      ok: false,
      code: 'PALETTE',
      message: `Art scrim color ${layout.art.scrim.color} is not in reference palette`,
    };
  }
  for (const s of (layout.shapes || [])) {
    if (!allowedPalette.has(normalizeHex(s.color))) {
      return {
        ok: false,
        code: 'PALETTE',
        message: `Shape color ${s.color} is not in reference palette`,
      };
    }
    if (s.strokeColor && !allowedPalette.has(normalizeHex(s.strokeColor))) {
      return {
        ok: false,
        code: 'PALETTE',
        message: `Shape stroke color ${s.strokeColor} is not in reference palette`,
      };
    }
  }
  for (const o of layout.overlays || []) {
    if (!allowedPalette.has(normalizeHex(o.color))) {
      return { ok: false, code: 'PALETTE', message: `Overlay colour ${o.color} is not in reference palette` };
    }
  }
  // ADR-238: every stop of a gradient and every brand element is in the palette too.
  for (const s of layout.shapes || []) {
    const off = s.gradient?.stops.find((st) => !allowedPalette.has(normalizeHex(st.color)));
    if (off) return { ok: false, code: 'PALETTE', message: `Gradient colour ${off.color} is not in reference palette` };
  }
  for (const o of layout.ornaments || []) {
    if (!allowedPalette.has(normalizeHex(o.color))) {
      return { ok: false, code: 'PALETTE', message: `Brand element colour ${o.color} is not in reference palette` };
    }
  }
  for (const s of layout.shapes || []) {
    if (s.shadow && !allowedPalette.has(normalizeHex(s.shadow.color))) {
      return { ok: false, code: 'PALETTE', message: `Shadow colour ${s.shadow.color} is not in reference palette` };
    }
  }
  for (const t of (layout.text || [])) {
    if (!allowedPalette.has(normalizeHex(t.color))) {
      return {
        ok: false,
        code: 'PALETTE',
        message: `Text color ${t.color} is not in reference palette`,
      };
    }
  }

  // 6. BOUNDS & Safe Margin
  const shortEdge = Math.min(layout.width, layout.height);
  const minSafeMargin = Math.floor(HOUSE_RULES.safeMarginShare * shortEdge);
  if (layout.grid.margin < minSafeMargin) {
    return {
      ok: false,
      code: 'BOUNDS',
      message: `Grid margin ${layout.grid.margin}px is below 6% safe margin (${minSafeMargin}px)`,
    };
  }

  const canvasBox: Box = { x: 0, y: 0, width: layout.width, height: layout.height };
  const safeMarginBox: Box = getSafeZoneBox(layout.width, layout.height, layout.grid.margin);

  if (!layout.logo) {
    return {
      ok: false,
      code: 'LOGO',
      message: 'Layout logo is missing',
    };
  }

  // Check all shapes are inside canvas
  for (const s of (layout.shapes || [])) {
    if (!boxContains(canvasBox, s)) {
      return {
        ok: false,
        code: 'BOUNDS',
        message: `Shape outside canvas bounds: {x:${s.x},y:${s.y},w:${s.width},h:${s.height}}`,
      };
    }
  }

  for (const o of layout.overlays || []) {
    if (!boxContains(canvasBox, o)) {
      return { ok: false, code: 'BOUNDS', message: `Overlay outside canvas bounds: {x:${o.x},y:${o.y},w:${o.width},h:${o.height}}` };
    }
  }

  // Check all text boxes are inside safe margin
  for (const t of (layout.text || [])) {
    if (!boxContains(safeMarginBox, t)) {
      const isStory = isStoryFormat(layout.width, layout.height);
      const prefix = isStory ? 'Story safe-zone violation: Text' : 'Text';
      return {
        ok: false,
        code: 'BOUNDS',
        message: `${prefix} box outside safe margin bounds: {x:${t.x},y:${t.y},w:${t.width},h:${t.height}}`,
      };
    }
  }

  // Check logo is inside safe margin
  if (!boxContains(safeMarginBox, layout.logo)) {
    const isStory = isStoryFormat(layout.width, layout.height);
    const prefix = isStory ? 'Story safe-zone violation: Logo' : 'Logo';
    return {
      ok: false,
      code: 'BOUNDS',
      message: `${prefix} outside safe margin bounds: {x:${layout.logo.x},y:${layout.logo.y},w:${layout.logo.width},h:${layout.logo.height}}`,
    };
  }

  // 6b. PHOTOS: every content photo placed once, inside the canvas, big enough to read as a
  // photograph, never under text or the logo. A photo the client sent and the design dropped is
  // the request not done; a photo the client did not send is invented.
  // In `choose` mode (ADR-157) the requester said the design need not use them all: a distinct
  // subset of at least the minimum is the request done. Every other rule below applies unchanged.
  //
  // ADR-180 (owner decision, "office house style"): in an art-direction recipe the hero, with at most a
  // blended texture, is the choice unless the requester's own words bind more: "use all the photos"
  // binds every one, "pick 3" binds three. The half-the-photos guess and a request that says nothing
  // about its photos do not (this supersedes ADR-171's default minimum for recipes).
  const photoCount = context.photoCount ?? 0;
  const photos = layout.photos ?? [];
  const recipe = photoRecipeOf(layout);
  const recipeMinimum = recipe ? recipePhotoMinimum(context.photoSelection, photoCount) : photoCount;
  const choosing = photoCount > 0 && (recipe ? recipeMinimum < photoCount : context.photoSelection?.mode === 'choose');
  const fewest = !choosing ? photoCount : recipe ? recipeMinimum : Math.max(1, Math.min(photoCount, context.photoSelection!.minimum));
  if (choosing ? photos.length < fewest || photos.length > photoCount : photos.length !== photoCount) {
    return {
      ok: false,
      code: 'PHOTOS',
      message: choosing
        ? `Design places ${photos.length} photo(s); the requester let the design choose at least ${fewest} of ${photoCount}`
        : `Design places ${photos.length} photo(s); the request has ${photoCount}`,
    };
  }
  const seen = new Set<number>();
  for (const p of photos) {
    if (p.photoIndex >= photoCount || seen.has(p.photoIndex)) {
      return { ok: false, code: 'PHOTOS', message: `Photo index ${p.photoIndex} is out of range or placed twice` };
    }
    seen.add(p.photoIndex);
    if (p.x < 0 || p.y < 0 || p.x + p.width > layout.width || p.y + p.height > layout.height) {
      return { ok: false, code: 'PHOTOS', message: `Photo ${p.photoIndex} leaves the canvas` };
    }
    const minSide = Math.round(Math.min(layout.width, layout.height) * (p.role === 'inset' ? 0.12 : 0.22));
    // A texture blended into a fade (ADR-170) is only in a recipe, and never a cell of its own.
    if (p.role === 'texture' && !recipe) {
      return { ok: false, code: 'PHOTOS', message: `Photo ${p.photoIndex} is a texture outside an art-direction recipe` };
    }
    // A person cut out of their photo is as wide as they are: a standing figure is narrow by nature,
    // so a cut-out is held to its height (ADR-032). A framed photo keeps the rule on both sides.
    if (p.role !== 'texture' && (p.treatment === 'cutout' ? p.height < minSide * 1.5 : Math.min(p.width, p.height) < minSide)) {
      return { ok: false, code: 'PHOTOS', message: `Photo ${p.photoIndex} (${p.role}) is ${p.width}x${p.height}; at least ${p.treatment === 'cutout' ? `${Math.round(minSide * 1.5)}px tall` : `${minSide}px a side`}` };
    }
    // A mask shapes a framed photo's rectangle; a cut-out has none, only the person's own edge. An
    // outline or a glow follows a person's silhouette; a framed photo has only its rectangle, and
    // the renderer would draw neither, so the design would not be the one described.
    if (p.treatment === 'cutout' && p.mask) {
      return { ok: false, code: 'PHOTOS', message: `Photo ${p.photoIndex} is a cut-out and cannot take the ${p.mask} mask; a mask shapes a framed photo` };
    }
    if (p.treatment !== 'cutout' && (p.outline || p.glow)) {
      return { ok: false, code: 'PHOTOS', message: `Photo ${p.photoIndex} is framed and cannot take ${p.outline ? 'an outline' : 'a glow'}; it follows a cut-out person's silhouette` };
    }
    // In a recipe, text may lie over a photo only on a plate, card, pill, fade or scrim (ADR-170);
    // hard QA then measures it on the rendered pixels. Anywhere else, never.
    for (const t of layout.text) {
      if (boxesIntersect(p, t) && !(recipe && carrierOf(layout, t))) {
        return {
          ok: false,
          code: 'PHOTOS',
          message: recipe
            ? `Text copyIndex ${t.copyIndex} sits bare on photo ${p.photoIndex}; in a recipe it must sit on a plate, card, pill, fade or scrim`
            : `Photo ${p.photoIndex} sits under text copyIndex ${t.copyIndex}`,
        };
      }
    }
    // The office sets its logo in a corner of the hero (reference examples 3, 8 and 11).
    if (boxesIntersect(p, layout.logo) && !recipe) {
      return { ok: false, code: 'PHOTOS', message: `Photo ${p.photoIndex} sits under the logo` };
    }
  }
  // Two cut-out people may stand a little into each other, as a group does; see photosMayOverlap.
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      // A texture is blended into the hero's fade (ADR-170): overlapping it is the point.
      const blended = Boolean(recipe) && (photos[i].role === 'texture' || photos[j].role === 'texture');
      if (boxesIntersect(photos[i], photos[j]) && !photosMayOverlap(photos[i], photos[j]) && !blended) {
        return { ok: false, code: 'PHOTOS', message: `Photos ${photos[i].photoIndex} and ${photos[j].photoIndex} overlap` };
      }
    }
  }

  // 7. OVERLAP
  // No text-text overlap
  for (let i = 0; i < layout.text.length; i++) {
    for (let j = i + 1; j < layout.text.length; j++) {
      if (boxesIntersect(layout.text[i], layout.text[j])) {
        return {
          ok: false,
          code: 'OVERLAP',
          message: `Text overlap between copyIndex ${layout.text[i].copyIndex} and ${layout.text[j].copyIndex}`,
        };
      }
    }
  }

  // No text-logo overlap
  for (const t of layout.text) {
    if (boxesIntersect(t, layout.logo)) {
      return {
        ok: false,
        code: 'OVERLAP',
        message: `Text box copyIndex ${t.copyIndex} overlaps with logo`,
      };
    }
  }

  // Shapes with role 'panel' may sit under text; 'rule'/'accent'/'frame' may not intersect text. A
  // frame drawn as a stroke only paints its band, so text well inside it does not touch it.
  for (const s of layout.shapes) {
    if (s.role !== 'panel') {
      for (const t of layout.text) {
        if (shapePaintsOver(s, t)) {
          return {
            ok: false,
            code: 'OVERLAP',
            message: `Shape role '${s.role}' intersects text box copyIndex ${t.copyIndex}`,
          };
        }
      }
    }
  }

  // 8. MIN_SIZE
  const minBodySize = HOUSE_RULES.minBodyShareOfWidth * layout.width; // 17.28 px at 1080
  let bodyFontSize: number | null = null;
  let titleFontSize: number | null = null;

  for (const t of layout.text) {
    if (t.fontSize < HOUSE_RULES.minFontPx) {
      return {
        ok: false,
        code: 'MIN_SIZE',
        message: `Text size ${t.fontSize}px is below absolute minimum 12px`,
      };
    }
    if (t.role === 'body') {
      if (t.fontSize < minBodySize) {
        return {
          ok: false,
          code: 'MIN_SIZE',
          message: `Body text size ${t.fontSize}px is below minimum 1.6% width (${minBodySize.toFixed(1)}px)`,
        };
      }
      bodyFontSize = Math.max(bodyFontSize || 0, t.fontSize);
    }
    if (t.role === 'title') {
      titleFontSize = Math.max(titleFontSize || 0, t.fontSize);
    }
  }

  if (titleFontSize !== null && bodyFontSize !== null) {
    if (titleFontSize < HOUSE_RULES.titleToBodyMin * bodyFontSize) {
      return {
        ok: false,
        code: 'MIN_SIZE',
        message: `Title size (${titleFontSize}px) is less than 2.2x body size (${bodyFontSize}px, required >= ${(2.2 * bodyFontSize).toFixed(1)}px)`,
      };
    }
  }

  // 9. LINE_HEIGHT
  for (const t of layout.text) {
    const script = context.copyScripts[t.copyIndex] || 'latin';
    if (script === 'arabic') {
      if (t.lineHeight < HOUSE_RULES.lineHeight.arabic.min || t.lineHeight > HOUSE_RULES.lineHeight.arabic.max) {
        return {
          ok: false,
          code: 'LINE_HEIGHT',
          message: `Arabic text lineHeight ${t.lineHeight} outside allowed range [1.6, 1.9]`,
        };
      }
    } else {
      if (t.lineHeight < HOUSE_RULES.lineHeight.latin.min || t.lineHeight > HOUSE_RULES.lineHeight.latin.max) {
        return {
          ok: false,
          code: 'LINE_HEIGHT',
          message: `Latin text lineHeight ${t.lineHeight} outside allowed range [1.2, 1.5]`,
        };
      }
    }
  }

  // 10. LETTER_SPACING
  for (const t of layout.text) {
    const script = context.copyScripts[t.copyIndex] || 'latin';
    if (script === 'arabic') {
      if (t.letterSpacing && t.letterSpacing !== 0) {
        return {
          ok: false,
          code: 'LETTER_SPACING',
          message: `Arabic text must not have letterSpacing (found ${t.letterSpacing})`,
        };
      }
    } else {
      if (t.letterSpacing !== undefined && Math.abs(t.letterSpacing) > HOUSE_RULES.letterSpacingMaxEm) {
        return {
          ok: false,
          code: 'LETTER_SPACING',
          message: `Latin text letterSpacing ${t.letterSpacing} exceeds |0.1em|`,
        };
      }
      if (t.role === 'body' && t.letterSpacing && t.letterSpacing !== 0) {
        return {
          ok: false,
          code: 'LETTER_SPACING',
          message: `Body text must not have letterSpacing (found ${t.letterSpacing})`,
        };
      }
    }
  }

  // 11. HIERARCHY
  // Hierarchy order: title > subtitle >= (date | venue) >= body >= footer
  const roleSizes: Record<string, number> = {};
  for (const t of layout.text) {
    roleSizes[t.role] = Math.max(roleSizes[t.role] || 0, t.fontSize);
  }

  const titleSize = roleSizes['title'];
  const subtitleSize = roleSizes['subtitle'];
  const dateSize = roleSizes['date'];
  const venueSize = roleSizes['venue'];
  const dateVenueSize = Math.max(dateSize || 0, venueSize || 0) || null;
  const bSize = roleSizes['body'];
  const footerSize = roleSizes['footer'];

  if (titleSize !== undefined && subtitleSize !== undefined && titleSize <= subtitleSize) {
    return {
      ok: false,
      code: 'HIERARCHY',
      message: `Hierarchy violated: title (${titleSize}px) must be larger than subtitle (${subtitleSize}px)`,
    };
  }
  if (subtitleSize !== undefined && dateVenueSize !== null && subtitleSize < dateVenueSize) {
    return {
      ok: false,
      code: 'HIERARCHY',
      message: `Hierarchy violated: subtitle (${subtitleSize}px) must be >= date/venue (${dateVenueSize}px)`,
    };
  }
  if (dateVenueSize !== null && bSize !== undefined && dateVenueSize < bSize) {
    return {
      ok: false,
      code: 'HIERARCHY',
      message: `Hierarchy violated: date/venue (${dateVenueSize}px) must be >= body (${bSize}px)`,
    };
  }
  if (bSize !== undefined && footerSize !== undefined && bSize < footerSize) {
    return {
      ok: false,
      code: 'HIERARCHY',
      message: `Hierarchy violated: body (${bSize}px) must be >= footer (${footerSize}px)`,
    };
  }

  // 12. LOGO
  const minLogoWidth = Math.max(houseMinLogoWidth(layout.width), context.reference.logoMinimumWidthPx ?? 0);
  if (layout.logo.width < minLogoWidth) {
    return {
      ok: false,
      code: 'LOGO',
      message: `Logo width ${layout.logo.width}px is less than minimum ${minLogoWidth}px`,
    };
  }
  const actualAspect = layout.logo.width / layout.logo.height;
  const aspectDeviation = Math.abs(actualAspect - context.reference.logoAspect) / context.reference.logoAspect;
  if (aspectDeviation > HOUSE_RULES.logo.aspectTolerance) {
    return {
      ok: false,
      code: 'LOGO',
      message: `Logo aspect ratio ${actualAspect.toFixed(3)} deviates by ${(aspectDeviation * 100).toFixed(1)}% from reference ${context.reference.logoAspect.toFixed(3)} (>1%)`,
    };
  }

  // Respect the stronger of the house rule and the client's stated minimum, in pixels or as a share
  // of the logo's height (ADR-238: KAAE's is the height of its K).
  const clientClearPx = clientLogoClearSpacePx(layout.logo, context.reference);
  // ADR-238: a cover composed from the client's guideline keeps the guideline's own clear space.
  const clientOnly = usesGuidelineClearSpace(layout) && clientClearPx > 0;
  const cs = clientOnly ? clientClearPx : Math.max(HOUSE_RULES.logo.clearSpaceShareOfHeight * layout.logo.height, clientClearPx);
  const logoClearSpace: Box = logoClearZone(layout.logo, clientClearPx, { clientOnly });

  for (const t of layout.text) {
    if (boxesIntersect(t, logoClearSpace)) {
      return {
        ok: false,
        code: 'LOGO',
        message: `Text box copyIndex ${t.copyIndex} violates logo clear space (${cs.toFixed(1)}px)`,
      };
    }
  }
  for (const s of layout.shapes) {
    if (s.role === 'rule' && boxesIntersect(s, logoClearSpace)) {
      return {
        ok: false,
        code: 'LOGO',
        message: `Rule shape violates logo clear space (${cs.toFixed(1)}px)`,
      };
    }
  }

  // 12b. ORNAMENT (ADR-238): a brand element stays inside the canvas and never lies under copy, the
  // logo or its clear space.
  for (const o of layout.ornaments || []) {
    if (!boxContains(canvasBox, o)) {
      return { ok: false, code: 'ORNAMENT', message: `Brand element ${o.kind} leaves the canvas` };
    }
    const under = layout.text.find((t) => boxesIntersect(t, o));
    if (under) {
      return { ok: false, code: 'ORNAMENT', message: `Brand element ${o.kind} lies under copy block ${under.copyIndex}` };
    }
    if (boxesIntersect(o, logoClearSpace)) {
      return { ok: false, code: 'ORNAMENT', message: `Brand element ${o.kind} enters the logo's clear space (${cs.toFixed(1)}px)` };
    }
  }

  // 13. ART_SAFETY
  if (layout.art) {
    if (layout.art.source === 'generated') {
      const prompt = layout.art.prompt || '';
      const match = prompt.match(FORBIDDEN_ART_REGEX);
      if (match) {
        return {
          ok: false,
          code: 'ART_SAFETY',
          message: `Art prompt contains forbidden word '${match[0]}'`,
        };
      }
    }
    // Text over the art must sit where the art is calm. Text that does not touch the art box at
    // all cannot be disturbed by it: this used to require even a footer below a top art band to
    // lie inside a calm region that, bounded by the art, could never reach it.
    if (layout.art.calmRegion) {
      const artBox = layout.art.box || { x: 0, y: 0, width: layout.width, height: layout.height };
      for (const t of layout.text) {
        if (boxesIntersect(t, artBox) && !boxContains(layout.art.calmRegion, t)) {
          return {
            ok: false,
            code: 'ART_SAFETY',
            message: `Text box copyIndex ${t.copyIndex} is not fully covered by art calmRegion`,
          };
        }
      }
    }
  }

  // 14. CONTRAST (if evaluator provided)
  if (context.contrastEvaluator) {
    for (const t of layout.text) {
      const minRatio = requiredContrast(t.fontSize, Boolean(t.bold));
      const ratio = context.contrastEvaluator(t, t.fontSize, Boolean(t.bold));
      if (ratio < minRatio) {
        return {
          ok: false,
          code: 'CONTRAST',
          message: `Text contrast ratio ${ratio.toFixed(2)}:1 for copyIndex ${t.copyIndex} is below required ${minRatio}:1`,
        };
      }
    }
  }

  return {
    ok: true,
    layout: normalized,
  };
}
