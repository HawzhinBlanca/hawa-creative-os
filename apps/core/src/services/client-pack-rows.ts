import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { SYSTEM_AUTOMATION_USER_ID } from '@hawa/contracts';
import type { ClientPack } from '@hawa/creative';
import { log } from '../logging.js';

/**
 * Every client pack names a hawa.clients row (ADR-038): tasks, DNA and publications point at it, so
 * a request routed to a new client needs the row before it can be saved. This inserts the rows that
 * are missing and changes nothing that exists: names, aliases and status are the office's to edit.
 * A row whose code is taken by another id is reported, not overwritten.
 */
export async function ensureClientPackRows(
  db: Kysely<Database>,
  tenantId: string,
  packs: ClientPack[]
): Promise<{ inserted: string[]; conflicts: string[] }> {
  const inserted: string[] = [];
  const conflicts: string[] = [];
  await withRlsContext(db, { tenantId, userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator' }, async (trx) => {
    for (const pack of packs) {
      const aliases = [...pack.routing.latinAliases, ...pack.routing.scriptAliases];
      const language = pack.languages[0] ?? 'en';
      const added = await sql<{ id: string }>`
        INSERT INTO hawa.clients (id, tenant_id, code, name, aliases, default_language, status)
        VALUES (${pack.id}::uuid, ${tenantId}::uuid, ${pack.code}, ${pack.displayName}, ${aliases}::text[], ${language}, 'active')
        ON CONFLICT DO NOTHING
        RETURNING id`.execute(trx);
      if (added.rows.length) {
        inserted.push(pack.code);
        continue;
      }
      const existing = await sql<{ id: string }>`
        SELECT id FROM hawa.clients WHERE tenant_id = ${tenantId}::uuid AND code = ${pack.code}`.execute(trx);
      if (existing.rows[0] && existing.rows[0].id !== pack.id) conflicts.push(`${pack.code} is row ${existing.rows[0].id}, the pack says ${pack.id}`);
    }
  });
  if (inserted.length) log.info(`[client-packs] Added client rows: ${inserted.join(', ')}`);
  for (const conflict of conflicts) log.error(`[client-packs] Client row conflict: ${conflict}. Requests routed to this pack cannot be saved until it is resolved.`);
  return { inserted, conflicts };
}
