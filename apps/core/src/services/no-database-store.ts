/**
 * Where Core keeps tasks, their events and briefs, client DNA history and uploaded assets when it
 * runs without a database: development and the in-memory tests (architecture programme 1.3, the
 * cleanup step of SPLIT_PLAN.md section 7).
 *
 * With a database, Postgres is the only truth and each of these maps holds nothing: every read finds
 * nothing and every write is dropped. They used to be caches next to Postgres, read first by some
 * routes, so a restart or a second Core answered with a different task than the one that wrote it.
 * Holding nothing, a route that still names one cannot keep a second copy, not even by mistake.
 */
export function noDatabaseStore<V>(db: unknown): Map<string, V> {
  return db ? new HoldsNothing<V>() : new Map<string, V>();
}

class HoldsNothing<V> extends Map<string, V> {
  override set(): this {
    return this;
  }
}
