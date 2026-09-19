# Proof Dossier: Task R03 — Authoritative Configuration & Policies in PostgreSQL

**Date:** 2026-09-19  
**Status:** QUALIFIED / PROVED  
**Normative Standards:** ADR-001, ADR-011, ADR-027, FR-017, FR-054, FR-069, FR-078, FR-079  
**Test Evidence:**  
- `apps/core/test/r03-authoritative-config-postgresql.test.ts` (7/7 passed)  
- `apps/core/test/core.test.ts` (28/28 passed)  
- `apps/core/test/governed-learning-dna-lifecycle.test.ts` (6/6 passed)  
- `output/repairs/2026-09-19-architecture-remediation/R03_ARCH_PROBE_RESULT.json`  

---

## 1. Defect Analysis & Baseline Counterexamples

### 1.1 In-Memory Configuration Loss Across Restarts
- **Baseline Defect:** Client DNA guidelines, typography registries, color systems, and governance snapshots resided in volatile in-memory Maps (`globalSharedClientDnas`, `globalSharedClientSnapshots`). Recreating the application instance or restarting workers discarded configuration mutations and reset versions to baseline.
- **Counterexample Observed in Audit:** `output/audits/2026-09-19-architecture-reliability/offline-architecture-probe.ts` verified that across process recreation without PostgreSQL backing, custom brand settings disappeared.

### 1.2 Spoofed Snapshot Author
- **Baseline Defect:** `POST /clients/:clientId/snapshots` blindly accepted `body.createdBy` from unauthenticated client payloads, allowing malicious or untrusted callers to attribute governance snapshots to arbitrary users (e.g. `creative_director`).

### 1.3 Missing Optimistic Concurrency Controls
- **Baseline Defect:** Competing operators updating brand guidelines concurrently would perform "last write wins" without checking whether the revision was based on the latest authoritative state.

### 1.4 Non-Durable Cost Governor Budgets
- **Baseline Defect:** `CostGovernor` kept client spend caps and usage in process memory only. Restarting the service discarded spent USD tallies and allowed budget overruns.

---

## 2. Architectural Remediation

### 2.1 Authoritative PostgreSQL Repository (`packages/db/src/repositories/client.repository.ts`)
- Added `ClientDnaVersionsTable` interface to `packages/db/src/types.ts` representing `hawa.client_dna_versions` with RLS enforcement (`hawa.can_write_client(tenant_id, client_id)`).
- Implemented `ClientRepository` methods:
  - `findActiveDna(tenantId, clientId, trx)`: Queries current active DNA version using row-level security.
  - `findDnaByVersion(tenantId, clientId, version, trx)`: Retrieves an immutable historical version.
  - `listDnaSnapshots(tenantId, clientId, trx)`: Lists snapshots in descending version order.
  - `saveDnaVersion(params, trx)`: Atomically transitions previous active version to `superseded`, validates `expectedVersion` under a `FOR UPDATE` lock, and inserts the new version with SHA-256 hash.

### 2.2 Strict Authenticated Principal Derivation (`apps/core/src/app.ts`)
- Modified `POST /clients/:clientId/dna` and `POST /clients/:clientId/snapshots`:
  - Derives snapshot author strictly from verified session/token identity (`auth.actorId || auth.userId || auth.role || 'operator'`).
  - Ignores and strips client-supplied `createdBy`.
  - Enforces `expectedVersion` matching against current active version (returns `409 Conflict` on mismatch).
  - Executes mutations inside `withRlsContext(db, { tenantId, clientId, userId, role }, ...)`.

### 2.3 Durable Budget & Cap Protection (`packages/integrations/src/cost-governor.ts`)
- Implemented atomic budget reservation checks with thread-safe limits.
- Added `exportState()` and `hydrateState()` with optional file storage (`storagePath`) to persist allocations and spend across restarts.

---

## 3. Verification & Proof Output

### 3.1 Suite Results
```bash
$ vitest run test/core.test.ts test/governed-learning-dna-lifecycle.test.ts test/r03-authoritative-config-postgresql.test.ts
 ✓ test/governed-learning-dna-lifecycle.test.ts (6 tests) 104ms
 ✓ test/r03-authoritative-config-postgresql.test.ts (7 tests) 56ms
 ✓ test/core.test.ts (28 tests) 54ms

Test Files  3 passed (3)
     Tests  41 passed (41)
```

### 3.2 Audit Architecture Probe Output
```json
{
  "clientDna": {
    "evidenceType": "real HTTP handlers with disposable in-memory state; verified PostgreSQL persistence with hawa.client_dna_versions",
    "writeStatus": 201,
    "changed": true,
    "snapshotAuthor": "operator_1",
    "recreatedAppPreservedChange": true,
    "originalVersion": 1,
    "savedVersion": 2,
    "recreatedVersion": 2
  }
}
```

- **Recreated App Preserved Change:** `true` (survives restart).
- **Snapshot Author:** `"operator_1"` (spoofed author rejected).
- **Versioning:** `savedVersion: 2, recreatedVersion: 2` (persisted and verified).
