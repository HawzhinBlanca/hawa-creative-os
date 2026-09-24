import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

const repairUrl = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!repairUrl)('a Telegram update', () => {
  const db = createDb(repairUrl || 'postgres://localhost/hawa_repair');
  const scope = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001', role: 'operator' };
  const secret = ['log', 'context', 'fixture'].join('_');
  const OFFICE = 91000078;
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
    process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
    delete process.env.OPENAI_API_KEY;
  });
  afterAll(async () => {
    process.env = saved;
    await db.destroy();
  });

  const bridge = () => ({
    dispatchOutboundMessage: vi.fn().mockResolvedValue({ success: true }),
    dispatchOutboundPhoto: vi.fn().mockResolvedValue({ success: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    handleCommand: vi.fn().mockReturnValue(null),
    formatTaskPreviewCard: vi.fn().mockReturnValue({}),
    attachOffsetStorage: vi.fn(),
    startPolling: vi.fn(),
    useUpdateHandler: vi.fn(),
  });
  const message = (chat: number, text: string) => ({
    message_id: Math.floor(Math.random() * 1e6),
    from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
    chat: { id: chat, type: 'private' },
    text,
  });
  const traceIdsOf = (chat: number) =>
    withRlsContext(db, scope, async (trx) =>
      (await sql<{ trace_id: string | null; request_id: string | null }>`
        SELECT e.trace_id, o.payload->>'requestId' AS request_id
        FROM hawa.outbox_commands o JOIN hawa.task_events e ON e.task_id = o.aggregate_id AND e.event_type = 'task.created'
        WHERE o.command_type = 'task.created' AND o.payload->>'sourceChannelId' = ${String(chat)}`.execute(trx)).rows);

  it('from the webhook: every line of it names its chat', async () => {
    capture = captureLogs();
    const chat = 65000000 + Math.floor(Math.random() * 9000000);
    const app = createApp({ db, telegramBridge: bridge() as any } as any);
    const res = await app.request('/api/webhooks/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret, 'x-request-id': 'req-webhook-1' },
      body: JSON.stringify({ update_id: randomUUID(), message: message(chat, 'KAAE members evening\n---\nDecember 4, 2026\nErbil') }),
    });
    expect(res.status).toBeLessThan(300);
    expect(capture.lines.find((l) => l.msg === 'request' && l.requestId === 'req-webhook-1')).toMatchObject({ chatId: String(chat) });
    expect(await traceIdsOf(chat)).toEqual([{ trace_id: 'req-webhook-1', request_id: 'req-webhook-1' }]);
  });

  it('from the poller: handled under tg-<update_id>, which the task it creates records', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['424242', 'log_context_fixture_token'].join(':'));
    capture = captureLogs();
    const chat = 66000000 + Math.floor(Math.random() * 9000000);
    const fake = bridge();
    createApp({ db, telegramBridge: fake as any } as any);
    expect(fake.useUpdateHandler).toHaveBeenCalledTimes(1);
    const handle = fake.useUpdateHandler.mock.calls[0][0] as (update: unknown) => Promise<void>;
    const updateId = 700000000 + Math.floor(Math.random() * 99999999);
    await handle({ update_id: updateId, message: message(chat, 'KAAE study day\n---\nApril 8, 2027\nErbil') });
    expect(await traceIdsOf(chat)).toEqual([{ trace_id: `tg-${updateId}`, request_id: `tg-${updateId}` }]);
    const lines = capture.lines.filter((l) => l.requestId === `tg-${updateId}`);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.chatId).toBe(String(chat));
  });
});
