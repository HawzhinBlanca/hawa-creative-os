# ADR-108: Preserve Canva creation uncertainty across sweep and retry

Date: 2026-09-28
Status: Accepted for implementation under the user's instruction to implement the lean architecture report.
Requirements: FR-060, NFR-001, NFR-020, NFR-024; R07/R21.

## Context

The previous sweeper changed old unknown Canva creation outcomes to `failed`.
The import guard excluded all failed records, allowing a fresh key to submit another
document. A status-read 404, missing/multiple returned designs, expired polling or
revoked authorization also cannot prove that the original creation had no effect.
Historical failed rows do not retain enough evidence to safely infer nonacceptance.

## Decision

Retain `uncertain` for unknown creation outcomes and stop automatic polling after a
bounded period. Record a specific reconciliation reason visible with the operation.
An explicit resume can read the original provider job and finish binding it; a fresh
key must not bypass a reconciliation hold. Do not infer nonacceptance from age,
unavailable authorization, a missing read result, or an invalid successful response.

Only an explicit dispatch refusal/not-sent classification or a matching provider
job's definite `failed` result records failure evidence permitting a new import key.
Historical `failed` creation rows without that evidence remain blocking and are
presented as uncertain. Preserve the original historical status in storage; do not
backfill invented proof or erase the prior record. An explicit status read may
reconcile a historical row when its original remote identity is available.

Updates use observed status/job identity so a stale sweep cannot demote an operation
that concurrently obtained its job or completed. Existing receipts/source bytes,
client scope and task admission remain authoritative. This changes no selected
infrastructure or workflow engine.

## Consequences and verification

Some old tasks require provider reconciliation or a native design binding. That is
an explicit retained uncertainty, not permission to create a replacement blindly.
Exports retain their separate read-only recovery semantics; this ADR's duplicate
creation invariant concerns imports and blank-design creation.

Fake-provider/PostgreSQL tests must exercise lost reply → sweep → fresh key, old
pending and unavailable jobs, legacy failed records, definite refusal/failure,
concurrent completion, and explicit recovery using the original job. No live
provider or flawless-operation claim follows from these tests.
