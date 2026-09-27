# ADR-096 — Share daily spending admission across Studio, evaluation and voice

Date: 2026-09-27
Status: Implemented; focused qualification passed; full release gate pending
Requirements: FR-059, FR-060, FR-062, FR-065, FR-079, NFR-001

Studio migration 051 serializes only Studio charges. Evaluation requests have a
bounded per-call allowance but do not reserve office funds; voice has a separate
UTC-day counter. These paths can independently consume the same office allowance.

Extend the existing policy and PostgreSQL advisory-lock boundary, retaining its
historical table/function names. Aggregate original Studio, evaluation and voice
ledgers, with no separate mutable balance. Use database admission timestamps and
Asia/Baghdad for shared office/client/role days. Fixture evaluations consume office
and role allowance without an invented client; voice also consumes its client
allowance. Existing voice per-call and UTC-day limits remain additional constraints.

Before transport, reserve the evaluation request's full bounded maxCostUsd, bound
to the immutable request hash. ADR-093 enforces each actual provider request within
that allocation. Voice reserves its inspected-audio estimate. Database triggers
seal reservation/policy/client/role/time identities and reject direct SQL bypasses.
Voice also has a composite tenant/client foreign key: the existing office-role
permission helper alone does not establish an arbitrary client ID's ownership.
All paths share one lock, including outcome/settlement writes; existing parent/task
locks precede it. New admissions require READ COMMITTED. Preserve duplicate replay
before testing new allowance, including when the budget is now exhausted.

Only complete, finite usage evidence or definite non-acceptance can release unused
funds; missing/historical unverifiable usage stays held across midnight. Original
known overruns are never discarded. Exact evaluation/Studio attestations contribute
the higher of retained and attested cost. Voice has no provider billing-duration
receipt; received transcripts retain the estimate until separately attributed
accounting repair exists. Missing historical reservation/evidence blocks new spend
instead of inventing a zero. Existing settlement does not automatically settle
completed replies with missing usage; broader named accounting repair remains a
required follow-up before live admission.

Budget refusal stops evaluation batches without transport and routes retained audio
to manual copy review. Desk reports the shared scope and the original evaluation
allocation separately from actual usage/transport quotes. Preserve raw original
receipts and all local/manual review paths. This gate does not qualify every other
provider-egress exception, live invoices or whole-app readiness.

Verification: failing-before Core zero-allowance controls; two-connection races
across paths; role/client/office separation; database timestamp/identity guards;
prior-day unknown holds, finite terminal costs, overrun retention and settlement;
Core/voice zero-transport refusal, retained source/manual review and process-kill
recovery; source/types/Desk/security/migration/full release gates.
