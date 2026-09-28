import { afterAll, describe, it, expect, vi } from 'vitest';
import { createDb, withRlsContext, sql } from '@hawa/db';
import { parkTelegramUpdate } from '../src/services/polled-update-dispatch.js';

// createPolledUpdateHandler (Core's poller counting attempts before the dead letter) was removed by
// stage 2 of ADR-135; ChatInbox counts them now (apps/worker/test/chat-inbox.test.ts).

describe('parkTelegramUpdate: the parked update is a durable row an operator can read', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(async () => { await db.destroy(); });
  const identity = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001' };
  const rows = (updateId: number) =>
    withRlsContext(db, { ...identity, role: 'operator' }, async (trx) =>
      (await sql<any>`SELECT event_kind, processing_error, payload, verified FROM hawa.inbox_events
        WHERE source_account_id = 'telegram' AND source_event_id = ${'parked-update-' + updateId}`.execute(trx)).rows);

  it('writes the update\'s id and kind with the reason, never its content, under the same RLS identity production uses, and only once', async () => {
    const parked = { update_id: 900_000_000 + Math.floor(Math.random() * 1e8), message: { chat: { id: 77 }, text: 'بانگهێشتنامەی کۆنفرانس' } };
    await parkTelegramUpdate(db, identity, parked, 'intake answered HTTP 500 after 5 attempts');
    await parkTelegramUpdate(db, identity, parked, 'a second pass after a restart');

    const found = await rows(parked.update_id);
    expect(found).toHaveLength(1);
    expect(found[0].event_kind).toBe('telegram_update_parked');
    expect(found[0].processing_error).toBe('intake answered HTTP 500 after 5 attempts');
    // The dead letter names the update; the words stay in the chat (architecture programme 0.4).
    expect(found[0].payload).toEqual({ update_id: parked.update_id, kind: 'message' });
    expect(JSON.stringify(found[0].payload)).not.toContain(parked.message.text);
    expect(found[0].verified).toBe(true);
  });

  it('alerts the office once, in the same transaction, and never the sender\'s own chat', async () => {
    const office = '91000009';
    const parked = { update_id: 900_000_000 + Math.floor(Math.random() * 1e8), message: { chat: { id: 78 }, from: { first_name: 'Rebin', username: 'rebin_k' }, text: 'secret words' } };
    const alongside = vi.fn(async () => {});
    await parkTelegramUpdate(db, identity, parked, 'intake answered HTTP 500 after 5 attempts', { officeChatId: office, alongside });
    await parkTelegramUpdate(db, identity, parked, 'again', { officeChatId: office });
    expect(alongside).toHaveBeenCalledTimes(1);
    const alerts = await withRlsContext(db, { ...identity, role: 'operator' }, async (trx) =>
      (await sql<any>`SELECT payload FROM hawa.outbox_commands WHERE idempotency_key = ${`notify.office:telegram-update-parked:${parked.update_id}`}`.execute(trx)).rows);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.chatId).toBe(office);
    expect(alerts[0].payload.message.text).toContain('from chat 78, sent by Rebin (@rebin_k)');
    expect(JSON.stringify(alerts[0].payload)).not.toContain('secret words');

    const own = { update_id: parked.update_id + 1, message: { chat: { id: Number(office) }, text: 'x' } };
    await parkTelegramUpdate(db, identity, own, 'x', { officeChatId: office });
    const ownAlerts = await withRlsContext(db, { ...identity, role: 'operator' }, async (trx) =>
      (await sql<any>`SELECT 1 FROM hawa.outbox_commands WHERE idempotency_key = ${`notify.office:telegram-update-parked:${own.update_id}`}`.execute(trx)).rows);
    expect(ownAlerts).toHaveLength(0);
  });

  it('writes nothing when what goes alongside fails: the dead letter and the offset commit together', async () => {
    const parked = { update_id: 900_000_000 + Math.floor(Math.random() * 1e8), message: { chat: { id: 79 } } };
    await expect(parkTelegramUpdate(db, identity, parked, 'x', { officeChatId: '91000009', alongside: async () => { throw new Error('offset not stored'); } }))
      .rejects.toThrow('offset not stored');
    expect(await rows(parked.update_id)).toHaveLength(0);
  });

  it('throws when the row cannot be written, so the queue does not move past an unstored update', async () => {
    const down = createDb('postgres://hawa:x@127.0.0.1:1/hawa_test');
    try {
      await expect(parkTelegramUpdate(down, identity, { update_id: 1 }, 'x')).rejects.toThrow();
    } finally {
      await down.destroy();
    }
  });
});

import { createApp } from '../src/app.js';

describe('/health tells the watchdog about a parked client message', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(async () => { await db.destroy(); });

  it('is degraded, with the count, while a parked message is under 48 hours old', async () => {
    const identity = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001' };
    await parkTelegramUpdate(db, identity, { update_id: 800_000_000 + Math.floor(Math.random() * 1e8) }, 'intake answered HTTP 500 after 5 attempts');
    const body = await (await createApp({ db }).request('/health')).json();
    expect(body.dependencies.parkedClientMessages).toBeGreaterThanOrEqual(1);
    expect(body.status).not.toBe('healthy');
  }, 30_000);
});
