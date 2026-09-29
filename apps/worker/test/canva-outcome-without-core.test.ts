import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/restate-sdk';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { runCanvaDraft } from '../src/canva-draft-workflow.js';
import { outcomeRecorder } from '../src/outcome-without-core.js';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import type { WorkflowInput } from '../src/workflow.js';

/**
 * 2026-09-24 fixes to the Canva draft workflow, beyond the hunt tests (canva-draft-giveup,
 * canva-draft-transient): an outcome Core does not take is written to the outbox by the worker; a
 * token-refresh collision retried to the end of its window is still reported as what it was; a
 * parity check with no verdict is not a match, and a parity check Core answered is not paid for twice.
 */

/** Like Restate: a failing step is retried `attempts` times, then ctx.run throws a TerminalError. */
function restateLikeContext(attempts = 3) {
  const steps: string[] = [];
  const ctx = {
    key: 'wf-outcome',
    run: async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      steps.push(name);
      let last: any;
      for (let i = 0; i < attempts; i++) {
        try { return await action(); } catch (err: any) { if (err?.terminal) throw new restate.TerminalError(err.message); last = err; }
      }
      throw new restate.TerminalError(`${last?.message || last}`);
    },
    sleep: async () => {},
  };
  return { ctx, steps };
}

// Tenant 8 (db/test-fixtures.sql): no other suite drains its outbox, so no consumer leases these rows.
const tenantId = '00000000-0000-4000-a000-000000000008';
const userId = '00000000-0000-4000-b000-000000000008';
const clientId = '00000000-0000-4000-c000-000000000008';
const office = '9505';
let db: Kysely<Database>;
const outbox = () => new OutboxRepository(db);
const asTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, { tenantId, userId, role: 'administrator' }, fn);
const rowsOf = (taskId: string) =>
  asTenant(async (trx) => (await sql<{ id: string; command_type: string; idempotency_key: string; payload: any; state: string }>`
    SELECT id, command_type, idempotency_key, payload, state FROM hawa.outbox_commands
    WHERE tenant_id = ${tenantId}::uuid AND aggregate_id = ${taskId}::uuid ORDER BY idempotency_key`.execute(trx)).rows);
const created: string[] = [];

beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  // This suite's rows are retired, so no other suite's consumer ever sends them.
  for (const taskId of created) {
    for (const row of await rowsOf(taskId)) {
      await asTenant(async (trx) => {
        if (row.state !== 'failed') await outbox().markPermanentFailure(row.id, 'outcome test cleanup', trx);
        await outbox().retire(tenantId, row.id, 'outcome test cleanup', 'test', trx);
      });
    }
  }
  await db?.destroy();
});

async function telegramTask(chat: string) {
  const taskId = randomUUID();
  created.push(taskId);
  await asTenant(async (trx) => {
    await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
      VALUES (${taskId}::uuid, ${tenantId}::uuid, ${clientId}::uuid, 'Core-down poster', '', 'received', 3, 1, now(), now())`.execute(trx);
    await sql`INSERT INTO hawa.task_events (id, tenant_id, task_id, aggregate_version, event_type, actor_type, actor_id, correlation_id, data, occurred_at)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${taskId}::uuid, 1, 'task.created', 'user', ${userId}, ${randomUUID()}::uuid,
        ${JSON.stringify({ payload: { sourcePlatform: 'telegram', sourceChannelId: chat } })}::jsonb, now())`.execute(trx);
  });
  return taskId;
}

const coreDown = () => vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });

describe('an outcome Core does not take', () => {
  it('is written to the outbox by the worker: the requester, the office and the report, once each', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const chat = String(7500 + Math.floor(Math.random() * 400));
    const taskId = await telegramTask(chat);
    const input: WorkflowInput = { taskId, tenantId, clientId, rawText: '', sourcePlatform: 'telegram', idempotencyKey: 'k', canvaAutoGenerate: true, designStudio: true };
    const record = outcomeRecorder(db, { userId, officeChatId: office });

    const { ctx, steps } = restateLikeContext();
    const out = await runCanvaDraft(input, ctx as any, coreDown() as any, record);
    expect(out.status).toBe('DESIGN_SERVER_ERROR');
    expect(steps.filter((s) => s.startsWith('canva-outcome-without-core-'))).toEqual(['canva-outcome-without-core-design_server_error']);

    const rows = await rowsOf(taskId);
    const key = `${taskId}:DESIGN_SERVER_ERROR:RETRY_EXHAUSTED:no-run`;
    expect(rows.map((r) => [r.command_type, r.idempotency_key])).toEqual([
      ['notify.telegram', `notify.office:outcome-unrecorded:${key}`],
      // Core's own key for this outcome, so a Core that takes the report later sends nothing twice.
      ['notify.telegram', `notify.telegram:${key}`],
      ['task.outcome', `task.outcome:${key}`],
    ]);
    const requester = rows.find((r) => r.idempotency_key === `notify.telegram:${key}`)!;
    expect(requester.payload.chatId).toBe(chat);
    // ADR-145: plain words by the design's name; no service names and no reference number.
    expect(requester.payload.message).toContain("I couldn't finish");
    expect(requester.payload.message).toContain('automatically. The office will follow up with you here.');
    expect(requester.payload.message).not.toMatch(/Reference|Canva|Hawa/);
    expect(rows.find((r) => r.command_type === 'task.outcome')!.payload.report).toMatchObject({ status: 'DESIGN_SERVER_ERROR', code: 'RETRY_EXHAUSTED' });
    expect(rows.find((r) => r.idempotency_key.startsWith('notify.office:'))!.payload.chatId).toBe(office);

    // A replay of the workflow (or a second worker) writes nothing new.
    await runCanvaDraft(input, restateLikeContext().ctx as any, coreDown() as any, record);
    expect((await rowsOf(taskId)).length).toBe(3);
  });

  it('writes nothing when Core had recorded it and only its answer was lost', async () => {
    const taskId = await telegramTask('7499');
    const key = `notify.telegram:${taskId}:DESIGN_STUCK:STUCK_IN_LAYING_OUT:run-1`;
    await asTenant((trx) => outbox().enqueue({ tenantId, aggregateType: 'task', aggregateId: taskId, commandType: 'notify.telegram', idempotencyKey: key, payload: { chatId: '7499', message: 'from Core' } }, trx));
    const recorded = await outcomeRecorder(db, { userId, officeChatId: office })({
      tenantId, taskId, report: { status: 'DESIGN_STUCK', code: 'STUCK_IN_LAYING_OUT', runId: 'run-1' },
    });
    expect(recorded).toEqual({ skipped: 'Core recorded this outcome already' });
    expect((await rowsOf(taskId)).map((r) => r.idempotency_key)).toEqual([key]);
  });

  it('is sent to Core again by the outbox until Core takes it', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    vi.stubEnv('HAWA_CORE_INTERNAL_URL', 'http://core.test');
    const taskId = await telegramTask('7498');
    await outcomeRecorder(db, { userId, officeChatId: null })({ tenantId, taskId, report: { status: 'DESIGN_FAILED', code: 'HARD_QA_REFUSED', runId: 'run-2' } });
    const posted: Array<{ url: string; body: any }> = [];
    let answer = 503;
    const coreFetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: answer });
    });
    // The handler is driven directly: a batch would lease every pending command of the shared tenant.
    const handler = (new OutboxConsumer(db, { tenantId, userId, telegramBotToken: null, coreFetcher: coreFetcher as any }) as any).handlers.get('task.outcome');
    const cmd = (await rowsOf(taskId)).find((r) => r.command_type === 'task.outcome')!;
    const replay = () => handler({ ...cmd, aggregate_id: taskId, tenant_id: tenantId }, db).then(() => 'taken', (e: Error) => e.message);
    expect(await replay()).toContain('CORE_UNAVAILABLE');
    answer = 200;
    expect(await replay()).toBe('taken');
    expect(posted[1].url).toBe(`http://core.test/v1/tasks/${taskId}/notifications/canva-status`);
    expect(posted[1].body).toEqual({ status: 'DESIGN_FAILED', code: 'HARD_QA_REFUSED', runId: 'run-2' });
    answer = 404;
    expect(await replay()).toContain('CORE_REFUSED_OUTCOME');
  });
});

describe('a Canva token refresh collision', () => {
  it('still reads as the refusal it was once the step has retried it to the end of its window', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const input: WorkflowInput = { taskId: randomUUID(), tenantId: 'tenant', clientId: 'client', rawText: '', sourcePlatform: 'telegram', idempotencyKey: 'k', canvaAutoGenerate: true };
    const reports: any[] = [];
    let exportTries = 0;
    const remote = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/notifications/')) { reports.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
      if (u.endsWith('/canva/generate')) return Response.json({ status: 'retrieved', designId: 'DA_collide' });
      if (u.endsWith('/canva')) return Response.json({ binding: { designId: 'DA_collide', version: 1 } });
      if (u.endsWith('/canva/exports')) { exportTries++; return Response.json({ title: 'CANVA_RECONNECT_REQUIRED' }, { status: 409 }); }
      return Response.json({ tenantId: 'tenant', clientId: 'client' });
    });
    const out = await runCanvaDraft(input, restateLikeContext(4).ctx as any, remote as any);
    expect(exportTries).toBe(4);
    expect(out.status).toBe('CANVA_PREVIEW_FAILED');
    expect(reports).toEqual([expect.objectContaining({ status: 'CANVA_PREVIEW_FAILED', code: 'CANVA_RECONNECT_REQUIRED', designId: 'DA_collide' })]);
  });
});

describe('the parity check', () => {
  const studio = (parityReply: () => Response) => {
    const calls: string[] = [];
    const reports: any[] = [];
    const remote = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/notifications/')) { reports.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
      if (u.endsWith('/canva/studio')) return Response.json({ runId: 'run-p', status: 'transferred', designId: 'DA_p' });
      if (u.endsWith('/canva')) return Response.json({ binding: { designId: 'DA_p', version: 1 } });
      if (u.endsWith('/canva/exports') && JSON.parse(String(init?.body)).format === 'png') return Response.json({ status: 'retrieved' });
      if (u.endsWith('/canva/exports')) return Response.json({ status: 'retrieved', artifact: { content_check: { copyPass: true, fontPass: true } } });
      if (u.endsWith('/canva/parity-check')) return parityReply();
      return Response.json({ tenantId: 'tenant', clientId: 'client' });
    });
    return { remote, calls, reports };
  };
  const input: WorkflowInput = { taskId: '00000000-0000-4000-c000-0000000000ff', tenantId: 'tenant', clientId: 'client', rawText: '', sourcePlatform: 'telegram', idempotencyKey: 'k', canvaAutoGenerate: true, designStudio: true };

  it('with no verdict in its answer is unavailable, not a match', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const { remote, reports } = studio(() => Response.json({ ok: true, verdict: {} }));
    await runCanvaDraft(input, restateLikeContext().ctx as any, remote as any);
    expect(reports).toEqual([expect.objectContaining({ status: 'CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', parity: 'unavailable', parityError: 'PARITY_NO_VERDICT' })]);
  });

  it('that Core answered with a 5xx is not asked again: each ask is a paid vision call', async () => {
    vi.stubEnv('HAWA_BEARER_TOKEN', 'test-only');
    const { remote, calls, reports } = studio(() => Response.json({ title: 'PARITY_MODEL_FAILED' }, { status: 500 }));
    await runCanvaDraft(input, restateLikeContext(5).ctx as any, remote as any);
    expect(calls.filter((u) => u.endsWith('/canva/parity-check'))).toHaveLength(1);
    expect(reports).toEqual([expect.objectContaining({ parity: 'unavailable', parityError: 'PARITY_MODEL_FAILED' })]);
  });
});
