# ADR-049: Studio Model Call Admission Identity

**Date:** 2026-09-25
**Status:** Accepted for the local R21 Studio boundary; provider reconciliation and deployed recovery remain open.
**Requirements:** FR-059, FR-060, FR-062, FR-065, FR-079, NFR-001.
**Amends:** ADR-048 and the Studio call ledger admission path.

## Context

ADR-048 makes a single Studio process stop when a provider's acceptance is unknown and refuses replay of a recorded paid current-stage call. Its pre-dispatch rows have random IDs, however. Two Core processes can read the same run before either inserts a row, each insert a different ID, and both dispatch a paid request. The process-local resume map cannot coordinate them. A swallowed uncertain image or judge error can also make the current process continue after an unresolved call; the R21 stage propagation fix closes that separate hole.

## Decision

Every new Studio model ledger row carries a positive per-run call ordinal when it belongs to the staged generation path, plus a SHA-256 logical-call identity. The identity hashes the run, stage, provider, exact model, ordinal and serialized request input. A PostgreSQL unique index on `(run_id, call_ordinal)` admits at most one stage call at the ordinal two processes read. A second unique index on `(run_id, logical_call_sha256)` rejects exact logical replay. The insert commits before provider dispatch. A conflict is a hold, never a signal to send a new model request or to use a degradation fallback.

Parity checks on an already completed run cannot update its immutable run budget. They use a content identity without an ordinal: the same export/question/model is not paid for twice, while a changed export can be measured separately. Historical ledger rows retain null identity fields; the indexes govern all newly admitted calls through the repository. No response body or private prompt is stored in the identity fields.

## Consequences and limits

- PostgreSQL uniqueness serializes concurrent inserts across Core processes and rejects the losing dispatch before it reaches the provider.
- The ledger identity is a local reservation, not a provider-supported idempotency key. It cannot prove whether a request with a lost reply was billed; ADR-048 still holds the run for reconciliation.
- A stale caller may be denied after a genuine no-charge error; an operator must decide whether a fresh run or a reviewed new attempt is safe. Availability is subordinate to not silently repeating paid work.
- Run-level status and candidate writes still need their own cross-process fencing. This ADR does not make R21 accepted or establish clean-host kill-after-send proof.
