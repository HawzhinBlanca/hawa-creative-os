import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { productionAppOptions } from '../src/entrypoint-options.js';
import { telegramPollerOf } from '../src/services/telegram-poller-owner.js';

/**
 * ADR-135: every Telegram chat is owned by RequestLifecycle, whatever the configuration says, and
 * the old intake only finishes requests it started before the switch. Against the per-file test
 * database as hawa_app, through Core's internal intake as the worker's ChatInbox calls it.
 *
 * The production behaviour this replaces (found 2026-09-28 with HAWA_LIFECYCLE_CHATS=*): a plain
 * brief in a chat with earlier Core tasks became a new Core-pinned task; a reply to an open legacy
 * draft was refused as stale; a legacy draft's button was bound to a waiting lifecycle request.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000017;
const WORKER = ['worker', 'lifecycle', 'only', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const admin = { 'Content-Type': 'application/json', Authorization: 'Bearer test_admin_key' };

const db = createDb(process.env.TEST_DATABASE_URL!);
const owner = createDb(process.env.TEST_DATABASE_OWNER_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  process.env.AUTO_GENERATE_DAILY_CAP_PER_SENDER = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
  await owner.destroy();
});

const chatId = () => 63_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
const textUpdate = (chat: number, text: string, extra: Record<string, unknown> = {}) => {
  const id = updateId();
  return { update_id: id, message: { message_id: id % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
    chat: { id: chat, type: 'private' }, date: 1790000000, text, ...extra } };
};
const BRIEF = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';

/** Telegram's sendMessage, recorded; anything else goes to the real fetch. */
function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const sent: Array<{ chat_id: string | number; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body || '{}'));
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
    }
    return Response.json({ ok: true, result: true });
  });
  return { sent };
}

const intake = async (app: any, update: unknown, mode = 'legacy') => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker,
    body: JSON.stringify({ v: 1, update, mode }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const tasksInChat = async (chat: number) => (await withRlsContext(db, scope, (trx) => sql<{
  id: string; pin: string; request_id: string | null; parent: string | null }>`SELECT t.id::text, t.delivery_executor_pin AS pin,
    t.request_id::text, o.payload->'studioOptions'->>'parentTaskId' AS parent
  FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
  WHERE t.tenant_id = ${tenantId}::uuid AND o.payload->>'sourceChannelId' = ${String(chat)}
  ORDER BY t.created_at`.execute(trx))).rows;

/** A request the old intake made before the switch: Core-pinned, no request owner. */
async function legacyTask(chat: number, opts: { state?: string; ageHours?: number } = {}) {
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `legacy-${randomUUID()}`, sourceChannelId: String(chat),
    rawText: 'KAAE spring lecture\n---\nMarch 3, 2026', title: 'KAAE spring lecture', clientId,
    designInstructions: 'Lecture announcement', exactCopy: [{ text: 'March 3, 2026' }],
    autoGenerate: false, variant: { width: 1080, height: 1350 },
  });
  const id = String(created.task.id);
  await sql`UPDATE hawa.tasks SET state = ${opts.state ?? 'human_review'}::hawa.task_state,
      created_at = now() - make_interval(hours => ${opts.ageHours ?? 1})
    WHERE id = ${id}::uuid`.execute(owner);
  return id;
}

/** A lifecycle request waiting for the requester's changes (stage manual, rev 3). */
async function waitingLifecycleRequest(chat: number) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId,
    designInstructions: 'Make the approved event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id,
      parent_request_id, owner, stage, rev, chat_id)
    VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid,
      null, 'restate', 'manual', 3, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid
      WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}

const requestRev = async (requestId: string) => Number((await withRlsContext(db, scope, (trx) =>
  sql<{ rev: string }>`SELECT rev FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(trx))).rows[0]?.rev);

describe('every Telegram chat is lifecycle-owned (ADR-135)', () => {
  it('opens a lifecycle request for a plain brief in a chat whose Core tasks are old or finished', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const app = createApp({ db } as any);
    const oldChat = chatId();
    await legacyTask(oldChat, { state: 'received', ageHours: 72 });
    const finishedChat = chatId();
    await legacyTask(finishedChat, { state: 'complete', ageHours: 2 });
    for (const chat of [oldChat, finishedChat]) {
      const before = await tasksInChat(chat);
      const opened = await intake(app, textUpdate(chat, BRIEF));
      expect(opened.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(chat) });
      // The request object creates the task; intake made none, and no Core-pinned one.
      expect(await tasksInChat(chat)).toEqual(before);
    }
  });

  it('no setting sends a new brief down the old path', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    for (const setting of ['', '12345', '*']) {
      vi.stubEnv('HAWA_LIFECYCLE_CHATS', setting);
      const chat = chatId();
      await legacyTask(chat, { state: 'complete', ageHours: 100 });
      const answer = await intake(createApp({ db } as any), textUpdate(chat, BRIEF));
      expect(answer.body, `HAWA_LIFECYCLE_CHATS=${setting}`).toMatchObject({ lifecycleAction: 'open-request' });
      expect((await tasksInChat(chat)).filter((t) => t.pin === 'core')).toHaveLength(1);
    }
  });

  it('a reply to an open legacy draft reaches that request and makes its revision, pinned as it was', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    fakeTelegram();
    const chat = chatId();
    const legacy = await legacyTask(chat, { state: 'human_review', ageHours: 3 });
    const reply = textUpdate(chat, 'Make the title bigger', {
      reply_to_message: { message_id: 4242, from: { id: 1, is_bot: true, first_name: 'Hawa' },
        chat: { id: chat, type: 'private' }, date: 1790000000,
        caption: `Draft ready\n🆔 Task ID: ${legacy}` } });
    const answer = await intake(createApp({ db } as any), reply);
    expect(answer.body.code).not.toBe('STALE_REQUEST_REPLY');
    expect(answer.body.lifecycleAction).toBeUndefined();
    expect(answer.body.intakeStatus).toBe(200);
    const tasks = await tasksInChat(chat);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toMatchObject({ parent: legacy, pin: 'core', request_id: null });
  });

  it('a reply to a finished legacy design starts nothing and asks for /new', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    fakeTelegram();
    const chat = chatId();
    const legacy = await legacyTask(chat, { state: 'complete', ageHours: 3 });
    const reply = textUpdate(chat, 'Make the title bigger', {
      reply_to_message: { message_id: 4243, from: { id: 1, is_bot: true, first_name: 'Hawa' },
        chat: { id: chat, type: 'private' }, date: 1790000000, text: `Delivered.\n🆔 Task ID: ${legacy}` } });
    const answer = await intake(createApp({ db } as any), reply);
    expect(answer.body).toMatchObject({ code: 'LEGACY_REQUEST_REFUSED', reason: 'REQUEST_CLOSED',
      lifecycleAction: 'new-brief-required', chatId: String(chat) });
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('an unlinked brief beside an open legacy request of the last 48 hours never becomes a new legacy task', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const { sent } = fakeTelegram();
    const chat = chatId();
    const legacy = await legacyTask(chat, { state: 'human_review', ageHours: 5 });
    const answer = await intake(createApp({ db } as any), textUpdate(chat, 'KAAE follow-up event\n---\nDecember 9, 2026'));
    expect(answer.body.lifecycleAction === 'open-request').toBe(false);
    // Legacy intake read it against its open design: a change to it, or a refusal asking for /new.
    for (const task of (await tasksInChat(chat)).slice(1)) expect(task).toMatchObject({ parent: legacy, pin: 'core' });
    if (answer.body.code === 'LEGACY_REQUEST_REFUSED') {
      expect(answer.body).toMatchObject({ reason: 'NEW_REQUEST', lifecycleAction: 'new-brief-required' });
      expect(await tasksInChat(chat)).toHaveLength(1);
      expect(sent).toHaveLength(0);
    }
    // /new is always a new lifecycle request.
    const explicit = await intake(createApp({ db } as any), textUpdate(chat, '/new KAAE follow-up event\n---\nDecember 9, 2026'));
    expect(explicit.body).toMatchObject({ lifecycleAction: 'open-request' });
  });

  it('a legacy draft button never becomes a directive for a waiting lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    fakeTelegram();
    const chat = chatId();
    const legacy = await legacyTask(chat, { state: 'human_review', ageHours: 3 });
    const waiting = await waitingLifecycleRequest(chat);
    const press = { update_id: updateId(), callback_query: { id: `cb-${randomUUID()}`,
      from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, data: `rq:ok:${legacy}`,
      message: { message_id: 4244, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Draft ready' } } };
    const answer = await intake(createApp({ db } as any), press, 'lifecycle');
    expect(answer.body.lifecycleAction).not.toBe('requester-revision');
    expect(answer.body.lifecycleAction).not.toBe('requester-answer');
    expect(await requestRev(waiting.requestId)).toBe(3);
    expect((await tasksInChat(chat)).filter((t) => t.parent === waiting.taskId)).toHaveLength(0);
  });

  it('the old intake starts no request when handed an update by the lifecycle, or in production', async () => {
    const { sent } = fakeTelegram();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET!;
    const post = (app: any, chat: number, headers: Record<string, string> = {}) => app.request('/api/webhooks/telegram?generate=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret, ...headers },
      body: JSON.stringify(textUpdate(chat, BRIEF)) });
    const handedOn = chatId();
    const refused = await post(createApp({ db } as any), handedOn, { 'x-hawa-intake-scope': 'finish-only' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'LEGACY_REQUEST_REFUSED', reason: 'NEW_REQUEST' });
    expect(await tasksInChat(handedOn)).toHaveLength(0);
    const instruction = await createApp({ db } as any).request('/api/webhooks/telegram?generate=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret, 'x-hawa-intake-scope': 'finish-only' },
      body: JSON.stringify(textUpdate(handedOn, 'Please change the background to navy')) });
    expect(instruction.status).toBe(409);
    expect(sent.filter((m) => String(m.chat_id) === String(handedOn))).toHaveLength(0);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TELEGRAM_INTAKE_ALLOWED_USERS', '*');
    const inProduction = chatId();
    const production = await post(createApp({ db } as any), inProduction);
    expect(production.status).toBe(409);
    expect(await tasksInChat(inProduction)).toHaveLength(0);
  });
});

describe('Core no longer polls Telegram (ADR-135)', () => {
  it('whatever HAWA_TELEGRAM_POLLER says, production Core does not poll, and the worker is named the poller', async () => {
    for (const value of [undefined, '', 'core', 'CORE', 'worker']) {
      expect(productionAppOptions({ HAWA_TELEGRAM_POLLER: value }), String(value)).not.toHaveProperty('enableTelegramPolling');
      expect(telegramPollerOf({ HAWA_TELEGRAM_POLLER: value })).toBe('worker');
    }
    vi.stubEnv('HAWA_TELEGRAM_POLLER', 'core');
    const app = createApp({ db } as any);
    const pollNow = await app.request('/v1/adapters/telegram/poll-now', { method: 'POST', headers: admin });
    // Stage 2 of ADR-135 removed both routes with Core's poller.
    expect(pollNow.status).toBe(404);
    const webhook = await app.request('/v1/adapters/telegram/webhook/register', { method: 'POST', headers: admin,
      body: JSON.stringify({ url: 'https://example.invalid/hook', secretToken: 'x'.repeat(32) }) });
    expect(webhook.status).toBe(404);
    const status = await (await app.request('/v1/adapters/telegram/status', { headers: admin })).json();
    expect(status.poller).toBe('worker');
  });
});
