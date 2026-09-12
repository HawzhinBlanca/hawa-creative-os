import http from 'node:http';
import * as restate from '@restatedev/restate-sdk';
import { createDb } from '@hawa/db';
import { TaskWorkflowRunner, type WorkflowInput } from './workflow.js';
import { OutboxConsumer } from './outbox-consumer.js';
import { TaskWorkflowDispatcher } from './workflow-dispatcher.js';
export * from './workflow.js';
export * from './outbox-consumer.js';
export * from './durable-context.js';
export * from './workflow-dispatcher.js';

const dbUrl = process.env.DATABASE_URL;
const sharedDb = dbUrl ? createDb(dbUrl) : undefined;

const taskService = restate.service({
  name: 'TaskService',
  handlers: {
    runTask: async (ctx: restate.Context, input: WorkflowInput) => {
      const runner = new TaskWorkflowRunner({ db: sharedDb });
      return await runner.run(input, ctx);
    },
  },
});

const taskWorkflow = restate.workflow({
  name: 'TaskWorkflow',
  handlers: {
    run: async (ctx: restate.WorkflowContext, input: WorkflowInput) => {
      const runner = new TaskWorkflowRunner({ db: sharedDb });
      return await runner.run(input, ctx);
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
    outboxConsumer = new OutboxConsumer(sharedDb, {
      batchSize: Number(process.env.OUTBOX_BATCH_SIZE || 20),
      pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS || 1000),
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      worker: 'restate-worker-1',
      outboxActive: Boolean(outboxConsumer),
      timestamp: new Date().toISOString(),
    }));
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
