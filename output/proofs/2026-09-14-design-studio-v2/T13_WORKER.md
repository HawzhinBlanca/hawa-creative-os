# Task T13 Proof: Worker Integration, Intake Flag, Status Notes, Photo Delivery, and Parity Check

**Date:** 2026-09-14  
**Branch:** `studio-v2`  
**Task:** T13 (Worker, intake flag, status notes, delivery, parity route)  
**Status:** COMPLETE (All automated tests pass, zero regressions, security scan 0 secrets)

---

## 1. Overview & Architecture (ADR-029 Section 5.9 & 5.10)

Task T13 completes the end-to-end integration connecting Hawa Core, the Durable Worker (Restate engine), Telegram Status Notifications, and Canva export parity verification:

1. **Intake Flag (`apps/core/src/services/chat-intake.ts`):**
   - Sets `payload.designStudio = process.env.DESIGN_STUDIO_V2 === 'on'` at intake as a journaled decision in the outbox command payload.
   - Allows caller override via `input.designStudio` and accepts `input.studioOptions` (tier, imagery, previews, holdForSelection).

2. **Dispatcher Mapping (`apps/worker/src/workflow.ts`, `apps/worker/src/workflow-dispatcher.ts`):**
   - Extended `WorkflowInput` with `designStudio?: boolean` and `studioOptions?: { tier?, imagery?, previews?, holdForSelection? }`.
   - `TaskWorkflowDispatcher` maps `designStudio` and `studioOptions` from outbox command payload to both Restate workflow invocations and embedded runner executions.

3. **Durable Worker Studio Flow (`apps/worker/src/canva-draft-workflow.ts`):**
   - When `designStudio` is true:
     - `canva-studio-start`: calls `POST /v1/tasks/:taskId/canva/studio` with variant size and studio options using stable idempotency key `workflow-studio-${taskId}`.
     - `canva-studio-resume-n`: polls `POST /v1/tasks/:taskId/canva/studio/:runId/resume` (up to 150 polls with 5s sleep) until status reaches `transferred`, `degraded`, or `failed`.
     - On `failed` status: transitions directly to `finish('DESIGN_FAILED', undefined, code)`.
     - On `transferred` or `degraded`: continues the verified downstream pipeline:
       - **Strict Binding Check**:
         `if (!result.designId || state.binding?.designId !== result.designId) throw new WorkflowTerminalError('Workflow binding differs from imported document', 'BINDING_MISMATCH');`
         The result must carry a valid `designId` matching the durable Canva binding; missing or mismatched design IDs throw `BINDING_MISMATCH` immediately.
       - `canva-read-binding` verifies document binding against imported design;
       - `canva-export-preview` retrieves PNG export;
       - `canva-export-copy-font-check` retrieves PPTX and runs native copy & font inspection;
       - **Parity Error Handling**:
         The parity check (`canva-parity-check`) is no longer swallowed with an empty catch block. In the event of a parity evaluation error, the boundary/HTTP/error code is preserved and forwarded as `parity: 'unavailable'` and `parityError: code` to `finish()`.
       - `finish('CANVA_DRAFT_READY_FOR_VISUAL_REVIEW', result.designId, parity === 'unavailable' ? parityError : undefined, parity)`.
   - Legacy path (`designStudio` false or off) executes `canva-create-draft` and `canva-resume-draft-n` with zero behavioral change.

4. **Canva Parity Check (P8) (`apps/core/src/services/design-studio/stages/parity.stage.ts`):**
   - Evaluates Prompt P8 via Fable 5.1 vision comparing Image 1 (candidate preview PNG) with Image 2 (Canva exported PNG from `hawa.canva_export_bytes`).
   - Returns structured `CanvaParityVerdict`: `{ parity: 'match' | 'minor' | 'major', divergences: [...], fontSubstituted, textReflowed, copyVisibleIdentical }`.
   - Records judgment into `hawa.design_studio_judgments` with `kind: 'parity'`.
   - Exposed on Core routes: `POST /v1/tasks/:taskId/canva/parity-check` and `POST /v1/tasks/:taskId/canva/studio/:runId/parity`.

5. **Status Notes & Outbound Photo Delivery (`apps/core/src/app.ts`, `canvaStatusHandler`):**
   - Automatically detects completed Studio v2 runs for the task.
   - When parity is `unavailable`, appends ` · parity: unavailable (${body.parityError})` to the notes and records an unavailable judgment into `hawa.design_studio_judgments`.
   - Appends informative studio metadata line to `notes`:
     `Studio v2 · 5 concepts · 2 revision rounds · judge 8.7/10 · imagery: generated (SynthID) · typeface: EB Garamond (draft stand-in for Minion)` plus any ladder rung notes.
   - Text message composed with `composeCanvaStatusMessage` and dispatched via `telegramBridge.dispatchOutboundMessage`.
   - Outbound photo delivery:
     1. Dispatches exported Canva PNG (from `hawa.canva_export_bytes`) with `dispatchOutboundPhoto(sourceChannelId, canvaPng, '🎨 Canva export draft')`.
     2. Dispatches up to `previews - 1` runner-up candidate previews captioned `Option n (preview, not in Canva)`.
     3. Wrapped in error handling so photo delivery errors never fail or retry the status notification.

---

## 2. Automated Test Evidence

### 2.1 Worker Studio & Legacy Pipeline Tests (`apps/worker/test/canva-draft-workflow.test.ts`)
Command: `TEST_DATABASE_URL="..." pnpm --filter @hawa/worker test`

```text
 ✓ test/workflow.test.ts (1 test) 4ms
 ✓ test/canva-draft-workflow.test.ts (22 tests) 19ms
   ✓ native Canva workflow > resumes known operations and retrieves a real-shaped preview without approving
   ✓ native Canva workflow > recovers a stale preview with a fresh bounded export without another generation
   ✓ native Canva workflow > does not spend on the historical backlog without an explicit generation marker
   ✓ native Canva workflow > rejects a different client before model or Canva actions
   ✓ native Canva workflow > never turns an uncertain generation into an approval or new request
   ✓ native Canva workflow > reports a refused generation (4xx) as a terminal outcome instead of retrying it
   ✓ native Canva workflow > keeps retrying transient Core failures (5xx) rather than reporting a false outcome
   ✓ native Canva workflow > drafts the size recorded at intake and falls back to the historical default without one
   ✓ native Canva workflow > never starts model or Canva work for an unscoped task; it tells the requester instead
   ✓ native Canva workflow > requires an engine invocation receipt, not just HTTP success
   ✓ native Canva workflow > uses workflow-key idempotency without the header rejected by the live Restate server
   ✓ native Canva workflow > reconciles 409 Conflict when workflow is already running in Restate without throwing
   ✓ native Canva workflow > passes updated binding version to pptx check after preview recovery bumps version
   ✓ native Canva workflow > gracefully falls back to CANVA_CHECK_REQUIRED when copy/font check export fails with 4xx terminal error
   ✓ native Canva workflow > gracefully transitions to CANVA_PREVIEW_FAILED when preview export fails with 4xx terminal error
   ✓ native Canva workflow > gracefully transitions to DESIGN_REJECTED when resume draft fails with 4xx terminal error
   ✓ native Canva workflow > executes Design Studio v2 workflow: studio-start -> studio-resume -> binding -> exports -> parity -> ready
   ✓ native Canva workflow > reports DESIGN_FAILED when design studio returns failed status after ladder
   ✓ native Canva workflow > proves both studio path and legacy path reach CANVA_DRAFT_READY_FOR_VISUAL_REVIEW
   ✓ native Canva workflow > forwards designStudio and studioOptions through TaskWorkflowDispatcher
   ✓ native Canva workflow > throws BINDING_MISMATCH when studio result lacks designId or differs from binding
   ✓ native Canva workflow > passes parity: unavailable with parityError code to status notification when parity check fails
 ✓ test/durable-workflow-recovery.test.ts (7 tests) 232ms
 ✓ test/outbox-consumer.test.ts (4 tests) 253ms

 Test Files  4 passed (4)
      Tests  34 passed (34)
   Start at  16:31:54
   Duration  781ms
```

### 2.2 Status Message Notes & Snapshot Tests (`apps/core/test/canva-status-message.test.ts`)
Command: `pnpm --filter @hawa/core test test/canva-status-message.test.ts`

```text
 ✓ test/canva-status-message.test.ts (5 tests) 3ms
   ✓ requester-facing Canva outcome messages > sends the Canva link only when a design actually exists
   ✓ requester-facing Canva outcome messages > tells the truth about each rejection reason instead of a generic "queued"
   ✓ requester-facing Canva outcome messages > escapes user-controlled text so Telegram never rejects the message
   ✓ draft caveats > appends escaped notes before the footer and never claims more than the status
   ✓ draft caveats > renders Studio v2 notes line and matches snapshot format

 Test Files  1 passed (1)
      Tests  5 passed (5)
```
