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

## Current result (2026-09-26 — source `1902c32`)

**ChatInbox per-chat mode cutover is now fully implemented and tested:**

- **Per-chat mode flag (`ChatInboxView.mode`)**: once a chat is switched to `'lifecycle'`, the exclusive
  `setMode` handler stores the flag on the inbox object and it never reverts. Existing inbox fields are
  preserved on upgrade from legacy.
- **`handleUpdate` reads mode from state**: the mode is read inside a journaled `ctx.run('mode', ...)` step,
  so any Restate replay — across all colour shifts — sees the same value that was recorded on the first run.
- **`RequestLifecycle.open` wires the cutover**: both `openManualRequest` and `openAutomaticRequest` call
  `ctx.setChatMode?(chatId, requestId)` after persisting the lifecycle state, using an idempotent
  fire-and-forget `objectSendClient(chatInbox, chatId).setMode(requestId, ...)` with a stable key.
- **Bug fix: `recordDesignFinished` replay detection**: the generalized `prior.rev >= nextRev` check was
  always false (prior.rev = nextRev - 1). Fixed to `prior.outcome?.eventId === event.eventId`, which
  correctly detects a crash-after-set replay at any revision round.
- **16/16 chat-inbox tests pass** (12 existing + 4 new `setMode` tests covering: fresh chat, idempotency,
  field preservation on legacy upgrade, and `handleUpdate` reading `'lifecycle'` from state).
- **233/233 worker tests pass**; `tsc --noEmit` clean.

Prior milestones still hold: multi-round journey integration-proved (8 tests, commit `f25ebf1`); delivery
routes implemented and covered; full suite 421 files / 3,237 tests green.

## Next useful milestone

1. **Q/A loop**: route clarifying questions from the design studio back to the requester via the lifecycle chat.
2. **Canary & admission**: full canary deployment and blind human admission acceptance tests.
3. **Final exports and provider boundaries**: qualify R11–R19 exports and R20–R23 provider boundaries.



