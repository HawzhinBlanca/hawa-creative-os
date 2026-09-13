import { createDb } from '../packages/db/src/index.js';
import { OutboxConsumer } from '../apps/worker/src/outbox-consumer.js';

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL (or TEST_DATABASE_URL) is required; this script has no default database');

  const batchSize = Number(process.env.BATCH_SIZE || 100);
  const maxBatches = Number(process.env.MAX_BATCHES || 50);

  console.log(`[DrainOutbox] Connecting to database: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[DrainOutbox] Batch size: ${batchSize}, Max batches: ${maxBatches}`);

  const db = createDb(connectionString);
  try {
    const consumer = new OutboxConsumer(db, {
      batchSize,
      tenantId: '00000000-0000-4000-a000-000000000001',
      userId: '00000000-0000-4000-b000-000000000002',
    });

    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let batchCount = 0;

    while (batchCount < maxBatches) {
      batchCount++;
      const summary = await consumer.processBatch(batchSize);
      if (summary.leased === 0) {
        console.log(`[DrainOutbox] No more pending outbox commands to process.`);
        break;
      }

      totalProcessed += summary.leased;
      totalSucceeded += summary.succeeded;
      totalFailed += summary.deadLettered + summary.retried;

      console.log(
        `[DrainOutbox] Batch ${batchCount}: leased=${summary.leased}, succeeded=${summary.succeeded}, retried=${summary.retried}, deadLettered=${summary.deadLettered}`
      );
    }

    console.log('\n=== Outbox Drain Summary ===');
    console.log(`Total batches run:   ${batchCount}`);
    console.log(`Commands processed:  ${totalProcessed}`);
    console.log(`Commands succeeded:  ${totalSucceeded}`);
    console.log(`Commands retried/failed: ${totalFailed}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('[DrainOutbox] Fatal error:', err);
  process.exit(1);
});
