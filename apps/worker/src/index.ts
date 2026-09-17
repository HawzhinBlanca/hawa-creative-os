import http from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import type { WorkflowDurableContext } from './durable-context.js';
import { withRlsContext, sql, createDb } from '@hawa/db';
import { TaskWorkflowRunner, type WorkflowInput } from './workflow.js';
import { OutboxConsumer } from './outbox-consumer.js';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';
export * from './workflow.js';
export * from './outbox-consumer.js';
export * from './durable-context.js';
export * from './workflow-dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const sharedDb = dbUrl ? createDb(dbUrl) : undefined;


/**
 * Wraps a Restate context so that errors the workflow marks as terminal (refused request,
 * scope mismatch) surface as Restate TerminalErrors. Without this, Restate would retry the
 * failing step forever and the requester would never hear the outcome.
 */
function durableContext(ctx: restate.Context | restate.WorkflowContext): WorkflowDurableContext {
  const isTerminal = (error: any) => Boolean(error?.terminal || error?.cause?.terminal);
  return {
    key: (ctx as any).key,
    run: (name, action) => ctx.run(name, async () => {
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
    }),
    sleep: (millis) => ctx.sleep(millis),
  };
}

const taskService = restate.service({
  name: 'TaskService',
  handlers: {
    runTask: async (ctx: restate.Context, input: WorkflowInput) => {
      const runner = new TaskWorkflowRunner({ db: sharedDb });
      return await runner.run(input, durableContext(ctx));
    },
  },
});

const taskWorkflow = restate.workflow({
  name: 'TaskWorkflow',
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: WorkflowInput) => {
      const runner = new TaskWorkflowRunner({ db: sharedDb });
      return await runner.run(input, durableContext(ctx));
    },
  },
});

const restateHandler = restate
  .endpoint()
  .bind(taskService)
  .bind(taskWorkflow)
  .http1Handler();

let outboxConsumer: OutboxConsumer | null = null;
if (sharedDb) {
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
    outboxConsumer.start();
    console.log('[Worker] OutboxConsumer background processor started');
  } catch (err) {
    console.error('[Worker] Failed to start OutboxConsumer:', err);
  }
}

const port = Number(process.env.PORT || 9080);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    // A worker whose database is unreachable cannot lease or acknowledge anything; say so.
    const tenantId = process.env.HAWA_TENANT_ID || '00000000-0000-4000-a000-000000000001';
    const probe: Promise<{ postgres: string; outbox: { pending: number; staleOver5m: number; failed: number } | null }> = sharedDb
      ? withRlsContext(sharedDb, { tenantId, userId: '00000000-0000-4000-b000-000000000002', role: 'operator' }, async (trx) => {
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
      const degraded = Boolean(outbox && (outbox.staleOver5m > 0 || outbox.failed > 0));
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? (degraded ? 'degraded' : 'healthy') : 'unhealthy',
        worker: 'restate-worker-1',
        buildCommit: process.env.HAWA_BUILD_COMMIT || 'unknown',
        flags: {
          DESIGN_PIPELINE_V3: process.env.DESIGN_PIPELINE_V3 || 'off',
          DESIGN_STUDIO_V2: process.env.DESIGN_STUDIO_V2 || 'off',
        },
        outboxActive: Boolean(outboxConsumer),
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
  console.log(`Hawa Worker listening on port ${port} with Restate services [TaskService, TaskWorkflow]`);
});

const shutdown = () => {
  if (outboxConsumer) {
    outboxConsumer.stop();
  }
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
