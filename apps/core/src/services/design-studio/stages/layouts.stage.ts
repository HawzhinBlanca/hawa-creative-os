import { randomUUID } from 'node:crypto';
import type { StageContext, CreativeBrief, Concept, CandidateState } from '../types.js';
import {
  validateLayoutV2,
  type LayoutValidationContext,
  type StudioLayoutV2,
  generateLayoutCandidatesV3,
  normalizeStudioLayout,
  prepareGeneratedLayoutV3,
  retrieveExemplarsV3,
  type CopyBlockSlotInput,
} from '@hawa/creative';
import { buildP0SystemPrompt, buildP3Prompt } from '../prompts.js';
import { copyForStageV3, conceptFromV3Candidate } from './v3.stage.js';

export const LAYOUT_SCHEMA = {
  type: 'object',
  properties: {
    layout: {
      type: 'object',
      properties: {
        version: { type: 'integer', enum: [2] },
        width: { type: 'integer' },
        height: { type: 'integer' },
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
        art: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['generated', 'procedural'] },
            prompt: { type: 'string' },
            motif: { type: 'string', enum: ['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash'] },
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
            scrim: {
              type: 'object',
              properties: {
                color: { type: 'string' },
                opacityStart: { type: 'number' },
                opacityEnd: { type: 'number' },
                direction: { type: 'string', enum: ['vertical', 'horizontal', 'radial'] },
              },
              required: ['color', 'opacityStart', 'opacityEnd', 'direction'],
              additionalProperties: false,
            },
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
          required: ['source', 'box', 'opacity', 'calmRegion'],
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
              opacity: { type: 'number' },
              radius: { type: 'number' },
              rotation: { type: 'number' },
              strokeWidth: { type: 'number' },
              strokeColor: { type: 'string' },
              role: { type: 'string', enum: ['rule', 'panel', 'accent', 'frame'] },
            },
            required: ['x', 'y', 'width', 'height', 'kind', 'color', 'role'],
            additionalProperties: false,
          },
        },
        text: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              copyIndex: { type: 'integer' },
              role: {
                type: 'string',
                enum: ['eyebrow', 'title', 'subtitle', 'body', 'date', 'venue', 'cta', 'footer', 'other'],
              },
              fontSize: { type: 'number' },
              lineHeight: { type: 'number' },
              letterSpacing: { type: 'number' },
              fontFamily: { type: 'string' },
              color: { type: 'string' },
              align: { type: 'string', enum: ['left', 'center', 'right'] },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              opacity: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height', 'copyIndex', 'role', 'fontSize', 'lineHeight', 'fontFamily', 'color', 'align'],
            additionalProperties: false,
          },
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
        photos: {
          type: 'array',
          description: "The client's photographs, one element per photo provided, each placed once. Empty when none were provided.",
          items: {
            type: 'object',
            properties: {
              photoIndex: { type: 'number' },
              role: { type: 'string', enum: ['hero', 'portrait', 'inset'] },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              radius: { type: 'number' },
            },
            required: ['photoIndex', 'role', 'x', 'y', 'width', 'height', 'radius'],
            additionalProperties: false,
          },
        },
      },
      required: ['version', 'width', 'height', 'grid', 'background', 'shapes', 'text', 'logo', 'photos'],
      additionalProperties: false,
    },
    notes: { type: 'string' },
  },
  required: ['layout'],
  additionalProperties: false,
};

/** The shared normaliser; kept under this name for the studio's existing callers. */
export const normalizeCandidateLayout = normalizeStudioLayout;

export async function runLayoutsStage(
  ctx: StageContext,
  brief: CreativeBrief,
  concepts: Concept[],
  existingCandidates?: Array<{ id: string; ordinal: number }>
): Promise<CandidateState[]> {
  if (ctx.pipelineV3) {
    // One generator call for three deliberately different layouts, conditioned on the owner's
    // confirmed exemplars, then exactly the preparation the qualification applies. There is no
    // fallback to the v2 generator: a v3 run that quietly produced v2 layouts would be recorded,
    // judged and reported as v3. A failure fails the run, and the run's diagnostic says why.
    const copy = copyForStageV3(ctx);
    const copyBlockSlots: CopyBlockSlotInput[] = ctx.copyBlocks.map((b, i) => {
      const roleEntry = brief.roles?.find((r) => r.copyIndex === i);
      return {
        index: i,
        text: b.text,
        role: (roleEntry?.role as any) || (i === 0 ? 'title' : 'body'),
        script: b.script === 'arabic' ? 'arabic' : 'latin',
      };
    });

    const briefSummary = layoutBriefV3(brief, ctx);

    const v3Result = await generateLayoutCandidatesV3({
      client: ctx.client as any,
      brief: briefSummary,
      copyBlocks: copyBlockSlots,
      palette: ctx.referencePack.palette,
      canvasWidth: ctx.width,
      canvasHeight: ctx.height,
      isRtl: ctx.copyBlocks.some((b) => b.script === 'arabic'),
      exemplars: retrieveExemplarsV3({ text: briefSummary, width: ctx.width, height: ctx.height }),
      logoAspect: ctx.logoAspect || 1.0,
      reference: ctx.reference,
    });

    return v3Result.layouts.map((rawLayout, i) => {
      const layout = prepareGeneratedLayoutV3(rawLayout, copy, {
        width: ctx.width,
        height: ctx.height,
        logoAspect: ctx.logoAspect,
        palette: ctx.referencePack.palette,
        background: ctx.requestedBackground,
        ornament: ctx.ornament,
        style: ctx.style,
      });
      const existing = existingCandidates?.find((c) => c.ordinal === i);
      return {
        id: existing?.id || randomUUID(),
        ordinal: i,
        concept: conceptFromV3Candidate(v3Result.rawCandidates[i], layout, i, v3Result.layouts.length),
        layouts: [layout],
        currentLayout: layout,
        critiques: [],
        status: 'draft' as const,
      };
    });
  }

  const systemPrompt = buildP0SystemPrompt({
    referencePackJson: JSON.stringify(ctx.referencePack),
    promotedRules: ctx.promotedRules || 'None',
  });

  const shortEdge = Math.min(ctx.width, ctx.height);
  const marginPx = Math.round(shortEdge * 0.06);
  const bodyMinPx = Math.max(12, Math.round(ctx.width * 0.016));
  const logoMinPx = Math.max(100, Math.round(ctx.width * 0.08));
  const logoAspect = ctx.logoAspect || 1.0; // Official KAAE emblem aspect ratio (2687x2687 = 1.000)

  const copyBlocksFormatted = ctx.copyBlocks
    .map((b, i) => `[Index ${i} - ${b.script}]: "${b.text.replace(/"/g, '\\"')}"`)
    .join('\n');

  const candidates: CandidateState[] = [];

  for (let ordinal = 0; ordinal < concepts.length; ordinal++) {
    const concept = concepts[ordinal];
    const userPrompt = buildP3Prompt({
      conceptId: concept.id,
      creativeBriefJson: JSON.stringify(brief),
      conceptJson: JSON.stringify(concept),
      width: ctx.width,
      height: ctx.height,
      marginPx,
      bodyMinPx,
      logoMinPx,
      logoAspect,
      palette: ctx.referencePack.palette.join(', '),
      latinFont: ctx.latinFont,
      arabicFont: ctx.arabicFont,
      copyBlocks: copyBlocksFormatted,
    });

    let layoutResponse = await ctx.client.completeJson<{ layout: StudioLayoutV2; notes?: string }>({
      system: systemPrompt,
      prompt: userPrompt,
      schema: LAYOUT_SCHEMA,
      schemaName: 'StudioLayoutV2Output',
    });

    let layout = normalizeCandidateLayout(layoutResponse.data.layout, ctx.width, ctx.height, logoAspect);

    const validationContext: LayoutValidationContext = {
      expectedWidth: ctx.width,
      expectedHeight: ctx.height,
      copyCount: ctx.copyBlocks.length,
      copyScripts: ctx.copyBlocks.map((b) => (b.script === 'arabic' ? 'arabic' : 'latin')),
      photoCount: ctx.photos?.length ?? 0,
      reference: {
        rules: {
          fontFamily: ctx.latinFont,
          palette: ctx.referencePack.palette,
          scriptFonts: {
            arabic: ctx.arabicFont,
          },
        },
        logoAspect,
      },
      draftFont: ctx.latinFont || 'Verdana',
    };

    // Hard validate layout
    let validation = validateLayoutV2(layout, validationContext);

    // If validation fails, attempt 1 repair call
    if (!validation.ok) {
      console.warn(`[LayoutsStage] Candidate ${ordinal} failed initial validation: [${validation.code}] ${validation.message}`);
      const repairPrompt = `${userPrompt}\n\nYour previous layout failed this check:\n- [${validation.code}]: ${validation.message}\nReturn a corrected StudioLayoutV2 adhering to all constraints.`;

      layoutResponse = await ctx.client.completeJson<{ layout: StudioLayoutV2; notes?: string }>({
        system: systemPrompt,
        prompt: repairPrompt,
        schema: LAYOUT_SCHEMA,
        schemaName: 'StudioLayoutV2Output',
      });

      layout = normalizeCandidateLayout(layoutResponse.data.layout, ctx.width, ctx.height, logoAspect);
      validation = validateLayoutV2(layout, validationContext);
      if (!validation.ok) {
        console.warn(`[LayoutsStage] Candidate ${ordinal} failed repair validation: [${validation.code}] ${validation.message}`);
      }
    }

    if (validation.ok) {
      const existing = existingCandidates?.find((c) => c.ordinal === ordinal);
      candidates.push({
        id: existing?.id || randomUUID(),
        ordinal,
        concept,
        layouts: [layout],
        currentLayout: layout,
        critiques: [],
        status: 'draft',
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error('All proposed concept layouts failed validation');
  }

  return candidates;
}

/**
 * The design brief the v3 generator reads. The client's own words and the brief's musts reach it:
 * it used to get only the occasion, audience and tone, so "dark blue navy as a background" never
 * did, and two of three cheap-tier candidates came back cream and white (task 3c3a422b, 2026-09-18).
 */
/** The enforced style decisions, told to the generator so its layouts start close to them. */
function styleSummary(style: StageContext['style']): string {
  if (!style) return '';
  const set = Object.entries(style).filter(([, v]) => v !== 'as_generated' && v !== false);
  return set.length ? `Enforced style (applied after generation): ${set.map(([k, v]) => `${k}=${v}`).join(', ')}` : '';
}

/** The line that tells the layout model what photographs it has to place, and how. */
export function photosBrief(photos: StageContext['photos'] | undefined, width: number, height: number): string {
  if (!photos?.length) return '';
  const minSide = Math.round(Math.min(width, height) * 0.22);
  const list = photos
    .map((p, i) => `${i}: ${p.width && p.height ? `${p.width}x${p.height} (${p.width >= p.height ? 'landscape' : 'portrait'})` : 'size unknown'}`)
    .join('; ');
  return (
    `Client photographs to place (${photos.length}): ${list}. Each appears exactly once in photos[], as content ` +
    `(a speaker's portrait, a product), at least ${minSide}px on its short side, never under text or the logo, ` +
    `cropped by cover-fit so plan the box near the photo's aspect. Compose the copy around them; they are the point of the design.`
  );
}

export function layoutBriefV3(
  brief: Pick<CreativeBrief, 'occasion' | 'audience' | 'toneWords' | 'must'>,
  ctx: Pick<StageContext, 'instructions' | 'requestedBackground' | 'reference' | 'style' | 'photos' | 'width' | 'height'>
): string {
  return (
    [
      [brief.occasion, brief.audience, (brief.toneWords || []).join(', ')].filter(Boolean).join(' - '),
      ctx.instructions ? `Client instructions: ${ctx.instructions.replace(/"/g, "'")}` : '',
      brief.must?.length ? `Must: ${brief.must.join('; ')}` : '',
      ctx.requestedBackground ? `Background: ${ctx.requestedBackground}, as the client asked` : '',
      ctx.reference ? `Client reference image (attached): ${ctx.reference.notes || 'follow its design'}` : '',
      photosBrief(ctx.photos, ctx.width, ctx.height),
      styleSummary(ctx.style),
    ]
      .filter(Boolean)
      .join('\n') || 'Official Institutional Communication'
  );
}
