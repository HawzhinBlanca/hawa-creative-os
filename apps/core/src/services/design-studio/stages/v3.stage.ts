import {
  rankCandidatesV3,
  critiqueCandidateV3,
  refineCandidateV3,
  selectWinnerV3,
  type PipelineV3Copy,
  type RankedCandidateV3,
  type BoxCritiqueResult,
  type RefinementOutcomeV3,
  type WinnerSelectionV3,
  type NormalizedLayoutCandidate,
  type StudioLayoutV2,
  type HardQaContext,
} from '@hawa/creative';
import type { StageContext, CandidateState, Concept, Archetype, MotifKind } from '../types.js';

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
    colourRoles: { background: '#0A1628', title: '#FFFFFF', body: '#FFFFFF', accent: '#C5A059', rule: '#C5A059' },
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
      accent: shapeColour('accent') || shapeColour('rule') || '#C5A059',
      rule: shapeColour('rule') || shapeColour('accent') || '#C5A059',
    },
    layoutIdea: `v3 ${v3Archetype}`,
    whyDifferent: `One of ${total} deliberately distinct v3 archetypes from a single generation`,
  };
}

/** The hard-QA context of this run: the gate its winner must pass. */
export function hardQaContextFor(
  ctx: Pick<StageContext, 'width' | 'height' | 'copyBlocks' | 'latinFont' | 'arabicFont' | 'referencePack' | 'logoAspect'>
): HardQaContext {
  return {
    width: ctx.width,
    height: ctx.height,
    copyScripts: ctx.copyBlocks.map((b) => (b.script === 'arabic' ? 'arabic' : 'latin')),
    latinFont: ctx.latinFont,
    arabicFont: ctx.arabicFont,
    palette: ctx.referencePack.palette,
    logoAspect: ctx.logoAspect || 1.0,
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
    })),
    copy,
    hardQaContextFor(ctx)
  ).map((r) => ({ ...r, candidate: byOrdinal.get(r.sourceIndex)! }));
}

/** P05: the box-grounded critique of the top-ranked candidate. */
export async function runCritiqueStageV3(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<{ candidate: CandidateState; critique: BoxCritiqueResult; compositeScores: Map<string, number> }> {
  const ranked = rankStudioCandidatesV3(ctx, candidates);
  const critique = await critiqueCandidateV3(ranked[0], copyForStageV3(ctx), { client: ctx.client, reference: ctx.reference });
  return {
    candidate: ranked[0].candidate,
    critique,
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
    canvas: {
      width: ctx.width,
      height: ctx.height,
      logoAspect: ctx.logoAspect,
      palette: ctx.referencePack.palette,
      background: ctx.requestedBackground,
      ornament: ctx.ornament,
      style: ctx.style,
    },
    qa: hardQaContextFor(ctx),
  });
  return { candidate: ranked[0].candidate, outcome, layout: outcome.layout };
}

/** P07: the judge and its canary choose between the top two candidates. */
export async function runJudgeStageV3(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<{
  selection: WinnerSelectionV3;
  winner: CandidateState;
  runnerUp: CandidateState | null;
  ranked: Array<RankedCandidateV3 & { candidate: CandidateState }>;
}> {
  const ranked = rankStudioCandidatesV3(ctx, candidates);
  assertJudgeSeesText(ranked);
  const selection = await selectWinnerV3(ranked, copyForStageV3(ctx), { client: ctx.client, reference: ctx.reference });
  const find = (r: RankedCandidateV3 | null) =>
    r ? ranked.find((x) => x.sourceIndex === r.sourceIndex)!.candidate : null;
  return { selection, winner: find(selection.winner)!, runnerUp: find(selection.runnerUp), ranked };
}
