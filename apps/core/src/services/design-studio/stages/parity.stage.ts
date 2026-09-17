import type { StageContext, ParityResult } from '../types.js';
import { buildP0SystemPrompt, P8_CANVA_PARITY_TEMPLATE } from '../prompts.js';

export const PARITY_SCHEMA = {
  type: 'object',
  properties: {
    parity: { type: 'string', enum: ['match', 'minor', 'major'] },
    divergences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          what: { type: 'string' },
          region: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['x', 'y', 'w', 'h'],
            additionalProperties: false,
          },
          severity: { type: 'string', enum: ['minor', 'major'] },
        },
        required: ['what', 'region', 'severity'],
        additionalProperties: false,
      },
    },
    fontSubstituted: { type: 'boolean' },
    textReflowed: { type: 'boolean' },
    copyVisibleIdentical: { type: 'boolean' },
  },
  required: ['parity', 'divergences', 'fontSubstituted', 'textReflowed', 'copyVisibleIdentical'],
  additionalProperties: false,
};

export async function runParityStage(
  ctx: StageContext,
  previewPng: Buffer,
  canvaPng: Buffer
): Promise<ParityResult> {
  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const response = await ctx.client.completeJson<ParityResult>({
    system: systemPrompt,
    prompt: P8_CANVA_PARITY_TEMPLATE,
    schema: PARITY_SCHEMA,
    schemaName: 'CanvaParityVerdict',
    images: [previewPng, canvaPng],
  });

  return response.data;
}
