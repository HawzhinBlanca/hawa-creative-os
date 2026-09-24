/**
 * DesignRun: one Restate workflow per design run of a lifecycle-owned request (architecture programme
 * Phase 2, slice 2.3; PHASE2_DESIGN.md section 2.4, ADR-034). Key `dr-<taskId>`, or `dr-<taskId>-a<n>`
 * for the n-th re-drive of a round (designRunId in packages/contracts).
 *
 * RequestLifecycle starts it with a one-way send and never waits for it. It runs today's design run
 * (runCanvaDraft) unchanged, with one difference: the outcome is not posted to Core (with an hour of
 * retries and the outbox fallback) but sent to the request's RequestLifecycle as `designFinished`, a
 * journaled one-way send, exactly once, keyed `dr-finished:<runId>`. The lifecycle projects it.
 *
 * The run's own Core calls keep the keys they have today (`workflow-studio-<runKey>`, ...), with
 * runKey the task id or `<task>-redrive-<n>`, so a DesignRun and a TaskWorkflow of one task could never
 * pay for the same work twice.
 *
 * What to design is read from the request's recorded `task.created` row (the fields TaskWorkflow's
 * dispatcher sends), in the step `run-input`, unless the input carries them: the lifecycle keeps no
 * copy of the brief in its state.
 *
 * Cancelled (the request was cancelled while it ran): the studio run it followed is abandoned and it
 * reports CANCELLED, which the lifecycle ignores. TaskWorkflow stays bound for the legacy requests.
 */
import * as restate from '@restatedev/restate-sdk';
import { SYSTEM_AUTOMATION_USER_ID, type CanvaStatusReport, type Versioned } from '@hawa/contracts';
import { OUTBOX_PAYLOAD_PICTURE_PATHS, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { isCancellation, runCanvaDraft, type OutcomeReport } from '../canva-draft-workflow.js';
import type { WorkflowDurableContext } from '../durable-context.js';
import { log, withInvocationLogContext } from '../logging.js';
import { durableContext } from '../restate-context.js';
import { designRunFieldsOf } from '../workflow-dispatcher.js';
import type { WorkflowInput, WorkflowOutput } from '../workflow.js';
import { RequestLifecycleApi } from './request-lifecycle.js';

/**
 * The workflow's input. Fields are only ever added, and only as optional ones (section 4 rule 1).
 * The WorkflowInput fields are optional: without them the run reads them from Postgres.
 */
export interface DesignRunInput extends Versioned, Partial<Omit<WorkflowInput, 'taskId' | 'tenantId'>> {
  taskId: string;
  tenantId: string;
  lifecycle: { requestId: string; round: number; runId: string };
}

export type DesignRunHandlers = { run: (ctx: restate.WorkflowContext, input: DesignRunInput) => Promise<WorkflowOutput> };

/** What a run needs from the request's recorded intake; null when there is no such row. */
export type RunInputFacts = ReturnType<typeof designRunFieldsOf>;

export interface DesignRunDeps {
  readRunInput(tenantId: string, taskId: string): Promise<RunInputFacts | null>;
  /** The run itself; tests pass their own. */
  draft?: typeof runCanvaDraft;
}

/** Reads the round's `task.created` row (recorded, never dispatched), without the pictures a payload may hold. */
export function runInputReader(db: Kysely<Database> | undefined): DesignRunDeps['readRunInput'] {
  return async (tenantId, taskId) => {
    if (!db) throw new Error('DATABASE_NOT_CONFIGURED: a design run reads its brief from Postgres');
    const payload = OUTBOX_PAYLOAD_PICTURE_PATHS.reduce((expr, path) => sql`(${expr} #- ${path}::text[])`, sql`payload`);
    return withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
      const row = (await sql<{ payload: Record<string, unknown> | string }>`
        SELECT ${payload} AS payload FROM hawa.outbox_commands
        WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid AND command_type = 'task.created'
        ORDER BY created_at LIMIT 1`.execute(trx)).rows[0];
      if (!row) return null;
      const body = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      return designRunFieldsOf(body as Record<string, unknown>);
    });
  };
}

/** Checks the input's shape; a malformed one is refused for good. */
export function readDesignRunInput(raw: unknown): DesignRunInput {
  const i = raw as Partial<DesignRunInput> | null;
  if (!i || typeof i !== 'object') throw new restate.TerminalError('INVALID_DESIGN_RUN: the input is not an object', { errorCode: 400 });
  if (i.v !== 1) throw new restate.TerminalError(`INVALID_DESIGN_RUN: this build reads v1, not ${JSON.stringify(i.v)}`, { errorCode: 400 });
  const l = i.lifecycle as Partial<DesignRunInput['lifecycle']> | undefined;
  if (typeof i.taskId !== 'string' || !i.taskId || typeof i.tenantId !== 'string' || !i.tenantId || !l
    || typeof l.requestId !== 'string' || !l.requestId || typeof l.runId !== 'string' || !l.runId || !Number.isInteger(l.round)) {
    throw new restate.TerminalError('INVALID_DESIGN_RUN: a design run names its task, tenant, request, round and run id', { errorCode: 400 });
  }
  return i as DesignRunInput;
}

/** The part of a Restate workflow context a design run uses; tests pass the fake context. */
export type DesignRunContext = Pick<restate.WorkflowContext, 'run' | 'sleep' | 'objectSendClient' | 'key'>;

/** The workflow's body. */
export async function runDesign(
  ctx: DesignRunContext,
  raw: DesignRunInput,
  deps: DesignRunDeps,
  durable: (taskId: string) => WorkflowDurableContext = (taskId) => durableContext(ctx as restate.WorkflowContext, taskId)
): Promise<WorkflowOutput> {
  const input = readDesignRunInput(raw);
  const { requestId, round, runId } = input.lifecycle;
  let cancelled = false;

  const report: OutcomeReport = async (status, body) => {
    const eventId = `dr-finished:${runId}`;
    const outcome = { ...body, status: cancelled ? 'CANCELLED' : status } as CanvaStatusReport;
    ctx.objectSendClient(RequestLifecycleApi, requestId).designFinished(
      { v: 1, eventId, runId, round, taskId: input.taskId, report: outcome },
      restate.rpc.sendOpts({ idempotencyKey: eventId })
    );
  };

  const given = typeof input.rawText === 'string' && typeof input.canvaAutoGenerate === 'boolean';
  let facts: RunInputFacts | null;
  if (given) {
    facts = designRunFieldsOf({
      rawRequestText: input.rawText, workflow: 'canva', autoGenerate: input.canvaAutoGenerate, variant: input.canvaVariant,
      designStudio: input.designStudio, studioOptions: input.studioOptions, sourcePlatform: input.sourcePlatform, clientId: input.clientId,
    });
  } else {
    try {
      facts = await ctx.run('run-input', () => deps.readRunInput(input.tenantId, input.taskId), { initialRetryInterval: 2000, retryIntervalFactor: 2, maxRetryInterval: 30_000, maxRetryDuration: 10 * 60 * 1000 });
    } catch (err) {
      if (isCancellation(err)) throw err;
      log.error(`[DesignRun] ${runId}: the brief of task ${input.taskId} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      facts = null;
    }
  }
  if (!facts) {
    await report('DESIGN_REJECTED', { status: 'DESIGN_REJECTED', code: 'RUN_INPUT_MISSING', detail: 'The design run found no recorded brief for its task.' });
    return { taskId: input.taskId, status: 'DESIGN_REJECTED', qcPassed: false, auditEventsCount: 0, executedSteps: [], replayedSteps: [] };
  }

  const workflowInput: WorkflowInput = {
    ...facts,
    taskId: input.taskId,
    tenantId: input.tenantId,
    idempotencyKey: runId,
    // The lifecycle starts a run only for a request that may be drafted; Core composes every message.
    requesterToldAtIntake: false,
    ...(input.redriveAttempt && input.redriveAttempt > 0 ? { redriveAttempt: input.redriveAttempt } : {}),
  };

  // Cancellation arrives as the next await's error; the report of a cancelled run says so.
  const base = durable(input.taskId);
  const watched: WorkflowDurableContext = {
    ...base,
    run: async (name, action, options) => {
      try { return await base.run(name, action, options); }
      catch (err) { if (isCancellation(err)) cancelled = true; throw err; }
    },
    ...(base.sleep ? {
      sleep: async (ms: number) => {
        try { await base.sleep!(ms); }
        catch (err) { if (isCancellation(err)) cancelled = true; throw err; }
      },
    } : {}),
  };
  return (deps.draft ?? runCanvaDraft)(workflowInput, watched, fetch, undefined, report);
}

export function designRunDepsFromEnv(db: Kysely<Database> | undefined): DesignRunDeps {
  return { readRunInput: runInputReader(db) };
}

export function createDesignRun(deps: DesignRunDeps) {
  return restate.workflow({
    name: 'DesignRun',
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: DesignRunInput): Promise<WorkflowOutput> =>
        withInvocationLogContext(ctx, { taskId: input?.taskId, tenantId: input?.tenantId }, () => runDesign(ctx, input, deps)),
    },
    // Only RequestLifecycle starts it, from inside Restate. A run lasts minutes (at most about 15 when
    // the studio is busy), well inside a blue/green drain.
    options: { ingressPrivate: true, workflowRetention: { days: 7 }, abortTimeout: { minutes: 10 } },
  });
}
