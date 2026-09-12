# Task CV-05 Evidence Dossier: Make One Durable Workflow Own the Whole Job

**Task:** CV-05  
**Requirements Covered:** FR-004, FR-060, FR-061, FR-062, NFR-001, NFR-003, NFR-014  
**Date:** 2026-09-11  
**Status:** VERIFIED  

---

## 1. Executive Summary

Task CV-05 establishes a single durable workflow to own the whole creative design lifecycle under the accepted Restate architecture (ADR-004) and eliminates unjournaled production execution and competing workflow engines.

All provider calls, knowledge retrieval, and studio activities execute as real durable activities wrapped in `ctx.run(...)` with deterministic, stable effect IDs. The outbox dispatcher (`OutboxConsumer` and `TaskWorkflowDispatcher`) now strictly requires confirmed workflow submission rather than a log line. Unregistered/unknown commands fail visibly with `UnknownCommandError` rather than being silently marked delivered by a no-op handler.

---

## 2. Key Architecture & Code Deliverables

1. **Durable Context & Journal Contract (`apps/worker/src/durable-context.ts`)**:
   - `WorkflowDurableContext`: Compatible with Restate's `restate.WorkflowContext` and `restate.Context`.
   - `DurableStepJournal`: Provides deterministic step memoization, chronological execution trace recording, crash simulation injection, and journal snapshot export/restore for restart/resume verification.

2. **Durable Activity Execution (`apps/worker/src/workflow.ts`)**:
   - Replaced raw unjournaled runner calls with `durableCtx.run(stableStepId, fn)` across all 9 lifecycle activities:
     - `task-routing:{taskId}`
     - `client-scope-lock:{taskId}`
     - `context-retrieval:{taskId}`
     - `brief-building:{taskId}`
     - `creative-planning:{taskId}`
     - `studio-composing:{taskId}` (high-cost external activity)
     - `qa-evaluation:{taskId}`
     - `persist-operational-records:{taskId}`
     - `await-approval-gate:{taskId}`
   - Synchronizes `TaskStateMachine` and `currentStatus` across step replays, ensuring deterministic replay behavior upon crash recovery.

3. **Confirmed Submission Dispatcher (`apps/worker/src/workflow-dispatcher.ts`)**:
   - `TaskWorkflowDispatcher`: Dispatches commands to Restate Ingress or embedded durable runner with confirmed submission receipts (`WorkflowSubmissionReceipt`).
   - Idempotency & Duplicate-Dispatch Protection: Caches in-flight/completed submissions and returns reconciled receipts without launching duplicate workflows.
   - Ambiguous-Success Reconciliation: Checks PostgreSQL state for existing progress if network dropped before outbox ack; reconciles safely without re-triggering side effects.

4. **Outbox Consumer Hardening (`apps/worker/src/outbox-consumer.ts`)**:
   - Handlers for `task.created` and `task.dispatch` require confirmed workflow submission.
   - Removed the no-op fallback handler (`() => console.warn('...marking delivered')`).
   - Unregistered command types fail visibly, recording `UnknownCommandError` in `last_error` and retrying/dead-lettering.

5. **Restate Worker Service & Workflow Context (`apps/worker/src/index.ts`)**:
   - Updated `TaskWorkflow` and `TaskService` handlers to pass the incoming Restate `WorkflowContext` / `Context` into `TaskWorkflowRunner.run(input, ctx)`.

---

## 3. Evidence Files

| Evidence File | Description | Invariants Proven |
|---|---|---|
| [`STABLE_WORKFLOW_EFFECT_IDS.json`](STABLE_WORKFLOW_EFFECT_IDS.json) | Registry of all 9 deterministic activity identifiers | FR-060, FR-062, NFR-001 |
| [`RESTART_RESUME_TRACES.json`](RESTART_RESUME_TRACES.json) | Chronological trace proving crash after studio compose does NOT repeat the external call on resume | Invariant #10, Invariant #12, FR-061, NFR-003 |
| [`AMBIGUOUS_SUCCESS_RECONCILIATION.json`](AMBIGUOUS_SUCCESS_RECONCILIATION.json) | Proof that unacknowledged outbox commands reconcile against existing DB state without re-triggering | FR-061, NFR-001, NFR-014 |
| [`DUPLICATE_DISPATCH_NEGATIVE_TESTS.json`](DUPLICATE_DISPATCH_NEGATIVE_TESTS.json) | Proof that re-dispatching with identical idempotency key avoids duplicate execution | FR-004, NFR-001 |
| [`TEST_RECEIPTS.json`](TEST_RECEIPTS.json) | Full test receipts (10/10 worker tests, 535/535 monorepo tests, zero DB pollution) | All |

---

## 4. Acceptance Criteria Verification

- [x] **Crash after each external success cannot silently repeat a costly effect**:
  - Proven by `durable-workflow-recovery.test.ts` (test 2): Injected crash after `studio-composing`. Upon resume, studio `create` and `apply` calls remained at exactly 1, replaying cached document metadata.
- [x] **Unknown commands fail visibly; no no-op handler can claim useful completion**:
  - Proven by `durable-workflow-recovery.test.ts` (test 3): Enqueuing `unknown.unsupported.action` throws `UnknownCommandError`, marks row failed/pending with error in `last_error`, never delivered.
- [x] **Outbox dispatcher requires confirmed submission, not a log line**:
  - Proven by `durable-workflow-recovery.test.ts` (test 4): Dispatcher confirms submission receipt before `markDelivered` commits.
- [x] **Ambiguous-success reconciliation**:
  - Proven by `durable-workflow-recovery.test.ts` (test 6): Unacknowledged outbox row with task in `human_review` reconciles without calling the runner.
- [x] **Duplicate dispatch protection**:
  - Proven by `durable-workflow-recovery.test.ts` (test 5): Dispatching same command twice results in exactly 1 runner execution.
- [x] **Production DB untouched**: Exactly 1,449 tasks, 1,449 outbox commands on PostgreSQL `hawa`.
