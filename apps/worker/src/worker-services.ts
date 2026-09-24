/**
 * The Restate services this worker build binds, built without starting anything, so index.ts and the
 * tests see the same definitions. Every service any build ever hosted is here (services.ts), and
 * every handler the record in lifecycle/shims.ts requires (HANDLERS_EVER).
 */
import * as restate from '@restatedev/restate-sdk';
import type { Database, Kysely } from '@hawa/db';
import { runCanvaDraft } from './canva-draft-workflow.js';
import { chatInbox } from './lifecycle/chat-inbox.js';
import { createDeliveryWorkflow } from './lifecycle/delivery.js';
import { createDesignRun, designRunDepsFromEnv } from './lifecycle/design-run.js';
import { createRequestLifecycle } from './lifecycle/request-lifecycle.js';
import { createTelegramSender, telegramSenderDepsFromEnv } from './lifecycle/telegram-sender.js';
import { withInvocationLogContext } from './logging.js';
import type { OutcomeRecorder } from './outcome-without-core.js';
import { durableContext } from './restate-context.js';
import { TaskWorkflowRunner, asTerminalIfNotRunnable, type WorkflowInput } from './workflow.js';

export interface WorkerServiceDeps {
  db?: Kysely<Database>;
  /** Outcomes Core would not take are written to the outbox through the worker's own database. */
  recordOutcome?: OutcomeRecorder;
}

export function workerServices(deps: WorkerServiceDeps = {}) {
  const taskService = restate.service({
    name: 'TaskService',
    handlers: {
      runTask: async (ctx: restate.Context, input: WorkflowInput) => withInvocationLogContext(ctx, input, async () => {
        if (input.canvaAutoGenerate) {
          return await runCanvaDraft(input, durableContext(ctx, input.taskId), fetch, deps.recordOutcome);
        }
        const runner = new TaskWorkflowRunner({ db: deps.db });
        try { return await runner.run(input, durableContext(ctx, input.taskId)); }
        catch (error) { throw asTerminalIfNotRunnable(error); }
      }),
    },
  });

  // Legacy requests (owner core) until slice 2.5, then a shim; the live-colour gate probes it for good.
  const taskWorkflow = restate.workflow({
    name: 'TaskWorkflow',
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: WorkflowInput) => withInvocationLogContext(ctx, input, async () => {
        if (input.canvaAutoGenerate) {
          return await runCanvaDraft(input, durableContext(ctx, input.taskId), fetch, deps.recordOutcome);
        }
        const runner = new TaskWorkflowRunner({ db: deps.db });
        try { return await runner.run(input, durableContext(ctx, input.taskId)); }
        catch (error) { throw asTerminalIfNotRunnable(error); }
      }),
    },
  });

  return [
    taskService,
    taskWorkflow,
    // Slice 2.1: one inbox per chat, fed by the worker's Telegram poller.
    chatInbox,
    // Slice 2.2 (PHASE2_DESIGN.md 2.5, 2.6): the Delivery workflow and the per-chat TelegramSender.
    createDeliveryWorkflow(),
    createTelegramSender(telegramSenderDepsFromEnv(deps.db)),
    // Slice 2.3 (2.3, 2.4): the request lifecycle and its design runs.
    createRequestLifecycle(),
    createDesignRun(designRunDepsFromEnv(deps.db)),
  ] as const;
}
