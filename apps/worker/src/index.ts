import http from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import { withStepChaosPoints, type WorkflowDurableContext, type WorkflowStepRetry } from './durable-context.js';
import { withRlsContext, sql, createDb } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import { TaskWorkflowRunner, asTerminalIfNotRunnable, type WorkflowInput } from './workflow.js';
import { OutboxConsumer } from './outbox-consumer.js';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';
import { LiveColourGate, runWhileLive, backgroundLoopsFromEnv, type LoopHandle } from './live-colour.js';
import { log, withInvocationLogContext } from './logging.js';

const SERVICE_NAME = 'hawa-worker';
// A long-running service that dies without saying why is the hardest kind of outage to diagnose,
// and compose restarts it, so the only trace left is a gap in the logs. Node terminates the
// process on an unhandled rejection by default; these handlers make the reason survive the exit.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.fatal(`[${SERVICE_NAME}] FATAL unhandledRejection: ${err.message}`, err);
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  log.fatal(`[${SERVICE_NAME}] FATAL uncaughtException: ${err.message}`, err);
  process.exit(1);
});
import { runCanvaDraft } from './canva-draft-workflow.js';
import { outcomeRecorder } from './outcome-without-core.js';
export * from './workflow.js';
export * from './canva-draft-workflow.js';
export * from './outbox-consumer.js';
export * from './durable-context.js';
export * from './workflow-dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const sharedDb = dbUrl ? createDb(dbUrl) : undefined;

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
const CORE_STEP_RETRY = {
  initialRetryInterval: 2000,
  retryIntervalFactor: 2,
  maxRetryInterval: 30000,
  maxRetryDuration: 10 * 60 * 1000,
};
const stepRetry = (options?: WorkflowStepRetry) =>
  !options ? CORE_STEP_RETRY : options.maxRetryDuration !== undefined ? { ...CORE_STEP_RETRY, ...options } : { maxRetryAttempts: 5, ...options };

/** Outcomes Core would not take are written to the outbox through the worker's own database. */
const recordOutcome = sharedDb ? outcomeRecorder(sharedDb) : undefined;

/**
 * Wraps a Restate context so that errors the workflow marks as terminal (refused request,
 * scope mismatch) surface as Restate TerminalErrors. Without this, Restate would retry the
 * failing step forever and the requester would never hear the outcome.
 */
function durableContext(ctx: restate.Context | restate.WorkflowContext, taskId?: string): WorkflowDurableContext {
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

const taskService = restate.service({
  name: 'TaskService',
  handlers: {
    runTask: async (ctx: restate.Context, input: WorkflowInput) => withInvocationLogContext(ctx, input, async () => {
      if (input.canvaAutoGenerate) {
        return await runCanvaDraft(input, durableContext(ctx, input.taskId), fetch, recordOutcome);
      }
      const runner = new TaskWorkflowRunner({ db: sharedDb });
      try { return await runner.run(input, durableContext(ctx, input.taskId)); }
      catch (error) { throw asTerminalIfNotRunnable(error); }
    }),
  },
});

const taskWorkflow = restate.workflow({
  name: 'TaskWorkflow',
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: WorkflowInput) => withInvocationLogContext(ctx, input, async () => {
      if (input.canvaAutoGenerate) {
        return await runCanvaDraft(input, durableContext(ctx, input.taskId), fetch, recordOutcome);
      }
      const runner = new TaskWorkflowRunner({ db: sharedDb });
      try { return await runner.run(input, durableContext(ctx, input.taskId)); }
      catch (error) { throw asTerminalIfNotRunnable(error); }
    }),
  },
});

const restateHandler = restate
  .endpoint()
  .bind(taskService)
  .bind(taskWorkflow)
  .http1Handler();

let outboxConsumer: OutboxConsumer | null = null;
// Blue/green (architecture programme 0.1): a colour runs the outbox only while it is the one Restate
// sends new work to. Without HAWA_WORKER_SELF_URI the worker is alone and runs it as before.
const backgroundMode = backgroundLoopsFromEnv();
const liveGate = backgroundMode.mode === 'live-colour'
  ? new LiveColourGate({ adminUrl: backgroundMode.adminUrl, selfUri: backgroundMode.selfUri, takeoverMs: backgroundMode.takeoverMs, refreshMs: backgroundMode.refreshMs })
  : null;
let gatedLoop: LoopHandle | null = null;
if (backgroundMode.mode === 'misconfigured') log.error(`[Worker] Outbox not started: ${backgroundMode.reason}`);
if (sharedDb && backgroundMode.mode !== 'misconfigured') {
  try {
    const dispatcher = new TaskWorkflowDispatcher({
      restateIngressUrl: process.env.RESTATE_INGRESS_URL,
      db: sharedDb,
    });
    const tenantIdsEnv = process.env.TENANT_IDS || process.env.HAWA_TENANT_IDS;
    const tenantIds = tenantIdsEnv ? tenantIdsEnv.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    outboxConsumer = new OutboxConsumer(sharedDb, {
      batchSize: Number(process.env.OUTBOX_BATCH_SIZE || 20),
      pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000),
      tenantIds,
      dispatcher,
    });
    if (liveGate) {
      const consumer = outboxConsumer;
      gatedLoop = runWhileLive({ gate: liveGate, tick: () => consumer.processBatch(), intervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000) });
      log.info(`[Worker] OutboxConsumer runs while ${process.env.HAWA_WORKER_SELF_URI} is the live colour`);
    } else {
      outboxConsumer.start();
      log.info('[Worker] OutboxConsumer background processor started');
    }
  } catch (err) {
    log.error('[Worker] Failed to start OutboxConsumer:', err);
  }
}

const port = Number(process.env.PORT || 9080);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    // A worker whose database is unreachable cannot lease or acknowledge anything; say so.
    const tenantId = process.env.HAWA_TENANT_ID || '00000000-0000-4000-a000-000000000001';
    const probe: Promise<{ postgres: string; outbox: { pending: number; staleOver5m: number; failed: number } | null }> = sharedDb
      ? withRlsContext(sharedDb, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
          const row = (await sql<{ pending: string; stale: string; failed: string }>`
            SELECT count(*) FILTER (WHERE state = 'pending') AS pending,
                   count(*) FILTER (WHERE state = 'pending' AND created_at < now() - interval '5 minutes') AS stale,
                   count(*) FILTER (WHERE state = 'failed') AS failed
            FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid`.execute(trx)).rows[0];
          return { postgres: 'connected', outbox: { pending: Number(row?.pending || 0), staleOver5m: Number(row?.stale || 0), failed: Number(row?.failed || 0) } };
        }).catch(() => ({ postgres: 'disconnected', outbox: null }))
      : Promise.resolve({ postgres: 'unconfigured', outbox: null });
    probe.then(({ postgres, outbox }) => {
      const healthy = postgres !== 'disconnected';
      // Backlog or dead letters degrade the worker without failing the container health check.
      const degraded = Boolean(outbox && (outbox.staleOver5m > 0 || outbox.failed > 0)) || backgroundMode.mode === 'misconfigured';
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? (degraded ? 'degraded' : 'healthy') : 'unhealthy',
        worker: 'restate-worker-1',
        buildCommit: process.env.HAWA_BUILD_COMMIT || 'unknown',
        flags: {
          DESIGN_PIPELINE_V3: process.env.DESIGN_PIPELINE_V3 || 'off',
          DESIGN_STUDIO_V2: process.env.DESIGN_STUDIO_V2 || 'off',
        },
        outboxActive: Boolean(outboxConsumer) && (!liveGate || liveGate.state() === 'live'),
        // blue/green: 'live' runs the outbox; 'standby' is a draining (or not yet registered) colour.
        colour: process.env.HAWA_WORKER_COLOUR || null,
        background: backgroundMode.mode === 'always' ? 'always' : backgroundMode.mode === 'misconfigured' ? 'misconfigured' : liveGate!.state(),
        dependencies: { postgres },
        outbox,
        timestamp: new Date().toISOString(),
      }));
    });
    return;
  }
  if (req.url === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ready',
      services: ['TaskService', 'TaskWorkflow'],
      outboxConsumer: outboxConsumer ? 'active' : 'idle',
    }));
    return;
  }
  restateHandler(req, res);
});

server.listen(port, () => {
  log.info(`Hawa Worker listening on port ${port} with Restate services [TaskService, TaskWorkflow]`);
});

const shutdown = () => {
  gatedLoop?.stop();
  if (outboxConsumer) {
    outboxConsumer.stop();
  }
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
