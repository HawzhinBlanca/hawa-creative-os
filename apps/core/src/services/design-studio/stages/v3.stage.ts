import {
  rankCandidatesV3,
  refineCandidateV3,
  selectWinnerV3,
  eligibleCandidatesV3,
  type PipelineV3Copy,
  type RankedCandidateV3,
  type BoxCritiqueResult,
  type CritiqueComment,
  type RefinementOutcomeV3,
  type WinnerSelectionV3,
  type NormalizedLayoutCandidate,
  type StudioLayoutV2,
  type HardQaContext,
  type BriefBoundJudgeBrief,
  type StudioJudgeProtocol,
  photoSelectionFromInstructions,
  reviewCandidateVisuallyV3,
  applyVisualReviewV3,
  conformReviewedLayoutV3,
  decideVisualRefinementV3,
  judgeRefinementV3,
  layoutSha256,
  type VisualReviewResult,
  type VisualReviewSettings,
  type AppliedVisualFix,
  type VisualRefinementDecision,
  StudioArtAccountingError,
} from '@hawa/creative';
import { isModelCallHoldError, StudioBudgetExhaustedError, type StageContext, type CandidateState, type Concept, type Archetype, type MotifKind, type CreativeBrief } from '../types.js';
import { CanvaFlowError } from '../../canva-flow-error.js';
import { candidateRenderOptions } from './asset-inputs.js';
import { runRenderStage } from './render.stage.js';
import { inStudioSubstep } from '../substeps.js';
import { StudioSpendCapError } from '../spend-cap.js';

/**
 * The studio's v3 stages. Each is a thin adapter: the decisions are made by the shared functions
 * in @hawa/creative's pipeline-v3, which the qualification calls too. What lives here is only the
 * mapping between the studio's candidates and those functions.
 */

/** The v3 generator returns up to three candidates; a v3 run reserves a row for each. */
export const V3_CANDIDATE_SLOTS = 3;

/** A reserved row's concept until the generator's own archetype replaces it. */
export function pendingV3Concept(index: number): Concept {
  return {
    id: `v3-pending-${index}`,
    name: 'Awaiting v3 layout generation',
    archetype: 'editorial-centered',
    artStrategy: 'none',
    typographicScale: { ratio: 1, titleSize: 0, bodySize: 0 },
    // A placeholder until the generator's archetype replaces it: neutral, never a client's colours.
    colourRoles: { background: '#111111', title: '#FFFFFF', body: '#FFFFFF', accent: '#BDBDBD', rule: '#BDBDBD' },
    layoutIdea: 'pending',
    whyDifferent: 'pending',
  };
}

/** The copy the pipeline renders and scores with, from the run's copy blocks. */
export function copyForStageV3(ctx: Pick<StageContext, 'copyBlocks'>): PipelineV3Copy {
  const text: Record<number, string> = {};
  const scripts: Record<number, 'latin' | 'arabic'> = {};
  ctx.copyBlocks.forEach((b, i) => {
    text[i] = b.text;
    scripts[i] = b.script === 'arabic' ? 'arabic' : 'latin';
  });
  return { text, scripts };
}

/**
 * ADR-124: what the brief-bound judge is bound to — the requester's instructions, the recorded
 * brief's occasion, audience and must/mustNot, and the run's exact copy with its recorded roles.
 * The copy is the same text the candidates are rendered from; nothing is summarized or rewritten.
 */
export function judgeBriefForStageV3(
  ctx: Pick<StageContext, 'copyBlocks' | 'instructions'>,
  brief: Partial<Pick<CreativeBrief, 'occasion' | 'audience' | 'must' | 'mustNot' | 'roles'>> = {}
): BriefBoundJudgeBrief {
  // Passed through unchanged. An oversized field is refused by the judge's own bounds, visibly,
  // rather than truncated here into a brief nobody wrote.
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
  const list = (value: unknown) => Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && !!v.trim())
    : undefined;
  return {
    instructions: text(ctx.instructions),
    occasion: text(brief.occasion),
    audience: text(brief.audience),
    must: list(brief.must),
    mustNot: list(brief.mustNot),
    copy: ctx.copyBlocks.map((block, copyIndex) => {
      const role = Array.isArray(brief.roles) ? brief.roles.find((r) => r?.copyIndex === copyIndex)?.role : undefined;
      return role ? { copyIndex, text: block.text, role } : { copyIndex, text: block.text };
    }),
  };
}

/** Nearest studio archetype for each v3 archetype; the v3 name itself is kept in the concept. */
const ARCHETYPE_FOR_V3: Record<string, Archetype> = {
  monolith_centered: 'editorial-centered',
  asymmetric_editorial: 'asymmetric-grid',
  hero_statement_grid: 'typographic-poster',
  split_statutory_banner: 'split-band',
  minimal_framed: 'framed-invitation',
  stat_card_triptych: 'asymmetric-grid',
  numbered_standards_stack: 'typographic-poster',
  executive_roadmap_quad: 'asymmetric-grid',
  crest_banner_split: 'split-band',
  credential_badge_card: 'framed-invitation',
  chevron_band_institutional: 'ribbon-and-rules',
  monograph_bilateral_column: 'split-band',
  academic_citation_folio: 'editorial-centered',
  commencement_diploma_frame: 'framed-invitation',
};
const MOTIFS: MotifKind[] = ['guilloche', 'sun-rays', 'thin-rules', 'gradient-wash', 'diagonal-lines'];

/**
 * Describes a v3 candidate for the Desk from what the generator actually produced. A v3 run used
 * to label its layouts with the v2 concept stage's concepts, which the v3 generator never sees, so
 * the names and art strategies shown had nothing to do with the designs.
 */
export function conceptFromV3Candidate(
  raw: NormalizedLayoutCandidate | undefined,
  layout: StudioLayoutV2,
  index: number,
  total: number
): Concept {
  const v3Archetype = raw?.compositionArchetype || 'monolith_centered';
  const sizeOf = (role: string) => Math.max(0, ...layout.text.filter((t) => t.role === role).map((t) => t.fontSize));
  const colourOf = (role: string) => layout.text.find((t) => t.role === role)?.color;
  const shapeColour = (role: string) => layout.shapes.find((s) => s.role === role)?.color;
  const motif = raw?.art?.motif && MOTIFS.includes(raw.art.motif as MotifKind) ? (raw.art.motif as MotifKind) : undefined;
  return {
    id: raw?.id || `v3-${index}`,
    name: raw?.conceptTitle || v3Archetype.replace(/_/g, ' '),
    archetype: ARCHETYPE_FOR_V3[v3Archetype] || 'editorial-centered',
    artStrategy: layout.art ? layout.art.source : 'none',
    ...(motif ? { motif } : {}),
    // The prompt the art stage will use: preparation strips words the house bans from it.
    ...(layout.art?.prompt ? { artPrompt: layout.art.prompt } : {}),
    typographicScale: {
      ratio: raw?.typeScale?.ratio || 1.333,
      titleSize: sizeOf('title'),
      bodySize: sizeOf('body'),
    },
    colourRoles: {
      background: layout.background.color,
      title: colourOf('title') || colourOf('eyebrow') || '#FFFFFF',
      body: colourOf('body') || '#FFFFFF',
      // With no accent or rule in the layout, its title colour: never a colour the client does not use.
      accent: shapeColour('accent') || shapeColour('rule') || colourOf('title') || '#FFFFFF',
      rule: shapeColour('rule') || shapeColour('accent') || colourOf('title') || '#FFFFFF',
    },
    layoutIdea: `v3 ${v3Archetype}`,
    whyDifferent: `One of ${total} deliberately distinct v3 archetypes from a single generation`,
  };
}

/** The hard-QA context of this run: the gate its winner must pass. */
export function hardQaContextFor(
  ctx: Pick<StageContext, 'width' | 'height' | 'copyBlocks' | 'latinFont' | 'arabicFont' | 'referencePack' | 'logoAspect' | 'photos' | 'playbook'> &
    Partial<Pick<StageContext, 'instructions' | 'photoSelection'>>
): HardQaContext {
  const photoCount = ctx.photos?.length ?? 0;
  return {
    photoCount,
    // ADR-157: the brief's recorded choice, else the instructions read now; `all` when neither says.
    photoSelection: ctx.photoSelection ?? photoSelectionFromInstructions(ctx.instructions, photoCount),
    ...(ctx.instructions ? { instructions: ctx.instructions } : {}),
    ...(ctx.playbook ? { playbook: ctx.playbook } : {}),
    width: ctx.width,
    height: ctx.height,
    copyScripts: ctx.copyBlocks.map((b) => (b.script === 'arabic' ? 'arabic' : 'latin')),
    latinFont: ctx.latinFont,
    arabicFont: ctx.arabicFont,
    admittedDisplayFonts: ctx.referencePack.admittedDisplayFonts,
    palette: ctx.referencePack.palette,
    logoAspect: ctx.logoAspect || 1.0,
    logoMinimumWidthPx: (ctx.referencePack.logoConstraints as { minimumWidthPx?: number } | undefined)?.minimumWidthPx,
    logoClearSpacePx: (ctx.referencePack.logoConstraints as { clearSpacePx?: number } | undefined)?.clearSpacePx,
    copyText: copyForStageV3(ctx).text,
  };
}

/**
 * The render a candidate is judged on. It has to be `previewPng`, the full render with the copy,
 * the art and the logo drawn on it. This stage used to pass `compositePng`, which the render stage
 * fills with the *no-text* composite it keeps only to measure contrast against the real backdrop
 * (render.stage.ts sets it from renderResult.noTextPng), so every P07 vote on hierarchy,
 * typographic craft and legibility was cast on an image with no words on it.
 */
export function judgeRenderFor(
  candidate: Pick<CandidateState, 'previewPng' | 'compositePng'>
): Buffer | undefined {
  // Only the preview. Falling back to the no-text composite would cost the run its judge to the
  // guard below; with nothing here the pipeline re-renders the candidate from its layout, with the
  // copy, which is what a candidate that never reached the render stage needs.
  return candidate.previewPng || undefined;
}

/**
 * Refuses to judge on a text-less render. The defect above stayed invisible for as long as it
 * lasted because a no-text composite is a perfectly good PNG and the judge answers about it
 * happily, so the only thing that can catch its return is comparing the bytes actually handed over
 * against the candidate's own no-text composite, before any call is made. A candidate carrying no
 * render at all is left alone: the pipeline renders that one from its layout, with the copy.
 */
export function assertJudgeSeesText(
  entries: Array<{ renderedPng?: Buffer; candidate: CandidateState }>
): void {
  for (const { renderedPng, candidate } of entries) {
    const noText = candidate.compositePng;
    if (!renderedPng || !noText || !renderedPng.equals(noText)) continue;
    throw new Error(
      `P07 refused to judge candidate ${candidate.id} (ordinal ${candidate.ordinal}): the image ` +
        `handed to the judge is its no-text composite, the render kept for contrast measurement. ` +
        `Hierarchy, typographic craft and legibility cannot be judged on an image with no copy on ` +
        `it. Re-run the render stage so the candidate carries its full preview render.`
    );
  }
}

/** The studio's candidates, ranked the way the pipeline ranks them, hard QA included. */
export function rankStudioCandidatesV3(
  ctx: StageContext,
  candidates: CandidateState[]
): Array<RankedCandidateV3 & { candidate: CandidateState }> {
  const copy = copyForStageV3(ctx);
  const byOrdinal = new Map(candidates.map((c) => [c.ordinal, c]));
  return rankCandidatesV3(
    candidates.map((c) => ({
      sourceIndex: c.ordinal,
      layout: c.currentLayout,
      // The render the client will see, with art where there is art and the copy set on it.
      renderedPng: judgeRenderFor(c),
      // Its no-text composite: contrast is measured on these pixels, not only declared (ADR-157).
      ...(c.compositePng ? { compositePng: c.compositePng } : {}),
    })),
    copy,
    hardQaContextFor(ctx)
  ).map((r) => ({ ...r, candidate: byOrdinal.get(r.sourceIndex)! }));
}

/** The metric a failing name belongs to, as a critique category. */
const CATEGORY_FOR_METRIC: Record<string, CritiqueComment['category']> = {
  textLegibility: 'hierarchy',
  gridAppropriateness: 'placement',
  alignment: 'alignment',
  balance: 'whitespace',
  justification: 'alignment',
  regularity: 'placement',
  typeScale: 'proportion',
};

/**
 * The critique record, built from what the run has already measured instead of from a model call.
 *
 * P05 used to spend one call on the top-ranked candidate — $0.046 of a $0.629 design, measured over
 * 16 production runs — for a written critique that reached nobody. Three facts, each checked rather
 * than assumed:
 *
 *  - No screen shows it. The Desk's Critique tab reads `candidate.critiques`, and the v3 branch of
 *    design-studio-service never writes that column: across 60 candidates in v3 runs in the
 *    2026-09-20 snapshot, zero carry a critique. Only old v2 runs (5 of 50) ever filled it.
 *  - No later stage reads it. `runReviseStageV3` calls `refineCandidateV3` with the canvas and the
 *    QA context and nothing else; the refinement critiques for itself, on its own model role. The
 *    service's own comment already said so.
 *  - It was not carrying the score. `compositeScores` come from `rankStudioCandidatesV3`, which is
 *    deterministic and runs before the critique either way.
 *
 * So the call bought a paragraph filed in a judgment row nobody reads. The row is still written —
 * it is the run's audit trail, and its shape is what the Desk would read if the tab were ever wired
 * up — but it is filled from the hard-QA defects and failing metrics, which name the same problems
 * more precisely than prose did, and cost nothing. The receipt records no model, so the ledger
 * cannot mistake this for a call that was made.
 */
export function deterministicCritiqueV3(ranked: RankedCandidateV3): Omit<BoxCritiqueResult, 'annotatedPng'> {
  const comments: CritiqueComment[] = [];

  // Hard QA speaks first: these are the defects that would stop the design shipping.
  const qa = ranked.hardQa;
  for (const [i, code] of (qa?.defectCodes || []).entries()) {
    comments.push({
      boxId: 'layout',
      category: 'placement',
      issue: `${code}: ${qa?.messages?.[i] || 'hard QA defect'}`,
      severity: 'high',
      suggestedFix: 'Repair before transfer; hard QA refuses this layout as it stands.',
    });
  }

  // Then the measured metrics that fell short, each named with its score.
  for (const name of ranked.metrics.failingMetrics || []) {
    const metric = (ranked.metrics.metrics as Record<string, { score: number }>)[name];
    comments.push({
      boxId: 'layout',
      category: CATEGORY_FOR_METRIC[name] || 'proportion',
      issue: `${name} scores ${metric ? metric.score.toFixed(3) : 'below threshold'} and does not pass.`,
      severity: 'medium',
      suggestedFix: `Improve ${name} in the next revision.`,
    });
  }

  const score = ranked.metrics.compositeScore.toFixed(3);
  const overallAssessment = comments.length
    ? `Composite ${score}; hard QA ${qa ? (qa.passed ? 'passed' : 'failed') : 'not run'}. ` +
      `${comments.length} measured issue(s): ${comments.map((c) => c.issue).join(' ')}`
    : `Composite ${score}; hard QA ${qa ? (qa.passed ? 'passed' : 'failed') : 'not run'}. No measured defect.`;

  return {
    status: 'success',
    comments,
    rejectedComments: [],
    overallAssessment,
    deterministicMetrics: ranked.metrics,
    annotations: [],
    receipt: {
      model: 'deterministic',
      responseId: 'none',
      xRequestId: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    },
  };
}

/** P05: the box-grounded critique of the top-ranked candidate, measured rather than written. */
export async function runCritiqueStageV3(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<{
  candidate: CandidateState;
  critique: Omit<BoxCritiqueResult, 'annotatedPng'>;
  compositeScores: Map<string, number>;
}> {
  const ranked = rankStudioCandidatesV3(ctx, candidates);
  return {
    candidate: ranked[0].candidate,
    critique: deterministicCritiqueV3(ranked[0]),
    compositeScores: new Map(ranked.map((r) => [r.candidate.id, r.metrics.compositeScore])),
  };
}

/**
 * P06: gated refinement of the top-ranked candidate. A repair is prepared like any generated layout
 * before it is measured, so a repair cannot move the logo off its real aspect.
 */
export async function runReviseStageV3(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<{ candidate: CandidateState; outcome: RefinementOutcomeV3; layout: StudioLayoutV2 }> {
  const ranked = rankStudioCandidatesV3(ctx, candidates);
  const outcome = await refineCandidateV3(ranked[0], copyForStageV3(ctx), {
    client: ctx.client,
    reference: ctx.reference,
    renderOptions: candidateRenderOptions(ctx, ranked[0].candidate),
    canvas: {
      width: ctx.width,
      height: ctx.height,
      logoAspect: ctx.logoAspect,
      palette: ctx.referencePack.palette,
      background: ctx.requestedBackground,
      ornament: ctx.ornament,
      style: ctx.style,
      allowArt: ctx.imageryStrategy !== 'none',
    },
    qa: hardQaContextFor(ctx),
  });
  return { candidate: ranked[0].candidate, outcome, layout: outcome.layout };
}

/** P07: the judge and its canary choose between the top two candidates. */
export async function runJudgeStageV3(
  ctx: StageContext,
  candidates: CandidateState[],
  judge: { protocol?: StudioJudgeProtocol; brief?: BriefBoundJudgeBrief; subjects?: string[] } = {}
): Promise<{
  selection: WinnerSelectionV3;
  winner: CandidateState;
  runnerUp: CandidateState | null;
  ranked: Array<RankedCandidateV3 & { candidate: CandidateState }>;
}> {
  const ranked = rankStudioCandidatesV3(ctx, candidates);
  assertJudgeSeesText(eligibleCandidatesV3(ranked));
  const selection = await selectWinnerV3(ranked, copyForStageV3(ctx), {
    client: ctx.client,
    reference: ctx.reference,
    clientProfile: ctx.clientProfile,
    renderOptionsForCandidate: (candidate) => candidateRenderOptions(ctx, ranked.find((r) => r.sourceIndex === candidate.sourceIndex)!.candidate),
    judgeProtocol: judge.protocol,
    judgeBrief: judge.brief,
    // ADR-170: the client's house art-direction rules, which the judge weighs on photo briefs.
    ...(ctx.artDirectionRules?.length ? { houseRules: ctx.artDirectionRules } : {}),
    // ADR-170: the brief's subject, for the house prior when the judge leaves two recipes undecided.
    ...(judge.subjects?.length ? { subjects: judge.subjects } : {}),
  });
  const find = (r: RankedCandidateV3 | null) =>
    r ? ranked.find((x) => x.sourceIndex === r.sourceIndex)!.candidate : null;
  return { selection, winner: find(selection.winner)!, runnerUp: find(selection.runnerUp), ranked };
}

// ---------------------------------------------------------------------------------------------
// ADR-237: the top model's visual review and one controlled refinement pass
// ---------------------------------------------------------------------------------------------

/** One review, as the critique stage stores it for the revise stage (stages.critique.visualReview). */
export interface StoredVisualReview extends VisualReviewResult {
  candidateId: string;
  ordinal: number;
}

export interface VisualReviewStageRecord {
  settings: VisualReviewSettings;
  reviews: StoredVisualReview[];
  /** Candidates not reviewed, and why: the cap, a model failure, no eligible candidate. */
  skipped: Array<{ candidateId?: string; reason: string }>;
}

/** What the review is told about the request and the client. */
function visualReviewContextFor(ctx: StageContext, brief: Partial<CreativeBrief>) {
  return {
    brief: judgeBriefForStageV3(ctx, brief),
    clientRules: [ctx.promotedRules, ctx.clientRules].filter((r) => typeof r === 'string' && r.trim()).join('\n\n'),
    ...(ctx.artDirectionRules?.length ? { houseRules: ctx.artDirectionRules } : {}),
    ...(ctx.clientProfile ? { clientProfile: ctx.clientProfile } : {}),
    ...(ctx.reference ? { reference: ctx.reference } : {}),
  };
}

/**
 * A model failure or the review's own cap ends the review of one candidate, which keeps its design.
 * A hold, a budget stop, an accounting failure or a lost authority stops the run as everywhere else.
 */
const reviewMayContinue = (err: unknown) =>
  !(isModelCallHoldError(err) || err instanceof StudioBudgetExhaustedError || err instanceof StudioArtAccountingError ||
    err instanceof CanvaFlowError);

/**
 * P05, ADR-237: the critique role's model (Sol in production) looks at the actual render of each of
 * the top `settings.candidates` candidates that pass hard QA — the ones the judge chooses between —
 * and returns structured fixes. Nothing is applied here; the revise stage applies, re-renders and
 * decides. Each review is its own substep, so a resumed stage reads its saved answer back.
 */
export async function runVisualReviewStageV3(
  ctx: StageContext,
  candidates: CandidateState[],
  settings: VisualReviewSettings,
  brief: Partial<CreativeBrief> = {}
): Promise<VisualReviewStageRecord> {
  const record: VisualReviewStageRecord = { settings, reviews: [], skipped: [] };
  if (settings.rounds < 1) return record;
  const ranked = rankStudioCandidatesV3(ctx, candidates).filter((r) => r.hardQa?.passed === true);
  if (!ranked.length) {
    record.skipped.push({ reason: 'no candidate passes hard QA; the gated repair runs instead' });
    return record;
  }
  const copy = copyForStageV3(ctx);
  const context = visualReviewContextFor(ctx, brief);
  for (const r of ranked.slice(0, settings.candidates)) {
    try {
      const result = await inStudioSubstep(`review/candidate-${r.candidate.ordinal + 1}`, () =>
        reviewCandidateVisuallyV3(r, copy, { client: ctx.client, context, renderOptions: candidateRenderOptions(ctx, r.candidate) }));
      record.reviews.push({ ...result, candidateId: r.candidate.id, ordinal: r.candidate.ordinal });
    } catch (err) {
      if (!reviewMayContinue(err)) throw err;
      record.skipped.push({ candidateId: r.candidate.id, reason: err instanceof Error ? err.message : String(err) });
      // The cap is the run's: once it is reached, no later candidate is reviewed either.
      if (err instanceof StudioSpendCapError) break;
    }
  }
  return record;
}

export interface VisualRefinementRound {
  round: number;
  fixes: AppliedVisualFix[];
  /** The geometry patch refused the review as a whole (ADR-190), with its findings. */
  rejection?: { code: string; findings: string[] };
  decision?: VisualRefinementDecision;
  scoreBefore?: number;
  scoreAfter?: number;
  hardQaAfter?: { passed: boolean; defectCodes: string[] };
  /** Rounds after the first are reviewed here; their receipts are recorded with them. */
  reviewReceipt?: VisualReviewResult['receipt'];
}

export interface VisualRefinementOutcome {
  candidateId: string;
  ordinal: number;
  adopted: boolean;
  reason: string;
  rounds: VisualRefinementRound[];
  /** The adopted candidate, rendered: its new layout appended, preview, composite and metrics. */
  refined?: CandidateState;
  score?: number;
}

/**
 * P06, ADR-237: applies each stored review to the layout it reviewed, conforms the result to the
 * house rules, renders it as the client would see it, runs hard QA on that render and keeps it only
 * if QA passes and the measures do not regress, or the judge prefers it. One round by default;
 * a second round (settings.rounds = 2) reviews the adopted design again.
 *
 * Replay-safe: a candidate whose current layout is no longer the one reviewed (a resumed stage that
 * already stored its refinement) is left alone, and every call is its own substep.
 */
export async function runVisualRefinementStageV3(
  ctx: StageContext,
  candidates: CandidateState[],
  record: VisualReviewStageRecord,
  brief: Partial<CreativeBrief> = {}
): Promise<VisualRefinementOutcome[]> {
  const copy = copyForStageV3(ctx);
  const canvas = {
    width: ctx.width, height: ctx.height, logoAspect: ctx.logoAspect, palette: ctx.referencePack.palette,
    background: ctx.requestedBackground, ornament: ctx.ornament, style: ctx.style, allowArt: ctx.imageryStrategy !== 'none',
  };
  const fonts = [ctx.latinFont, ctx.arabicFont, ...(ctx.referencePack.admittedDisplayFonts?.latin ?? []), ...(ctx.referencePack.admittedDisplayFonts?.arabic ?? [])];
  const judgeBrief = judgeBriefForStageV3(ctx, brief);
  const context = visualReviewContextFor(ctx, brief);
  const outcomes: VisualRefinementOutcome[] = [];
  for (const stored of record.reviews) {
    const original = candidates.find((c) => c.id === stored.candidateId);
    const outcome: VisualRefinementOutcome = { candidateId: stored.candidateId, ordinal: stored.ordinal, adopted: false, reason: '', rounds: [] };
    outcomes.push(outcome);
    if (!original) { outcome.reason = 'candidate_not_active'; continue; }
    if (layoutSha256(original.currentLayout) !== stored.reviewedLayoutSha256) {
      outcome.reason = original.layouts.some((l) => layoutSha256(l) === stored.reviewedLayoutSha256)
        ? 'already_refined' : 'layout_changed_since_review';
      continue;
    }
    let current = original;
    let review: VisualReviewResult = stored;
    for (let round = 1; round <= record.settings.rounds; round++) {
      const roundRecord: VisualRefinementRound = { round, fixes: [] };
      const [before] = rankStudioCandidatesV3(ctx, [current]);
      if (round > 1) {
        try {
          review = await inStudioSubstep(`review/candidate-${stored.ordinal + 1}-round-${round}`, () =>
            reviewCandidateVisuallyV3(before, copy, { client: ctx.client, context, renderOptions: candidateRenderOptions(ctx, current) }));
          roundRecord.reviewReceipt = review.receipt;
        } catch (err) {
          if (!reviewMayContinue(err)) throw err;
          outcome.reason = `round ${round} review unavailable: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }
      outcome.rounds.push(roundRecord);
      const applied = applyVisualReviewV3(current.currentLayout, review.review, { palette: ctx.referencePack.palette, allowedFonts: fonts });
      roundRecord.fixes = applied.fixes;
      if (!applied.ok) {
        roundRecord.rejection = { code: applied.rejection.code, findings: applied.rejection.findings };
        outcome.reason = outcome.adopted ? outcome.reason : applied.rejection.code;
        break;
      }
      if (!applied.changed) {
        outcome.reason = outcome.adopted ? outcome.reason : 'no_applicable_fix';
        break;
      }
      const conformed = conformReviewedLayoutV3(applied.layout, copy, canvas);
      const [rendered] = await runRenderStage(ctx, [{
        ...current, layouts: [...current.layouts, conformed], currentLayout: conformed, critiques: [...current.critiques],
      }]);
      const [after] = rankStudioCandidatesV3(ctx, [rendered]);
      roundRecord.scoreBefore = before.metrics.compositeScore;
      roundRecord.scoreAfter = after.metrics.compositeScore;
      roundRecord.hardQaAfter = { passed: after.hardQa?.passed === true, defectCodes: after.hardQa?.defectCodes ?? [] };
      let decision: VisualRefinementDecision;
      try {
        decision = await decideVisualRefinementV3(before, after, () =>
          inStudioSubstep(`review-judge/candidate-${stored.ordinal + 1}-round-${round}`, () => judgeRefinementV3(before, after, copy, {
            client: ctx.client, reference: ctx.reference, clientProfile: ctx.clientProfile, judgeBrief,
            renderOptions: candidateRenderOptions(ctx, current),
            ...(ctx.artDirectionRules?.length ? { houseRules: ctx.artDirectionRules } : {}),
          })));
      } catch (err) {
        if (!reviewMayContinue(err)) throw err;
        // No judge, no tie-break: a refinement the measures do not support is not kept.
        decision = { adopt: false, reason: 'metrics_regressed', regressions: [`judge unavailable: ${err instanceof Error ? err.message : String(err)}`] };
      }
      roundRecord.decision = decision;
      outcome.reason = decision.reason;
      if (!decision.adopt) break;
      outcome.adopted = true;
      outcome.refined = rendered;
      outcome.score = after.metrics.compositeScore;
      current = rendered;
    }
  }
  return outcomes;
}
