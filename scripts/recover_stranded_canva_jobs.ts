/**
 * scripts/recover_stranded_canva_jobs.ts
 *
 * Remediation for Item 3: Stranded Canva Imports Sweeper & Recovery Tool
 * Recovers, settles, or fails stranded Canva create & export operations,
 * specifically clearing CANVA_CREATE_CONFLICT blocks on tasks like KAAE.
 */
import { createDb, sql, withRlsContext } from '../packages/db/src/index.js';
import { CanvaConnectService } from '../apps/core/src/services/canva-connect-service.js';

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required; this script has no default database');

  const isDryRun = process.argv.includes('--dry-run');
  const tenantId = process.env.TENANT_ID || '00000000-0000-4000-a000-000000000001';
  const actorId = process.env.ACTOR_ID || '00000000-0000-4000-b000-000000000001';

  console.log(`[Canva Recovery] Connecting to database: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[Canva Recovery] Mode: ${isDryRun ? 'DRY RUN' : 'LIVE RECOVERY'}`);
  console.log(`[Canva Recovery] Tenant: ${tenantId}`);

  const db = createDb(connectionString);
  const options = {
    clientId: process.env.CANVA_CLIENT_ID,
    clientSecret: process.env.CANVA_CLIENT_SECRET,
    redirectUri: process.env.CANVA_REDIRECT_URI || 'http://127.0.0.1:8080/v1/integrations/canva/callback',
    encryptionKey: process.env.CANVA_TOKEN_ENCRYPTION_KEY,
  };

  const service = new CanvaConnectService(db, options);
  const scope = { tenantId, actorId, role: 'admin' };

  try {
    // 1. Query all non-terminal operations (create and export)
    const strandedOps = await withRlsContext(db, { tenantId, userId: actorId, role: 'admin' }, async (trx) => {
      return (await sql<any>`
        SELECT id, task_id, client_id, actor_id, request_key, kind, status, remote_job_id, design_id, created_at, updated_at
        FROM hawa.canva_remote_operations
        WHERE tenant_id = ${tenantId}::uuid
          AND status IN ('submitted', 'creating', 'uncertain')
        ORDER BY created_at ASC
      `.execute(trx)).rows;
    });

    console.log(`\nFound ${strandedOps.length} stranded Canva operation(s) across tenant.`);

    for (const op of strandedOps) {
      console.log(`\n--- Operation ${op.id} ---`);
      console.log(`Task ID:       ${op.task_id}`);
      console.log(`Kind:          ${op.kind}`);
      console.log(`Status:        ${op.status}`);
      console.log(`Remote Job ID: ${op.remote_job_id || 'NONE'}`);
      console.log(`Created At:    ${op.created_at}`);

      if (isDryRun) {
        console.log(`[DRY RUN] Would attempt recovery/settlement for operation ${op.id}`);
        continue;
      }

      if (op.kind === 'create') {
        try {
          console.log(`Attempting to resume/settle create import operation...`);
          const res = await service.resumeImport(scope, op.task_id, op.id);
          console.log(`Result: status=${res.status}, designId=${(res as any).designId || 'none'}, message=${(res as any).message || 'none'}`);
        } catch (err: any) {
          console.error(`Error settling create operation: ${err.message}`);
          console.log(`Marking operation ${op.id} as failed to unblock task...`);
          await withRlsContext(db, { tenantId, userId: actorId, role: 'admin' }, async (trx) => {
            await sql`
              UPDATE hawa.canva_remote_operations
              SET status = 'failed', updated_at = now()
              WHERE tenant_id = ${tenantId}::uuid AND id = ${op.id}::uuid
            `.execute(trx);
          });
          console.log(`Operation ${op.id} marked as failed.`);
        }
      } else if (op.kind === 'export') {
        try {
          console.log(`Attempting to check/settle export operation...`);
          const res = await service.exportStatus({ ...scope, actorId: op.actor_id }, op.task_id, op.id);
          console.log(`Result: status=${res.status}, message=${res.message || 'none'}`);
        } catch (err: any) {
          console.error(`Error settling export operation: ${err.message}`);
          console.log(`Marking operation ${op.id} as failed...`);
          await withRlsContext(db, { tenantId, userId: actorId, role: 'admin' }, async (trx) => {
            await sql`
              UPDATE hawa.canva_remote_operations
              SET status = 'failed', updated_at = now()
              WHERE tenant_id = ${tenantId}::uuid AND id = ${op.id}::uuid
            `.execute(trx);
          });
          console.log(`Operation ${op.id} marked as failed.`);
        }
      }
    }

    // Run sweepStrandedOperations as well to verify the service method
    if (!isDryRun) {
      console.log(`\nRunning service.sweepStrandedOperations...`);
      const sweepRes = await service.sweepStrandedOperations(scope, { maxAgeMinutes: 0, limit: 50 });
      console.log(`Sweeper scanned ${sweepRes.sweptCount} operation(s), settled ${sweepRes.settled.length}.`);
    }

    // Verify current status of target tasks
    const remainingStranded = await withRlsContext(db, { tenantId, userId: actorId, role: 'admin' }, async (trx) => {
      return (await sql<any>`
        SELECT id, task_id, kind, status, remote_job_id, design_id, updated_at
        FROM hawa.canva_remote_operations
        WHERE tenant_id = ${tenantId}::uuid
          AND status IN ('submitted', 'creating', 'uncertain')
      `.execute(trx)).rows;
    });

    console.log(`\nRemaining stranded non-terminal operations: ${remainingStranded.length}`);
    for (const r of remainingStranded) {
      console.log(`  - Op ${r.id}: Task ${r.task_id} (${r.kind}) -> ${r.status}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[Canva Recovery] Fatal error:', err);
  process.exit(1);
});
