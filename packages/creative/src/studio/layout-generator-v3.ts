import { fitLogoToAspect } from './studio-normalize.js';
import { z } from 'zod';
import type { StudioLayoutV2, TextElement, ShapeElement, ArtConfig, Box } from './layout-v2.js';
import { studioLayoutV2Schema } from './layout-v2.js';
import { resolveModel, modelSupportsReasoningEffort } from '@hawa/domain';
import { fontCoversText, pickFontCovering } from './render-layout-v2.js';
import { evaluateDesignMetrics, checkCandidateSetDegeneracy, type CandidateSetDegeneracyResult } from './design-metrics.js';
import { hexToLuminance, calculateLuminanceContrastRatio } from './composite-contrast.js';
import { OpenAiStudioClient, type OpenAiStructuredResponse } from './openai-studio-client.js';
import type { ExemplarRetrievalMatch } from './exemplar-retrieval.js';

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedTextElement extends NormalizedBox {
  copyIndex: number;
  role: 'eyebrow' | 'title' | 'subtitle' | 'body' | 'date' | 'venue' | 'cta' | 'footer' | 'other';
  fontSize: number;
  lineHeight: number;
  letterSpacing: number | null;
  fontFamily: 'Cinzel' | 'Lora' | 'Cairo' | 'Playfair Display' | 'Cormorant Garamond' | 'Amiri' | 'Verdana' | 'Noto Sans Arabic';
  color: string;
  align: 'left' | 'center' | 'right';
  bold: boolean;
  italic: boolean;
  rtl: boolean;
}

export interface NormalizedShapeElement extends NormalizedBox {
  kind: 'rect' | 'roundRect' | 'ellipse' | 'line';
  color: string;
  opacity: number | null;
  radius: number | null;
  strokeWidth: number | null;
  strokeColor: string | null;
  role: 'rule' | 'panel' | 'accent' | 'frame';
}

export interface NormalizedArtConfig {
  source: 'generated' | 'procedural';
  prompt: string | null;
  motif: 'guilloche' | 'sun-rays' | 'thin-rules' | 'gradient-wash' | null;
  box: NormalizedBox;
  opacity: number;
  calmRegion: NormalizedBox;
}

export type CompositionArchetype =
  | 'monolith_centered'
  | 'asymmetric_editorial'
  | 'hero_statement_grid'
  | 'split_statutory_banner'
  | 'minimal_framed'
  | 'stat_card_triptych'
  | 'numbered_standards_stack'
  | 'executive_roadmap_quad'
  | 'crest_banner_split'
  | 'credential_badge_card'
  | 'chevron_band_institutional'
  | 'monograph_bilateral_column'
  | 'academic_citation_folio'
  | 'commencement_diploma_frame';

export interface NormalizedLayoutCandidate {
  id: string;
  conceptTitle: string;
  compositionArchetype: CompositionArchetype;
  typeScale: {
    base: number;
    ratio: number;
  };
  grid: {
    margin: number;
    columns: 6 | 12;
    gutter: number;
    baseline: number;
  };
  background: {
    color: string;
  };
  logo: NormalizedBox;
  art: NormalizedArtConfig | null;
  shapes: NormalizedShapeElement[];
  text: NormalizedTextElement[];
}

export interface CopyBlockSlotInput {
  index: number;
  text: string;
  role: 'eyebrow' | 'title' | 'subtitle' | 'body' | 'date' | 'venue' | 'cta' | 'footer' | 'other';
  script: 'latin' | 'arabic';
}

export interface CapacitySlotGuidance {
  copyIndex: number;
  role: string;
  charCount: number;
  script: string;
  targetCapacityMin: number;
  targetCapacityMax: number;
  recommendedNormWidth: [number, number];
  recommendedNormHeight: [number, number];
  recommendedNormFontSize: [number, number];
}

/**
 * Computes character capacity guidance for each copy block per PosterMELD (2608.02218).
 */
export function computeCapacitySlot(
  block: CopyBlockSlotInput,
  canvasWidth: number,
  canvasHeight: number
): CapacitySlotGuidance {
  const charCount = block.text.trim().length;
  let fontRange: [number, number];
  let heightRange: [number, number];
  const widthRange: [number, number] = [0.75, 0.88];

  switch (block.role) {
    case 'title': {
      const minTitlePx = Math.max(36, Math.round(Math.ceil(0.016 * canvasWidth) * 2.2));
      fontRange = [minTitlePx / canvasHeight, Math.max(minTitlePx * 1.3, 52) / canvasHeight];
      heightRange = [0.07, 0.12];
      break;
    }
    case 'subtitle':
      fontRange = [20 / canvasHeight, 26 / canvasHeight];
      heightRange = [0.04, 0.08];
      break;
    case 'eyebrow':
      fontRange = [13 / canvasHeight, 16 / canvasHeight];
      heightRange = [0.025, 0.04];
      break;
    case 'body': {
      const minBodyPx = Math.ceil(0.016 * canvasWidth);
      const minBodyNorm = minBodyPx / canvasHeight;
      fontRange = [minBodyNorm, Math.max(minBodyNorm * 1.3, 24 / canvasHeight)];
      const estLines = Math.ceil(charCount / 65);
      const estHeight = Math.max(0.10, Math.min(0.28, (estLines * 28) / canvasHeight));
      heightRange = [estHeight * 0.9, estHeight * 1.3];
      break;
    }
    case 'footer': {
      const minFooterNorm = 12 / canvasHeight;
      fontRange = [minFooterNorm, 16 / canvasHeight];
      heightRange = [0.025, 0.045];
      break;
    }
    default:
      fontRange = [14 / canvasHeight, 18 / canvasHeight];
      heightRange = [0.04, 0.08];
  }

  return {
    copyIndex: block.index,
    role: block.role,
    charCount,
    script: block.script,
    targetCapacityMin: Math.round(charCount * 0.9),
    targetCapacityMax: Math.round(charCount * 2.2),
    recommendedNormWidth: widthRange,
    recommendedNormHeight: [Number(heightRange[0].toFixed(3)), Number(heightRange[1].toFixed(3))],
    recommendedNormFontSize: [Number(fontRange[0].toFixed(4)), Number(fontRange[1].toFixed(4))],
  };
}

/**
 * Verifies that text elements in the scaled layout have sufficient capacity to render copy.
 */
export function verifySlotCapacity(
  layout: StudioLayoutV2,
  copyBlocks: CopyBlockSlotInput[]
): { ok: boolean; overflowIssues: string[] } {
  const issues: string[] = [];

  for (const block of copyBlocks) {
    const textEl = layout.text.find((t) => t.copyIndex === block.index);
    if (!textEl) {
      issues.push(`Missing text element for copyIndex ${block.index} (${block.role})`);
      continue;
    }

    const charWidth = 0.52 * textEl.fontSize;
    const charsPerLine = Math.floor(textEl.width / charWidth);
    const lineSpacing = textEl.lineHeight * textEl.fontSize;
    const numLines = Math.floor(textEl.height / lineSpacing);
    const capacity = Math.max(1, charsPerLine * numLines);

    if (block.text.trim().length > capacity * 1.6) {
      issues.push(
        `Slot overflow on copyIndex ${block.index} (${block.role}): text has ${block.text.length} chars, capacity is only ~${capacity} chars`
      );
    }
  }

  return {
    ok: issues.length === 0,
    overflowIssues: issues,
  };
}

/**
 * Detects bilateral symmetric twin-card layouts (frequent model failure mode).
 */
export function hasTwinCardBlock(layout: StudioLayoutV2): boolean {
  const panels = layout.shapes.filter(
    (s) => s.role === 'panel' || s.kind === 'rect' || s.kind === 'roundRect'
  );
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const p1 = panels[i];
      const p2 = panels[j];
      if (
        Math.abs(p1.y - p2.y) < 25 &&
        Math.abs(p1.height - p2.height) < 25 &&
        Math.abs(p1.width - p2.width) < 25 &&
        p1.width < layout.width * 0.48 &&
        p1.width > layout.width * 0.30
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Server-side scaling: converts normalized [0..1] candidate layout to target StudioLayoutV2 (PosterLLaVa).
 */
export function scaleNormalizedLayoutToV2(
  norm: NormalizedLayoutCandidate,
  canvasWidth: number,
  canvasHeight: number,
  /** The real logo's width over height. When given, the logo is fitted before geometry is settled. */
  logoAspect?: number
): StudioLayoutV2 {
  const clamp = (val: number, min = 0, max = 1) => Math.min(max, Math.max(min, val));
  const scaleX = (val: number) => Math.round(clamp(val) * canvasWidth);
  const scaleY = (val: number) => Math.round(clamp(val) * canvasHeight);
  const scaleDimX = (val: number) => Math.max(1, Math.round(clamp(val) * canvasWidth));
  const scaleDimY = (val: number) => Math.max(1, Math.round(clamp(val) * canvasHeight));

  const scaledGrid = {
    margin: Math.max(40, scaleX(norm.grid.margin)),
    columns: norm.grid.columns === 6 ? (6 as const) : (12 as const),
    gutter: Math.max(12, scaleX(norm.grid.gutter)),
    baseline: Math.max(4, Math.round(norm.grid.baseline * canvasHeight || 8)),
  };

  const canvasBgLum = hexToLuminance(norm.background?.color || '#0A1628');
  const shapes: ShapeElement[] = norm.shapes.map((s) => {
    let resolvedColor = s.color;
    let strokeColor = s.strokeColor || undefined;
    // T6(c): Fix footer or venue band so it inherits the palette instead of defaulting to cream
    if (canvasBgLum < 0.2) {
      const sLum = hexToLuminance(s.color || '#000000');
      // If a panel on a dark background is cream/white (> 0.5 luminance)
      if ((s.role === 'panel' || s.y >= 0.6) && sLum > 0.5) {
        resolvedColor = '#162B48';
        if (!strokeColor) strokeColor = '#1E3A5F';
      }
    }
    return {
      x: scaleX(s.x),
      y: scaleY(s.y),
      width: scaleDimX(s.width),
      height: scaleDimY(s.height),
      kind: s.kind,
      color: resolvedColor,
      role: s.role,
      opacity: s.opacity !== null && s.opacity !== undefined ? Number(clamp(s.opacity).toFixed(2)) : undefined,
      radius: s.radius !== null && s.radius !== undefined ? Math.round(s.radius * canvasWidth) : undefined,
      strokeWidth:
        s.strokeWidth !== null && s.strokeWidth !== undefined
          ? Math.max(1, Math.round(s.strokeWidth * canvasWidth))
          : undefined,
      strokeColor,
    };
  });

  const minBodyPx = Math.ceil(0.016 * canvasWidth);
  const text: TextElement[] = norm.text.map((t) => {
    let minSize = 12;
    if (t.role === 'title') minSize = Math.max(32, Math.round(minBodyPx * 2.2));
    else if (t.role === 'subtitle') minSize = 20;
    else if (t.role === 'body') minSize = minBodyPx;
    else if (t.role === 'cta') minSize = 14;
    else if (t.role === 'footer') minSize = 12;

    const rawFontSize =
      t.fontSize <= 1
        ? Math.round(t.fontSize * canvasHeight)
        : Math.round(t.fontSize);
    const fontSizePx = Math.max(minSize, rawFontSize);
    const clampedLineHeight = Math.max(1.15, Math.min(1.85, Number(t.lineHeight.toFixed(2))));

    // Typography invariant enforcement
    let resolvedFont: string = t.fontFamily;
    if (t.rtl) {
      if (t.role === 'body' || t.role === 'footer') {
        resolvedFont = 'Noto Sans Arabic';
      } else if (resolvedFont !== 'Amiri' && resolvedFont !== 'Cairo') {
        // Amiri, not Cairo, is the display default for right-to-left copy: Cairo cannot draw the
        // Sorani letters ڕ ڵ ۆ ێ ە, and ە is among the most common characters in Kurdish.
        resolvedFont = 'Amiri';
      }
    } else {
      if (t.role === 'body' || t.role === 'footer') {
        resolvedFont = 'Verdana';
      } else {
        if (resolvedFont === 'Lora') {
          resolvedFont = 'Playfair Display';
        } else if (resolvedFont === 'Cormorant Garamond' || resolvedFont === 'Amiri' || resolvedFont === 'Noto Sans Arabic' || !resolvedFont) {
          resolvedFont = 'Cinzel';
        } else if (resolvedFont !== 'Cinzel' && resolvedFont !== 'Playfair Display') {
          resolvedFont = 'Cinzel';
        }
      }
    }

    // WCAG 2.1 AA Contrast Enforcement:
    // Determine underlying surface color (panel behind text or canvas background)
    let effectiveBg = norm.background?.color || '#0A1628';
    for (let i = norm.shapes.length - 1; i >= 0; i--) {
      const s = norm.shapes[i];
      if (s.role === 'panel' || s.kind === 'rect' || s.kind === 'roundRect') {
        const containsX = t.x >= s.x - 0.05 && (t.x + t.width) <= (s.x + s.width + 0.05);
        const containsY = t.y >= s.y - 0.05 && (t.y + t.height) <= (s.y + s.height + 0.05);
        if (containsX && containsY && s.color && s.color.startsWith('#')) {
          effectiveBg = s.color;
          break;
        }
      }
    }

    const bgLum = hexToLuminance(effectiveBg);
    const textLum = hexToLuminance(t.color);
    const contrast = calculateLuminanceContrastRatio(textLum, bgLum);
    const requiredContrast = fontSizePx >= 20 || (fontSizePx >= 16 && t.bold) ? 3.0 : 4.5;

    let resolvedColor = t.color;
    if (contrast < requiredContrast) {
      if (bgLum < 0.2) {
        // Dark background: Cream or Gold
        resolvedColor = (t.role === 'eyebrow' || t.role === 'date' || t.role === 'venue') ? '#C5A059' : '#FDF8F3';
      } else {
        // Light background: Deep Navy
        resolvedColor = '#0A1628';
      }
    }

    // T6(b): Restrain letterSpacing to em units [0, 0.06] and never multiply by canvasWidth!
    // Arabic script joins cursively, so any tracking pulls the joined letters apart and reads as
    // broken text. The model emitted 0.02 on the eyebrow of every Kurdish layout in the T5 run.
    const resolvedLetterSpacing = t.rtl
      ? 0
      : t.letterSpacing !== null && t.letterSpacing !== undefined
        ? t.role === 'eyebrow'
          ? Math.min(0.04, Math.max(0, t.letterSpacing > 1 ? t.letterSpacing / 100 : t.letterSpacing))
          : Math.min(0.06, Math.max(0, t.letterSpacing > 1 ? t.letterSpacing / 100 : t.letterSpacing))
        : undefined;

    return {
      copyIndex: t.copyIndex,
      role: t.role,
      x: scaleX(t.x),
      y: scaleY(t.y),
      width: scaleDimX(t.width),
      height: scaleDimY(t.height),
      fontSize: fontSizePx,
      lineHeight: clampedLineHeight,
      letterSpacing: resolvedLetterSpacing,
      fontFamily: resolvedFont,
      color: resolvedColor,
      align: t.align,
      bold: t.bold,
      italic: t.italic,
      rtl: t.rtl,
    };
  });

  const logo: Box = {
    x: scaleX(norm.logo.x),
    y: scaleY(norm.logo.y),
    width: scaleDimX(norm.logo.width),
    height: scaleDimY(norm.logo.height),
  };
  // Settle the logo at its real shape before the geometry pass below reads it.
  if (logoAspect) Object.assign(logo, fitLogoToAspect({ logo: { ...logo } }, logoAspect).logo);

  let art: ArtConfig | undefined = undefined;
  if (norm.art) {
    const boxNorm = norm.art.box || { x: 0, y: 0, width: 1, height: 1 };
    const calmNorm = norm.art.calmRegion || boxNorm;
    art = {
      source: norm.art.source,
      prompt: norm.art.prompt || undefined,
      motif: norm.art.motif || undefined,
      box: {
        x: scaleX(boxNorm.x),
        y: scaleY(boxNorm.y),
        width: scaleDimX(boxNorm.width),
        height: scaleDimY(boxNorm.height),
      },
      opacity: Number(clamp(norm.art.opacity ?? 0.5).toFixed(2)),
      calmRegion: {
        x: scaleX(calmNorm.x),
        y: scaleY(calmNorm.y),
        width: scaleDimX(calmNorm.width),
        height: scaleDimY(calmNorm.height),
      },
    };
  }

  normalizeLayoutGeometry({ shapes, text, height: canvasHeight, width: canvasWidth, grid: scaledGrid, logo });

  return {
    version: 2,
    width: canvasWidth,
    height: canvasHeight,
    genre: canvasWidth / canvasHeight >= 1.6 ? ('banner' as const) : ('poster' as const),
    grid: scaledGrid,
    background: { color: norm.background.color },
    art,
    shapes,
    text,
    logo,
    typeScale: norm.typeScale ? { base: norm.typeScale.base, ratio: norm.typeScale.ratio } : undefined,
  };
}

/**
 * Recentres a thin horizontal separator inside the vertical gap between the two text blocks it
 * divides. The model routinely leaves one lopsided — 38px below the block above and 84px above the
 * block below — and the T5 re-critique raised that asymmetry nine times across eighteen designs.
 *
 * Deliberately narrow: only thin, horizontally-oriented rules and accents that sit clear of every
 * text block and horizontally overlap the blocks on both sides. Panels, frames, vertical accent
 * bars and anything a text block overlaps are left exactly where the model put them, because for
 * those the offset is usually the intent.
 */
export interface SeparatorGap {
  shapeIndex: number;
  /** Clear space between the block above and the separator. */
  padTop: number;
  /** Clear space between the separator and the block below. */
  padBottom: number;
  /** Where the separator would sit if it were centred in the gap. */
  centredY: number;
  /** |padTop - padBottom| as a fraction of the gap; 0 is perfectly centred. */
  skew: number;
}

/** A separator within this distance of a solid shape's edge is treated as attached to it. */
const EDGE_ATTACH_TOLERANCE_PX = 2;

/**
 * A shape acting as a divider mark between blocks. Size is not part of the test: a 22x22 ellipse
 * accent divides a subtitle from a body exactly as a hairline rule does, and requiring thinness
 * skipped it. Whether it is small enough to be a mark rather than a block is decided against the
 * gap it sits in, in findSeparatorGaps.
 */
const isSeparatorCandidate = (s: ShapeElement): boolean =>
  s.width > 0 &&
  s.height > 0 &&
  (s.kind === 'line' || s.role === 'rule' || s.role === 'accent');

/** A divider mark should be a small fraction of the gap it divides, not a block filling it. */
const MAX_SEPARATOR_SHARE_OF_GAP = 1 / 3;

/**
 * Finds every thin horizontal separator that sits clear inside a vertical gap, and reports how
 * lopsided it is. Read-only counterpart to `centerSeparatorsInGaps`.
 *
 * Boundaries are text blocks *and* solid shapes such as panels and frames, because a reader reads
 * the edge of a panel as the edge of the content. Centring only against text put a footer rule
 * 37px below a panel and 69px above the footer text — dead centre between the two text blocks and
 * visibly lopsided, which the vision critique kept raising. A shape that vertically contains the
 * separator is a container, not a boundary, so a rule dividing two blocks inside a panel still
 * centres against those blocks.
 */
export function findSeparatorGaps(shapes: ShapeElement[], text: TextElement[]): SeparatorGap[] {
  const out: SeparatorGap[] = [];
  if (text.length < 2 || shapes.length === 0) return out;

  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    if (!isSeparatorCandidate(s)) continue;

    const sTop = s.y;
    const sBottom = s.y + s.height;
    const overlapsHorizontally = (b: { left: number; right: number }) =>
      s.x < b.right && s.x + s.width > b.left;

    const solids = shapes
      .filter((o, j) => j !== i && !isSeparatorCandidate(o))
      .map((o) => ({ top: o.y, bottom: o.y + o.height, left: o.x, right: o.x + o.width }));

    // A separator flush with a panel's edge is that panel's own rule, placed there on purpose.
    // Every one of the seven residual cases in the T5 set was a panel top rule sitting at exactly
    // 0px from its panel, and centring them pulled each one off its panel. They are left alone.
    const attachedToSolidEdge = solids.some(
      (o) =>
        overlapsHorizontally(o) &&
        (Math.abs(sTop - o.top) <= EDGE_ATTACH_TOLERANCE_PX ||
          Math.abs(sBottom - o.top) <= EDGE_ATTACH_TOLERANCE_PX ||
          Math.abs(sTop - o.bottom) <= EDGE_ATTACH_TOLERANCE_PX ||
          Math.abs(sBottom - o.bottom) <= EDGE_ATTACH_TOLERANCE_PX)
    );
    if (attachedToSolidEdge) continue;

    const boundaries = [
      ...text.map((t) => ({ top: t.y, bottom: t.y + t.height, left: t.x, right: t.x + t.width })),
      ...solids,
    ];

    let above = -Infinity;
    let below = Infinity;
    let straddled = false;
    for (const b of boundaries) {
      if (b.top <= sTop && b.bottom >= sBottom) continue; // container, not a boundary
      if (b.bottom <= sTop) {
        if (overlapsHorizontally(b)) above = Math.max(above, b.bottom);
      } else if (b.top >= sBottom) {
        if (overlapsHorizontally(b)) below = Math.min(below, b.top);
      } else {
        straddled = true;
        break;
      }
    }
    if (straddled || above === -Infinity || below === Infinity) continue;

    const gap = below - above;
    if (gap <= s.height || s.height > gap * MAX_SEPARATOR_SHARE_OF_GAP) continue;

    const padTop = sTop - above;
    const padBottom = below - sBottom;
    const span = padTop + padBottom;
    out.push({
      shapeIndex: i,
      padTop,
      padBottom,
      centredY: Math.round(above + (gap - s.height) / 2),
      skew: span > 0 ? Math.abs(padTop - padBottom) / span : 0,
    });
  }
  return out;
}

export function centerSeparatorsInGaps(shapes: ShapeElement[], text: TextElement[]): number {
  let moved = 0;
  for (const g of findSeparatorGaps(shapes, text)) {
    const s = shapes[g.shapeIndex];
    if (g.centredY !== s.y) {
      s.y = g.centredY;
      moved++;
    }
  }
  return moved;
}

/** A block whose width is within this much of the shared measure counts as the same measure. */
const MEASURE_MATCH_TOLERANCE_SHARE = 0.02;
/** A span needs this many text blocks on it before it counts as the layout's shared measure. */
const MEASURE_CONSENSUS_MIN = 3;

/**
 * Translates a text block back onto the span the rest of the layout shares, when that block has
 * drifted rather than been given a measure of its own.
 *
 * The distinction is width, not distance. Across the eighteen T5 layouts, 22 text blocks sit off
 * the shared span; 21 of them are 43px to 173px narrower or wider — nested bodies, full-bleed
 * eyebrows, deliberate secondary measures — and the vision critique accepted every one. The
 * twenty-second was a footer at 103..913 against its four neighbours' 130..951: the same width to
 * within 11px, simply 27px out of position. That is the one the critique raised, and the only
 * shape of defect this corrects. Distance thresholds cannot separate the two cases, because the
 * drifted footer and the deliberate insets deviate by the same 27-38px.
 */
/** Fallback order per script, most preferred first. Every entry is an admitted family. */
const RTL_FONT_PREFERENCES = ['Amiri', 'Cairo', 'Noto Sans Arabic'];
const LATIN_FONT_PREFERENCES = ['Cinzel', 'Playfair Display', 'Verdana'];

/**
 * Replaces any font that cannot draw the copy assigned to it with one that can.
 *
 * The generator picks a family from a role and a script without seeing the characters, so it
 * cannot know that Cairo is missing five Sorani letters. This runs where the copy is known and
 * keeps the generator's choice whenever that choice actually works.
 */
const ARABIC_SCRIPT_RANGE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_SCRIPT_RANGE = /[A-Za-z\u00C0-\u024F]/;

/**
 * The characters of the block's own script. A Kurdish footer that ends in "kaae.gov.krd" is
 * legitimately set with script fallback for the Latin run, and an Arabic face not covering Latin
 * is normal typography rather than a defect. What is not normal is a face failing on the script it
 * was chosen for, because then a single word renders in two typefaces.
 */
function charactersOfOwnScript(text: string, rtl: boolean): string {
  const range = rtl ? ARABIC_SCRIPT_RANGE : LATIN_SCRIPT_RANGE;
  return Array.from(text)
    .filter((ch) => range.test(ch))
    .join('');
}

export function correctFontsThatCannotDrawTheCopy(
  layout: StudioLayoutV2,
  copyText: Record<number, string>
): number {
  let corrected = 0;
  for (const t of layout.text) {
    const copy = copyText[t.copyIndex];
    if (!copy) continue;
    const ownScript = charactersOfOwnScript(copy, !!t.rtl);
    if (!ownScript) continue;

    const opts = { bold: t.bold, italic: t.italic };
    if (fontCoversText(t.fontFamily, ownScript, opts).covers) continue;

    const preferences = t.rtl ? RTL_FONT_PREFERENCES : LATIN_FONT_PREFERENCES;
    const ordered = [t.fontFamily, ...preferences.filter((f) => f !== t.fontFamily)];
    const replacement = pickFontCovering(ordered, ownScript, opts);
    if (replacement !== t.fontFamily) {
      t.fontFamily = replacement;
      corrected++;
    }
  }
  return corrected;
}

/** Below this share of canvas height, a top/bottom margin difference is not worth moving for. */
const MARGIN_IMBALANCE_MIN_SHARE = 0.02;
/** A shape this close to covering the canvas is a background, not composed content. */
const FULL_BLEED_SHARE = 0.98;

/**
 * Shifts the whole composition so the space above it and below it match, when they differ enough
 * to read as the design sitting high or low on the canvas.
 *
 * The generator places content from the top margin down and lets the remainder fall at the bottom,
 * which left 157px under one footer against 76px above its eyebrow. The shift never takes the top
 * element above the grid margin, so the margin stays a floor rather than an exact position, and
 * full-bleed background shapes are neither measured nor moved because they have no margin.
 */
export function balanceCanvasMargins(
  layout: Pick<StudioLayoutV2, 'height' | 'width' | 'grid' | 'text' | 'shapes'> & {
    logo?: StudioLayoutV2['logo'];
  },
  opts: { minImbalanceShare?: number } = {}
): number {
  const minShare = opts.minImbalanceShare ?? MARGIN_IMBALANCE_MIN_SHARE;

  const composed = layout.shapes.filter(
    (sh) => !(sh.height >= layout.height * FULL_BLEED_SHARE && sh.width >= layout.width * FULL_BLEED_SHARE)
  );
  const boxes: Array<{ y: number; height: number }> = [
    ...layout.text,
    ...composed,
    ...(layout.logo ? [layout.logo] : []),
  ];
  if (boxes.length === 0) return 0;

  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = layout.height - Math.max(...boxes.map((b) => b.y + b.height));
  const imbalance = bottom - top;
  if (Math.abs(imbalance) < layout.height * minShare) return 0;

  let shift = Math.round(imbalance / 2);
  if (top + shift < layout.grid.margin) shift = layout.grid.margin - top;
  if (shift === 0) return 0;

  for (const b of boxes) b.y += shift;
  return 1;
}

/**
 * There is deliberately no frame-internal balancing pass.
 *
 * The critique raised two designs whose content sat unevenly inside a large frame, and balancing it
 * against the frame is the obvious analogue of balanceCanvasMargins one reference level in. It was
 * written and measured: it fires on 1 of the 20 production layouts, drops that layout's composite
 * from 0.968 to 0.964, and the render is worse — the composition sits high with a dead band along
 * the bottom. With no evidence of benefit on the single case it touches, it is not worth the risk
 * of a pass that moves whole compositions.
 */

/**
 * Runs the geometry normalisations in dependency order and is safe to run again: each pass is
 * idempotent, and a later pass needs the earlier ones to have settled. Drifted blocks move first
 * because their position defines the panels and gaps; a text block centred in its panel then
 * changes the gaps a separator divides, so separators go last.
 */
export function normalizeLayoutGeometry(
  layout: {
    shapes: ShapeElement[];
    text: TextElement[];
  } & Partial<Pick<StudioLayoutV2, 'height' | 'width' | 'grid' | 'logo'>>
): { drifted: number; textCentred: number; separators: number; marginBalanced: number } {
  const drifted = snapDriftedTextBlocks(layout.text);
  const textCentred = centerLoneTextInPanels(layout.shapes, layout.text);
  const separators = centerSeparatorsInGaps(layout.shapes, layout.text);
  // Balancing shifts the whole composition, so it runs last: it preserves every interval the
  // passes above have just settled.
  const marginBalanced =
    layout.height && layout.width && layout.grid
      ? balanceCanvasMargins(
          layout as Pick<StudioLayoutV2, 'height' | 'width' | 'grid' | 'text' | 'shapes'> & {
            logo?: StudioLayoutV2['logo'];
          }
        )
      : 0;
  return { drifted, textCentred, separators, marginBalanced };
}

export function snapDriftedTextBlocks(text: TextElement[]): number {
  if (text.length < MEASURE_CONSENSUS_MIN + 1) return 0;

  const spans = new Map<string, { left: number; right: number; count: number }>();
  for (const t of text) {
    const key = `${t.x}:${t.x + t.width}`;
    const seen = spans.get(key);
    if (seen) seen.count++;
    else spans.set(key, { left: t.x, right: t.x + t.width, count: 1 });
  }

  let measure: { left: number; right: number; count: number } | null = null;
  for (const span of spans.values()) {
    if (!measure || span.count > measure.count) measure = span;
  }
  if (!measure || measure.count < MEASURE_CONSENSUS_MIN) return 0;

  const measureWidth = measure.right - measure.left;
  const tolerance = Math.max(12, measureWidth * MEASURE_MATCH_TOLERANCE_SHARE);

  let moved = 0;
  for (const t of text) {
    if (t.x === measure.left && t.x + t.width === measure.right) continue;
    if (Math.abs(t.width - measureWidth) > tolerance) continue; // its own measure, left alone
    t.x = measure.left;
    t.width = measureWidth;
    moved++;
  }
  return moved;
}

/**
 * Centres a text block vertically inside the panel that contains it, when that panel holds exactly
 * one block. The generator routinely leaves the block low or high in its panel — "96px above and
 * 77px below", "65px above and 54px below" — which the T5 re-critique raised five times over
 * eighteen designs, and which no deterministic metric registers.
 *
 * Only a panel with exactly one text block inside it is touched. A panel holding several blocks is
 * left alone, because redistributing a stack is a composition decision rather than a centring one,
 * and the move is skipped if it would push the block onto another shape inside the same panel.
 */
export function centerLoneTextInPanels(shapes: ShapeElement[], text: TextElement[]): number {
  let moved = 0;
  for (const panel of shapes) {
    if (isSeparatorCandidate(panel) || panel.width <= 0 || panel.height <= 0) continue;

    const panelTop = panel.y;
    const panelBottom = panel.y + panel.height;
    const inside = text.filter(
      (t) =>
        t.y >= panelTop &&
        t.y + t.height <= panelBottom &&
        t.x >= panel.x &&
        t.x + t.width <= panel.x + panel.width
    );
    if (inside.length !== 1) continue;

    const t = inside[0];
    const target = Math.round(panelTop + (panel.height - t.height) / 2);
    if (target === t.y || target < panelTop) continue;

    // Anything else sitting inside this panel that the block must not land on.
    const obstacles = shapes.filter(
      (o) => o !== panel && o.y + o.height > panelTop && o.y < panelBottom
    );
    const collides = obstacles.some(
      (o) =>
        target < o.y + o.height &&
        target + t.height > o.y &&
        t.x < o.x + o.width &&
        t.x + t.width > o.x
    );
    if (collides) continue;

    t.y = target;
    moved++;
  }
  return moved;
}

/**
 * Separators a reader would see as lopsided. Thresholds are relative and absolute together, so a
 * few pixels in a tight gap is not a defect while 38px above against 84px below is.
 *
 * None of the thirteen deterministic design metrics responds to separator position: recentring all
 * 31 separators across the eighteen T5 layouts moved every metric by exactly 0.0000, which is why
 * the model kept emitting lopsided rules while the free gate scored them at 0.95. The generator
 * now centres them unconditionally; this detector is the gate that catches a layout which reaches
 * QA without having gone through that normalisation.
 */
export function findAsymmetricSeparators(
  shapes: ShapeElement[],
  text: TextElement[],
  opts: { minSkew?: number; minPixels?: number } = {}
): SeparatorGap[] {
  const minSkew = opts.minSkew ?? 0.25;
  const minPixels = opts.minPixels ?? 8;
  return findSeparatorGaps(shapes, text).filter(
    (g) => g.skew >= minSkew && Math.abs(g.padTop - g.padBottom) >= minPixels
  );
}

/**
 * Strict JSON Schema without $defs for OpenAI Structured Outputs.
 */
export const LAYOUT_V3_JSON_SCHEMA = {
  type: 'object',
  properties: {
    layouts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          conceptTitle: { type: 'string' },
          compositionArchetype: {
            type: 'string',
            enum: [
              'monolith_centered',
              'asymmetric_editorial',
              'hero_statement_grid',
              'split_statutory_banner',
              'minimal_framed',
              'stat_card_triptych',
              'numbered_standards_stack',
              'executive_roadmap_quad',
              'crest_banner_split',
              'credential_badge_card',
              'chevron_band_institutional',
              'monograph_bilateral_column',
              'academic_citation_folio',
              'commencement_diploma_frame',
            ],
          },
          typeScale: {
            type: 'object',
            properties: {
              base: { type: 'number' },
              ratio: { type: 'number' },
            },
            required: ['base', 'ratio'],
            additionalProperties: false,
          },
          grid: {
            type: 'object',
            properties: {
              margin: { type: 'number' },
              columns: { type: 'integer', enum: [6, 12] },
              gutter: { type: 'number' },
              baseline: { type: 'number' },
            },
            required: ['margin', 'columns', 'gutter', 'baseline'],
            additionalProperties: false,
          },
          background: {
            type: 'object',
            properties: {
              color: { type: 'string' },
            },
            required: ['color'],
            additionalProperties: false,
          },
          logo: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          art: {
            type: ['object', 'null'],
            properties: {
              source: { type: 'string', enum: ['generated', 'procedural'] },
              prompt: { type: ['string', 'null'] },
              motif: {
                type: ['string', 'null'],
                enum: ['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash', null],
              },
              box: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
                required: ['x', 'y', 'width', 'height'],
                additionalProperties: false,
              },
              opacity: { type: 'number' },
              calmRegion: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
                required: ['x', 'y', 'width', 'height'],
                additionalProperties: false,
              },
            },
            required: ['source', 'prompt', 'motif', 'box', 'opacity', 'calmRegion'],
            additionalProperties: false,
          },
          shapes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                kind: { type: 'string', enum: ['rect', 'roundRect', 'ellipse', 'line'] },
                color: { type: 'string' },
                opacity: { type: ['number', 'null'] },
                radius: { type: ['number', 'null'] },
                strokeWidth: { type: ['number', 'null'] },
                strokeColor: { type: ['string', 'null'] },
                role: { type: 'string', enum: ['rule', 'panel', 'accent', 'frame'] },
              },
              required: [
                'x',
                'y',
                'width',
                'height',
                'kind',
                'color',
                'opacity',
                'radius',
                'strokeWidth',
                'strokeColor',
                'role',
              ],
              additionalProperties: false,
            },
          },
          text: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                copyIndex: { type: 'integer' },
                role: {
                  type: 'string',
                  enum: ['eyebrow', 'title', 'subtitle', 'body', 'date', 'venue', 'cta', 'footer', 'other'],
                },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                fontSize: { type: 'number' },
                lineHeight: { type: 'number' },
                letterSpacing: { type: ['number', 'null'] },
                fontFamily: {
                  type: 'string',
                  enum: [
                    'Cinzel',
                    'Lora',
                    'Cairo',
                    'Playfair Display',
                    'Cormorant Garamond',
                    'Amiri',
                    'Verdana',
                    'Noto Sans Arabic',
                  ],
                },
                color: { type: 'string' },
                align: { type: 'string', enum: ['left', 'center', 'right'] },
                bold: { type: 'boolean' },
                italic: { type: 'boolean' },
                rtl: { type: 'boolean' },
              },
              required: [
                'copyIndex',
                'role',
                'x',
                'y',
                'width',
                'height',
                'fontSize',
                'lineHeight',
                'letterSpacing',
                'fontFamily',
                'color',
                'align',
                'bold',
                'italic',
                'rtl',
              ],
              additionalProperties: false,
            },
          },
        },
        required: [
          'id',
          'conceptTitle',
          'compositionArchetype',
          'typeScale',
          'grid',
          'background',
          'logo',
          'art',
          'shapes',
          'text',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['layouts'],
  additionalProperties: false,
};

export interface GenerateLayoutCandidatesOptions {
  client: OpenAiStudioClient;
  brief: string;
  copyBlocks: CopyBlockSlotInput[];
  palette: string[];
  canvasWidth?: number;
  canvasHeight?: number;
  exemplars?: ExemplarRetrievalMatch[];
  isRtl?: boolean;
  /** Override the model for this call. Defaults to the active tier's layout model. */
  model?: string;
  /** The official logo's width over height; the model is told it and the box is fitted to it. */
  logoAspect?: number;
}

export interface GenerateLayoutCandidatesResult {
  layouts: StudioLayoutV2[];
  rawCandidates: NormalizedLayoutCandidate[];
  responseId: string;
  xRequestId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  /** The object checkCandidateSetDegeneracy returns: its field is pairwiseDistances. */
  degeneracyCheck: CandidateSetDegeneracyResult;
}

/**
 * Builds the byte-stable system prompt (> 1024 tokens for OpenAI prefix caching).
 */
export function buildLayoutV3SystemPrompt(): string {
  return `You are the Senior Typographer and Creative Director for KAAE (Kurdistan Accrediting Agency for Education).
Your mandate is to generate THREE deliberately distinct, research-grade institutional layout candidates as structured JSON.
You operate under strict mathematical, spatial, and typographic design rules established in top-tier graphic design and computational aesthetic research (arXiv:2402.06945, PosterLLaVa arXiv:2406.02884, PosterMELD arXiv:2608.02218, LaySPA).

================================================================================
1. CORE ARCHITECTURAL INVARIANTS
================================================================================
- Coordinate System: Output all spatial coordinates (x, y, width, height, margins, gutters) strictly NORMALIZED in [0.0, 1.0].
  Coordinates are scaled to target pixel dimensions server-side.
- Deliberate Diversity: Return exactly THREE distinct layouts. No two candidates may share the same structural geometry, alignment axis, or component distribution.
  Assign each candidate to a different Composition Archetype:
  1) monolith_centered: Formal, symmetrical, centered authoritative institutional hierarchy with central spine.
  2) asymmetric_editorial: Dynamic left-aligned (or right-aligned for RTL) editorial with strong vertical rule or offset weight.
  3) hero_statement_grid: High-impact title block framed by grounded card or lower structured panel.
  4) split_statutory_banner: Distinct top header banner zone with structured statutory details below.
  5) minimal_framed: Generous breathing margins with refined architectural hairline framing.
- Pairwise Geometric Distance: The spatial distance between any two candidates must exceed 15px when scaled (do NOT return twin or near-identical layouts).
- Anti-Twin-Card Invariant: NEVER generate side-by-side bilateral symmetric cards (two cards side-by-side with identical width and height in the body) unless the brief explicitly commands a 2-item comparison. Such layouts violate institutional dignity.
- Live Copy Only: Layouts are purely spatial and typographic containers. Every text element references an exact copyIndex. Never invent copy or omit copy blocks.

================================================================================
2. F12 TYPOGRAPHY & ROLE POLICY (NORMATIVE)
================================================================================
Strict font family adherence is required. You may ONLY use the following admitted families:
- Body & Footer Roles (role: "body", "footer"):
  * For Latin text: MUST use "Verdana".
  * For Kurdish / Arabic text: MUST use "Noto Sans Arabic".
  * NEVER use display fonts for body or footer copy.
- Display & Headline Roles (role: "title", "subtitle", "eyebrow", "cta"):
  * For Latin text: "Cinzel", "Lora", "Playfair Display", "Cormorant Garamond".
  * For Kurdish / Arabic text: "Cairo", "Amiri".
- NEVER use unadmitted fonts (such as Arimo, Arial, Times New Roman, Roboto, or generic sans-serif).
- Type-Scale: Each layout declares its base font size in pixels (e.g., 14 to 18) and typographic ratio (e.g., 1.25 Major Third, 1.333 Perfect Fourth, 1.414 Augmented Fourth, or 1.5 Perfect Fifth).
  All font sizes must adhere to the declared modular scale.
- Line Heights:
  * Titles: 1.20 to 1.35.
  * Subtitles: 1.30 to 1.45.
  * Body text: 1.40 to 1.60 (sufficient leading for readability).
  * Footers: 1.30 to 1.45.
- MINIMUM FONT SIZE CONSTRAINTS (HARD QA REQUIREMENTS):
  * Absolute minimum font size for ANY text element is 12px (normalized: >= 12 / canvasHeight).
  * Body copy (role: "body") MUST have fontSize >= 1.6% of canvas width (e.g. >= 18px on 1080px width canvas; normalized: >= (0.016 * canvasWidth) / canvasHeight).
  * Title copy (role: "title") MUST have fontSize >= 2.2x body copy fontSize (e.g. >= 40px on 1080px width canvas).
  * Subtitle copy (role: "subtitle") MUST have fontSize >= 20px.
  * Any font size below 12px or body text below 1.6% width (such as 9px body) will be REJECTED by Hard QA with defect code MIN_SIZE / UNREADABLE_FONT_SIZE. Layouts are never silently rewritten.

================================================================================
3. SPATIAL GRID, MARGINS & WCAG 2.1 AA LEGIBILITY
================================================================================
- Margins: The outer canvas margins must be >= 0.05 (normalized), ensuring all text, logos, and critical content remain comfortably inside the safe area.
- Logo Placement: Place the logo in a prominent header or anchor position (e.g., top-center or top-left for Latin, top-center or top-right for RTL).
  Ensure the logo box has dignified proportions and does not collide with title text.
- Text Legibility & Contrast:
  * Light text on dark background (e.g., Cream #FDF8F3 or Gold #C5A059 on Navy #0A1628 / #0C2340): contrast ratio MUST exceed 4.5:1.
  * Dark text on light background (e.g., Navy on Cream panel): contrast ratio MUST exceed 4.5:1.
  * NEVER place low-contrast text (e.g., dark blue on dark blue, or pale gray on cream).
- Eyebrows & Tracking:
  * Eyebrows (role: "eyebrow") must fit cleanly on a SINGLE line. NEVER allow an eyebrow to wrap onto multiple lines.
  * Use restrained tracking (0.02 to 0.04em).
- Footer and Venue Bands:
  * If the canvas background is dark, NEVER place a solid cream (#FDF8F3) or white rectangle across the footer or venue area.
  * Footer and venue bands on dark canvases MUST harmonize with the palette: use a deep tone (#162B48, #1E3A5F), a subtle border/rule (#C5A059), or a translucent container. An unstyled stark cream block on a dark poster is strictly rejected.
- Vertical Rhythm & Negative Space:
  * Negative space fraction must stay in the optimal band (0.35 to 0.58 of canvas area, matching confirmed exemplars).
  * Avoid excessive dead voids (no single uncomposed vertical void > 0.20 of canvas height). Never leave 40% of the canvas empty.
  * Group related elements (title + subtitle, body paragraphs, statutory footer) with intentional proximity.

================================================================================
4. RTL (SORANI KURDISH) RULES
================================================================================
When generating layouts for Kurdish or Arabic copy:
- Set rtl: true on all Arabic/Kurdish text elements.
- Set letterSpacing to 0 on every Arabic/Kurdish element. Arabic script joins cursively, so any
  tracking separates joined letters and reads as broken text to a native reader.
- Alignment must be "right" or "center" (NEVER left-aligned for Arabic script).
- Font family must be "Cairo" or "Amiri" for titles, and "Noto Sans Arabic" for body and footer.

================================================================================
5. ART LAYER & CALM REGION SPECIFICATION
================================================================================
If a layout candidate requests an art layer (art.source = "generated" or "procedural"):
- You MUST declare a calmRegion box in normalized coordinates.
- The calmRegion defines the canvas area occupied by headline and body text.
- The calmRegion MUST stay dark, low-frequency, and low-contrast so that foreground text renders with pristine legibility.
- Background art opacity must be moderate (0.15 to 0.40) to prevent text occlusion.

Adhere strictly to this specification and produce three publication-ready layouts.`;
}

/**
 * Builds the user prompt detailing constraints, palette, copy blocks, capacity slots, and exemplars.
 */
/**
 * The canvas proportion in words. The prompt used to call every non-square canvas 4:5 — a
 * 1920x1080 banner was described to the model as 4:5 beside its own pixel dimensions.
 */
export function aspectRatioLabel(width: number, height: number): string {
  const r = width / height;
  const known: Array<[number, string]> = [
    [1, '1:1'], [0.8, '4:5'], [9 / 16, '9:16'], [16 / 9, '16:9'], [Math.SQRT1_2, 'A4 portrait, 1:1.414'], [Math.SQRT2, 'A4 landscape, 1.414:1'],
  ];
  for (const [ratio, label] of known) if (Math.abs(r - ratio) / ratio < 0.02) return label;
  return `${r.toFixed(3)}:1`;
}

export function buildLayoutV3UserPrompt(options: {
  brief: string;
  copyBlocks: CopyBlockSlotInput[];
  palette: string[];
  canvasWidth: number;
  canvasHeight: number;
  exemplars?: ExemplarRetrievalMatch[];
  isRtl?: boolean;
  logoAspect?: number;
}): string {
  const { brief, copyBlocks, palette, canvasWidth, canvasHeight, exemplars, isRtl, logoAspect } = options;

  const capacitySlots = copyBlocks.map((b) => computeCapacitySlot(b, canvasWidth, canvasHeight));

  const slotsFormatted = capacitySlots
    .map(
      (s) => `- Block ${s.copyIndex} [role: "${s.role}", script: "${s.script}"]:
    Text: "${copyBlocks[s.copyIndex].text.substring(0, 80)}${copyBlocks[s.copyIndex].text.length > 80 ? '...' : ''}"
    Char Count: ${s.charCount} chars | Target Capacity: ${s.targetCapacityMin}–${s.targetCapacityMax} chars
    Recommended Normalized Width: [${s.recommendedNormWidth[0]}, ${s.recommendedNormWidth[1]}]
    Recommended Normalized Height: [${s.recommendedNormHeight[0]}, ${s.recommendedNormHeight[1]}]
    Recommended Normalized FontSize: [${s.recommendedNormFontSize[0]}, ${s.recommendedNormFontSize[1]}]`
    )
    .join('\n');

  const exemplarsFormatted =
    exemplars && exemplars.length > 0
      ? exemplars
          .map((ex, i) => {
            const shortDesc = ex.descriptor.length > 140 ? ex.descriptor.substring(0, 140) + '...' : ex.descriptor;
            return `${i + 1}. [${ex.filename}] (${ex.format}): ${shortDesc}`;
          })
          .join('\n')
      : 'None provided. Use institutional KAAE standards.';

  return `CREATIVE BRIEF:
"${brief}"

CANVAS DIMENSIONS & SPECIFICATIONS:
- Target Dimensions: ${canvasWidth}px x ${canvasHeight}px (Aspect Ratio: ${aspectRatioLabel(canvasWidth, canvasHeight)})
- Official Logo: width:height = ${(logoAspect || 1).toFixed(2)}${Math.abs((logoAspect || 1) - 1) < 0.02 ? ' (a square emblem)' : ''}. Reserve its box at exactly this proportion.
- Primary Palette: ${palette.join(', ')}
- Language Direction: ${isRtl ? 'RTL (Sorani Kurdish / Arabic)' : 'LTR (Latin / English)'}

OWNER-CONFIRMED REFERENCE EXEMPLARS (Inspiration for layout architecture and negative space distribution):
${exemplarsFormatted}

CAPACITY-AWARE COPY SLOTS (PosterMELD 2608.02218):
Fit the copy before rendering. Sizing each text box and font size must satisfy character capacity:
${slotsFormatted}

TASK:
Generate exactly THREE deliberately distinct normalized layout candidates as JSON.
Choose 3 distinct composition archetypes tailored to the brief from the 14 institutional archetypes:
- monolith_centered, asymmetric_editorial, hero_statement_grid, split_statutory_banner, minimal_framed,
- stat_card_triptych, numbered_standards_stack, executive_roadmap_quad, crest_banner_split,
- credential_badge_card, chevron_band_institutional, monograph_bilateral_column, academic_citation_folio, commencement_diploma_frame.
Ensure wide architectural diversity: vary alignment axes (centered vs asymmetric), column structures (6 vs 12 columns), and content grouping across candidates.

CRITICAL CONSTRAINTS:
1. No two candidates may have identical or near-identical geometry (geometric distance > 15px).
2. NO side-by-side bilateral symmetric twin cards.
3. Use ONLY admitted fonts: Verdana (Latin) or Noto Sans Arabic (Sorani) for body/footer; Cinzel or Playfair Display for Latin titles; Amiri for Sorani titles (Cairo cannot draw the Sorani letters ڕ ڵ ۆ ێ ە).
4. All coordinates strictly in [0.0, 1.0].
5. Declare typeScale (base and ratio) for each candidate.
6. Declare calmRegion if an art layer is requested.
7. MINIMUM FONT SIZES (STRICT ENFORCEMENT):
   - Absolute minimum font size for ANY text: 12px (normalized: ${(12 / canvasHeight).toFixed(4)}).
   - Body copy (role: "body") minimum font size: ${Math.ceil(0.016 * canvasWidth)}px (1.6% of canvas width ${canvasWidth}px; normalized: ${(Math.ceil(0.016 * canvasWidth) / canvasHeight).toFixed(4)}).
   - Title copy (role: "title") minimum font size: ${Math.max(36, Math.round(Math.ceil(0.016 * canvasWidth) * 2.2))}px (>= 2.2x body font size).
   - NEVER generate font sizes below these minimums (e.g. 9px body text is strictly rejected by QA).`;
}

/**
 * Generates three layout candidates in a single gpt-6-astra call with strict JSON schema.
 */
export async function generateLayoutCandidatesV3(
  options: GenerateLayoutCandidatesOptions
): Promise<GenerateLayoutCandidatesResult> {
  const canvasWidth = options.canvasWidth || 1080;
  const canvasHeight = options.canvasHeight || 1350;

  const systemPrompt = buildLayoutV3SystemPrompt();
  const userPrompt = buildLayoutV3UserPrompt({
    brief: options.brief,
    copyBlocks: options.copyBlocks,
    palette: options.palette,
    canvasWidth,
    canvasHeight,
    exemplars: options.exemplars,
    isRtl: options.isRtl,
    logoAspect: options.logoAspect,
  });

  const response: OpenAiStructuredResponse<{ layouts: NormalizedLayoutCandidate[] }> =
    await options.client.createStructuredCompletion({
      model: options.model || resolveModel('layout'),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      jsonSchema: {
        name: 'layout_v3_candidates',
        schema: LAYOUT_V3_JSON_SCHEMA,
        strict: true,
      },
      maxTokens: 16000,
      // gpt-4.1-mini and gpt-4o-mini reject reasoning_effort with a 400, so it is sent only to a
      // model that accepts it rather than assumed.
      ...(modelSupportsReasoningEffort(options.model || resolveModel('layout'))
        ? { reasoningEffort: 'low' as const }
        : {}),
      timeoutMs: 240000,
    });

  const rawCandidates = response.data.layouts;
  if (!rawCandidates || rawCandidates.length < 3) {
    throw new Error(`Expected at least 3 layout candidates, received ${rawCandidates?.length || 0}`);
  }

  // Scale candidates server-side. Deliberately no box-to-content fitting here: shrinking a text
  // box around its centre leaves the ink exactly where it was, so it changes no visible pixel of
  // the design (measured: ~6k of 1.17M pixels differ, purely 1px rounding of the baseline), while
  // dropping the exemplar-calibrated negativeSpace metric from 0.95 to 0.27. The critique
  // complaints it would have answered — "a shallow line within a 130px-high box" — are readings of
  // the Set-of-Mark annotation drawn for the critique, not of anything the design shows.
  const copyByIndex: Record<number, string> = {};
  for (const b of options.copyBlocks) copyByIndex[b.index] = b.text;

  const scaledLayouts: StudioLayoutV2[] = rawCandidates.map((c) => {
    const layout = scaleNormalizedLayoutToV2(c, canvasWidth, canvasHeight, options.logoAspect);
    correctFontsThatCannotDrawTheCopy(layout, copyByIndex);
    return layout;
  });

  // Validate each layout against studioLayoutV2Schema. A candidate that fails is dropped rather
  // than aborting the brief: the point of generating several is that they are independent, and one
  // malformed candidate out of three is a reason to use the other two, not to lose the request.
  const invalidCandidates: string[] = [];
  const validIndices: number[] = [];
  for (let i = 0; i < scaledLayouts.length; i++) {
    const layout = scaledLayouts[i];
    const parseResult = studioLayoutV2Schema.safeParse(layout);
    if (!parseResult.success) {
      invalidCandidates.push(`candidate ${i + 1}: ${parseResult.error.message.slice(0, 200)}`);
      continue;
    }
    validIndices.push(i);

    // Check twin-card failure mode
    if (hasTwinCardBlock(layout)) {
      console.warn(`[LayoutGeneratorV3] Warning: Candidate ${i + 1} contains twin-card block`);
    }

    // Check capacity
    const capCheck = verifySlotCapacity(layout, options.copyBlocks);
    if (!capCheck.ok) {
      console.warn(`[LayoutGeneratorV3] Warning: Candidate ${i + 1} capacity warnings:`, capCheck.overflowIssues);
    }
  }

  if (invalidCandidates.length) {
    console.warn(
      `[LayoutGeneratorV3] Dropped ${invalidCandidates.length} of ${scaledLayouts.length} candidates ` +
        `that failed StudioLayoutV2 schema: ${invalidCandidates.join(' | ')}`
    );
  }
  const validLayouts = validIndices.map((i) => scaledLayouts[i]);
  const validRaw = validIndices.map((i) => rawCandidates[i]);
  if (validLayouts.length < 2) {
    throw new Error(
      `Only ${validLayouts.length} of ${scaledLayouts.length} layout candidates passed ` +
        `StudioLayoutV2 schema, which is too few to choose between. ${invalidCandidates.join(' | ')}`
    );
  }

  // Degeneracy check across the surviving layouts. Its result used to be returned and never read
  // by any caller — the check ran and its answer was discarded — so a near-identical candidate set
  // proceeded in silence. It is reported here, and the distances go out with the result so the
  // threshold can eventually be calibrated from real runs instead of guessed.
  const degeneracy = checkCandidateSetDegeneracy(validLayouts);
  if (degeneracy.isDegenerate) {
    console.warn(
      `[LayoutGeneratorV3] Candidate set is degenerate: ${degeneracy.reason}. ` +
        `The tournament cannot separate candidates this similar, and a judge asked to will decide ` +
        `by presentation order.`
    );
  } else {
    const spread = degeneracy.pairwiseDistances.length
      ? Math.min(...degeneracy.pairwiseDistances).toFixed(1)
      : 'n/a';
    console.log(`[LayoutGeneratorV3] Candidate spread: closest pair ${spread}px apart.`);
  }

  return {
    layouts: validLayouts,
    rawCandidates: validRaw,
    responseId: response.receipt.responseId,
    xRequestId: response.receipt.xRequestId || null,
    inputTokens: response.receipt.inputTokens,
    outputTokens: response.receipt.outputTokens,
    cachedTokens: response.receipt.cacheReadTokens,
    costUsd: response.receipt.costUsd,
    latencyMs: response.receipt.latencyMs,
    degeneracyCheck: degeneracy,
  };
}
