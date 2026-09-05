# ADR-015: Primary Vector Editor Admission & Proof Sprint Resolution

**Status:** Accepted / Formally Admitted  
**Date:** 2026-09-05  
**Context:** Phase 0 HyCanvas Proof Sprint (`docs/21_HYCANVAS_PROOF_SPRINT.md`) & `TASK_SHEET.md` Task `HD-010`  
**Deciders:** Lead Architect, Creative Engine Lead, Security Auditor  

---

## 1. Context and Problem Statement

`MASTER_SPEC.md` requires Invariant #2: **"Editable vector tree first — zero flattened bitmaps as masters."**
The project evaluated upstream native HyCanvas (pinned candidate release `v0.3.9`, MIT License) versus the focused browser-native custom vector studio editor (`Desk Studio`) embedded in `apps/desk`.

The proof sprint investigated:
1. Native Sorani/Arabic typography, Kashida, UAX #9 bidirectional text isolation, and diacritic ascender/descender clipping.
2. Complete lossless round-trip serialization of live vector nodes (geometry, z-order, transforms, groups, drop shadows, line heights, letter spacing, alignments) into `.hyc` packages.
3. Memory boundedness, offline recovery via IndexedDB/LocalStorage, and zero-alert UX.
4. Parity between interactive artboard rendering and headless production export (SVG, 2x Retina PNG, ZIP bundle).
5. Untrusted import attack surfaces (`HD-004`), ensuring malformed or adversarial SVG/HTML cannot execute.

---

## 2. Decision: Patch-and-Admit Adapter with Authoritative Custom Vector Editor

We **patch-and-admit** the editor architecture as follows:

1. **Authoritative Runtime Editor**:
   The custom browser-native vector studio editor in `apps/desk` (`ReviewScreen.tsx`, `canvasExport.ts`, `historyTree.ts`, `sanitizer.ts`) is formally admitted as the **authoritative interactive design tool** for Drustee and Hawdesign primary operations.
   - Preserves 100% live vector AST without raster flattening.
   - Enforces UAX #9 First-Strong directional isolation and standard Sorani orthography.
   - Enforces strict DOM sanitization (`sanitizeSvgContent`) on all imported markup.

2. **Interchange Compatibility via `DesignStudioAdapter`**:
   The `HyCanvasStudioAdapter` in `packages/integrations/src/hycanvas-adapter.ts` remains the stable adapter contract:
   - Uses real cryptographic SHA-256 (`node:crypto`) over canonical document representations.
   - Rejects unknown or non-existent documents fail-closed with typed `DOCUMENT_NOT_FOUND`.
   - Allows bidirectional interchange between upstream HyCanvas `.hyc` packages and Desk Studio.

3. **External Editor Boundary (Photoshop-Optional)**:
   Photoshop is designated as an **optional external editor** for complex manual raster retouching and specialized compositing. Flattened Photoshop outputs may never replace editable vector masters. High-resolution exports from Photoshop re-enter the workflow as linked image assets with cryptographic SHA-256 asset tracking, leaving the headline, copy, and layout live in Hawdesign.

---

## 3. Supported Operations & Capabilities

| Capability | Supported Status | Authoritative Implementation |
|---|---|---|
| Text Layers | Full (Live Vector) | `ReviewScreen.tsx` + SVG text runs with bidi isolation |
| Shape & Badge Layers | Full (Live Vector) | SVG rect, path, accent geometries |
| Kurdish Sorani Typography | Full (`ckb`, RTL) | `packages/qa/src/rtl-validator.ts` + Google Fonts / bundled Noto |
| Non-Destructive Undo/Redo | Full (Granular AST) | `historyTree.ts` (styling, geometry, ordering) |
| Local Persistence | Full (Atomic) | `draftStorage.ts` (IndexedDB + LocalStorage fallback) |
| Multi-Format Export | Full | SVG, 2x Retina PNG, `.hyc` package, Master Kit ZIP |
| Asset Sanitization | Full | `sanitizer.ts` (`sanitizeSvgContent`) |
| Google Drive/Sheets Publishing | Bounded / Gated | `google-publisher.ts` (fails closed if unconfigured) |

---

## 4. Consequences and Invariants Preserved

- **Invariant #2 Preserved**: Editable vector tree first; zero flattened bitmaps as masters.
- **Invariant #7 Preserved**: Hard deterministic QA blocks bad output; missing assets or copy mismatch cannot be bypassed.
- **Invariant #11 Preserved**: Verification is structural, cryptographic, and independent; no false passing certificates.
