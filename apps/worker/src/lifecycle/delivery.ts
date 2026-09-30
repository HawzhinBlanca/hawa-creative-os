/**
 * Delivery: one Restate workflow per run of a publication's delivery (architecture programme Phase 2,
 * slice 2.2; PHASE2_DESIGN.md section 2.5, ADR-034). Key `dl-<task>-<approval>`, and
 * `dl-<task>-<approval>:archive:<n>` for a later run that retries the Drive archive or the Sheets row.
 *
 * It replaces, for a request-owned task and for a non-lifecycle task pinned 'restate' (ADR-052; none
 * in production, removed in stage 2 of ADR-135), Core's own delivery run from the HTTP request
 * (deliveriesInFlight, reopenInterruptedDelivery) and the outbox's `notify.published` command:
 * 1. prepare: Core does the Drive and Sheets work (idempotent by the publication key) and answers
 *    with what the requester is sent. A Core that does not answer is asked again for 10 minutes; a
 *    refusal or a Core gone for longer ends the delivery `failed`. Core keeps a possible Drive upload
 *    in archive reconciliation; only a definite pre-upload failure can return the task to APPROVED.
 * 2. each approved file, then the notice, through the chat's TelegramSender, awaited one at a time.
 *    Their keys are the publication's, not the run's (`dl-<task>-<approval>:file:<artifact>`,
 *    `…:notice`), so a later run never sends a file twice; a send that may have arrived is never
 *    repeated and the office hears of it once (TelegramSender).
 * 3. report: legacy runs report to Core; request-owned runs report to the private RequestLifecycle
 *    owner, which applies one versioned Core projection before confirming completion.
 *
 * A workflow may await a Virtual Object; the Virtual Objects never await this (section 4).
 */
import * as restate from '@restatedev/restate-sdk';
import {
  deliveryBaseId,
  type DeliveryInput,
  type DeliveryOutcome,
  type OutboundMessage,
  type PreparedDelivery,
  type SendResult,
} from '@hawa/contracts';
import { chaosPoint } from '@hawa/observability';
import { verifyLifecycleDeliveryClaim } from '@hawa/integrations';
import { composeDeliveredCaption, composeDeliveredMessage, composeDeliveryFailedAlert } from '../delivery-notification.js';
import { requestIdHeaders, withInvocationLogContext } from '../logging.js';
import { TelegramSenderApi } from './telegram-sender.js';
import { RequestLifecycleApi } from './request-lifecycle.js';
import { acceptedWorkerSecrets } from './worker-secrets.js';
import { officeAlertKey, officeChatIdsFromEnv, officeRecipients } from './office-chats.js';

/** A Core step's retry: from 2 s doubling to 30 s, for up to 10 minutes (as TaskWorkflow's steps). */
export const PREPARE_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30000, maxRetryDuration: 10 * 60 * 1000 };
type StepRetry = { initialRetryInterval: number; retryIntervalFactor: number;
  maxRetryInterval: number; maxRetryDuration?: number };

/** The part of a Restate workflow context a delivery uses; tests pass a plain object. */
export interface DeliveryContext {
  run<T>(name: string, action: () => Promise<T>, retry: StepRetry): Promise<T>;
  /** An awaited call to the chat's TelegramSender. */
  send(message: OutboundMessage): Promise<SendResult>;
  /** Private RequestLifecycle report for a request-owned delivery. */
  reportLifecycle?(input: DeliveryInput, outcome: DeliveryOutcome): Promise<unknown>;
}

/** Core's internal API as the worker reaches it (HAWA_WORKER_TOKEN, a service principal). */
export interface CoreInternal {
  post<T>(path: string, body: unknown): Promise<T>;
}

/**
 * A Core answer the worker can act on: 2xx is the value; 5xx, 408, 429 and no answer throw an error
 * the step retries; any other 4xx is a TerminalError (asking again would get the same answer).
 * A deployment fault is retried too (ADR-155): Core refusing the worker's own credential (401, 403)
 * or not knowing the route at all (a 404 with no problem body) says nothing about the request, and
 * the same call succeeds once the deployment is fixed. It used to end the step for good.
 */
export function coreInternalFromEnv(fetcher: typeof fetch = fetch): CoreInternal {
  return {
    async post<T>(path: string, body: unknown): Promise<T> {
      const token = process.env.HAWA_WORKER_TOKEN;
      if (!token) throw new Error('CORE_NOT_CONFIGURED: HAWA_WORKER_TOKEN is not set, so Core\'s internal API cannot be called');
      const base = (process.env.HAWA_CORE_INTERNAL_URL || 'http://core:3001').replace(/\/+$/, '');
      const res = await fetcher(`${base}/v1${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...requestIdHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const answer = await res.json().catch(() => null) as ({ code?: string; detail?: string } & Record<string, unknown>) | null;
      if (res.ok) return answer as T;
      const what = `Core answered HTTP ${res.status}${answer?.code ? ` ${answer.code}` : ''} for ${path}${answer?.detail ? `: ${String(answer.detail).slice(0, 300)}` : ''}`;
      const deploymentFault = res.status === 401 || res.status === 403 || (res.status === 404 && !answer);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 && !deploymentFault) {
        throw new restate.TerminalError(what, { errorCode: res.status });
      }
      throw new Error(deploymentFault ? `${what} (a deployment fault: asked again)` : what);
    },
  };
}

/** Core's answer when it recorded this projection key with other content: a genuine idempotency conflict. */
const IDEMPOTENCY_CONFLICT = /^Core answered HTTP 409 IDEMPOTENCY_CONFLICT\b/;
export const isIdempotencyConflict = (err: unknown): boolean =>
  err instanceof restate.TerminalError && IDEMPOTENCY_CONFLICT.test(err.message);

/**
 * Core's internal API for the report of a finished design or delivery, which is the only report there
 * is (ADR-155): nothing else ever tells Core that the paid work ended, and a report that fails for good
 * leaves the request at its stage with nothing to move it. Only a genuine idempotency conflict (this
 * key recorded with other content: asking again can only get the same answer) stays final; any other
 * refusal is asked again, inside the step, until Restate's retry policy pauses the invocation for a
 * person, where it is visible (/v1/health restateInvocations) and can be resumed once Core is fixed.
 */
export function outcomeReportCore(core: CoreInternal): CoreInternal {
  return {
    async post<T>(path: string, body: unknown): Promise<T> {
      try {
        return await core.post<T>(path, body);
      } catch (err) {
        if (err instanceof restate.TerminalError && !isIdempotencyConflict(err)) {
          throw new Error(`${err.message} (the only report of this outcome: kept pending and asked again)`);
        }
        throw err;
      }
    },
  };
}

const isTerminal = (err: unknown) => err instanceof restate.TerminalError;

/**
 * What Core's delivery-finished route accepts (lifecycle-internal.routes.ts): a reason of at most 2000
 * characters, at most 50 uncertain names of 500. A longer one (many refused files, each with Telegram's
 * words) was refused as a 4xx and left the request `delivering` for good (ADR-155). The start of the
 * reason is kept: Core reads its leading code (TELEGRAM_REFUSED, NO_REQUESTER_CHAT, ...).
 */
const MAX_REPORTED_REASON = 1900;
const MAX_REPORTED_NAME = 500;
const MAX_REPORTED_NAMES = 50;
const capText = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The workflow's body. */
export async function runDelivery(ctx: DeliveryContext, core: CoreInternal, input: DeliveryInput): Promise<DeliveryOutcome> {
  if (input.reportTo === 'lifecycle' && (!ctx.reportLifecycle ||
      !Number.isInteger(input.requestRev) || Number(input.requestRev) < 4 ||
      input.requestId === input.taskId)) {
    throw new restate.TerminalError('LIFECYCLE_DELIVERY_NOT_AVAILABLE: a bound request owner and revision are required', { errorCode: 409 });
  }
  if (input.reportTo === 'lifecycle') {
    const { claimSignature, ...claim } = input;
    // HAWA_WORKER_TOKEN, or its previous value while a rotation is under way (ADR-129). The verdict is
    // journaled, as OfficeDecisionGateway's is (ADR-155): a replay after the rotation finished must not
    // refuse a delivery that already sent files, and strand the request in `delivering`.
    const verified = await ctx.run('verify-claim', async () =>
      acceptedWorkerSecrets().some((secret) => verifyLifecycleDeliveryClaim(secret, claim, claimSignature)), PREPARE_RETRY);
    if (!verified) {
      throw new restate.TerminalError('INVALID_LIFECYCLE_DELIVERY_CLAIM', { errorCode: 401 });
    }
  }
  // Stage 2 of ADR-135: the run that reported to Core (reportTo 'core', a task RequestLifecycle did not
  // own) is gone; none was running when it merged (GET /v1/operations/legacy-path, stage2Ready).
  if (input.reportTo !== 'lifecycle') {
    throw new restate.TerminalError('INVALID_DELIVERY_REPORT_TARGET', { errorCode: 400 });
  }
  const run = Number.isInteger(input.run) && Number(input.run) > 0 ? Number(input.run) : 1;
  const base = deliveryBaseId(input.taskId, input.approvalId);

  let prepared: PreparedDelivery | null = null;
  let failure: string | null = null;
  let alreadyComplete = false;
  try {
    prepared = await ctx.run('prepare', () => core.post<PreparedDelivery>(
      `/internal/lifecycle/${encodeURIComponent(input.requestId)}/deliveries/${encodeURIComponent(input.approvalId)}/prepare`,
      { taskId: input.taskId, tenantId: input.tenantId, revisionId: input.revisionId, deliveryId: input.deliveryId, run,
        ...(input.requestRev ? { requestRev: input.requestRev } : {}), ...(input.policy ? { policy: input.policy } : {}) }
    ), PREPARE_RETRY);
  } catch (err) {
    if (!isTerminal(err)) throw err;
    // Delivered already (by an earlier run whose report Core has): nothing to send, nobody to alert.
    if (/DELIVERY_ALREADY_COMPLETE/.test(messageOf(err))) alreadyComplete = true;
    else failure = `PREPARE_FAILED: ${messageOf(err)}`;
  }

  const chatId = prepared?.chatId || input.chatId;
  let filesSent = 0;
  const uncertain: string[] = [];
  const refused: string[] = [];
  if (prepared && chatId) {
    for (const [i, file] of prepared.files.entries()) {
      // The chaos suite kills a process here: some files sent, the others not yet.
      if (i > 0) await chaosPoint('worker.delivery.between-files', { deliveryId: input.deliveryId, taskId: input.taskId, file: i });
      const sent = await ctx.send({
        v: 1,
        key: `${base}:file:${file.artifactId}`,
        chatId,
        kind: 'document',
        exportRef: { tenantId: input.tenantId, taskId: input.taskId, artifactId: file.artifactId, sha256: file.sha256 },
        filename: file.filename,
        // #32 (ADR-145): "<design>, final" in the requester's language; the file keeps its own name.
        caption: composeDeliveredCaption(prepared.notice?.title ?? prepared.title, file.filename),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        class: 'critical',
        tenantId: input.tenantId,
        taskId: input.taskId,
      });
      if (sent.outcome === 'sent') filesSent++;
      else if (sent.outcome === 'uncertain') uncertain.push(file.filename);
      else refused.push(`${file.filename} (${sent.error})`);
    }
    // The notice says what is known. A refused file leaves the delivery failed and the notice unsent,
    // as Core's own delivery did: the office follows up.
    if (prepared.files.length > 0 && refused.length === 0) {
      const text = composeDeliveredMessage({ ...prepared.notice, title: prepared.notice.title ?? prepared.title }, { filesSent, filesUncertain: uncertain.length });
      const notice = await ctx.send({ v: 1, key: `${base}:notice`, chatId, kind: 'text', text, parseMode: 'HTML', class: 'critical', tenantId: input.tenantId, taskId: input.taskId });
      if (notice.outcome === 'uncertain') uncertain.push('delivery notice');
      else if (notice.outcome === 'refused') refused.push(`delivery notice (${notice.error})`);
    }
  } else if (prepared && !chatId) {
    failure = 'NO_REQUESTER_CHAT: the task has no chat to receive the approved files';
  }
  if (prepared && prepared.files.length === 0) {
    failure = 'NO_DELIVERABLE_FILES: Core prepared no approved files for the requester';
  }

  const outcome: DeliveryOutcome = {
    outcome: failure || refused.length ? 'failed' : uncertain.length ? 'uncertain' : prepared?.chatOnly ? 'chat_only' : 'delivered',
    // Within what Core accepts for the report (at most 50 names of 500 characters, ADR-155).
    uncertain: uncertain.slice(0, MAX_REPORTED_NAMES).map((name) => capText(name, MAX_REPORTED_NAME)),
    sheetsConfirmed: alreadyComplete || Boolean(prepared?.sheetsConfirmed),
    archived: alreadyComplete || Boolean(prepared?.archived),
    filesSent,
    ...(failure || refused.length ? { reason: capText(failure || `TELEGRAM_REFUSED: ${refused.join(', ')}`, MAX_REPORTED_REASON) } : {}),
    ...(alreadyComplete ? { reason: 'DELIVERY_ALREADY_COMPLETE: nothing was sent again' } : {}),
  };

  // A delivery that failed is the office's to follow up, every member of it (ADR-155), the requester
  // too when they are one; one that may not have arrived was alerted by TelegramSender, per message.
  // Who the office is was read from the environment beside the step; it is journaled now, so a replay
  // alerts the same people under the same keys.
  if (outcome.outcome === 'failed') {
    const members = await ctx.run('office-chats', async () => officeChatIdsFromEnv(), PREPARE_RETRY);
    const recipients = officeRecipients(input.officeChatId, members);
    for (const [index, officeChat] of recipients.entries()) {
      await ctx.send({
        v: 1,
        key: officeAlertKey(`${input.deliveryId}:failed-alert`, index, officeChat),
        chatId: officeChat,
        kind: 'text',
        text: composeDeliveryFailedAlert(input.taskId, chatId, 1, outcome.reason || 'delivery failed'),
        class: 'critical',
        tenantId: input.tenantId,
        taskId: input.taskId,
      });
    }
  }

  // This is already a Restate object call. Nesting it inside ctx.run creates an extra journal
  // command around the RPC and can strand a completed delivery on replay (Restate 570).
  await ctx.reportLifecycle!(input, outcome);
  return outcome;
}

export type DeliveryHandlers = { run: (ctx: restate.WorkflowContext, input: DeliveryInput) => Promise<DeliveryOutcome> };

export function createDeliveryWorkflow(core: CoreInternal = coreInternalFromEnv()) {
  return restate.workflow({
    name: 'Delivery',
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: DeliveryInput): Promise<DeliveryOutcome> =>
        withInvocationLogContext(ctx, { taskId: input?.taskId, tenantId: input?.tenantId }, () => {
          if (!input || input.v !== 1 || !input.taskId || !input.approvalId || !input.deliveryId) {
            throw new restate.TerminalError('INVALID_DELIVERY: a delivery names its version, task, approval and id', { errorCode: 400 });
          }
          return runDelivery({
            run: (name, action, retry) => ctx.run(name, action, retry),
            send: (message) => ctx.objectClient(TelegramSenderApi, message.chatId).send(message),
            reportLifecycle: (delivery, outcome) =>
              ctx.objectClient(RequestLifecycleApi, delivery.requestId).deliveryFinished({
                v: 1, eventId: `delivery:${delivery.deliveryId}`, requestId: delivery.requestId,
                taskId: delivery.taskId, approvalId: delivery.approvalId,
                deliveryId: delivery.deliveryId, run: Number(delivery.run || 1),
                expectedRev: Number(delivery.requestRev), outcome,
              }),
          }, core, input);
        }),
    },
    // Core starts it through ingress (the publish route); a run lasts minutes, well inside a drain.
    options: { ingressPrivate: false, workflowRetention: { days: 7 }, abortTimeout: { minutes: 10 } },
  });
}

/** Stable workflow client definition used by the private RequestLifecycle owner. */
export const DeliveryApi = createDeliveryWorkflow();
