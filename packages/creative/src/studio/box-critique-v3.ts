import { clientReferenceInstruction, clientReferencePart, type ClientReference } from './client-reference.js';
import { assertModelAllowed, resolveModel } from '@hawa/domain';
import { renderAnnotatedLayoutV2, type ElementBoxAnnotation, type RenderLayoutOptions, measureWrappedLines } from './render-layout-v2.js';
import {
  evaluateDesignMetrics,
  type DesignMetricsReport,
} from './design-metrics.js';
import type { StudioLayoutV2 } from './layout-v2.js';
import {
  OpenAiStudioClient,
  type OpenAiMessage,
} from './openai-studio-client.js';

export type CritiqueCategory =
  | 'placement'
  | 'alignment'
  | 'proportion'
  | 'hierarchy'
  | 'whitespace';

export type CritiqueSeverity = 'high' | 'medium' | 'low';

export interface CritiqueComment {
  boxId: string;
  category: CritiqueCategory;
  issue: string;
  severity: CritiqueSeverity;
  suggestedFix: string;
}

export interface BoxCritiqueResult {
  status: 'success' | 'filtered';
  comments: CritiqueComment[];
  rejectedComments: Array<{ comment: any; reason: string }>;
  overallAssessment: string;
  deterministicMetrics: DesignMetricsReport;
  annotatedPng: Buffer;
  annotations: ElementBoxAnnotation[];
  receipt: {
    model: string;
    responseId: string;
    xRequestId: string | null;
    inputTokens: number;
    cachedTokens?: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
  };
}

export interface GenerateBoxCritiqueOptions {
  /** The client's style reference: the critique says where the design departs from it. */
  reference?: ClientReference;
  client?: OpenAiStudioClient;
  openaiApiKey?: string;
  fetchFn?: typeof fetch;
  annotatedPng?: Buffer;
  renderOptions?: RenderLayoutOptions;
  deterministicMetrics?: DesignMetricsReport;
  model?: string;
  detail?: 'low' | 'high';
}

const FORBIDDEN_SCOPE_REGEX =
  /\b(colou?r|palette|contrast|darker|lighter|hex|wording|copy|spelling|grammar|rewrite|phrase|phrasing|font\s*family|translation)\b/i;

export const CRITIQUE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    overallAssessment: {
      type: 'string',
      description: 'Brief spatial and typographic structure critique summary (1-2 sentences)',
    },
    comments: {
      type: 'array',
      description: 'List of box-grounded critique comments citing specific element box IDs',
      items: {
        type: 'object',
        properties: {
          boxId: {
            type: 'string',
            description: 'The exact box identifier from the Set-of-Mark catalog (e.g. B0, B1, B2)',
          },
          category: {
            type: 'string',
            enum: ['placement', 'alignment', 'proportion', 'hierarchy', 'whitespace'],
            description: 'The structural category of the issue',
          },
          issue: {
            type: 'string',
            description: 'Specific description of the geometric or typographic spatial flaw',
          },
          severity: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Severity level of the flaw',
          },
          suggestedFix: {
            type: 'string',
            description: 'Actionable coordinate or dimension shift recommendation to repair the layout',
          },
        },
        required: ['boxId', 'category', 'issue', 'severity', 'suggestedFix'],
        additionalProperties: false,
      },
    },
  },
  required: ['overallAssessment', 'comments'],
  additionalProperties: false,
};

export function filterCritiqueComments(
  rawComments: any[],
  validBoxIds: Set<string>
): { accepted: CritiqueComment[]; rejected: Array<{ comment: any; reason: string }> } {
  const accepted: CritiqueComment[] = [];
  const rejected: Array<{ comment: any; reason: string }> = [];

  for (const c of rawComments) {
    if (!c || typeof c !== 'object') {
      rejected.push({ comment: c, reason: 'Malformed comment object' });
      continue;
    }

    if (!validBoxIds.has(c.boxId)) {
      rejected.push({
        comment: c,
        reason: `Invalid boxId '${c.boxId}'. Must be one of: ${Array.from(validBoxIds).join(', ')}`,
      });
      continue;
    }

    const allowedCategories = ['placement', 'alignment', 'proportion', 'hierarchy', 'whitespace'];
    if (!allowedCategories.includes(c.category)) {
      rejected.push({
        comment: c,
        reason: `Invalid category '${c.category}'. Must be one of: ${allowedCategories.join(', ')}`,
      });
      continue;
    }

    // Check forbidden scope: colour, copy, wording
    const textToCheck = `${c.category} ${c.issue} ${c.suggestedFix}`;
    const forbiddenMatch = textToCheck.match(FORBIDDEN_SCOPE_REGEX);
    if (forbiddenMatch) {
      rejected.push({
        comment: c,
        reason: `Violated scope restriction: comments regarding '${forbiddenMatch[0]}' are prohibited. Scope is restricted to placement, alignment, proportion, hierarchy, and whitespace.`,
      });
      continue;
    }

    accepted.push({
      boxId: c.boxId,
      category: c.category,
      issue: c.issue,
      severity: c.severity || 'medium',
      suggestedFix: c.suggestedFix,
    });
  }

  return { accepted, rejected };
}

/**
 * Generates an annotated render and performs a box-grounded visual critique
 * using gpt-6-astra with Set-of-Mark visual prompting and deterministic facts first.
 */
let warnedPlaceholderCritique = false;

export async function generateBoxGroundedCritique(
  layout: StudioLayoutV2,
  options: GenerateBoxCritiqueOptions = {}
): Promise<BoxCritiqueResult> {
  const model = options.model || resolveModel('critique');
  assertModelAllowed(model);

  // 1. Evaluate deterministic design metrics (Facts First)
  const deterministicMetrics =
    options.deterministicMetrics ||
    evaluateDesignMetrics(layout, {
      // Score the type, not the boxes — and the band travels with the measure.
      wrappedLines: options.renderOptions?.copyText
        ? measureWrappedLines(layout, options.renderOptions.copyText, options.renderOptions)
        : undefined,
    });

  // 2. Generate annotated debug render (Set-of-Mark style)
  let annotatedPng = options.annotatedPng;
  let annotations: ElementBoxAnnotation[];
  if (!annotatedPng) {
    if (!options.renderOptions?.copyText && !warnedPlaceholderCritique) {
      warnedPlaceholderCritique = true;
      console.warn(
        '[box-critique-v3] Rendering without the copy: the critic will see "Sample copy block N" ' +
          'placeholders, not the design. Pass renderOptions.copyText.'
      );
    }
    const rendered = renderAnnotatedLayoutV2(layout, options.renderOptions);
    annotatedPng = rendered.png;
    annotations = rendered.annotations;
  } else {
    const { getLayoutBoxAnnotations } = await import('./render-layout-v2.js');
    annotations = getLayoutBoxAnnotations(layout);
  }

  const validBoxIds = new Set(annotations.map((a) => a.boxId));

  // 3. Prepare client
  const client =
    options.client ||
    new OpenAiStudioClient({
      apiKey: options.openaiApiKey || process.env.OPENAI_API_KEY,
      fetcher: options.fetchFn,
      primaryModel: model,
    });

  // 4. Construct Prompts
  const systemPrompt = `You are a world-class institutional poster layout critic specializing in spatial composition, typographic hierarchy, and visual balance.
Your task is to analyze an annotated layout render where every structural element is tagged with a bounding box and an identifier (e.g. [B0], [B1], [B2], etc.) in Set-of-Mark style.

CRITICAL SCOPE RESTRICTION:
You are restricted EXCLUSIVELY to spatial and typographic geometry:
- placement (canvas positions, margins, edge bleed)
- alignment (edge alignment, column snapping, centering)
- proportion (element box widths, heights, scaling)
- hierarchy (visual dominance, spacing between title/subtitle/body/footer)
- whitespace (margins, padding, breathing room, crowding)

STRICT PROHIBITIONS:
- You must NEVER comment on colour, palette, contrast, darkness, or lightness.
- You must NEVER comment on copy wording, spelling, grammar, language, or phrasing.
- You must NEVER suggest changes to colors or copy.
Every critique comment MUST cite an exact boxId from the provided catalog.`;

  const factsBlock = `GROUND TRUTH DETERMINISTIC METRICS (arXiv:2402.06945 & LaySPA):
- Composite Score: ${deterministicMetrics.compositeScore.toFixed(3)} (Pass Threshold >= 0.850, Overall Passed: ${deterministicMetrics.passed})
- Failing Metrics: [${deterministicMetrics.failingMetrics.join(', ')}]
- Individual Metric Measurements:
${Object.entries(deterministicMetrics.metrics)
  .map(
    ([name, m]) =>
      `  * ${name}: score ${m.score.toFixed(3)} (pass: ${m.passed})`
  )
  .join('\n')}

ELEMENT BOX CATALOG (Set-of-Mark Marks on the Image):
${annotations
  .map(
    (a) =>
      `- [${a.boxId}] Role: ${a.role}, Box: { x: ${a.box.x}, y: ${a.box.y}, width: ${a.box.width}, height: ${a.box.height} }${
        a.copyIndex !== undefined ? `, copyIndex: ${a.copyIndex}` : ''
      }`
  )
  .join('\n')}

CANVAS GEOMETRY:
- Width: ${layout.width}px, Height: ${layout.height}px
- Grid: margin=${layout.grid.margin}px, columns=${layout.grid.columns}, gutter=${layout.grid.gutter}px, baseline=${layout.grid.baseline}px

TASK:
Inspect the attached annotated render at detail 'low'. Cross-examine the visual image against the deterministic metrics stated above.
Identify any spatial, alignment, margin, or hierarchy defects and return actionable critique comments referencing the exact box IDs.`;

  const b64Image = `data:image/png;base64,${annotatedPng.toString('base64')}`;

  const messages: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: options.reference ? `${factsBlock}\n\n${clientReferenceInstruction(options.reference)} Report where the design departs from it as comments.` : factsBlock },
        {
          type: 'image_url',
          image_url: {
            url: b64Image,
            detail: options.detail || 'low',
          },
        },
        ...(options.reference ? [clientReferencePart(options.reference)] : []),
      ],
    },
  ];

  // 5. Call gpt-6-astra via structured completion
  const response = await client.createStructuredCompletion<{
    overallAssessment: string;
    comments: CritiqueComment[];
  }>({
    model,
    messages,
    jsonSchema: {
      name: 'DesignCritiqueReport',
      schema: CRITIQUE_JSON_SCHEMA,
      strict: true,
    },
    reasoningEffort: 'low',
    maxTokens: 1500,
  });

  const rawData = response.data || { overallAssessment: '', comments: [] };
  const { accepted, rejected } = filterCritiqueComments(rawData.comments || [], validBoxIds);

  return {
    status: rejected.length > 0 ? 'filtered' : 'success',
    comments: accepted,
    rejectedComments: rejected,
    overallAssessment: rawData.overallAssessment || '',
    deterministicMetrics,
    annotatedPng,
    annotations,
    receipt: {
      model: response.receipt.model,
      responseId: response.receipt.responseId,
      xRequestId: response.receipt.xRequestId ?? null,
      inputTokens: response.receipt.inputTokens,
      cachedTokens: (response.receipt as any).cacheReadTokens ?? 0,
      outputTokens: response.receipt.outputTokens,
      costUsd: response.receipt.costUsd,
      latencyMs: response.receipt.latencyMs,
    },
  };
}
