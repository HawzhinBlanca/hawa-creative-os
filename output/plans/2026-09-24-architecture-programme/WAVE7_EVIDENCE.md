# Wave 7 evidence (2026-09-25): Phase 2.3 RequestLifecycle, 2.4 office decisions, the load test and the runbook

Merged into `claude/reliability`: `worktree-wf_e8db9031-310-1` (the chain, 7 commits, 8b0d140…6269ef4) and `worktree-wf_e8db9031-310-2` (5e64ae3). Each step was implemented, reviewed by a separate agent that re-ran the suite and the chaos scenarios, and fixed where the review found a blocking defect. Production is unchanged until `HAWA_LIFECYCLE_CHATS` names a chat (default empty).

## The chain

| Step | Commits | Review | Blocking defect found and fixed |
|---|---|---|---|
| 2.3A foundations: contracts, pure state machine (`packages/domain/src/request-lifecycle.ts`), office hours, migration 023 (`hawa.requests`, `tasks.request_id`, `hawa.lifecycle_projections`, guard trigger, RLS, grants), Core's projection endpoint `/v1/internal/lifecycle/:id/project` | 8b0d140, e8169f4, d5a884c | fix | A retried design outcome projected under a new key, got 409 AHEAD, and the request stayed in `designing` forever. Fixed: the outcome is keyed by run and replays the first projection's ops. |
| 2.3B worker: RequestLifecycle Virtual Object and DesignRun, fake object context for crash-replay tests, shims list | 5fb37d2 | pass | — |
| 2.3C routing: intake decide mode, ChatInbox routes lifecycle chats to RequestLifecycle, legacy paths refuse lifecycle-owned tasks | 736b0e9, 3904fe0 | fix | A no-client brief in a flagged chat used up the sender's daily automatic-draft allowance. Fixed with the daily cap, instruction-only messages, rollback routing and unanswered buttons. |
| 2.4 office decisions through RequestLifecycle, Desk action ids (Idempotency-Key), lifecycle view on GET /tasks/:id | 6269ef4 | pass | — |

Chaos scenarios run by the reviewers (every invariant held):
- 2.3A: R1.0 14/14 (13.3 s), L2.0 18/18 (13.4 s).
- 2.3B: R1.0 14/14, L2.0 18/18, L3.0 13/13, L3.K7b, L3.K6, L3.K8 13/13 each (worker killed at `worker.rl.after-project`, Core and Restate kills).
- 2.4: L4.S7.0 23/23, L4.S7.DBL 23/23 (double click gives one approval), L4.S7.K14 24/24 (Core killed after the lifecycle accepted), L4.S7.OLD 22/22 (approving an old round during a change is refused, 409 CHANGE_PENDING), L4.S8.0 and L4.S8.K15–K18 29/29 each (Core, worker, Postgres or Restate killed between the two delivered files).

Known gaps, stated by the implementers and reviewers (a follow-up wave takes them):
- Picture briefs, albums and picture replies from flagged chats still take Core's path (`request_id` NULL); the lifecycle does not take pictures yet. So no photo bytes enter Restate.
- A draft or question Telegram refuses (400/403) produces no `messageSent`, so reminders and the 14-day expiry are never scheduled for it.
- Core's legacy redrive of a lifecycle-owned task tells the requester a design started; the worker then refuses it silently.
- `OutboundMessage.kind` gained `callback_answer` (a new value on an existing field, against payload rule 1): matters only on a rollback to an older TelegramSender.
- Office cancel in stage `approved` or `delivering` leaves the lifecycle and Postgres disagreeing (no legal task move exists).
- The Desk keeps action ids in memory; a reload after an accepted-but-unanswered press makes a new id.
- The AHEAD reconciliation after a Restate restore (2.6 drill) can now be exercised; it has not been yet.

## Load test and runbook (Phase 4 preparation)

`scripts/load/run.ts` on the chaos stack: 5,000 seeded tasks, three real Desk tabs (App, query cache, API client, event stream in jsdom), 10 chats briefing at once.

| | Core poller | Worker poller |
|---|---|---|
| Brief to first draft p50 / p95 | 11.5 s / 35.7 s | 11.3 s / 35.4 s |
| GET /v1/tasks p95 per page (through proxy) | 66.9 / 54.3 ms | 49.1 ms |
| Requests per idle tab per minute | 38 (0 list reads) | 38 (0 list reads) |
| Errors | none | none |

- The draft tail comes from Core planning at most two designs at a time (`canva-design-planner.ts`, 429 PLANNING_BUSY with 2/4/8/16 s retries), not from the poller.
- 36 of the 38 idle requests were the Canva panel's 5 s poll; fixed on this branch in ecc9af7 (5 s only while Canva or the planner works, otherwise 60 s, plus a refresh on the task's live event). Not re-measured yet.
- `runbooks/20_architecture_operations.md`: blue/green and stuck drains, paused invocations, the Phase 2 flags and rollback, one request's logs, the file store, per-file test databases, the chaos suite, the load test. Every command block names where it ran; `scripts/load/test/runbook.test.ts` enforces that and forbids production names.

## Gate on the merged branch (lead)

- Merge conflicts: `packages/testkit/chaos/chaos.test.ts` (imports and the scenario options of 2.6's restore drill and 2.3's lifecycle chats, united) and the chaos compose comment on HAWA_WORKER_TOKEN (the duplicate key was removed on both sides).
- `pnpm build` 0; full suite (`HAWA_TEST_WORKERS=4`): 425 files passed, 1 failed, 4 skipped; 3,277 tests passed, 1 failed (r11-release-gate test 1, which needs the release manifest), 81 skipped. Typecheck and lint clean; explicit any 976 of 1,053.
- Migration 023 rehearsed on tonight's nightly dump restored into a scratch database on the test server (`hawa_drill_mig023_*`, dropped): applied in 0.62 s with 001–022 verified; 1,612 tasks, 0 with a request, 0 requests, 0 projections afterwards.
- Full chaos suite on the merged branch, one run per poller (lead, 2026-09-25 05:10-06:05):
  - Core poller (default, production's): 29 passed, 2 failed, 37 skipped (worker-poller scenarios), 942 s, peak 836 MiB. The failures are the documented legacy baselines (WAVE3A_EVIDENCE.md): R1.K14 (Core killed during Deliver leaves the task in `publishing` until Deliver is pressed again; fixed on the Delivery workflow path, L2.K14 passes) and R4 (chat B waits 31 s behind chat A's 30 s download; fixed by the worker poller).
  - Worker poller: 63 passed, 4 failed, 1 skipped, 1,899 s, peak 898 MiB. R1.K14 is the legacy baseline. Three lifecycle scenarios that passed when run alone failed in the full run:
    - L3.R3.D and L3.R2.D2 assume the blue colour is live, but an earlier scenario left green live (a harness ordering defect).
    - L3.R2.D1: `telegram_classifier` ran twice for one message after Restate, the worker and Core were killed around a reminder. A paid call twice (a few cents) on a flagged chat under a triple kill.
  - All three need `HAWA_LIFECYCLE_CHATS` set, which production does not, so they block enabling the flag, not deploying the code. They are in wave 8b's first step.
