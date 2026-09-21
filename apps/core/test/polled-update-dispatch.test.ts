import { describe, it, expect, vi } from 'vitest';
import { createPolledUpdateHandler, PARKED_UPDATE_NOTICE, POLLED_UPDATE_MAX_ATTEMPTS } from '../src/services/polled-update-dispatch.js';

const quiet = { error: () => {}, warn: () => {} };
const update = { update_id: 4242, message: { chat: { id: 77 }, text: 'a brief' } };

function harness(deliver: () => Promise<number>, park: () => Promise<void> = async () => {}) {
  const deps = { deliver: vi.fn(deliver), park: vi.fn(park), notifySender: vi.fn(async () => {}), log: quiet };
  return { deps, handle: createPolledUpdateHandler(deps) };
}
/** Returning means the bridge advances the offset and Telegram forgets the update. */
const advances = async (handle: (u: typeof update) => Promise<void>) => handle(update).then(() => true, () => false);

describe('a Telegram update that intake keeps failing is never dropped', () => {
  it('advances on success and on a deliberate rejection, without parking', async () => {
    for (const status of [200, 201, 400, 401, 403, 422]) {
      const { deps, handle } = harness(async () => status);
      expect(await advances(handle)).toBe(true);
      expect(deps.park).not.toHaveBeenCalled();
      expect(deps.notifySender).not.toHaveBeenCalled();
    }
  });

  it('holds the queue while intake is failing, for 5xx, 429, 408 and a transport error alike', async () => {
    for (const deliver of [async () => 500, async () => 503, async () => 429, async () => 408, async () => { throw new Error('socket hang up'); }]) {
      const { deps, handle } = harness(deliver);
      for (let i = 1; i < POLLED_UPDATE_MAX_ATTEMPTS; i++) expect(await advances(handle)).toBe(false);
      expect(deps.park).not.toHaveBeenCalled();
    }
  });

  it('the old behaviour, giving up quietly on the fourth attempt, is gone', async () => {
    const { deps, handle } = harness(async () => 503, async () => { throw new Error('database is down'); });
    for (let i = 0; i < 12; i++) expect(await advances(handle)).toBe(false);
    expect(deps.notifySender).not.toHaveBeenCalled();
  });

  it('parks the update after the last attempt, tells the sender, and only then moves on', async () => {
    const { deps, handle } = harness(async () => 500);
    for (let i = 1; i < POLLED_UPDATE_MAX_ATTEMPTS; i++) expect(await advances(handle)).toBe(false);
    expect(await advances(handle)).toBe(true);
    expect(deps.deliver).toHaveBeenCalledTimes(POLLED_UPDATE_MAX_ATTEMPTS);
    expect(deps.park).toHaveBeenCalledTimes(1);
    expect(deps.park.mock.calls[0][0]).toBe(update);
    expect(String(deps.park.mock.calls[0][1])).toMatch(/HTTP 500 after 5 attempts/);
    expect(deps.notifySender).toHaveBeenCalledWith(update, PARKED_UPDATE_NOTICE);
  });

  it('keeps the queue blocked when the update cannot be parked either, then parks once storage is back', async () => {
    let storageUp = false;
    const { deps, handle } = harness(async () => 503, async () => { if (!storageUp) throw new Error('database is down'); });
    for (let i = 0; i < POLLED_UPDATE_MAX_ATTEMPTS + 3; i++) expect(await advances(handle)).toBe(false);
    expect(deps.notifySender).not.toHaveBeenCalled();

    storageUp = true;
    expect(await advances(handle)).toBe(true);
    expect(deps.notifySender).toHaveBeenCalledTimes(1);
  });

  it('delivers normally if intake recovers before the last attempt', async () => {
    let calls = 0;
    const { deps, handle } = harness(async () => (++calls < 3 ? 503 : 201));
    expect(await advances(handle)).toBe(false);
    expect(await advances(handle)).toBe(false);
    expect(await advances(handle)).toBe(true);
    expect(deps.park).not.toHaveBeenCalled();
  });

  it('a sender who cannot be reached does not block the queue once the update is parked', async () => {
    const deps = { deliver: vi.fn(async () => 500), park: vi.fn(async () => {}), notifySender: vi.fn(async () => { throw new Error('bot was blocked'); }), log: quiet, maxAttempts: 1 };
    await expect(createPolledUpdateHandler(deps)(update)).resolves.toBeUndefined();
    expect(deps.park).toHaveBeenCalledTimes(1);
  });

  it('counts attempts per update', async () => {
    const { deps, handle } = harness(async () => 500);
    const other = { ...update, update_id: 4243 };
    for (let i = 1; i < POLLED_UPDATE_MAX_ATTEMPTS; i++) await handle(update).catch(() => {});
    await expect(handle(other)).rejects.toThrow(/attempt 1\//);
    expect(deps.park).not.toHaveBeenCalled();
  });
});

import { afterAll } from 'vitest';
import { createDb, withRlsContext, sql } from '@hawa/db';
import { parkTelegramUpdate } from '../src/services/polled-update-dispatch.js';

describe('parkTelegramUpdate: the parked update is a durable row an operator can read', () => {
  const db = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(async () => { await db.destroy(); });
  const identity = { tenantId: '00000000-0000-4000-a000-000000000001', userId: '00000000-0000-4000-b000-000000000001' };
  const rows = (updateId: number) =>
    withRlsContext(db, { ...identity, role: 'operator' }, async (trx) =>
      (await sql<any>`SELECT event_kind, processing_error, payload, verified FROM hawa.inbox_events
        WHERE source_account_id = 'telegram' AND source_event_id = ${'parked-update-' + updateId}`.execute(trx)).rows);

  it('writes the update with the reason, under the same RLS identity production uses, and only once', async () => {
    const parked = { update_id: 900_000_000 + Math.floor(Math.random() * 1e8), message: { chat: { id: 77 }, text: 'بانگهێشتنامەی کۆنفرانس' } };
    await parkTelegramUpdate(db, identity, parked, 'intake answered HTTP 500 after 5 attempts');
    await parkTelegramUpdate(db, identity, parked, 'a second pass after a restart');

    const found = await rows(parked.update_id);
    expect(found).toHaveLength(1);
    expect(found[0].event_kind).toBe('telegram_update_parked');
    expect(found[0].processing_error).toBe('intake answered HTTP 500 after 5 attempts');
    expect(found[0].payload.message.text).toBe(parked.message.text);
    expect(found[0].verified).toBe(true);
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
