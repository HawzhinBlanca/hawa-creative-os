# Proof Dossier: Task R07 — Close Durable Workflow Through Terminal State & Notification

**Date:** 2026-09-19  
**Status:** QUALIFIED / PROVED  
**Normative Standards:** ADR-015, ADR-025, ADR-038, FR-051–053, FR-081–082, NFR-001, NFR-014  
**Test Evidence:**  
- `apps/core/test/r07-outbox-terminal-state.test.ts` (6/6 passed)  
- `apps/worker/test/outbox-consumer.test.ts` (4/4 passed)  
- `apps/worker/test/durable-workflow-recovery.test.ts` (7/7 passed)  
- `apps/core/test/milestone1-vertical-slice.test.ts` (1/1 passed)  
- `apps/core/test/governed-learning-dna-lifecycle.test.ts` (6/6 passed)  
- `apps/core/test/r03-authoritative-config-postgresql.test.ts` (7/7 passed)  
- `apps/core/test/auth-negative-controls.test.ts` (22/22 passed)  

---

## 1. Defect Analysis & Counterexamples

### 1.1 Terminal Task State Couplings & Rolled-Back Task Completion
- **Baseline Defect:** Task publication and notification were synchronously or ambiguously coupled. If the downstream notification (e.g. Telegram message to client or operator) failed, timed out, or was rejected, earlier systems risked rolling back the publication or leaving the task in an ambiguous state despite deliverables being verified in Google Drive and Sheets.
- **Counterexample Observed:** When Telegram returned a 503 or socket disconnect during publication dispatch, the task was either marked failed or left in an incomplete state, causing subsequent retries to re-attempt asset delivery.
- **Remediation (FR-051 Decoupling):**
  - Publication completion and outbox command enrollment are atomically committed in a single PostgreSQL transaction: `taskRepo.transitionState({ toState: 'complete', command: { type: 'notify.published', ... } }, trx)`.
  - The task and publication are marked `COMPLETE` in durable storage. Downstream notification is tracked independently in `hawa.outbox_commands`.
  - If notification fails, the task and its published assets remain 100% complete and immutable. Notification failure is surfaced cleanly in the outbox ledger without invalidating delivery.

### 1.2 Outbox Error Classification & Infinite Retries on Permanent Failures
- **Baseline Defect:** The outbox worker treated all errors identically, retrying unrecoverable errors (`CHAT_NOT_FOUND`, `BOT_BLOCKED`, `INVALID_DESTINATION`) with exponential backoff up to 5 times before failing.
- **Counterexample Observed:** When a Telegram chat was deleted or the client blocked the bot, the worker repeatedly retried the command 5 times over several hours, wasting resources and generating misleading error logs.
- **Remediation:**
  - Implemented `OutboxDeliveryError` and `DeliveryErrorCategory` (`'retryable' | 'permanent' | 'uncertain'`) in `apps/worker/src/outbox-consumer.ts`.
  - Added `markPermanentFailure(id, error)` in `OutboxRepository`.
  - Permanent failures are dead-lettered immediately on attempt 1 (`state = 'failed'`), preventing pointless retry cycles while preserving failure telemetry.

### 1.3 Duplicate Client Messages from Blind Replay of Uncertain Deliveries
- **Baseline Defect:** Network socket drops, HTTP gateway read timeouts, or process terminations occurring *after* an outbound message was dispatched over the wire were treated as generic failures and automatically retried, resulting in duplicate notifications sent to clients.
- **Counterexample Observed:** Socket timeout on ACK after Telegram HTTP 200 payload write caused the consumer to schedule a retry, resulting in the client receiving identical delivery notifications twice.
- **Remediation:**
  - Introduced uncertain delivery error handling: socket drops or write-time timeouts throw `OutboxDeliveryError(..., 'uncertain')`.
  - The worker marks the command `state = 'failed'` with prefix `DELIVERY_UNCERTAIN:` using `outboxRepo.markUncertain(id, error)`.
  - Automated background retries are strictly blocked. Manual operator redrive requires explicit `{ confirmUncertainReplay: true }` in `POST /tasks/:taskId/outbox/:commandId/redrive`, preventing duplicate messages to clients.

### 1.4 Undiscoverable Failure State & Missing Operator Recovery Paths
- **Baseline Defect:** Operators had no API endpoint to inspect the durable publication status or outbox delivery state of a task, requiring raw SQL database queries to troubleshoot stuck or failing notifications.
- **Remediation:**
  - Added `GET /tasks/:taskId/outbox`: returns task outbox commands enriched with `actionableRecovery`, `errorCategory`, `canRedrive`, and `requiresUncertainConfirmation`.
  - Added `POST /tasks/:taskId/outbox/:commandId/redrive`: role-protected endpoint allowing operators/administrators to redrive failed outbox commands, with safety gate enforcement for uncertain commands.
  - Added `GET /tasks/:taskId/publication-state`: returns durable publication and sync state across Drive, Sheets, and notification channels with clear, actionable reconciliation advice.

---

## 2. Architecture & Implementation Summary

### 2.1 Repository & Outbox Infrastructure (`packages/db`)
- `OutboxRepository`:
  - `findByAggregateId(tenantId, aggregateType, aggregateId, trx)`: queries outbox commands scoped to tenant and task.
  - `findById(tenantId, id, trx)`: finds specific command with tenant isolation.
  - `markPermanentFailure(id, error, trx)`: records permanent failure immediately on attempt 1.
  - `markUncertain(id, error, trx)`: prefixes error with `DELIVERY_UNCERTAIN:` and marks failed to prevent automated replay.
  - `redrive(tenantId, id, trx)`: resets state to `'pending'`, `attempts = 0`, and `last_error = null`.
- `PublicationRepository`:
  - `findByTaskId(taskId, tenantId, trx)`: finds latest publication record by task ID.
  - Fixed `client_dna_versions` upsert constraint target to match `UNIQUE(client_id, version)`.

### 2.2 Worker Domain (`apps/worker`)
- `OutboxConsumer`:
  - Added `OutboxDeliveryError` class with category classification (`'retryable' | 'permanent' | 'uncertain'`).
  - Categorized errors during batch processing:
    - `permanent`: calls `markPermanentFailure()`.
    - `uncertain`: calls `markUncertain()`.
    - `retryable`: calls `retryOrDeadLetter()` with exponential backoff.

### 2.3 Core Domain (`apps/core`)
- `executeOmnichannelPublish` & `POST /tasks/:taskId/publish`:
  - Atomically passes `command: { type: 'notify.published', ... }` to `taskRepo.transitionState`.
  - Updates `globalSharedInMemoryOutbox` in in-memory mode.
- Discovery and Recovery Endpoints:
  - `GET /tasks/:taskId/outbox`: inspects task outbox commands.
  - `POST /tasks/:taskId/outbox/:commandId/redrive`: safely redrives failed commands.
  - `GET /tasks/:taskId/publication-state`: queries publication state and provides actionable reconciliation guidance.

---

## 3. Test Execution & Evidence

### 3.1 R07 Outbox Terminal State Test Suite
```bash
$ vitest run test/r07-outbox-terminal-state.test.ts

 ✓ test/r07-outbox-terminal-state.test.ts (6 tests) 100ms
   ✓ R07: Close Durable Workflow Through Terminal State & Notification (FR-051–053, FR-081–082, NFR-001, NFR-014) (6)
     ✓ 1. Atomically commits terminal task completion and enrolls notify.published outbox command 25ms
     ✓ 2. Preserves COMPLETE publication and task state if outbox notification fails (FR-051 decoupling) 4ms
     ✓ 3. Outbox consumer distinguishes retryable, permanent, and uncertain errors 58ms
     ✓ 4. Outbox discovery endpoint surfaces actionable recovery instructions for all failure types 3ms
     ✓ 5. Enforces safety gate on redrive: rejects uncertain replays without explicit confirmation and blocks non-operators 5ms
     ✓ 6. Publication state endpoint reports accurate sync status and reconciliation guidance 3ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  14:26:05
   Duration  1.08s
```

### 3.2 Worker Durable Outbox & Recovery Suite
```bash
$ vitest run

 ✓ test/durable-workflow-recovery.test.ts (7 tests) 160ms
 ✓ test/outbox-consumer.test.ts (4 tests) 132ms
 ✓ test/canva-draft-workflow.test.ts (23 tests) 20ms
 ✓ test/workflow.test.ts (1 test) 4ms

 Test Files  4 passed (4)
      Tests  35 passed (35)
   Start at  14:23:20
   Duration  1.82s
```

### 3.3 Core Regressions Clean
```bash
$ vitest run test/auth-negative-controls.test.ts test/governed-learning-dna-lifecycle.test.ts test/milestone1-vertical-slice.test.ts test/r03-authoritative-config-postgresql.test.ts

 ✓ test/milestone1-vertical-slice.test.ts (1 test) 186ms
 ✓ test/governed-learning-dna-lifecycle.test.ts (6 tests) 111ms
 ✓ test/r03-authoritative-config-postgresql.test.ts (7 tests) 63ms
 ✓ test/auth-negative-controls.test.ts (22 tests) 23ms

 Test Files  4 passed (4)
      Tests  36 passed (36)
   Start at  14:25:58
   Duration  2.44s
```

---

## 4. Architectural Invariants Verification
1. **Zero Fake Passes:** Every test executed against real or emulated runtime conditions; database operations executed directly against PostgreSQL test instance (`hawa_test` on `127.0.0.1:55432`).
2. **Immutable Audit Directory:** `output/audits/2026-09-19-architecture-reliability/` remained untouched.
3. **Decoupled Terminal Boundaries:** Task state `COMPLETE` is decoupled from ephemeral transport success; failures in notification never roll back delivered assets.
4. **Idempotency & Replay Safety:** Outbox commands cannot be replayed without operator role verification, and uncertain deliveries require explicit `confirmUncertainReplay: true`.
