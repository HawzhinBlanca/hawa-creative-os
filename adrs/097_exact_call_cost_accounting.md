# ADR-097 — Attributed accounting for exact paid calls

Date: 2026-09-27
Status: Accepted for implementation; qualification pending
Requirements: FR-059, FR-060, FR-062, FR-065, FR-079, NFR-001.
Sources: docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/10_WORKFLOW_RELIABILITY.md, docs/14_SECURITY_THREAT_MODEL.md,
docs/17_UI_UX.md and MASTER_SPEC.md.

Successful Studio replies with estimated costs, completed evaluations with missing
usage, and received or lost voice replies can retain allocations indefinitely.
Run settlement also changes recovery eligibility and cannot represent this solely
financial operation. Add exact-call cost attestations for the three existing ledgers.
Do not introduce another balance counter or a provider lookup framework.

A current named office administrator supplies terminal provider evidence, its
locally retained SHA-256, a reference, known final USD cost, reason, an exact
observed snapshot and an action UUID. SQL rechecks named authority, source identity,
snapshot and evidence. Source-specific foreign keys, FORCE RLS, parent/source locks
before the shared office spending lock, immutable revisions and keyed replay protect
the operation. A late original outcome changes the snapshot; it is never discarded.
References and digests are administrator attestations, not verified invoices.

Use the greater of original known cost, existing settlement and all attributed
costs. Terminal evidence releases only unused reservations, including prior-day
holds. A subsequent correction appends a revision; a lower amount does not silently
erase a previously retained higher charge. Desk shows the original, attested and
conservative accounted amounts separately, with disagreement visible. Reject a
non-acceptance claim when the current original receipt proves acceptance or cost.
Late contrary evidence remains visible and contributes its higher cost.

Accounting never changes a call outcome, evaluation score, run/task/request state,
workflow ownership or design approval; never sends a provider request; and never
clears an execution-uncertainty hold. Existing stopped-run recovery remains a
separate operation. Voice deduplication and its additional per-day call cap remain.
No raw evidence files, prompts, answers, transcripts or credentials enter the
accounting UI or new ledger. Paginated office-role reads expose sanitized metadata.

Verify completed/unknown costs across all three paths, prior-day release, retained
overruns, late receipts, exact replay through fresh services, conflicting actions,
stale snapshots, concurrent revisions, RLS/named authority/revocation/CSRF, SQL
immutability and direct-insert guards, run-budget consistency and Desk retry flows.
Live invoice validation, budget policy administration and typed result recovery
remain separate requirements; keep their completion status explicit.
