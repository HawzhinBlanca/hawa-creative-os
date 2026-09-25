# ADR-046: Staff settlement of an uncertain requester send

**Date:** 2026-09-25  
**Status:** Accepted for implementation on `codex/research-grade-design-system`; no production cutover.  
**Amends:** ADR-043 and ADR-045.  
**Requirements:** FR-051, FR-060, FR-063; R09.

## Context

An ambiguous Telegram send keeps the request delivering and the task publishing with `REQUESTER_SEND_UNCONFIRMED`. TelegramSender will not repeat the same critical message. Staff can now see local marks and Bot API IDs, but the system offers no safe way to record what staff found in the actual requester chat. A simple retry is dangerous: Telegram does not accept an application idempotency key, and Restate may also deduplicate a reused logical key.

## Decision

Add an office-admin-only settlement action for **confirmed visible in the exact requester chat**. It is a human attestation, never described as a requester read receipt. The action requires the current request revision, one stable action UUID, the current publication and approval, the immutable requester chat ID, and one positive observed Telegram message ID for every approved file and the delivery notice. For a local `sent` mark with a Bot API ID, the observed ID must match. For an `attempted` or `uncertain` mark, the staff member must enter the message ID they found in the chat. A missing, failed or released mark cannot be settled through this action. The Desk displays the exact names and hashes and requires explicit confirmation that all items were compared in the named chat.

Core takes the request advisory lock and publication/task row locks, verifies the current ownership and `REQUESTER_SEND_UNCONFIRMED` marker, checks the exact approved package and the recorded Drive/Sheet receipts, and atomically advances the request revision, completes the task/publication, appends a user-attributed task event containing the observed IDs and package hash, and stores an idempotent lifecycle projection receipt. A repeated action with identical content returns its original result; a changed action or stale revision is refused. No send mark is edited or released, and no Telegram API call occurs.

The endpoint and Desk use the term **staff confirmed visible**. Operational reports must preserve the distinction from automatic Bot API acknowledgement and from requester acknowledgement. This action is not a substitute for a live requester receipt gate in the final programme. It allows a tightly controlled, auditable resolution of a case staff actually observed. Inconclusive cases remain open; replay needs a separate protocol with a new logical send identity and explicit duplicate-risk decision.

## Verification

Use isolated PostgreSQL and rendered Desk tests for exact scope, role, chat, artifact set, positive IDs, local sent-ID equality, stored archive receipts, expected revision, idempotent duplicate, stale/concurrent decision, and no additional Telegram send. The source release gate and traceability evidence must pass before the action is considered implemented. Keep the production pipeline flags off.
