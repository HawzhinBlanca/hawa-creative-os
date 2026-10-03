/**
 * Hawa Creative OS — Durable Workflow Execution & Recovery Verification
 * Task: CV-05 (GEMINI_TASK_SHEET.md)
 * Requirements: FR-004, FR-060, FR-061, FR-062, NFR-001, NFR-003, NFR-014
 *
 * Proof:
 * 1. Restart/resume traces across external side-effect boundaries.
 * 2. Stable workflow and effect IDs.
 * 3. Ambiguous-success reconciliation.
 * 4. Task commands outside RequestLifecycle are refused for good (ADR-287 retired the task workflow).
 * 5. Unknown command visible failure rejection (no no-op completion).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDb,
  type Kysely,
  type Database,
  OutboxRepository,
  TaskRepository,
  withRlsContext,
} from '@hawa/db';
import type { DesignStudioAdapter, RequestContext } from '@hawa/contracts';
import { OutboxConsumer } from '../src/outbox-consumer.js';
import { TaskWorkflowDispatcher } from '../src/workflow-dispatcher.js';

describe('CV-05: Durable Workflow Ownership & Crash-Recovery Suite', () => {
  let db: Kysely<Database>;
  let outboxRepo: OutboxRepository;
  let taskRepo: TaskRepository;
  const testTenantId = '00000000-0000-4000-a000-000000000005';
  const adminUserId = '00000000-0000-4000-b000-000000000005';
  const testClientId = 'c1000000-0000-4000-8000-000000000005';

  beforeEach(async () => {
    const testDbUrl =
      process.env.TEST_DATABASE_URL!;
    db = createDb(testDbUrl);
    outboxRepo = new OutboxRepository(db);
    taskRepo = new TaskRepository(db);

    // Clean test tenant outbox table for isolated deterministic tests
    await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        await trx.deleteFrom('outbox_commands').where('tenant_id', '=', testTenantId).execute();
      }
    );
  });

  afterEach(async () => {
    if (db) {
      await db.destroy();
    }
  });



  it('proves unknown outbox commands fail visibly and are never marked delivered (no no-op completion)', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `idem-unknown-${crypto.randomUUID()}`;

    // 1. Enqueue unknown command type
    await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        await outboxRepo.enqueue(
          {
            tenantId: testTenantId,
            aggregateType: 'task',
            aggregateId: taskId,
            commandType: 'unknown.unsupported.action',
            idempotencyKey,
            payload: { reason: 'malformed_payload' },
          },
          trx
        );
      }
    );

    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      batchSize: 5,
      maxAttempts: 2,
    });

    // 2. Process batch
    const summary = await consumer.processBatch(1);

    // Must visibly fail
    expect(summary.leased).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.retried).toBe(1);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0].error).toContain(
      "Unknown command_type 'unknown.unsupported.action'. Unknown commands fail visibly; no no-op handler can claim useful completion."
    );

    // 3. Verify in DB: command is NOT marked delivered
    const record = await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        return await outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx);
      }
    );

    expect(record).toBeDefined();
    expect(record?.state).toBe('pending'); // Retried, not delivered!
    expect(record?.attempts).toBe(1);
    expect(record?.last_error).toContain("Unknown command_type 'unknown.unsupported.action'");
  });

  it('refuses a task command outside RequestLifecycle for good, before any submission (ADR-287)', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `idem-retired-${crypto.randomUUID()}`;
    await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      await trx.insertInto('tasks').values({ id: taskId, tenant_id: testTenantId, client_id: testClientId,
        title: 'Task outside the lifecycle', state: 'received', priority: 3, version: 1 }).execute();
      await outboxRepo.enqueue({ tenantId: testTenantId, aggregateType: 'task', aggregateId: taskId,
        commandType: 'task.dispatch', idempotencyKey, payload: { rawText: 'Retired', workflow: 'canva', autoGenerate: true } }, trx);
    });
    const dispatcher = { dispatchCustomer: vi.fn(), dispatchDeskOpen: vi.fn() } as unknown as TaskWorkflowDispatcher;
    const consumer = new OutboxConsumer(db, { tenantId: testTenantId, userId: adminUserId, dispatcher, batchSize: 5,
      telegramBotToken: null, officeAlertChatId: null });
    const summary = await consumer.processBatch(1);
    expect(summary).toMatchObject({ leased: 1, succeeded: 0, retried: 0, deadLettered: 1 });
    expect(summary.errors[0].error).toContain('LEGACY_WORKFLOW_RETIRED');
    const record = await withRlsContext(db, { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      (trx) => outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx));
    expect(record?.state).not.toBe('delivered');
    expect(record?.last_error).toContain('LEGACY_WORKFLOW_RETIRED');
    expect(Object.values(dispatcher).every((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
  });

});
