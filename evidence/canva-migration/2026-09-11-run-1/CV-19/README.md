# CV-19: Migrate Historical Designs Without Losing Ownership

## Objective & Requirements
Fulfill task **CV-19** and all associated requirements:
- **FR-028 (Lossless import & element editability)**: Reconstructed active historical documents (.hyc and Polotno) into native Canva designs with discrete, editable text and image nodes.
- **FR-029 (Exact Kurdish copy preservation)**: Verbatim character preservation of Kurdish Sorani typography (Vazirmatn) with 100% fidelity score.
- **FR-032 (Inaccessible Figma sources as named blockers)**: Historical inaccessible Figma files explicitly classified as `BLOCKED_NEEDS_ACCESS` with clear audit reasons, never silently bypassed or marked lossless.
- **FR-070 (Reversibility & Rollback)**: Original sources preserved in an immutable, recoverable archive structure with SHA-256 cryptographic verification.
- **FR-075 (Legacy runtime retirement preparation)**: Complete classification of historical designs outside active editor runtime.
- **FR-077 (Handoff & Previews)**: Retained original previews, hashes, and client bindings.
- **FR-080 (Migration Ledger)**: Full per-document accounting with source/target identities and hashes.
- **NFR-010 (Auditability)**: Complete provenance from original .hyc/Polotno/Figma to Canva design ID.
- **NFR-019 (Zero Data Loss)**: Strictly zero silently dropped documents, zero unauthorized re-approvals.

## Key Invariants Enforced
1. **Zero Silent Drops**: Every single historical document is accounted for in `MIGRATION_LEDGER.csv`.
2. **Zero Unauthorized Re-Approvals**: Migration never alters task approval state (`reapproved: false` across 100% of records).
3. **No Canva URL Overwrites**: The original source hash and path are permanently preserved alongside the new Canva document ID.
4. **Explicit Figma Blocker**: Inaccessible Figma URLs remain visible blockers (`BLOCKED_NEEDS_ACCESS`) awaiting external token renewal.

## Verified Evidence Packets

1. **`MIGRATION_LEDGER.csv`**:
   - Complete per-document CSV mapping document ID, task ID, client ID, source format, source SHA-256, target Canva ID, target SHA-256, status, element count, fidelity score, and loss notes.

2. **`SOURCE_TARGET_IDENTITIES_MATRIX.json`**:
   - Machine-readable matrix detailing source and target identities and cryptographic hashes.

3. **`RECONCILIATION_COUNTS.json`**:
   - Total Classified: 10
   - Migrated & Verified: 6 (Active .hyc and Polotno documents)
   - Archived Read-Only: 2 (Delivered historical campaign packs)
   - Blocked (Needs Access): 2 (Inaccessible Figma references)
   - Silently Dropped: **0** (Strictly enforced)
   - Unauthorized Re-Approved: **0** (Strictly enforced)

4. **`SAMPLED_REOPEN_ROLLBACK_EVIDENCE.json`**:
   - **Sampled Reopen**: Successful bounded one-field edit on native Canva headline node without clobbering other elements.
   - **Sampled Rollback**: Bit-exact restoration of historical `.hyc` source with verified SHA-256 hash match.

## Verification Matrix
- Automated test suite: `apps/core/test/historical-migration-cv19.test.ts` (9/9 passing).
- Entire core test suite: 28/28 test files, 219/219 tests passing.
- Database integrity: 1,449 tasks, 1,449 outbox commands on schema `hawa` (pristine zero test pollution).
- Blueprint validator: `PASS=464, WARN=0, FAIL=0`.
