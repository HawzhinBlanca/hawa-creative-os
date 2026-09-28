# ADR-058: Anchor lifecycle question reminders to confirmed sends

Date: 2026-09-26
Status: accepted for implementation
Requirements: FR-060, NFR-001
Sources: `MASTER_SPEC.md`; `docs/10_WORKFLOW_RELIABILITY.md`; `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` §§2.3, 2.6–2.7.

## Context

R07 initially scheduled question reminders when Core projected `awaiting_answer`.
The Telegram question may be delayed, refused, or uncertain. Projection time is not
proof the requester saw a question. The legacy SQL reminder scanner also lacked a
request-ownership exclusion, allowing two schedulers to consider one task.

## Decision

- Keep the question and its request revision durable at outcome projection, but leave
  `question_asked_at` empty until TelegramSender commits a `sent` mark with a positive
  Telegram message ID.
- The sender emits one keyed internal `questionSent` event after that mark. Core checks
  the exact send mark, current request revision/task, and persisted question before
  recording the mark's timestamp. RequestLifecycle then schedules day-1 and day-5
  reminders at the next 09:00–20:00 Erbil office moment relative to that timestamp.
- Use the existing request revision, question ID, and Restate send keys to suppress
  duplicate and stale reminders. A send that is uncertain or refused starts no timer.
  Existing delayed ticks from an older worker retain their stage/revision guard.
- Exclude request-owned tasks from the legacy SQL reminder queries. Make
  TelegramSender private to Restate callers: all repository call sites use internal
  object clients, and a public caller must not forge a question send callback.

## Consequences and verification

The sender-to-request callback adds one Core receipt read/write and one Restate
message for confirmed questions. A lost Core response repeats under the same send
mark; a crash after state storage reschedules under the same timer keys. The office
must reconcile uncertain Telegram sends, which cannot start an automatic reminder.
Local database, sender and lifecycle tests establish these boundaries; deployed
process-kill and live Telegram evidence remain separate admission gates.
