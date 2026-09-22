import type { StageContext, CandidateState } from '../types.js';
import type { EditableTransferPlan } from '@hawa/creative';
import { encodeStudioTransferV2 } from '@hawa/creative';

export interface TransferStageResult {
  pptxBytes: Buffer;
  sha256: string;
  plan: EditableTransferPlan;
  manifest: Record<string, unknown>;
}

export async function runTransferStage(
  ctx: StageContext,
  winner: CandidateState
): Promise<TransferStageResult> {
  const copyStrings = ctx.copyBlocks.map((b) => b.text);

  const transfer = await encodeStudioTransferV2(
    winner.currentLayout,
    copyStrings,
    ctx.logo,
    {
      artBuffer: winner.artPng || undefined,
      photos: ctx.photos?.map((p) => ({ bytes: p.bytes, mimeType: p.mimeType })),
      extraFonts: [ctx.latinFont, ctx.arabicFont, 'Verdana', 'Noto Sans Arabic', 'Cinzel', 'Playfair Display'],
    }
  );

  return {
    pptxBytes: transfer.bytes,
    sha256: transfer.sha256,
    plan: transfer.plan,
    manifest: transfer.manifest,
  };
}
