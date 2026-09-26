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

## Consequences

The decision receipt contains the prepared brief and Telegram update hash, not a
task. A worker or Core restart can replay the same `open` event without creating a
second task. Deliberate refusal is preferable to guessing when a message could be a
new brief or a change to an older request. Media and callback variants require their
own admission tests before broad cutover; the live flag remains off until the full
canary and recovery gates pass.
