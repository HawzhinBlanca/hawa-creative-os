import * as restate from '@restatedev/restate-sdk';
import { verifyLifecycleOfficeEvent } from '@hawa/integrations';
import { withInvocationLogContext } from '../logging.js';
import { RequestLifecycleApi, type OfficeRevisionEvent, type OfficeRevisionReply } from './request-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignedOfficeDecision {
  v: 1;
  event: OfficeRevisionEvent;
  signature: string;
}

/** Only this one Desk operation is exposed; the request object itself remains ingress-private. */
export function checkSignedOfficeDecision(input: SignedOfficeDecision, secret: string): 'ok' | 'invalid' | 'unauthorized' {
  if (input?.v !== 1 || !input.event || typeof input.event !== 'object' || Array.isArray(input.event) ||
      input.event.v !== 1 || input.event.kind !== 'revise' || input.event.expectedRev !== 2 ||
      !UUID.test(input.event.requestId) || !UUID.test(input.event.taskId) ||
      !UUID.test(input.event.revisionId) || !UUID.test(input.event.actionId) ||
      input.event.eventId !== `desk:${input.event.actionId}` ||
      !input.event.actor || !UUID.test(input.event.actor.userId) ||
      typeof input.event.actor.role !== 'string' || typeof input.event.reason !== 'string' ||
      !input.event.reason.trim() || input.event.reason.length > 2000) return 'invalid';
  return verifyLifecycleOfficeEvent(secret, input.event, input.signature) ? 'ok' : 'unauthorized';
}

export function createOfficeDecisionGateway(secret = process.env.HAWA_WORKER_TOKEN || '') {
  return restate.service({
    name: 'OfficeDecisionGateway',
    handlers: {
      decide: async (ctx: restate.Context, input: SignedOfficeDecision): Promise<OfficeRevisionReply> =>
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
