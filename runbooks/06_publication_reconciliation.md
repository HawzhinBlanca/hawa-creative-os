# Runbook: Drive/Sheets Publication Divergence

1. Freeze the publication ID and approved revision/package hash.
2. Read PostgreSQL publication/Drive/Sheet substates.
3. Query Drive by recorded file/folder IDs and deterministic app metadata.
4. Verify sizes, hashes where available, names, parent folder, and permissions.
5. Query Sheet by immutable hidden task ID/row key; do not trust row number alone.
6. Repair only missing/inconsistent substeps using the same publication key.
7. Re-read both systems and update reconciliation state.
8. Send final notification after state converges.

Never delete possible duplicates until hashes/source and permissions are reviewed.
