import { z } from 'zod';

const share = z.number().finite().min(0).max(1);
const dimension = z.number().finite().positive().max(1);
const tracking = z.number().finite().min(-1).max(1);
const font = z.string().min(1).max(128).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const note = z.string().min(1).max(2000);
const paletteSchema = z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(1).max(64);

/** Fixed-depth schema: no recursive traversal of arbitrary client/model content. */
function grammarSchema(palette: ReadonlySet<string>) {
  const color = z.string().regex(/^#[0-9a-f]{6}$/i).refine(value => palette.has(value.toUpperCase()));
  const stops = z.array(z.object({ at: share, color }).strict()).min(2).max(8).superRefine((values, context) => {
    if (values.length && (values[0].at !== 0 || values[values.length - 1].at !== 1)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stops must span the gradient line.' });
    }
    for (let i = 1; i < values.length; i++) {
      if (values[i].at <= values[i - 1].at) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'at'], message: 'Stops must ascend strictly.' });
      }
    }
  });
  const type = z.object({
    fontFamily: font, bold: z.boolean().optional(), italic: z.boolean().optional(),
    color, colorOnDark: color.optional(), sizeShare: dimension,
    lineHeight: z.number().finite().positive().max(5).optional(), letterSpacing: tracking.optional(),
  }).strict();
  const card = z.object({ fill: color, title: color, text: color, edge: color.optional(), edgeShare: dimension.optional() }).strict();
  // ADR-271: a poster composition's colours.
  const posterVariant = z.object({
    ground: color.optional(), title: color, lead: color, body: color, detail: color,
    panel: color.optional(), panelTitle: color.optional(), panelText: color.optional(),
    pill: color, pillText: color, sunburst: z.object({ color, opacity: share }).strict(),
    pattern: z.object({ color, opacity: share }).strict().optional(),
  }).strict();
  const poster = z.object({
    source: note.optional(),
    titleSizeShare: z.object({ min: dimension, max: dimension }).strict().refine(v => v.min <= v.max, 'The title range must ascend.'),
    logoWidthShare: dimension, titleBarWidthShare: dimension, negativeSpaceMax: share,
    detailSizeShareMin: dimension.optional(),
    navy: posterVariant, cream: posterVariant.refine(v => Boolean(v.ground && v.panel && v.panelTitle && v.panelText), 'The cream poster names its ground and card.'),
    band: posterVariant,
  }).strict();
  return z.object({
    source: note.optional(),
    page: z.object({ background: color, marginShare: z.number().finite().min(0).lt(0.5) }).strict(),
    header: z.object({
      logoWidthShare: dimension,
      rule: z.object({ color, opacity: share, thicknessShare: dimension }).strict(),
      accent: z.object({ widthShare: dimension, thicknessShare: dimension, stops }).strict(), label: type,
    }).strict(),
    title: type,
    titleBar: z.object({ widthShare: dimension, heightShare: dimension, gapShare: share, stops }).strict(),
    lead: type, body: type,
    cards: z.object({
      radiusShare: share,
      shadow: z.object({ color, opacity: share, blurShare: share, offsetShare: share }).strict(),
      plain: card, brand: card, tint: card, dark: card,
    }).strict(),
    stat: z.object({ fontFamily: font, bold: z.boolean().optional(), colorOnDark: color, colorOnLight: color,
      labelColor: color, labelColorOnDark: color }).strict(),
    footRule: z.object({ heightShare: dimension, stops }).strict(),
    cover: z.object({
      angle: z.number().finite().min(0).max(360), stops, logoWidthShare: dimension, title: color, body: color,
      subtitle: z.object({ fontFamily: font, color, letterSpacing: tracking, sizeShare: dimension }).strict(),
    }).strict(),
    elements: z.object({
      sunburst: z.object({ color, opacityOnLight: share, colorOnDark: color, opacityOnDark: share,
        rays: z.number().finite().int().min(1).max(64) }).strict(),
      trianglePattern: z.object({ color, opacityOnLight: share, colorOnDark: color, opacityOnDark: share }).strict(),
      rule: note.optional(),
    }).strict(),
    poster: poster.optional(),
  }).strict();
}

export type AdmittedPageGrammar = z.infer<ReturnType<typeof grammarSchema>>;

export class PageGrammarInvalidError extends Error {
  readonly code = 'PAGE_GRAMMAR_INVALID';
  constructor(readonly field: string) {
    // No supplied value or Zod message: unknown property names/content may contain private data.
    super(`PAGE_GRAMMAR_INVALID: ${field} violates the client page grammar contract.`);
    this.name = 'PageGrammarInvalidError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function fieldPath(root: string, path: Array<string | number>): string {
  return root + path.map(part => typeof part === 'number' ? `[${part}]` : `.${part}`).join('');
}

/**
 * Validate only a grammar explicitly present in this reference. Never insert a house/client style,
 * coerce numeric strings, omit malformed supplied data or rewrite the hash-bearing reference.
 * Font string structure is checked here; pinned face/glyph/native admission remains a later gate.
 */
export function admitPageGrammarFromReference(rawReference: unknown): AdmittedPageGrammar | undefined {
  const rules = record(record(rawReference)?.rules);
  if (!rules || !Object.prototype.hasOwnProperty.call(rules, 'pageGrammar')) return undefined;
  const palette = paletteSchema.safeParse(rules.palette);
  if (!palette.success) throw new PageGrammarInvalidError(fieldPath('rules.palette', palette.error.issues[0].path));
  const grammar = grammarSchema(new Set(palette.data.map(color => color.toUpperCase()))).safeParse(rules.pageGrammar);
  if (!grammar.success) throw new PageGrammarInvalidError(fieldPath('pageGrammar', grammar.error.issues[0].path));
  return grammar.data;
}
