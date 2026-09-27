# ADR-084 — Durable fixture evaluation admission and call replay

Date: 2026-09-27. Status: accepted for implementation.
Requirements: FR-059/060/065/067/079, NFR-001; docs/07, docs/10, docs/14 and docs/17.

Core currently holds evaluation history only in a Map and generates a fresh run on
every POST. ADR-083 stops uncertainty within a process but cannot protect a retry
after a lost response or restart. Reuse the existing eval_runs/eval_datasets tables;
add a tenant/run/ordinal call ledger and a caller-supplied action UUID.

Commit run identity and each call reservation before transport. A repeated action
with identical inputs returns or resumes that run; changed inputs conflict. Bind
replay to the fixture corpus and image hash, evaluator version, release manifest,
request hash and recorded model metadata. Serialize tenant evaluation execution and refuse a fresh run
while an earlier run is incomplete or has unreconciled paid work. No process-local
map or database-unavailable fallback may initiate evaluation model calls.

For these fixed fixture tournaments only, retain an allowlisted scoring projection
(decision, confidence, canonical corpus client/project labels, booleans and numeric
rubric fields), plus gateway receipt metadata and original response hash. Never
retain raw prompts, free-text output, arbitrary model fields or exception bodies.
The same projection is used for initial scoring and replay. This policy does not
authorize persistence of general client model output. A completed call replays its
stored projection without transport. A pending or uncertain call remains a hold;
provider acceptance cannot be inferred from a dead process. First outcomes and
admission identities are immutable. No automatic provider reconciliation is claimed.

Desk keeps the action identity through a lost response and refresh, exposes
incomplete runs, and resumes the selected run explicitly. Evaluation results remain
fixture diagnostics with admissionEligible:false; this work does not qualify
creative quality, exact pricing, provider billing, or model promotion.
