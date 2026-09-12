# Task CV-09: Preserve Original Client Knowledge and Assets

**Task ID:** CV-09  
**Depends On:** CV-04  
**Requirements:** FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-017, FR-018, FR-019, FR-020, FR-021, FR-022, FR-023, FR-027, FR-037, FR-066, FR-067  
**Status:** VERIFIED (100% Complete)  
**Date:** 2026-09-11  

---

## 1. Summary of Changes

Task **CV-09** preserves client knowledge, brand guidelines, and official vector assets across PostgreSQL, domain models, retrieval, and Canva bindings:

1. **Client Knowledge & Canva Mapping Model:**
   - Extended `ClientDNA` with `CanvaClientMapping` (`canvaTeamId`, `canvaBrandKitId`, `canvaTemplateIds`, `canvaFolderId`, `verifiedAt`).
   - Validated that naked Brand Kit names without verified Team IDs are rejected (`INVALID_CANVA_TEAM_MAPPING`, `INVALID_CANVA_BRAND_KIT_MAPPING`).
2. **Three Authentic Ground-Truth Clients:**
   - **KAAE** (`c1000000-0000-4000-8000-000000000002`): Ground truth from `KAAE_Guidelines4.pdf` with page citations, official logos (SHA-256 `40dab5f8ca...` and vector SVG `accadd24fd...`), statutory disclaimers (Law No. 6 of 2022), and Canva mapping (`team_kaae_erbil`, `kit_kaae_2026`).
   - **Drustee** (`c1000000-0000-4000-8000-000000000003`): Evidence-first botanical health in Erbil, official logo (SHA-256 `6a3f120199...`), prohibited claims, and Canva mapping (`team_drustee_erbil`, `kit_drustee_2026`).
   - **Aster** (`c1000000-0000-4000-8000-000000000004`): Luxury resort and hospitality in Erbil, official crest logo (SHA-256 `8e1c940562...`), luxury guidelines, and Canva mapping (`team_aster_erbil`, `kit_aster_2026`).
3. **Strict Client Isolation & Cross-Client Bleed Prevention (Invariant #6):**
   - Scoped retrieval in `RetrievalService` and `VaultSearchEngine` enforces hard client boundaries before similarity scoring.
   - Negative bleed controls prove that querying Drustee keywords under KAAE returns zero Drustee results, and querying KAAE keywords under Aster returns zero KAAE results.
4. **Missing & Conflicting Guideline Defense:**
   - Missing required brand assets cause a blocking resolution (`MISSING_BRAND_ASSET`), never inventing placeholder or synthetic branding.
   - Conflicting claims and prohibited lexicon (e.g., "Magic cure") trigger blocking conflicts (`PROHIBITED_LEXICON_VIOLATION`), halting unauthorized generation.
5. **Untrusted Upload & Reference Sanitization:**
   - Created `sanitizeUntrustedUpload` in `@hawa/retrieval`: validates MIME types, bounds payload sizes, strips active scripts and handlers from SVGs, and computes cryptographic SHA-256.

---

## 2. Test Verification

The test suite `apps/core/test/client-knowledge-assets.test.ts` passes 6/6 tests:
1. `Three-client retrieval isolation: strictly prevents cross-client retrieval and brand bleed`: PASS
2. `Canva mapping validation: requires verified team ID and brand kit ID, rejects naked kit names`: PASS
3. `Missing guideline/asset defense: causes a visible block or clarification, never invented branding`: PASS
4. `Conflicting guideline & prohibited lexicon defense: detects prohibited claims and blocks generation`: PASS
5. `Untrusted upload sanitization: neutralizes active SVG scripts while preserving clean vectors`: PASS
6. `Ground-truth KAAE reference retrieval before generation`: PASS

Zero test pollution verified on production database `hawa` (1,449 tasks, 1,449 outbox commands maintained).

---

## 3. Evidence Artifacts

- [`CLIENT_REFERENCE_MANIFEST.json`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-09/CLIENT_REFERENCE_MANIFEST.json)
- [`THREE_CLIENT_RETRIEVAL_CONTROLS.json`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-09/THREE_CLIENT_RETRIEVAL_CONTROLS.json)
- [`MISSING_AND_CONFLICTING_GUIDELINE_TESTS.json`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-09/MISSING_AND_CONFLICTING_GUIDELINE_TESTS.json)
