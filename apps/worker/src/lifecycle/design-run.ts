/** One workflow per request-owned design attempt (ADR-034, PHASE2_DESIGN.md §2.4). */
import * as restate from '@restatedev/restate-sdk';
import { withStepChaosPoints, type WorkflowDurableContext, type WorkflowStepRetry } from '../durable-context.js';
import { runCanvaDraft, type LifecycleOutcomeReporter } from '../canva-draft-workflow.js';
import type { WorkflowInput, WorkflowOutput } from '../workflow.js';
import { withInvocationLogContext } from '../logging.js';
import { RequestLifecycleApi, type DesignFinishedEvent } from './request-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TENANT_ID = '00000000-0000-4000-a000-000000000001';
const CORE_STEP_RETRY = { initialRetryInterval: 2000, retryIntervalFactor: 2,
  maxRetryInterval: 30000, maxRetryDuration: 10 * 60 * 1000 };

export interface DesignRunInput extends WorkflowInput {
  v: 1;
  lifecycle: { requestId: string; round: 0; runId: string };
}

export function validDesignRun(input: DesignRunInput, key: string): boolean {
  return input?.v === 1 && UUID.test(input.taskId) && UUID.test(input.lifecycle?.requestId) &&
    input.lifecycle.round === 0 && input.lifecycle.runId === key && key === `dr-${input.taskId}` &&
    input.tenantId === DEFAULT_TENANT_ID && Boolean(input.clientId && UUID.test(input.clientId)) &&
    input.canvaAutoGenerate === true && input.idempotencyKey === `lifecycle:${input.lifecycle.requestId}:${input.taskId}`;
}

/** Kept separate from the Restate adapter so invalid ownership is tested before a paid call. */
export async function runOwnedDesign(
  input: DesignRunInput, key: string, ctx: WorkflowDurableContext,
  report: LifecycleOutcomeReporter['report'], fetcher: typeof fetch = fetch,
): Promise<WorkflowOutput> {
  if (!validDesignRun(input, key)) {
    throw new restate.TerminalError('DESIGN_RUN_REFUSED: invalid request, task or workflow identity', { errorCode: 409 });
  }
  return runCanvaDraft(input, ctx, fetcher, undefined, { requestId: input.lifecycle.requestId, report });
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
            round: 0, taskId: input.taskId, report,
          };
          ctx.objectSendClient(RequestLifecycleApi, event.requestId).designFinished(
            event, restate.rpc.sendOpts({ idempotencyKey: event.eventId }),
          );
        }, fetch,
      )),
  },
  options: { ingressPrivate: true, inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 5 },
    retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60_000,
      maxAttempts: 300, onMaxAttempts: 'pause' } },
});
