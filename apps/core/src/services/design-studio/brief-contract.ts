import { createHash } from 'node:crypto';
import { getSafeZoneBox, negativeSpacePolicyIdentity, screenCopyFeasibility } from '@hawa/creative';
import { buildBriefContract, type BriefProposalInput, type ExecutableBriefContract } from '@hawa/domain';
import type { StageContext } from './types.js';
import { copyForStageV3 } from './stages/v3.stage.js';

const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const dataUrlBytes = (url: string) => {
  const m = /^data:[^;]+;base64,(.+)$/.exec(url);
  return m ? Buffer.from(m[1], 'base64') : Buffer.from(url);
};

/** A recorded contract that no longer matches the run's own authorities holds the run (ADR-125). */
export class StudioBriefContractError extends Error {
  readonly code = 'BRIEF_CONTRACT_CHANGED';
}

/**
 * The run's executable brief contract (ADR-125), from its own authorities: the copy the run
 * renders, the pinned client assets, the client's words and rules, the model brief as proposals,
 * the policies prompt construction and QA share, and a free copy-feasibility screen.
 */
export function buildRunBriefContract(ctx: StageContext, brief: BriefProposalInput, copyAuthority: 'source_copy' | 'run_effective_copy'): ExecutableBriefContract {
  const copy = copyForStageV3(ctx);
  return buildBriefContract({
    canvas: { width: ctx.width, height: ctx.height },
    safeArea: getSafeZoneBox(ctx.width, ctx.height),
    copy: ctx.copyBlocks.map((b) => ({ text: b.text, script: b.script })),
    copyAuthority,
    instructions: ctx.instructions,
    clientRules: ctx.clientRules,
    logo: ctx.logo ? { sha256: sha(ctx.logo.bytes) } : null,
    photos: (ctx.photos ?? []).map((p) => ({ sha256: sha(p.bytes), ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}) })),
    reference: ctx.reference ? { sha256: sha(dataUrlBytes(ctx.reference.dataUrl)) } : null,
    brief: brief ?? {},
    ...(ctx.requestedBackground ? { appliedBackground: ctx.requestedBackground } : {}),
    policies: [negativeSpacePolicyIdentity()],
    copyFeasibility: screenCopyFeasibility({ width: ctx.width, height: ctx.height, copy, latinFont: ctx.latinFont, arabicFont: ctx.arabicFont,
      admittedDisplayFonts: ctx.referencePack.admittedDisplayFonts }),
  });
}
