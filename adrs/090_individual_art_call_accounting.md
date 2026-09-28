# ADR-090 — Account for each art generation and verification request

Date: 2026-09-27
Status: Accepted for implementation; qualification recorded separately
Requirements: FR-059, FR-060, FR-062, FR-065, FR-079, NFR-001

## Context

The Studio art wrapper admits one call, but the provider can generate two images
and request two paid vision verdicts. Only image costs reach the aggregate
receipt. The vision adapter also treats a missing boolean as a clean verdict,
has no timeout, and its caller swallows unknown acceptance as a procedural
fallback. Therefore the ledger cannot support meaningful pre-dispatch spending
reservations until it represents the actual paid requests.

## Decision

Keep the bounded two-attempt art controller. Inject the existing ledger-backed
text client for vision and admit/finalize each image attempt separately. Every
request competes for the existing call/spend limits before dispatch. Record image
tokens, provider metadata and the returned image hash when available. Never
manufacture a provider receipt ID when it is absent. Procedural rendering has no
paid-call entry. The art result aggregates image and vision costs for reporting;
only individual receipts update the run budget, avoiding double counting.

Use the existing bounded structured text adapter for vision. Validate the verdict
at runtime: a missing/invalid boolean or explanation cannot pass the image. A
definite verifier refusal can select a reported procedural fallback; unknown
acceptance, budget/authority refusal and local accounting failures must stop the
controller. They cannot authorize another image request or a clean result.

## Alternatives and consequences

Reserving an aggregate guessed art price would preserve hidden requests and
unattributed unknown outcomes. Removing verification would weaken admission.
Per-request accounting reuses existing storage and task locks, needs no migration
or new framework, and permits future reservation/recovery at the real boundary.

Historical aggregate receipts remain immutable. This change does not reconstruct
their missing vision cost or establish an invoice ceiling. Conservative USD
reservation bounds, role/office/day caps and typed completed-stage recovery remain
required work under R20/R21. Provider price research cannot turn an operator
estimate or an auto-quality image into a proven maximum charge.

## Verification

Prove admission before every transport, separate image/verifier receipts, exact
budget aggregation, refusal at the last call slot, no replay/fallback after a lost
vision response or failed accounting, strict malformed-verdict rejection, and
durable PostgreSQL accounting. Record both initial failures and final results in
R21 evidence. No live provider charge or production rollout is implied.
