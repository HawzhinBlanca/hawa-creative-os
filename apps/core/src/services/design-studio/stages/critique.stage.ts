import type { StageContext, CreativeBrief, CandidateState, Critique } from '../types.js';
import { buildP0SystemPrompt, buildP4Prompt } from '../prompts.js';

export const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
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
        },
        required: ['text', 'region'],
        additionalProperties: false,
      },
      minItems: 5,
      maxItems: 5,
    },
    scores: {
      type: 'object',
      properties: {
        hierarchy: { type: 'number' },
        typography: { type: 'number' },
        composition: { type: 'number' },
        whitespace: { type: 'number' },
        brandFidelity: { type: 'number' },
        legibility: { type: 'number' },
        craft: { type: 'number' },
      },
      required: ['hierarchy', 'typography', 'composition', 'whitespace', 'brandFidelity', 'legibility', 'craft'],
      additionalProperties: false,
    },
    evidence: {
      type: 'object',
      properties: {
        hierarchy: { type: 'string' },
        typography: { type: 'string' },
        composition: { type: 'string' },
        whitespace: { type: 'string' },
        brandFidelity: { type: 'string' },
        legibility: { type: 'string' },
        craft: { type: 'string' },
      },
      required: ['hierarchy', 'typography', 'composition', 'whitespace', 'brandFidelity', 'legibility', 'craft'],
      additionalProperties: false,
    },
    hardFails: {
      type: 'array',
      items: { type: 'string' },
    },
    revisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          element: { type: 'string' },
          change: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['element', 'change', 'target'],
        additionalProperties: false,
      },
      maxItems: 3,
    },
    overall: { type: 'number' },
  },
  required: ['observations', 'scores', 'evidence', 'hardFails', 'revisions'],
  additionalProperties: false,
};

export function computeWeightedScore(scores: Critique['scores']): number {
  const weighted =
    scores.hierarchy * 0.20 +
    scores.typography * 0.20 +
    scores.composition * 0.15 +
    scores.whitespace * 0.10 +
    scores.brandFidelity * 0.15 +
    scores.legibility * 0.10 +
    scores.craft * 0.10;
  return Math.round(weighted * 100) / 100;
}

export async function runCritiqueStage(
  ctx: StageContext,
  brief: CreativeBrief,
  candidates: CandidateState[]
): Promise<CandidateState[]> {
  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  for (const cand of candidates) {
    if (!cand.previewPng) continue;

    const userPrompt = buildP4Prompt({
      metricsJson: JSON.stringify(cand.metrics || {}),
      hardQaJson: JSON.stringify({ passed: true, checks: 'preliminary_metrics_ok' }),
      creativeBriefJson: JSON.stringify(brief),
    });

    const response = await ctx.client.completeJson<Critique>({
      system: systemPrompt,
      prompt: userPrompt,
      schema: CRITIQUE_SCHEMA,
      schemaName: 'CandidateCritique',
      images: [cand.previewPng],
    });

    const critique = response.data;
    critique.weightedScore = computeWeightedScore(critique.scores);
    cand.critiques.push(critique);
    cand.score = critique.weightedScore;
  }

  return candidates;
}
