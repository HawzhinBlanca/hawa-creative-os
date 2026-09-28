# ADR-088 — Admit Studio calls against the durable call ledger

Date: 2026-09-27
Status: Accepted for implementation; qualification recorded separately
Requirements: FR-065, FR-079, NFR-001

## Evidence and decision

Four PostgreSQL regression cases reproduce admission after a transferred run's
call cap, after a paid receipt without its budget snapshot update, concurrent
admission of two different parity inputs into one remaining slot, and admission
against incomplete historical accounting. See the retained red test output in
`output/acceptance/2026-09-27-studio-budget/`.

The run budget JSON remains its saved snapshot and configured limits. Before
inserting a call, the repository holds the existing task lock and evaluates all
run call receipts. Every admission consumes a call slot, including failures,
unfinished calls and calls later settled as not accepted. Known receipt costs
and exact-call administrator settlement costs count towards the spending stop
threshold. A late receipt cannot discount an earlier higher settlement; use the
greater value once per call. Attestation remains separate from provider billing.

Validate finite positive limits, integer call caps and nonnegative counters.
Refuse incomplete historical accounting when saved counters exceed the available
ledger, rather than inventing a historical cost allocation. Permit only the
floating-point tolerance for summing the same receipts in JS. A separately
requested new run is the operational exit after any uncertainty is settled.
Never rewrite immutable run snapshots or original call receipts to reset caps.

Expose the derived admission totals and any refusal in Desk separately from the
original receipts. Missing or unknown amounts stay visibly unknown.

## Scope and limits

This closes cumulative call caps and admission after the recorded spending
threshold is reached across processes and after transfer. It adds no storage or
framework. Existing task/run scope, uncertainty holds and logical call identity
remain required. The application repository is the admission boundary; this is
not a new SQL trigger protecting arbitrary privileged inserts.

The USD limit is a stop threshold for recorded costs, not a guaranteed invoice
ceiling. A call admitted below it can exceed the remaining amount; concurrently
in-flight calls also have unknown final costs. Hard pre-dispatch USD reservations
need separately validated provider price/input bounds. Per-role/daily aggregate
caps and typed response recovery remain separate qualification work. No live
provider bill, production change or overall application admission follows from
this change alone.
