# ADR-085 — Named settlement of held fixture evaluations

Date: 2026-09-27. Status: accepted for implementation.
Requirements: FR-059/060/065/079, NFR-001; sources docs/07, docs/10, docs/14, docs/17.

ADR-084 prevents duplicate uncertain model work but has no operator exit. Neither a
timeout nor a provider request ID proves non-execution or final cost. The original
call outcome and run report must remain immutable.

Add one append-only settlement per held fixture run. A currently authenticated
named office administrator must supply the exact observed ledger snapshot, a reason,
and terminal provider evidence for every pending/uncertain call: provider/support
reference, SHA-256 of evidence retained by the office, and reported final USD cost.
A provider-confirmed rejection requires zero cost. Unknown acceptance or cost cannot
settle a call. References and digests do not independently verify provider claims;
the API and Desk label these as administrator-attested evidence.

Settlement closes the run without changing its report, scores or first call outcomes.
It never sends a model request, replays paid work, promotes a model, or marks a failed
evaluation successful. A later explicitly requested evaluation is a distinct billable
run. Reads and same-action retries expose the closure; old runs cannot resume. Calls
already admitted may still record a late first outcome for audit, but no new ordinal
may be admitted for a closed run.

Use the existing tenant execution lock plus the run row lock, keyed action replay,
snapshot comparison, transaction-time named authority, FORCE RLS and immutable SQL
records. Refuse while a live execution holds its lock. Revalidate the complete call
set in SQL; operator/shared-key callers cannot append settlements. Do not persist raw
provider documents, prompts, responses, credentials, or session hashes in settlements.

This is a bounded staffed recovery operation for fixture diagnostics. Automatic
provider lookup, invoice verification, general Studio response replay, and independent
recovery/live qualification remain separate requirements. No provider API or credential
configuration changes are needed.
