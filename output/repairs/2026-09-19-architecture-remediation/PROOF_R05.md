# Proof Dossier: Task R05 — Make Approval an Immutable Artifact/QC Contract

**Date:** 2026-09-19  
**Status:** QUALIFIED / PROVED  
**Normative Standards:** ADR-015, ADR-025, FR-015, FR-041, FR-043-045, NFR-015, NFR-020  
**Test Evidence:**  
- `apps/core/test/r05-immutable-approval-contract.test.ts` (7/7 passed)  
- `apps/core/test/core.test.ts` (28/28 passed)  
- `apps/core/test/design-studio-routes.test.ts` (21/21 passed)  
- `apps/core/test/human-approval-binding.test.ts` (10/10 passed)  
- `apps/core/test/pinned-delivery.test.ts` (10/10 passed)  
- `apps/core/test/r04-scope-enforcement.test.ts` (10/10 passed)  
- `apps/core/test/r03-authoritative-config-postgresql.test.ts` (7/7 passed)  
- `apps/core/test/gate-f-review-invalidation.test.ts` (4/4 passed)  
- `apps/core/test/approval-qc-hash.test.ts` (3/3 passed)  

---

## 1. Defect Analysis & Counterexamples

### 1.1 Unfenced Approval Mutation & Concurrent Edit Vulnerability
- **Baseline Defect:** Approvals could be recorded while concurrent revisions or edits were occurring without database row locking (`FOR UPDATE`) on the tasks table or optimistic version checks. A post-approval edit could take place after approval was granted, yet the downstream delivery pipeline would deliver the newly edited, unapproved revision under the previous approval.
- **Counterexample Observed:** When task version was incremented concurrently, an approval request specifying a stale `expectedTaskVersion` was accepted, creating an inconsistent approval record over a modified task.
- **Remediation:**
  - In `packages/db/src/repositories/revision.repository.ts`, `recordApproval()` acquires a `forUpdate()` row lock on the task.
  - Enforced `expectedTaskVersion` concurrency fence: if `expectedTaskVersion` does not match `task.version`, approval is aborted with `409 Conflict`.
  - In `POST /tasks/:taskId/revisions`, any new design revision resets `task.latestQAReport = null`, marks `latestApproval.invalidated = true`, and sets task status to `AWAITING_APPROVAL`.

### 1.2 Unverified, Null, or Stale QC Qualifying Approvals
- **Baseline Defect:** Approvals could be granted on designs where no QC run had executed, or where an earlier passing QC run was superseded by a later failing regression run.
- **Counterexample Observed:** An approval request without a corresponding passing QC run was accepted, allowing defective designs to bypass quality gates.
- **Remediation:**
  - Implemented strict rule: "null or unknown QC strictly refuses approval (null/unknown QC cannot publish)" returning `412 Precondition Failed`.
  - In `packages/db/src/repositories/revision.repository.ts`, QC runs are queried ordered by `created_at DESC`. If the latest QC run is not `status: 'passed'` with `critical_pass: true`, approval is strictly refused.
  - In `apps/core/src/app.ts`, `POST /tasks/:taskId/revisions/:revisionId/decisions` validates QC report integrity against `effectiveQcReportHash`.

### 1.3 Reviewer Role Authority & Principal Derivation
- **Baseline Defect:** Client-supplied role assertions (`x-user-role` header, `body.role`) allowed callers with operator credentials to assert reviewer roles (`art_director`, `client_approver`) and approve designs.
- **Counterexample Observed:** An operator calling `/decisions` with `action: 'approve'` succeeded.
- **Remediation:**
  - In production mode, actor role is strictly derived from the authenticated server-side principal record (`auth.role`).
  - Operators are forbidden from approving designs (`effectiveRole === 'operator'` returns `403 Forbidden`).
  - Client approvers are strictly checked against `task.clientId`; any cross-client approval attempt returns `403 Forbidden`.

### 1.4 Stale or Revoked Canva Binding
- **Baseline Defect:** If a task's Canva binding was in status `revoked` or `stale`, approvals could still be recorded against it.
- **Remediation:** Enforced Canva binding status check: if `task.canvaBinding.status !== 'bound'`, approval is refused with `422 Unprocessable Entity: Stale Canva Binding`.

### 1.5 Immutable Approval Tuple
- **Remediation:** Approval records bind an immutable contract tuple:
  - `(tenantId, clientId, taskId, revisionId, canvaBindingId, canvaBindingVersion, sourceHash, exportHashes, qcRunId, qcReportHash, approverId, approverRole, approvedAt)`.
  - Downstream delivery requires this exact tuple and verifies `invalidated === false`.

---

## 2. Verification Suite Results

```bash
$ vitest run test/r05-immutable-approval-contract.test.ts

 ✓ test/r05-immutable-approval-contract.test.ts (7 tests) 44ms
   ✓ R05: Immutable Approval Contract & QC Binding (FR-015, FR-041, FR-043-045, NFR-015, NFR-020) (7)
     ✓ 1. Positive approval succeeds when verified passing QC is present 24ms
     ✓ 2. Null or unknown QC strictly refuses approval (null/unknown QC cannot publish) 3ms
     ✓ 3. Earlier PASS followed by later FAIL cannot qualify 3ms
     ✓ 4. Concurrent edit/approve has one valid serial outcome via expectedTaskVersion 3ms
     ✓ 5. Operator role cannot approve designs (FR-043 authority check) 4ms
     ✓ 6. Post-approval edit invalidates approval and blocks publication 4ms
     ✓ 7. Stale or revoked Canva binding cannot approve 2ms

Test Files  1 passed (1)
     Tests  7 passed (7)
```

Total regression across core test suites: **100/100 tests passed**.
