# Google Sheet row identity — implementation checkpoint

ADR-105, FR-049 and FR-050 prerequisite. Local fake-provider qualification only.

## Behavior

Core uses Client DNA's numeric `destinations.sheetId`. Publication creates a row
with a provider metadata identity or updates that exact identity after inspection.
It reads the configured tab by grid ID, checks for duplicate task IDs and validates
all protected values. Row moves do not redirect an update to a bystander. A lost
response is reconciled by the original identity, including after process restart.

## Operator findings

| Finding | Meaning / next action |
| --- | --- |
| `SHEETS_LEGACY_ROW_NEEDS_MIGRATION` | A task row exists without the new metadata. Preserve it; the supervised migration workflow is still required. |
| `SHEETS_DUPLICATE_TASK` | More than one row has this task ID. Inspect the exact tab and publication before resolving the duplicate. |
| `SHEETS_ROW_IDENTITY_CONFLICT` | Metadata and task/tab identity disagree. Preserve evidence and inspect the publication. |
| `SHEETS_ROW_MOVED_DURING_READ` | The independent reads did not see one stable location. A later recheck can observe a settled row. |
| `SHEETS_ROW_VALUES_DIFFER` | At least one protected column differs, even if the package hash still matches. |
| `SHEETS_SCAN_LIMIT` | Tab capacity exceeds 20,000 rows. No partial scan is reported as complete. |
| `SHEETS_HTTP_*` / `SHEETS_READ_OR_WRITE_UNCONFIRMED` | Access or transport did not establish the result. It does not prove that a write failed. |

Metadata contains identifiers, never credentials. It is not an access-control
mechanism. Staff can edit the spreadsheet; observations describe a point in time.
No metadata or data is silently added to an existing legacy row by number.

## Remaining release work

Persist immutable expected destinations/row values and metadata receipts in
PostgreSQL, implement scheduled external Drive/Sheet inspection and current-scope
staff resolution, and qualify the protocol against real Google Workspace. The
adapter's process-local receipt lookup is not a durable reconciler. Historical
permissions or expectations must remain unknown unless supported by real evidence.

Reproducible local checks and the real SIGKILL drill are recorded in
`plans/research-grade-upgrade-2026-09-25/R09_SHEET_IDENTITY_PROOF.json`.
