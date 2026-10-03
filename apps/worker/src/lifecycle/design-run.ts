/** One workflow per request-owned design attempt (ADR-034, PHASE2_DESIGN.md §2.4). */
import * as restate from '@restatedev/restate-sdk';
import { withStepChaosPoints, type WorkflowDurableContext, type WorkflowStepRetry } from '../durable-context.js';
import { runCanvaDraft, type LifecycleOutcomeReporter } from '../canva-draft-workflow.js';
import type { WorkflowInput, WorkflowOutput } from '../design-input.js';
import { withInvocationLogContext } from '../logging.js';
import { RequestLifecycleApi, type DesignFinishedEvent } from './request-lifecycle.js';
import { TelegramSenderApi } from './telegram-sender.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const CORE_STEP_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2,
  maxRetryInterval: 30000, maxRetryDuration: 10 * 60 * 1000 };

export interface DesignRunInput extends WorkflowInput {
  v: 1;
  /** round: 0 for the original design; ≥ 1 for requester revision rounds. */
  lifecycle: { requestId: string; round: number; runId: string };
  /**
   * ADR-233: what the requester hears once this round's design has really started ("I'll redo …",
   * "I'm now adding what you asked …"): sent when Core admits the run, never before. A round refused at
   * admission says only its outcome; the requester heard "I'll redo" and, a second later, "a designer
   * will make this change by hand" (live test L13).
   */
  startNotice?: DesignStartNotice;
}

export interface DesignStartNotice { key: string; chatId: string; text: string; parseMode?: 'HTML' }

/** A start notice as RequestLifecycle may pass it on: its own key, chat and words, nothing else. */
export function validStartNotice(value: unknown, chatId: string): value is DesignStartNotice {
  const n = value as Partial<DesignStartNotice> | null | undefined;
  return Boolean(n) && typeof n === 'object' && !Array.isArray(n) && typeof n!.key === 'string' && /^[\w:.-]{8,200}$/.test(n!.key) &&
    n!.chatId === chatId && typeof n!.text === 'string' && n!.text.trim().length > 0 && n!.text.length <= 4000 &&
    (n!.parseMode === undefined || n!.parseMode === 'HTML') &&
    Object.keys(n!).every((k) => ['key', 'chatId', 'text', 'parseMode'].includes(k));
}

/**
 * The run of a task's first design is `dr-<taskId>`; an office retry of a design that ended without a
 * draft (ADR-142) is `dr-<taskId>-a<n>`, run with `redriveAttempt: n` so its Studio run has its own key.
 */
export function designRunKeyMatches(input: Pick<DesignRunInput, 'taskId' | 'redriveAttempt'>, key: string): boolean {
  if (key === `dr-${input.taskId}`) return input.redriveAttempt === undefined;
  const attempt = new RegExp(`^dr-${input.taskId}-a([1-9][0-9]*)$`).exec(key);
  return Boolean(attempt) && input.redriveAttempt === Number(attempt![1]);
}

export function validDesignRun(input: DesignRunInput, key: string): boolean {
  return input?.v === 1 && UUID.test(input.taskId) && UUID.test(input.lifecycle?.requestId) &&
    Number.isInteger(input.lifecycle.round) && input.lifecycle.round >= 0 &&
    input.lifecycle.runId === key && designRunKeyMatches(input, key) &&
    input.tenantId === DEFAULT_TENANT_ID && Boolean(input.clientId && UUID.test(input.clientId)) &&
    input.canvaAutoGenerate === true && input.idempotencyKey === `lifecycle:${input.lifecycle.requestId}:${input.taskId}`;
}

/** Kept separate from the Restate adapter so invalid ownership is tested before a paid call. */
export async function runOwnedDesign(
  input: DesignRunInput, key: string, ctx: WorkflowDurableContext,
  report: LifecycleOutcomeReporter['report'], fetcher: typeof fetch = fetch,
  started?: LifecycleOutcomeReporter['started'],
): Promise<WorkflowOutput> {
  if (!validDesignRun(input, key)) {
    throw new restate.TerminalError('DESIGN_RUN_REFUSED: invalid request, task or workflow identity', { errorCode: 409 });
  }
  return runCanvaDraft(input, ctx, fetcher, {
    requestId: input.lifecycle.requestId, runId: input.lifecycle.runId, report, ...(started ? { started } : {}),
  });
}

function durableContext(ctx: restate.WorkflowContext, taskId: string): WorkflowDurableContext {
  const isTerminal = (error: any) => Boolean(error?.terminal || error?.cause?.terminal);
  return withStepChaosPoints({
    key: ctx.key,
    run: (name, action, options?: WorkflowStepRetry) => ctx.run(name, async () => {
      try { return await action(); }
      catch (error: any) {
        if (isTerminal(error)) {
          const terminal = new restate.TerminalError(error?.message || 'terminal workflow failure', { errorCode: 400 });
          (terminal as any).cause = error;
          throw terminal;
        }
        throw error;
      }
    }, !options ? CORE_STEP_RETRY : options.maxRetryDuration !== undefined
      ? { ...CORE_STEP_RETRY, ...options } : { maxRetryAttempts: 5, ...options }),
    sleep: (millis) => ctx.sleep(millis),
  }, taskId);
}

export const DesignRunApi = restate.workflow({
  name: 'DesignRun',
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: DesignRunInput) =>
      withInvocationLogContext(ctx, { requestId: input?.lifecycle?.requestId,
        taskId: input?.taskId, tenantId: input?.tenantId }, () => runOwnedDesign(
        input, ctx.key, durableContext(ctx, input?.taskId || ''), (report) => {
          const event: DesignFinishedEvent = {
            v: 1, eventId: `dr-finished:${input.lifecycle.runId}`,
            requestId: input.lifecycle.requestId, runId: input.lifecycle.runId,
            round: input.lifecycle.round, taskId: input.taskId, report,
          };
          ctx.objectSendClient(RequestLifecycleApi, event.requestId).designFinished(
            event, restate.rpc.sendOpts({ idempotencyKey: event.eventId }),
          );
        }, fetch,
        // ADR-233: Core admitted the run; the requester now hears that it started, once (its key).
        () => {
          const notice = input.startNotice;
          if (!notice) return;
          ctx.objectSendClient(TelegramSenderApi, notice.chatId).send({ v: 1, key: notice.key, chatId: notice.chatId, kind: 'text',
            text: notice.text, ...(notice.parseMode ? { parseMode: notice.parseMode } : {}), class: 'critical',
            tenantId: input.tenantId, taskId: input.taskId }, restate.rpc.sendOpts({ idempotencyKey: notice.key }));
        },
      )),
  },
  options: { ingressPrivate: true, inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 5 },
    retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000,
      maxAttempts: 300, onMaxAttempts: 'pause' } },
});
