import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createDb, withRlsContext, OutboxRepository } from '@hawa/db';

// A dead letter degrades the worker until someone acts on it, and redrive re-runs the request. The
// one left from 2026-09-17 (Restate had lost the worker) was an old design request: retiring keeps
// it, as 'dead', and says who retired it and why.
describe('retiring an obsolete dead letter', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const app = createApp({ testAuth: { roleHeader: true },  db });
  const tenantId = '00000000-0000-4000-a000-000000000001';
  const operatorUserId = '00000000-0000-4000-b000-000000000001';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}` };
  const outbox = new OutboxRepository(db);

  async function taskWithCommand(state: 'failed' | 'pending') {
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `retire-${crypto.randomUUID()}` },
      body: JSON.stringify({ title: 'Dead letter task', priority: 3 }),
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    const cmd = await withRlsContext(db, { tenantId, userId: operatorUserId, role: 'operator' }, async (trx) => {
      const row = await outbox.enqueue(
        { tenantId, aggregateType: 'task', aggregateId: task.id, commandType: 'task.created', idempotencyKey: `retire-${crypto.randomUUID()}`, payload: {} },
        trx
      );
      return state === 'failed' ? outbox.markFailed(row.id, "service 'TaskWorkflow' not found", trx) : row;
    });
    return { task, cmd };
  }

  it('lists it, refuses without a reason or an operator, then retires it once', async () => {
    const { task, cmd } = await taskWithCommand('failed');
    const listed = await (await app.request('/v1/outbox/failed', { headers })).json();
    expect(listed.commands.map((c: any) => c.id)).toContain(cmd.id);

    const url = `/v1/tasks/${task.id}/outbox/${cmd.id}/retire`;
    expect((await app.request(url, { method: 'POST', headers, body: JSON.stringify({}) })).status).toBe(422);
    const viewer = await app.request(url, { method: 'POST', headers: { ...headers, 'x-user-role': 'viewer' }, body: JSON.stringify({ reason: 'x' }) });
    expect(viewer.status).toBe(403);
    expect((await app.request(`/v1/tasks/${crypto.randomUUID()}/outbox/${cmd.id}/retire`, { method: 'POST', headers, body: JSON.stringify({ reason: 'x' }) })).status).toBe(404);

    const retired = await app.request(url, { method: 'POST', headers, body: JSON.stringify({ reason: 'Superseded: request handled after Restate re-registration' }) });
    expect(retired.status).toBe(200);
    const body = await retired.json();
    expect(body.state).toBe('dead');
    expect(body.lastError).toMatch(/^RETIRED by .+: Superseded: request handled after Restate re-registration \| was: service 'TaskWorkflow' not found$/);

    const after = await (await app.request('/v1/outbox/failed', { headers })).json();
    expect(after.commands.map((c: any) => c.id)).not.toContain(cmd.id);
    expect((await app.request(url, { method: 'POST', headers, body: JSON.stringify({ reason: 'again' }) })).status).toBe(409);
  });

  it('never retires a command that can still be delivered', async () => {
    const { task, cmd } = await taskWithCommand('pending');
    const res = await app.request(`/v1/tasks/${task.id}/outbox/${cmd.id}/retire`, { method: 'POST', headers, body: JSON.stringify({ reason: 'x' }) });
    expect(res.status).toBe(409);
  });
});
