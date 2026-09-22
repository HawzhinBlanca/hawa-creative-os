import * as restate from '@restatedev/restate-sdk';
import type { UUID } from '@hawa/contracts';
import type { Database, Kysely } from '@hawa/db';
import { runCanvaDraft, reportNotRunnable } from './canva-draft-workflow.js';
import type { WorkflowDurableContext } from './durable-context.js';

export interface WorkflowInput {
  taskId: UUID;
  tenantId: UUID;
  clientId?: UUID;
  rawText: string;
  sourcePlatform: string;
  priority?: string;
  idempotencyKey: string;
  canvaAutoGenerate?: boolean;
  /** Requested artboard size recorded at intake; absent for historical tasks. */
  canvaVariant?: { width: number; height: number };
  /** Studio v2 execution flag */
  designStudio?: boolean;
  /** Studio v2 execution options */
  studioOptions?: {
    tier?: 'fast' | 'quality';
    imagery?: 'none' | 'abstract' | 'photographic';
    previews?: number;
    holdForSelection?: boolean;
  };
  /**
   * Set when an operator or the requester asked for the design again (/redo, Desk re-drive). The run
   * is a new one, so every idempotency key it sends Core carries the attempt, and Core does not hand
   * back the first run's answer.
   */
  redriveAttempt?: number;
  /**
   * True when intake already told the requester that no automatic draft is coming (daily cap, no
   * client, instruction only, a reference image). The outcome is still reported, for the task's
   * state, but no second message is sent.
   */
  requesterToldAtIntake?: boolean;
}

export interface WorkflowOutput {
  taskId: UUID;
  status: string;
  briefId?: UUID;
  documentId?: UUID;
  qcPassed: boolean;
  publicationReceipt?: Record<string, unknown>;
  auditEventsCount: number;
  executedSteps: string[];
  replayedSteps: string[];
}

export interface TaskWorkflowRunnerOptions {
  db?: Kysely<Database>;
  /** Transport to Core, for reporting a refusal. Tests inject one; production uses fetch. */
  fetcher?: typeof fetch;
}

/**
 * Runs one task's workflow. There is one path: the Canva draft workflow.
 *
 * A nine-step generator lived here until 2026-09-22 (brief, creative director, HyCanvas-era studio
 * compose, QA, publish), the path production ran before the Canva cutover of 2026-09-13. It was
 * kept for tests, behind a guard that also checked the deployment environment. A later clean-up
 * dropped the environment half of that guard, so any production task dispatched with autoGenerate
 * false (the daily cap declines it, for one) ran the retired generator: model calls paid for a
 * design the approval gate could not use. The generator is gone. A command that is not a Canva
 * job is refused here, visibly, and the outbox records the reason.
 */
export class TaskWorkflowRunner {
  constructor(private readonly options: TaskWorkflowRunnerOptions = {}) {}

  async run(input: WorkflowInput, ctx?: WorkflowDurableContext): Promise<WorkflowOutput> {
    if (!input.canvaAutoGenerate) {
      // The refusal used to end here with nothing reported: the task stayed RECEIVED for good and a
      // requester who had not been told at intake never heard anything. The outcome now goes to Core
      // first (best effort: it never hides the refusal), and Core decides whether to message.
      if (ctx) await reportNotRunnable(input, ctx, this.options.fetcher);
      throw new WorkflowNotRunnableError(
        input.taskId,
        'This task was dispatched without a Canva job (autoGenerate is not set). The only generator is the Canva draft workflow; nothing was run and nothing was spent.'
      );
    }
    if (!ctx) throw new Error('Production Canva workflows require the durable Restate context');
    return runCanvaDraft(input, ctx);
  }
}

/** Terminal: retrying will not change the answer. The outbox consumer dead-letters it at once. */
export class WorkflowNotRunnableError extends Error {
  readonly category = 'permanent' as const;
  /** Read by the Restate adapter: this must not be retried. */
  readonly terminal = true as const;
  constructor(readonly taskId: UUID, message: string) {
    super(`PERMANENT_REJECTION: ${message}`);
    this.name = 'WorkflowNotRunnableError';
  }
}

/**
 * A task that is not a job (a reference image saved for a later request, a brief the cap
 * declined) is still dispatched to the workflow, and the runner refuses it. The refusal used to be
 * thrown as a plain error from the handler, outside any durable step, so Restate retried the
 * invocation without end: on 2026-09-22 two reference-image tasks were re-invoked every few seconds
 * for the rest of the day. A refusal is final; it is reported to Restate as such.
 */
export function asTerminalIfNotRunnable(error: unknown): unknown {
  if (error instanceof WorkflowNotRunnableError) {
    const terminal = new restate.TerminalError(error.message, { errorCode: 422 });
    (terminal as any).cause = error;
    return terminal;
  }
  return error;
}
