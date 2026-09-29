import * as restate from '@restatedev/restate-sdk';
import { verifyLifecycleOfficeEvent } from '@hawa/integrations';
import { parseCompleteRevisionRequest, parseOfficeApprovalProof, parseRejectionCategory } from '@hawa/domain';
import { withInvocationLogContext } from '../logging.js';
import { acceptedWorkerSecrets } from './worker-secrets.js';
import { parseNativeReviewSubmission, type NativeReviewSubmission, type NativeReviewReply } from '@hawa/domain';
import { RequestLifecycleApi, OFFICE_RETRY_ROLES, type OfficeDeliveryStartEvent, type OfficeDeliveryStartReply,
  type OfficeRetryEvent, type OfficeRetryReply, type OfficeRevisionEvent, type OfficeRevisionReply } from './request-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignedOfficeDecision {
  v: 1;
  event: OfficeRevisionEvent | OfficeDeliveryStartEvent;
  signature: string;
}

/** Only signed review decisions are exposed; the request object itself remains ingress-private. */
/** Any of the accepted values verifies (HAWA_WORKER_TOKEN, or its previous value during a rotation; ADR-129). */
function signedWithAny(secrets: string | readonly string[], verify: (secret: string) => boolean): boolean {
  return (typeof secrets === 'string' ? [secrets] : secrets).some((secret) => Boolean(secret) && verify(secret));
}

export function checkSignedOfficeDecision(input: SignedOfficeDecision, secret: string | readonly string[]): 'ok' | 'invalid' | 'unauthorized' {
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
  return signedWithAny(secret, (value) => verifyLifecycleOfficeEvent(value, input.event, input.signature)) ? 'ok' : 'unauthorized';
}

/** ADR-142: a signed office retry of a design that ended without a draft. */
export function checkSignedOfficeRetry(input: { v: 1; event: OfficeRetryEvent; signature: string }, secret: string | readonly string[]): 'ok' | 'invalid' | 'unauthorized' {
  const e = input?.event;
  if (input?.v !== 1 || !e || typeof e !== 'object' || Array.isArray(e) || e.v !== 1 || e.kind !== 'retry' ||
      Object.keys(e).some((key) => !['v', 'kind', 'eventId', 'requestId', 'taskId', 'actionId', 'expectedRev', 'actor', 'reason'].includes(key)) ||
      !UUID.test(e.requestId) || !UUID.test(e.taskId) || !UUID.test(e.actionId) || e.eventId !== `desk:${e.actionId}` ||
      !Number.isInteger(e.expectedRev) || e.expectedRev < 2 ||
      !e.actor || typeof e.actor !== 'object' || Object.keys(e.actor).some((key) => key !== 'userId' && key !== 'role') ||
      !UUID.test(e.actor.userId) || !OFFICE_RETRY_ROLES.has(e.actor.role) ||
      typeof e.reason !== 'string' || !e.reason.trim() || e.reason.length > 2000) return 'invalid';
  return signedWithAny(secret, (value) => verifyLifecycleOfficeEvent(value, e, input.signature)) ? 'ok' : 'unauthorized';
}

export function createOfficeDecisionGateway(secret: string | readonly string[] = acceptedWorkerSecrets()) {
  return restate.service({
    name: 'OfficeDecisionGateway',
    handlers: {
      nativeReview: async (ctx: restate.Context,input: {v:1;event:NativeReviewSubmission;signature:string}):Promise<NativeReviewReply>=>{
        const verdict=await ctx.run('authenticate',async()=>checkSignedNativeReview(input,secret));
        if (verdict !== 'ok') throw new restate.TerminalError('INVALID_NATIVE_REVIEW',{errorCode:verdict==='invalid'?400:401});
        return ctx.objectClient(RequestLifecycleApi,input.event.requestId).nativeReview(input.event);
      },
      retryDesign: async (ctx: restate.Context, input: { v: 1; event: OfficeRetryEvent; signature: string }): Promise<OfficeRetryReply> =>
        withInvocationLogContext(ctx, { requestId: input?.event?.requestId }, async () => {
          const verdict = await ctx.run('authenticate', async () => checkSignedOfficeRetry(input, secret));
          if (verdict !== 'ok') throw new restate.TerminalError(
            verdict === 'invalid' ? 'INVALID_OFFICE_RETRY' : 'UNAUTHORIZED_OFFICE_RETRY',
            { errorCode: verdict === 'invalid' ? 400 : 401 });
          return ctx.objectClient(RequestLifecycleApi, input.event.requestId).officeRetry(input.event);
        }),
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

export function checkSignedNativeReview(input: {v:1;event:NativeReviewSubmission;signature:string},secret:string|readonly string[]):'ok'|'invalid'|'unauthorized' {
  if (input?.v !== 1 || !parseNativeReviewSubmission(input.event)) return 'invalid';
  return signedWithAny(secret,(value)=>verifyLifecycleOfficeEvent(value,input.event,input.signature))?'ok':'unauthorized';
}
