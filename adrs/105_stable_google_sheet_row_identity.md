# ADR-105 — Stable Google Sheet row identity

Date: 2026-09-27
Status: Accepted for implementation; live Google qualification pending
Requirements: FR-049; prerequisite for FR-050

## Evidence and decision

The current adapter uses unqualified A1 ranges, a task-only process cache and a
read-then-write row number. It ignores the configured tab, misses duplicate task
IDs and can overwrite another row if staff sort between lookup and update. A lost
append response can produce a second row on retry. A package-hash cell alone does
not verify the destination or link.

Use numeric `sheetId` data filters for reads and a row-scoped developer metadata
ID for updates. Derive a positive 31-bit ID from a versioned tuple of tenant,
spreadsheet, tab and task. Store the full tuple as its metadata value. A hash
collision is an explicit conflict, never permission to update the occupied ID.
The provider stores this identity independently of the Core process.

Create a new row by one atomic `spreadsheets.batchUpdate`: insert at row 2,
write literal values and create the explicitly chosen metadata ID. The metadata
ID's uniqueness makes two concurrent creates or lost-response retries converge
without another insertion. Re-read after success or uncertainty. Update existing
rows through `values:batchUpdateByDataFilter` with that exact metadata ID and RAW
values. Never fall back to blind append or numeric-row writes.

Before writing, read the exact tab, validate its bounded grid, detect duplicate
task IDs and verify the metadata's full identity and one-row location. A historical
row without metadata requires an explicit supervised migration; auto-attaching
metadata to its observed row number has the same sort race. A missing, ambiguous,
malformed or unreadable identity remains unconfirmed. Independent readback checks
all seven protected values, the complete row hash and current location. Keep the
existing package-hash receipt field for compatibility; record the row hash and
metadata ID separately. Creation timestamps come from the request where present;
replays retain the existing row timestamp.

## Limits and following work

Sheets is collaborative and does not provide cell-value compare-and-swap. Staff
can still alter/delete metadata, cells or permissions. Fresh external verification
must flag this drift; a success receipt describes an observation, not an eternal
guarantee. The bounded scan refuses oversized sheets instead of silently checking
only a prefix. No permission baseline may be invented for historical publications.

FR-050 still requires immutable PostgreSQL publication inputs, scheduled persisted
external observations, current-scope staff actions and a supervised legacy-row
migration. Configured tab propagation and the wider reporting schema also remain
part of the delivery work. This ADR does not claim them complete.

## Primary references (accessed 2026-09-27)

- [Metadata identity, row association and unique explicit IDs](https://developers.google.com/workspace/sheets/api/guides/metadata)
- [Atomic batch updates and collaborator limitations](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)
- [Updates by data filter and RAW values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdateByDataFilter)

Acceptance must exercise distinct/nonzero tabs, sort between read and write,
duplicate IDs, concurrent creation, lost successful responses, a fresh publisher,
identity collisions, malformed/unavailable reads, changed links and byte limits.
