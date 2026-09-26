/**
 * Delivery: one Restate workflow per run of a publication's delivery (architecture programme Phase 2,
 * slice 2.2; PHASE2_DESIGN.md section 2.5, ADR-034). Key `dl-<task>-<approval>`, and
 * `dl-<task>-<approval>:archive:<n>` for a later run that retries the Drive archive or the Sheets row.
 *
 * It replaces, for a task whose chat is on HAWA_LIFECYCLE_CHATS when Deliver is pressed, Core's own
 * delivery run from the HTTP request (deliveriesInFlight, reopenInterruptedDelivery) and the outbox's
 * `notify.published` command:
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
import { composeDeliveredMessage, composeDeliveryFailedAlert } from '../delivery-notification.js';
import { log, requestIdHeaders, withInvocationLogContext } from '../logging.js';
import { TelegramSenderApi } from './telegram-sender.js';
import { RequestLifecycleApi } from './request-lifecycle.js';

/** A Core step's retry: from 2 s doubling to 30 s, for up to 10 minutes (as TaskWorkflow's steps). */
export const PREPARE_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30000, maxRetryDuration: 10 * 60 * 1000 };
/**
 * The report waits an hour for Core, as the design run's outcome report does. Longer would keep the
 * run, and so its worker colour, from draining during a deploy. A report that gives up is not lost:
 * the workflow ends with the outcome as its output, and the next Deliver press reads it from Restate
 * and records it (startWorkflowDelivery in Core).
 */
export const REPORT_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 60000, maxRetryDuration: 60 * 60 * 1000 };
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
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new restate.TerminalError(what, { errorCode: res.status });
      }
      throw new Error(what);
    },
  };
}

const isTerminal = (err: unknown) => err instanceof restate.TerminalError;
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
    if (!verifyLifecycleDeliveryClaim(process.env.HAWA_WORKER_TOKEN || '', claim, claimSignature)) {
      throw new restate.TerminalError('INVALID_LIFECYCLE_DELIVERY_CLAIM', { errorCode: 401 });
    }
  }
  if (input.reportTo !== 'core' && input.reportTo !== 'lifecycle') {
    throw new restate.TerminalError('INVALID_DELIVERY_REPORT_TARGET', { errorCode: 400 });
  }
  const run = Number.isInteger(input.run) && Number(input.run) > 0 ? Number(input.run) : 1;
  const base = deliveryBaseId(input.taskId, input.approvalId);
  const officeChat = input.officeChatId || (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).find(Boolean) || null;

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
        caption: file.filename,
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
    uncertain,
    sheetsConfirmed: alreadyComplete || Boolean(prepared?.sheetsConfirmed),
    archived: alreadyComplete || Boolean(prepared?.archived),
    filesSent,
    ...(failure || refused.length ? { reason: failure || `TELEGRAM_REFUSED: ${refused.join(', ')}` } : {}),
    ...(alreadyComplete ? { reason: 'DELIVERY_ALREADY_COMPLETE: nothing was sent again' } : {}),
  };

  // A delivery that failed is the office's to follow up; one that may not have arrived was alerted by
  // TelegramSender, per message.
  if (outcome.outcome === 'failed' && officeChat && officeChat !== chatId) {
    await ctx.send({
      v: 1,
      key: `${input.deliveryId}:failed-alert`,
      chatId: officeChat,
      kind: 'text',
      text: composeDeliveryFailedAlert(input.taskId, chatId, 1, outcome.reason || 'delivery failed'),
      class: 'critical',
      tenantId: input.tenantId,
      taskId: input.taskId,
    });
  }

  try {
    if (input.reportTo === 'lifecycle') {
      // This is already a Restate object call. Nesting it inside ctx.run creates an extra journal
      // command around the RPC and can strand a completed delivery on replay (Restate 570).
      await ctx.reportLifecycle!(input, outcome);
    } else {
      await ctx.run('report', () => core.post(`/internal/tasks/${encodeURIComponent(input.taskId)}/delivery-finished`, {
        tenantId: input.tenantId,
        deliveryId: input.deliveryId,
        approvalId: input.approvalId,
        run,
        outcome,
      }), REPORT_RETRY);
    }
  } catch (err) {
    if (!isTerminal(err)) throw err;
    if (input.reportTo === 'lifecycle') throw err;
    // The requester has what was sent; the task stays PUBLISHING until Deliver is pressed again, which
    // reads this run's output and records it.
    log.error(`[Delivery] ${input.deliveryId} ended ${outcome.outcome}, and Core did not take the report: ${messageOf(err)}`);
  }
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
