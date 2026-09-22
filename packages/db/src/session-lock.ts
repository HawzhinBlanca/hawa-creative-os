import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';

export type SessionLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Runs `fn` while holding a PostgreSQL session advisory lock on `key`, or reports that someone else
 * holds it. It never waits.
 *
 * This is for work that must not run twice at once and cannot sit inside a transaction: an upload
 * to a client's Drive folder takes seconds to minutes, and a transaction held open across it pins
 * row locks and a snapshot for that long. A session lock pins only one pooled connection.
 *
 * The lock belongs to the database session, so a process that is killed mid-work releases it when
 * its connection drops. There is no lease to expire and no stale row to clean up, which is why this
 * is not a claim column on the publication row.
 *
 * The key is hashed with hashtextextended, as the intake and planner locks are, so callers pass a
 * readable string such as `publish:<tenant>:<task>`.
 */
export async function withSessionAdvisoryLock<T>(
  db: Kysely<Database>,
  key: string,
  fn: () => Promise<T>
): Promise<SessionLockResult<T>> {
  return await db.connection().execute(async (conn) => {
    const got = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`.execute(conn);
    if (!got.rows[0]?.locked) return { acquired: false } as const;
    try {
      return { acquired: true, value: await fn() } as const;
    } finally {
      // If the unlock itself fails the connection is broken, and a broken session holds no locks.
      await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(conn).catch(() => undefined);
    }
  });
}
