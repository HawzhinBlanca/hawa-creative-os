import { FakeDesignStudioAdapter as SimulatedStudioFixture } from '../../../packages/testkit/src/fake-studio.js';
/**
 * Hawa Creative OS — Durable Workflow Execution & Recovery Verification
 * Task: CV-05 (GEMINI_TASK_SHEET.md)
 * Requirements: FR-004, FR-060, FR-061, FR-062, NFR-001, NFR-003, NFR-014
 *
 * Proof:
 * 1. Restart/resume traces across external side-effect boundaries.
 * 2. Stable workflow and effect IDs.
 * 3. Ambiguous-success reconciliation.
 * 4. Duplicate-dispatch negative tests.
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
import { TaskWorkflowRunner, type WorkflowInput } from '../src/workflow.js';
import { DurableStepJournal } from '../src/durable-context.js';
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
      process.env.TEST_DATABASE_URL ||
      'postgresql://hawa_app:hawa_app_secure_runtime_pass_2026@127.0.0.1:54332/hawa_test';
    db = createDb(testDbUrl);
    outboxRepo = new OutboxRepository(db);
    taskRepo = new TaskRepository(db);

    // Clean test tenant outbox table for isolated deterministic tests
    await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        await trx.deleteFrom('outbox_commands').where('tenant_id', '=', testTenantId).execute();
        await trx.deleteFrom('tasks').where('tenant_id', '=', testTenantId).execute();
      }
    );
  });

  afterEach(async () => {
    if (db) {
      await db.destroy();
    }
  });

  it('proves stable workflow and effect IDs across durable execution', async () => {
    const taskId = 'task-stable-id-1';
    const journal = new DurableStepJournal(`task-wf-${taskId}`);
    const runner = new TaskWorkflowRunner({ studio: new SimulatedStudioFixture() });

    const output = await runner.run(
      {
        taskId,
        tenantId: testTenantId,
        clientId: 'client-office-1',
        rawText: 'پۆستەری کەمپینی بەهارە بۆ کاک ئەحمەد',
        sourcePlatform: 'desk',
        idempotencyKey: 'idem-stable-1',
      },
      journal
    );

    expect(output.taskId).toBe(taskId);
    expect(output.status).toBe('AWAITING_APPROVAL');
    expect(journal.key).toBe(`task-wf-${taskId}`);

    // Verify all deterministic stable step names are present in journal
    expect(journal.hasStep(`task-routing:${taskId}`)).toBe(true);
    expect(journal.hasStep(`client-scope-lock:${taskId}`)).toBe(true);
    expect(journal.hasStep(`context-retrieval:${taskId}`)).toBe(true);
    expect(journal.hasStep(`brief-building:${taskId}`)).toBe(true);
    expect(journal.hasStep(`creative-planning:${taskId}`)).toBe(true);
    expect(journal.hasStep(`studio-composing:${taskId}`)).toBe(true);
    expect(journal.hasStep(`qa-evaluation:${taskId}`)).toBe(true);
    expect(journal.hasStep(`await-approval-gate:${taskId}`)).toBe(true);

    const trace = journal.getExecutionTrace();
    expect(trace).toContain(`invoked:studio-composing:${taskId}`);
    expect(trace).toContain(`completed:studio-composing:${taskId}`);
  });

  it('proves crash after expensive external studio compose does NOT repeat the effect on resume (Invariant #10 & #12)', async () => {
    const taskId = 'task-crash-studio-2';
    const initialJournal = new DurableStepJournal(`task-wf-${taskId}`);

    // Mock design studio adapter to track exact calls
    let studioCreateCalls = 0;
    let studioApplyCalls = 0;

    const mockStudio: DesignStudioAdapter = {
      name: 'MockStudio',
      create: async (ctx: RequestContext, spec: any) => {
        studioCreateCalls++;
        return {
          ok: true,
          value: {
            documentId: 'doc_live_canva_101',
            sourceSha256: 'sha256_mock_canva_source_101',
            editUrl: 'https://canva.com/design/DAGMock101/edit',
          } as any,
        };
      },
      apply: async (ctx: RequestContext, batch: any) => {
        studioApplyCalls++;
        return {
          ok: true,
          value: {
            documentId: 'doc_live_canva_101',
            sourceSha256: 'sha256_mock_canva_source_101_updated',
            editUrl: 'https://canva.com/design/DAGMock101/edit',
          } as any,
        };
      },
      getManifest: async (ctx: RequestContext, docRef: any) => {
        return {
          ok: true,
          value: {
            documentId: docRef.documentId,
            pages: [{ id: 'p1', width: 1080, height: 1080, elements: [] }],
            nodes: [],
          } as any,
        };
      },
      render: async () => ({ ok: true, value: { renders: [] } as any }),
      exportPdfPrint: async () => ({ ok: true, value: { exportUrl: 'https://cdn.example.com/p.pdf' } as any }),
    };

    const runner = new TaskWorkflowRunner({ studio: mockStudio });

    // Step A: Configure simulated process crash right after studio-composing step completes
    // In Restate, a step persisted to journal is durable before next step starts.
    // Here we let studio-composing complete and persist, but crash before qa-evaluation executes.
    initialJournal.setCrashBefore(`qa-evaluation:${taskId}`);

    // Attempt 1: Worker executes up to studio-composing, then crashes before QA
    await expect(
      runner.run(
        {
          taskId,
          tenantId: testTenantId,
          clientId: 'client-office-1',
          rawText: 'داشکاندنی بەهارە بۆ نەورۆز',
          sourcePlatform: 'telegram',
          idempotencyKey: 'idem-crash-studio-1',
        },
        initialJournal
      )
    ).rejects.toThrow(`[CRASH_SIMULATION] Process crashed before step 'qa-evaluation:${taskId}'`);

    expect(studioCreateCalls).toBe(1);
    expect(studioApplyCalls).toBe(1);

    // Save journal state from crash
    const snapshot = initialJournal.getJournalSnapshot();
    expect(snapshot[`studio-composing:${taskId}`]).toBeDefined();

    // Attempt 2: Worker restarts / recovers and resumes with preserved journal
    const recoveredJournal = new DurableStepJournal(`task-wf-${taskId}`, snapshot);

    const recoveredOutput = await runner.run(
      {
        taskId,
        tenantId: testTenantId,
        clientId: 'client-office-1',
        rawText: 'داشکاندنی بەهارە بۆ نەورۆز',
        sourcePlatform: 'telegram',
        idempotencyKey: 'idem-crash-studio-1',
      },
      recoveredJournal
    );

    // Verification of zero duplication:
    // Studio create and apply MUST NOT have been called again!
    expect(studioCreateCalls).toBe(1); // Still 1! NOT 2!
    expect(studioApplyCalls).toBe(1); // Still 1! NOT 2!
    expect(recoveredOutput.status).toBe('AWAITING_APPROVAL');
    expect(recoveredOutput.documentId).toBe('doc_live_canva_101');
    expect(recoveredOutput.replayedSteps).toContain(`studio-composing:${taskId}`);
    expect(recoveredOutput.executedSteps).toContain(`qa-evaluation:${taskId}`);

    const trace = recoveredJournal.getExecutionTrace();
    expect(trace).toContain(`replayed:studio-composing:${taskId}`);
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

  it('proves outbox dispatcher requires confirmed submission and marks delivered only upon receipt', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `idem-confirmed-${crypto.randomUUID()}`;

    // 1. Enqueue real task.dispatch command
    await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        await outboxRepo.enqueue(
          {
            tenantId: testTenantId,
            aggregateType: 'task',
            aggregateId: taskId,
            commandType: 'task.dispatch',
            idempotencyKey,
            payload: {
              rawText: 'دیزاینی پۆست بۆ کۆمپانیا',
              clientId: 'client-office-1',
              sourcePlatform: 'desk',
            },
          },
          trx
        );
      }
    );

    let dispatchCalled = false;
    let confirmedWorkflowId = '';

    const dispatcher = new TaskWorkflowDispatcher({
      runner: {
        run: async (input: WorkflowInput) => {
          dispatchCalled = true;
          return {
            taskId: input.taskId,
            status: 'AWAITING_APPROVAL',
            briefId: 'brief_mock_1',
            documentId: 'doc_mock_1',
            qcPassed: true,
            auditEventsCount: 5,
            executedSteps: ['step1'],
            replayedSteps: [],
          };
        },
      } as any,
    });

    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      dispatcher,
      batchSize: 5,
    });

    // 2. Process batch
    const summary = await consumer.processBatch(1);

    expect(dispatchCalled).toBe(true);
    expect(summary.leased).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.errors.length).toBe(0);

    // 3. Verify in PostgreSQL: marked delivered with timestamp
    const record = await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        return await outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx);
      }
    );

    expect(record).toBeDefined();
    expect(record?.state).toBe('delivered');
    expect(record?.delivered_at).toBeDefined();
  });

  it('proves duplicate-dispatch negative protection: re-dispatching same command returns existing receipt without re-running', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `idem-dup-${crypto.randomUUID()}`;

    let executionCount = 0;
    const dispatcher = new TaskWorkflowDispatcher({
      runner: {
        run: async (input: WorkflowInput) => {
          executionCount++;
          return {
            taskId: input.taskId,
            status: 'AWAITING_APPROVAL',
            qcPassed: true,
            auditEventsCount: 4,
            executedSteps: ['compose'],
            replayedSteps: [],
          };
        },
      } as any,
    });

    const cmd: any = {
      id: crypto.randomUUID(),
      tenant_id: testTenantId,
      aggregate_type: 'task',
      aggregate_id: taskId,
      command_type: 'task.dispatch',
      idempotency_key: idempotencyKey,
      payload: { rawText: 'Duplicate test' },
    };

    // First dispatch
    const receipt1 = await dispatcher.dispatch(cmd);
    expect(receipt1.status).toBe('completed');
    expect(receipt1.workflowId).toBe(`task-wf-${taskId}`);
    expect(receipt1.reconciled).toBeFalsy();
    expect(executionCount).toBe(1);

    // Duplicate dispatch with same idempotency key
    const receipt2 = await dispatcher.dispatch(cmd);
    expect(receipt2.workflowId).toBe(receipt1.workflowId);
    expect(receipt2.status).toBe('completed');
    expect(receipt2.reconciled).toBe(true); // Reconciled without re-executing!
    expect(executionCount).toBe(1); // Still 1! Proves zero duplicate execution!
  });

  it('does not treat a progressed task as proof of workflow submission', async () => {
    const taskId = crypto.randomUUID();
    const idempotencyKey = `idem-ambig-${crypto.randomUUID()}`;

    // 1. Create task in PostgreSQL in 'human_review' state (simulating that the workflow already ran
    // and transitioned the task, but connection dropped before outbox record was marked delivered)
    await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        await trx
          .insertInto('tasks')
          .values({
            id: taskId,
            tenant_id: testTenantId,
            client_id: testClientId,
            title: 'Ambiguous Success Task',
            state: 'human_review',
            priority: 3,
            version: 2,
          })
          .execute();

        await outboxRepo.enqueue(
          {
            tenantId: testTenantId,
            aggregateType: 'task',
            aggregateId: taskId,
            commandType: 'task.dispatch',
            idempotencyKey,
            payload: { rawText: 'Ambiguous test' },
          },
          trx
        );
      }
    );

    let runnerCalled = false;
    const dispatcher = new TaskWorkflowDispatcher({
      db,
      runner: {
        run: async () => {
          runnerCalled = true;
          return {} as any;
        },
      } as any,
    });

    const consumer = new OutboxConsumer(db, {
      tenantId: testTenantId,
      userId: adminUserId,
      dispatcher,
      batchSize: 5,
    });

    // 2. The runner must supply evidence; task state alone cannot acknowledge delivery.
    const summary = await consumer.processBatch(1);

    expect(runnerCalled).toBe(true);
    expect(summary.succeeded).toBe(0);
    expect(summary.retried).toBe(1);

    // 3. Verify in PostgreSQL that outbox row was safely reconciled and marked delivered
    const record = await withRlsContext(
      db,
      { tenantId: testTenantId, userId: adminUserId, role: 'administrator' },
      async (trx) => {
        return await outboxRepo.findByIdempotencyKey(testTenantId, idempotencyKey, trx);
      }
    );

    expect(record).toBeDefined();
    expect(record?.state).toBe('pending');
  });
});
