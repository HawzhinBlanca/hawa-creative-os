import type { UUID, ISODateTime, JsonObject, Result, AppError } from '@hawa/contracts';

/** A concept or failed render is not evidence a person can review. */
export function isRenderedStudioCandidate(candidate: { previewSha256?: string | null; hasPreviewBytes?: boolean } | null | undefined): boolean {
  return Boolean(candidate && (candidate.hasPreviewBytes || /^[a-f0-9]{64}$/i.test(candidate.previewSha256 || '')));
}

export type FeedbackPolarity = 'positive' | 'negative' | 'neutral';

export interface FeedbackEvent {
  feedbackId: UUID;
  taskId: UUID;
  clientId: UUID;
  projectId?: UUID;
  designRevisionId: UUID;
  nodeId?: string;
  polarity: FeedbackPolarity;
  category: 'typography' | 'color' | 'layout' | 'brand_voice' | 'cultural' | 'image_subject' | 'other';
  rawFeedbackText: string;
  attributedActor: {
    userId: UUID;
    displayName: string;
  };
  governance: {
    status: 'received' | 'mined' | 'rule_proposed' | 'rule_promoted' | 'dismissed';
    promotedRuleId?: UUID;
    promotedByUserId?: UUID;
  };
  occurredAt: ISODateTime;
}

export interface CandidateRule {
  candidateRuleId: UUID;
  clientId: UUID;
  category: string;
  suggestedRuleText: string;
  supportingFeedbackIds: UUID[];
  confidenceScore: number;
  status: 'pending_review' | 'promoted' | 'rejected';
  proposedAt: ISODateTime;
}

export function promoteCandidateRule(
  candidate: CandidateRule,
  promotedByUserId: UUID,
  officialRuleText: string
): Result<{ promotedRuleId: UUID; ruleText: string; clientId: UUID }, AppError> {
  if (!promotedByUserId) {
    return {
      ok: false,
      error: {
        code: 'PROMOTION_REQUIRES_HUMAN_ACTOR',
        message: 'A candidate rule can only be promoted to Client DNA by an authorized human administrator',
        retryable: false,
        safeAction: 'Review rule candidate in Hawa Desk Feedback Governance panel',
      },
    };
  }

  return {
    ok: true,
    value: {
      promotedRuleId: crypto.randomUUID(),
      ruleText: officialRuleText || candidate.suggestedRuleText,
      clientId: candidate.clientId,
    },
  };
}

/** An immutable design identity, or an explicitly task-wide rejection. */
export type LearningDesignTarget =
  | {kind:'studio_candidate';runId:string;candidateId:string;previewSha256:string}
  | {kind:'design_revision';revisionId:string;sourceSha256:string}
  | {kind:'task'};
export interface LearningExampleReceipt {
  feedbackId:string;clientId:string;taskId:string;target:LearningDesignTarget;
  verdict:'approve'|'reject'|'revise'|'rating'|'corrected';rating?:number|null;
  actor:{id:string;role?:string};recordedAt:string;
  basis:'studio_review'|'revision_decision'|'revision_rejection'|'approved_refinement'|'task_rejection'|'unresolved_legacy';
  approval?:{id:string;actorId:string};notes?:string|null;
}
const learningId=(value:unknown)=>typeof value==='string' && value.trim().length>0 && value.trim()===value;
export function learningTargetKey(target:LearningDesignTarget):string {
  if(!target || typeof target!=='object') throw new Error('Learning target is missing');
  if(target.kind==='task') return 'task';
  if(target.kind==='studio_candidate' && learningId(target.runId) && learningId(target.candidateId) && /^[a-f0-9]{64}$/i.test(target.previewSha256)) {
    return JSON.stringify([target.kind,target.runId,target.candidateId,target.previewSha256.toLowerCase()]);
  }
  if(target.kind==='design_revision' && learningId(target.revisionId) && /^[a-f0-9]{64}$/i.test(target.sourceSha256)) {
    return JSON.stringify([target.kind,target.revisionId,target.sourceSha256.toLowerCase()]);
  }
  throw new Error('Learning target identity/hash is invalid');
}
/** Content equivalence is scoped externally by client/task and never crosses target kinds. */
export function learningContentKey(target:LearningDesignTarget):string {
  learningTargetKey(target);
  return target.kind==='task'?'task':JSON.stringify([target.kind,
    (target.kind==='studio_candidate'?target.previewSha256:target.sourceSha256).toLowerCase()]);
}
export function isNegativeLearningReceipt(receipt:LearningExampleReceipt):boolean {
  return ['reject','revise','corrected'].includes(receipt.verdict) || (receipt.rating!=null && receipt.rating<=4);
}
export function learningReceiptKey(receipt:LearningExampleReceipt):string {
  const targetKey=learningTargetKey(receipt.target);
  if(![receipt.clientId,receipt.taskId,receipt.feedbackId,receipt.actor?.id].every(learningId) ||
    typeof receipt.recordedAt!=='string' || !Number.isFinite(Date.parse(receipt.recordedAt)) ||
    (receipt.actor.role!==undefined && typeof receipt.actor.role!=='string') ||
    (receipt.notes!=null && typeof receipt.notes!=='string') ||
    !['approve','reject','revise','rating','corrected'].includes(receipt.verdict) ||
    !['studio_review','revision_decision','revision_rejection','approved_refinement','task_rejection','unresolved_legacy'].includes(receipt.basis) ||
    (receipt.approval!==undefined && (![receipt.approval?.id,receipt.approval?.actorId].every(learningId))) ||
    (receipt.verdict==='approve' && ['approved_refinement','revision_decision'].includes(receipt.basis) && !receipt.approval) ||
    (receipt.target.kind==='task' && !['reject','revise'].includes(receipt.verdict)) ||
    (receipt.rating!=null && (!Number.isInteger(receipt.rating) || receipt.rating<1 || receipt.rating>10))) {
    throw new Error('Learning receipt identity/authority is invalid');
  }
  return JSON.stringify([receipt.clientId,receipt.taskId,receipt.feedbackId,targetKey]);
}
export function mergeLearningReceipts(...groups:readonly LearningExampleReceipt[][]):LearningExampleReceipt[] {
  const receipts=new Map<string,LearningExampleReceipt>();
  const fingerprint=(r:LearningExampleReceipt)=>JSON.stringify([r.verdict,r.rating??null,r.actor.id,r.actor.role??null,
    r.recordedAt,r.basis,r.approval?.id??null,r.approval?.actorId??null,r.notes??null]);
  for(const group of groups) for(const receipt of group) {
    const key=learningReceiptKey(receipt),previous=receipts.get(key);
    if(previous && fingerprint(previous)!==fingerprint(receipt)) throw new Error('Learning receipt reuse conflict');
    receipts.set(key,structuredClone(receipt));
  }
  return [...receipts.values()];
}
/** Approval of another target is not support; any contradiction on the exact target holds it. */
export function resolveLearningExamples(clientId:string,receipts:readonly LearningExampleReceipt[]) {
  if(receipts.some(r=>r.clientId!==clientId)) throw new Error('Learning example client scope conflict');
  const admitted=mergeLearningReceipts([...receipts]);
  const key=(r:LearningExampleReceipt)=>JSON.stringify([r.taskId,learningContentKey(r.target)]);
  const negativeExamples=admitted.filter(isNegativeLearningReceipt);
  const rejected=new Set(negativeExamples.map(key));
  const taskHolds=new Set(negativeExamples.filter(r=>r.target.kind==='task').map(r=>r.taskId));
  const positiveExamples=admitted.filter(r=>r.verdict==='approve' && r.target.kind!=='task' &&
    !rejected.has(key(r)) && !taskHolds.has(r.taskId) && ['studio_review','approved_refinement','revision_decision'].includes(r.basis));
  return {receipts:admitted,positiveExamples,negativeExamples,
    positiveExampleTaskIds:[...new Set(positiveExamples.map(r=>r.taskId))],
    negativeExampleTaskIds:[...new Set(negativeExamples.map(r=>r.taskId))]};
}
