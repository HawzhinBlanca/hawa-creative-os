import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import {
  CANARY_CHAT_ID_MAX, CANARY_CHAT_ID_MIN, SYSTEM_AUTOMATION_USER_ID, canaryChatIdFromEnv, canaryChatProblem, isCanaryChat, isReservedCanaryChatId,
  type OutboundMessage,
} from '@hawa/contracts';
import { canarySinkFor, handleSend, markIdOf, SEND_STEP, sendAttempt, type SenderContext, type TelegramSenderDeps } from '../src/lifecycle/telegram-sender.js';
import { canarySinkMessageId, isCanaryTask, readSendMark, type TelegramSender as BridgeLike } from '../src/delivery-notification.js';
import { officeAlertRoute } from '../src/lifecycle/office-chats.js';

/**
 * ADR-240: the nightly canary's sink. TelegramSender records, and never sends, what is addressed to the
 * canary chat and every office alert about a canary request. The canary chat can only be an id no
 * Telegram chat can have (2^52 and up), so no real chat can be sunk, however it is configured.
 */
const tenantId = '00000000-0000-4000-a000-000000000001';
const OWNER_CHAT = '7191500129';
const CANARY = String(CANARY_CHAT_ID_MIN + 4242);
let db: Kysely<Database>;
beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
afterAll(async () => { await db?.destroy(); });
const asAutomation = <T>(fn: (trx: Kysely<Database>) => Promise<T>) =>
  withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, fn);

function recordingBridge() {
  const calls: Array<{ chatId: string; text?: string }> = [];
  const bridge: BridgeLike = {
    async dispatchOutboundMessage(chatId, message) { calls.push({ chatId: String(chatId), text: message.text }); return { success: true, messageId: String(100 + calls.length) }; },
    async dispatchOutboundDocument(chatId) { calls.push({ chatId: String(chatId) }); return { success: true, messageId: String(100 + calls.length) }; },
  };
  return { bridge, calls };
}
function deps(bridge: BridgeLike, canaryChatId: string | null, canaryTasks: string[] = []): TelegramSenderDeps {
  return {
    db, botToken: () => ['canary', 'test', 'bot'].join('_'), bridge: () => bridge,
    readExportBytes: async () => null, officeChatIds: () => ['9000001'], markRetryDelaysMs: [5],
    canaryChatId: () => canaryChatId,
    isCanaryTask: async (_trx, _tenant, taskId, canary) => canary === canaryChatId && canaryTasks.includes(taskId),
  };
}
const message = (chatId: string, overrides: Partial<OutboundMessage> = {}): OutboundMessage =>
  ({ v: 1, key: `canary-test:${randomUUID()}`, chatId, kind: 'text', text: 'Got it. A designer will make it.', class: 'critical', tenantId, ...overrides });
const sinkRow = async (key: string) => (await asAutomation((trx) => sql<{ event_kind: string; payload: Record<string, unknown> }>`
  SELECT event_kind, payload FROM hawa.inbox_events WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery'
    AND source_event_id = ${`${markIdOf(key)}:${SEND_STEP}`} ORDER BY received_at DESC LIMIT 1`.execute(trx))).rows[0];

describe('the reserved canary chat range (packages/contracts/src/canary.ts)', () => {
  it('is exactly [2^52, 2^53): no Telegram chat, private or group, can be in it', () => {
    expect(isReservedCanaryChatId(String(CANARY_CHAT_ID_MIN))).toBe(true);
    expect(isReservedCanaryChatId(String(CANARY_CHAT_ID_MAX))).toBe(true);
    expect(isReservedCanaryChatId(CANARY_CHAT_ID_MIN)).toBe(true);
    for (const real of [OWNER_CHAT, '-1001234567890', String(CANARY_CHAT_ID_MIN - 1), '9007199254740992', `0${CANARY_CHAT_ID_MIN}`,
      `-${CANARY_CHAT_ID_MIN}`, `${CANARY_CHAT_ID_MIN}.0`, ` ${CANARY_CHAT_ID_MIN}`, '', 'canary']) {
      expect(isReservedCanaryChatId(real), real).toBe(false);
    }
  });

  it('configures nothing from a real chat id: the owner\'s chat can never be named the canary', () => {
    expect(canaryChatIdFromEnv({ HAWA_CANARY_CHAT_ID: OWNER_CHAT })).toBeNull();
    expect(canaryChatProblem({ HAWA_CANARY_CHAT_ID: OWNER_CHAT })).toMatch(/is ignored/);
    expect(isCanaryChat(OWNER_CHAT, { HAWA_CANARY_CHAT_ID: OWNER_CHAT })).toBe(false);
    expect(canaryChatIdFromEnv({})).toBeNull();
    expect(canaryChatProblem({})).toBeNull();
    expect(canaryChatIdFromEnv({ HAWA_CANARY_CHAT_ID: ` ${CANARY} ` })).toBe(CANARY);
    expect(isCanaryChat(Number(CANARY), { HAWA_CANARY_CHAT_ID: CANARY })).toBe(true);
  });
});

describe('TelegramSender\'s canary sink (ADR-240)', () => {
  it('records a message to the canary chat as canary_sink: Telegram is never called, and no sent mark is written', async () => {
    const { bridge, calls } = recordingBridge();
    const m = message(CANARY);
    const answer = await sendAttempt(deps(bridge, CANARY), m);
    expect(answer).toEqual({ outcome: 'canary_sink', messageId: canarySinkMessageId(m.key) });
    expect(calls).toEqual([]);
    expect(await sinkRow(m.key)).toMatchObject({ event_kind: 'telegram_message_canary_sink',
      payload: { outcome: 'canary_sink', chatId: CANARY, reason: 'canary_chat', kind: 'text', text: m.text } });
    // Readers of send marks never take it for a sent message (a requester's receipt).
    expect(await asAutomation((trx) => readSendMark(trx, tenantId, markIdOf(m.key), SEND_STEP))).toBeUndefined();
    // The stand-in id is a valid message id, the same for the same key, far above a chat's real ones.
    expect(Number(answer.outcome === 'canary_sink' && answer.messageId)).toBeGreaterThan(2 ** 50);
    expect(canarySinkMessageId(m.key)).toBe(answer.outcome === 'canary_sink' ? answer.messageId : '');
  });

  it('never sinks a real chat: the owner\'s chat set as HAWA_CANARY_CHAT_ID still gets its message', async () => {
    const { bridge, calls } = recordingBridge();
    // As telegramSenderDepsFromEnv reads it: an id outside the range configures no canary.
    const m = message(OWNER_CHAT);
    expect(await sendAttempt(deps(bridge, canaryChatIdFromEnv({ HAWA_CANARY_CHAT_ID: OWNER_CHAT })), m)).toEqual({ outcome: 'sent', messageId: '101' });
    expect(calls).toEqual([{ chatId: OWNER_CHAT, text: m.text }]);
    expect((await sinkRow(m.key))?.event_kind).toBe('telegram_message_sent');
  });

  it('sends to every real chat while a canary is configured, unless the message is about a canary request', async () => {
    const { bridge, calls } = recordingBridge();
    const canaryTask = randomUUID();
    const d = deps(bridge, CANARY, [canaryTask]);
    const realRequest = message(OWNER_CHAT, { taskId: randomUUID() });
    const noTask = message(OWNER_CHAT);
    const officeAlert = message('9000001', { taskId: canaryTask, text: 'A new draft is ready for office review: "Amber Reading Workshop"' });
    expect((await sendAttempt(d, realRequest)).outcome).toBe('sent');
    expect((await sendAttempt(d, noTask)).outcome).toBe('sent');
    expect(await sendAttempt(d, officeAlert)).toMatchObject({ outcome: 'canary_sink' });
    expect(calls.map((c) => c.chatId)).toEqual([OWNER_CHAT, OWNER_CHAT]);
    expect(await sinkRow(officeAlert.key)).toMatchObject({ payload: { reason: 'canary_request', chatId: '9000001' } });
  });

  it('sinks nothing at all without a configured canary, whatever the task', async () => {
    const { bridge, calls } = recordingBridge();
    const m = message('9000001', { taskId: randomUUID() });
    expect(await canarySinkFor(deps(bridge, null, [m.taskId!]), m)).toBeNull();
    expect(await canarySinkFor(deps(bridge, null), message(CANARY))).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a question recorded for the canary is not confirmed (Core would refuse it), and nothing is alerted', async () => {
    const { bridge } = recordingBridge();
    const requestId = randomUUID(), taskId = randomUUID(), questionId = randomUUID();
    const notified: string[] = [];
    const forwarded: OutboundMessage[] = [];
    const ctx: SenderContext = { run: (_n, action) => action(), sendTo: (m) => { forwarded.push(m); }, notifySent: (_m, id) => { notified.push(id); } };
    const m = message(CANARY, { key: `${requestId}:2:design-outcome`, taskId, onSent: { kind: 'question', requestId, requestRev: 2, taskId, questionId } });
    expect((await handleSend(ctx, deps(bridge, CANARY), m)).outcome).toBe('canary_sink');
    expect(notified).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  it('isCanaryTask reads the task\'s intake: only a task the canary chat sent is the canary\'s', async () => {
    await asAutomation(async (trx) => {
      expect(await isCanaryTask(trx, tenantId, randomUUID(), CANARY)).toBe(false);
      expect(await isCanaryTask(trx, tenantId, 'not-a-task', CANARY)).toBe(false);
    });
  });
});

describe('office alerts about a canary request go to the canary chat (office-chats.ts)', () => {
  it('moves an alert about a reserved-range chat to it, naming the member, and leaves every real request alone', () => {
    expect(officeAlertRoute('9000001', CANARY)).toEqual({ chatId: CANARY, canaryFor: '9000001' });
    expect(officeAlertRoute('9000001', OWNER_CHAT)).toEqual({ chatId: '9000001' });
    expect(officeAlertRoute('9000001', undefined)).toEqual({ chatId: '9000001' });
    expect(officeAlertRoute('9000001', null)).toEqual({ chatId: '9000001' });
    expect(officeAlertRoute(CANARY, CANARY)).toEqual({ chatId: CANARY });
  });
});

describe('Core\'s own office messages through the outbox (notify.telegram) are sunk for the canary too', () => {
  const outboxTenant = '00000000-0000-4000-a000-000000000006';
  const outboxUser = '00000000-0000-4000-b000-000000000006';
  const inTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, { tenantId: outboxTenant, userId: outboxUser, role: 'administrator' }, fn);
  afterEach(() => { vi.unstubAllEnvs(); });
  const enqueue = async (chatId: string) => {
    const key = `canary-outbox-${randomUUID()}`;
    const repo = new OutboxRepository(db);
    await inTenant((trx) => repo.enqueue({ tenantId: outboxTenant, aggregateType: 'task', aggregateId: randomUUID(), commandType: 'notify.telegram',
      idempotencyKey: key, payload: { chatId, message: { text: 'A request has waited for review for six hours.' } } }, trx));
    const row = (await inTenant((trx) => repo.findByIdempotencyKey(outboxTenant, key, trx)))!;
    return { key, id: row.id };
  };
  const latestMark = async (id: string) => (await inTenant((trx) => sql<{ event_kind: string }>`SELECT event_kind FROM hawa.inbox_events
    WHERE tenant_id = ${outboxTenant}::uuid AND source_account_id = 'telegram_delivery' AND source_event_id = ${`${id}:message`}
    ORDER BY received_at DESC LIMIT 1`.execute(trx))).rows[0]?.event_kind;

  it('isCanaryTask is true only for a task whose intake names the canary chat', async () => {
    const repo = new OutboxRepository(db);
    const created = async (chatId: string) => {
      const taskId = randomUUID();
      await inTenant((trx) => repo.enqueue({ tenantId: outboxTenant, aggregateType: 'task', aggregateId: taskId, commandType: 'task.created',
        idempotencyKey: `canary-task-${taskId}`, payload: { sourcePlatform: 'telegram', sourceChannelId: chatId } }, trx));
      await inTenant((trx) => sql`UPDATE hawa.outbox_commands SET state = 'delivered' WHERE aggregate_id = ${taskId}::uuid`.execute(trx));
      return taskId;
    };
    const canaryTask = await created(CANARY), ownerTask = await created(OWNER_CHAT);
    await inTenant(async (trx) => {
      expect(await isCanaryTask(trx, outboxTenant, canaryTask, CANARY)).toBe(true);
      expect(await isCanaryTask(trx, outboxTenant, ownerTask, CANARY)).toBe(false);
      expect(await isCanaryTask(trx, outboxTenant, canaryTask, OWNER_CHAT)).toBe(false);
    });
  });

  it('records one for the canary chat, and sends one for a real chat even when that chat is set as HAWA_CANARY_CHAT_ID', async () => {
    const sent: string[] = [];
    const worker = new OutboxConsumer(db, { tenantId: outboxTenant, userId: outboxUser, telegramBotToken: 'test-token', officeAlertChatId: null,
      telegramSender: () => ({ async dispatchOutboundMessage(chatId) { sent.push(String(chatId)); return { success: true, messageId: '77' }; },
        async dispatchOutboundDocument() { throw new Error('No document expected'); } }) });
    vi.stubEnv('HAWA_CANARY_CHAT_ID', CANARY);
    const toCanary = await enqueue(CANARY);
    await worker.processBatch(10);
    expect(sent).toEqual([]);
    expect(await latestMark(toCanary.id)).toBe('telegram_message_canary_sink');
    vi.stubEnv('HAWA_CANARY_CHAT_ID', OWNER_CHAT);
    const toOwner = await enqueue(OWNER_CHAT);
    await worker.processBatch(10);
    expect(sent).toEqual([OWNER_CHAT]);
    expect(await latestMark(toOwner.id)).toBe('telegram_message_sent');
  });
});
