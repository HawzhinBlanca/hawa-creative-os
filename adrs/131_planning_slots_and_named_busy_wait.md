# ADR-131: Planning Slots From Measured Limits, and a Busy Wait Core Names

**Date:** 2026-09-28
**Status:** Proposed; tests pass locally on `claude/mainline`; not deployed. The owner decides the slot count for production (4 by default; 5 saves a ten-brief burst one round, at the cost in section 2).
**Requirements:** FR-059 (provider and capacity waits pause and retry without losing work), FR-060 (resume after a restart), FR-062 (expensive model concurrency limited by office scope), FR-079 (generation caps).
**Changes a foundation:** Core's hard-coded limit of two designs planned at a time for the whole office (`PLANNING_BUSY`), and the worker's handling of that refusal.
**Builds on:** ADR-101 (durable Canva planner calls), ADR-034 (RequestLifecycle and DesignRun).
**Origin:** ported from studio-v2 `0a2acd0a` (same number, same intent). studio-v2's planner and this line's differ: here every paid planner call is admitted durably (ADR-101) against the office's spending allowance, so the port keeps each of those guarantees and changes only the slot count, the refusal and the wait.

## 1. Context

Core's Canva planner (`apps/core/src/services/canva-design-planner.ts`) makes one model call per design. `generate()` claims a plan under the tenant's planning lock (`pg_advisory_xact_lock('canva-planning:<tenant>')`), and inside that claim refused a new plan with HTTP 429 `PLANNING_BUSY` while two of the tenant's `canva_design_plans` rows were in `planning`. A row is in `planning` from its claim, through the durable admission of its call (`canva_planner_calls`, ADR-101) and the call itself (aborted at 90 s by `executePlannerCall`), until the editable source is saved. A row can also stay in `planning` longer: when its call's outcome is uncertain and the row still has a retained layout awaiting named cost evidence, or when Core died after the call was admitted.

The worker sends `/canva/generate` from `runCanvaDraft` (`apps/worker/src/canva-draft-workflow.ts`), which serves both the legacy `TaskWorkflow` and a RequestLifecycle-owned `DesignRun` (`lifecycle/design-run.ts`, with its design proof headers). The call went through an ordinary `ctx.run`. A 429 is retryable there, so Restate's step retry answered it with its own doubling backoff (`CORE_STEP_RETRY`: 2, 4, 8, 16 and then 30 s, for 10 minutes). The studio start already avoided this: its 429 `STUDIO_BUSY` goes through `runUnlessBusy`, a journalled answer and a fixed 25 s durable sleep for up to 15 minutes.

The Phase 4 load test (studio-v2, 2026-09-24; 10 Telegram chats sending a brief at once, fakes that plan instantly) measured brief to first draft at p50 11.3–11.5 s and p95 35.4–35.7 s. Drafts arrived in pairs at about 5, 7, 11, 19 and 35 s, while slots stood free between tries. With real model calls each pair takes as long as a plan, and the doubling waits add on top. The load test's chats are not enrolled, so on this line too their requests take the legacy path.

### Where "2" came from

`git log -S PLANNING_BUSY` finds it first in `bf7a0175` (2026-09-13, the Canva-only cutover), which is in this line's history too, as a literal with the message "Two designs are already being planned. Resume existing work before starting another." That message is written for an operator pressing Generate in the Desk. No ADR, test, cost note or runbook gives a reason for the number. Automatic drafts from Telegram came later. The cost programme (2026-09-20) and ADR-101 set spending limits instead (office, client and role allowances admitted before each paid call); none of them refers to planning concurrency.

The cap also had a defect. A row left in `planning` by a Core that died mid-call is never finished by anything: nothing sweeps it, and ADR-101 rightly forbids re-running a call whose outcome is uncertain. So it held a slot for ever, and two such crashes would stop the office planning until an operator abandoned each plan by hand.

## 2. What limits planning concurrency (measured or documented, 2026-09-28)

These were gathered for studio-v2's ADR-131 and apply unchanged: the same model, the same Canva connection, the same Mac.

| Limit | Value | Source |
|---|---|---|
| Planner call length | 23.3–47.1 s, median 34.0 s (n=10, claude-opus-5, text only). Production rows 25–37 s (n=3, 2026-09-13). No `gpt-6-astra` planner call has a recorded duration; its other calls ran at about 57 output tokens/s, which puts a planner's 1.2–2.0k output tokens at roughly 21–35 s ^[inferred] | studio-v2 ADR-131 section 2 and its sources |
| Planner call size | 1.5–2.1k input and 0.45–2.2k output tokens (n=13); `max_completion_tokens` 4,000 | the same |
| OpenAI, `gpt-6-astra` | Tier 1: 500 RPM and 500K TPM. About 25 calls could be in flight at Tier 1 before the token limit binds ^[inferred] | developers.openai.com, fetched 2026-09-28 |
| Canva Connect, design imports | 20 requests a minute per user | canva.dev, "Create design import job", fetched 2026-09-28 |
| Canva Connect, design exports | 20 requests a minute per user; 75 per 5 minutes and 500 a day per user | canva.dev, "Create design export job", fetched 2026-09-28 |
| What a Canva 429 does | The Canva client retries a refused create up to four times, honouring Canva's `Retry-After` up to 30 s. If Canva is still refusing after that, the import or export is recorded as failed and the draft fails | `packages/integrations/src/canva-connect-client.ts` |
| Spending | Each admitted planner call reserves its bounded cost against the office, client and `creative_director` allowances before transport (ADR-101). More slots do not raise any allowance; they only let the allowance be spent sooner | `hawa.enforce_canva_planner_call`, migration 056 |

Every automatic draft is imported and exported through the office's single Canva connection: one import and two exports per draft (the PNG preview and the PPTX copy-and-font check), plus up to two more exports when a preview comes back stale. A slot frees when its plan is saved, so `n` slots start about `n × 60 / T` drafts a minute for a plan time of `T` seconds.

- **A burst of ten briefs** spends 20 exports whatever the slot count; the slots decide how they are spread. With 30 s plans, 5 slots put all 20 into one minute, exactly Canva's limit. **4 slots** go in rounds of 4, 4 and 2, at most 16 exports in any minute.
- **Sustained demand** is bounded by the office's daily limits and spending allowance rather than by the slots.

**Four slots is therefore the default: the most that keeps a burst of ten under Canva's export limit with headroom.** Five slots reach the limit exactly, and any further export in that minute then depends on the Canva client's short retry.

## 3. Decision

1. **Four planning slots by default, configurable.** `HAWA_CANVA_PLANNING_SLOTS`, a whole number from 1 to 16, overrides the default; any other value keeps it (`planningSlotsFrom`). Raise it only together with the Canva export budget above, and not past 4 while a lasting Canva 429 still fails a draft. The count is still taken inside the claim, under the tenant's planning lock, so concurrent briefs cannot overshoot it.
2. **Core names the wait.** A refused brief gets 429 `PLANNING_BUSY` with `Retry-After` (whole seconds, rounded up; `CanvaFlowError.retryAfterMs`, sent by `canva.routes.ts`). The value is the time until the oldest running plan should finish, judged by the median slot time (claim to saved result) of the office's last 20 finished plans that made a model call, bounded to 2–15 s. With no such plan to judge by it names the shortest wait, 2 s: studio-v2's first version guessed 20 s and held the second round of an empty office back 15 s after its slots had freed (`planningRetryAfterMs`). A refused brief leaves no plan row, admits no call and reserves no allowance.
3. **The worker waits the named time.** `/canva/generate` goes through `runUnlessBusy`, as the studio start does. A 429 is journalled as an answer together with Core's `Retry-After`, so a replay sleeps the same without reading a header. The worker sleeps that long, bounded to 1–30 s, and asks again with the same idempotency key (the planner's request key, so Core still plans one design), for up to 15 minutes. A busy answer that names no wait, or names it as a date, waits 25 s as before. After the window the run ends as `DESIGN_SERVER_ERROR` with code `PLANNING_BUSY`, reported once: through Core's status route on the legacy path, through `LifecycleOutcomeReporter` to RequestLifecycle on a DesignRun. The first try keeps its step name (`canva-create-draft`), so an invocation journalled before this change replays unchanged.
4. **A cut-off plan stops holding a slot, and nothing else about it changes.** A row still in `planning` three minutes after its claim (`STALE_PLANNING_MS`: twice the 90 s model timeout) is not counted. The row is not touched (its `created_at` is immutable evidence, migration 056), its call stays as it is (`started` or unresolved), its reservation stays held in the office allowance, and its own task is still not planned again under any key: `generate()` returns the existing plan and `resume()` says it must be reconciled. Settling that charge remains ADR-101's reconciliation, by an operator with named evidence.

### Why not a true queue

A FIFO queue with tickets would need a new plan status or table, a migration, and expiry for tickets whose workflow died: the same stale-slot problem again, for every waiter. With the named wait, a waiter comes back within about 2 s of the moment a slot should free. The only unfairness left is which of several waiters wins a freed slot, bounded by the 15-minute window.

## 4. Consequences

- A burst of briefs is drafted in rounds of four rather than two, and no waiter sleeps past a free slot by more than the named wait.
- A burst comes closer to Canva's per-minute export limit: 16 exports in a minute where two slots made 8. A Canva 429 that outlasts the client's short retry still fails the draft. Turning that into a workflow wait is the natural next step and is not done here.
- Four plans can hold an allowance reservation at once instead of two. The allowance itself is unchanged, and admission still refuses a call it cannot cover (`OFFICE_BUDGET_EXHAUSTED`) before transport.
- A stale `planning` row is still visible in the Desk and Operations as unresolved; freeing its slot does not hide it.
- The studio lane's `STUDIO_BUSY` is unchanged: still 2 runs, a 25 s wait, and no `Retry-After`.

## 5. Verification

Tests written first and seen failing (15 of the 17 new tests failed on `19ffb93f`; the pre-change replay guard and the route's no-header case passed there, as they should):

- `apps/core/test/canva-design-planner.test.ts`, real PostgreSQL: the slot policy (`planningSlotsFrom`, `planningRetryAfterMs`, `STALE_PLANNING_MS`); refusal past the slots with `PLANNING_BUSY` and a 2–15 s `retryAfterMs`, with no model call, no plan row and no `canva_planner_calls` row, then planning with the same key once a slot frees; the named wait is 2 s while recent plans were brief; three slots plan three at once; a plan left in `planning` past `STALE_PLANNING_MS` (its call admitted and still `started`) no longer blocks another task, while the row stays `planning`, the call stays `started`, and a new key for its own task returns that same plan with no model call (mutation-checked: removing the age filter fails it).
- `apps/core/test/canva-planning-busy-route.test.ts`: the route sends `Retry-After` in whole seconds, rounded up, and none on a refusal that names no wait.
- `apps/worker/test/canva-draft-workflow-planning-busy.test.ts`: on the legacy path, the worker waits the named 3 s four times, not 2/4/8/16; one idempotency key; Core's wait is journalled with the answer; replay makes no Core call and asks for the same timers; a pre-change journal replays; waits bounded to 1–30 s; 25 s when unnamed or not in whole seconds; `DESIGN_SERVER_ERROR`/`PLANNING_BUSY` once after 15 minutes. On a DesignRun, every try carries the lifecycle design proof and the one outcome goes to RequestLifecycle, never to the legacy status route.

Load test on the chaos stack: see section 6.

## 6. Load test on this line

studio-v2's runs (2026-09-28, 10 chats at once, brief to first draft from the fake Telegram's pickup): instant plans p50/p95 11.2/35.4 s before, 9.2/9.8 s after with 4 slots; 30 s plans 125.4/245.6 s before, 65.8/97.8 s after with 4 slots (97.6/161.9 s with the named wait alone on 2 slots).

Runs on `claude/mainline` with this change: recorded below when run.
