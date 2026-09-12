import { createDb, reconcileTasksFromEvents } from '../packages/db/src/index.js';

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';

  const isDryRun = process.argv.includes('--dry-run');

  console.log(`[Reconcile] Connecting to database: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[Reconcile] Mode: ${isDryRun ? 'DRY RUN (no mutations)' : 'LIVE MUTATION'}`);

  const db = createDb(connectionString);
  try {
    const result = await reconcileTasksFromEvents(db, undefined, isDryRun);
    console.log('\n=== Task State Reconciliation Summary ===');
    console.log(`Total tasks scanned:    ${result.totalScanned}`);
    console.log(`State divergences:      ${result.divergedCount}`);
    console.log(`Tasks reconciled:       ${result.reconciledCount}`);

    if (result.details.length > 0) {
      console.log('\nDivergence Details (first 10):');
      for (const d of result.details.slice(0, 10)) {
        console.log(`  - Task ${d.taskId}: ${d.previousState} -> ${d.inferredState} (${d.reason})`);
      }
      if (result.details.length > 10) {
        console.log(`  ... and ${result.details.length - 10} more`);
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[Reconcile] Fatal error:', err);
  process.exit(1);
});
