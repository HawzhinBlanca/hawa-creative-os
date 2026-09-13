import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type Kysely, type Database, OutboxRepository, withRlsContext, sql } from '@hawa/db';
import { OutboxConsumer } from '../src/outbox-consumer.js';

describe('Worker: Durable Outbox Consumer', () => {
  let db: Kysely<Database>;
  let outboxRepo: OutboxRepository;
  const testTenantId = '00000000-0000-4000-a000-000000000006';
  const adminUserId = '00000000-0000-4000-b000-000000000006';

  beforeEach(async () => {
    const testDbUrl =
      process.env.TEST_DATABASE_URL!;
    db = createDb(testDbUrl);
    outboxRepo = new OutboxRepository(db);

    // Ensure clean state for test tenant so tests only lease their own outbox commands
    await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      await trx.deleteFrom('outbox_commands').where('tenant_id', '=', testTenantId).execute();
    });
  });

  afterEach(async () => {
    if (db) {
      await db.destroy();
    }
  });

  it('leases pending commands, executes handler, and marks delivered in PostgreSQL', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `test-outbox-${crypto.randomUUID()}`;

    // 1. Enqueue outbox command under RLS context
    await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      await outboxRepo.enqueue({
        tenantId: testTenantId,
        aggregateType: 'task',
        aggregateId: taskId,
        commandType: 'publish.drive',
        idempotencyKey,
        payload: { taskId, fileCount: 3 },
      }, trx);
    });

    let handledCommand: any = null;
    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      batchSize: 10,
      handlers: {
        'publish.drive': async (cmd) => {
          handledCommand = cmd;
        },
      },
    });

    // 2. Process batch
    const summary = await consumer.processBatch(5);

    expect(summary.leased).toBeGreaterThanOrEqual(1);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    expect(handledCommand).not.toBeNull();
    expect(handledCommand.aggregate_id).toBe(taskId);
    expect(handledCommand.command_type).toBe('publish.drive');

    // 3. Verify in DB that state is delivered under RLS
    const record = await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      return await outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx);
    });
    expect(record).toBeDefined();
    expect(record?.state).toBe('delivered');
    expect(record?.delivered_at).toBeDefined();
    expect(record?.leased_until).toBeNull();
  });

  it('retries failing commands with incremented attempt and backoff', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `test-fail-${crypto.randomUUID()}`;

    await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      await outboxRepo.enqueue({
        tenantId: testTenantId,
        aggregateType: 'task',
        aggregateId: taskId,
        commandType: 'test.failing',
        idempotencyKey,
        payload: { willFail: true },
      }, trx);
    });

    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      maxAttempts: 3,
      backoffBaseSeconds: 2,
      handlers: {
        'test.failing': async () => {
          throw new Error('Simulated external delivery timeout');
        },
      },
    });

    const summary = await consumer.processBatch(1);
    expect(summary.retried).toBeGreaterThanOrEqual(1);

    const record = await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      return await outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx);
    });
    expect(record).toBeDefined();
    expect(record?.state).toBe('pending');
    expect(record?.attempts).toBe(1);
    expect(record?.last_error).toContain('Simulated external delivery timeout');
    expect(record?.available_at).toBeDefined();
    expect(new Date(record!.available_at!).getTime()).toBeGreaterThan(Date.now());
    expect(record?.leased_until).toBeNull();
  });

  it('dead-letters commands when max attempts are exhausted', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `test-deadletter-${crypto.randomUUID()}`;

    await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      await outboxRepo.enqueue({
        tenantId: testTenantId,
        aggregateType: 'task',
        aggregateId: taskId,
        commandType: 'test.fatal',
        idempotencyKey,
        payload: { willFail: true },
      }, trx);
    });

    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      maxAttempts: 1, // Will exhaust on attempt 1
      handlers: {
        'test.fatal': async () => {
          throw new Error('Fatal unrecoverable error');
        },
      },
    });

    const summary = await consumer.processBatch(1);
    expect(summary.deadLettered).toBeGreaterThanOrEqual(1);

    const record = await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      return await outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx);
    });
    expect(record).toBeDefined();
    expect(record?.state).toBe('failed');
    expect(record?.attempts).toBe(1);
    expect(record?.last_error).toContain('Fatal unrecoverable error');
    expect(record?.leased_until).toBeNull();
  });

  it('isolates command failures so a SQL abort in one command does not rollback previous successful commands or prevent retry tracking', async () => {
    const task1Id = crypto.randomUUID();
    const task2Id = crypto.randomUUID();
    const key1 = `test-batch-success-${crypto.randomUUID()}`;
    const key2 = `test-batch-sqlerr-${crypto.randomUUID()}`;

    await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      await outboxRepo.enqueue({
        tenantId: testTenantId,
        aggregateType: 'task',
        aggregateId: task1Id,
        commandType: 'test.success_in_batch',
        idempotencyKey: key1,
        payload: { task1Id },
      }, trx);
      await outboxRepo.enqueue({
        tenantId: testTenantId,
        aggregateType: 'task',
        aggregateId: task2Id,
        commandType: 'test.sql_error_in_batch',
        idempotencyKey: key2,
        payload: { task2Id },
      }, trx);
    });

    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      batchSize: 10,
      handlers: {
        'test.success_in_batch': async () => {
          // Normal success
        },
        'test.sql_error_in_batch': async (_cmd, trx) => {
          // Trigger a raw SQL error that aborts the Postgres transaction
          await (sql`SELECT * FROM nonexistent_fatal_table_123`).execute(trx);
        },
      },
    });

    const summary = await consumer.processBatch(5);
    expect(summary.leased).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.retried).toBe(1);

    const rec1 = await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      return await outboxRepo.findByIdempotencyKey(testTenantId, key1, trx);
    });
    expect(rec1?.state).toBe('delivered');

    const rec2 = await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      return await outboxRepo.findByIdempotencyKey(testTenantId, key2, trx);
    });
    expect(rec2?.state).toBe('pending');
    expect(rec2?.attempts).toBe(1);
    expect(rec2?.last_error).toContain('nonexistent_fatal_table_123');
  });
});
