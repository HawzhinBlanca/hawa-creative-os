# ADR-131: Planning Slots From Measured Limits, and a Busy Wait Core Names

**Date:** 2026-09-28
**Status:** Proposed; tests and the chaos-stack load test pass locally; not deployed. The owner decides the slot count for production (4 by default; 5 saves a ten-brief burst one round, at the cost in section 2).
**Requirements:** FR-059 (provider and capacity waits pause and retry without losing work), FR-060 (resume after a restart), FR-079 (generation caps).
**Changes a foundation:** Core's hard-coded limit of two designs planned at a time for the whole office (`PLANNING_BUSY`), and the worker's handling of that refusal.

## 1. Context

Core's Canva planner (`apps/core/src/services/canva-design-planner.ts`) makes one model call per design. It refused a new plan with HTTP 429 `PLANNING_BUSY` while two of the tenant's `canva_design_plans` rows were in `planning`. A row is in `planning` from its claim until the model call and the editable source are done, up to the call's 90 s timeout.

The worker (`TaskWorkflow`, `canva-draft-workflow.ts`) sent `/canva/generate` through an ordinary `ctx.run`. A 429 is retryable there, so Restate's step retry answered it with its own doubling backoff (`CORE_STEP_RETRY`: 2, 4, 8, 16 and then 30 s, for 10 minutes). The Phase 4 load test (2026-09-24; 10 Telegram chats sending a brief at once, fakes that plan instantly) measured brief to first draft at p50 11.3–11.5 s and p95 35.4–35.7 s. Drafts arrived in pairs at about 5, 7, 11, 19 and 35 s, while slots stood free between tries. With real model calls each pair takes as long as a plan, and the doubling waits add on top.

### Where "2" came from

`git log -S PLANNING_BUSY` finds it first in `bf7a017` (2026-09-13, the Canva-only cutover), as a literal with the message "Two designs are already being planned. Resume existing work before starting another." That message is written for an operator pressing Generate in the Desk. No ADR, test, cost note or runbook gives a reason for the number. Automatic drafts from Telegram came later. The studio's `STUDIO_BUSY` (2026-09-14, `e8fc7e8`) copied the number and the wording. The cost programme (2026-09-20) set daily and per-run limits instead: 5 automatic drafts per sender and 200 for the office each day (`chat-intake.ts`), $30 of office spend a day, and $2 or 24 calls per studio run. None of them refers to planning concurrency.

The cap also had a defect. A row left in `planning` by a Core that died mid-call is never finished. Nothing sweeps it, and `abandon()` refuses a plan in `planning`. So it held a slot for ever, and two such crashes would stop the office planning until someone edited the database by hand. The studio's cap already ignores a run that has not moved for 30 minutes (`8c439f8`); the planner's did not.

## 2. What limits planning concurrency (measured or documented, 2026-09-28)

| Limit | Value | Source |
|---|---|---|
| Planner call length | 23.3–47.1 s, median 34.0 s (n=10, claude-opus-5, text only). Production rows 25–37 s (n=3, 2026-09-13). No `gpt-6-astra` planner call has a recorded duration. Its other calls ran at about 57 output tokens/s, and a planner's 1.2–2.0k output tokens puts one at roughly 21–35 s ^[inferred] | `antigravity/remediation:output/proofs/2026-09-14-design-studio-v2/baseline/summary.json`; session transcripts of 2026-09-13 and 09-15 to 09-20 |
| Planner call size | 1.5–2.1k input and 0.45–2.2k output tokens (n=13); `max_completion_tokens` 4,000 | receipts in the same sources |
| OpenAI, `gpt-6-astra` | Tier 1: 500 RPM and 500K TPM (higher tiers 5,000–15,000 RPM, 1M–40M TPM). At a worst case of about 10k tokens and 30 s per call, about 25 calls could be in flight at Tier 1 before the token limit binds ^[inferred]. No rate-limit header or genuine `rate_limit_exceeded` from this account has ever been recorded; every real OpenAI 429 so far was billing exhaustion | developers.openai.com model page and rate-limit guide, fetched 2026-09-28; `references/llm-provider-billing-exhaustion-signals` in the vault |
| Canva Connect, design imports | 20 requests a minute per user | canva.dev, "Create design import job", fetched 2026-09-28 |
| Canva Connect, design exports | 20 requests a minute per user; 75 per 5 minutes and 500 a day per user; 75 per 5 minutes per design | canva.dev, "Create design export job", fetched 2026-09-28 |
| What a Canva 429 does | The Canva client retries a refused create up to four times, honouring Canva's `Retry-After` up to 30 s, otherwise waiting 1, 2, 4 and 8 s. If Canva is still refusing after that, or asks for a wait over 30 s, the import or export is recorded as `failed` ("Canva did not accept …; nothing was created") and the workflow reports the draft failed. So a brief overshoot is absorbed, and a longer one loses the draft | `packages/integrations/src/canva-connect-client.ts` `createWithRetry`; `canva-connect-service.ts` `createdNothing` |
| The Mac | M4 Max, 14 cores, 36 GiB. Core's container is limited to 768 MiB on the chaos stack. What Core holds per running plan was measured by the load test (section 5) | `sysctl`; `docker-compose.chaos.yml` |

Every automatic draft is imported and exported through the office's single Canva connection. On the generation path each draft makes one import and two exports (the PNG preview and the PPTX copy-and-font check), plus up to two more exports when a preview comes back stale. A slot frees when its plan is saved, so `n` slots start about `n × 60 / T` drafts a minute for a plan time of `T` seconds. Each of those drafts spends two of Canva's 20 exports a minute.

- **A burst of ten briefs** spends 20 exports whatever the slot count; the slots decide how they are spread. With 30 s plans, 5 slots put all 20 into one minute, exactly Canva's limit, with no room left for a stale-preview retry or an operator's export from the Desk. **4 slots** go in rounds of 4, 4 and 2, at most 16 exports in any minute. 3 slots peak at 12, but add a fourth round.
- **Sustained demand** at the median 30 s plan: 4 slots ≈ 8 drafts ≈ 16 exports a minute; 5 slots ≈ 20. At the fastest measured plans (about 21 s), even 4 slots would reach about 23 a minute. Sustained demand is bounded by the office's daily limits (5 automatic drafts per sender, 200 per office) rather than by the slots.

**Four slots is therefore the default: the most that keeps a burst of ten under Canva's export limit with headroom.** Five slots reach the limit exactly, and any further export in that minute (a stale-preview retry, an operator's export) then depends on the client's short retry. If Canva asks to wait longer than 30 s, that export and its draft fail. Five slots would cut the p95 of a ten-brief burst by one round (about 30 s with 30 s plans, section 5). Once a lasting Canva 429 becomes a workflow wait instead of a failure, 5 or 6 slots cost nothing but a later export. OpenAI's published limits allow several times more. On the Mac, Core's memory did not measurably change between two and five running plans in the load test (section 5).

## 3. Decision

1. **Four planning slots by default, configurable.** `HAWA_CANVA_PLANNING_SLOTS`, a whole number from 1 to 16, overrides the default; any other value keeps it (`planningSlotsFrom`). Raise it only together with the Canva export budget above, and not past 4 while a lasting Canva 429 still fails a draft.
2. **Core names the wait.** A refused brief gets 429 `PLANNING_BUSY` with `Retry-After`. The value is the time until the oldest running plan should finish, judged by the median slot time of the tenant's last 20 finished plans, and bounded to 2–15 s. With no finished plan to judge by it names the shortest wait, 2 s: a first version guessed 20 s and held the second round of an empty office back 15 s after its slots had freed (section 5) (`planningRetryAfterMs`). A refused brief makes no model call and leaves no row.
3. **The worker waits the named time.** `/canva/generate` goes through `runUnlessBusy`, the helper the studio lane already uses for `STUDIO_BUSY`. A 429 is journalled as an answer, together with Core's `Retry-After`. The worker sleeps that long, bounded to 1–30 s, and asks again with the same idempotency key, for up to 15 minutes. A busy answer that names no wait (the studio's, or an older Core) waits 25 s as before. After the window the run ends as `DESIGN_SERVER_ERROR` with code `PLANNING_BUSY`, and the requester is told once. The first try keeps its step name (`canva-create-draft`), so an invocation journalled before this change replays unchanged.
4. **A cut-off plan stops holding a slot.** A row still in `planning` three minutes after its claim (`STALE_PLANNING_MS`: twice the 90 s model timeout) is not counted. The row itself is left alone: its charge is uncertain, and settling that belongs to ADR-101's work, not here.

### Why not a true queue

A FIFO queue with tickets would need a new plan status or table, a migration, and expiry for tickets whose workflow died. That is the same stale-slot problem again, for every waiter. With the named wait, a waiter comes back within about 2 s of the moment a slot should free. The only unfairness left is which of several waiters wins a freed slot, bounded by the 15-minute window. At the measured peak of ten briefs and four slots, every brief is planned within three rounds (section 5). A queue is worth revisiting if sustained demand ever exceeds the slots for minutes on end. Canva's export limit caps the office at about 10 drafts a minute either way.

## 4. Consequences

- A burst of briefs is drafted in rounds of four rather than two, and no waiter sleeps past a free slot by more than the named wait (about 1 s in the load test).
- A burst now comes closer to Canva's per-minute export limit: 16 exports in a minute where two slots made 8. A Canva 429 that outlasts the client's short retry still fails the draft (section 2). Turning that into a workflow wait, as this ADR does for `PLANNING_BUSY`, is the natural next step and is not done here.
- `claude/mainline` rewrote the planner (ADR-101, durable planner calls) and still has the literal 2. Merging it needs this change carried into its `generate()`.
- The studio lane's `STUDIO_BUSY` is unchanged: still 2 runs, a 25 s wait, and no `Retry-After`.

## 5. Verification

Tests written first and seen failing:

- `apps/core/test/canva-design-planner.test.ts`, real PostgreSQL: refusal past the slots with `PLANNING_BUSY` and a 2–15 s `retryAfterMs`, with no model call and no row; three slots plan three at once; a plan left in `planning` past `STALE_PLANNING_MS` no longer blocks (mutation-checked: removing the filter fails it); `planningSlotsFrom` and `planningRetryAfterMs` bounds.
- `apps/core/test/canva-planning-busy-route.test.ts`: the route sends `Retry-After` in whole seconds, and none on a refusal that names no wait (fails on the old route).
- `apps/worker/test/canva-draft-workflow-planning-busy.test.ts`: the worker waits the named 3 s four times, not 2/4/8/16; one idempotency key; replay makes no Core call and asks for the same timers; waits bounded to 1–30 s; 25 s when unnamed; `DESIGN_SERVER_ERROR`/`PLANNING_BUSY` after 15 minutes.

Load test on the chaos stack (`scripts/load/run.ts --poller core`, 10 chats at once). `--plan-ms` makes every planner call take that long in the fakes; `--planning-slots` sets Core's slot count. "Before" ran in a throwaway worktree of `4f5e995` with only the harness change applied:

All runs on 2026-09-28, 10 of 10 drafts shown in every run that started. Two starts (10:56Z on the old code, 12:00Z on the new) failed before loading, at the harness's first database login (`password authentication failed for user "hawa_owner"`), and were rerun. That is a harness start-up flake, recorded separately. None had a Core or worker error line, an unmatched model call, or a paused or backing-off invocation. The Mac had production running beside the stack, as in the runbook's earlier runs. Times are from the fake Telegram's pickup of the briefs.

| Run (UTC) | Code | Plan call | Slots | Drafts shown at (s) | p50 | p95 | Core MiB, peak |
|---|---|---|---|---|---|---|---|
| 11:29–11:36 | before (`4f5e995`) | instant | 2 | 5.0 ×2, 7.0 ×2, 11.2 ×2, 19.3 ×2, 35.4 ×2 | 11.2 s | 35.4 s | 130 |
| 12:01–12:07 | after | instant | **4 (default)** | 5.3 ×4, 9.2 ×4, 9.8 ×2 | 9.2 s | 9.8 s | 150 |
| 11:52–11:58 | after | instant | 5 | 5.6 ×5, 7.8 ×5 | 6.7 s | 7.8 s | 157 |
| 11:19–11:29 | before (`4f5e995`) | 30 s | 2 | 35.2 ×2, 65.3 ×2, 125.4 ×2, 185.4 ×2, 245.6 ×2 | 125.4 s | 245.6 s | 141 |
| 11:43–11:52 | after | 30 s | 2 | 34.9 ×2, 65.5 ×2, 97.6 ×2, 129.7 ×2, 161.9 ×2 | 97.6 s | 161.9 s | 131 |
| 12:07–12:15 | after | 30 s | **4 (default)** | 35.3 ×4, 65.8 ×4, 97.8 ×2 | 65.8 s | 97.8 s | 150 |
| 11:36–11:43 | after | 30 s | 5 | 35.1 ×5, 65.8 ×5 | 50.5 s | 65.8 s | 155 |

What the runs show:

- **The old step retry idled 30 s between rounds** once its backoff reached its cap: 125 → 185 → 246 s with 30 s plans. With the named wait on the same two slots, each round follows the last by 30–32 s, the plan time plus about 1 s. That alone takes the p95 from 246 s to 162 s.
- **Four slots (the default) clear ten briefs in three rounds:** p95 98 s with 30 s plans (from 246 s), and 9.8 s with instant plans (from 35.4 s). Five slots take two rounds (p95 66 s and 7.8 s), at the cost described in section 2.
- **The first version guessed** a 20 s plan when the office had none finished, and the instant-plan run (11:12–11:19, superseded) showed drafts at 5.3 ×5 and 20.4 ×5: its second round was held back 15 s. It now names 2 s when it has nothing to judge by (decision 2), and the rerun above shows 7.8 s.
- **Core's memory barely moves with the slot count.** It peaked at 131–157 MiB whether 2 or 5 plans were in flight, against a 768 MiB limit. The Mac is not what bounds the slots. Caveat: the fakes answer from fixtures, so each in-flight request here is only as large as the chaos briefs. A real request also carries the client's exemplar and reference images, a few MiB each in base64 ^[inferred].
- **Not measured:** how many 429 answers the waiting briefs got. The saved results hold only the Desk tabs' requests, and Core's log goes with the stack.

Raw results: `packages/testkit/chaos/.run/load-core-*.json` of each run (gitignored), copied with their logs to the session scratchpad.
