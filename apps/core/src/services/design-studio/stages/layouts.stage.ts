import { randomUUID } from 'node:crypto';
import type { StageContext, CreativeBrief, Concept, CandidateState } from '../types.js';
import {
  validateLayoutV2,
  type LayoutValidationContext,
  type StudioLayoutV2,
  generateLayoutCandidatesV3,
  type CopyBlockSlotInput,
} from '@hawa/creative';
import { buildP0SystemPrompt, buildP3Prompt } from '../prompts.js';

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
      },
      required: ['version', 'width', 'height', 'grid', 'background', 'shapes', 'text', 'logo'],
      additionalProperties: false,
    },
    notes: { type: 'string' },
  },
  required: ['layout'],
  additionalProperties: false,
};

export function normalizeCandidateLayout(
  lyt: any,
  width: number,
  height: number,
  logoAspect: number = 1.0
): StudioLayoutV2 {
  if (!lyt) lyt = {};
  if (!lyt.shapes) lyt.shapes = [];
  if (!lyt.text) lyt.text = [];
  if (!lyt.width) lyt.width = width;
  if (!lyt.height) lyt.height = height;

  const shortEdge = Math.min(width, height);
  const minSafeMargin = Math.floor(0.06 * shortEdge);
  if (!lyt.grid) {
    lyt.grid = {
      margin: minSafeMargin,
      columns: 12,
      gutter: 16,
      baseline: 8,
    };
  } else {
    lyt.grid.margin = Math.max(minSafeMargin, lyt.grid.margin || minSafeMargin);
  }

  if (!lyt.logo) {
    const logoMinPx = Math.max(100, Math.round(width * 0.08));
    lyt.logo = {
      x: Math.round(width / 2 - logoMinPx / 2),
      y: lyt.grid.margin,
      width: logoMinPx,
      height: Math.round(logoMinPx / logoAspect),
    };
  } else {
    lyt.logo.width = Math.max(100, lyt.logo.width || 100);
    lyt.logo.height = Math.round(lyt.logo.width / logoAspect);
    const maxLogoX = width - lyt.grid.margin - lyt.logo.width;
    const maxLogoY = height - lyt.grid.margin - lyt.logo.height;
    lyt.logo.x = Math.max(lyt.grid.margin, Math.min(lyt.logo.x ?? lyt.grid.margin, maxLogoX));
    lyt.logo.y = Math.max(lyt.grid.margin, Math.min(lyt.logo.y ?? lyt.grid.margin, maxLogoY));
  }

  if (lyt.art) {
    if (!lyt.art.box) {
      lyt.art.box = { x: 0, y: 0, width: lyt.width, height: lyt.height };
    }
    if (!lyt.art.calmRegion) {
      lyt.art.calmRegion = { ...lyt.art.box };
    }
  }

  const minBodyPx = Math.ceil(0.016 * width);
  for (const t of lyt.text) {
    if (t.role === 'body') t.fontSize = Math.max(t.fontSize || 0, minBodyPx);
    else if (t.role === 'footer') t.fontSize = Math.max(t.fontSize || 0, 12);
    else t.fontSize = Math.max(t.fontSize || 0, 12);

    const maxTextX = width - lyt.grid.margin - t.width;
    const maxTextY = height - lyt.grid.margin - t.height;
    if (maxTextX >= lyt.grid.margin) {
      t.x = Math.max(lyt.grid.margin, Math.min(t.x ?? lyt.grid.margin, maxTextX));
    }
    if (maxTextY >= lyt.grid.margin) {
      t.y = Math.max(lyt.grid.margin, Math.min(t.y ?? lyt.grid.margin, maxTextY));
    }
  }

  const roleSizes: Record<string, number> = {};
  for (const t of lyt.text) {
    roleSizes[t.role] = Math.max(roleSizes[t.role] || 0, t.fontSize);
  }
  const titleSize = roleSizes['title'];
  const subtitleSize = roleSizes['subtitle'];
  const dateVenueSize = Math.max(roleSizes['date'] || 0, roleSizes['venue'] || 0);
  if (titleSize && subtitleSize && dateVenueSize && subtitleSize < dateVenueSize && titleSize > dateVenueSize) {
    for (const t of lyt.text) {
      if (t.role === 'subtitle') {
        t.fontSize = dateVenueSize;
      }
    }
  }

  const checkBoxesIntersect = (a: any, b: any) =>
    !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

  lyt.shapes = (lyt.shapes || []).map((s: any) => {
    if (s.role === 'frame') return { ...s, role: 'panel' };
    return s;
  }).filter((s: any) => {
    if (s.role === 'panel') return true;
    const hitsText = lyt.text.some((t: any) => checkBoxesIntersect(s, t));
    const hitsLogo = lyt.logo ? checkBoxesIntersect(s, lyt.logo) : false;
    return !hitsText && !hitsLogo;
  });

  return lyt as StudioLayoutV2;
}

export async function runLayoutsStage(
  ctx: StageContext,
  brief: CreativeBrief,
  concepts: Concept[],
  existingCandidates?: Array<{ id: string; ordinal: number }>
): Promise<CandidateState[]> {
  if (process.env.DESIGN_PIPELINE_V3 === 'on') {
    try {
      const copyBlockSlots: CopyBlockSlotInput[] = ctx.copyBlocks.map((b, i) => {
        const roleEntry = brief.roles?.find((r) => r.copyIndex === i);
        return {
          index: i,
          text: b.text,
          role: (roleEntry?.role as any) || (i === 0 ? 'title' : 'body'),
          script: b.script === 'arabic' ? 'arabic' : 'latin',
        };
      });

      const briefSummary =
        [brief.occasion, brief.audience, (brief.toneWords || []).join(', ')].filter(Boolean).join(' - ') ||
        ctx.instructions ||
        'Official Institutional Communication';

      const v3Result = await generateLayoutCandidatesV3({
        client: ctx.client as any,
        brief: briefSummary,
        copyBlocks: copyBlockSlots,
        palette: ctx.referencePack.palette,
        canvasWidth: ctx.width,
        canvasHeight: ctx.height,
        isRtl: ctx.copyBlocks.some((b) => b.script === 'arabic'),
      });

      if (v3Result.layouts.length > 0) {
        return v3Result.layouts.map((rawLayout, i) => {
          const layout = normalizeCandidateLayout(rawLayout, ctx.width, ctx.height, ctx.logoAspect || 1.0);
          const existing = existingCandidates?.find((c) => c.ordinal === i);
          const raw = v3Result.rawCandidates[i];
          const concept: Concept = concepts[i] || {
            id: raw?.id || `v3-concept-${i}`,
            title: raw?.conceptTitle || `Archetype: ${raw?.compositionArchetype || i}`,
            rationale: `Research-grade layout archetype: ${raw?.compositionArchetype}`,
            visualMetaphor: raw?.compositionArchetype || 'institutional_dignity',
            motif: (raw?.art?.motif as any) || 'thin-rules',
            artPrompt: raw?.art?.prompt || undefined,
          };
          return {
            id: existing?.id || randomUUID(),
            ordinal: i,
            concept,
            layouts: [layout],
            currentLayout: layout,
            critiques: [],
            status: 'draft' as const,
          };
        });
      }
    } catch (v3Err) {
      console.warn('[LayoutsStage] v3 layout generation failed, falling back to sequential stage:', v3Err);
    }
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
