import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, OutboxRepository, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { OutboxConsumer, type OutboxCommandRecord } from '../src/outbox-consumer.js';
import type { TaskWorkflowDispatcher, WorkflowSubmissionReceipt } from '../src/workflow-dispatcher.js';

/**
 * A request the Restate lifecycle owns is designed by its DesignRun (slice 2.3; PHASE2_DESIGN.md 3,
 * "Replaces for lifecycle-owned requests"). Its task.created row is recorded, never pending; if one
 * is pending all the same, the outbox refuses it for good instead of starting a TaskWorkflow, and the
 * requester is not told that the request failed.
 */
const tenantId = '00000000-0000-4000-a000-000000000006';
const adminUserId = '00000000-0000-4000-b000-000000000006';

describe('the outbox and lifecycle-owned requests', () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = createDb(process.env.TEST_DATABASE_URL!);
    await withRlsContext(db, { tenantId, userId: adminUserId, role: 'administrator' }, (trx) => trx.deleteFrom('outbox_commands').where('tenant_id', '=', tenantId).execute());
  });
  afterEach(async () => { await db?.destroy(); });

  it('refuses task.created and task.dispatch of a lifecycle-owned task, dispatches the others', async () => {
    const repo = new OutboxRepository(db);
    const owned = randomUUID();
    const legacy = randomUUID();
    await withRlsContext(db, { tenantId, userId: adminUserId, role: 'administrator' }, async (trx) => {
      for (const [taskId, commandType, lifecycleOwner] of [[owned, 'task.created', 'restate'], [owned, 'task.dispatch', 'restate'], [legacy, 'task.dispatch', undefined]] as const) {
        await repo.enqueue({
          tenantId, aggregateType: 'task', aggregateId: taskId, commandType, idempotencyKey: `guard-${commandType}-${taskId}`,
          payload: { workflow: 'canva', autoGenerate: true, sourcePlatform: 'telegram', ...(lifecycleOwner ? { lifecycleOwner } : {}) },
        }, trx);
      }
    });
    const dispatched: string[] = [];
    const dispatcher = {
      dispatch: async (cmd: OutboxCommandRecord): Promise<WorkflowSubmissionReceipt> => {
        dispatched.push(`${cmd.command_type}:${cmd.aggregate_id}`);
        return { workflowId: `task-wf-${cmd.aggregate_id}`, aggregateId: cmd.aggregate_id, status: 'submitted', idempotencyKey: cmd.idempotency_key, submittedAt: new Date().toISOString(), receiptId: 'inv_test' };
      },
    } as unknown as TaskWorkflowDispatcher;
    const consumer = new OutboxConsumer(db, { tenantId, userId: adminUserId, batchSize: 10, dispatcher });
    await consumer.processBatch(10);

    expect(dispatched).toEqual([`task.dispatch:${legacy}`]);
    const rows = await withRlsContext(db, { tenantId, userId: adminUserId, role: 'administrator' }, (trx) =>
      trx.selectFrom('outbox_commands').select(['aggregate_id', 'command_type', 'state', 'last_error']).where('tenant_id', '=', tenantId).execute());
    const ownedRows = rows.filter((r) => r.aggregate_id === owned);
    expect(ownedRows.map((r) => r.state).sort()).toEqual(['failed', 'failed']);
    expect(ownedRows.every((r) => String(r.last_error).includes('OWNED_BY_LIFECYCLE'))).toBe(true);
    expect(rows.find((r) => r.aggregate_id === legacy)?.state).toBe('delivered');
  });
});
