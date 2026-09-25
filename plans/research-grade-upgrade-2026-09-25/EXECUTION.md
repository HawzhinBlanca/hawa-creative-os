# Completion checkpoint

Updated 2026-09-26 after the user requested faster, more economical completion.
Branch: `codex/research-grade-design-system`. Scope and acceptance remain in `PLAN.md` and `WORK_ITEMS.csv`.

## Working method

- Finish connected user journeys with their failure recovery and acceptance evidence. Keep the existing architecture.
- During implementation, run the affected unit, integration and failure tests. Run the full required release checks at a coherent milestone before qualification or deployment; repeat them for concrete new risk or changed code.
- Batch source, tests, traceability and one concise evidence update. Seal a release candidate once it is actually ready for that gate. Do not create another seal solely to rephrase status.
- Read this checkpoint and the relevant source/evidence sections on continuation. Use scoped searches and short logs. Maintain the historical evidence without copying its whole history into every update.
- Keep engineering, live-operation and human-quality acceptance separate. Complete available engineering while real corpus preparation and human review remain pending; no synthetic result substitutes for them.
- Reuse fixtures, the existing Restate workflow and the pinned dependency stack. Add a dependency or redesign only when a measured need justifies it.

## Current result (2026-09-26 — source `f25ebf1`)

The multi-round request lifecycle journey is now integration-proved from end to end:

- **Revision lifecycle generalized**: `DesignRunInput.round` accepts any ≥0 value; `RequestLifecycle` accepts
  arbitrary revision rounds instead of just a first-review-only path.
- **Requester revision implemented**: `projectLifecycleRequesterRevision` (Core projection) and the
  `/internal/lifecycle/:id/requester-revision` route (HTTP) advance `manual(rev3) → designing(rev4)` while
  claiming the new task atomically under the request; idempotency-key replay returns the same result.
- **`recordRequesterDecision` (Restate VO)**: handler wired, starts a second design run with the new round.
- **Full journey E2E integration test** (`lifecycle-full-journey.test.ts`, 8 tests):
  `open(1) → design-outcome(2, in_review) → office-revise(3, manual) → requester-revision(4, designing)
  → design2-outcome(5, in_review) → office-approve(6, approved)`
  Covers happy path, idempotent replay, stale-rev, wrong-priorTask, already-owned-task, bad-payload,
  office-approve after revision round, and monotonic `lifecycle_projections` revisions.
- **57/57 lifecycle tests** pass across all lifecycle test files; **75/75 broader lifecycle+delivery
  regression** pass; source suite **421 files / 3,237 tests** pass (3 release-gate files expected unsealed).

Delivery-start and delivery-finished routes are fully implemented and covered in `lifecycle-office-desk-bridge.test.ts`
(approval → delivery-start → delivery-finish multi-run with receipt verification, ARCHIVE_UNCONFIRMED handling,
and Drive reservation atomicity). ChatInbox still routes legacy; no lifecycle flag is enabled in production.

## Next useful milestone

Complete the ChatInbox cutover path: implement the per-chat lifecycle flag read in `handleUpdate` so the
poller can switch individual chats from legacy mode to request-lifecycle mode. Then close the question/answer
loop (clarifying questions from the design studio back to the requester). Then run the full canary deployment
and blind human admission acceptance.

Then qualify client-general final exports (R11–R19), finish the remaining provider boundaries (R20–R23), and
run the canary, recovery and blind human admission work (R24–R27). All original acceptance criteria stay in
force. The deployed build and new design flags have not changed.
