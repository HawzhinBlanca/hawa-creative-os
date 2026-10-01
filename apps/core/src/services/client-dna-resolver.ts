/**
 * A client's authoritative active DNA: scoped PostgreSQL, or the map only without a database.
 * Moved from app.ts (architecture programme 1.3,
 * SPLIT_PLAN.md F4); delivery, tasks, clients and rubric routes all read DNA through it.
 */
import type { ClientDNA } from '@hawa/domain';
import type { Database, Kysely } from '@hawa/db';
import { loadActiveClientDna } from './client-dna-hydration.js';
import type { CoreContext } from '../core-context.js';

export class ClientDnaUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Current client DNA could not be verified; try again');
    this.name = 'ClientDnaUnavailableError';
    this.cause = cause;
  }
}

/** Database reads require explicit identity; requireDatabase is retained for caller compatibility. */
export type ClientDnaResolver = (
  clientId: string | undefined | null,
  identity?: { tenantId?: string; userId?: string; role?: string; requireDatabase?: boolean },
  trx?: Kysely<Database>
) => Promise<ClientDNA | undefined>;

export function createClientDnaResolver({ db, clientDnas }: Pick<CoreContext, 'db' | 'clientDnas'>): ClientDnaResolver {
  const resolveClientDna = async (clientId: string | undefined | null, identity?: { tenantId?: string; userId?: string; role?: string; requireDatabase?: boolean }, trx?: Kysely<Database>): Promise<ClientDNA | undefined> => {
    if (!clientId) return undefined;
    if (db) {
      if (!identity?.tenantId || !identity.userId || !identity.role) throw new ClientDnaUnavailableError();
      try {
        return await loadActiveClientDna(db, { tenantId: identity.tenantId, userId: identity.userId, role: identity.role }, clientId, trx) as unknown as ClientDNA | undefined;
      } catch (err) {
        throw new ClientDnaUnavailableError(err);
      }
    }
    return clientDnas.get(clientId);
  };

  return resolveClientDna;
}
