import type { StudioLayoutV2, Box } from './layout-v2.js';

export interface ValidationReference {
  rules: {
    fontFamily: string;
    palette: string[];
    scriptFonts?: {
      arabic?: string;
    };
  };
  logoAspect: number; // width / height
}

export interface LayoutValidationContext {
  expectedWidth: number;
  expectedHeight: number;
  copyCount: number;
  copyScripts: Array<'latin' | 'arabic' | 'unsupported'>;
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

function normalizeHex(hex: string): string {
  let clean = hex.trim().toLowerCase();
  if (clean.length === 4) {
    clean = `#${clean[1]}${clean[1]}${clean[2]}${clean[2]}${clean[3]}${clean[3]}`;
  }
  return clean;
}

const FORBIDDEN_ART_WORDS = [
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
];

const FORBIDDEN_ART_REGEX = new RegExp(`\\b(${FORBIDDEN_ART_WORDS.join('|')})\\b`, 'i');

export function validateLayoutV2(
  layout: StudioLayoutV2,
  context: LayoutValidationContext
): ValidationResult {
  // 1. COUNTS
  if (layout.text.length > 40) {
    return {
      ok: false,
      code: 'COUNTS',
      message: `Text count ${layout.text.length} exceeds maximum 40`,
    };
  }
  if (layout.shapes.length > 40) {
    return {
      ok: false,
      code: 'COUNTS',
      message: `Shapes count ${layout.shapes.length} exceeds maximum 40`,
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
  const admittedDisplayFonts = [
    'cinzel',
    'playfair display',
    'montserrat',
    'lora',
    'bodoni moda',
    'cairo',
    'plus jakarta sans',
    'vazirmatn',
    'inter',
    'verdana',
  ];
  const admittedLatinFonts = new Set([
    (context.reference.rules.fontFamily || 'Verdana').toLowerCase(),
    (context.draftFont || 'Verdana').toLowerCase(),
    'verdana',
    ...admittedDisplayFonts,
  ]);
  const arabicScriptFont = context.reference.rules.scriptFonts?.arabic || 'Noto Sans Arabic';

  for (let i = 0; i < normalized.text.length; i++) {
    const t = normalized.text[i];
    const script = context.copyScripts[t.copyIndex] || 'latin';

    if (script === 'arabic') {
      // Overwrite to scriptFonts.arabic, right-aligned, rtl: true (server decision, ADR-028)
      t.fontFamily = arabicScriptFont;
      t.align = 'right';
      t.rtl = true;
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
  for (const s of layout.shapes) {
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
  for (const t of layout.text) {
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
  const minSafeMargin = Math.floor(0.06 * shortEdge);
  if (layout.grid.margin < minSafeMargin) {
    return {
      ok: false,
      code: 'BOUNDS',
      message: `Grid margin ${layout.grid.margin}px is below 6% safe margin (${minSafeMargin}px)`,
    };
  }

  const canvasBox: Box = { x: 0, y: 0, width: layout.width, height: layout.height };
  const safeMarginBox: Box = {
    x: layout.grid.margin,
    y: layout.grid.margin,
    width: layout.width - 2 * layout.grid.margin,
    height: layout.height - 2 * layout.grid.margin,
  };

  // Check all shapes are inside canvas
  for (const s of layout.shapes) {
    if (!boxContains(canvasBox, s)) {
      return {
        ok: false,
        code: 'BOUNDS',
        message: `Shape outside canvas bounds: {x:${s.x},y:${s.y},w:${s.width},h:${s.height}}`,
      };
    }
  }

  // Check all text boxes are inside safe margin
  for (const t of layout.text) {
    if (!boxContains(safeMarginBox, t)) {
      return {
        ok: false,
        code: 'BOUNDS',
        message: `Text box outside safe margin bounds: {x:${t.x},y:${t.y},w:${t.width},h:${t.height}}`,
      };
    }
  }

  // Check logo is inside safe margin
  if (!boxContains(safeMarginBox, layout.logo)) {
    return {
      ok: false,
      code: 'BOUNDS',
      message: `Logo outside safe margin bounds: {x:${layout.logo.x},y:${layout.logo.y},w:${layout.logo.width},h:${layout.logo.height}}`,
    };
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

  // Shapes with role 'panel' may sit under text; 'rule'/'accent'/'frame' may not intersect text
  for (const s of layout.shapes) {
    if (s.role !== 'panel') {
      for (const t of layout.text) {
        if (boxesIntersect(s, t)) {
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
  const minBodySize = 0.016 * layout.width; // 17.28 px at 1080
  let bodyFontSize: number | null = null;
  let titleFontSize: number | null = null;

  for (const t of layout.text) {
    if (t.fontSize < 12) {
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
    if (titleFontSize < 2.2 * bodyFontSize) {
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
      if (t.lineHeight < 1.6 || t.lineHeight > 1.9) {
        return {
          ok: false,
          code: 'LINE_HEIGHT',
          message: `Arabic text lineHeight ${t.lineHeight} outside allowed range [1.6, 1.9]`,
        };
      }
    } else {
      if (t.lineHeight < 1.2 || t.lineHeight > 1.5) {
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
      if (t.letterSpacing !== undefined && Math.abs(t.letterSpacing) > 0.1) {
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
  const minLogoWidth = Math.max(100, Math.round(0.08 * layout.width));
  if (layout.logo.width < minLogoWidth) {
    return {
      ok: false,
      code: 'LOGO',
      message: `Logo width ${layout.logo.width}px is less than minimum ${minLogoWidth}px`,
    };
  }
  const actualAspect = layout.logo.width / layout.logo.height;
  const aspectDeviation = Math.abs(actualAspect - context.reference.logoAspect) / context.reference.logoAspect;
  if (aspectDeviation > 0.01) {
    return {
      ok: false,
      code: 'LOGO',
      message: `Logo aspect ratio ${actualAspect.toFixed(3)} deviates by ${(aspectDeviation * 100).toFixed(1)}% from reference ${context.reference.logoAspect.toFixed(3)} (>1%)`,
    };
  }

  // Clear space: 0.5 * logo.height free of text and rules
  const cs = 0.5 * layout.logo.height;
  const logoClearSpace: Box = {
    x: layout.logo.x - cs,
    y: layout.logo.y - cs,
    width: layout.logo.width + 2 * cs,
    height: layout.logo.height + 2 * cs,
  };

  for (const t of layout.text) {
    if (boxesIntersect(t, logoClearSpace)) {
      return {
        ok: false,
        code: 'LOGO',
        message: `Text box copyIndex ${t.copyIndex} violates logo clear space (0.5x logo height = ${cs.toFixed(1)}px)`,
      };
    }
  }
  for (const s of layout.shapes) {
    if (s.role === 'rule' && boxesIntersect(s, logoClearSpace)) {
      return {
        ok: false,
        code: 'LOGO',
        message: `Rule shape violates logo clear space (0.5x logo height = ${cs.toFixed(1)}px)`,
      };
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
    // calmRegion must cover every text box if present
    if (layout.art.calmRegion) {
      for (const t of layout.text) {
        if (!boxContains(layout.art.calmRegion, t)) {
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
      const isLarge = t.fontSize >= 32 || (t.fontSize >= 24 && Boolean(t.bold));
      const minRatio = isLarge ? 3.0 : 4.5;
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
