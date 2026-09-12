# Task CV-13 Verification: Capture Real Immutable Output Packages

## Summary
Task CV-13 establishes a verified, production-grade output capture pipeline for Canva designs, fulfilling requirements **FR-032, FR-033, FR-038, FR-045, FR-075, NFR-020**.

## Key Verifications & Architectural Invariants
1. **Explicit Capture Pipeline**: Implemented `CanvaCapturePipeline` executing after editing (CV-11, CV-12) and before review (CV-15).
2. **Strict Byte & File Integrity Validation**:
   - Zero-byte / missing files rejected with `MISSING_EXPORT_OUTPUT`.
   - 8-byte corrupt/placeholder files rejected with `CORRUPT_OR_EMPTY_ARTIFACT` (Invariant: Eight-byte outputs cannot become ready).
   - Wrong-format magic bytes (e.g. HTML 500 error pages) rejected with `WRONG_FORMAT_OUTPUT`.
   - RGB-only PDF submitted for print preflight rejected with `PRINT_PREFLIGHT_DEFECT`.
3. **No Ephemeral Link as Backup**:
   - Ephemeral Canva download URLs carry expiration timestamps. Expired links are detected and rejected with `EXPIRED_DOWNLOAD_URL`.
   - The pipeline streams raw bytes directly into durable staged storage (`data/staged-exports/{sha256}.{ext}`) and computes immutable cryptographic SHA-256 digests.
4. **Reconcile Uncertain Export Jobs**:
   - Instead of repeating duplicate export jobs on timeout/uncertainty, jobs are polled and reconciled (`reconcileExportJob`) by `jobId`.
5. **Native Print-Export Upload Handoff Route**:
   - Provides operator guidance for native Canva print dialog settings (PDF Print, CMYK profile, crop marks, bleed).
   - Ingests manual print uploads, validating PDF magic bytes, MediaBox/TrimBox/BleedBox, and CMYK color space.
6. **Multi-Format Consistency & Atomic Package Publishing**:
   - Validates presence of all required aspect ratio variants (`4:5`, `1:1`, `9:16`). Rejects partial packages with `PARTIAL_OUTPUT_PACKAGE`.
   - Incomplete snapshots (`semanticCoverage.isComplete: false`) block source-complete claims with `INCOMPLETE_SNAPSHOT_ERROR`.
   - Calculates Merkle root hash over all artifact hashes (`capturedArtifactSetHash`).
   - Atomically records capture set into `canva_capture_sets` and increments version (`v1 -> v2`). Stale version retries are rejected with `STALE_VERSION_CONFLICT`.

## Evidence Artifacts
- `PNG_PDF_PARSING_RESULTS.json`: PNG IHDR dimension and PDF header parsing results.
- `PDF_PAGE_BOXES_FONTS_PROFILE_PPI.json`: MediaBox, TrimBox, BleedBox, CMYK profile, and embedded font preflight details.
- `EXPORT_FAILURE_AND_EXPIRED_LINK_CONTROLS.json`: Rejection traces for corrupt, 8-byte, wrong-format, and expired-link files.
- `MULTI_FORMAT_CONSISTENCY_CHECK.json`: Consistent multi-format package verification and atomic capture manifest.
- Automated Test Suite: `apps/core/test/canva-immutable-capture.test.ts` (13/13 passing).
