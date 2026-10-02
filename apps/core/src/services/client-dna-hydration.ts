import { withRlsContext, type Kysely, type Database } from '@hawa/db';

/**
 * Loads every client's active DNA from PostgreSQL into the process-memory map Core still reads.
 *
 * The map was seeded from source-code fixtures at start-up (only tests seed it now, through
 * CreateAppOptions.seedClientDna), and the publish, QA and generation paths read it (31 sites). The Desk writes edits to PostgreSQL, and GET reads PostgreSQL first, so
 * an operator could save a new Drive folder, see it in the UI, restart Core, and have deliveries
 * go to the fixture's folder again. Hydrating the map from the database after seeding makes the
 * database win wherever it holds a client. Keys are the client id and its code, which is how the
 * map is addressed today.
 *
 * Returns the number of clients loaded. Throws if the database could not be read, so the caller
 * decides whether to start without it (development) or refuse (production).
 */
export async function hydrateClientDnaFromDb(
  db: Kysely<Database>,
  map: Map<string, unknown>,
  identity: { tenantId: string; userId: string },
  options?: { dropUnknown?: boolean }
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
  const known = new Set<string>();
  let loaded = 0;
  for (const row of rows) {
    const dna = typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna;
    if (!dna || typeof dna !== 'object') continue;
    map.set(String(row.client_id), dna);
    known.add(String(row.client_id));
    if (row.code) {
      map.set(String(row.code), dna);
      map.set(`client-${row.code}`, dna);
      known.add(String(row.code));
      known.add(`client-${row.code}`);
    }
    loaded++;
  }
  // In production a client the database does not know is not a client. The seeds are development
  // fixtures (six invented offices); one of them once held the fallback destination for a delivery.
  if (options?.dropUnknown) {
    for (const key of [...map.keys()]) if (!known.has(key)) map.delete(key);
  }
  return loaded;
}

/**
 * The active DNA for a client, from PostgreSQL. `clientId` may be the client's uuid, its code, or
 * `client-<code>`, the three spellings Core uses. Undefined when the database does not know the
 * client. Throws when the database cannot answer: a caller that wants to fall back decides so.
 */
/**
 * Pass `trx` when already inside a transaction: the lookup then runs on that connection. Opening a
 * second connection inside an open transaction is how 100 concurrent task creates exhausted a pool
 * of 20, each holding one connection while waiting for another.
 */
export async function loadActiveClientDna(
  db: Kysely<Database>,
  identity: { tenantId: string; userId: string; role?: string },
  clientId: string,
  trx?: Kysely<Database>
): Promise<Record<string, unknown> | undefined> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
  const codes = isUuid ? [] : [clientId, clientId.replace(/^client-/, '')];
  const rls = { tenantId: identity.tenantId, userId: identity.userId, role: identity.role || 'administrator' };
  const lookup = async (trx: Kysely<Database>) => {
    let targetId: string | undefined = isUuid ? clientId : undefined;
    for (const code of codes) {
      if (targetId) break;
      const row = await trx.selectFrom('clients').select('id').where('tenant_id', '=', identity.tenantId).where('code', '=', code).executeTakeFirst();
      targetId = row?.id;
    }
    if (!targetId) return undefined;
    const row = await trx.selectFrom('client_dna_versions').select(['dna', 'client_id', 'tenant_id', 'version'])
      .where('tenant_id', '=', identity.tenantId).where('client_id', '=', targetId).where('status', '=', 'active').executeTakeFirst();
    if (!row?.dna) return undefined;
    const dna = typeof row.dna === 'string' ? JSON.parse(row.dna) : row.dna;
    return dna && typeof dna === 'object' ? { ...dna as Record<string, unknown>, clientId: row.client_id, tenantId: row.tenant_id, version: row.version } : undefined;
  };
  return trx ? lookup(trx) : withRlsContext(db, rls, lookup);
}
