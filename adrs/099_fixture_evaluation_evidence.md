# ADR-099: Source-bound fixture evaluation evidence

Date: 2026-09-27
Status: Accepted; qualification pending
Requirements: FR-056, FR-057, FR-060, FR-065, FR-079

## Context

Desk displayed invented case passes, model scores, latency and canary states.
Persisted fixture reports only supplied aggregate counts. Visual scoring supplied
passing numeric defaults when the model omitted optional rubric fields. Browsing
the RTL corpus incorrectly appeared to run its cases, although the fixed runner
does not execute that corpus.

## Decision

Keep the existing PostgreSQL evaluation ledger and bounded gateway. Add additive
case outcomes and dataset byte hashes to its saved report. Distinguish passed,
failed, not executed and unreported outcomes; missing visual scores yield no
complete pass rate. Bump the replay protocol because scoring semantics changed.
Previously completed reports remain immutable and aggregate-only.

Use one allowlisted dataset reader for actual counts, unique case IDs and source
hashes. Unknown IDs return 404; unreadable datasets remain unavailable. Desk binds
case outcomes to the selected saved run and exact source hash. It reports recorded
suite totals and call receipts, with no inferred model admission or latency.
Dataset browsing does not change the fixed tournament's execution scope.

These are synthetic fixture diagnostics: label-derived retrieval, four copy checks,
synthetic visual geometry and five attack-pattern checks. They cannot establish
native Canva editability, a held-out model ranking, human quality or RTL admission.

## Verification

Prove missing-score behavior, held/unexecuted cases, hash mismatch, legacy reports,
dataset errors, actual tab interaction, stale-read rejection and durable replay
without additional provider calls. Record failures and final gates in the proof.
