import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import { createDb, OutboxRepository, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { captureLogs, runWithLogContext } from '@hawa/observability';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import { withInvocationLogContext } from '../src/logging.js';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * Architecture programme 1.4: one request id follows a design from Core through the outbox, Restate
 * and the worker's calls back to Core, and every log line on the way carries it.
 */

const taskId = '00000000-0000-4000-c000-00000000a114';
const input: WorkflowInput = {
  taskId,
  tenantId: '00000000-0000-4000-a000-000000000001',
  clientId: 'client',
  rawText: '',
  sourcePlatform: 'telegram',
  idempotencyKey: 'key',
  canvaAutoGenerate: true,
  designStudio: true,
};

/**
 * A Restate context as the handler sees it: the ingress headers, the invocation id, and steps that,
 * like Restate's once their retries are spent, end in a TerminalError.
 */
const invocation = (headers: Record<string, string>) => ({
  key: 'wf-log',
  request: () => ({ id: 'inv_1logtest', headers: new Map(Object.entries(headers)) }),
  run: async <T>(_name: string, action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (err: any) { throw new restate.TerminalError(String(err?.message || err)); }
  },
  sleep: async () => {},
});

let capture: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('a Restate handler logs under the request id it was started with', () => {
  // A studio run that stops following and then cannot abandon it: the worker logs a warning.
  const stuckCore = () =>
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith('/resume')) return Response.json({ runId: 'run-log', status: 'laying_out' });
      if (u.endsWith('/canva/studio')) return Response.json({ runId: 'run-log', status: 'briefing' });
      if (u.endsWith('/abandon')) return new Response('{}', { status: 500 });
      if (u.includes('/notifications/')) return Response.json({ ok: true });
      return Response.json({ tenantId: input.tenantId, clientId: 'client' });
    });

  it('from the x-request-id header: on its log lines and on every call it makes to Core', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    capture = captureLogs();
    const core = stuckCore();
    const ctx = invocation({ 'x-request-id': 'req-from-core-1' });
    const out = await withInvocationLogContext(ctx, input, () => runCanvaDraft(input, ctx as any, core as any));
    expect(out.status).toBe('DESIGN_STUCK');

    const warned = capture.lines.filter((l) => l.level === 'warn' && l.msg.includes('could not be abandoned'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ service: 'worker', requestId: 'req-from-core-1', taskId, tenantId: input.tenantId });
    expect(core.mock.calls.length).toBeGreaterThan(2);
    for (const [, init] of core.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect((init.headers as Record<string, string>)['x-request-id']).toBe('req-from-core-1');
    }
  });

  it('from its input when the header is missing, else from the invocation id', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    capture = captureLogs();
    const ctx = invocation({});
    await withInvocationLogContext(ctx, { ...input, requestId: 'req-in-payload' }, () => runCanvaDraft(input, ctx as any, stuckCore() as any));
    await withInvocationLogContext(ctx, input, () => runCanvaDraft(input, ctx as any, stuckCore() as any));
    const ids = capture.lines.filter((l) => l.msg.includes('could not be abandoned')).map((l) => l.requestId);
    expect(ids).toEqual(['req-in-payload', 'restate-inv_1logtest']);
  });
});

describe('an outbox command carries the id of the request that wrote it to Restate', () => {
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'administrator' };
  let db: Kysely<Database>;
  beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
  afterAll(async () => { await db?.destroy(); });

  it('Core writes it into the payload; the dispatcher sends it to Restate as a header and in the input', async () => {
    const asTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, scope, fn);
    await asTenant((trx) => trx.deleteFrom('outbox_commands').where('tenant_id', '=', tenantId).execute());
    // What Core does inside a request: the repository takes the id from the log context.
    const aggregateId = randomUUID();
    const row = await runWithLogContext({ requestId: 'req-core-outbox-1' }, () =>
      asTenant((trx) => new OutboxRepository(db).enqueue({
        tenantId, aggregateType: 'task', aggregateId, commandType: 'task.dispatch',
        idempotencyKey: `log-test-${randomUUID()}`, payload: { sourcePlatform: 'telegram', sourceChannelId: '4242' },
      }, trx))
    );
    expect((row.payload as Record<string, unknown>).requestId).toBe('req-core-outbox-1');

    const ingress = vi.fn(async () => Response.json({ invocationId: 'inv_logtest1' }, { status: 202 }));
    vi.stubGlobal('fetch', ingress);
    const consumer = new OutboxConsumer(db, {
      tenantIds: [tenantId],
      dispatcher: new TaskWorkflowDispatcher({ restateIngressUrl: 'http://restate.test:8080', db }),
      telegramBotToken: null,
    });
    const summary = await consumer.processBatch(5);
    expect(summary.succeeded).toBe(1);

    expect(ingress).toHaveBeenCalledTimes(1);
    const [url, init] = ingress.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/TaskWorkflow/task-wf-${aggregateId}/run/send`);
    expect((init.headers as Record<string, string>)['x-request-id']).toBe('req-core-outbox-1');
    expect(JSON.parse(String(init.body)).requestId).toBe('req-core-outbox-1');
  });
});
