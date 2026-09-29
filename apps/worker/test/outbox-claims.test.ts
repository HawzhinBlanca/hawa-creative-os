import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer, type OutboxHandlerScope } from '../src/outbox-consumer.js';
import { writeSendMark, type TelegramSender } from '../src/delivery-notification.js';

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

/**
 * Waits until `check` holds. The tests below wait for what a step needs (a send made, a lease run
 * out) instead of sleeping for how long it usually takes: under the suite's parallel load a fixed
 * sleep was sometimes too short, and a second consumer found a lease that had not run out yet. The
 * deadline only stops a wait for something that never happens: it is 10 s (the waits take 1 to 2 s),
 * so that two waits in one test end within the test's 30 s and a hang is reported as the wait that
 * never ended, not as the test's timeout.
 */
async function until(what: string, check: () => boolean | Promise<boolean>, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting until ${what}`);
    await sleep(50);
  }
}

/** Whether the command's lease has run out by the database's clock, the clock a claim is decided by. */
const leaseRunOut = async (id: string) =>
  (await asTenant((trx) => sql<{ out: boolean }>`SELECT leased_until < now() AS out FROM hawa.outbox_commands WHERE id = ${id}::uuid`.execute(trx)))
    .rows[0]?.out === true;

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

  /*
   * "Never two consumers on one row, even when a handler outlasts the lease" used to be one test: a
   * one-second lease, handlers that slept 1.5 s, and two consumers polling. It passed only while every
   * renewal landed within 0.67 s, which the suite's parallel load did not always allow; and a renewal
   * that comes late is allowed to lose the command (the fence in whileHeld, not the renewal, is what
   * keeps two consumers from both acting). It is three tests now, each true whatever the timing.
   */
  it('renews the lease while a handler outlasts it, and the command stays its own', async () => {
    const { id, idempotencyKey } = await enqueue('test.outlasts_lease', { note: 'acts past its first lease' });
    let calls = 0;
    const consumer = new OutboxConsumer(db, {
      tenantId, userId, batchSize: 1, leaseSeconds: 1,
      handlers: {
        'test.outlasts_lease': async (cmd) => {
          calls++;
          // Acts until the lease it was claimed with has run out by the database's clock, and a
          // renewal has moved the lease on past it.
          const claimedUntil = cmd.claim_token;
          await until('the first lease has run out and been renewed', async () => {
            const row = (await asTenant((trx) => sql<{ past: boolean; moved: boolean }>`
              SELECT now() > ${claimedUntil}::timestamptz AS past, leased_until > ${claimedUntil}::timestamptz AS moved
              FROM hawa.outbox_commands WHERE id = ${id}::uuid`.execute(trx))).rows[0];
            return Boolean(row?.past && row?.moved);
          });
        },
      },
    });
    const summary = await consumer.processBatch(1);
    const row = await record(idempotencyKey);
    expect({ calls, succeeded: summary.succeeded, lost: summary.lostClaims, state: row?.state, attempts: row?.attempts })
      .toEqual({ calls: 1, succeeded: 1, lost: 0, state: 'delivered', attempts: 0 });
  });

  it('does not take a command another consumer holds on a lease that has not run out', async () => {
    const { id, idempotencyKey } = await enqueue('test.held_elsewhere', { note: 'held by a live consumer' });
    await asTenant((trx) => sql`UPDATE hawa.outbox_commands SET state = 'leased', leased_until = now() + interval '1 hour'
      WHERE id = ${id}::uuid`.execute(trx));
    let calls = 0;
    const consumer = new OutboxConsumer(db, { tenantId, userId, batchSize: 5, leaseSeconds: 1, handlers: { 'test.held_elsewhere': async () => { calls++; } } });
    const summary = await consumer.processBatch(5);
    const row = await record(idempotencyKey);
    expect({ leased: summary.leased, calls, state: row?.state, attempts: row?.attempts }).toEqual({ leased: 0, calls: 0, state: 'leased', attempts: 0 });
  });

  it('lets two consumers polling one queue act on each command once, one at a time', async () => {
    // What this checks is the claim: a command one consumer holds is not handed to the other. The
    // lease is the default minute, so no lease runs out here whatever the load; a holder that loses
    // its lease while it acts is the takeover test's (review of phase 0.2, below).
    const ids = await Promise.all([1, 2, 3].map((n) => enqueue('test.guarded_send', { n })));
    const inside = new Map<string, number>();
    const acted = new Map<string, number>();
    let overlap = 0;
    // Every side effect goes through whileHeld, as the delivery handlers' do; the effect takes a while.
    // Before it, the handler prepares (a delivery reads the export's bytes) holding no row lock, so
    // only the lease keeps the other consumer off the command then: inside whileHeld the row lock
    // alone would (claims skip locked rows).
    const handler = async (cmd: { id: string }, _db: unknown, scope: OutboxHandlerScope) => {
      await sleep(150);
      await scope.whileHeld!(async () => {
        const now = (inside.get(cmd.id) || 0) + 1;
        inside.set(cmd.id, now);
        overlap = Math.max(overlap, now);
        await sleep(100);
        inside.set(cmd.id, now - 1);
        acted.set(cmd.id, (acted.get(cmd.id) || 0) + 1);
      });
    };
    const make = () => new OutboxConsumer(db, { tenantId, userId, batchSize: 10, handlers: { 'test.guarded_send': handler } });
    const [a, b] = [make(), make()];
    let allDelivered = false;
    const drain = async (consumer: OutboxConsumer) => {
      await until('every command is delivered', async () => {
        if (allDelivered) return true;
        await consumer.processBatch(10);
        const rows = await Promise.all(ids.map((c) => record(c.idempotencyKey)));
        allDelivered = rows.every((r) => r?.state === 'delivered');
        return allDelivered;
      });
    };
    await Promise.all([drain(a), drain(b)]);
    const rows = await Promise.all(ids.map((c) => record(c.idempotencyKey)));
    expect(overlap).toBe(1);
    expect(ids.map((c) => acted.get(c.id) || 0)).toEqual([1, 1, 1]);
    expect(rows.map((r) => [r?.state, r?.attempts])).toEqual([['delivered', 0], ['delivered', 0], ['delivered', 0]]);
  });

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

  it('clears the reclaim note when a reclaimed command is then delivered', async () => {
    const { id, idempotencyKey } = await enqueue('test.reclaimed_then_done', { note: 'first holder stopped' });
    await asTenant((trx) => sql`UPDATE hawa.outbox_commands SET state = 'leased', leased_until = now() - interval '1 second'
      WHERE id = ${id}::uuid`.execute(trx));
    const consumer = new OutboxConsumer(db, { tenantId, userId, handlers: { 'test.reclaimed_then_done': async () => {} } });
    await consumer.processBatch(5);
    const row = await record(idempotencyKey);
    expect({ state: row?.state, attempts: row?.attempts, error: row?.last_error ?? null }).toEqual({ state: 'delivered', attempts: 1, error: null });
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

  // (Two cases here pinned the same for Core's requester delivery, notify.published: its file or
  // notice was not sent again after the first worker died having sent it. ADR-135 stage 2d retired
  // that send; the worker ends such a command at once, sending nothing.)
  it('does not resend a notify.telegram message the first worker sent, and resends it after an administrator confirms a replay', async () => {
    const chat = String(7950 + Math.floor(Math.random() * 40));
    const { id, idempotencyKey } = await enqueue('notify.telegram', { chatId: chat, message: { text: 'Your Canva draft is ready' }, taskId: randomUUID() });
    const firstDb = createDb(url);
    let closed: Promise<void> | undefined;
    const sent: string[] = [];
    const dying = new OutboxConsumer(firstDb, {
      tenantId, userId, leaseSeconds: 1, telegramBotToken: botToken, officeAlertChatId: office,
      telegramSender: () => ({
        async dispatchOutboundDocument() { return { success: true }; },
        async dispatchOutboundMessage(chatId) {
          if (String(chatId) === office) return { success: true };
          sent.push(String(chatId));
          closed ??= firstDb.destroy().catch(() => {});
          return new Promise<never>(() => {});
        },
      }),
    });
    void dying.processBatch(5);
    await until('the first worker has sent the message', () => sent.length > 0);
    await closed;
    await until("the first worker's lease has run out", () => leaseRunOut(id));

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
    // confirmUncertainReplay): the command starts over and its uncertain send is released, so it is
    // sent once more. A redrive alone releases nothing (the review test above).
    await asTenant(async (trx) => {
      await repo.redrive(tenantId, id, trx);
      await repo.releaseUncertainSends(tenantId, [id], trx);
    });
    await again().processBatch(5);
    expect(sent).toEqual([chat, chat]);
    expect((await record(idempotencyKey))?.state).toBe('delivered');
  });
});

/**
 * Review of phase 0.2 (2026-09-24): a send Telegram did not confirm was released for sending again by
 * any requeue that reset the attempts, confirmed or not. (Three more cases here pinned it on Core's
 * multi-file requester delivery, notify.published: a holder whose lease was taken over kept sending
 * the later files, an unconfirmed file was resent after a plain requeue, and a later refusal ended a
 * delivery 'failed' rather than uncertain. ADR-135 stage 2d retired that delivery; the worker's
 * remaining sends are one message each.)
 */
describe('review of phase 0.2: sends that must not be repeated', () => {
  const office = String(9800 + Math.floor(Math.random() * 100));
  // What POST /v1/system/outbox/requeue {"all":true} does (system.routes.ts), which deploy.sh
  // suggests after every deploy: every failed row that is not uncertain starts over with no attempts.
  const requeueAll = () => {
    const uncertain = 'DELIVERY_UNCERTAIN|TELEGRAM_RECEIPT_INVALID|TIMEOUT_AFTER_SEND|KILL_AFTER_SEND|SOCKET_HANGUP_AFTER_WRITE';
    return asTenant((trx) => sql`UPDATE hawa.outbox_commands SET state = 'pending', attempts = 0, available_at = now(), leased_until = NULL
      WHERE tenant_id = ${tenantId}::uuid AND state = 'failed' AND NOT (coalesce(last_error, '') ~* ${uncertain})`.execute(trx));
  };

  it('keeps a send a worker was stopped in the middle of, whatever the command ended with, until an administrator confirms', async () => {
    // A send marked attempted with no answer, left by a worker that stopped; the command then ended
    // for a reason of its own that says nothing about that send, and a plain requeue restarts it.
    const chat = '7123004';
    const { id, idempotencyKey } = await enqueue('notify.telegram', { chatId: chat, message: { text: 'Midway message' }, taskId: randomUUID() });
    await asTenant(async (trx) => {
      await writeSendMark(trx, tenantId, id, 'message', 'message', 'attempted');
      await sql`UPDATE hawa.outbox_commands SET state = 'failed', attempts = 12, last_error = 'CORE_UNAVAILABLE: HTTP 502' WHERE id = ${id}::uuid`.execute(trx);
    });
    await requeueAll();
    const sends: string[] = [];
    const sender: TelegramSender = {
      async dispatchOutboundDocument() { return { success: true }; },
      async dispatchOutboundMessage(to) { if (String(to) !== office) sends.push(String(to)); return { success: true, messageId: '10' }; },
    };
    const consumer = () => new OutboxConsumer(db, { tenantId, userId, telegramBotToken: botToken, officeAlertChatId: office, telegramSender: () => sender });
    await consumer().processBatch(5);
    expect(sends).toEqual([]);
    const uncertain = await record(idempotencyKey);
    expect([uncertain?.state, uncertain?.last_error]).toEqual(['failed', expect.stringMatching(/^DELIVERY_UNCERTAIN: /)]);

    // The administrator checked the chat and confirmed the replay: the message is sent once.
    await asTenant(async (trx) => {
      await repo.redrive(tenantId, id, trx);
      await repo.releaseUncertainSends(tenantId, [id], trx);
    });
    await consumer().processBatch(5);
    expect(sends).toEqual([chat]);
    expect((await record(idempotencyKey))?.state).toBe('delivered');
  }, 15000);
});
