# ADR-087 — Attributed settlement of stopped Studio calls

Date: 2026-09-27. Status: accepted for implementation.
Requirements: FR-060/065/067/079, NFR-001; sources docs/10, docs/14, docs/17 and MASTER_SPEC.

ADR-086 correctly holds a task across replacement runs, but leaves no staffed exit
when the provider has supplied terminal evidence. Add append-only settlements for
all currently unresolved calls in a stopped Studio run. Preserve the original
call rows, requested inputs, run status, diagnostics and budget.

A currently authenticated named office administrator supplies a stable action UUID,
exact observed snapshot, reason, and a terminal provider/support reference, retained
evidence digest and known reported final cost for each unresolved call. Confirmed
non-acceptance requires zero cost. These are administrator attestations, not
machine-verified invoices. No raw client prompts, provider responses or evidence
files are retained by this operation.

Only abandoned, failed, degraded or transferred runs qualify. Stop an active run
through its existing owner before settlement. The financial-evidence endpoint does
not mutate a task, request, run, approval, Canva design or workflow owner, and never
starts or resumes generation. RequestLifecycle still owns any next workflow action.
Transferred runs can have later, distinct parity calls; evidence covers exact call
IDs, never future requests. Their existing content identity still refuses replay.

Serialize on the task row used by call admission and abandonment, then lock the run
and calls. Recheck named authority in the transaction and SQL trigger; retain
FORCE RLS, actor attribution, immutable receipts, exact coverage and keyed replay.
Calls admitted earlier may still deliver their first late outcome. A terminal
provider attestation can precede that local receipt; the original receipt and the
later attestation remain separate, with any disagreement visible to operators.
Settlement itself cannot prove a missing design result or release publication QA.

New paid work checks only unresolved calls without settlement evidence. It remains
an explicit, separately billable action subject to task eligibility, run closure,
budgets, current references and workflow ownership. General response replay is
still unavailable; do not silently re-run a paid stage or label settlement a pass.
