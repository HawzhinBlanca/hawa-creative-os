import * as restate from '@restatedev/restate-sdk';
import { verifyLifecycleOfficeEvent } from '@hawa/integrations';
import { parseCompleteRevisionRequest, parseOfficeApprovalProof, parseRejectionCategory } from '@hawa/domain';
import { withInvocationLogContext } from '../logging.js';
import { parseNativeReviewSubmission, type NativeReviewSubmission, type NativeReviewReply } from '@hawa/domain';
import { RequestLifecycleApi, type OfficeDeliveryStartEvent, type OfficeDeliveryStartReply,
  type OfficeRevisionEvent, type OfficeRevisionReply } from './request-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignedOfficeDecision {
  v: 1;
  event: OfficeRevisionEvent | OfficeDeliveryStartEvent;
  signature: string;
}

/** Only signed review decisions are exposed; the request object itself remains ingress-private. */
export function checkSignedOfficeDecision(input: SignedOfficeDecision, secret: string): 'ok' | 'invalid' | 'unauthorized' {
  if (input?.v !== 1 || !input.event || typeof input.event !== 'object' || Array.isArray(input.event) ||
      input.event.v !== 1 || !['revise', 'approve', 'reject', 'deliver'].includes(input.event.kind) ||
      (input.event.kind === 'deliver'
        ? (!Number.isInteger(input.event.expectedRev) || input.event.expectedRev < 3 ||
          !UUID.test(input.event.approvalId) ||
          Object.keys(input.event).some((key) => !['v', 'kind', 'eventId', 'requestId', 'taskId',
            'revisionId', 'approvalId', 'actionId', 'expectedRev', 'actor', 'reason'].includes(key)) ||
          !['art_director', 'creative_director', 'office_admin', 'administrator'].includes(input.event.actor?.role))
        : (!Number.isInteger(input.event.expectedRev) || input.event.expectedRev < 2)) ||
      !UUID.test(input.event.requestId) || !UUID.test(input.event.taskId) ||
      !UUID.test(input.event.revisionId) || !UUID.test(input.event.actionId) ||
      input.event.eventId !== `desk:${input.event.actionId}` ||
      !input.event.actor || !UUID.test(input.event.actor.userId) ||
      typeof input.event.actor.role !== 'string' || typeof input.event.reason !== 'string' ||
      (input.event.kind !== 'deliver' && (input.event.actor.authMethod !== undefined || input.event.actor.sessionHash !== undefined) &&
        (input.event.actor.authMethod !== 'google_oidc' || !/^[a-f0-9]{64}$/.test(input.event.actor.sessionHash || ''))) ||
      !input.event.reason.trim() || input.event.reason.length > 2000 ||
      (input.event.kind !== 'deliver' && input.event.revisionRequest !== undefined &&
        (!parseCompleteRevisionRequest(input.event.revisionRequest) ||
          input.event.revisionRequest.comment.trim() !== input.event.reason.trim())) ||
      (input.event.kind === 'approve' && (!parseOfficeApprovalProof(input.event.approvalProof) ||
        !/^[a-f0-9]{64}$/.test(input.event.deskRequestFingerprint || '') || input.event.revisionRequest !== undefined ||
        input.event.rejectionCategory !== undefined)) ||
      (input.event.kind === 'reject' && (!parseRejectionCategory(input.event.rejectionCategory) ||
        input.event.approvalProof !== undefined || input.event.deskRequestFingerprint !== undefined ||
        input.event.revisionRequest !== undefined)) ||
      (input.event.kind === 'revise' && (input.event.approvalProof !== undefined ||
        input.event.deskRequestFingerprint !== undefined || input.event.rejectionCategory !== undefined))) return 'invalid';
  return verifyLifecycleOfficeEvent(secret, input.event, input.signature) ? 'ok' : 'unauthorized';
}

export function createOfficeDecisionGateway(secret = process.env.HAWA_WORKER_TOKEN || '') {
  return restate.service({
    name: 'OfficeDecisionGateway',
    handlers: {
      nativeReview: async (ctx: restate.Context,input: {v:1;event:NativeReviewSubmission;signature:string}):Promise<NativeReviewReply>=>{
        const verdict=await ctx.run('authenticate',async()=>checkSignedNativeReview(input,secret));
        if (verdict !== 'ok') throw new restate.TerminalError('INVALID_NATIVE_REVIEW',{errorCode:verdict==='invalid'?400:401});
        return ctx.objectClient(RequestLifecycleApi,input.event.requestId).nativeReview(input.event);
      },
      decide: async (ctx: restate.Context, input: SignedOfficeDecision): Promise<OfficeRevisionReply | OfficeDeliveryStartReply> =>
        withInvocationLogContext(ctx, { requestId: input?.event?.requestId }, async () => {
          // Journal the authentication verdict so a credential rotation cannot change a replayed
          // invocation after it was already accepted. A rejected event makes no object call.
          const verdict = await ctx.run('authenticate', async () => checkSignedOfficeDecision(input, secret));
          if (verdict !== 'ok') throw new restate.TerminalError(
            verdict === 'invalid' ? 'INVALID_OFFICE_DECISION' : 'UNAUTHORIZED_OFFICE_DECISION',
            { errorCode: verdict === 'invalid' ? 400 : 401 });
          return ctx.objectClient(RequestLifecycleApi, input.event.requestId).officeDecision(input.event);
        }),
    },
    options: { ingressPrivate: false, idempotencyRetention: { days: 7 },
      retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000,
        maxAttempts: 300, onMaxAttempts: 'pause' } },
  });
}

export function checkSignedNativeReview(input: {v:1;event:NativeReviewSubmission;signature:string},secret:string):'ok'|'invalid'|'unauthorized' {
  if (input?.v !== 1 || !parseNativeReviewSubmission(input.event)) return 'invalid';
  return verifyLifecycleOfficeEvent(secret,input.event,input.signature)?'ok':'unauthorized';
}
