# Task CV-14 Verification: Make Quality Checks Inspect the Actual Work

## Summary
Task CV-14 replaces fixed example manifests and success-only QA with deterministic inspection checks over the actual brief, observed semantics, and captured files, fulfilling requirements **FR-014, FR-015, FR-027, FR-034, FR-035, FR-036, FR-037, FR-038, FR-039, FR-040, NFR-009, NFR-014**.

## Key Verifications & Architectural Invariants
1. **Passing Positive Baseline**: An authentic, complete KAAE National Conference Invitation fixture passes with `status: 'passed'`, `criticalPass: true`, and zero hard failures.
2. **Negative Controls Suite**: 10 distinct deliberate critical defects are rejected for their specific intended reasons:
   - `NC-01` (Altered Date) -> `PROTECTED_TOKEN_MUTATED`
   - `NC-02` (Altered Statutory Decree) -> `PROTECTED_TOKEN_MUTATED`
   - `NC-03` (Confidentiality Leak) -> `CONFIDENTIALITY_POLICY_VIOLATION`
   - `NC-04` (Wrong Logo Hash) -> `OFFICIAL_LOGO_MISSING_OR_MUTATED`
   - `NC-05` (Invisible Text) -> `INVISIBLE_TEXT_DEFECT`
   - `NC-06` (Text Overflow / Clipping) -> `TEXT_OVERFLOW_DEFECT`
   - `NC-07` (Unsupported Font Glyphs) -> `FONT_GLYPH_COVERAGE_DEFECT`
   - `NC-08` (Missing Aspect Ratio Variant) -> `REQUIRED_PAGE_VARIANT_MISSING`
   - `NC-09` (Zero Renders) -> `ZERO_RENDERS_DEFECT`
   - `NC-10` (Nonexistent Output Package) -> `NONEXISTENT_PACKAGE_ERROR`
3. **Advisory Critique Invariant**: A high vision model advisory score (99/100) CANNOT waive hard failures. Status remains strictly `failed` with `waivedHardFailuresCount: 0`.
4. **Coverage Block Invariant**: Insufficient inspection coverage (`semanticCoverage.isComplete: false`) marks quality status as `BLOCKED`, preventing unobserved layers from passing as verified work.

## Evidence Artifacts
- `POSITIVE_BASELINE_REPORT.json`: Clean QA report for canonical KAAE invitation.
- `NEGATIVE_CONTROLS_REPORT.json`: Complete 10-point negative control rejection matrix.
- `ADVISORY_CRITIQUE_INVARIANT_TRACES.json`: Proof that model advisory critique cannot waive hard defects.
- `COVERAGE_BLOCK_RECORDINGS.json`: Proof that unobserved layers cause BLOCKED status.
- Automated Test Suite: `apps/core/test/canva-work-quality-inspection.test.ts` (13/13 passing).
