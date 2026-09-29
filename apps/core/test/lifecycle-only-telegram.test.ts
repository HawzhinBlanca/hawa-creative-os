import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';
import { productionAppOptions } from '../src/entrypoint-options.js';
import { telegramPollerOf } from '../src/services/telegram-poller-owner.js';

/**
 * ADR-135: every Telegram chat is owned by RequestLifecycle, whatever the configuration says. Since
 * stage 2 the old intake is gone: a reply or a button under one of its messages is a stale reply, and
 * a brief beside one of its requests opens a lifecycle request. Against the per-file test database as
 * hawa_app, through Core's internal intake as the worker's ChatInbox calls it.
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

  // Stage 2 of ADR-135: the old intake is gone, so a reply to one of its drafts, open or finished, is
  // a stale reply that asked the requester to reply to a current notice or send /new. Since ADR-144 the
  // words are passed to the office (and the requester is told so, in plain words); it still changes
  // nothing and makes no task, and the decision replays.
  it.each(['human_review', 'complete'] as const)('a reply to an old-intake draft (%s) is passed to the office and makes nothing', async (state) => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const { sent } = fakeTelegram();
    const chat = chatId();
    const legacy = await legacyTask(chat, { state, ageHours: 3 });
    const reply = textUpdate(chat, 'Make the title bigger', {
      reply_to_message: { message_id: 4242, from: { id: 1, is_bot: true, first_name: 'Hawa' },
        chat: { id: chat, type: 'private' }, date: 1790000000,
        caption: `Draft ready\n🆔 Task ID: ${legacy}` } });
    const app = createApp({ db } as any);
    const answer = await intake(app, reply);
    expect(answer.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'chat-answer', chatId: String(chat),
      chatAnswer: { text: expect.stringContaining("I've passed your message to the office") },
      officeAlert: { text: expect.stringContaining('Make the title bigger') } });
    expect(await tasksInChat(chat)).toEqual([expect.objectContaining({ id: legacy, pin: 'core', request_id: null })]);
    // The same update again gives the same answer (a receipt), and Core itself sent nothing.
    expect((await intake(createApp({ db } as any), reply)).body).toMatchObject({ duplicate: true,
      lifecycleAction: 'chat-answer', chatAnswer: answer.body.chatAnswer });
    expect(sent).toHaveLength(0);
  });

  it('an unlinked brief beside an open old-intake request opens a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const { sent } = fakeTelegram();
    const chat = chatId();
    const legacy = await legacyTask(chat, { state: 'human_review', ageHours: 5 });
    const answer = await intake(createApp({ db } as any), textUpdate(chat, 'KAAE follow-up event\n---\nDecember 9, 2026'));
    expect(answer.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(chat) });
    // Intake made no task (the request object makes it), and nothing joined the old request.
    expect(await tasksInChat(chat)).toEqual([expect.objectContaining({ id: legacy, pin: 'core', parent: null })]);
    expect(sent).toHaveLength(0);
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
    const bridge = { downloadFile: vi.fn(), dispatchOutboundMessage: vi.fn(async () => ({ success: true })),
      answerCallbackQuery: vi.fn(async () => true) };
    const answer = await intake(createApp({ db, telegramBridge: bridge } as any), press, 'lifecycle');
    // Stage 2 of ADR-135: every button is under an old-intake message, and a press is a stale reply.
    expect(answer.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY',
      lifecycleAction: 'request-choice-required', chatId: String(chat) });
    expect(await requestRev(waiting.requestId)).toBe(3);
    expect((await tasksInChat(chat)).filter((t) => t.parent === waiting.taskId || t.parent === legacy)).toHaveLength(0);
    // The spinner is stopped once; the same press again replays its receipt and asks Telegram nothing.
    expect(bridge.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect((await intake(createApp({ db, telegramBridge: bridge } as any), press, 'lifecycle')).body).toMatchObject({ code: 'STALE_REQUEST_REPLY' });
    expect(bridge.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(bridge.dispatchOutboundMessage).not.toHaveBeenCalled();
  });

  it('the old intake is gone: its route answers 404 under every prefix, in production too', async () => {
    const { sent } = fakeTelegram();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET!;
    for (const production of [false, true]) {
      if (production) { vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('TELEGRAM_INTAKE_ALLOWED_USERS', '*'); }
      const app = createApp({ db } as any);
      const chat = chatId();
      for (const path of ['/webhooks/telegram', '/api/webhooks/telegram?generate=true', '/v1/webhooks/telegram', '/api/v1/webhooks/telegram']) {
        const res = await app.request(path, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
          body: JSON.stringify(textUpdate(chat, BRIEF)) });
        expect(res.status, `${path} production=${production}`).toBe(404);
      }
      expect(await tasksInChat(chat)).toHaveLength(0);
    }
    expect(sent).toHaveLength(0);
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
