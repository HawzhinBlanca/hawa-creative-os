import { createHash } from 'node:crypto';
import { layoutConditioningImage, type LayoutVisualInput, type RenderLayoutOptions } from '@hawa/creative';
import type { StageContext, CandidateState } from '../types.js';

/** One asset mapping for the output, its refinement and its comparison renders. */
export function candidateRenderOptions(
  ctx: Pick<StageContext, 'logo' | 'photos' | 'photoCutouts'>,
  candidate: Pick<CandidateState, 'artPng'>,
): RenderLayoutOptions {
  return {
    logoDataUri: ctx.logo ? `data:${ctx.logo.mimeType};base64,${ctx.logo.bytes.toString('base64')}` : undefined,
    artImagePath: candidate.artPng ? `data:image/png;base64,${candidate.artPng.toString('base64')}` : undefined,
    photoFiles: ctx.photos?.map((p) => ({ bytes: p.bytes, mediaType: p.mimeType })),
    photoCutouts: ctx.photoCutouts,
  };
}

export async function layoutVisualInputs(ctx: Pick<StageContext, 'clientId' | 'referencePack' | 'exemplars' | 'photos' | 'visualInputs'>): Promise<LayoutVisualInput[]> {
  if (ctx.visualInputs) return ctx.visualInputs;
  const selected = (ctx.exemplars ?? []).filter((e) => e.bytes).slice(0, 2);
  if (selected.length && ctx.referencePack.clientId !== ctx.clientId) throw new Error('LAYOUT_EXEMPLAR_SCOPE_MISMATCH');
  const inputs: LayoutVisualInput[] = [];
  for (const exemplar of selected) {
    const bytes = exemplar.bytes!;
    if (exemplar.sha256 && exemplar.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      throw new Error('LAYOUT_EXEMPLAR_HASH_MISMATCH');
    }
    inputs.push({ kind: 'approved_example', label: exemplar.label, ...await layoutConditioningImage(bytes) });
  }
  for (const [index, photo] of (ctx.photos ?? []).entries()) {
    inputs.push({ kind: 'content_photo', label: `Photo ${index}`, notes: photo.notes, ...await layoutConditioningImage(photo.bytes) });
  }
  return inputs;
}
