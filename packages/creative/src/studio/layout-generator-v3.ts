import { z } from 'zod';
import type { StudioLayoutV2, TextElement, ShapeElement, ArtConfig, Box } from './layout-v2.js';
import { studioLayoutV2Schema } from './layout-v2.js';
import { evaluateDesignMetrics, checkCandidateSetDegeneracy } from './design-metrics.js';
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

export interface NormalizedLayoutCandidate {
  id: string;
  conceptTitle: string;
  compositionArchetype: 'monolith_centered' | 'asymmetric_editorial' | 'hero_statement_grid' | 'split_statutory_banner' | 'minimal_framed';
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
    case 'title':
      fontRange = [36 / canvasHeight, 46 / canvasHeight];
      heightRange = [0.07, 0.12];
      break;
    case 'subtitle':
      fontRange = [20 / canvasHeight, 26 / canvasHeight];
      heightRange = [0.04, 0.08];
      break;
    case 'eyebrow':
      fontRange = [13 / canvasHeight, 16 / canvasHeight];
      heightRange = [0.025, 0.04];
      break;
    case 'body': {
      fontRange = [15 / canvasHeight, 19 / canvasHeight];
      const estLines = Math.ceil(charCount / 65);
      const estHeight = Math.max(0.10, Math.min(0.28, (estLines * 28) / canvasHeight));
      heightRange = [estHeight * 0.9, estHeight * 1.3];
      break;
    }
    case 'footer':
      fontRange = [11 / canvasHeight, 14 / canvasHeight];
      heightRange = [0.025, 0.045];
      break;
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
  canvasHeight: number
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

  const shapes: ShapeElement[] = norm.shapes.map((s) => ({
    x: scaleX(s.x),
    y: scaleY(s.y),
    width: scaleDimX(s.width),
    height: scaleDimY(s.height),
    kind: s.kind,
    color: s.color,
    role: s.role,
    opacity: s.opacity !== null && s.opacity !== undefined ? Number(clamp(s.opacity).toFixed(2)) : undefined,
    radius: s.radius !== null && s.radius !== undefined ? Math.round(s.radius * canvasWidth) : undefined,
    strokeWidth:
      s.strokeWidth !== null && s.strokeWidth !== undefined
        ? Math.max(1, Math.round(s.strokeWidth * canvasWidth))
        : undefined,
    strokeColor: s.strokeColor || undefined,
  }));

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
      } else {
        if (resolvedFont === 'Amiri' || resolvedFont === 'Cairo') {
          // Keep admitted installed font
        } else {
          resolvedFont = 'Cairo';
        }
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

    return {
      copyIndex: t.copyIndex,
      role: t.role,
      x: scaleX(t.x),
      y: scaleY(t.y),
      width: scaleDimX(t.width),
      height: scaleDimY(t.height),
      fontSize: fontSizePx,
      lineHeight: clampedLineHeight,
      letterSpacing:
        t.letterSpacing !== null && t.letterSpacing !== undefined
          ? t.letterSpacing <= 1
            ? Number((t.letterSpacing * canvasWidth).toFixed(1))
            : Number(t.letterSpacing.toFixed(1))
          : undefined,
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
  degeneracyCheck: { isDegenerate: boolean; reason?: string; distances?: number[] };
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
- Vertical Rhythm & Negative Space:
  * Negative space fraction must be balanced (typically 0.35 to 0.65 of canvas area).
  * Avoid excessive dead voids (no single uncomposed vertical void > 0.25 of canvas height).
  * Group related elements (title + subtitle, body paragraphs, statutory footer) with intentional proximity.

================================================================================
4. RTL (SORANI KURDISH) RULES
================================================================================
When generating layouts for Kurdish or Arabic copy:
- Set rtl: true on all Arabic/Kurdish text elements.
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
export function buildLayoutV3UserPrompt(options: {
  brief: string;
  copyBlocks: CopyBlockSlotInput[];
  palette: string[];
  canvasWidth: number;
  canvasHeight: number;
  exemplars?: ExemplarRetrievalMatch[];
  isRtl?: boolean;
}): string {
  const { brief, copyBlocks, palette, canvasWidth, canvasHeight, exemplars, isRtl } = options;

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
- Target Dimensions: ${canvasWidth}px x ${canvasHeight}px (Aspect Ratio: ${canvasWidth === canvasHeight ? '1:1' : '4:5'})
- Primary Palette: ${palette.join(', ')}
- Language Direction: ${isRtl ? 'RTL (Sorani Kurdish / Arabic)' : 'LTR (Latin / English)'}

OWNER-CONFIRMED REFERENCE EXEMPLARS (Inspiration for layout architecture and negative space distribution):
${exemplarsFormatted}

CAPACITY-AWARE COPY SLOTS (PosterMELD 2608.02218):
Fit the copy before rendering. Sizing each text box and font size must satisfy character capacity:
${slotsFormatted}

TASK:
Generate exactly THREE deliberately distinct normalized layout candidates as JSON.
- Candidate 1: Explore Archetype "monolith_centered" or "split_statutory_banner".
- Candidate 2: Explore Archetype "asymmetric_editorial" (offset axis, accent line).
- Candidate 3: Explore Archetype "hero_statement_grid" or "minimal_framed".

CRITICAL CONSTRAINTS:
1. No two candidates may have identical or near-identical geometry (geometric distance > 15px).
2. NO side-by-side bilateral symmetric twin cards.
3. Use ONLY F12 admitted fonts (Verdana or Noto Sans Arabic for body/footer; Cinzel/Lora/Cairo/Amiri for titles).
4. All coordinates strictly in [0.0, 1.0].
5. Declare typeScale (base and ratio) for each candidate.
6. Declare calmRegion if an art layer is requested.`;
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
  });

  const response: OpenAiStructuredResponse<{ layouts: NormalizedLayoutCandidate[] }> =
    await options.client.createStructuredCompletion({
      model: 'gpt-6-astra',
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
      reasoningEffort: 'low',
      timeoutMs: 240000,
    });

  const rawCandidates = response.data.layouts;
  if (!rawCandidates || rawCandidates.length < 3) {
    throw new Error(`Expected at least 3 layout candidates, received ${rawCandidates?.length || 0}`);
  }

  // Scale candidates server-side
  const scaledLayouts: StudioLayoutV2[] = rawCandidates.map((c) =>
    scaleNormalizedLayoutToV2(c, canvasWidth, canvasHeight)
  );

  // Validate each layout against studioLayoutV2Schema
  for (let i = 0; i < scaledLayouts.length; i++) {
    const layout = scaledLayouts[i];
    const parseResult = studioLayoutV2Schema.safeParse(layout);
    if (!parseResult.success) {
      throw new Error(`Candidate ${i + 1} failed StudioLayoutV2 schema: ${parseResult.error.message}`);
    }

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

  // Degeneracy check across the 3 layouts
  const degeneracy = checkCandidateSetDegeneracy(scaledLayouts);

  return {
    layouts: scaledLayouts,
    rawCandidates,
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
