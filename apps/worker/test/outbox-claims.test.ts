import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import type { TelegramSender } from '../src/delivery-notification.js';

/**
 * Phase 0.2 of the architecture programme (2026-09-24): no network call inside an open transaction.
 *
 * The consumer used to run each handler inside the command's transaction. A Telegram document upload
 * may take 60 s while the pool's idle_in_transaction_session_timeout is 30 s, so the session could be
 * killed after the send and before the command was marked delivered, and the delivery sent again.
 * Here the consumer's own sessions time out after 1 s, handlers take longer than that, consumers stop
 * mid-send, and two consumers poll one queue.
 */

const tenantId = '00000000-0000-4000-a000-000000000006';
const userId = '00000000-0000-4000-b000-000000000006';
const scope = { tenantId, userId, role: 'administrator' };
const botToken = ['worker', 'claims', 'bot', 'token'].join('_');
const url = process.env.TEST_DATABASE_URL!;

interface PoolLike { on(event: string, listener: (arg: { on(event: string, fn: () => void): void }) => void): void }
const fromDbPackage = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const pg = fromDbPackage('pg') as { Pool: new (config: Record<string, unknown>) => PoolLike };
const kysely = fromDbPackage('kysely') as {
  Kysely: new (config: { dialect: unknown }) => Kysely<Database>;
  PostgresDialect: new (config: { pool: PoolLike }) => unknown;
};

/**
 * A database whose every session is killed after 1 s idle inside a transaction. Set as a startup
 * option, so nothing can race it the way createDb's own session settings are applied.
 */
function shortIdleDb(): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    options: '-c search_path=hawa,public -c idle_in_transaction_session_timeout=1000',
  });
  // A session the server kills emits 'error' on its client; with no listener that would be thrown.
  pool.on('error', () => {});
  pool.on('connect', (client) => client.on('error', () => {}));
  return new kysely.Kysely({ dialect: new kysely.PostgresDialect({ pool }) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let db: Kysely<Database>;
let repo: OutboxRepository;
const asTenant = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => withRlsContext(db, scope, fn);

beforeAll(() => {
  db = createDb(url);
  repo = new OutboxRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});
beforeEach(async () => {
  // The consumers below drain the whole tenant: rows other suites left behind would be sent too.
  await asTenant((trx) => trx.deleteFrom('outbox_commands').where('tenant_id', '=', tenantId).execute());
});

async function enqueue(commandType: string, payload: Record<string, unknown>) {
  const idempotencyKey = `claims-test-${randomUUID()}`;
  const row = await asTenant((trx) =>
    repo.enqueue({ tenantId, aggregateType: 'task', aggregateId: randomUUID(), commandType, idempotencyKey, payload }, trx)
  );
  return { id: row.id as string, idempotencyKey };
}
const record = (idempotencyKey: string) => asTenant((trx) => repo.findByIdempotencyKey(tenantId, idempotencyKey, trx));

describe('the outbox consumer holds no transaction while a handler acts', () => {
  it('completes a 2 s handler once although its sessions are killed after 1 s idle in a transaction', async () => {
    const consumerDb = shortIdleDb();
    try {
      const shown = await sql<{ idle: string }>`SELECT current_setting('idle_in_transaction_session_timeout') AS idle`.execute(consumerDb);
      expect(shown.rows[0].idle).toBe('1s');

      const { idempotencyKey } = await enqueue('test.slow_send', { note: 'takes two seconds' });
      let calls = 0;
      const consumer = new OutboxConsumer(consumerDb, {
        tenantId, userId, batchSize: 5,
        handlers: { 'test.slow_send': async () => { calls++; await sleep(2000); } },
      });
      const summary = await consumer.processBatch(5);
      const row = await record(idempotencyKey);
      expect({ calls, succeeded: summary.succeeded, state: row?.state, attempts: row?.attempts, error: row?.last_error ?? null })
        .toEqual({ calls: 1, succeeded: 1, state: 'delivered', attempts: 0, error: null });
    } finally {
      await consumerDb.destroy();
    }
  });

  it('never lets two consumers act on one row, even when a handler outlasts the lease', async () => {
    const ids = await Promise.all([1, 2, 3].map((n) => enqueue('test.long_send', { n })));
    const handled = new Map<string, number>();
    const handler = async (cmd: { id: string }) => {
      handled.set(cmd.id, (handled.get(cmd.id) || 0) + 1);
      await sleep(1500);
    };
    // A one-second lease: a consumer that stopped renewing would lose the row before it finished.
    const make = () => new OutboxConsumer(db, { tenantId, userId, batchSize: 10, leaseSeconds: 1, handlers: { 'test.long_send': handler } });
    const [a, b] = [make(), make()];
    const deadline = Date.now() + 7000;
    const drain = async (consumer: OutboxConsumer) => {
      while (Date.now() < deadline) {
        await consumer.processBatch(10);
        const rows = await Promise.all(ids.map((c) => record(c.idempotencyKey)));
        if (rows.every((r) => r?.state === 'delivered')) return;
        await sleep(100);
      }
    };
    await Promise.all([drain(a), drain(b)]);
    const rows = await Promise.all(ids.map((c) => record(c.idempotencyKey)));
    expect(ids.map((c) => handled.get(c.id) || 0)).toEqual([1, 1, 1]);
    expect(rows.map((r) => [r?.state, r?.attempts])).toEqual([['delivered', 0], ['delivered', 0], ['delivered', 0]]);
  }, 15000);

  it('records a result only while the claim is still its own', async () => {
    // An operator redrives the command while its handler is still acting: the operator's decision
    // stands, and the late result changes nothing.
    const { id, idempotencyKey } = await enqueue('test.redriven_meanwhile', { note: 'redriven while acting' });
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 1,
      handlers: { 'test.redriven_meanwhile': async () => { await asTenant((trx) => repo.redrive(tenantId, id, trx)); } },
    });
    const summary = await consumer.processBatch(1);
    const row = await record(idempotencyKey);
    expect({ succeeded: summary.succeeded, lost: summary.lostClaims, state: row?.state, attempts: row?.attempts })
      .toEqual({ succeeded: 0, lost: 1, state: 'pending', attempts: 0 });
  });

  it('counts a claim whose holder stopped as an attempt, and dead-letters it as uncertain at the limit', async () => {
    const { id, idempotencyKey } = await enqueue('test.stops_every_worker', { note: 'every holder dies' });
    // Two earlier holders stopped mid-command: the lease of the second has run out.
    await asTenant((trx) => sql`UPDATE hawa.outbox_commands SET state = 'leased', attempts = 2, leased_until = now() - interval '1 second'
      WHERE id = ${id}::uuid`.execute(trx));
    let calls = 0;
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 5, maxAttempts: 3,
      handlers: { 'test.stops_every_worker': async () => { calls++; } },
    });
    const summary = await consumer.processBatch(5);
    const row = await record(idempotencyKey);
    expect({ calls, deadLettered: summary.deadLettered, state: row?.state, attempts: row?.attempts, leased: row?.leased_until ?? null })
      .toEqual({ calls: 0, deadLettered: 1, state: 'failed', attempts: 3, leased: null });
    expect(row?.last_error).toMatch(/^DELIVERY_UNCERTAIN: LEASE_EXPIRED/);
  });

  it('hands a handler only the columns it needs, and no picture from the payload', async () => {
    const picture = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    await enqueue('task.dispatch', {
      rawRequestText: 'Poster for the spring sale',
      sourcePlatform: 'telegram',
      sourceChannelId: '4242',
      referenceImageBase64: picture,
      studioOptions: { tier: 'quality', referenceImageBase64: picture, mediaGroupId: 'album-1' },
      payload: { sourcePlatform: 'telegram', sourceChannelId: '4242', referenceImageBase64: picture, studioOptions: { referenceImageBase64: picture } },
    });
    const seen: Array<Record<string, unknown>> = [];
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 5,
      handlers: { 'task.dispatch': async (cmd) => { seen.push(cmd as unknown as Record<string, unknown>); } },
    });
    await consumer.processBatch(5);
    expect(seen).toHaveLength(1);
    const cmd = seen[0];
    expect(Object.keys(cmd).sort()).toEqual(
      ['aggregate_id', 'aggregate_type', 'attempts', 'claim_token', 'command_type', 'id', 'idempotency_key', 'payload', 'reclaimed', 'state', 'tenant_id'].sort()
    );
    const text = JSON.stringify(cmd);
    expect(text).not.toContain('base64');
    expect(text.length).toBeLessThan(2000);
    // Everything else the dispatcher reads is still there.
    const payload = cmd.payload as { rawRequestText?: string; studioOptions?: Record<string, unknown>; payload?: Record<string, unknown> };
    expect(payload.rawRequestText).toBe('Poster for the spring sale');
    expect(payload.studioOptions).toEqual({ tier: 'quality', mediaGroupId: 'album-1' });
    expect(payload.payload).toEqual({ sourcePlatform: 'telegram', sourceChannelId: '4242', studioOptions: {} });
  });
});

describe('a consumer that stops mid-send is not repeated by the one that reclaims its work', () => {
  const office = String(9300 + Math.floor(Math.random() * 500));

  function deliveryPayload(chat: string, artifactId: string, png: Uint8Array) {
    return {
      taskId: randomUUID(), title: 'Reclaim poster', chatId: chat, driveFolderId: '', spreadsheetId: '', sheetsConfirmed: false,
      archiveProblem: 'the office Google account is not connected', filesCount: 1,
      files: [{ artifactId, format: 'png', filename: 'reclaim.png', mimeType: 'image/png', sha256: sha(png), byteSize: png.length }],
    };
  }

  /**
   * Stands in for a worker that dies at a given send: the send reaches Telegram, then the process
   * is gone. Its database pool closes, so it can neither renew its lease nor record anything, and
   * the send's promise never settles.
   */
  function dyingSender(log: { documents: string[]; notices: string[] }, dieAt: 'document' | 'notice', consumerDb: Kysely<Database>): TelegramSender {
    const die = () => { void consumerDb.destroy().catch(() => {}); return new Promise<never>(() => {}); };
    return {
      async dispatchOutboundDocument(chatId) {
        log.documents.push(String(chatId));
        if (dieAt === 'document') return die();
        return { success: true, messageId: '1' };
      },
      async dispatchOutboundMessage(chatId, message) {
        if (String(chatId) === office) return { success: true, messageId: '9' };
        log.notices.push(message.text);
        if (dieAt === 'notice') return die();
        return { success: true, messageId: '2' };
      },
    };
  }

  function recordingSender(log: { documents: string[]; notices: string[]; office: string[] }): TelegramSender {
    return {
      async dispatchOutboundDocument(chatId) { log.documents.push(String(chatId)); return { success: true, messageId: '3' }; },
      async dispatchOutboundMessage(chatId, message) {
        if (String(chatId) === office) log.office.push(message.text);
        else log.notices.push(message.text);
        return { success: true, messageId: '4' };
      },
    };
  }

  for (const dieAt of ['document', 'notice'] as const) {
    it(`does not send the ${dieAt} again after the first worker died having sent it`, async () => {
      const png = new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 5));
      const artifactId = randomUUID();
      const chat = String(7100 + Math.floor(Math.random() * 800));
      const { idempotencyKey } = await enqueue('notify.published', deliveryPayload(chat, artifactId, png));
      const readExportBytes = async (_d: unknown, _t: string, _task: string, id: string) => (id === artifactId ? png : null);

      const first = { documents: [] as string[], notices: [] as string[] };
      const firstDb = createDb(url);
      const dying = new OutboxConsumer(firstDb, {
        tenantId, userId, batchSize: 5, leaseSeconds: 1, telegramBotToken: botToken, officeAlertChatId: office,
        telegramSender: () => dyingSender(first, dieAt, firstDb), readExportBytes,
      });
      void dying.processBatch(5);
      // Wait until the first worker has made the send it dies at, then until its lease has run out.
      const until = Date.now() + 5000;
      while ((dieAt === 'document' ? first.documents : first.notices).length === 0 && Date.now() < until) await sleep(50);
      await sleep(1600);

      const second = { documents: [] as string[], notices: [] as string[], office: [] as string[] };
      const reclaiming = new OutboxConsumer(db, {
        tenantId, userId, batchSize: 5, leaseSeconds: 1, telegramBotToken: botToken, officeAlertChatId: office,
        telegramSender: () => recordingSender(second), readExportBytes,
      });
      const summary = await reclaiming.processBatch(5);
      const row = await record(idempotencyKey);

      expect(summary.leased).toBe(1);
      expect({ documents: first.documents.length + second.documents.length, notices: first.notices.length + second.notices.length })
        .toEqual({ documents: 1, notices: 1 });
      expect(second.documents).toEqual([]);
      if (dieAt === 'notice') expect(second.notices).toEqual([]);
      // Nobody knows whether the requester has what the first worker sent: the office is told.
      expect(row?.state).toBe('failed');
      expect(row?.last_error).toMatch(/^DELIVERY_UNCERTAIN: /);
      expect(row?.last_error).toContain(dieAt === 'document' ? 'reclaim.png' : 'delivery notice');
      expect(second.office).toHaveLength(1);
    }, 15000);
  }

  it('does not resend a notify.telegram message the first worker sent, and resends it after an administrator confirms a replay', async () => {
    const chat = String(7950 + Math.floor(Math.random() * 40));
    const { id, idempotencyKey } = await enqueue('notify.telegram', { chatId: chat, message: { text: 'Your Canva draft is ready' }, taskId: randomUUID() });
    const firstDb = createDb(url);
    const sent: string[] = [];
    const dying = new OutboxConsumer(firstDb, {
      tenantId, userId, leaseSeconds: 1, telegramBotToken: botToken, officeAlertChatId: office,
      telegramSender: () => ({
        async dispatchOutboundDocument() { return { success: true }; },
        async dispatchOutboundMessage(chatId) {
          if (String(chatId) === office) return { success: true };
          sent.push(String(chatId));
          void firstDb.destroy().catch(() => {});
          return new Promise<never>(() => {});
        },
      }),
    });
    void dying.processBatch(5);
    const until = Date.now() + 5000;
    while (sent.length === 0 && Date.now() < until) await sleep(50);
    await sleep(1600);

    const office2: string[] = [];
    const again = () => new OutboxConsumer(db, {
      tenantId, userId, leaseSeconds: 1, telegramBotToken: botToken, officeAlertChatId: office,
      telegramSender: () => ({
        async dispatchOutboundDocument() { return { success: true }; },
        async dispatchOutboundMessage(chatId) {
          if (String(chatId) === office) office2.push(String(chatId));
          else sent.push(String(chatId));
          return { success: true, messageId: '5' };
        },
      }),
    });
    await again().processBatch(5);
    expect(sent).toEqual([chat]);
    expect(office2).toHaveLength(1);
    const uncertain = await record(idempotencyKey);
    expect([uncertain?.state, uncertain?.last_error?.startsWith('DELIVERY_UNCERTAIN: ')]).toEqual(['failed', true]);

    // An administrator looked, found nothing in the chat, and confirmed the replay (requeue with
    // confirmUncertainReplay): the command starts over with no attempts, and is sent once more.
    await asTenant((trx) => repo.redrive(tenantId, id, trx));
    await again().processBatch(5);
    expect(sent).toEqual([chat, chat]);
    expect((await record(idempotencyKey))?.state).toBe('delivered');
  }, 15000);
});
