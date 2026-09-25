/**
 * The durable context the design runs are written against (runCanvaDraft, TaskWorkflowRunner), built
 * from a Restate context. Shared by TaskWorkflow and TaskService (index.ts) and by DesignRun
 * (lifecycle/design-run.ts, slice 2.3), so the three retry and report the same way.
 */
import * as restate from '@restatedev/restate-sdk';
import { withStepChaosPoints, type WorkflowDurableContext, type WorkflowStepRetry } from './durable-context.js';

/**
 * How long a step keeps retrying a Core that does not answer. Every step this worker journals is a
 * call to Core (runCanvaDraft, reportNotRunnable). Five attempts at the SDK's default spacing (50 ms,
 * doubling) ended a step in under a second, so a Core restart or deploy (10–60 s) during a design
 * failed the step, the workflow reported DESIGN_SERVER_ERROR to a Core that was still down, and the
 * requester of a paid run was never told (2026-09-23). Core deduplicates these calls (idempotency
 * keys, studio stages persisted before advancing, one in-flight resume per run, the outbox for the
 * outcome), so a retry pays for nothing twice. They now back off from 2 s to a 30 s ceiling for up to
 * 10 minutes: that outlasts a restart, and a real outage still ends in a reported outcome.
 *
 * A step that pays for work Core does not deduplicate (the parity check's model call) passes its own
 * options and keeps the old bound of five quick attempts.
 *
 * A step that names its own duration keeps this schedule and only stretches it: the outcome report
 * waits an hour for Core, since a report lost with Core is the requester's only answer (2026-09-24).
 */
export const CORE_STEP_RETRY = {
  initialRetryInterval: 2000,
  retryIntervalFactor: 2,
  maxRetryInterval: 30000,
  maxRetryDuration: 10 * 60 * 1000,
};

export const stepRetry = (options?: WorkflowStepRetry) =>
  !options ? CORE_STEP_RETRY : options.maxRetryDuration !== undefined ? { ...CORE_STEP_RETRY, ...options } : { maxRetryAttempts: 5, ...options };

/**
 * Wraps a Restate context so that errors the workflow marks as terminal (refused request,
 * scope mismatch) surface as Restate TerminalErrors. Without this, Restate would retry the
 * failing step forever and the requester would never hear the outcome.
 */
export function durableContext(ctx: restate.Context | restate.WorkflowContext, taskId?: string): WorkflowDurableContext {
  const isTerminal = (error: any) => Boolean(error?.terminal || error?.cause?.terminal);
  // The chaos suite can stop the worker between a step's side effect and its journal entry.
  return withStepChaosPoints({
    key: (ctx as any).key,
    run: (name, action, options) => ctx.run(name, async () => {
      try { return await action(); }
      catch (error: any) {
        if (isTerminal(error)) {
          // Keep the original error reachable so the workflow can still report the refusal reason.
          const terminal = new restate.TerminalError(error?.message || 'terminal workflow failure', { errorCode: 400 });
          (terminal as any).cause = error;
          throw terminal;
        }
        throw error;
      }
    }, stepRetry(options)),
    sleep: (millis) => ctx.sleep(millis),
  }, taskId);
}
