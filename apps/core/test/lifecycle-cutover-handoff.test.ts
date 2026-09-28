import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * ADR-136: requests made before a chat joined the lifecycle finish where they started. On 2026-09-28
 * production put every chat on the lifecycle (HAWA_LIFECYCLE_CHATS=*) while requesters still had Core
 * drafts, prompts and delivered files in front of them. The worker's ChatInbox hands every update to
 * POST /v1/internal/telegram/intake, which must give a button press or a reply about a Core-owned
 * design to legacy intake (ADR-052, ADR-059), and let an ordinary brief open a lifecycle request once
 * the chat's Core history is older than legacy intake's own 48-hour reading window.
 * Against the per-file test database as hawa_app (row-level security as in production).
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const clientId = 'c1000000-0000-4000-8000-000000000002';
const operatorUserId = '00000000-0000-4000-b000-000000000001';
const scope = { tenantId, userId: operatorUserId, role: 'operator' as const };
const OFFICE = 91000007;
const WORKER = ['worker', 'handoff', 'fixture', 'token'].join('_');
const worker = { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER}` };
const BOT = { id: 7000001, is_bot: true, first_name: 'Hawa' };

const db = createDb(process.env.TEST_DATABASE_URL!);
const saved = { ...process.env };
beforeAll(() => {
  process.env.TELEGRAM_ALLOWED_USERS = String(OFFICE);
  process.env.AUTO_GENERATE_DAILY_CAP_GLOBAL = '1000000';
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  process.env = saved;
  await db.destroy();
});

const chatId = () => 63_000_000 + Math.floor(Math.random() * 9_000_000);
const updateId = () => 1_100_000_000 + Math.floor(Math.random() * 800_000_000);
const message = (id: number, chat: number, text: string) => ({
  update_id: id,
  message: { message_id: id % 100000, from: { id: OFFICE, is_bot: false, first_name: 'Owner' }, chat: { id: chat, type: 'private' }, date: 1790000000, text },
});
const BRIEF = 'KAAE members evening\n---\nDecember 4, 2026\nErbil';

function fakeTelegram() {
  const realFetch = globalThis.fetch;
  const sent: Array<{ chat_id: string | number; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
    if (/\/send(Message|Photo|Document)/.test(url)) {
      const body = JSON.parse(String(init?.body || '{}'));
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: 1 + sent.length, chat: { id: body.chat_id } } });
    }
    return Response.json({ ok: true, result: true });
  });
  return { sent };
}

const intake = async (app: any, update: unknown, mode: 'legacy' | 'lifecycle' = 'legacy') => {
  const res = await app.request('/v1/internal/telegram/intake', { method: 'POST', headers: worker, body: JSON.stringify({ v: 1, update, mode }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const tasksInChat = async (chat: number) =>
  (await withRlsContext(db, scope, (trx) => sql<{ id: string; pin: string; parent: string | null }>`SELECT t.id::text, t.delivery_executor_pin AS pin,
      o.payload->'studioOptions'->>'parentTaskId' AS parent
    FROM hawa.tasks t JOIN hawa.outbox_commands o ON o.aggregate_id = t.id AND o.command_type = 'task.created'
    WHERE o.payload->>'sourceChannelId' = ${String(chat)} ORDER BY t.created_at`.execute(trx))).rows;

const routingReceipt = async (id: number) => (await withRlsContext(db, scope, (trx) => sql<{ event_kind: string }>`
  SELECT event_kind FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid
    AND source_account_id = 'lifecycle_chat_routing' AND source_event_id = ${String(id)}`.execute(trx))).rows;

/** A Core request of the chat, made while the chat was not on the lifecycle (legacy intake). */
async function coreRequest(chat: number): Promise<string> {
  vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
  const made = await intake(createApp({ db } as any), message(updateId(), chat, BRIEF));
  expect(made.body.taskIds).toHaveLength(1);
  const [task] = await tasksInChat(chat);
  expect(task.pin).toBe('core');
  return task.id;
}

/** A lifecycle request of the chat waiting for the requester's revision (rev 3, stage manual). */
async function waitingRequest(chat: number) {
  const requestId = randomUUID();
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `lc-seed-${requestId}`, sourceChannelId: String(chat),
    rawText: 'KAAE members evening', title: 'KAAE members evening', clientId,
    designInstructions: 'Make the approved event design', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: true, designStudio: true, variant: { width: 1200, height: 1697 }, studioOptions: { tier: 'quality' },
  }, { outboxState: 'recorded' });
  const taskId = String(created.task.id);
  await withRlsContext(db, scope, async (trx) => {
    await sql`INSERT INTO hawa.requests (request_id, tenant_id, root_task_id, current_task_id, parent_request_id, owner, stage, rev, chat_id)
      VALUES (${requestId}::uuid, ${tenantId}::uuid, ${taskId}::uuid, ${taskId}::uuid, null, 'restate', 'manual', 3, ${String(chat)})`.execute(trx);
    await sql`UPDATE hawa.tasks SET request_id = ${requestId}::uuid WHERE tenant_id = ${tenantId}::uuid AND id = ${taskId}::uuid`.execute(trx);
  });
  return { requestId, taskId };
}

const requestRev = async (requestId: string) => (await withRlsContext(db, scope, (trx) => sql<{ rev: string; stage: string }>`
  SELECT rev, stage FROM hawa.requests WHERE request_id = ${requestId}::uuid`.execute(trx))).rows[0];

describe('a chat that joined the lifecycle with Core requests in flight (ADR-136)', () => {
  it('gives a Telegram reply to a Core draft to legacy intake instead of refusing it as a stale lifecycle reply', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const reply = message(updateId(), chat, 'Please change the venue to Rotana Hotel, Erbil');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 4242, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000,
      text: 'Your draft is ready', reply_markup: { inline_keyboard: [[{ text: 'Approve design', callback_data: `rq:ok:${task}` }]] } };
    const result = await intake(createApp({ db } as any), reply);
    expect(result.body.code).not.toBe('STALE_REQUEST_REPLY');
    expect(result.body.lifecycleAction).toBeUndefined();
    expect(result.body.intakeStatus).toBeLessThan(500);
    expect(await routingReceipt(reply.update_id)).toEqual([]);
    // The same reply after the chat left the lifecycle again is still legacy intake's (no receipt to replay).
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    expect((await intake(createApp({ db } as any), reply)).body.lifecycleAction).toBeUndefined();
  });

  it('gives a reply to a delivered Core file to legacy intake even when the chat also has a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    const waiting = await waitingRequest(chat);
    // The outbox's send mark of the delivered file: `<command id>:<step>`, with the Telegram message ID.
    await withRlsContext(db, scope, async (trx) => {
      const [cmd] = (await sql<{ id: string }>`SELECT id::text FROM hawa.outbox_commands WHERE aggregate_id = ${task}::uuid AND command_type = 'task.created'`.execute(trx)).rows;
      await sql`INSERT INTO hawa.inbox_events (tenant_id, source_account_id, source_event_id, event_kind, payload, payload_hash, verified)
        VALUES (${tenantId}::uuid, 'telegram_delivery', ${`${cmd.id}:document-1`}, 'telegram_document_sent',
          ${JSON.stringify({ commandId: cmd.id, step: 'document-1', outcome: 'sent', messageId: '5151' })}::jsonb, ${`test-${cmd.id}`}, true)`.execute(trx);
    });
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const reply = message(updateId(), chat, 'Please use a darker blue');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 5151, from: BOT, chat: { id: chat, type: 'private' },
      date: 1790000000, document: { file_id: 'sent-file', file_name: 'design.png' } };
    const result = await intake(createApp({ db } as any), reply, 'lifecycle');
    expect(result.body.code).not.toBe('STALE_REQUEST_REPLY');
    expect(result.body.lifecycleAction).toBeUndefined();
    expect(await requestRev(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect(await routingReceipt(reply.update_id)).toEqual([]);
  });

  it('never reads a Core button press as a revision directive for a waiting lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    const waiting = await waitingRequest(chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const press = { update_id: updateId(), callback_query: { id: `cb-${randomUUID()}`, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
      message: { message_id: 4343, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Your draft is ready',
        reply_markup: { inline_keyboard: [[{ text: 'Approve design', callback_data: `rq:ok:${task}` }]] } },
      chat_instance: 'handoff', data: `rq:ok:${task}` } };
    const result = await intake(createApp({ db } as any), press, 'lifecycle');
    expect(result.body.lifecycleAction).toBeUndefined();
    expect(await requestRev(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect((await tasksInChat(chat)).filter((t) => t.parent === waiting.taskId)).toEqual([]);
  });

  it('still refuses a reply to an unknown message once the chat has a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    await coreRequest(chat);
    await waitingRequest(chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const reply = message(updateId(), chat, 'Make it blue');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 777001, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Something' };
    const result = await intake(createApp({ db } as any), reply, 'lifecycle');
    expect(result.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY' });
  });

  it('gives any reply in a chat with only Core history to legacy intake (an answer to its clarification question)', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    await coreRequest(chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const reply = message(updateId(), chat, 'revise');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 777002, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000,
      text: 'Clarification needed: is this a change to the design?' };
    const result = await intake(createApp({ db } as any), reply);
    expect(result.body.code).not.toBe('STALE_REQUEST_REPLY');
    expect(result.body.lifecycleAction).toBeUndefined();
    expect(await routingReceipt(reply.update_id)).toEqual([]);
  });

  it('opens a lifecycle request for an ordinary brief once the chat\'s Core history is older than 48 hours', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '*');
    const recent = await intake(createApp({ db } as any), message(updateId(), chat, 'KAAE follow-up event\n---\nDecember 9, 2026'));
    expect(recent.body.lifecycleAction).toBeUndefined();
    expect(recent.body.taskIds).toHaveLength(1);
    await withRlsContext(db, scope, (trx) => sql`UPDATE hawa.tasks SET created_at = now() - interval '49 hours'
      WHERE id IN (SELECT aggregate_id FROM hawa.outbox_commands WHERE command_type = 'task.created' AND payload->>'sourceChannelId' = ${String(chat)})`.execute(trx));
    const later = await intake(createApp({ db } as any), message(updateId(), chat, 'KAAE graduation ceremony\n---\nDecember 20, 2026\nErbil'));
    expect(later.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request' });
    expect((await tasksInChat(chat)).map((t) => t.id)).toContain(task);
    expect(await tasksInChat(chat)).toHaveLength(2);
  });
});

describe('Core\'s own poller after a rollback of HAWA_TELEGRAM_POLLER (ADR-136)', () => {
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
  const pollerHandler = () => {
    const fake = bridge();
    createApp({ db, telegramBridge: fake as any } as any);
    expect(fake.useUpdateHandler).toHaveBeenCalledTimes(1);
    return fake.useUpdateHandler.mock.calls[0][0] as (update: unknown) => Promise<void>;
  };
  /** Restate's ingress, recorded; anything else goes to the real fetch. */
  function fakeIngress(status = 202) {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; key: string | null; body: any }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('http://restate-ingress.test:8080/')) return realFetch(input, init);
      calls.push({ url, key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ invocationId: 'inv_test', status: 'Accepted' }), { status });
    });
    return calls;
  }

  it('hands an update of a chat with a lifecycle request to its ChatInbox under the worker poller\'s key, not to legacy intake', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['424243', 'handoff_poller_fixture'].join(':'));
    vi.stubEnv('RESTATE_INGRESS_URL', 'http://restate-ingress.test:8080');
    vi.stubEnv('HAWA_LIFECYCLE_CHATS', '');
    const calls = fakeIngress();
    const chat = chatId();
    const waiting = await waitingRequest(chat);
    const handle = pollerHandler();
    const reply = message(updateId(), chat, 'The venue is Rotana Hotel, Erbil');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 9090, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'What should change?' };
    await handle(reply);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `http://restate-ingress.test:8080/ChatInbox/${chat}/handleUpdate/send`, key: `tg-${reply.update_id}`,
      body: { v: 1, update: reply } });
    // Legacy intake never saw it: no revision of the request's task outside its request.
    expect((await tasksInChat(chat)).map((t) => t.id)).toEqual([waiting.taskId]);
    expect(await requestRev(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
  });

  it('keeps legacy intake for a chat without a lifecycle request', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['424243', 'handoff_poller_fixture'].join(':'));
    vi.stubEnv('RESTATE_INGRESS_URL', 'http://restate-ingress.test:8080');
    const calls = fakeIngress();
    const chat = chatId();
    const handle = pollerHandler();
    await handle(message(updateId(), chat, BRIEF));
    expect(calls).toHaveLength(0);
    expect(await tasksInChat(chat)).toHaveLength(1);
  });

  it('asks again, and never gives the update to legacy intake, while Restate does not take it', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ['424243', 'handoff_poller_fixture'].join(':'));
    vi.stubEnv('RESTATE_INGRESS_URL', 'http://restate-ingress.test:8080');
    const calls = fakeIngress(503);
    const chat = chatId();
    const waiting = await waitingRequest(chat);
    const handle = pollerHandler();
    await expect(handle(message(updateId(), chat, 'Use a darker blue'))).rejects.toThrow(/attempt 1\/5 failed \(intake answered HTTP 503\)/);
    expect(calls).toHaveLength(1);
    expect((await tasksInChat(chat)).map((t) => t.id)).toEqual([waiting.taskId]);
  });
});
