/**
 * Re-encrypt every stored Canva credential under a new CANVA_TOKEN_ENCRYPTION_KEY.
 *
 * Usage (owner connection; RLS must not hide rows of other tenants):
 *   DATABASE_URL=postgresql://<owner>:<password>@127.0.0.1:54332/hawa \
 *   CANVA_TOKEN_ENCRYPTION_KEY_OLD=<64 hex> CANVA_TOKEN_ENCRYPTION_KEY_NEW=<64 hex> \
 *     npx tsx apps/core/src/tools/rotate-canva-token-key.ts [--dry-run]
 *
 * Runs in one transaction: either every row is re-sealed or none is. After it commits, set
 * CANVA_TOKEN_ENCRYPTION_KEY=<new> for core and worker and restart them. Nothing is printed
 * except row counts; the keys and the decrypted tokens never leave memory.
 */
import { createDb, sql } from '@hawa/db';
import { CanvaTokenCipher } from '../services/canva-connect-service.js';

const url = process.env.DATABASE_URL;
const oldHex = process.env.CANVA_TOKEN_ENCRYPTION_KEY_OLD;
const newHex = process.env.CANVA_TOKEN_ENCRYPTION_KEY_NEW;
const dryRun = process.argv.includes('--dry-run');
if (!url || !oldHex || !newHex) {
  console.error('DATABASE_URL, CANVA_TOKEN_ENCRYPTION_KEY_OLD and CANVA_TOKEN_ENCRYPTION_KEY_NEW are required');
  process.exit(2);
}
if (oldHex === newHex) {
  console.error('The new key must differ from the old key');
  process.exit(2);
}
const OLD: string = oldHex, NEW: string = newHex, URL_: string = url;

class DryRunRollback extends Error {}

async function main() {
  const oldCipher = new CanvaTokenCipher(OLD);
  const newCipher = new CanvaTokenCipher(NEW);
  const db = createDb(URL_);
  let summary: Record<string, unknown> = {};
  try {
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '10s'`.execute(trx);
      const connections = await sql<{ tenant_id: string; actor_id: string; encrypted_tokens: string }>`
        SELECT tenant_id, actor_id, encrypted_tokens FROM hawa.canva_connections FOR UPDATE`.execute(trx);
      let resealed = 0;
      for (const row of connections.rows) {
        const aad = `${row.tenant_id}:${row.actor_id}`;
        const plain = oldCipher.open(row.encrypted_tokens, aad); // throws if the old key is wrong
        await sql`UPDATE hawa.canva_connections SET encrypted_tokens = ${newCipher.seal(plain, aad)}, updated_at = now()
          WHERE tenant_id = ${row.tenant_id}::uuid AND actor_id = ${row.actor_id}`.execute(trx);
        resealed++;
      }
      // Pending OAuth states cannot survive a key change; they expire within 10 minutes anyway.
      const states = await sql`DELETE FROM hawa.canva_oauth_states`.execute(trx);
      summary = { dryRun, connectionsResealed: resealed, oauthStatesDropped: Number(states.numAffectedRows ?? 0) };
      if (dryRun) throw new DryRunRollback('dry run');
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  } finally {
    await db.destroy().catch(() => {});
  }
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error('rotation failed; nothing was changed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
