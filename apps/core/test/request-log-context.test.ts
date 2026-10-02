import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { captureLogs } from '@hawa/observability';
import { createApp } from '../src/app.js';
import { log, requestLogContext, getLogContext, bindLogContext } from '../src/logging.js';

/**
 * Architecture programme 1.4: every log line Core writes names the request it belongs to, and so does
 * everything the request writes to the database, so one command can find all of it again.
 */

let capture: ReturnType<typeof captureLogs> | null = null;
afterEach(() => {
  capture?.restore();
  capture = null;
  vi.unstubAllEnvs();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 2026-10-02 review: Core wrote no error-level line in two days although routes answer 500 themselves.
describe('a failed request is an error line', () => {
  it('logs a 5xx at error level and a 4xx or 2xx at info', async () => {
    capture = captureLogs();
    const app = new Hono();
    app.use('*', requestLogContext());
    app.get('/fails', (c) => c.json({ title: 'Internal Server Error' }, 500));
    app.get('/refuses', (c) => c.json({ title: 'Not Found' }, 404));
    app.get('/works', (c) => c.json({ ok: true }));
    for (const path of ['/fails', '/refuses', '/works']) await app.request(path, { headers: { 'x-request-id': `req-level${path.replace('/', '-')}` } });
    const line = (id: string) => capture!.lines.find((l) => l.requestId === id && /^request/.test(String(l.msg)));
    expect(line('req-level-fails')).toMatchObject({ level: 'error', msg: 'request', status: 500 });
    expect(line('req-level-refuses')).toMatchObject({ level: 'info', msg: 'request', status: 404 });
    expect(line('req-level-works')).toMatchObject({ level: 'info', msg: 'request', status: 200 });
  });
});

describe('the request middleware', () => {
  const probe = () => {
    const app = new Hono();
    app.use('*', requestLogContext());
    app.get('/tasks/:id/probe', async (c) => {
      await sleep(3);
      bindLogContext({ tenantId: 'tenant-probe' });
      await Promise.all([sleep(2).then(() => log.info('after a timer')), Promise.resolve().then(() => log.warn('in a microtask'))]);
      return c.json(getLogContext() ?? null);
    });
    return app;
  };
  const taskId = '11111111-2222-4333-8444-555555555555';

  it('keeps the caller\'s id across awaits, sends it back, and puts it on every line of the request', async () => {
    capture = captureLogs();
    const res = await probe().request(`/tasks/${taskId}/probe`, { headers: { 'x-request-id': 'req-probe-1' } });
    expect(res.headers.get('x-request-id')).toBe('req-probe-1');
    expect(await res.json()).toEqual({ requestId: 'req-probe-1', taskId, tenantId: 'tenant-probe' });
    const lines = capture.lines.filter((l) => l.requestId === 'req-probe-1');
    expect(lines.map((l) => l.msg).sort()).toEqual(['after a timer', 'in a microtask', 'request']);
    for (const line of lines) expect(line).toMatchObject({ service: 'core', taskId, tenantId: 'tenant-probe' });
    expect(lines.find((l) => l.msg === 'request')).toMatchObject({ method: 'GET', status: 200, path: `/tasks/${taskId}/probe` });
  });

  it('makes a new id when none, or an unusable one, was sent, and keeps concurrent requests apart', async () => {
    capture = captureLogs();
    const app = probe();
    const [a, b, forged] = await Promise.all([
      app.request(`/tasks/${taskId}/probe`),
      app.request(`/tasks/${taskId}/probe`),
      app.request(`/tasks/${taskId}/probe`, { headers: { 'x-request-id': 'bad id with spaces' } }),
    ]);
    const ids = [a, b, forged].map((r) => r.headers.get('x-request-id'));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(capture.lines.filter((l) => l.requestId === id)).toHaveLength(3);
  });
});

describe('Core with its database', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
  afterAll(() => db.destroy());

  it('stores the request id with the task events and the outbox command it writes, and logs the tenant', async () => {
    capture = captureLogs();
    const app = createApp({ db } as any);
    const res = await app.request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${process.env.HAWA_BEARER_TOKEN}`, 'x-request-id': 'req-desk-create-1' },
      body: JSON.stringify({ title: 'Logging probe', clientId: 'c1000000-0000-4000-8000-000000000002' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-request-id')).toBe('req-desk-create-1');
    const { id } = await res.json();
    const [events, commands] = await withRlsContext(db, scope, async (trx) => [
      (await sql<{ event_type: string; trace_id: string | null }>`SELECT event_type, trace_id FROM hawa.task_events WHERE task_id = ${id}::uuid`.execute(trx)).rows,
      (await sql<{ request_id: string | null }>`SELECT payload->>'requestId' AS request_id FROM hawa.outbox_commands WHERE aggregate_id = ${id}::uuid`.execute(trx)).rows,
    ]);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.trace_id).toBe('req-desk-create-1');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command.request_id).toBe('req-desk-create-1');
    expect(capture.lines.find((l) => l.msg === 'request' && l.requestId === 'req-desk-create-1')).toMatchObject({ tenantId: scope.tenantId, status: 201 });
  });
});

// A Telegram update's lines named its chat through the webhook's own log context. The webhook was
// removed by stage 2 of ADR-135; the worker's hand-off (POST /v1/internal/telegram/intake) goes
// through the same request middleware as any other request, and no Core line binds a chat id now.
