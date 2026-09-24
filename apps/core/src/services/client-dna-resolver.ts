/**
 * A client's DNA as the office last saved it: Postgres first, this process's map only when there is
 * no database or it does not know the client. Moved from app.ts (architecture programme 1.3,
 * SPLIT_PLAN.md F4); delivery, tasks, clients and rubric routes all read DNA through it.
 */
import type { ClientDNA } from '@hawa/domain';
import type { Database, Kysely } from '@hawa/db';
import { loadActiveClientDna } from './client-dna-hydration.js';
import { DEFAULT_TENANT_ID, OPERATOR_USER_ID, type CoreContext } from '../core-context.js';
import { log } from '../logging.js';

export type ClientDnaResolver = (
  clientId: string | undefined | null,
  identity?: { tenantId?: string; userId?: string; role?: string },
  trx?: Kysely<Database>
) => Promise<ClientDNA | undefined>;

export function createClientDnaResolver({ db, clientDnas }: Pick<CoreContext, 'db' | 'clientDnas'>): ClientDnaResolver {
  /**
   * The client's DNA as the office last saved it. PostgreSQL answers first; the map (hydrated from
   * the database, seeded with fixtures only by tests, kept current by the routes that write) answers only when
   * there is no database, or when it does not know the client. The map is a cache, not a truth:
   * it is what let a saved Drive folder be ignored by delivery after a restart. Every route that
   * used to call clientDnas.get() goes through here.
   */
  const resolveClientDna = async (clientId: string | undefined | null, identity?: { tenantId?: string; userId?: string; role?: string }, trx?: Kysely<Database>): Promise<ClientDNA | undefined> => {
    if (!clientId) return undefined;
    if (db) {
      try {
        const fromDb = await loadActiveClientDna(db, { tenantId: identity?.tenantId || DEFAULT_TENANT_ID, userId: identity?.userId || OPERATOR_USER_ID, role: identity?.role }, clientId, trx);
        if (fromDb) return fromDb as unknown as ClientDNA;
      } catch (err) {
        log.warn('[core:client_dna] PostgreSQL read failed, answering from memory:', err instanceof Error ? err.message : err);
      }
    }
    return clientDnas.get(clientId);
  };

  return resolveClientDna;
}
