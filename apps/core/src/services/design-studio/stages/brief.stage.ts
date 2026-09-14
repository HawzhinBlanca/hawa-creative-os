import type { StageContext, CreativeBrief } from '../types.js';
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
  ],
  additionalProperties: false,
};

export async function runBriefStage(ctx: StageContext): Promise<CreativeBrief> {
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

  const response = await ctx.client.completeJson<CreativeBrief>({
    system: systemPrompt,
    prompt: userPrompt,
    schema: CREATIVE_BRIEF_SCHEMA,
    schemaName: 'CreativeBrief',
  });

  const brief = response.data;

  // Server check: roles must cover every copy index exactly once
  const coveredIndices = new Set(brief.roles.map((r: { copyIndex: number }) => r.copyIndex));
  for (let i = 0; i < ctx.copyBlocks.length; i++) {
    if (!coveredIndices.has(i)) {
      throw new Error(`Creative brief failed validation: missing copy index ${i}`);
    }
  }
  if (brief.roles.length !== ctx.copyBlocks.length) {
    throw new Error(`Creative brief failed validation: roles length ${brief.roles.length} != copy blocks ${ctx.copyBlocks.length}`);
  }

  return brief;
}
