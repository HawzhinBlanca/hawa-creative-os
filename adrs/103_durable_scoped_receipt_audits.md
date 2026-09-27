# ADR-103: Immutable receipt audits from one authorized database snapshot

Date: 2026-09-27
Status: implementation and qualification in progress
Requirements: FR-050 (stored-receipt subset only), FR-064, NFR-006
Sources: docs/13_GOOGLE_DRIVE_SHEETS.md; docs/10_WORKFLOW_RELIABILITY.md;
docs/17_UI_UX.md; MASTER_SPEC.md

## Evidence

The audit POST reads tasks and receipts with RLS but in separate transactions.
The GET returns one process-local lastReport without checking its originating
identity or client set. Authenticated PostgreSQL regressions reproduce another
user reading a client's anomaly IDs, continued access after client membership
revocation, and loss of the report on a fresh Core instance. The first test fixture
used a foreign tenant that this office's session reader correctly refuses; that
401 setup failure and the corrected behavioral failures are preserved separately.

## Decision

Keep PostgreSQL as operational truth. Store append-only receipt audits with tenant,
actor, exact authorized client-set hash, monotonically increasing revision per
actor/scope, reason, predecessor audit, action UUID, normalized input hash and
report hash. No historical process-local report is invented or backfilled.

Derive scope from current PostgreSQL membership and client RLS, not a caller's
role/client list. Include unassigned office tasks only for active office members.
Both application queries and table RLS require the current actor and exact current
scope; losing or gaining clients invalidates the old latest view. A report is a
snapshot for its stated scope/time, never a statement about later membership or
Google state. Another user's audit is not that user's latest report.

Read tasks, publication markers and stored receipts and append the report in one
serializable transaction. Retry only database serialization/uniqueness races, with
a bounded retry count; there is no provider call inside this transaction. Bind a
caller-generated action UUID to the exact expected scope, predecessor and reason.
The Idempotency-Key header must match that UUID.
An exact replay returns its original committed report before the predecessor check;
a changed request or competing newer audit is refused. A failed commit publishes
no successful report. The Desk saves the action before transport and retains it
through a lost response/reload; unavailable browser storage sends no new request.

Expose typed latest/history state with bounded pagination and explicit scope,
recorded time and hashes. Clear stale evidence on unreadable/malformed responses.
Preserve exact saved-action retry and show audit anomalies without claiming repairs.
Remove process-local latest state and audit-result broadcasts: report counts and
identifiers must not travel through a tenant-wide event outside the read policy.
Reject caller-supplied simulation rows at the production audit endpoint; fixture
comparison remains a stateless deterministic domain function. No repair is added.

## Comparison correctness

The old comparison also included approved/in-progress tasks as if reporting rows
were already due, and collected receipts from every revision. Compare only the
current-revision publication's verified receipts with its declared artifact names,
hashes and sizes. Keep expected/observed Sheet row hashes separate. Missing source
manifest evidence cannot qualify a delivery. Count not-yet-due tasks separately;
preserve any unresolved archive marker without asserting external absence.
Normalize the database timestamp to milliseconds explicitly at the SQL/API boundary.

## Qualification

Prove same-process identity isolation, current membership revocation, foreign
scope refusal, actual RLS and immutable-row enforcement, exact replay after a lost
response/restart, predecessor conflicts, concurrent same/different actions, one
snapshot during a concurrent receipt change, and rollback without a visible report.
Check historical migration, Desk failed reads, saved actions across reload and
storage failure. Run the full regression and inspect a fresh deployed browser;
keep failures and unexecuted gates explicit in traceability.

## Remaining scope

This does not finish FR-050: independent Drive/Sheets reads, scheduled external
drift detection and staffed conflict resolution remain required. It also does not
admit live providers, measure availability, approve native Canva, or replace human
multilingual/design review and independent-host restore.
