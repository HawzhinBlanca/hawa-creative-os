# Runbook: Editable Studio Incident

1. Stop new automated studio operations; existing Hawa Desk tasks remain available.
2. Preserve latest valid source bytes, source hash, neutral manifest, and operation log.
3. Determine whether failure is process, storage, database, schema migration, rendering, font, or source corruption.
4. Reopen the previous immutable revision on the pinned version.
5. On stale/concurrent edits, preserve both versions and require explicit merge/selection.
6. For an export-only defect, use the proven fallback renderer while retaining `.hyc` source.
7. For broad studio failure, activate the fallback ADR and route new work to the admitted fallback/human editor.
8. Never flatten source merely to complete publication.

A source hash mismatch or unexplained semantic loss is P0.
