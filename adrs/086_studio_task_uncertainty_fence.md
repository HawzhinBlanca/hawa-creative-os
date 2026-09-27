# ADR-086 — Keep Studio uncertainty across replacement runs

Date: 2026-09-27. Status: accepted for implementation.
Requirements: FR-060, FR-065, NFR-001; source docs/10_WORKFLOW_RELIABILITY.md.

A stale, failed or manually abandoned run is not proof that its provider request
was rejected. The earlier per-run ledger fence could be bypassed by requesting a
new run, resetting its budget while the original acceptance and cost stayed unknown.

Under the existing task row lock, refuse a new Studio run or planner reservation
when any Studio call for that tenant/task is uncertain. Preserve read-only replay
of an existing action. At each Studio call admission, also refuse uncertainty from
another run or a finished uncertain call in the current run. Unfinished calls in
the current run retain the existing bounded parallel execution policy.

Abandonment and admission serialize on the same task lock. Abandoned, failed and
degraded runs admit no additional requests. A transferred run permits only its
existing content-keyed parity operation. A previously admitted request can still
record its first late outcome; abandonment never rewrites the financial ledger.

This tightens the existing admission boundary without storing client response
content, changing RequestLifecycle ownership, or introducing a provider retry.
Uncertain calls still require separately attributed reconciliation; ADR-085's
fixture-evaluation settlement does not authorize settlement of Studio calls.
