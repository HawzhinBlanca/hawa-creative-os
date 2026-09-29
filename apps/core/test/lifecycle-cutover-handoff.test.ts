import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { createApp } from '../src/app.js';
import { persistChatIntake } from '../src/services/chat-intake.js';

/**
 * ADR-136 handed a button press or a reply about a request the old intake made to that intake, so
 * requests made before a chat joined the lifecycle finished where they started. Stage 2 of ADR-135
 * deleted the old intake once none of its requests was open (GET /v1/operations/legacy-path,
 * stage2Ready). These are ADR-136's cases as they are answered now: every such update is a stale reply
 * with a receipt (ChatInbox asks the requester to reply to a current notice or send /new); it changes
 * nothing, makes no task, never reaches a waiting lifecycle request; and a brief beside an old request
 * opens a lifecycle request at once (the old 48-hour window went with the old intake).
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

/**
 * A Core request of the chat, as legacy intake made it before the cutover: pinned core, no request
 * owner, waiting for review. (ADR-136 made it through intake with the chat off the lifecycle; since
 * ADR-135 no configuration does that.)
 */
async function coreRequest(chat: number): Promise<string> {
  const created = await persistChatIntake(db, {
    platform: 'telegram', sourceEventId: `legacy-${randomUUID()}`, sourceChannelId: String(chat),
    rawText: BRIEF, title: 'KAAE members evening', clientId,
    designInstructions: 'Event announcement', exactCopy: [{ text: 'December 4, 2026' }],
    autoGenerate: false, variant: { width: 1080, height: 1350 },
  });
  const [task] = await tasksInChat(chat);
  expect(task).toMatchObject({ id: String(created.task.id), pin: 'core' });
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

describe('a chat with requests the old intake made, after stage 2 of ADR-135 (was ADR-136)', () => {
  const stale = { intakeStatus: 409, code: 'STALE_REQUEST_REPLY', lifecycleAction: 'request-choice-required' };

  it('a Telegram reply to an old-intake draft is a stale reply with a receipt, and makes nothing', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    const { sent } = fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    const reply = message(updateId(), chat, 'Please change the venue to Rotana Hotel, Erbil');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 4242, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000,
      text: 'Your draft is ready', reply_markup: { inline_keyboard: [[{ text: 'Approve design', callback_data: `rq:ok:${task}` }]] } };
    const result = await intake(createApp({ db } as any), reply);
    expect(result.body).toMatchObject({ ...stale, chatId: String(chat) });
    expect(await routingReceipt(reply.update_id)).toHaveLength(1);
    expect((await intake(createApp({ db } as any), reply)).body).toMatchObject(stale);
    expect(await tasksInChat(chat)).toEqual([expect.objectContaining({ id: task, pin: 'core' })]);
    expect(sent).toHaveLength(0);
  });

  it('a reply to a delivered old-intake file is a stale reply, and the chat\'s waiting lifecycle request keeps its revision', async () => {
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
    const reply = message(updateId(), chat, 'Please use a darker blue');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 5151, from: BOT, chat: { id: chat, type: 'private' },
      date: 1790000000, document: { file_id: 'sent-file', file_name: 'design.png' } };
    const result = await intake(createApp({ db } as any), reply, 'lifecycle');
    expect(result.body).toMatchObject(stale);
    expect(await requestRev(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect((await tasksInChat(chat)).map((t) => t.id).sort()).toEqual([task, waiting.taskId].sort());
  });

  it('never reads an old-intake button press as a revision directive for a waiting lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    const waiting = await waitingRequest(chat);
    const press = { update_id: updateId(), callback_query: { id: `cb-${randomUUID()}`, from: { id: OFFICE, is_bot: false, first_name: 'Owner' },
      message: { message_id: 4343, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Your draft is ready',
        reply_markup: { inline_keyboard: [[{ text: 'Approve design', callback_data: `rq:ok:${task}` }]] } },
      chat_instance: 'handoff', data: `rq:ok:${task}` } };
    const result = await intake(createApp({ db } as any), press, 'lifecycle');
    expect(result.body).toMatchObject(stale);
    expect(await requestRev(waiting.requestId)).toMatchObject({ rev: '3', stage: 'manual' });
    expect((await tasksInChat(chat)).filter((t) => t.parent === waiting.taskId || t.parent === task)).toEqual([]);
  });

  it('still refuses a reply to an unknown message once the chat has a lifecycle request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    await coreRequest(chat);
    await waitingRequest(chat);
    const reply = message(updateId(), chat, 'Make it blue');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 777001, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000, text: 'Something' };
    const result = await intake(createApp({ db } as any), reply, 'lifecycle');
    expect(result.body).toMatchObject({ intakeStatus: 409, code: 'STALE_REQUEST_REPLY' });
  });

  it('a reply in a chat with only old-intake history (an answer to its clarification question) is a stale reply', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    const reply = message(updateId(), chat, 'revise');
    (reply.message as Record<string, unknown>).reply_to_message = { message_id: 777002, from: BOT, chat: { id: chat, type: 'private' }, date: 1790000000,
      text: 'Clarification needed: is this a change to the design?' };
    const result = await intake(createApp({ db } as any), reply);
    expect(result.body).toMatchObject(stale);
    expect(await routingReceipt(reply.update_id)).toHaveLength(1);
    expect(await tasksInChat(chat)).toEqual([expect.objectContaining({ id: task })]);
  });

  it('opens a lifecycle request for an ordinary brief beside a recent open old-intake request', async () => {
    vi.stubEnv('HAWA_WORKER_TOKEN', WORKER);
    fakeTelegram();
    const chat = chatId();
    const task = await coreRequest(chat);
    const opened = await intake(createApp({ db } as any), message(updateId(), chat, 'KAAE follow-up event\n---\nDecember 9, 2026'));
    expect(opened.body).toMatchObject({ intakeStatus: 200, lifecycleAction: 'open-request', chatId: String(chat) });
    // The request object creates the lifecycle task; intake itself made none, and nothing joined the old one.
    expect(await tasksInChat(chat)).toEqual([expect.objectContaining({ id: task, parent: null })]);
  });
});

// ADR-136's "Core's own poller after a rollback" cases went with Core's poller (ADR-135): Core never
// polls, whatever HAWA_TELEGRAM_POLLER says (lifecycle-only-telegram.test.ts, "Core no longer polls").
