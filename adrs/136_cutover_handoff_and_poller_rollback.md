# ADR-136 — Requests from before the lifecycle cutover, and rolling the poller back

Date: 2026-09-28. Status: deployed 2026-09-29 00:31 +03; **partly superseded by ADR-135** (2026-09-29,
see "Reconciled with ADR-135" at the end): the Core-poller rollback and the 48-hour new-Core-task rule
are gone; the handoff of Core-owned updates stays.
Requirements: FR-004, FR-060, NFR-001, NFR-013. Normative sources: MASTER_SPEC.md,
docs/10_WORKFLOW_RELIABILITY.md ("Legacy delivery cutover pin"), infra/docker/README.md,
runbooks/20_architecture_operations.md. Builds on ADR-052, ADR-059, ADR-065, ADR-113/114, ADR-129
and ADR-130.

## Context

On 2026-09-28 at about 20:55 production switched to `HAWA_TELEGRAM_POLLER=worker` with
`HAWA_LIFECYCLE_CHATS=*`. Every chat then reached Core's intake through ChatInbox and the lifecycle
routing, including chats whose requesters still had Core (legacy) drafts, change prompts, questions
and delivered files in front of them. The newest production dump (predeploy 18:13Z, read on a scratch
database of the test server, counts only) held 111 Telegram tasks in 15 chats, all pinned `core`,
and no lifecycle request. The rules of ADR-052 and ADR-059 say those requests finish on legacy intake
and Core delivery. Three places did not keep that promise, and a fourth appeared on rollback:

1. **A Telegram reply to a Core message was refused.** In a lifecycle chat, a reply whose target is
   not a recorded lifecycle notice was answered "That design is no longer waiting for changes"
   (`STALE_REQUEST_REPLY`), even when the chat had no lifecycle request at all. Replying to the draft,
   to the "What should change?" prompt, to a clarification question or to a delivered file is how
   legacy requesters ask for changes.
2. **A Core button press could become a lifecycle revision.** A callback query carries its data
   (`rq:ok:<task>`) as text. In a chat where a lifecycle request waited for the requester, the press
   was projected as that request's revision directive, a paid revision reading "rq:ok:…".
3. **Chats with Core history never reached the lifecycle.** An ordinary brief opened a lifecycle
   request only when the chat had no Core-pinned task ever, and nothing tells requesters about `/new`.
   All 15 production chats had Core history.
4. **Rolling the poller back to Core stranded lifecycle requests.** Core's own poller hands every
   update to legacy intake. A requester's reply to a lifecycle request waiting for it became a new
   Core task queued in the Desk, and the request kept waiting for a reply it would never get.

## Decision

- **Core-owned updates stay with legacy intake** (`coreOwnedUpdate`,
  `apps/core/src/services/lifecycle-chat-target.ts`). In a chat the lifecycle serves (flag or ChatInbox
  mode), Core's intake gives an update to legacy intake before any lifecycle routing when it is
  a button press (lifecycle notices carry no buttons); a reply whose quoted text, caption or buttons
  name a Core-pinned task of this chat (legacy intake's own reading of a reply); a reply to a message
  the outbox sent for a Core-pinned task of this chat (by the Telegram message ID of its send mark); or
  any reply in a chat with Core history and no lifecycle request. A reply to a lifecycle message,
  `/new`, and a reply to an unknown message in a chat that has lifecycle requests keep the lifecycle's
  routing and its refusals.
- **Old Core history no longer holds a chat off the lifecycle.** An ordinary new brief needs `/new`
  only while the chat has a Core-pinned task created in the last 48 hours, the window in which legacy
  intake reads an unlinked message against the chat's designs (`telegram-intake/replies.ts`). Such a
  brief still goes to legacy intake unchanged; there is no refusal to explain.
- **Core's poller keeps lifecycle chats with ChatInbox** (`apps/core/src/services/polled-lifecycle-route.ts`).
  When Core polls, an update from a chat that has any Restate-owned request is sent to that chat's
  ChatInbox through Restate's ingress with the worker poller's key `tg-<update_id>`, the same rule as
  ChatInbox's own "lifecycle mode never reverts". Every other chat keeps legacy intake. While Restate
  does not take the update, it is asked for again and, after five failures, dead-lettered with the
  office alerted, as any intake failure is; it is never given to legacy intake.

No migration. Delivery pins (ADR-052), receipts and ChatInbox are unchanged.

## Consequences

A rollback (`HAWA_TELEGRAM_POLLER=core`, `HAWA_LIFECYCLE_CHATS` empty) now leaves lifecycle requests
with their owner: the Desk approves and delivers them as before, and their requesters' replies reach
them through ChatInbox on whichever worker colour Restate routes it to. Rolling back therefore does
not take lifecycle chats off Restate; it stops new chats from joining. A Restate outage longer than
about 30 s after a rollback dead-letters updates from lifecycle chats instead of letting legacy intake
guess. An unlinked message in a chat that has both a lifecycle request and recent Core history keeps
its earlier routing (ADR-130 does not cover unlinked words either).

## Acceptance

Core intake and poller tests on the isolated test database (`apps/core/test/lifecycle-cutover-handoff.test.ts`),
red before the fix, and the chaos scenarios R10.H1 (handoff) and R10.K1 (rollback and roll forward),
which deploy the configuration change the way `deploy.sh` does. Evidence:
`plans/lean-design-implementation-2026-09-28/R10_HANDOFF_ROLLBACK_PROOF.json`.

## Local qualification — 2026-09-28

Unit tests first, against the unchanged source: the six intake cases failed five (the stale-reply
guard for an unknown message passed), the three poller cases failed two (a chat without a lifecycle
request stayed on legacy intake). With the fix all nine pass; twelve affected Core test files pass
150 tests.

The chaos scenarios ran twice from the same harness: once on images built from the unchanged Core
source, once on the fix. Before the fix R10.H1 held 65 of 75 checks (the change-prompt reply, the
clarification answer and the photo reply to a delivered file were refused as stale replies; an
ordinary brief next to 49-hour-old Core history stayed legacy) and R10.K1 49 of 52 (after the poller
rollback the requester's reply became Core task `332a8d72…` queued in the Desk, the request stayed at
rev 3, and no ChatInbox invocation took the reply). With the fix R10.H1 held 75/75, R10.K1 52/52 and
R10.K2 17/17: 30 Telegram updates, every post-switch update one completed ChatInbox invocation
(16/16, including one read while Core and the new colour both polled and one while both polled during
the rollback), no update dead-lettered or making two tasks, 80 requester sends with no duplicate, the
held design and the held delivery each finishing once on the colour they started on before its drain.

Not executed: production (no deploy, no SQL), a lifecycle `awaiting_answer` question (no Studio
fixtures), real Telegram's 409 between two pollers (the fake serves both), native recovery of the held
revisions, and Restate backup and restore.

## Reconciled with ADR-135 — 2026-09-29

ADR-135 (every Telegram chat lifecycle-owned; the old intake only finishes its own requests; Core
never polls) was written in parallel from an older base and adopted on top of this ADR. What of this
ADR remains:

- **Kept: the handoff of Core-owned updates** (decision 1). Its reading of which updates belong to an
  old request is the one both ADRs now use (`legacyOwnedUpdate`, moved from
  `lifecycle-chat-target.ts` to `apps/core/src/services/legacy-telegram-routing.ts`, with "legacy"
  read as ADR-135 reads it: a Telegram task RequestLifecycle does not own). It was kept over ADR-135's
  narrower reading because its tests and `R10.H1` cover replies ADR-135's missed: to a delivered file
  and to a prompt that names no task. Legacy intake now takes these updates in its finish-only scope.
- **Replaced: the 48-hour rule for new briefs** (decision 2). A brief next to recent Core history no
  longer starts a Core task. It goes to the old intake only when the chat's newest request of the last
  48 hours is an open legacy one, and that intake continues that design or asks for `/new` (ADR-135).
- **Removed: Core's poller forwarding lifecycle chats to `ChatInbox`** (decision 3,
  `polled-lifecycle-route.ts`). Core never polls, so it was unreachable. Rolling back is deploying the
  previous release with `HAWA_TELEGRAM_POLLER=worker` and `HAWA_LIFECYCLE_CHATS=*` kept, not switching
  to Core's poller (infra/docker/README.md, runbooks/20_architecture_operations.md).
- The chaos scenarios were converted accordingly: `R10.H1` makes its old requests on the previous
  release and deploys this one; `R10.K1` rolls this release back to the previous one and forward;
  `R10.K2` checks that the emptied chat list changes nothing. Results:
  `plans/lean-design-implementation-2026-09-28/RECONCILIATION_PROOF.json`.
