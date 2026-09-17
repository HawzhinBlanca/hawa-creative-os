import { createHash } from 'node:crypto';
import type { StageContext, CandidateState } from '../types.js';
import { renderMotifPng, type ProceduralMotifType } from '@hawa/creative';

export async function runArtStage(
  ctx: StageContext,
  candidates: CandidateState[]
): Promise<CandidateState[]> {
  for (const cand of candidates) {
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
      const rawCalm = artConfig.calmRegion || box;
      const calmBox = {
        x: rawCalm.x ?? box.x,
        y: rawCalm.y ?? box.y,
        width: rawCalm.width ?? box.width,
        height: rawCalm.height ?? box.height,
      };
      const calmRegionDesc = `centered around (${Math.round(calmBox.x)}, ${Math.round(calmBox.y)}) measuring ${Math.round(calmBox.width)}x${Math.round(calmBox.height)}`;

      try {
        const artResult = await ctx.artProvider.generateArt({
          artPrompt: basePrompt,
          palette: ctx.referencePack.palette,
          aspect: width >= height ? '16:9' : '9:16',
          calmRegionDescription: calmRegionDesc,
          width,
          height,
        });

        cand.artPng = artResult.imageBuffer;
        cand.artSha256 = artResult.receipt.sha256;
        cand.artProvenance = {
          source: 'generated',
          model: artResult.receipt.model,
          synthId: artResult.receipt.synthId,
          prompt: basePrompt,
        };
      } catch (err) {
        // Degradation ladder rung 2: fallback to procedural motif
        const fallbackMotif: ProceduralMotifType = (cand.concept.motif as ProceduralMotifType) || 'thin-rules';
        const pngBytes = renderMotifPng(fallbackMotif, {
          width,
          height,
          palette: ctx.referencePack.palette,
          opacity: artConfig.opacity ?? 0.5,
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
        opacity: artConfig.opacity ?? 0.5,
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
