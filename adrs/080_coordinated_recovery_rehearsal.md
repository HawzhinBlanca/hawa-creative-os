# ADR-080: Coordinated application-store recovery rehearsal

Date: 2026-09-27
Status: Accepted for isolated qualification; production admission pending
Requirements: FR-060, FR-061, FR-070, NFR-003, NFR-013, NFR-020

## Finding

The existing nightly pair authenticates the database/file and Restate archives,
but captures them at different times while other application writers may continue.
The isolated Restate proof reads saved state; it does not resume a pending delivery.
The PostgreSQL PITR proof does not establish agreement with Restate or file bytes.
None of these receipts authorizes automatic whole-system recovery.

## Decision

Add an explicit recovery mode to the existing synthetic full-application candidate.
Use the real Core, worker, PostgreSQL, Restate and file store. Keep the external test
services alive across recovery so their already-observed effects cannot disappear
with the application's backup. Require fsync and full_page_writes for this mode.

At a named external-effect boundary, stop Core and every worker, then stop Restate
and PostgreSQL. Confirm all writers are stopped before capturing any of the three
stores. Authenticate and encrypt each complete store archive, verify its contents,
and restore into newly created volumes using the exact observed service images.
Retain original volumes until the rehearsal is torn down. Validate database rows,
RLS policies, file hashes and pending journal identity before admitting workers.
Resume the original invocation without another approval or Deliver request.

Exercise Drive adoption after upload but before a database receipt, and an uncertain
Telegram file send whose committed attempt mark must prevent a resend. Verify
one publication, the intended file bytes, completed journal/projection, and external
effect counts against the test services that survived recovery. A failed restore
must leave workers stopped and preserve the recovery artifacts for diagnosis;
never silently resume an older store after external effects may have advanced.

This is a same-host coherent cold-capture rehearsal, not independent-host recovery,
arbitrary PostgreSQL PITR combined with older Restate state, off-host durability,
real provider acceptance, or unattended production backup admission. The nightly
production path remains disabled for Restate until its coordinated capture and
restore are separately qualified. Unequal capture windows still require explicit
reconciliation and must not be presented as an atomic recovery set.

## Source

[Restate backup guidance](https://docs.restate.dev/server/snapshots), checked
2026-09-27, requires the complete single-node data directory and node configuration.
The rehearsal retains the existing pinned Restate 1.7.10 image and node identity.
