/**
 * Hawa Creative OS — Durable Task Workflow Dispatcher
 * Requirements: FR-004, FR-060, FR-061, FR-062, NFR-001, NFR-003, NFR-014
 *
 * Dispatches outbox commands to the durable workflow engine (Restate or embedded durable runner)
 * requiring confirmed submission receipts, enforcing duplicate-dispatch idempotency,
 * and performing ambiguous-success reconciliation.
 */

import crypto from 'node:crypto';
import type { Database, Kysely } from '@hawa/db';
import { TaskWorkflowRunner, type WorkflowInput, type WorkflowOutput } from './workflow.js';
import { DurableStepJournal } from './durable-context.js';
import type { OutboxCommandRecord } from './outbox-consumer.js';

export interface WorkflowSubmissionReceipt {
  workflowId: string;
  aggregateId: string;
  status: 'submitted' | 'completed';
  idempotencyKey: string;
  submittedAt: string;
  receiptId: string;
  reconciled?: boolean;
}

export interface TaskWorkflowDispatcherOptions {
  restateIngressUrl?: string;
  runner?: TaskWorkflowRunner;
  db?: Kysely<Database>;
}

export class TaskWorkflowDispatcher {
  private readonly inFlightSubmissions = new Map<string, WorkflowSubmissionReceipt>();

  constructor(private readonly options: TaskWorkflowDispatcherOptions = {}) {}

  /**
   * Dispatches an outbox command to the durable workflow engine with confirmed submission.
   */
  async dispatch(
    cmd: OutboxCommandRecord,
    trx?: Kysely<Database>
  ): Promise<WorkflowSubmissionReceipt> {
    const workflowId = `task-wf-${cmd.aggregate_id}`;
    const idempotencyKey = cmd.idempotency_key;

    // 1. Idempotency / Duplicate-Dispatch Check:
    // If already dispatched in this runtime session with confirmed receipt, return immediately.
    if (this.inFlightSubmissions.has(idempotencyKey)) {
      const existing = this.inFlightSubmissions.get(idempotencyKey)!;
      return {
        ...existing,
        reconciled: true,
      };
    }

    // 2. Ambiguous-Success Reconciliation:
    // Check if task already progressed beyond initial intake in DB.
    const client = trx || this.options.db;
    if (client) {
      try {
        const existingTask = await client
          .selectFrom('tasks')
          .select(['id', 'state'])
          .where('id', '=', cmd.aggregate_id)
          .executeTakeFirst();

        if (
          existingTask &&
          existingTask.state !== 'received' &&
          existingTask.state !== 'promotion_pending'
        ) {
          const reconciledReceipt: WorkflowSubmissionReceipt = {
            workflowId,
            aggregateId: cmd.aggregate_id,
            status: 'submitted',
            idempotencyKey,
            submittedAt: new Date().toISOString(),
            receiptId: `rcpt_reconciled_${crypto.randomUUID().slice(0, 8)}`,
            reconciled: true,
          };
          this.inFlightSubmissions.set(idempotencyKey, reconciledReceipt);
          return reconciledReceipt;
        }
      } catch {
        // Table or connection query fallback
      }
    }

    // 3. Submission to Restate Ingress endpoint if configured
    if (this.options.restateIngressUrl) {
      const url = `${this.options.restateIngressUrl}/TaskWorkflow/${workflowId}/run/send`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            taskId: cmd.aggregate_id,
            tenantId: cmd.tenant_id,
            rawText: cmd.payload?.rawText || cmd.payload?.title || 'Creative Task',
            sourcePlatform: cmd.payload?.sourcePlatform || 'inbox',
            clientId: cmd.payload?.clientId,
            idempotencyKey,
          }),
        });

        if (!res.ok && res.status !== 409) {
          throw new Error(`Restate ingress rejected submission: ${res.status} ${res.statusText}`);
        }

        const receipt: WorkflowSubmissionReceipt = {
          workflowId,
          aggregateId: cmd.aggregate_id,
          status: 'submitted',
          idempotencyKey,
          submittedAt: new Date().toISOString(),
          receiptId: `rcpt_restate_${crypto.randomUUID().slice(0, 8)}`,
        };
        this.inFlightSubmissions.set(idempotencyKey, receipt);
        return receipt;
      } catch (err: any) {
        throw new Error(`Failed to submit task to Restate workflow: ${err.message}`);
      }
    }

    // 4. Embedded Durable Workflow Runner
    const runner = this.options.runner || new TaskWorkflowRunner({ db: this.options.db });
    const journal = new DurableStepJournal(workflowId);

    const input: WorkflowInput = {
      taskId: cmd.aggregate_id,
      tenantId: cmd.tenant_id,
      clientId: cmd.payload?.clientId,
      rawText: cmd.payload?.rawText || cmd.payload?.title || 'Creative Task',
      sourcePlatform: cmd.payload?.sourcePlatform || 'inbox',
      idempotencyKey,
    };

    const output: WorkflowOutput = await runner.run(input, journal);

    if (!output || !output.status) {
      throw new Error(`Workflow execution returned invalid output for task ${cmd.aggregate_id}`);
    }

    const receipt: WorkflowSubmissionReceipt = {
      workflowId,
      aggregateId: cmd.aggregate_id,
      status: 'completed',
      idempotencyKey,
      submittedAt: new Date().toISOString(),
      receiptId: `rcpt_embedded_${crypto.randomUUID().slice(0, 8)}`,
    };

    this.inFlightSubmissions.set(idempotencyKey, receipt);
    return receipt;
  }
}
