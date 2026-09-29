import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer, REQUESTER_SEND_RETIRED } from '../src/outbox-consumer.js';
import { composeDeliveredCaption, composeDeliveredMessage, readStoredExportBytes, type TelegramSender } from '../src/delivery-notification.js';

/**
 * What the requester hears from the outbox worker.
 *
 * `notify.published`, Core's own delivery of the approved files to a Telegram requester, was retired
 * with ADR-135 stage 2d: the request-owned Delivery workflow sends them (with composeDeliveredMessage
 * and readStoredExportBytes, pinned below), and a command left from before ends at once, sending
 * nothing. A request dead-lettered at intake is told to the requester and the office.
 */

const tenantId = '00000000-0000-4000-a000-000000000006';
const userId = '00000000-0000-4000-b000-000000000006';
const botToken = ['worker', 'test', 'bot', 'token'].join('_');

let db: Kysely<Database>;
let outbox: OutboxRepository;

beforeAll(() => {
  db = createDb(process.env.TEST_DATABASE_URL!);
  outbox = new OutboxRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});

const asTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, { tenantId, userId, role: 'administrator' }, fn);

async function enqueue(commandType: string, payload: Record<string, unknown>, aggregateId: string = randomUUID()) {
  const idempotencyKey = `delivery-notice-test-${randomUUID()}`;
  await asTenant((trx) => outbox.enqueue({ tenantId, aggregateType: 'task', aggregateId, commandType, idempotencyKey, payload }, trx));
  return { idempotencyKey, aggregateId };
}
const record = (idempotencyKey: string) => asTenant((trx) => outbox.findByIdempotencyKey(tenantId, idempotencyKey, trx));

function recordingSender() {
  const documents: Array<{ chatId: string; bytes: Uint8Array; filename: string; mimeType?: string; caption?: string }> = [];
  const messages: Array<{ chatId: string; text: string; parse_mode?: string }> = [];
  const sender: TelegramSender = {
    async dispatchOutboundDocument(chatId, bytes, filename, options) {
      documents.push({ chatId: String(chatId), bytes, filename, mimeType: options?.mimeType, caption: options?.caption });
      return { success: true, messageId: String(documents.length) };
    },
    async dispatchOutboundMessage(chatId, message) {
      messages.push({ chatId: String(chatId), ...message });
      return { success: true, messageId: String(100 + messages.length) };
    },
  };
  return { sender, documents, messages };
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('an old notify.published command', () => {
  it('ends failed with REQUESTER_SEND_RETIRED at once, and sends nothing to the requester or the office', async () => {
    const png = new Uint8Array(Array.from({ length: 48 }, (_, i) => i));
    const artifactId = randomUUID();
    const chat = String(4300 + Math.floor(Math.random() * 600));
    const office = '9191';
    const { idempotencyKey } = await enqueue('notify.published', {
      taskId: randomUUID(), title: 'Left from before', chatId: chat, driveFolderId: 'client-root-folder', spreadsheetId: '',
      sheetsConfirmed: false, filesCount: 1,
      files: [{ artifactId, format: 'png', filename: 'old.png', mimeType: 'image/png', sha256: sha(png), byteSize: png.length }],
    });
    const { sender, documents, messages } = recordingSender();
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100, maxAttempts: 5,
      telegramBotToken: botToken, telegramSender: () => sender, officeAlertChatId: office,
    });

    await consumer.processBatch(100);

    const row = await record(idempotencyKey);
    // Permanent on the first attempt: no retries while attempts remain.
    expect([row?.state, row?.attempts]).toEqual(['failed', 1]);
    expect(row?.last_error).toContain(REQUESTER_SEND_RETIRED);
    expect(documents.filter((d) => d.chatId === chat || d.chatId === office)).toEqual([]);
    expect(messages.filter((m) => m.chatId === chat || m.chatId === office)).toEqual([]);
  });
});

describe('a request dead-lettered at intake', () => {
  const failingDispatch = { 'task.created': async () => { throw new Error('Restate ingress unreachable'); } };

  it('tells the requesting chat in plain English and alerts the office', async () => {
    const { idempotencyKey, aggregateId } = await enqueue('task.created', { sourcePlatform: 'telegram', sourceChannelId: '5151', rawRequestText: 'poster please' });
    const { sender, messages } = recordingSender();
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100, maxAttempts: 1,
      handlers: failingDispatch,
      telegramBotToken: botToken, telegramSender: () => sender, officeAlertChatId: '9090',
    });

    await consumer.processBatch(100);

    expect((await record(idempotencyKey))?.state).toBe('failed');
    const toRequester = messages.filter((m) => m.chatId === '5151');
    expect(toRequester).toHaveLength(1);
    // ADR-145: plain words, and no reference number (the office's alert names the task).
    expect(toRequester[0].text).toBe("Sorry, I couldn't start your design request. The office has been told and will follow up with you here.");
    expect(toRequester[0].parse_mode).toBeUndefined();
    const toOffice = messages.filter((m) => m.chatId === '9090');
    expect(toOffice).toHaveLength(1);
    expect(toOffice[0].text).toContain(aggregateId);
    expect(toOffice[0].text).toContain('Restate ingress unreachable');
  });

  it('says nothing while attempts remain', async () => {
    const { idempotencyKey } = await enqueue('task.created', { sourcePlatform: 'telegram', sourceChannelId: '5152' });
    const { sender, messages } = recordingSender();
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100, maxAttempts: 3,
      handlers: failingDispatch,
      telegramBotToken: botToken, telegramSender: () => sender, officeAlertChatId: '9090',
    });
    try {
      await consumer.processBatch(100);
      expect((await record(idempotencyKey))?.state).toBe('pending');
      expect(messages.filter((m) => m.chatId === '5152')).toHaveLength(0);
    } finally {
      // This test's own command only: left pending, a later batch in the shared tenant would run it.
      await asTenant((trx) => sql`DELETE FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${idempotencyKey}`.execute(trx));
    }
  });
});

describe('composeDeliveredMessage', () => {
  it('writes an HTML notice naming each attached file with its own Drive link, and nothing of the office\'s', () => {
    const text = composeDeliveredMessage({
      title: 'Eid <poster> & *sale*', driveFolderId: 'client-root-folder', spreadsheetId: '', sheetsConfirmed: false,
      sheetProblem: 'No spreadsheet is configured for this client',
      files: [
        { artifactId: randomUUID(), format: 'png', filename: 'kaae-1.png', mimeType: 'image/png', sha256: 'a'.repeat(64), byteSize: 1, webViewLink: 'https://drive.google.com/file/d/png-file/view' },
        { artifactId: randomUUID(), format: 'pdf', filename: 'kaae-2.pdf', mimeType: 'application/pdf', sha256: 'b'.repeat(64), byteSize: 1, webViewLink: 'https://drive.google.com/file/d/pdf-file/view' },
      ],
    } as never, { filesSent: 2 });
    expect(text).toMatch(/^Here is your final <b>Eid &lt;poster&gt; &amp; \*sale\*<\/b>\. 🎉/);
    expect(text).toContain('Also in Google Drive:');
    expect(text).toContain('<a href="https://drive.google.com/file/d/png-file/view">kaae-1.png</a>');
    expect(text).toContain('<a href="https://drive.google.com/file/d/pdf-file/view">kaae-2.pdf</a>');
    expect(text).not.toContain('client-root-folder');
    // The production log is the office's (ADR-145, #31): the Desk shows it, the requester is not told.
    expect(text).not.toMatch(/Production log|spreadsheet/i);
    expect(text).not.toMatch(/\*[A-Z][^*]*\*/); // no Markdown bold left over
  });

  it('falls back to the delivery folder for a command written before files were named', () => {
    const text = composeDeliveredMessage({ title: 'Old', driveFolderId: 'fld_1', spreadsheetId: 'sh_1', sheetRowNumber: 7 }, { filesSent: 0 });
    expect(text).toContain('<a href="https://drive.google.com/drive/folders/fld_1">the delivery folder</a>');
    expect(text).not.toMatch(/row 7|spreadsheets/);
  });

  it('says nothing of the office\'s Drive archive: that is the office\'s to follow up (ADR-145, #31)', () => {
    for (const archiveProblem of ['INVALID_DESTINATION', 'CREDENTIALS_MISSING', 'DRIVE_UPLOAD_FAILED: 403 Forbidden', 'the office Google account is not connected']) {
      const text = composeDeliveredMessage({ title: 'Archive', archiveProblem, driveFolderId: 'fld_1' }, { filesSent: 1 });
      expect(text).toBe('Here is your final <b>Archive</b>. 🎉');
    }
  });

  it('answers in the language of the design\'s name, and names files by it', () => {
    expect(composeDeliveredMessage({ title: 'پۆستەری نەورۆز' }, { filesSent: 1 })).toBe('فەرموو، ئەمە وەشانی کۆتایی <b>پۆستەری نەورۆز</b>. 🎉');
    expect(composeDeliveredCaption('KAAE: Nawroz poster', 'kaae.png')).toBe('Nawroz poster, final');
    expect(composeDeliveredCaption(null, 'kaae.png')).toBe('kaae.png');
  });
});

describe('readStoredExportBytes', () => {
  it('reads a stored Canva export under the command tenant', async () => {
    const t5 = '00000000-0000-4000-a000-000000000005';
    const u5 = '00000000-0000-4000-b000-000000000005';
    const client5 = 'c1000000-0000-4000-8000-000000000005';
    const taskId = randomUUID();
    const opId = randomUUID();
    const exportId = randomUUID();
    const content = Buffer.from(`stored export bytes for ${taskId}`);
    await withRlsContext(db, { tenantId: t5, userId: u5, role: 'administrator' }, async (trx) => {
      await sql`INSERT INTO hawa.tasks (id, tenant_id, client_id, title, description, state, priority, version, created_at, updated_at)
        VALUES (${taskId}::uuid, ${t5}::uuid, ${client5}::uuid, 'Stored export read', '', 'approved', 3, 1, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_remote_operations (id, tenant_id, task_id, client_id, actor_id, request_key, request_hash, kind, status, design_id, binding_version, metadata, created_at, updated_at)
        VALUES (${opId}::uuid, ${t5}::uuid, ${taskId}::uuid, ${client5}::uuid, ${u5}, ${'req_' + opId.slice(0, 8)}, 'hash_req', 'export', 'retrieved', 'design-read-test', 1, ${JSON.stringify({ format: 'png' })}::jsonb, now(), now())`.execute(trx);
      await sql`INSERT INTO hawa.canva_export_bytes (id, tenant_id, task_id, client_id, operation_id, format, sha256, content, created_at)
        VALUES (${exportId}::uuid, ${t5}::uuid, ${taskId}::uuid, ${client5}::uuid, ${opId}::uuid, 'png', ${sha(content)}, ${content}, now())`.execute(trx);
    });

    const read = await withRlsContext(db, { tenantId: t5, userId: u5, role: 'administrator' }, (trx) => readStoredExportBytes(trx, t5, taskId, exportId));
    expect(read && Buffer.from(read).equals(content)).toBe(true);
    // Another tenant's context cannot read it, and a malformed id is never queried.
    expect(await asTenant((trx) => readStoredExportBytes(trx, tenantId, taskId, exportId))).toBeNull();
    expect(await asTenant((trx) => readStoredExportBytes(trx, tenantId, 'bad', exportId))).toBeNull();
  });
});
