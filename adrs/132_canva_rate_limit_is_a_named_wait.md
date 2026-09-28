# ADR-132: A Canva Rate Limit Is a Named Wait, Not a Failed Draft

**Date:** 2026-09-28
**Status:** Proposed; focused tests and the full suite pass locally. Not deployed, and no real Canva call was made. Builds on ADR-131 (merged into studio-v2 as 928dbd6).
**Requirements:** FR-059 (provider failures pause and retry without losing completed work), FR-060 (no repeated non-idempotent side effect).
**Changes a foundation:** how Core records a Canva create call (design import, design export) that Canva still refuses with 429, and how the worker's `TaskWorkflow` answers it.

## 1. Context

Canva Connect limits design import jobs to 20 requests a minute per user, and design export jobs to 20 a minute per user, 75 per 5 minutes, 500 a day per user, and 75 per 5 minutes per design (canva.dev, fetched 2026-09-28). Every automatic draft goes through the office's single Canva connection and makes one import and two exports (the PNG preview and the PPTX copy-and-font check).

The client (`packages/integrations/src/canva-connect-client.ts`, `createWithRetry`) repeats a 429 on a create call up to four times (1, 2, 4, 8 s, or Canva's `Retry-After` up to 30 s). If Canva was still refusing after that, or asked for a wait over 30 s, Core's `createdNothing` recorded the operation `failed` ("Canva did not accept the import/export …; nothing was created"). Core answered normally, and the workflow ended the draft as `DESIGN_FAILED` or `CANVA_PREVIEW_FAILED`. The refusal also could not be retried under its own key. Core reports a failed operation's key as failed and never sends it again. So a draft that only had to wait its turn was lost.

ADR-131 sized the planning slots (default 4) to keep a burst of ten briefs under the export limit, and recorded that raising them needs this change.

## 2. Decision

1. **The client says how long Canva asked to wait.** A create call refused with 429 throws `CanvaHttpError` with `retryAfterMs`, Canva's `Retry-After` when it sent one. Other refusals name no wait.
2. **Core records a 429 as a refusal its own key may send again.** The operation is marked `failed`, as before. Its metadata gets `rateLimited: true`, a `rateLimitCount`, and `failureEvidence: {kind: 'not_accepted'}`. That evidence is true, since Canva's rate limit refuses before acting. With it, the operation blocks no other creation for the task (`canRetryCanvaCreation`, ADR-121), and the task state does not show it as `legacy_failed_without_evidence`. A retry removes `rateLimited` and the evidence again. The same key then sends the same request again, under the task row lock, with a compare-and-set from `failed` + `rateLimited` to `creating`. A second retry of the same key waits for the lock and follows the first. An import also re-runs the checks a new import passes: no other live create for the task, and no binding. An export re-reads the design, re-runs the binding lock and the pending-export check, and refreshes `designUpdatedAt`. It keeps the check policy recorded when the export was first admitted, so today's font policy never replaces it. That is the same rule a concurrent retry follows.
3. **Core answers 429 `CANVA_RATE_LIMITED` with `Retry-After`.** The wait is Canva's, bounded to 1–30 s (the range the worker keeps). It is 30 s when Canva named none (`canvaRateLimitWaitMs`). This applies on `/canva/exports`, on `/canva/generate` and `/canva/plans/:id/resume` (the planner's import), and on the studio's resume, whose transfer stage imports. The studio run stays at `transferring`, as it does for `PARENT_STILL_RUNNING`. The studio route now sends `Retry-After` too.
4. **The worker waits through `runUnlessBusy`.** The preview export, the stale-preview recovery exports, the copy-and-font check export and the plan resume now go through the helper that already carried the generation (ADR-131). The busy answer and Core's wait are journalled. The worker waits that long, bounded to 1–30 s, and asks again with the same idempotency key, for up to 15 minutes. The first try keeps its step name, so an invocation journalled before this change replays unchanged. After the window the draft ends once, as that step's failure: `CANVA_PREVIEW_FAILED` or `CANVA_CHECK_REQUIRED` with the design id, or `DESIGN_SERVER_ERROR` for the import. The code is `CANVA_RATE_LIMITED` and the detail names Canva's rate limit.
5. **Only a 429 is repeated.** An import whose outcome is unknown (a 5xx, or a connection lost after sending) stays `uncertain` and is never sent again under its key, as before. Every other 4xx stays `failed` and final under its key. Canva documents no idempotency key for create calls, so a 429 is the one answer that certainly created nothing and may be repeated.

## 3. Consequences

- A burst that overshoots Canva's per-minute limit delays drafts instead of failing them. That was ADR-131's stated condition for going past 4 planning slots. The slot count is still the owner's decision, and the daily limit (500 exports per user) is still a hard stop: the window ends the draft with `CANVA_RATE_LIMITED`.
- Each workflow retry costs Core at most one Canva request when Canva asks for more than 30 s, and up to five (about 15 s) when it names no wait. Over the 15-minute window that is bounded by about 30 tries.
- A Desk export refused this way now shows the 429's message ("Send the same request again in about N s") instead of a `failed` export. Pressing Export again reuses the same key, and so the same operation.
- The draft recheck (`canva-task-outcome.ts`) reports `refused: CANVA_RATE_LIMITED` rather than `failed`.
- studio-v2 now carries the mainline tree (a7350009), including the rewritten planner (ADR-101). Its `resume()` lets the import's `CANVA_RATE_LIMITED` through to the route, and the lifecycle-owned DesignRun reports the ending through the same `finish`.

## 4. Verification

Tests written first and seen failing (14 of the new or changed tests failed before the change):

- `packages/integrations/test/canva-create-retry.test.ts`: a 429 the client gives up on carries Canva's wait (120 s after one POST; none after five unnamed refusals); a 400 names none.
- `apps/core/test/canva-connect-resilience.test.ts` (real PostgreSQL, mocked Canva transport): an import or export refused with 429 answers `CANVA_RATE_LIMITED` with a 30 s bound. The same key sends it again once Canva accepts: one operation and one job, and a third call follows it. Two simultaneous retries of one key send the import once. A 5xx or a lost connection stays `uncertain` and is not sent again. A 403 import or 400 export stays `failed` under its key. The wait bounds are 7→7 s, 120→30 s, 0→1 s, and none→30 s.
- `apps/core/test/canva-design-planner.test.ts`: a rate-limited import keeps the paid plan `planned`, and the same generation key imports it with no second model call.
- `apps/core/test/design-studio-orchestrator.test.ts` (6d): the run stays at `transferring` with the named wait, and the next resume imports under the run's key.
- `apps/core/test/canva-rate-limit-route.test.ts`: the export and studio resume routes send `Retry-After`.
- `apps/worker/test/canva-draft-workflow-canva-rate-limit.test.ts`: the preview, check, generation and plan-resume waits use the named time and one key. A replay makes no Core call and asks for the same timers. After 15 minutes the draft ends `CANVA_PREVIEW_FAILED`/`CANVA_RATE_LIMITED` with the design id, or `DESIGN_SERVER_ERROR`/`CANVA_RATE_LIMITED` for the import. A 409 on the export stays final, with no wait.

Not measured: the chaos stack's fake Canva cannot yet answer 429, so no load test shows the wait end to end.
