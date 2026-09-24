# CV-15: Bind Human Approval to Captured Revision & Review Desk

**Requirements:** FR-041, FR-042, FR-043, FR-044, FR-069
**Depends on:** CV-04, CV-14
**Status:** VERIFIED

## Executive Summary

Task CV-15 establishes truthful, server-authenticated human review and approval binding for Hawa Creative OS. Approval records are cryptographically bound to immutable captured artifact sets (CV-13) and verified passing QA runs (CV-14), preventing race conditions, post-approval drift, unapproved publishing, and authority bypasses.

## Core Invariants & Acceptance Gates Proven

1. **The Central Acceptance Invariant: Approve A / Edit B / Publish**:
   - When Revision A is approved and subsequently edited in Canva to produce Revision B:
     - Task approval is strictly invalidated; task reverts to `AWAITING_APPROVAL`.
     - Attempting to publish Revision B using Revision A's approval is strictly rejected with HTTP 409 `Conflict` (`APPROVAL_REVISION_MISMATCH`: *"B cannot ship using A's approval"*).
     - Attempting to publish current task without re-approval is blocked with HTTP 409 (`AWAITING_APPROVAL`).
     - Under policy `deliver_approved_stored`, publication delivers the stored, verified capture files of Revision A **without re-exporting the live Canva design** (which has drifted to B).
     - Upon proper review and approval of Revision B, Revision B is successfully published.

2. **Truthful Review Desk Inspection (FR-041)**:
   - Reviewers inspect full-size preview files across all aspect ratios (`1:1`, `9:16`, `4:5`, PDF Print, PDF Standard, SVG).
   - Exact extracted copy with Kurdish Sorani RTL verification.
   - Reference brand assets (official logo hash, approved brand color palette, verified Kurdish webfonts).
   - Deterministic QA findings and glyph coverage report.
   - Direct *"Edit in Canva"* working link with return URL and lease protection.

3. **Structured Revision Requests (FR-042)**:
   - Captures scope (`copy`, `layout`, `color`, `asset`, `full_design`), category (`factual_error`, `brand_violation`, etc.), target node IDs, priority, and reusable feedback flag.
   - Automatically writes to `feedback_events` for governed learning in CV-18.

4. **Strict Role Authority Checks (FR-043)**:
   - Server-authenticated identities only (`verifiedServerSide: true`).
   - Authorized roles: `art_director`, `creative_director`, `client_reviewer`, `office_admin`.
   - Unauthorized roles (`external_guest`, `viewer`) are rejected with HTTP 403 Forbidden.
   - Unauthenticated callers are rejected with HTTP 401 Unauthorized.

5. **Optimistic Concurrency & Stale Defenses**:
   - Bumps task version on decision. Concurrent approval with stale version is rejected with HTTP 409 (`CONFLICT_CONCURRENT_APPROVAL`).
   - Stale two-way chat actions referencing older revisions are rejected with HTTP 409 (`STALE_CHAT_APPROVAL_ACTION`).
   - Tampered `capturedArtifactSetHash` or `qcReportHash` are rejected with HTTP 422 Unprocessable Entity.

6. **Append-Only Cryptographic Audit Trail (FR-069)**:
   - Every approval, rejection, revision request, and invalidation is recorded with actor attribution and SHA-256 hash chaining to the preceding entry.

### Addendum 2026-09-24 (architecture programme 1.3, groups G3 and G5)

The last step of invariant 1 ("Revision B is successfully published") no longer holds once
Revision A has been delivered under `deliver_approved_stored`. Decisions are now recorded only in
Postgres (`hawa.approvals`), and Postgres refuses to approve a task that is already delivered
(COMPLETE has no transitions), so approving B on that task answers HTTP 409 and B goes out as a new
request. It used to be approved and delivered again from Core's in-memory copy, which production,
reading Postgres, never did. Test 8 of `apps/core/test/human-approval-binding.test.ts` now asserts
the 409 and that the recorded delivery is A's pinned export alone. The other steps are unchanged.
The trace files below are the 2026-09-11 run and were not regenerated.

## Evidence Artifacts

- `APPROVE_A_EDIT_B_PUBLISH_TRACES.json`: Full trace of the core invariant across all 8 lifecycle steps.
- `CONCURRENT_APPROVALS_AND_STALE_CHAT_REPORT.json`: Optimistic locking race traces and chat action defenses.
- `TAMPERED_HASHES_AND_ROLE_AUTHORITY_REPORT.json`: Hash tampering rejection and 6-role authorization matrix.
- `STRUCTURED_REVISION_AND_AUDIT_TRAIL.json`: Structured revision request payload and chained audit log.

## Verification

```bash
pnpm vitest run apps/core/test/human-approval-binding.test.ts
python3 scripts/validate_pack.py
```
