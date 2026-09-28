# ADR-067: Admit captionless photos only through an exact request reply

Date: 2026-09-26
Status: accepted for implementation
Requirements: FR-011, FR-060, NFR-001, NFR-006
Sources: `docs/09_MESSAGING_AND_OFFICE_INBOX.md` §§4, 6, 8; `docs/10_WORKFLOW_RELIABILITY.md` §§1, 3, 7; ADR-060, ADR-061 and ADR-062.

## Context

A requester replying to a current revision or clarification notice with only a
photo is held even though the reply identifies its request. Inferring an owner
from an unlinked photo would contaminate other work. Treating image text as the
requester's written answer would invent facts.

## Decision

- Extend the existing single-photo admission to a captionless photo only when
  its reply message identifies exactly one current, waiting lifecycle request.
  Check the confirmed outgoing message and expected revision again in the task
  projection transaction. Unlinked photos, stale replies, albums and other media
  retain their explicit refusal or hold paths.
- Use a stable application-authored directive that says the image has no written
  instructions and must be considered within the existing brief without inferring
  factual copy. Preserve the original Telegram update and the parent's exact copy.
  This is an image submission, not a claim that the image answers every question.
- Reuse the durable hash-bound photo decision, blob retention, task file binding
  and revision receipt. Completed retries and an interrupted decision replay
  without downloading the file again, including after chat flag rollback.
- Keep source parsing shared between intake and projection, so an image cannot
  bypass these rules by arriving through the internal projection service.

## Consequences

The requester can send an image as an exact reply without repeating a caption.
No new database or workflow foundation is selected. Album collection, voice/PDF
admission, actual model interpretation and live delivery need separate evidence.
Production lifecycle flags remain off.
