import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { Database } from '../src/types.js';

/** SQL compilation for service stubs; no database connections or simulated lock guarantees. */
export function createQueryOnlyDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: {
    createDriver: () => new DummyDriver(),
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: db => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  } });
}
