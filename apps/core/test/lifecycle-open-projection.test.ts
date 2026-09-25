import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { openManualRequest, type ManualLifecycleState, type OpenManualEvent } from '../../worker/src/lifecycle/request-lifecycle.js';
import type { OutboundMessage } from '@hawa/contracts';

/** The first request projection must be atomic across task, outbox ownership and replay receipt. */
const db = createDb(process.env.TEST_DATABASE_URL!);
const tenantId = '00000000-0000-4000-a000-000000000001';
const scope = { tenantId, userId: '00000000-0000-4000-b000-000000000001', role: 'operator' as const };
const token = ['worker', 'lifecycle', 'projection', 'fixture'].join('_');
const saved = process.env.HAWA_WORKER_TOKEN;
beforeAll(() => { process.env.HAWA_WORKER_TOKEN = token; });
afterAll(async () => {
  if (saved === undefined) delete process.env.HAWA_WORKER_TOKEN;
  else process.env.HAWA_WORKER_TOKEN = saved;
  await db.destroy();
});

function projection(requestId = randomUUID(), chat = String(70_000_000 + Math.floor(Math.random() * 9_000_000))) {
  return {
    requestId,
    body: {
      v: 1, expectedRev: 0, rev: 1, key: `${requestId}:1:open`,
      ops: [{ kind: 'createRequest', draft: {
        platform: 'telegram', sourceEventId: `lc-${requestId}-r0`, sourceChannelId: chat,
        rawText: 'An autumn workshop poster with date and venue', title: 'Autumn workshop poster',
        designInstructions: 'Use the supplied text', exactCopy: ['Autumn workshop'],
        clientId: null, autoGenerate: false,
      } }],
    },
  };
}

async function send(requestId: string, body: unknown, bearer = token) {
  const response = await createApp({ db } as any).request(`/v1/internal/lifecycle/${requestId}/project`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('first RequestLifecycle projection', () => {
  it('atomically pins a task to Restate and returns the same receipt after a lost response and Core restart', async () => {
    const { requestId, body } = projection();
    const first = await send(requestId, body);
    expect(first).toMatchObject({ status: 200, body: { v: 1, requestId, rev: 1, stage: 'manual', autoGenerate: false } });
    const taskId = first.body.taskId as string;
    const replay = await send(requestId, body); // new Core instance, same database
    expect(replay).toEqual(first);

    const rows = await withRlsContext(db, scope, async (trx) => ({
      task: await trx.selectFrom('tasks').select(['id', 'request_id']).where('id', '=', taskId).executeTakeFirst(),
      request: await trx.selectFrom('requests').select(['owner', 'root_task_id', 'rev']).where('request_id', '=', requestId).executeTakeFirst(),
      outbox: await trx.selectFrom('outbox_commands').select(['state', 'last_error', 'payload']).where('aggregate_id', '=', taskId).where('command_type', '=', 'task.created').executeTakeFirst(),
      receipts: await trx.selectFrom('lifecycle_projections').select(['rev', 'idempotency_key']).where('request_id', '=', requestId).execute(),
    }));
    expect(rows.task).toMatchObject({ id: taskId, request_id: requestId });
    expect(rows.request).toMatchObject({ owner: 'restate', root_task_id: taskId, rev: '1' });
    expect(rows.outbox).toMatchObject({ state: 'delivered', last_error: 'OWNED_BY_LIFECYCLE', payload: { lifecycleOwner: 'restate' } });
    expect(rows.receipts).toHaveLength(1);
  });

  it('serializes concurrent retries and refuses a changed body under the same key', async () => {
    const { requestId, body } = projection();
    const [a, b] = await Promise.all([send(requestId, body), send(requestId, body)]);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    const changed = structuredClone(body);
    changed.ops[0].draft.rawText += ' changed';
    const collision = await send(requestId, changed);
    expect(collision).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    const count = await withRlsContext(db, scope, (trx) => trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute());
    expect(count).toHaveLength(1);
  });

  it('does not let a second request claim the same source event or permit malformed and unauthorized opens', async () => {
    const { requestId, body } = projection();
    expect((await send(requestId, body, 'not-worker')).status).toBe(401);
    expect((await send(requestId, { ...body, rev: 2 })).status).toBe(400);
    expect((await send(requestId, { ...body, ops: [{ kind: 'createRequest', draft: { ...body.ops[0].draft, sourceEventId: 'wrong' } }] })).status).toBe(400);
    expect((await send(requestId, body)).status).toBe(200);
    const second = projection(randomUUID(), body.ops[0].draft.sourceChannelId);
    second.body.ops[0].draft.sourceEventId = body.ops[0].draft.sourceEventId;
    // A forged reuse of the first update is invalid even before it reaches the database.
    expect((await send(second.requestId, second.body)).status).toBe(400);
  });

  it('refuses to adopt an event that the legacy executor already owns', async () => {
    const { requestId, body } = projection();
    const draft = body.ops[0].draft;
    const legacy = await persistChatIntake(db, draft);
    const attempted = await send(requestId, body);
    expect(attempted).toMatchObject({ status: 409, body: { code: 'TASK_ALREADY_OWNED' } });
    const rows = await withRlsContext(db, scope, async (trx) => ({
      task: await trx.selectFrom('tasks').select('request_id').where('id', '=', legacy.task.id).executeTakeFirst(),
      command: await trx.selectFrom('outbox_commands').select('state').where('aggregate_id', '=', legacy.task.id).executeTakeFirst(),
      request: await trx.selectFrom('requests').select('request_id').where('request_id', '=', requestId).executeTakeFirst(),
    }));
    expect(rows.task?.request_id).toBeNull();
    expect(rows.command?.state).toBe('pending');
    expect(rows.request).toBeUndefined();
  });

  it('worker open survives a lost Core response and sends one fenced acknowledgement', async () => {
    const { requestId, body } = projection();
    const draft = body.ops[0].draft;
    const event: OpenManualEvent = {
      v: 1, eventId: `open:${requestId}`, requestId, tenantId, chatId: draft.sourceChannelId,
      draft: { ...draft, platform: 'telegram', clientId: null, autoGenerate: false },
    };
    let state: ManualLifecycleState | null = null;
    const sent: OutboundMessage[] = [];
    const ctx = {
      key: requestId,
      get: async () => state,
      run: async <T>(_name: string, action: () => Promise<T>) => action(),
      set: (_name: string, value: ManualLifecycleState) => { state = value; },
      send: (message: OutboundMessage) => { sent.push(message); },
    };
    let loseFirstResponse = true;
    const core = { post: async <T>(path: string, payload: unknown): Promise<T> => {
      const response = await createApp({ db } as any).request(`/v1${path}`, {
        method: 'POST', headers: workerHeaders(), body: JSON.stringify(payload),
      });
      const answer = await response.json() as T;
      if (loseFirstResponse) { loseFirstResponse = false; throw new Error('Core committed but the HTTP response was lost'); }
      if (!response.ok) throw new Error(`Core refused HTTP ${response.status}`);
      return answer;
    } };
    await expect(openManualRequest(ctx, core, event)).rejects.toThrow('response was lost');
    expect(state).toBeNull();
    const result = await openManualRequest(ctx, core, event);
    expect(result).toMatchObject({ accepted: true, stage: 'manual' });
    expect(sent).toEqual([expect.objectContaining({ key: `${requestId}:1:ack`, taskId: result.taskId, class: 'critical' })]);
    const receipts = await withRlsContext(db, scope, (trx) => trx.selectFrom('lifecycle_projections').select('rev').where('request_id', '=', requestId).execute());
    expect(receipts).toHaveLength(1);
  });
});

function workerHeaders() {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
