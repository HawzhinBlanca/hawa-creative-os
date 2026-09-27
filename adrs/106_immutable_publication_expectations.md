# ADR-106 — Immutable publication expectations

Date: 2026-09-27
Status: Accepted for implementation; release qualification pending
Requirements: FR-047, FR-048, FR-049, FR-050
Normative source: docs/13_GOOGLE_DRIVE_SHEETS.md

## Decision and reason

Freeze one scoped publication input in PostgreSQL before calling the publisher.
It binds tenant, task, client, approval, design revision, package hash, exact file
identities/names/types/sizes/hashes, Drive destination, configured Sheet destination
and publication timestamp. SQL validates the binding to the publication/task and
hashes the payload. Update, deletion and truncation are forbidden. A retry uses
the stored input and rehydrates only the original approved bytes. Renaming a
client or changing its DNA cannot redirect or rename an already attempted archive.

Older publication rows have protocol 0; new rows default to protocol 1. Historical
expectations are not reconstructed from current DNA. An unfinished protocol-0
publication without expectations requires supervised reconciliation. Completed
historical publications retain their original receipt authority and uncertainty.

Before the first Sheet write, persist a separate immutable Sheet expectation,
including exact values and provider metadata identity. The Google adapter calls
the Core persistence adapter after verified Drive readback and before any Sheet
mutation. A persistence failure leaves the Sheet untouched and unconfirmed. An
initially configured Sheet cannot change. If no Sheet was configured originally,
the first explicit retry after configuration may bind one, preserving the existing
Drive archive and publication timestamp. Subsequent retries use that binding.
This preserves the supported missing-Sheet recovery without allowing later DNA
changes to redirect a previously attempted Sheet write.

Current Sheet receipts retain metadata ID, expected values and whole-row hashes.
The immutable per-publication expectation remains available when a later revision
updates the reporting row. Neither a publisher boolean nor a hash cell alone is
permission to replace expected input. The scheduled reconciler will compare the
current publication's original expectation with independent external observations.

## Scope and limits

The new records establish durable expectations, not proof that Google currently
matches them. Permission baselines are still unknown until actually measured.
Scheduled observations, supervised legacy migration, staffed repair, the complete
reporting schema and real provider qualification remain required. No workflow
framework or new deployable is introduced. Domain/contract code remains free of
database and provider SDK dependencies.

## Verification

Reproduce destination changes across fresh Core instances, then show frozen Drive
and Sheet IDs, file names and timestamp surviving retries. Test late Sheet binding,
rejected changed bytes/approval/scope, concurrent freeze, no Sheet mutation after
failed expectation persistence, immutable SQL hashes/RLS, protocol-0 uncertainty
and complete receipt persistence. Preserve all failed or unexecuted gates.
