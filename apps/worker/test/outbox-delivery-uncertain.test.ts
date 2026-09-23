import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import type { TelegramSender } from '../src/delivery-notification.js';

/**
 * Bug hunt 2026-09-24: the approved file's upload to the requester times out (60 s upload limit; a
 * PPTX with photos is several MB). The send is "uncertain", the command is closed as failed, and the
 * office alert that every other failed delivery gets is skipped, while the Desk already told the
 * office "The approved file was sent to the requester in Telegram".
 */
const tenantId = '00000000-0000-4000-a000-000000000006';
const userId = '00000000-0000-4000-b000-000000000006';
const botToken = ['worker', 'hunt', 'bot', 'token'].join('_');
let db: Kysely<Database>;
beforeAll(() => { db = createDb(process.env.TEST_DATABASE_URL!); });
afterAll(async () => { await db?.destroy(); });

describe('HUNT: an uncertain delivery of the approved file', () => {
  it('alerts the office, since nobody knows whether the requester has the file', async () => {
    const png = new Uint8Array(Array.from({ length: 40 }, (_, i) => i * 3));
    const artifactId = randomUUID();
    const chat = String(7000 + Math.floor(Math.random() * 1000));
    const office = String(9100 + Math.floor(Math.random() * 800));
    const idempotencyKey = `hunt-uncertain-${randomUUID()}`;
    const repo = new OutboxRepository(db);
    await withRlsContext(db, { tenantId, userId, role: 'administrator' }, (trx) => repo.enqueue({
      tenantId, aggregateType: 'task', aggregateId: randomUUID(), commandType: 'notify.published', idempotencyKey,
      payload: {
        taskId: randomUUID(), title: 'Hunt poster', chatId: chat, archiveProblem: 'the office Google account is not connected',
        driveFolderId: '', spreadsheetId: '', sheetsConfirmed: false, filesCount: 1,
        files: [{ artifactId, format: 'png', filename: 'kaae-hunt.png', mimeType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), byteSize: png.length }],
      },
    }, trx));
    const toOffice: string[] = [];
    const sender: TelegramSender = {
      async dispatchOutboundDocument() { return { success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' }; },
      async dispatchOutboundMessage(chatId, message) {
        if (String(chatId) === office) toOffice.push(message.text);
        return { success: true, messageId: '1' };
      },
    };
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100, telegramBotToken: botToken, officeAlertChatId: office,
      telegramSender: () => sender,
      readExportBytes: async (_d, _t, _task, id) => (id === artifactId ? png : null),
    });
    await consumer.processBatch(100);
    const state = (await withRlsContext(db, { tenantId, userId, role: 'administrator' }, (trx) => repo.findByIdempotencyKey(tenantId, idempotencyKey, trx)))?.state;
    expect({ state, officeAlerts: toOffice.length }).toEqual({ state: 'failed', officeAlerts: 1 });
  });
});
