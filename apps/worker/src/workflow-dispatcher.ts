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
import { chaosPoint } from '@hawa/observability';
import { TaskWorkflowRunner, type WorkflowInput, type WorkflowOutput } from './workflow.js';
import { DurableStepJournal } from './durable-context.js';
import type { OutboxCommandRecord } from './outbox-consumer.js';
import { requestIdHeaders } from './logging.js';

/**
 * What a design run needs from the request's `task.created` payload: the fields the dispatcher sends
 * TaskWorkflow, which DesignRun (slice 2.3) reads from the same recorded row, so the two start a run
 * of one request alike.
 */
export function designRunFieldsOf(payload: Record<string, unknown> | null | undefined): Pick<WorkflowInput, 'rawText' | 'canvaAutoGenerate' | 'canvaVariant' | 'designStudio' | 'studioOptions' | 'sourcePlatform' | 'clientId'> {
  const p = (payload ?? {}) as Partial<Record<'rawRequestText' | 'rawText' | 'title' | 'sourcePlatform' | 'clientId' | 'workflow', string>> & {
    autoGenerate?: unknown; designStudio?: unknown; variant?: WorkflowInput['canvaVariant']; studioOptions?: WorkflowInput['studioOptions'];
  };
  return {
    rawText: p.rawRequestText || p.rawText || p.title || '',
    canvaAutoGenerate: p.workflow === 'canva' && p.autoGenerate === true,
    canvaVariant: p.variant,
    designStudio: p.designStudio === true,
    studioOptions: p.studioOptions,
    sourcePlatform: p.sourcePlatform || 'inbox',
    clientId: p.clientId,
  };
}

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
   *
   * The outbox calls this with no transaction open (the submission is a network call of up to 10 s),
   * and `trx` is unused: never pass one. A command reclaimed after a consumer stopped mid-dispatch is
   * submitted again under the same workflow key, which Restate answers with 409, so no run starts
   * twice. The command reaches here without the request's pictures (OutboxRepository.claimDue): the
   * studio reads them from the task's own event, so they no longer ride into Restate's journal.
   */
  async dispatch(
    cmd: OutboxCommandRecord,
    trx?: Kysely<Database>
  ): Promise<WorkflowSubmissionReceipt> {
    // A Restate workflow runs once per key. A re-drive (Core enqueues `task.dispatch` with
    // redriveAttempt) is a new run of the same task, so it gets its own key; the first run's key
    // would answer 409 and nothing would run.
    const redriveAttempt = Number.isInteger(cmd.payload?.redriveAttempt) && cmd.payload.redriveAttempt > 0
      ? Number(cmd.payload.redriveAttempt)
      : undefined;
    const workflowId = `task-wf-${cmd.aggregate_id}${redriveAttempt ? `-redrive-${redriveAttempt}` : ''}`;
    const idempotencyKey = cmd.idempotency_key;
    // Every Telegram intake path that saves a task without an automatic draft tells the requester so
    // in its acknowledgement (daily cap, no client, instruction only, reference image). The worker
    // still reports the outcome for the task's state; this keeps Core from sending a second message.
    const requesterToldAtIntake = cmd.payload?.autoGenerate !== true;
    // The request that wrote the command, also in the input for a handler whose headers lack it.
    const requestId = typeof cmd.payload?.requestId === 'string' ? cmd.payload.requestId : undefined;

    // 1. Idempotency / Duplicate-Dispatch Check:
    // If already dispatched in this runtime session with confirmed receipt, return immediately.
    if (this.inFlightSubmissions.has(idempotencyKey)) {
      const existing = this.inFlightSubmissions.get(idempotencyKey)!;
      return {
        ...existing,
        reconciled: true,
      };
    }

    // Task state is not a Restate submission receipt. Reconcile using the stable
    // workflow identity and the engine's real invocation ID below.
    // 3. Submission to Restate Ingress endpoint if configured
    if (this.options.restateIngressUrl) {
      const url = `${this.options.restateIngressUrl}/TaskWorkflow/${workflowId}/run/send`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Restate workflows are idempotent by their workflow key; this
            // endpoint rejects an additional idempotency-key header.
            // Restate hands the invocation the headers it was started with: the handler logs under
            // the request id Core wrote with the command (logging.ts).
            ...requestIdHeaders(),
          },
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            taskId: cmd.aggregate_id,
            tenantId: cmd.tenant_id,
            ...designRunFieldsOf(cmd.payload),
            idempotencyKey,
            ...(redriveAttempt ? { redriveAttempt } : {}),
            requesterToldAtIntake,
            ...(requestId ? { requestId } : {}),
          }),
        });

        // The chaos suite kills the worker here: the workflow has started, the outbox command is not done.
        if (res.ok || res.status === 409) await chaosPoint('worker.dispatch.after-submit', { workflowId, taskId: cmd.aggregate_id });

        if (res.status === 409) {
          const receipt: WorkflowSubmissionReceipt = {
            workflowId,
            aggregateId: cmd.aggregate_id,
            status: 'submitted',
            idempotencyKey,
            submittedAt: new Date().toISOString(),
            receiptId: `inv_conflict_reconciled_${cmd.aggregate_id.slice(0, 8)}`,
            reconciled: true,
          };
          this.inFlightSubmissions.set(idempotencyKey, receipt);
          return receipt;
        }

        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
          throw new Error(`Restate ingress rejected submission: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
        }

        const accepted=await res.json().catch(()=>({})) as any;
        const invocationId=accepted.invocationId||res.headers.get('x-restate-id');
        if(!/^inv_[A-Za-z0-9_-]+$/.test(invocationId||''))throw new Error('Restate did not return an invocation receipt');
        const receipt: WorkflowSubmissionReceipt = {
          workflowId,
          aggregateId: cmd.aggregate_id,
          status: 'submitted',
          idempotencyKey,
          submittedAt: new Date().toISOString(),
          receiptId: invocationId,
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
      rawText: cmd.payload?.rawRequestText || cmd.payload?.rawText || cmd.payload?.title || '',
      canvaAutoGenerate: cmd.payload?.workflow==='canva' && cmd.payload?.autoGenerate===true,
      canvaVariant: cmd.payload?.variant,
      designStudio: cmd.payload?.designStudio === true,
      studioOptions: cmd.payload?.studioOptions,
      sourcePlatform: cmd.payload?.sourcePlatform || 'inbox',
      idempotencyKey,
      ...(redriveAttempt ? { redriveAttempt } : {}),
      requesterToldAtIntake,
      ...(requestId ? { requestId } : {}),
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
