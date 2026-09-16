import type { StageContext, CreativeBrief, Concept, Archetype, MotifKind } from '../types.js';
import { buildP0SystemPrompt, buildP2Prompt } from '../prompts.js';

export const CONCEPTS_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          archetype: {
            type: 'string',
            enum: [
              'editorial-centered',
              'asymmetric-grid',
              'typographic-poster',
              'framed-invitation',
              'split-band',
              'full-bleed-art-with-scrim',
              'monumental-title',
              'ribbon-and-rules',
            ],
          },
          artStrategy: {
            type: 'string',
            enum: ['none', 'procedural', 'generated'],
          },
          motif: {
            type: 'string',
            enum: ['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash'],
          },
          artPrompt: { type: 'string' },
          typographicScale: {
            type: 'object',
            properties: {
              ratio: { type: 'number' },
              titleSize: { type: 'number' },
              bodySize: { type: 'number' },
            },
            required: ['ratio', 'titleSize', 'bodySize'],
            additionalProperties: false,
          },
          colourRoles: {
            type: 'object',
            properties: {
              background: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
              accent: { type: 'string' },
              rule: { type: 'string' },
            },
            required: ['background', 'title', 'body', 'accent', 'rule'],
            additionalProperties: false,
          },
          layoutIdea: { type: 'string' },
          whyDifferent: { type: 'string' },
        },
        required: [
          'id',
          'name',
          'archetype',
          'artStrategy',
          'typographicScale',
          'colourRoles',
          'layoutIdea',
          'whyDifferent',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['concepts'],
  additionalProperties: false,
};

export function checkConceptDiversity(
  concepts: Concept[],
  palette: string[],
  nExpected: number
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (concepts.length < nExpected) {
    reasons.push(`Expected at least ${nExpected} concepts, got ${concepts.length}`);
  }

  // 1. Archetype uniqueness
  const archetypes = new Set<string>();
  for (const c of concepts) {
    if (archetypes.has(c.archetype)) {
      reasons.push(`Duplicate archetype detected: ${c.archetype} in concept ${c.id}`);
    }
    archetypes.add(c.archetype);
  }

  // 2. Generated imagery count <= 2
  const generatedCount = concepts.filter((c) => c.artStrategy === 'generated').length;
  if (generatedCount > 2) {
    reasons.push(`At most 2 concepts may use generated imagery, found ${generatedCount}`);
  }

  // 3. At least 1 concept uses no imagery
  const noneCount = concepts.filter((c) => c.artStrategy === 'none').length;
  if (noneCount < 1) {
    reasons.push(`At least one concept must use no imagery (artStrategy='none')`);
  }

  // 4. Palette containment
  const normPalette = new Set(palette.map((hex) => hex.toLowerCase().replace('#', '')));
  for (const c of concepts) {
    for (const [role, color] of Object.entries(c.colourRoles)) {
      const normColor = color.toLowerCase().replace('#', '');
      if (!normPalette.has(normColor)) {
        reasons.push(`Concept ${c.id} colour role ${role}="${color}" is not in brand palette`);
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

export async function runConceptsStage(
  ctx: StageContext,
  brief: CreativeBrief
): Promise<Concept[]> {
  const nExpected = ctx.tier === 'premium' ? 5 : 3;

  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const userPrompt = buildP2Prompt({
    n: nExpected,
    creativeBriefJson: JSON.stringify(brief),
  });

  const exemplarImages = (ctx.exemplars || []).slice(0, 2).map((e) => e.bytes).filter(Boolean) as Buffer[];
  const images = exemplarImages.length > 0 ? exemplarImages : undefined;

  // Attempt 1
  let response = await ctx.client.completeJson<{ concepts: Concept[] }>({
    system: systemPrompt,
    prompt: userPrompt,
    images,
    schema: CONCEPTS_SCHEMA,
    schemaName: 'ConceptBoard',
  });

  let concepts = response.data.concepts;
  let check = checkConceptDiversity(concepts, ctx.referencePack.palette, nExpected);

  // If diversity check fails, retry once with feedback
  if (!check.valid) {
    const retryPrompt = `${userPrompt}\n\nYour previous proposals failed these diversity/palette rules:\n${check.reasons.map((r) => `- ${r}`).join('\n')}\nPlease return ${nExpected} corrected concepts adhering to all rules.`;

    response = await ctx.client.completeJson<{ concepts: Concept[] }>({
      system: systemPrompt,
      prompt: retryPrompt,
      images,
      schema: CONCEPTS_SCHEMA,
      schemaName: 'ConceptBoard',
    });

    concepts = response.data.concepts;
    check = checkConceptDiversity(concepts, ctx.referencePack.palette, nExpected);
    if (!check.valid) {
      // Degrade gracefully: fix palette colors if needed to ensure pipeline continuity
      const fallbackPalette = ctx.referencePack.palette;
      for (const c of concepts) {
        for (const role of Object.keys(c.colourRoles) as Array<keyof typeof c.colourRoles>) {
          const norm = c.colourRoles[role].toLowerCase().replace('#', '');
          const normPalette = new Set(fallbackPalette.map((p) => p.toLowerCase().replace('#', '')));
          if (!normPalette.has(norm)) {
            c.colourRoles[role] = fallbackPalette[0];
          }
        }
      }
    }
  }

  return concepts.slice(0, nExpected);
}
