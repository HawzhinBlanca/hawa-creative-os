# Proof Dossier: Task R06 — Make Publication Restart-Safe, Concurrency-Safe & Verifiable

**Date:** 2026-09-19  
**Status:** QUALIFIED / PROVED  
**Normative Standards:** ADR-015, ADR-025, FR-045–050, FR-059–060, NFR-001, NFR-014, NFR-020  
**Test Evidence:**  
- `apps/core/test/r06-publication-safety.test.ts` (5/5 passed)  
- `apps/core/test/verified-delivery-drive-sheets.test.ts` (10/10 passed)  
- `apps/core/test/pinned-delivery.test.ts` (10/10 passed)  
- `apps/core/test/publish-sheets-unconfirmed.test.ts` (3/3 passed)  
- `packages/integrations/test/google-publisher-bytes.test.ts` (7/7 passed)  
- `packages/integrations/test/real-google-operations.test.ts` (5/5 passed)  
- `packages/integrations/test/integrations.test.ts` (4/4 passed)  

---

## 1. Defect Analysis & Counterexamples

### 1.1 Race Conditions & Duplicate Side-Effects on Concurrent Calls
- **Baseline Defect:** When multiple publication requests with the same publication intent or key arrived simultaneously (e.g., operator double-clicking or multiple automated triggers), each request raced into state transition and provider upload routines. Subsequent requests either failed with unexpected `409 Conflict: Invalid transition` or caused duplicate upload/append side-effects with divergent receipts.
- **Counterexample Observed:** Three simultaneous publish requests to `/v1/tasks/:taskId/publish-omnichannel` resulted in the second and third requests aborting with 409 Conflict instead of returning the identical completed receipt.
- **Remediation:**
  - Implemented `globalSharedInFlightPublications` promise deduplication in `apps/core/src/app.ts`.
  - Concurrent requests targeting the same canonical publication key (`pub_key_${taskId}_${approvalId}`) coalesce onto the active in-flight execution promise, returning the exact same receipt and status (`COMPLETE` / 200) without redundant provider calls or state collision.

### 1.2 Fragmented Route Logic & Divergent Publication Keys
- **Baseline Defect:** The desk route (`POST /tasks/:taskId/publish`) and the omnichannel route (`POST /tasks/:taskId/publish-omnichannel`) used divergent publication key formats (`pub_key_${taskId}_...` vs `pub_omni_${taskId}_...`), bypassed each other's in-memory ledgers, and handled task completion idempotency inconsistently.
- **Counterexample Observed:** Calling `/tasks/:taskId/publish` followed by `/v1/tasks/:taskId/publish-omnichannel` on the same task caused the second call to fail with `409 Conflict: Task is in status 'COMPLETE', not 'approved'` rather than reusing the existing receipt.
- **Remediation:**
  - Unified both routes around canonical publication key derivation: `pub_key_${taskId}_${approval.approvalId}`.
  - Both routes now consult and populate the unified publication ledger (`hawa.publications` in PostgreSQL and `omnichannelReceipts` in-memory).
  - Calling either route on an already completed task idempotently returns the existing verified publication receipt.

### 1.3 Google Sheets Row Overwrites from Row Position Drift
- **Baseline Defect:** `GooglePublisher.syncSheetRow` relied solely on cached or passed row numbers (e.g., `PUT /values/A{rowNumber}:G{rowNumber}`). If a user sorted, filtered, or inserted rows into the Google Sheet externally, the publisher blindly overwrote unrelated tasks situated at that row index.
- **Counterexample Observed:** When Task A was at row 2 and Task B at row 3, inserting a new row at index 2 shifted Task A to row 4. A subsequent sync targeting Task A overwrote row 2 (which now belonged to another task).
- **Remediation:**
  - Updated `packages/integrations/src/google-publisher.ts` to enforce immutable task identity verification before modifying any row.
  - Before issuing an update to row `N`, the publisher reads `A{N}:A{N}`. If column A does not match `request.taskId`, the publisher detects row drift and calls `findRowByTaskId()` to scan column A and discover the actual row number of the task.
  - Only the task's verified row is updated, preventing unrelated rows from ever being corrupted.

### 1.4 Deliverable Checksum & Hash Verification
- **Baseline Defect:** Corrupted or tampered deliverables could theoretically be accepted if only file existence or byte count was checked.
- **Remediation:**
  - Delivery loader verifies every file against its sha256 checksum and exact byte size.
  - Any mismatch immediately halts publication before provider calls, returning `422 Unprocessable Entity: PUBLICATION_VERIFICATION_FAILED`.

### 1.5 Reconciliation and Replay for Unconfirmed Sheets Rows
- **Baseline Defect:** If Google Drive upload succeeded but the Google Sheets write failed or timed out, earlier systems either marked the task complete prematurely or re-uploaded all Drive files on retry.
- **Remediation:**
  - Unconfirmed Sheets row leaves the task in `PUBLISH_RECONCILIATION` with HTTP status 202.
  - A retry operation locates the existing `drive_complete` publication record and retries *only* the Sheets row write; Drive files are never re-uploaded.

---

## 2. Test Execution & Evidence

### 2.1 R06 Publication Safety Test Suite
```bash
$ vitest run test/r06-publication-safety.test.ts

 ✓ test/r06-publication-safety.test.ts (5 tests) 35ms
   ✓ R06: Publication Restart-Safety, Concurrency & Row Safety (FR-045–050, FR-059–060, NFR-001, NFR-014, NFR-020) (5)
     ✓ 1. Concurrent same-key publication calls return identical receipt with zero duplicate side-effects 25ms
     ✓ 2. Both API routes (/publish and /publish-omnichannel) use unified publication ledger 4ms
     ✓ 3. Sheets row updates verify immutable task identity and never overwrite shifted/moved/inserted rows 0ms
     ✓ 4. Deliverable checksum mismatch strictly halts publication with PUBLICATION_VERIFICATION_FAILED 0ms
     ✓ 5. Unconfirmed Sheets write leaves task in PUBLISH_RECONCILIATION; retry completes without re-upload 3ms

Test Files  1 passed (1)
     Tests  5 passed (5)
```

### 2.2 Full Regressions across Packages
- `@hawa/core` delivery & approval regressions: 35/35 passed across 5 test files (`verified-delivery-drive-sheets`, `pinned-delivery`, `publish-sheets-unconfirmed`, `r05-immutable-approval-contract`, `r06-publication-safety`).
- `@hawa/integrations`: 128/128 passed across 19 test files.
- `@hawa/db`: 34/34 passed across 8 test files.
