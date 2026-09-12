# CV-23 Evidence Packet — Complete Decommissioning of Figma & Legacy Editor Runtime

**Task Identifier:** `CV-23`  
**Target:** Remove Figma and legacy editor runtime completely  
**Dependencies:** CV-22  
**Normative Requirements:** FR-030, FR-064, FR-073, FR-074, FR-075, FR-080, NFR-012, NFR-018, NFR-023  
**Cutover Release:** `v2.0.0-canva-cutover`  
**Decommission Status:** `VERIFIED_COMPLETE`  
**Verification Date:** 2026-09-12T02:25:00.000Z  

---

## 1. Executive Summary

Under **CV-23**, all remnants of the legacy Figma bridge transport and the retired Polotno/Konva custom editor runtime have been permanently deleted and decommissioned from the production repository.

Canva Native Studio is now the sole active design studio for all admitted clients (**KAAE**, **Drustee**, and **Aster**). The legacy Figma lease transport routes now strictly return **HTTP 410 GONE** (`FIGMA_TRANSPORT_DECOMMISSIONED`), and the monolithic `ReviewScreen.tsx` (9,500+ LOC) along with Polotno SDK dependencies have been completely purged from `apps/desk`.

---

## 2. Decommission Inventory & Artifact Manifest

| Evidence File | Format | Description |
|---|---|---|
| [`DECOMMISSION_MANIFEST.csv`](DECOMMISSION_MANIFEST.csv) | CSV | Granular inventory of all 13 deleted files, 7 retired routes, 1 deleted dependency, and 3 pruned environment variables |
| [`DEPENDENCY_GRAPH_DIFF.json`](DEPENDENCY_GRAPH_DIFF.json) | JSON | Package dependency diff proving `polotno` removal and net -59 transitive packages in `pnpm-lock.yaml` |
| [`PRODUCTION_BUNDLE_SCAN.json`](PRODUCTION_BUNDLE_SCAN.json) | JSON | Static analysis audit of `apps/desk/dist` proving zero residual Polotno or legacy Konva imports |
| [`CLEAN_HOST_VERIFICATION.json`](CLEAN_HOST_VERIFICATION.json) | JSON | Verification records of clean builds, test executions, and database invariant verification |
| [`BEFORE_AFTER_FOOTPRINT.json`](BEFORE_AFTER_FOOTPRINT.json) | JSON | Quantitative footprint analysis (-15,740 LOC, -1.0 MB dead code removed, -59 packages) |

---

## 3. Key Decommission Highlights

1. **Purged Monolithic Editor Engine:**
   - Deleted `apps/desk/src/screens/ReviewScreen.tsx` (9,553 lines, 429 KB).
   - Deleted `polotnoEngine.ts`, `historyTree.ts`, `canvasExport.ts`, `reflowEngine.ts`, `editorPresets.ts`.
   - Deleted 408 KB of embedded base64 font blobs (`cairoFontBase64.ts`, `interFontBase64.ts`, `vazirmatnFontBase64.ts`).

2. **Removed Polotno Vendor Dependency:**
   - Removed `"polotno": "^4.12.1"` from `apps/desk/package.json`.
   - Purged 59 transitive dependencies from `pnpm-lock.yaml`.
   - `apps/desk` production bundle reduced and zero runtime warnings.

3. **Retired Figma Transport Routes with HTTP 410 GONE:**
   - `POST /tasks/:taskId/leases` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)
   - `POST /tasks/:taskId/figma/lease` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)
   - `DELETE /tasks/:taskId/leases/:leaseId` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)
   - `POST /tasks/:taskId/figma/mutate` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)
   - `GET /tasks/:taskId/figma/status` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)
   - `GET /v1/figma/status` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)
   - `GET /figma/status` -> 410 GONE (`FIGMA_TRANSPORT_DECOMMISSIONED`)

4. **Preserved Test Fakes & General Utilities:**
   - Preserved general upload and asset utilities (`draftStorage.ts`, `paletteExtractor.ts`, `sanitizer.ts`, `zipBundler.ts`) with passing unit test suites.
   - Preserved clearly named test fakes (`FakeFigmaBridge`) under test-only boundaries (`packages/testkit`).
   - Preserved historical source migration archives (`apps/core/archive/historical-designs/`) per provenance requirements.

---

## 4. Test Verification Matrix

| Test Suite | File | Tests | Result |
|---|---|---|---|
| CV-23 Decommission Suite | `apps/core/test/decommission-figma-editor-runtime-cv23.test.ts` | 7 / 7 | PASS |
| Core Test Suite | `apps/core/test/*.test.ts` | 31 files / 236 tests | PASS |
| Integrations Suite | `packages/integrations/test/*.test.ts` | 11 files / 65 tests | PASS |
| Desk Active Suite | `apps/desk/test/*.test.ts` | 4 files / 17 tests | PASS |
| Total Tests Verified | Monorepo Core + Integrations + Desk | 318 tests | PASS |

---

## 5. Invariant Checks

- **Database Zero Pollution:** `hawa.tasks` = 1,449, `hawa.outbox_commands` = 1,449 (verified clean).
- **Blueprint Validation:** `PASS=466, WARN=0, FAIL=0` maintained.
- **Architectural Integrity:** ADR 021 and ADR 020 enforced; Canva Native Studio is sole active studio.
