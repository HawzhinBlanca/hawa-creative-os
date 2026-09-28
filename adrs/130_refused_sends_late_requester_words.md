# ADR-130 — Refused sends, late requester words and spent Deliver keys

Date: 2026-09-28. Status: implementation; locally qualified, not deployed.
Requirements: FR-004, FR-051, FR-060, NFR-001, NFR-020, NFR-024. Normative sources:
MASTER_SPEC.md, docs/09_MESSAGING_AND_OFFICE_INBOX.md, docs/10_WORKFLOW_RELIABILITY.md.
Builds on ADR-034 (RequestLifecycle on Restate) and ADR-046 (uncertain requester sends).
Phase 4 adversarial review findings 22, 13 and 19, verified at `7b8de71e`.

## Decision

**Refused sends (finding 22).** TelegramSender writes `attempted` before a critical send.
When Telegram definitely did not take the message (429, a pre-connection failure, an
unknown refusal or a 4xx) and the `failed` mark cannot be written, the attempt no longer
throws with `attempted` left behind. It journals `not_sent` with the wait. A separate
step writes `failed` only over this attempt's `attempted` mark and throws until Postgres
takes it. The handler then waits (Restate's durable sleep) and runs a new attempt, or
answers `refused`. When the mark write succeeds inside the attempt, the earlier path is
unchanged: a RetryableError with retry_after, or a plain retry. A 5xx, a lost answer or an
invalid receipt stays uncertain, is never resent and alerts the office once. A process
that dies after Telegram answered and before that answer was journaled still leaves
`attempted`: nothing durable says it was refused, so it remains uncertain and visible.

**Late requester words (finding 13).** A reply to a lifecycle message of a request that is
in review, approved, delivering or delivered (the first draft at rev 2 included) is no
longer refused as a stale reply that keeps nothing. Core stores the words with the request,
task, revision and stage under the update ID, before answering, and replays that decision
for the same update. The office chat receives a keyed plain-text alert quoting them
(`notify.office:late-change:<request>:<update>`); the requester is told the words were not
applied and that the office was told, or only that they were saved when no office chat is
configured. A request designing again, or a reply that matches a waiting request, keeps
its earlier routing. Photo replies keep the caption; the photo stays in Telegram and a
note says so.

A new request-owned Deliver action is held with `409 LATE_REQUESTER_CHANGE` and the
unacknowledged words until an office member acknowledges each one in the same action.
Core records who acknowledged, with the action key. The guard is in Core's Desk delivery
route, the only entry that starts request-owned delivery, and reads the change receipts
that are written before the requester is answered. A replay of an action that already has
a request receipt is not held again. RequestLifecycle, its signed event and the gateway
are unchanged. A delivery already running when the words arrive is not stopped; the alert
says so. Words sent without a reply, and replies to delivery files or notices, are not
covered by this decision.

**Deliver keys (finding 19).** The Desk keys a request-owned Deliver reservation by user,
task, approval, task version and, when present, the acknowledged changes. A press whose
answer was lost retries with the same ID. Once that delivery moved the task on (started,
then failed back to APPROVED) the next press is a new action instead of the spent one.
A late-change refusal releases its reservation, because Core asked for no delivery.
RequestLifecycle replay semantics are unchanged; Core already answers a replay whose
delivery ended in `approved` with `DELIVERY_RETRY_REQUIRED`.

No migration: receipts and acknowledgements use the existing `hawa.inbox_events`
uniqueness (`lifecycle_chat_routing`, `lifecycle_late_change_ack`).

## Acceptance

Fake object context with a journal that records an entry only when a step returns,
retries thrown steps by replay, and crashes before or after every recorded entry; real
isolated PostgreSQL send marks with an injected outage. Refused sends are retried and
sent once each; a 4xx is refused and marked `failed`; a 5xx stays uncertain and alerted
once; a lost first answer stays uncertain and alerted. Core intake on isolated PostgreSQL
keeps words for each late stage, replays them, refuses changed content under the same
update and creates no task. Desk delivery is held, rejects an unknown acknowledgement,
records the acknowledging actor, and is held again by a newer change. The Desk shows
the words, retries with a fresh key after acknowledgement, and uses a fresh key after the
task version moved. No live Telegram, Restate server or deployment.

## Local qualification — 2026-09-28

Red runs first. Sender: 8 of 38 failed (the 5xx guard already passed). Desk Deliver key:
the one new case failed. Late words across Core intake, delivery and ChatInbox: 10 of 108
failed (the designing guard passed). Desk late-change prompt: both new cases failed. One
further intake case (captioned photo reply) was added after the fix and passed.

Final affected run: 13 files, 222 passed, 0 failed, 0 skipped. Source, scripts and 533
strict test roots type-check; any ceiling, provider egress and security scan pass. The
full suite, run once before the photo case and the documentation edits, gave 532 files,
4471 passed, 8 failed, 60 skipped. The same 8 failures in 7 files reproduce on
`7b8de71e` without this change (route inventory, migration lists, blob references,
planner accounting, Studio ledger and release manifest); none touches these paths.

Limits: the journal is a test double of Restate, not the Restate server; the outage is an
injected transaction failure; there is no process-kill drill, live Telegram call, browser
run of the Desk dialog or deployment. A `sent` mark that cannot be written after a
successful send still answers uncertain and alerts the office, as before.
