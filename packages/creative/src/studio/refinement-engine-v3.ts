import { measureWrappedLines, type RenderLayoutOptions } from './render-layout-v2.js';
import type { ClientReference } from './client-reference.js';
import { assertModelAllowed, resolveModel } from '@hawa/domain';
import type { StudioLayoutV2, TextElement, ShapeElement } from './layout-v2.js';
import {
  evaluateDesignMetrics,
  type DesignMetricsReport,
} from './design-metrics.js';
import {
  generateBoxGroundedCritique,
  type CritiqueComment,
} from './box-critique-v3.js';
import {
  OpenAiStudioClient,
  type OpenAiMessage,
} from './openai-studio-client.js';

export const CALIBRATED_BAND_MIN = 0.85;

export interface RefinementGateDecision {
  shouldRefine: boolean;
  reason: string;
}

export interface RefinementRoundRecord {
  round: number;
  critiqueComments: CritiqueComment[];
  preScore: number;
  postScore: number;
  scoreDelta: number;
  preFailingMetrics: string[];
  postFailingMetrics: string[];
  repairedLayout: StudioLayoutV2;
  changesAttributed: Array<{ boxId: string; description: string }>;
  stopReason?: string;
  /** The round's two calls combined. Kept for older readers; use `calls` for a ledger. */
  receipt?: {
    model: string;
    responseId: string;
    costUsd: number;
    latencyMs: number;
  };
  /** One entry per model call in the round, with the token counts a ledger needs. */
  calls: RefinementCallReceipt[];
}

export interface RefinementCallReceipt {
  stage: 'critique' | 'repair';
  model: string;
  responseId: string;
  xRequestId: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface RefinementCandidateResult {
  candidateId: string | number;
  initialLayout: StudioLayoutV2;
  finalLayout: StudioLayoutV2;
  initialScore: number;
  finalScore: number;
  scoreDelta: number;
  roundsRun: number;
  gateDecision: 'skip' | 'refine';
  stopReason: string;
  rounds: RefinementRoundRecord[];
  passed: boolean;
}

export interface RefineOptions {
  client?: OpenAiStudioClient;
  openaiApiKey?: string;
  fetchFn?: typeof fetch;
  maxRounds?: number;
  minDelta?: number;
  model?: string;
  /**
   * The copy each block will carry. Without it the critique inside each round renders
   * "Sample copy block N" placeholders, so the critic judges text it will never see, and the
   * metrics fall back to box area instead of the measured lines the ranking uses.
   */
  copyText?: Record<number, string>;
  /** Explicit scoped assets used when the critique renders a candidate. */
  renderOptions?: RenderLayoutOptions;
  reference?: ClientReference;
  /**
   * Refine even when the metric gate would skip: the caller knows of a failure the metrics do not
   * see — a hard-QA defect, for instance.
   */
  force?: boolean;
  /**
   * The defects production's hard QA reports for a layout. The repair is shown them, refinement
   * continues while any remain, and a round cannot end as "repaired" until there are none —
   * before this, a design refined because QA rejected it was repaired without being told why.
   */
  issuesFor?: (layout: StudioLayoutV2) => string[];
}

export const REPAIR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    repairSummary: {
      type: 'string',
      description: 'Concise summary of geometric coordinate and sizing adjustments made to repair the layout',
    },
    layout: {
      type: 'object',
      properties: {
        version: { type: 'integer', enum: [2] },
        width: { type: 'number' },
        height: { type: 'number' },
        grid: {
          type: 'object',
          properties: {
            margin: { type: 'number' },
            columns: { type: 'number', enum: [6, 12] },
            gutter: { type: 'number' },
            baseline: { type: 'number' },
          },
          required: ['margin', 'columns', 'gutter', 'baseline'],
          additionalProperties: false,
        },
        background: {
          type: 'object',
          properties: { color: { type: 'string' } },
          required: ['color'],
          additionalProperties: false,
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
        shapes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              color: { type: 'string' },
              kind: { type: 'string', enum: ['rect', 'roundRect', 'ellipse', 'line'] },
              role: { type: 'string', enum: ['rule', 'panel', 'accent', 'frame'] },
              opacity: { type: ['number', 'null'] },
              radius: { type: ['number', 'null'] },
              strokeWidth: { type: ['number', 'null'] },
              strokeColor: { type: ['string', 'null'] },
            },
            required: [
              'x',
              'y',
              'width',
              'height',
              'color',
              'kind',
              'role',
              'opacity',
              'radius',
              'strokeWidth',
              'strokeColor',
            ],
            additionalProperties: false,
          },
        },
        text: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              copyIndex: { type: 'integer' },
              role: {
                type: 'string',
                enum: [
                  'eyebrow',
                  'title',
                  'subtitle',
                  'body',
                  'date',
                  'venue',
                  'cta',
                  'footer',
                  'other',
                ],
              },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              fontSize: { type: 'number' },
              lineHeight: { type: 'number' },
              letterSpacing: { type: 'number' },
              fontFamily: { type: 'string' },
              color: { type: 'string' },
              align: { type: 'string', enum: ['left', 'center', 'right'] },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              rtl: { type: 'boolean' },
            },
            required: [
              'copyIndex',
              'role',
              'x',
              'y',
              'width',
              'height',
              'fontSize',
              'lineHeight',
              'letterSpacing',
              'fontFamily',
              'color',
              'align',
              'bold',
              'italic',
              'rtl',
            ],
            additionalProperties: false,
          },
        },
        typeScale: {
          type: 'object',
          properties: {
            base: { type: 'number' },
            ratio: { type: 'number' },
          },
          required: ['base', 'ratio'],
          additionalProperties: false,
        },
      },
      required: [
        'version',
        'width',
        'height',
        'grid',
        'background',
        'logo',
        'shapes',
        'text',
        'typeScale',
      ],
      additionalProperties: false,
    },
  },
  required: ['repairSummary', 'layout'],
  additionalProperties: false,
};

/**
 * Gate check: A candidate is refined ONLY if it fails a P01 metric or scores below the calibrated band (0.850).
 * Pass the metrics measured with the copy (refineCandidateV3 does): without them negative space is
 * scored on declared boxes, the no-copy fallback band of the policy, not the measure the layout
 * generator is told (ADR-125).
 */
export function checkRefinementGate(
  layout: StudioLayoutV2,
  metrics?: DesignMetricsReport
): RefinementGateDecision {
  const m = metrics || evaluateDesignMetrics(layout);
  if (!m.passed) {
    return {
      shouldRefine: true,
      reason: `Failed deterministic metrics: [${m.failingMetrics.join(', ')}]`,
    };
  }
  if (m.compositeScore < CALIBRATED_BAND_MIN) {
    return {
      shouldRefine: true,
      reason: `Composite score ${m.compositeScore.toFixed(3)} is below calibrated band (${CALIBRATED_BAND_MIN})`,
    };
  }
  return {
    shouldRefine: false,
    reason: 'candidate_already_passes_all_checks',
  };
}

/**
 * Compares before and after layouts to attribute changes directly to element box IDs.
 */
export function identifyAttributedChanges(
  before: StudioLayoutV2,
  after: StudioLayoutV2,
  critiqueComments: CritiqueComment[]
): Array<{ boxId: string; description: string }> {
  const changes: Array<{ boxId: string; description: string }> = [];

  // Check Logo (B0)
  if (
    before.logo.x !== after.logo.x ||
    before.logo.y !== after.logo.y ||
    before.logo.width !== after.logo.width ||
    before.logo.height !== after.logo.height
  ) {
    changes.push({
      boxId: 'B0',
      description: `Logo shifted from (${before.logo.x},${before.logo.y},${before.logo.width}x${before.logo.height}) to (${after.logo.x},${after.logo.y},${after.logo.width}x${after.logo.height})`,
    });
  }

  // Check Text elements (B1..Bn)
  for (let i = 0; i < before.text.length; i++) {
    const tPre = before.text[i];
    const tPost = after.text.find((t) => t.copyIndex === tPre.copyIndex) || after.text[i];
    if (tPost) {
      const boxId = `B${i + 1}`;
      const diffs: string[] = [];
      if (tPre.x !== tPost.x) diffs.push(`x: ${tPre.x}->${tPost.x}`);
      if (tPre.y !== tPost.y) diffs.push(`y: ${tPre.y}->${tPost.y}`);
      if (tPre.width !== tPost.width) diffs.push(`w: ${tPre.width}->${tPost.width}`);
      if (tPre.height !== tPost.height) diffs.push(`h: ${tPre.height}->${tPost.height}`);
      if (tPre.fontSize !== tPost.fontSize) diffs.push(`font: ${tPre.fontSize}->${tPost.fontSize}`);
      if (diffs.length > 0) {
        changes.push({
          boxId,
          description: `Text [${tPre.role}] adjusted: ${diffs.join(', ')}`,
        });
      }
    }
  }

  // Check Shape elements
  const shapeOffset = 1 + before.text.length;
  for (let j = 0; j < before.shapes.length; j++) {
    const sPre = before.shapes[j];
    const sPost = after.shapes[j];
    if (sPost) {
      const boxId = `B${shapeOffset + j}`;
      const diffs: string[] = [];
      if (sPre.x !== sPost.x) diffs.push(`x: ${sPre.x}->${sPost.x}`);
      if (sPre.y !== sPost.y) diffs.push(`y: ${sPre.y}->${sPost.y}`);
      if (sPre.width !== sPost.width) diffs.push(`w: ${sPre.width}->${sPost.width}`);
      if (sPre.height !== sPost.height) diffs.push(`h: ${sPre.height}->${sPost.height}`);
      if (diffs.length > 0) {
        changes.push({
          boxId,
          description: `Shape [${sPre.role || sPre.kind}] adjusted: ${diffs.join(', ')}`,
        });
      }
    }
  }

  return changes;
}

/**
 * Gated Refinement Engine (arXiv:2607.26922):
 * Refines a layout ONLY if it fails P01 or falls below calibrated band.
 * Stops on pass, max rounds (2), or plateau (improvement < 0.02).
 */
export async function refineCandidate(
  candidateId: string | number,
  layout: StudioLayoutV2,
  options: RefineOptions = {}
): Promise<RefinementCandidateResult> {
  const model = options.model || resolveModel('layout');
  assertModelAllowed(model);

  const maxRounds = options.maxRounds || 2;
  const minDelta = options.minDelta !== undefined ? options.minDelta : 0.02;

  const copyText = options.copyText;
  const measure = (l: StudioLayoutV2) =>
    evaluateDesignMetrics(l, copyText ? { wrappedLines: measureWrappedLines(l, copyText) } : {});

  // 1. Gating Check
  const initialMetrics = measure(layout);
  const gate = checkRefinementGate(layout, initialMetrics);

  if (!gate.shouldRefine && !options.force) {
    return {
      candidateId,
      initialLayout: layout,
      finalLayout: layout,
      initialScore: initialMetrics.compositeScore,
      finalScore: initialMetrics.compositeScore,
      scoreDelta: 0,
      roundsRun: 0,
      gateDecision: 'skip',
      stopReason: gate.reason,
      rounds: [],
      passed: initialMetrics.passed,
    };
  }

  // 2. Prepare client
  const client =
    options.client ||
    new OpenAiStudioClient({
      apiKey: options.openaiApiKey || process.env.OPENAI_API_KEY,
      fetcher: options.fetchFn,
      primaryModel: model,
    });

  let currentLayout = layout;
  let currentMetrics = initialMetrics;
  let currentScore = initialMetrics.compositeScore;
  const rounds: RefinementRoundRecord[] = [];
  let stopReason = 'max_rounds_reached';

  // 3. Iterative Refinement Loop
  for (let r = 1; r <= maxRounds; r++) {
    // a. Obtain box-grounded visual critique
    const critiqueResult = await generateBoxGroundedCritique(currentLayout, {
      reference: options.reference,
      client,
      deterministicMetrics: currentMetrics,
      model,
      detail: 'low',
      renderOptions: { ...options.renderOptions, ...(copyText ? { copyText } : {}) },
    });

    const issues = options.issuesFor ? options.issuesFor(currentLayout) : [];
    if (critiqueResult.comments.length === 0 && issues.length === 0) {
      stopReason = 'no_critique_comments_to_address';
      break;
    }

    // b. Construct Repair Prompt
    const systemPrompt = `You are a precision layout refinement specialist.
Your task is to repair a failing poster layout by applying specific box-grounded critique suggestions while maintaining design harmony.
Strict requirements:
- Directly fix the issues cited by the critic comments (e.g. shift coordinates, align with column grid, resize boxes to fix proportion/whitespace).
- Do NOT change text copy, wording, or colors.
- Ensure all coordinates stay within canvas bounds (${currentLayout.width}x${currentLayout.height}) and snap to margins (${currentLayout.grid.margin}px).${
      currentLayout.photos?.length
        ? `\n- The client's photographs are fixed and stay where they are: ${currentLayout.photos
            .map((p) => `photo ${p.photoIndex} at x=${p.x} y=${p.y} ${p.width}x${p.height}`)
            .join('; ')}. Never place or move text, shapes or the logo onto them.`
        : ''
    }
- Return the complete repaired layout matching the StudioLayoutV2 JSON schema.`;

    const userPrompt = `CURRENT FAILING LAYOUT:
\`\`\`json
${JSON.stringify(currentLayout, null, 2)}
\`\`\`

DETERMINISTIC EVALUATION GROUND TRUTH:
- Composite Score: ${currentMetrics.compositeScore.toFixed(3)}
- Failing Metrics: [${currentMetrics.failingMetrics.join(', ')}]

BOX-GROUNDED CRITIQUE COMMENTS TO REPAIR:
${critiqueResult.comments
  .map(
    (c) =>
      `- [${c.boxId}] Category: ${c.category} (Severity: ${c.severity}): ${c.issue}
   Suggested Fix: ${c.suggestedFix}`
  )
  .join('\n')}

${issues.length ? `
HARD QA DEFECTS (production rejects the design until every one is fixed):
${issues.map((i) => `- ${i}`).join('\n')}
` : ''}
TASK:
Produce the corrected layout repairing these exact flaws.`;

    // c. Call OpenAI Structured Output for repair
    const repairResponse = await client.createStructuredCompletion<{
      repairSummary: string;
      layout: StudioLayoutV2;
    }>({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      jsonSchema: {
        name: 'layout_v3_repair',
        schema: REPAIR_JSON_SCHEMA,
        strict: true,
      },
      reasoningEffort: 'low',
      maxTokens: 3500,
    });

    const repairedData = repairResponse.data;
    if (!repairedData || !repairedData.layout) {
      throw new Error(`Refinement round ${r} returned invalid repair payload`);
    }

    // Retain art config if present on current layout
    const repairedLayout: StudioLayoutV2 = {
      ...repairedData.layout,
      art: currentLayout.art ? { ...currentLayout.art } : undefined,
      // The repair schema has no photographs; they are fixed and carried through as they were.
      ...(currentLayout.photos?.length ? { photos: currentLayout.photos.map((p) => ({ ...p })) } : {}),
    };
    const onPhoto = (repairedLayout.photos || []).some((p) =>
      [...(Array.isArray(repairedLayout.text) ? repairedLayout.text : []), ...(repairedLayout.logo ? [repairedLayout.logo] : [])].some(
        (b) => b.x < p.x + p.width && b.x + b.width > p.x && b.y < p.y + p.height && b.y + b.height > p.y
      )
    );
    if (onPhoto) {
      console.warn(`[refinement-engine-v3] Round ${r} put text or the logo on a client photograph; keeping the last good layout.`);
      stopReason = 'repair_covered_a_photo';
      break;
    }

    // A repair that is not a usable layout must not become the result: this engine returns
    // finalLayout to its callers. (The "layout.text is not iterable" seen live was most likely the
    // qualification runner passing its options object as the layout — a shifted argument no build
    // type-checked — but a model can return an unusable layout too, so the guard stays.) Keep the
    // last good layout and stop refining instead.
    if (
      !Array.isArray(repairedLayout.text) ||
      repairedLayout.text.length === 0 ||
      !Array.isArray(repairedLayout.shapes) ||
      !Number.isFinite(repairedLayout.width) ||
      !Number.isFinite(repairedLayout.height)
    ) {
      console.warn(
        `[refinement-engine-v3] Round ${r} returned a layout without usable text or geometry; ` +
          `keeping the last good layout and stopping refinement.`
      );
      stopReason = 'repair_returned_unusable_layout';
      break;
    }

    // d. Re-evaluate P01 deterministic metrics
    const postMetrics = measure(repairedLayout);
    const postScore = postMetrics.compositeScore;
    const delta = Number((postScore - currentScore).toFixed(4));
    const changesAttributed = identifyAttributedChanges(
      currentLayout,
      repairedLayout,
      critiqueResult.comments
    );

    const roundRecord: RefinementRoundRecord = {
      round: r,
      critiqueComments: critiqueResult.comments,
      preScore: currentScore,
      postScore,
      scoreDelta: delta,
      preFailingMetrics: currentMetrics.failingMetrics,
      postFailingMetrics: postMetrics.failingMetrics,
      repairedLayout,
      changesAttributed,
      receipt: {
        model: repairResponse.receipt.model,
        responseId: repairResponse.receipt.responseId,
        costUsd: repairResponse.receipt.costUsd + critiqueResult.receipt.costUsd,
        latencyMs: repairResponse.receipt.latencyMs + critiqueResult.receipt.latencyMs,
      },
      calls: [
        {
          stage: 'critique',
          model: critiqueResult.receipt.model,
          responseId: critiqueResult.receipt.responseId,
          xRequestId: critiqueResult.receipt.xRequestId ?? null,
          inputTokens: critiqueResult.receipt.inputTokens,
          cachedTokens: critiqueResult.receipt.cachedTokens ?? 0,
          outputTokens: critiqueResult.receipt.outputTokens,
          costUsd: critiqueResult.receipt.costUsd,
          latencyMs: critiqueResult.receipt.latencyMs,
        },
        {
          stage: 'repair',
          model: repairResponse.receipt.model,
          responseId: repairResponse.receipt.responseId,
          xRequestId: repairResponse.receipt.xRequestId ?? null,
          inputTokens: repairResponse.receipt.inputTokens,
          cachedTokens: repairResponse.receipt.cacheReadTokens ?? 0,
          outputTokens: repairResponse.receipt.outputTokens,
          costUsd: repairResponse.receipt.costUsd,
          latencyMs: repairResponse.receipt.latencyMs,
        },
      ],
    };

    rounds.push(roundRecord);

    currentLayout = repairedLayout;
    currentMetrics = postMetrics;
    currentScore = postScore;

    // e. Stop Condition 1: Repaired and passed everything
    if (postMetrics.passed && postScore >= CALIBRATED_BAND_MIN && (!options.issuesFor || options.issuesFor(repairedLayout).length === 0)) {
      stopReason = 'repaired_and_passed';
      roundRecord.stopReason = stopReason;
      break;
    }

    // f. Stop Condition 2: Plateau stop (delta < 0.02)
    if (delta < minDelta) {
      stopReason = `plateau_detected_delta_under_${minDelta.toFixed(2)}`;
      roundRecord.stopReason = stopReason;
      break;
    }
  }

  const totalDelta = Number((currentScore - initialMetrics.compositeScore).toFixed(4));

  return {
    candidateId,
    initialLayout: layout,
    finalLayout: currentLayout,
    initialScore: initialMetrics.compositeScore,
    finalScore: currentScore,
    scoreDelta: totalDelta,
    roundsRun: rounds.length,
    gateDecision: 'refine',
    stopReason,
    rounds,
    passed: currentMetrics.passed,
  };
}
