import { withRlsContext, type Kysely, type Database } from '@hawa/db';

/**
 * Loads every client's active DNA from PostgreSQL into the process-memory map Core still reads.
 *
 * The map is seeded from source-code fixtures at start-up, and the publish, QA and generation
 * paths read it (31 sites). The Desk writes edits to PostgreSQL, and GET reads PostgreSQL first, so
 * an operator could save a new Drive folder, see it in the UI, restart Core, and have deliveries
 * go to the fixture's folder again. Hydrating the map from the database after seeding makes the
 * database win wherever it holds a client. Keys are the client id and its code, which is how the
 * map is addressed today.
 *
 * Returns the number of clients loaded. Throws if the database could not be read, so the caller
 * decides whether to start on fixtures (development) or refuse (production).
 */
export async function hydrateClientDnaFromDb(
  db: Kysely<Database>,
  map: Map<string, unknown>,
  identity: { tenantId: string; userId: string }
): Promise<number> {
  const rows = await withRlsContext(db, { tenantId: identity.tenantId, userId: identity.userId, role: 'administrator' }, async (trx) =>
    trx
      .selectFrom('client_dna_versions as v')
      .innerJoin('clients as c', (join) => join.onRef('c.id', '=', 'v.client_id').onRef('c.tenant_id', '=', 'v.tenant_id'))
      .select(['v.client_id', 'v.dna', 'v.version', 'c.code'])
      .where('v.tenant_id', '=', identity.tenantId)
      .where('v.status', '=', 'active')
      .execute()
  );
  let loaded = 0;
  for (const row of rows) {
    const dna = typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna;
    if (!dna || typeof dna !== 'object') continue;
    map.set(String(row.client_id), dna);
    if (row.code) {
      map.set(String(row.code), dna);
      map.set(`client-${row.code}`, dna);
    }
    loaded++;
  }
  return loaded;
}
