# ADR-059: Admit new Telegram briefs through RequestLifecycle

Date: 2026-09-26
Status: accepted for implementation
Requirements: FR-060, NFR-001
Sources: `MASTER_SPEC.md`; `docs/10_WORKFLOW_RELIABILITY.md`; `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §§2.2–2.3; `plans/research-grade-upgrade-2026-09-25/PLAN.md` G2.

## Context

The worker hosts RequestLifecycle, but live ChatInbox intake has no path to its
`open` handler. The Core lifecycle mode still falls through to legacy task creation
when it sees no waiting requester decision. Enabling a lifecycle chat flag could
therefore create a task without the request owner, while an unlinked message in a
busy chat can be misread as a revision directive.

## Decision

- Core prepares a complete, versioned new-brief draft using the same client and copy
  extraction as legacy Telegram intake, but writes no task or sends no acknowledgement.
  It stores a hash-bound intake decision under the Telegram update identity so a lost
  Core answer reuses the same draft.
- A new request ID is deterministic from chat and update ID. ChatInbox journals the
  decision and sends one keyed `RequestLifecycle.open`; the request object alone
  creates and owns the task and sends its acknowledgement.
- In a chat with a waiting lifecycle request, an unlinked ordinary message remains a
  candidate requester directive. An explicit `/new` brief starts a separate request;
  its command prefix is not treated as factual design copy. A reply to a current
  lifecycle notice remains bound to that request. A stale reply never opens a new
  request by accident.
- Existing core-owned tasks remain on legacy intake. Disabling the lifecycle flag
  affects only future new requests; it does not change a request's stored owner.
- A legacy intake receipt for the Telegram update takes precedence over a new lifecycle
  decision when the chat flag changes between deliveries. The same update must not
  create a second task across executor cutover.

## Consequences

The decision receipt contains the prepared brief and Telegram update hash, not a
task. A worker or Core restart can replay the same `open` event without creating a
second task. Deliberate refusal is preferable to guessing when a message could be a
new brief or a change to an older request. Media and callback variants require their
own admission tests before broad cutover; the live flag remains off until the full
canary and recovery gates pass.

## Addendum: media ownership at the cutover boundary (2026-09-26)

A flagged photo with a caption was observed creating a legacy task because lifecycle
intake read only `message.text`. Until the lifecycle contract can carry durable media
references and the design run can read them, Core records a hash-bound routing refusal
for photos, albums, voice, audio, documents, videos and captions in a lifecycle chat,
including channel posts and edited messages. The production sender allowlist is checked
before recording a new hold. ChatInbox parks the
whole update through Core's durable dead-letter and office-alert path and sends the
requester the existing follow-up notice. Repeating the update after a flag rollback
replays the refusal; a changed payload under the same update ID conflicts. This is an
interim ownership fence, not media support. Full cutover still requires Core-owned
downloads, a retained content reference outside the Restate journal, image and voice
use in the correct request, album grouping, and process-kill tests of those paths.

The same cutover rule also applies to a stored text refusal. A stale or ambiguous
requester reply, or a blocked revision, must replay its hash-bound decision even if
the chat flag is rolled back. Otherwise the legacy intake can reinterpret a refused
reply as a new task under a different owner.
