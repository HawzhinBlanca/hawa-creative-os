# Task T11 Proof: Design Studio v2 Orchestrator

## Overview
- **Service**: `apps/core/src/services/design-studio/design-studio-service.ts`
- **Exports**: `apps/core/src/services/design-studio/index.ts`
- **Tests**: `apps/core/test/design-studio-orchestrator.test.ts` (7 tests passed)
- **Monorepo State**: 920 tests passed, 0 failures, 0 typecheck errors, 0 secrets.

---

## 1. Concurrency & Transaction Isolation
- **Tenant Advisory Lock**:
  ```typescript
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('design-studio:' || ${s.tenantId}, 0))`.execute(db);
  ```
  Acquired within each transaction to serialize concurrent generation requests for a given tenant.
- **Client Scope Immutability**:
  Acquires `SELECT client_id, description FROM hawa.tasks WHERE tenant_id = ... AND id = ... FOR UPDATE` before inspecting client context and ensuring immutable binding to KAAE.
- **Active Run Limits**:
  - **One active run per task**:
    ```typescript
    const activeOnTask = await sql`SELECT id FROM hawa.design_studio_runs 
      WHERE tenant_id=${s.tenantId}::uuid AND task_id=${taskId}::uuid 
        AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned') LIMIT 1`.execute(db);
    if (activeOnTask.rows.length > 0) {
      throw new CanvaFlowError(409, 'STUDIO_RUN_IN_PROGRESS', 'A studio design is already in progress for this task.');
    }
    ```
  - **Max 2 concurrent active runs per tenant**:
    ```typescript
    const activeRuns = await sql`SELECT count(*) AS n FROM hawa.design_studio_runs 
      WHERE tenant_id=${s.tenantId}::uuid 
        AND status NOT IN ('transferred', 'degraded', 'failed', 'abandoned')`.execute(db);
    if (Number(activeRuns.n) >= 2) {
      throw new CanvaFlowError(429, 'STUDIO_BUSY', 'Two studio designs are already in progress.');
    }
    ```
- **Idempotency & Conflict Check**:
  Repeated calls with identical request key and payload return the existing run with `created: false`. Altered payloads throw `409 GENERATION_CONFLICT`.

---

## 2. Stage Execution, Resumption & Call Ledger
- **Insert-Before-Dispatch**:
  Calls are recorded to `hawa.design_studio_calls` with status `uncertain` before issuing the network request to Anthropic or Google Imagen:
  ```typescript
  await this.repo.recordCallStart({
    id: callId,
    runId: run.id,
    tenantId: s.tenantId,
    stage: currentStageName,
    provider: 'anthropic',
    model,
    requestedModel: model,
  });
  ```
- **Finalize Upon Completion**:
  When the model returns, `finalizeCall` records token usage, USD estimate, and sets status `ok`.
- **Interruption Resilience**:
  When resumed, prior completed stages are retained in `run.stages`. No model call is re-dispatched for already completed stages (verified in test 3: `SELECT count(*) as n FROM hawa.design_studio_calls WHERE run_id=... AND stage='briefing'` remains exactly 1).

---

## 3. Budget Cap Enforcement
- Model clients check remaining USD budget before making any call:
  ```typescript
  if (currentBudget.spentUsd >= currentBudget.maxUsd || currentBudget.calls >= currentBudget.maxCalls) {
    throw new StudioBudgetExhaustedError('BUDGET_EXHAUSTED');
  }
  ```
- Graceful handling: If budget cap is breached, `handleBudgetExhaustion` scans candidate states so far, evaluates deterministic hard QA, and promotes the best candidate passing QA to `transferring`. If no candidate passes QA, the run is marked `failed` with diagnostic `BUDGET_EXHAUSTED`.

---

## 4. Degradation Ladder & Rung 4 Fallback
- **Rung 1**: Procedural motif fallback if generated art provider fails or times out.
- **Rung 2**: Soft visual critique failure retries once with feedback.
- **Rung 3**: Judge outage ranks candidates by deterministic layout metrics (`alignmentScore`, APCA contrast).
- **Rung 4**: If generation stages fail unrecoverably, `executeRung4Fallback` calls `CanvaDesignPlanner.generate(s, run.task_id, fallbackKey, width, height)` and marks run status as `degraded` with `plan_id` referencing the resulting plan row in `hawa.canva_design_plans`.

---

## 5. Verification Output
```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ apps/core/test/design-studio-orchestrator.test.ts (7 tests) 2373ms
   ✓ 1. repeated Idempotency-Key returns the same run; altered payload throws GENERATION_CONFLICT (33ms)
   ✓ 2. enforces one active run per task and 2 active runs per tenant (39ms)
   ✓ 3. interruption between stages resumes without a second charge (ledger count unchanged) (22ms)
   ✓ 4. budget cap exhaustion transitions to BUDGET_EXHAUSTED with best candidate so far (15ms)
   ✓ 5. degradation ladder Rung 4 fallback calls the planner when studio stages fail unrecoverably (24ms)
   ✓ 6. advances full pipeline to transferred status and creates canva_design_plans row (1914ms)
   ✓ 7. abandon marks run abandoned and allows a new generation to be started (27ms)

 Test Files  1 passed (1)
      Tests  7 passed (7)
```
Full suite: 920 tests passing, 0 failures across 125 test files.
