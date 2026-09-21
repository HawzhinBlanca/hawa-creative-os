import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/client.js';
import { withSessionAdvisoryLock } from '../src/session-lock.js';

describe('withSessionAdvisoryLock: one holder at a time, across processes', () => {
  // Two handles are two pools: the closest a test gets to two Core processes.
  const processA = createDb(process.env.TEST_DATABASE_URL!);
  const processB = createDb(process.env.TEST_DATABASE_URL!);
  afterAll(async () => { await processA.destroy(); await processB.destroy(); });

  const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { open, wait }; };

  it('refuses a second holder while the first is working, without waiting', async () => {
    const key = `publish:test:${randomUUID()}`;
    const g = gate();
    const started = gate();
    const first = withSessionAdvisoryLock(processA, key, async () => { started.open(); await g.wait; return 'first'; });
    await started.wait;

    const t0 = Date.now();
    const second = await withSessionAdvisoryLock(processB, key, async () => 'second');
    expect(second).toEqual({ acquired: false });
    expect(Date.now() - t0).toBeLessThan(1000);

    g.open();
    expect(await first).toEqual({ acquired: true, value: 'first' });
  });

  it('frees the lock when the work finishes, and when it throws', async () => {
    const key = `publish:test:${randomUUID()}`;
    expect(await withSessionAdvisoryLock(processA, key, async () => 1)).toEqual({ acquired: true, value: 1 });
    await expect(withSessionAdvisoryLock(processA, key, async () => { throw new Error('upload failed'); })).rejects.toThrow('upload failed');
    expect(await withSessionAdvisoryLock(processB, key, async () => 2)).toEqual({ acquired: true, value: 2 });
  });

  it('lets different keys run together', async () => {
    const g = gate();
    const started = gate();
    const first = withSessionAdvisoryLock(processA, `publish:test:${randomUUID()}`, async () => { started.open(); await g.wait; });
    await started.wait;
    expect((await withSessionAdvisoryLock(processB, `publish:test:${randomUUID()}`, async () => 'other')).acquired).toBe(true);
    g.open();
    await first;
  });

  it('frees the lock when the holding process dies', async () => {
    const key = `publish:test:${randomUUID()}`;
    const doomed = createDb(process.env.TEST_DATABASE_URL!);
    const started = gate();
    const never = withSessionAdvisoryLock(doomed, key, async () => { started.open(); await new Promise(() => {}); });
    never.catch(() => undefined);
    await started.wait;
    expect((await withSessionAdvisoryLock(processB, key, async () => 'x')).acquired).toBe(false);

    // kill -9: the connections drop, nothing runs a finally block.
    await terminateBackendsHolding(processB, key);

    let acquired = false;
    for (let i = 0; i < 20 && !acquired; i++) {
      acquired = (await withSessionAdvisoryLock(processB, key, async () => 'after')).acquired;
      if (!acquired) await new Promise((r) => setTimeout(r, 100));
    }
    expect(acquired).toBe(true);
    // Not awaited: the doomed work never settles, so its pool would wait for it for ever.
    void doomed.destroy().catch(() => undefined);
  }, 20_000);
});

/** Ends the session that holds the advisory lock for `key`, as the server sees a killed client. */
async function terminateBackendsHolding(db: any, key: string) {
  const { sql } = await import('kysely');
  await sql`
    SELECT pg_terminate_backend(l.pid)
    FROM pg_locks l
    WHERE l.locktype = 'advisory' AND l.granted
      AND ((l.classid::bigint << 32) | l.objid::bigint) = (hashtextextended(${key}, 0) & x'FFFFFFFFFFFFFFFF'::bigint)
      AND l.pid <> pg_backend_pid()`.execute(db);
}
