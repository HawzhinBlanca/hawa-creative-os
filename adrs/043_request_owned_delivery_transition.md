# ADR-043: Start and finish request-owned delivery through RequestLifecycle

**Date:** 2026-09-25  
**Status:** Accepted for implementation on `codex/research-grade-design-system`; no production cutover.  
**Amends:** ADR-034 Phase 2.3–2.5 and ADR-040's signed office gateway.  
**Requirements:** FR-045–FR-051, FR-060, FR-061; R07–R10.

## Context

ADR-042 lets RequestLifecycle own the first approval, but the existing Deliver route and Delivery workflow deliberately refuse a task with `request_id`. The Desk must therefore show approval as recorded while delivery waits. Reusing the legacy publisher would advance the task without advancing the request object and could send twice after an uncertain response.

## Decision

An authenticated office Deliver request carries a stable UUID action key and names the current approval. Core signs a narrow `deliver` event for `OfficeDecisionGateway`; the private RequestLifecycle object admits it only from `approved` at expected revision 3 and with the same task, revision and approval ID it recorded. Core's worker-only projection locks the request and task, rechecks the approval and selected immutable export hashes, claims a publication keyed by task and approval, and commits task `approved → publishing`, request revision 4 `delivering`, and a hash-bound receipt together. The object then starts one Delivery workflow by the deterministic publication/run ID. A retry after Core commits but before Restate acknowledges reuses the same receipt and workflow key.

The Delivery workflow may prepare only a matching request-owned publication in `delivering` under the worker credential. It rechecks the selected bytes, latest capture and pending client changes before Drive or Sheets effects. Drive, Sheets and Telegram retain their existing independent idempotency and reconciliation keys. It sends files and notice through TelegramSender; an uncertain send is surfaced to the office once and is never blindly repeated.

The workflow reports its result to the private request object, which applies one versioned Core projection for task, publication and request state. `delivered` requires confirmed archive, Sheet row and requester send state; the final projection rereads the stored Drive and Sheet receipts and matches them to the claimed package within its transaction. A reported success with missing or mismatched receipts leaves the same run unfinished for retry. Missing archive returns the request to `approved` for an explicit retry only when no requester file was sent or left uncertain; otherwise a new run is blocked for office resolution. An archived package with an unconfirmed Sheet row remains `delivering` for reconciliation. An uncertain Telegram result remains explicitly uncertain and needs office resolution; it is never shown as fully delivered. The exact state names and receipt schema are fixed in the implementation tests before a cutover.

No legacy publish, delivery-finished or direct repository call may move a request-owned task. Existing legacy requests keep their executor. The public gateway never exposes the private lifecycle handler or raw worker credential.

## Why

Approval and delivery are distinct effects. One owner and one expected-revision projection prevent Core, Desk and Restate from each deciding independently what “delivered” means. Stable publication and sender keys make a lost response recoverable without duplicating files or claiming that an uncertain Telegram send succeeded.

## Admission limits

The local implementation landed at source `f58c67b`: the authenticated Desk action, signed gateway, private RequestLifecycle claim/report, and versioned PostgreSQL projections pass synthetic integration tests. This is not production admission. Do not enable lifecycle chat flags until a real PostgreSQL/Restate kill-and-replay drill, byte read-back of Drive files, Sheet-row reconciliation, requester send evidence, operator resolution for uncertain sends, and clean-host restore pass on the candidate image. R09 evidence records the exact local checks and limits.
