import type { StageContext, CreativeBrief } from '../types.js';
import { nearestPaletteColour, STYLE_SPEC_SCHEMA, NEUTRAL_STYLE_SPEC } from '@hawa/creative';
import { buildP0SystemPrompt, buildP1Prompt } from '../prompts.js';

export const CREATIVE_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    occasion: { type: 'string' },
    audience: { type: 'string' },
    formality: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    toneWords: {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 3,
    },
    readingOrder: {
      type: 'array',
      items: { type: 'integer' },
    },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          copyIndex: { type: 'integer' },
          role: {
            type: 'string',
            enum: ['eyebrow', 'title', 'subtitle', 'body', 'date', 'venue', 'cta', 'footer', 'other'],
          },
          importance: { type: 'integer', enum: [1, 2, 3, 4, 5] },
        },
        required: ['copyIndex', 'role', 'importance'],
        additionalProperties: false,
      },
    },
    must: {
      type: 'array',
      items: { type: 'string' },
    },
    mustNot: {
      type: 'array',
      items: { type: 'string' },
    },
    imageryStrategy: {
      type: 'string',
      enum: ['none', 'abstract', 'photographic'],
    },
    imageryRationale: { type: 'string' },
    kurdishLeads: { type: 'boolean' },
    riskFlags: {
      type: 'array',
      items: { type: 'string' },
    },
    referenceRole: {
      type: 'string',
      enum: ['none', 'logo', 'style_reference'],
      description:
        "What the attached image is: 'logo' if it is the client's logo or emblem, 'style_reference' if it shows a design, layout, colour or mood the client wants followed, 'none' if no image is attached or it is unrelated.",
    },
    referenceNotes: {
      type: 'string',
      description:
        "For a style reference: what to take from it, concretely (composition, where colour and ornament sit, texture, type treatment, mood). Empty otherwise.",
    },
    styleSpec: STYLE_SPEC_SCHEMA,
    requestedBackground: {
      type: 'string',
      description:
        "The brand-palette hex the client explicitly asked to use as the background (for example they wrote 'navy background'); an empty string when they did not ask for one.",
    },
  },
  required: [
    'occasion',
    'audience',
    'formality',
    'toneWords',
    'readingOrder',
    'roles',
    'must',
    'mustNot',
    'imageryStrategy',
    'imageryRationale',
    'kurdishLeads',
    'riskFlags',
    'requestedBackground',
    'referenceRole',
    'referenceNotes',
    'styleSpec',
  ],
  additionalProperties: false,
};

const ATTACHED_WITH_THE_REQUEST =
  "The client attached the image shown. Classify it in referenceRole, and for a style reference say in referenceNotes what the design should take from it. The client's words above say what they sent it for.";

// The owner sends the request text and the reference photo as two Telegram messages, and the photo
// carries no caption at all, so the request never mentions an image. Told the wording above, which
// sends the model to the client's words for what the image is for, it has nothing connecting the
// two and can answer referenceRole 'none' for a reference the client did send. How the image
// arrived is the only evidence there is, so the brief is given it.
const SENT_JUST_AFTER_THE_REQUEST =
  "The client sent the image shown as a separate message moments after the request above, with no caption. That is how this office receives a reference, so judge it from the image alone: unless it is plainly the client's own logo or emblem, it is the design they want followed. Classify it in referenceRole, and for a style reference say in referenceNotes what the design should take from it.";

/** `lateReference`: the image reached the run after this brief was first written (studio service). */
export async function runBriefStage(ctx: StageContext, opts?: { lateReference?: boolean }): Promise<CreativeBrief> {
  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const copyBlocksFormatted = ctx.copyBlocks
    .map((b, i) => `[Index ${i} - ${b.script}]: "${b.text.replace(/"/g, '\\"')}"`)
    .join('\n');

  const aspectLabel = `${ctx.width}:${ctx.height} (${(ctx.width / ctx.height).toFixed(2)})`;
  const imageryOption = ctx.tier === 'premium' ? 'auto' : 'none';

  const userPrompt = buildP1Prompt({
    instructions: ctx.instructions,
    copyBlocksWithIndexAndScript: copyBlocksFormatted,
    width: ctx.width,
    height: ctx.height,
    aspectLabel,
    imageryOption,
  });

  const attached = ctx.attachedImage?.match(/^data:([^;]+);base64,(.+)$/);
  const response = await ctx.client.completeJson<CreativeBrief>({
    system: systemPrompt,
    prompt: attached
      ? `${userPrompt}\n\n${opts?.lateReference ? SENT_JUST_AFTER_THE_REQUEST : ATTACHED_WITH_THE_REQUEST}\n\nFill styleSpec from the reference and the client's instructions (the instructions win where they differ): these values are enforced on the design, so read them off the image precisely.`
      : `${userPrompt}\n\nFill styleSpec only from what the client's instructions ask for explicitly (a font, a gold button, where the logo goes); 'as_generated' for everything else.`,
    ...(attached ? { images: [{ mediaType: attached[1], data: attached[2] }] } : {}),
    schema: CREATIVE_BRIEF_SCHEMA,
    schemaName: 'CreativeBrief',
  });

  const { brief, dropped } = normalizeBriefRoles(response.data, ctx.copyBlocks.length);
  // Without an image there is nothing to follow, whatever the model answered.
  if (!attached) {
    brief.referenceRole = 'none';
    brief.referenceNotes = '';
  }
  brief.referenceSeen = Boolean(attached);
  brief.styleSpec = { ...NEUTRAL_STYLE_SPEC, ...(brief.styleSpec || {}) };
  if (dropped.length > 0) {
    console.warn(`[studio] creative brief listed ${dropped.length} surplus role(s) (${dropped.join('; ')}); kept one role per copy block`);
  }
  return brief;
}

/**
 * Keeps exactly one role per copy block, in copy order, and a reading order over real blocks only.
 *
 * gpt-4.1-mini (the cheap tier) returned nine roles for eight blocks on 2026-09-18 (task abc59152),
 * and the whole design failed at its first stage. A surplus role, whether a block named twice or an
 * index past the end, is dropped: the first role given for a block is kept. A block with no role at
 * all still fails, because the pipeline cannot know what it is.
 */
export function normalizeBriefRoles(brief: CreativeBrief, copyCount: number): { brief: CreativeBrief; dropped: string[] } {
  const byIndex = new Map<number, CreativeBrief['roles'][number]>();
  const dropped: string[] = [];
  for (const role of brief.roles || []) {
    const i = role.copyIndex;
    if (!Number.isInteger(i) || i < 0 || i >= copyCount) dropped.push(`copyIndex ${i} does not exist`);
    else if (byIndex.has(i)) dropped.push(`copyIndex ${i} listed again as ${role.role}`);
    else byIndex.set(i, role);
  }
  for (let i = 0; i < copyCount; i++) {
    if (!byIndex.has(i)) throw new Error(`Creative brief failed validation: missing copy index ${i}`);
  }
  // An eyebrow is the short line above a title. A block the client wrote after the title cannot be
  // one: labelled so, the layout sets it above the title (the guest's name, task 3c3a422b).
  const title = [...byIndex.values()].find((r) => r.role === 'title');
  for (const [i, r] of byIndex) {
    if (title && r.role === 'eyebrow' && i > title.copyIndex) byIndex.set(i, { ...r, role: 'subtitle' });
  }
  const order = [...new Set((brief.readingOrder || []).filter((i) => Number.isInteger(i) && i >= 0 && i < copyCount))];
  for (let i = 0; i < copyCount; i++) if (!order.includes(i)) order.push(i);
  return {
    brief: { ...brief, roles: [...byIndex.keys()].sort((a, b) => a - b).map((i) => byIndex.get(i)!), readingOrder: order },
    dropped,
  };
}

/**
 * The background colour the client asked for, as a colour of the brand palette, or undefined.
 * A hex outside the palette resolves to the nearest brand colour; anything else is ignored.
 */
export function requestedBackgroundFor(brief: Partial<CreativeBrief> | undefined, palette: string[]): string | undefined {
  const hex = String(brief?.requestedBackground || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex) || !palette.length) return undefined;
  return palette.find((p) => p.toLowerCase() === hex.toLowerCase()) || nearestPaletteColour(hex, palette);
}
