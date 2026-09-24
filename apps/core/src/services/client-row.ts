/**
 * The Postgres id of a client named the three ways Core names one: its uuid, its code, or
 * `client-<code>`. hawa.clients is under row-level security, so the lookup runs inside a context:
 * outside one a code finds nothing, and the DNA routes used to carry on as if the client were not
 * in the database, keeping snapshots only in memory (architecture programme 1.3, SPLIT_PLAN G2).
 */
import { withRlsContext, type ClientRepository, type Database, type Kysely } from '@hawa/db';
import { isValidUuid } from '../core-helpers.js';

export async function findClientRowId(
  db: Kysely<Database>,
  clientRepo: ClientRepository,
  scope: { tenantId: string; userId: string; role: string },
  clientId: string
): Promise<string | undefined> {
  if (isValidUuid(clientId)) return clientId;
  // findByCode also tries the code without its `client-` prefix.
  return withRlsContext(db, scope, async (trx) => (await clientRepo.findByCode(scope.tenantId, clientId, trx))?.id);
}

/** A stored DNA version as the snapshot routes list it. */
export interface StoredDnaVersion {
  id: string;
  client_id: string;
  version: number;
  content_hash: string;
  status: string;
  created_by: string | null;
  created_at: Date | string | null;
  dna: unknown;
}

/**
 * A stored DNA version as a snapshot. The routes store the commit message and the acting person
 * inside the DNA, as `__commitMessage` and `__createdBy`: client_dna_versions has no column for the
 * message, and its created_by holds only a user uuid, not who acted (a Mini App or Desk session).
 */
export function snapshotFromRow(row: StoredDnaVersion) {
  const parsed = typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna;
  return {
    snapshotId: row.id,
    clientId: row.client_id,
    version: row.version,
    sha256: row.content_hash,
    commitMessage: parsed?.__commitMessage || `Version ${row.version} (${row.status})`,
    createdBy: parsed?.__createdBy || row.created_by || 'operator',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    dna: parsed,
  };
}
