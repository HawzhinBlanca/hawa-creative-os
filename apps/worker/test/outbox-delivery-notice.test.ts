import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import { composeDeliveredMessage, readStoredExportBytes, type TelegramSender } from '../src/delivery-notification.js';

/**
 * What the requester hears from the outbox worker.
 *
 * `notify.published` used to send one Markdown-starred message with no parse mode (the requester saw
 * the asterisks), named only the client's root Drive folder, never sent the approved file, and was
 * marked delivered when the bot token or the chat was missing although nothing was sent. A request
 * dead-lettered at intake was never mentioned to the requester at all.
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

async function enqueue(commandType: string, payload: Record<string, unknown>, aggregateId = randomUUID()) {
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

describe('notify.published', () => {
  it('sends the approved files as documents, then an HTML notice with each file\'s Drive link', async () => {
    const png = new Uint8Array(Array.from({ length: 48 }, (_, i) => i));
    const pdf = new Uint8Array(Array.from({ length: 64 }, (_, i) => 255 - i));
    const pngId = randomUUID();
    const pdfId = randomUUID();
    const stored = new Map([[pngId, png], [pdfId, pdf]]);
    const { idempotencyKey } = await enqueue('notify.published', {
      taskId: randomUUID(),
      title: 'Eid <poster> & *sale*',
      chatId: '4242',
      driveFolderId: 'client-root-folder',
      spreadsheetId: '',
      sheetsConfirmed: false,
      sheetProblem: 'No spreadsheet is configured for this client',
      filesCount: 2,
      files: [
        { artifactId: pngId, format: 'png', filename: 'kaae-1.png', mimeType: 'image/png', sha256: sha(png), byteSize: png.length, webViewLink: 'https://drive.google.com/file/d/png-file/view' },
        { artifactId: pdfId, format: 'pdf', filename: 'kaae-2.pdf', mimeType: 'application/pdf', sha256: sha(pdf), byteSize: pdf.length, webViewLink: 'https://drive.google.com/file/d/pdf-file/view' },
      ],
    });
    const { sender, documents, messages } = recordingSender();
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100,
      telegramBotToken: botToken,
      telegramSender: () => sender,
      readExportBytes: async (_db, _tenant, _task, artifactId) => stored.get(artifactId) ?? null,
    });

    await consumer.processBatch(100);

    const sent = documents.filter((d) => d.chatId === '4242');
    expect(sent.map((d) => [d.filename, d.mimeType])).toEqual([
      ['kaae-1.png', 'image/png'],
      ['kaae-2.pdf', 'application/pdf'],
    ]);
    expect(sent[0].bytes).toEqual(png);
    expect(sent[1].bytes).toEqual(pdf);

    // Only this test's chat: the batch can also hold other commands of the shared test tenant.
    const toRequester = messages.filter((m) => m.chatId === '4242');
    expect(toRequester).toHaveLength(1);
    const [notice] = toRequester;
    expect(notice.parse_mode).toBe('HTML');
    expect(notice.text).toContain('<b>Eid &lt;poster&gt; &amp; *sale*</b>');
    expect(notice.text).toContain('The 2 approved files are attached above.');
    expect(notice.text).toContain('<a href="https://drive.google.com/file/d/png-file/view">kaae-1.png</a>');
    expect(notice.text).toContain('<a href="https://drive.google.com/file/d/pdf-file/view">kaae-2.pdf</a>');
    expect(notice.text).not.toContain('client-root-folder');
    expect(notice.text).toContain('Production log: not updated yet (No spreadsheet is configured for this client).');
    expect(notice.text).not.toMatch(/\*[A-Z][^*]*\*/); // no Markdown bold left over

    expect((await record(idempotencyKey))?.state).toBe('delivered');
  });

  it('sends nothing, and is not marked delivered, when a stored file no longer matches its approved hash', async () => {
    const artifactId = randomUUID();
    const { idempotencyKey } = await enqueue('notify.published', {
      taskId: randomUUID(), title: 'Changed file', chatId: '4243',
      files: [{ artifactId, format: 'png', filename: 'x.png', mimeType: 'image/png', sha256: 'f'.repeat(64) }],
    });
    const { sender, documents, messages } = recordingSender();
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 100, telegramBotToken: botToken, telegramSender: () => sender,
      readExportBytes: async () => new Uint8Array(40),
    });
    await consumer.processBatch(100);
    expect(documents.filter((d) => d.chatId === '4243')).toHaveLength(0);
    expect(messages.filter((m) => m.chatId === '4243')).toHaveLength(0);
    const row = await record(idempotencyKey);
    expect(row?.state).toBe('failed');
    expect(row?.last_error).toContain('DELIVERED_FILE_CHANGED');
  });

  it('dead-letters, instead of reporting delivered, when the task has no requesting chat', async () => {
    const { idempotencyKey } = await enqueue('notify.published', { taskId: 'not-a-uuid', title: 'Desk drill', files: [] });
    const { sender, messages } = recordingSender();
    const consumer = new OutboxConsumer(db, { tenantId, userId, batchSize: 100, telegramBotToken: botToken, telegramSender: () => sender });
    await consumer.processBatch(100);
    const row = await record(idempotencyKey);
    expect(row?.state).toBe('failed');
    expect(row?.last_error).toContain('NO_REQUESTER_CHAT');
    expect(messages.some((m) => m.text.includes('Desk drill'))).toBe(false);
  });

  it('is retried, instead of reported delivered, when no bot token is configured', async () => {
    const { idempotencyKey } = await enqueue('notify.published', { taskId: randomUUID(), title: 'No token', chatId: '4244', files: [] });
    const consumer = new OutboxConsumer(db, { tenantId, userId, batchSize: 100, telegramBotToken: null, maxAttempts: 5 });
    try {
      await consumer.processBatch(100);
      const row = await record(idempotencyKey);
      expect(row?.state).toBe('pending');
      expect(row?.attempts).toBe(1);
      expect(row?.last_error).toContain('TELEGRAM_NOT_CONFIGURED');
    } finally {
      await asTenant((trx) => sql`DELETE FROM hawa.outbox_commands WHERE tenant_id = ${tenantId}::uuid AND idempotency_key = ${idempotencyKey}`.execute(trx));
    }
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
    expect(toRequester[0].text).toContain('Sorry, we could not process your design request.');
    expect(toRequester[0].text).toContain('The office has been alerted');
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
  it('falls back to the delivery folder for a command written before files were named', () => {
    const text = composeDeliveredMessage({ title: 'Old', driveFolderId: 'fld_1', spreadsheetId: 'sh_1', sheetRowNumber: 7 }, { filesSent: 0 });
    expect(text).toContain('<a href="https://drive.google.com/drive/folders/fld_1">delivery folder</a>');
    expect(text).toContain('<a href="https://docs.google.com/spreadsheets/d/sh_1#gid=0&amp;range=A7">row 7</a> recorded.');
    expect(text).not.toContain('attached');
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
