import { createHash } from 'node:crypto';
import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { parseNativeReviewSubmission, type NativeReviewSubmission, type NativeReviewReply } from '@hawa/domain';
import { isServiceUserId } from '@hawa/contracts';
import { lockNativeRecovery } from './lifecycle-native-scope.js';
import { latestRevisionCopy } from './native-revision-handoff.js';
import { recordManualCanvaReview } from './manual-canva-review.js';
import { evaluateCanvaExportQc } from '../core-helpers.js';
import { CanvaFlowError } from './canva-flow-error.js';

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b))
    .map(([k,value])=>`${JSON.stringify(k)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(v);
};
export const nativeReviewHash = (event: NativeReviewSubmission) => createHash('sha256').update(canonical(event)).digest('hex');
export const nativeReviewKey = (event: NativeReviewSubmission) => `${event.requestId}:${event.expectedRev+1}:nativeReview:${event.eventId}`;

/** Read the immutable receipt for an exact retry, even after a later request transition. */
export async function nativeReviewReceipt(db: Kysely<Database>, tenantId: string, event: NativeReviewSubmission) {
  const receipt = await db.selectFrom('lifecycle_projections').selectAll().where('tenant_id','=',tenantId)
    .where('request_id','=',event.requestId).where('idempotency_key','like',`${event.requestId}:%:nativeReview:${event.eventId}`).executeTakeFirst();
  if (!receipt) return undefined;
  if (receipt.payload_sha256 !== nativeReviewHash(event)) throw new CanvaFlowError(409,'NATIVE_REVIEW_CONFLICT','This action already identifies a different submission.');
  return receipt.result as unknown as Extract<NativeReviewReply,{accepted:true}>;
}

/** Only the private RequestLifecycle projection calls this transition. */
export async function projectLifecycleNativeReview(db: Kysely<Database>, tenantId: string, raw: NativeReviewSubmission) {
  const event = parseNativeReviewSubmission(raw);
  if (!event || isServiceUserId(event.actor.userId)) throw new CanvaFlowError(422,'INVALID_NATIVE_REVIEW','A complete office submission is required.');
  return withRlsContext(db,{tenantId,userId:event.actor.userId,role:event.actor.role},async trx=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lifecycle:${event.requestId}`},0))`.execute(trx);
    const prior = await nativeReviewReceipt(trx,tenantId,event);
    if (prior) return prior;
    await lockNativeRecovery(trx,{tenantId,actorId:event.actor.userId,role:event.actor.role,
      nativeRecovery:{requestId:event.requestId,rev:event.expectedRev}},event.taskId);
    const task = await trx.selectFrom('tasks').select(['version','state']).where('tenant_id','=',tenantId)
      .where('id','=',event.taskId).forUpdate().executeTakeFirst();
    if (!task || Number(task.version) !== event.expectedTaskVersion)
      throw new CanvaFlowError(409,'NATIVE_REVIEW_STALE','The task changed. Review the current handoff before submission.');
    const copy = await latestRevisionCopy(trx,tenantId,event.taskId);
    if (copy?.id !== event.confirmationEventId)
      throw new CanvaFlowError(409,'NATIVE_REVIEW_STALE','The copy confirmation changed. Capture the current revised design.');
    const review = await recordManualCanvaReview(trx,evaluateCanvaExportQc,{tenantId,taskId:event.taskId,
      actorId:event.actor.userId,role:event.actor.role,artifactId:event.artifactId,
      lifecycle:{requestId:event.requestId,rev:event.expectedRev}});
    if (review.status !== 'recorded') throw new CanvaFlowError(409,'NATIVE_REVIEW_UNVERIFIED',review.reason);
    const rev=event.expectedRev+1;
    await trx.updateTable('requests').set({stage:'in_review',rev,updated_at:new Date()})
      .where('tenant_id','=',tenantId).where('request_id','=',event.requestId).where('rev','=',event.expectedRev).executeTakeFirstOrThrow();
    const result: Extract<NativeReviewReply,{accepted:true}>={accepted:true,requestId:event.requestId,taskId:event.taskId,
      actionId:event.actionId,revisionId:review.revisionId,rev,stage:'in_review',qaPassed:review.qaPassed};
    await trx.insertInto('lifecycle_projections').values({tenant_id:tenantId,request_id:event.requestId,rev,
      idempotency_key:nativeReviewKey(event),payload_sha256:nativeReviewHash(event),result}).execute();
    return result;
  });
}
