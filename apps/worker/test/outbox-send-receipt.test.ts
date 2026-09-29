import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import type { TelegramSender } from '../src/delivery-notification.js';

const tenantId = '00000000-0000-4000-a000-000000000006';
const userId = '00000000-0000-4000-b000-000000000006';
let db: Kysely<Database>;

beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
afterAll(async () => { await db?.destroy(); });

const inTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>) =>
  withRlsContext(db, { tenantId, userId, role: 'administrator' }, fn);

async function enqueue(commandType = 'notify.telegram', payload: Record<string, unknown> = { chatId: '551122', message: 'Ready' }) {
  const idempotencyKey = `outbox-send-receipt-${randomUUID()}`;
  const repo = new OutboxRepository(db);
  await inTenant((trx) => repo.enqueue({ tenantId, aggregateType: 'task', aggregateId: randomUUID(),
    commandType, idempotencyKey, payload }, trx));
  const row = await inTenant((trx) => repo.findByIdempotencyKey(tenantId, idempotencyKey, trx));
  if (!row) throw new Error('Command was not created');
  return { idempotencyKey, id: row.id };
}

async function command(key: string) {
  return inTenant((trx) => new OutboxRepository(trx).findByIdempotencyKey(tenantId, key, trx));
}

async function latestMark(id: string, step = 'message') {
  return inTenant(async (trx) => (await sql<{ event_kind: string; payload: Record<string, unknown> }>`
    SELECT event_kind, payload FROM hawa.inbox_events
    WHERE tenant_id = ${tenantId}::uuid AND source_account_id = 'telegram_delivery'
      AND source_event_id = ${`${id}:${step}`}
    ORDER BY received_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0]);
}

const sender = (send: () => Promise<{ success: boolean; messageId?: string; error?: string }>): TelegramSender => ({
  dispatchOutboundMessage: send,
  async dispatchOutboundDocument() { throw new Error('No document expected'); },
});

describe('legacy outbox Telegram send receipt', () => {
  it('does not complete or replay a success response without a valid message ID', async () => {
    const { idempotencyKey, id } = await enqueue();
    let sends = 0;
    const worker = new OutboxConsumer(db, { tenantId, userId, telegramBotToken: 'test-token', officeAlertChatId: null,
      telegramSender: () => sender(async () => { sends++; return { success: true }; }) });

    await worker.processBatch(10);
    expect((await command(idempotencyKey))?.state).toBe('failed');
    expect((await command(idempotencyKey))?.last_error).toContain('DELIVERY_UNCERTAIN');
    expect((await latestMark(id))?.event_kind).toBe('telegram_message_uncertain');

    await inTenant((trx) => sql`UPDATE hawa.outbox_commands SET state = 'pending', attempts = 0,
      available_at = now(), leased_until = NULL WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`.execute(trx));
    await worker.processBatch(10);
    expect(sends).toBe(1);
  });

  it('records the provider message ID with the sent mark before completing', async () => {
    const { idempotencyKey, id } = await enqueue();
    const worker = new OutboxConsumer(db, { tenantId, userId, telegramBotToken: 'test-token', officeAlertChatId: null,
      telegramSender: () => sender(async () => ({ success: true, messageId: '712' })) });

    await worker.processBatch(10);
    expect((await command(idempotencyKey))?.state).toBe('delivered');
    expect(await latestMark(id)).toMatchObject({ event_kind: 'telegram_message_sent', payload: { messageId: '712' } });
  });

  it('keeps an accepted message uncertain when its final sent mark cannot be stored', async () => {
    const { idempotencyKey, id } = await enqueue();
    let sends = 0;
    let failWrites = 0;
    const brokenDb = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') return () => {
          if (failWrites > 0) {
            failWrites--;
            return { execute: async () => { throw new Error('Injected sent-mark database failure'); } };
          }
          return target.transaction();
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Kysely<Database>;
    const worker = new OutboxConsumer(brokenDb, { tenantId, userId, telegramBotToken: 'test-token', officeAlertChatId: null,
      markRetryDelaysMs: [1], telegramSender: () => sender(async () => {
        sends++;
        failWrites = 2;
        return { success: true, messageId: '713' };
      }) });

    await worker.processBatch(10);
    expect((await command(idempotencyKey))?.state).toBe('failed');
    expect((await command(idempotencyKey))?.last_error).toContain('DELIVERY_UNCERTAIN');
    expect((await latestMark(id))?.event_kind).toBe('telegram_message_attempted');
    expect(sends).toBe(1);
  });

  it('holds a raw server error as uncertain even if a custom sender returns it directly', async () => {
    const { idempotencyKey, id } = await enqueue();
    const worker = new OutboxConsumer(db, { tenantId, userId, telegramBotToken: 'test-token', officeAlertChatId: null,
      telegramSender: () => sender(async () => ({ success: false, error: 'TELEGRAM_REJECTED_502' })) });

    await worker.processBatch(10);
    expect((await command(idempotencyKey))?.state).toBe('failed');
    expect((await command(idempotencyKey))?.last_error).toContain('DELIVERY_UNCERTAIN');
    expect((await latestMark(id))?.event_kind).toBe('telegram_message_uncertain');
  });
  // (Core's requester delivery, notify.published, had a case here: a file answered 'success' with no
  // message ID stayed uncertain. ADR-135 stage 2d retired that send; the Delivery workflow's own
  // sends go through lifecycle/telegram-sender.ts.)
});
