import { createHash } from 'node:crypto';
import { isModelCallHoldError, type StageContext, type CandidateState } from '../types.js';
import { FORBIDDEN_ART_WORDS, renderMotifPng, evaluateHardQa, type ProceduralMotifType } from '@hawa/creative';
import { hardQaContextFor } from './v3.stage.js';
import { log } from '../../../logging.js';
import { studioSubstepKey } from '@hawa/domain';
import { inStudioSubstep } from '../substeps.js';

function assertArtPromptSafe(prompt: string, ctx: StageContext): void {
  const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const art = normalized(prompt);
  const protectedPhrases = [ctx.referencePack.clientName, ...ctx.copyBlocks.map((block) => block.text)]
    .filter((value): value is string => typeof value === 'string' && normalized(value).length >= 3);
  const copyAcronyms = ctx.copyBlocks.flatMap((block) => [...block.text.matchAll(/\b[A-Z]{3,}\b/g)].map(([value]) => value));
  const prohibitedMarks = new RegExp(`\\b(?:${[...FORBIDDEN_ART_WORDS, 'insignia', 'crest', 'wordmark', 'brandmark'].join('|')})\\b`, 'i');
  if (prohibitedMarks.test(prompt) || /\p{N}/u.test(prompt) ||
      protectedPhrases.some((value) => art.includes(normalized(value))) ||
      copyAcronyms.some((value) => art.includes(normalized(value)))) {
    throw new Error('ART_PROMPT_PROTECTED_CONTENT');
  }
}

export async function runArtStage(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<CandidateState[]> {
  for (const cand of candidates) {
    if (cand.currentLayout.art && ctx.imageryStrategy !== 'none') {
      // Artwork cannot repair overflowing copy, illegal fonts or broken geometry. Contrast is
      // evaluated again against completed imagery; this preflight is not a final QA certificate.
      const qa = evaluateHardQa(cand.currentLayout, hardQaContextFor(ctx));
      // Primary-font measurement is mandatory in both pipelines. V3 additionally applies its
      // admitted composition profile here; that profile is not imposed on other clients.
      const defects = qa.defectCodes.filter((code) => ctx.pipelineV3 ? code !== 'CONTRAST' : code === 'COPY_UNMEASURED');
      if (defects.length) {
        cand.status = 'eliminated';
        cand.diagnostics = [...new Set([...(cand.diagnostics ?? []), ...defects])];
        continue;
      }
    }
    if (ctx.imageryStrategy === 'none') {
      delete cand.currentLayout.art;
      cand.artPng = null;
      cand.artSha256 = null;
      cand.artProvenance = null;
      cand.concept.artStrategy = 'none';
      continue;
    }
    const artConfig = cand.currentLayout.art;
    if (!artConfig) continue;

    const rawBox = artConfig.box || { x: 0, y: 0, width: cand.currentLayout.width, height: cand.currentLayout.height };
    const box = {
      x: rawBox.x ?? 0,
      y: rawBox.y ?? 0,
      width: rawBox.width ?? cand.currentLayout.width,
      height: rawBox.height ?? cand.currentLayout.height,
    };
    const width = Math.max(320, Math.round(box.width));
    const height = Math.max(320, Math.round(box.height));

    if (artConfig.source === 'generated' && ctx.artProvider) {
      const basePrompt = artConfig.prompt || cand.concept.artPrompt || 'Editorial still life composition';
      assertArtPromptSafe(basePrompt, ctx);
      const rawCalm = artConfig.calmRegion || box;
      const calmBox = {
        x: rawCalm.x ?? box.x,
        y: rawCalm.y ?? box.y,
        width: rawCalm.width ?? box.width,
        height: rawCalm.height ?? box.height,
      };
      const calmRegionDesc = `centered around (${Math.round(calmBox.x)}, ${Math.round(calmBox.y)}) measuring ${Math.round(calmBox.width)}x${Math.round(calmBox.height)}`;

      try {
        // The image, its refusals and its verifier are attempts of one substep (ADR-122).
        const artProvider = ctx.artProvider;
        const artResult = await inStudioSubstep(studioSubstepKey('art', `candidate-${cand.ordinal + 1}`), () => artProvider.generateArt({
          artPrompt: basePrompt,
          palette: ctx.referencePack.palette,
          aspect: width >= height ? '16:9' : '9:16',
          calmRegionDescription: calmRegionDesc,
          width,
          height,
        }));

        const actualSha256 = createHash('sha256').update(artResult.imageBuffer).digest('hex');
        if (actualSha256 !== artResult.receipt.sha256) {
          throw new Error('ART_RECEIPT_HASH_MISMATCH');
        }

        cand.artPng = artResult.imageBuffer;
        cand.artSha256 = actualSha256;
        cand.artProvenance = {
          source: artResult.receipt.provider === 'procedural' ? 'procedural' : 'generated',
          model: artResult.receipt.model,
          synthId: artResult.receipt.synthId,
          prompt: basePrompt,
          ...(artResult.receipt.artFallback ? { artFallback: artResult.receipt.artFallback } : {}),
          ...(artResult.receipt.fallbackReason ? { fallbackReason: artResult.receipt.fallbackReason } : {}),
        };
      } catch (err: any) {
        if (isModelCallHoldError(err)) throw err;
        // Degradation ladder rung 2: fallback to procedural motif. Logged because the ladder is
        // otherwise invisible — a design quietly shipping a procedural motif instead of generated
        // art looks like a design decision rather than a failed image call.
        log.warn(
          `[art.stage] Image generation failed (${err?.message || err}); falling back to a ` +
            `procedural motif for this candidate.`
        );
        const fallbackMotif: ProceduralMotifType = (cand.concept.motif as ProceduralMotifType) || 'thin-rules';
        const pngBytes = renderMotifPng(fallbackMotif, {
          width,
          height,
          palette: ctx.referencePack.palette,
          // Drawn at full strength: the layer's opacity is applied once, by the render and the deck.
        opacity: 1,
        });
        cand.artPng = pngBytes;
        cand.artSha256 = createHash('sha256').update(pngBytes).digest('hex');
        cand.artProvenance = {
          source: 'procedural',
          motif: fallbackMotif,
          fallbackReason: err instanceof Error ? err.message : 'generation_failed',
        };
      }
    } else if (artConfig.source === 'procedural' || (!cand.artPng && artConfig.motif)) {
      const motifKind: ProceduralMotifType = (artConfig.motif as ProceduralMotifType) || 'thin-rules';
      const pngBytes = renderMotifPng(motifKind, {
        width,
        height,
        palette: ctx.referencePack.palette,
        // Drawn at full strength: the layer's opacity is applied once, by the render and the deck.
        opacity: 1,
      });
      cand.artPng = pngBytes;
      cand.artSha256 = createHash('sha256').update(pngBytes).digest('hex');
      cand.artProvenance = {
        source: 'procedural',
        motif: motifKind,
      };
    }
  }

  return candidates;
}
