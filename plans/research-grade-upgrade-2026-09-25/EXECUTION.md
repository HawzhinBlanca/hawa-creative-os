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

## Current result (2026-09-26 — source `78d1cce`)

**Requester revision directive routing is implemented and locally tested:**

- **`projectLifecycleRequesterRevisionWithIntake`** (Core `lifecycle-projection.ts`): atomically persists a
  requester's revision task from the raw Telegram update text and advances the request `manual → designing` in
  one idempotent transaction. Guarded by `pg_advisory_xact_lock` on the request; has idempotency receipt and
  conflict detection identical to the office-side projection.
- **Core intake route now accepts `mode=lifecycle`**: when mode is `lifecycle` and the chat has an open
  restate-owned manual-stage request at `rev ≥ 3`, Core extracts the directive text from the update, calls
  the projection above, and returns `lifecycleAction: 'requester-revision'` with the new task ID, round,
  directive, and priorTaskId. If no matching request is found it falls through to legacy intake.
- **Worker `ChatInboxCore.intake` passes `requestId`**: the worker reads `requestId` from the journaled mode
  object (alongside `mode: 'lifecycle'`) and passes it to Core so the intake can locate the request.
- **`ChatInboxView.requestId`** stored by `setMode` so the mode journal already carries it; no extra DB lookup
  on the hot path.
- **`InboxContext.sendLifecycleDecision`**: when Core returns `lifecycleAction: 'requester-revision'`,
  `handleUpdate` calls this method, which uses `ctx.objectSendClient(RequestLifecycleApi, requestId)` to fire
  `RequestLifecycle.requesterDecision` (the VO's state machine advances to `designing` and starts the next
  design run). The call is idempotent via `chatinbox:revision:<update_id>` key.
- **292 lifecycle tests pass** (`worker + core/lifecycle`); `tsc --noEmit` clean on both packages.
- **Integration evidence**: new test `routes a requester revision directive to the open lifecycle request
  (Q/A loop)` in `lifecycle-internal-intake.test.ts` seeds a manual-stage lifecycle request in the DB,
  sends a Telegram text update in lifecycle mode, and verifies the full projection response.

**R07 reminder and notice hardening (current working tree):** An office revision emits a critical,
keyed requester notice and schedules a 24-hour reminder for that exact request revision. A replay after
state save reissues the same keys, so a worker crash cannot silently drop the notice or timer. The reminder
checks the current revision and stage and uses the critical sender's PostgreSQL send mark. Office comments
are sent as literal text, avoiding Telegram HTML parsing of untrusted content. ChatInbox now preserves its
lifecycle mode and request ID after both handled and parked updates; a requester decision send is awaited
inside the Restate handler, so a failed dispatch replays from its journaled Core answer. Focused worker/Core
tests: 3 files / 34 tests passed; worker TypeScript passed. This is local proof, not a live delayed-send drill.

Prior milestones still hold: ChatInbox cutover (`1902c32`); multi-round journey (`f25ebf1`); delivery routes;
the last full suite passed 421 files / 3,237 tests before the reminder changes.

## Next useful milestone

1. **Complete R07 Q/A**: route `NEEDS_CLARIFICATION` questions into lifecycle chat, bind answers to the
   waiting request, and prove restart, duplicate, late-answer and reminder behavior end to end. Resolve
   the per-chat request pointer for a second open request before canary: `setMode` currently retains its
   first request ID, so another request in the same chat has ambiguous answer routing.
2. **Final exports and provider boundaries**: qualify R11–R19 exports and R20–R23 provider boundaries.
3. **Canary & admission**: deploy only after a coherent release gate, then run live recovery and blind human
   creative-quality acceptance. No current source or local test result establishes production admission.
