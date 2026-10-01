import type { StageContext, ParityResult } from '../types.js';
import { resolveModel } from '@hawa/domain';
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

/**
 * The findings the PPTX check already established, written out for the model as facts it must not
 * contradict. `checkCanvaPptx` reads the exported slide XML, so these are read off the document
 * rather than inferred from pixels: `copyPass` compares every copy string word for word,
 * `fontPass` compares the typeface of each text object against the one it was sent in, and
 * `rtlPass` confirms right-to-left runs stayed right-to-left.
 */
export function parityFactsFrom(check: any): string {
  if (!check) {
    return 'No deterministic export check is available for this design, so judge all five answers from the two images alone.';
  }
  const lines = [
    'ESTABLISHED FACTS from the exported PowerPoint, read off the document itself. These are not in',
    'question and your answer must agree with them:',
    `- Copy: every copy string ${check.copyPass ? 'survived the round trip word for word' : 'did NOT survive intact'}` +
      `${check.offendingObjects?.length ? ` (${check.offendingObjects.length} offending text object(s))` : ''}.`,
    `- Typefaces: each text object ${check.fontPass ? 'kept the typeface it was sent in' : 'did NOT keep the typeface it was sent in'}` +
      `${check.observedFonts?.length ? ` (observed: ${check.observedFonts.join(', ')})` : ''}.`,
  ];
  if (check.rtlPass !== undefined) {
    lines.push(`- Right-to-left runs: ${check.rtlPass ? 'preserved' : 'NOT preserved'}${check.rtlNote ? ` (${check.rtlNote})` : ''}.`);
  }
  lines.push(
    `- Text objects: ${check.textObjectCount} present, ${check.expectedTextObjectCount} expected.`,
    '',
    `Set copyVisibleIdentical to ${check.copyPass ? 'true' : 'false'} and fontSubstituted to ${check.fontPass ? 'false' : 'true'},`,
    'to match the facts above. Spend your attention on the one question the document cannot answer:',
    'whether the ARRANGEMENT survived — did anything move, resize, reflow onto a different number of',
    'lines, collide, or leave the canvas.'
  );
  return lines.join('\n');
}

export async function runParityStage(
  ctx: StageContext,
  previewPng: Buffer,
  canvaPng: Buffer,
  contentCheck?: any
): Promise<ParityResult> {
  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const response = await ctx.client.completeJson<ParityResult>({
    system: systemPrompt,
    prompt: `${P8_CANVA_PARITY_TEMPLATE}\n\n${parityFactsFrom(contentCheck)}`,
    schema: PARITY_SCHEMA,
    schemaName: 'CanvaParityVerdict',
    images: [previewPng, canvaPng],
    // Parity reads two finished renders and reports what differs; it invents nothing, which is the
    // same shape of work as the judge, and it rides the judge role: gpt-6.1-sol in production since
    // ADR-237 (every model that looks at a design is the top model). Its verdict is advisory in any
    // case: delivery is already gated on the deterministic copy and font checks above, and nothing
    // branches on this result.
    model: resolveModel('judge'),
  });

  return response.data;
}
