# Task CV-12 Verification: Qualify Native Manual Editing and Bounded AI Edits

## Summary
Task CV-12 establishes production-qualified native manual editing and bounded AI edits for Hawa Creative OS on native Canva Studio, fulfilling requirements **FR-031, FR-032, FR-033, FR-034, FR-035, FR-036, FR-037, FR-041, FR-042, NFR-008, NFR-009, NFR-016**.

## Key Verifications & Architectural Invariants
1. **Canva Native UI Delegation**: Text, font, spacing, geometry, crop, alignment, layer/group, undo/redo, and multi-ratio variants are handled natively in Canva across Desktop Web (Chrome/Safari/Firefox) and Mobile App (iOS/Android). Hawa never recreates these controls.
2. **Single Automation Lease Coordination**: Hawa automated AI writers acquire a single automation lease (`acquireAutomationLease`). A second concurrent automated writer is rejected with HTTP 409 (`AUTOMATION_LEASE_HELD`).
3. **External Human Designers Never Locked**: Invariant proven: `isExternalHumanLocked: false`. External human designers working in Canva can edit anytime.
4. **Anti-Overwrite Invariant (Concurrent Human Modification Defense)**: When an automated writer attempts to stage edits against a stale source observation hash (`expectedSourceSha256`), the system detects human modifications and aborts with `EXPECTED_REVISION_MISMATCH`. Human edits are never overwritten.
5. **Transactional Edit Staging & Geometry Reflow**: Staged edits (`stageEditTransaction`) allow preview readbacks (`previewReadback`) and apply post-formatting geometry reflow (e.g. height expansion for expanded Kurdish Sorani text) to prevent canvas clipping.
6. **Immutable Lineage & Cancel Safety**: Committing an edit transaction increments version (`v1 -> v2`), preserves `parentRevisionId`, logs to revision history, and releases the lease. Cancelling discards the staging and restores pristine state with 0 byte drift.
7. **Unsupported Action Translation**: Operations that cannot be safely executed automatically (e.g. `arbitrary_vector_morph`, `lossy_raster_overdraw`) are translated into named native human actions (`HUMAN_ACTION_RECOMMENDED`) with deep links to Canva editor instead of triggering destructive whole-design regeneration.
8. **50 Undo/Redo Stress Fixture Qualification**: Successfully qualified 50 continuous undo/redo cycles on the KAAE National Conference Invitation master fixture: zero dropped nodes, zero dropped text, and byte-for-byte baseline recovery.
9. **Central Kurdish & Arabic Font Licensing & Glyph Coverage**: Validates client fonts (Cairo, Vazirmatn, Noto Naskh Arabic) covering Sorani letters (پ, چ, گ, ڤ, ۆ, ێ, ڵ, ڕ, ە); rejects Latin-only fonts with `FONT_GLYPH_COVERAGE_ERROR`.
10. **Linked Aspect Ratio Variants**: Master `4:5` (1080x1350) layout generates linked variants for `1:1` (1080x1080) and `9:16` (1080x1920) while preserving explicit per-variant overrides.

## Evidence Artifacts
- `DESKTOP_MOBILE_EDIT_MATRIX.json`: Platform URLs, deep links, and delegated control mappings.
- `STRESS_FIXTURE_50_UNDO_REDO_CYCLES.json`: 50-cycle undo/redo stress qualification metrics.
- `CONCURRENT_HUMAN_AI_EDIT_TESTS.json`: Lease contention and anti-overwrite traces.
- `SAVE_REOPEN_CANCEL_RECORDINGS.json`: Transactional commit, preview, and cancel traces.
- `UNSUPPORTED_ACTION_FALLBACK_LOGS.json`: Translation of unsupported actions into human recommendations.
- Automated Test Suite: `apps/core/test/canva-manual-bounded-edit.test.ts` (9/9 passing).
