# ADR 017: Embedded Professional Agency Editor in Hawa Desk

**Status:** Approved  
**Date:** 2026-09-10  
**Deciders:** Hawzhin, Antigravity Agent  
**Reconciles & Refines:** ADR 002 (HyCanvas Studio), ADR 016 (Figma Agent Studio)  

---

## 1. Context & User Directive

Following the comprehensive manual editor audit (`output/research/2026-09-10-manual-editor/REPORT.md`) and hands-on operational evaluation, the user established an explicit product directive:

1. **Editing Stays Inside Hawa**: Primary agency design review, manual adjustment, and operator approval must occur directly inside **Hawa Desk** (`apps/desk`), without forcing operators into external third-party software for everyday invitation, certificate, poster, and announcement tasks.
2. **Professional Agency Scope**: The target capability is focused, high-precision layout and typographic editing for agency deliverables (KAAE invitations, institutional announcements, bilingual campaign cards). It does not require duplicating complex photographic digital painting or arbitrary 3D rendering.
3. **Truthful Infrastructure & Honest State**: The editor must eliminate hardcoded connectivity assurances (ME-01), flawed persistence promises (ME-02, ME-03), lossy hydration (ME-04), synthetic export reconstruction (ME-05), and distorted viewport fitting (ME-08).
4. **Commercial SDK Acceptance**: Embedding a proven, paid layout engine (such as Polotno SDK or IMG.LY CE.SDK) is approved, subject to verified terms, transparent licensing, and rigorous qualification.

---

## 2. Decision

We establish the **Hawa Embedded Professional Agency Studio** as the primary interactive canvas in Hawa Desk:

1. **Authoritative In-App Canvas**:
   - The primary interactive design environment is embedded directly inside Hawa Desk (`apps/desk/src/screens/ReviewScreen.tsx`).
   - The editor is powered by an admitted, self-contained layout engine (evaluated and pinned under ADR 018), backed by the neutral manifest and `DesignStudioAdapter` boundary.
   - External Figma synchronization (ADR 016) remains an optional, explicitly declared export/handoff adapter, but is **never** presented as connected without a live verified handshake and readback.

2. **One Document, One Reliable Persistence Pipeline**:
   - Local drafts are persisted via IndexedDB and reconciled with localStorage backup.
   - Writes commit upon transaction completion (`tx.oncomplete`), rejecting on abort or error (resolving ME-02).
   - Draft loading performs active reconciliation between IndexedDB and localStorage, selecting the newest verified revision by `version`, timestamp, and SHA-256 integrity (resolving ME-03).
   - Explicit empty strings and empty node collections are preserved during hydration without false absence assumptions (resolving ME-04).
   - Multi-state save indicators (`Unsaved`, `Saving to Device`, `Saved on Device`, `Syncing to Server`, `Saved to Server`, `Conflict`, `Save Failed`) are strictly bound to the active revision ID (resolving ME-06).

3. **Faithful Unified Rendering & Export**:
   - High-resolution PNG, SVG, and vector PDF exports render the **exact node hierarchy** from the canonical document, completely eliminating synthetic gradient or decorative badge reconstruction (resolving ME-05).
   - Graphic coordinates map 1:1 between interactive artboard presets and output export targets.

4. **Preservation of Core Architectural Invariants**:
   - **PostgreSQL Ledger (Invariant #2)**: Tasks, immutable revisions, and Client DNA remain stored in PostgreSQL 17/18 with RLS.
   - **Client Isolation (Invariants #4 & #6)**: Hard client boundary enforced before retrieval or asset binding.
   - **Approval Invalidation (Invariant #11)**: Any manual mutation of approved copy or protected brand assets immediately invalidates prior approval, transitioning the task to `IN_PROGRESS` and blocking publication until re-evaluated.
   - **Kurdish Typographic Integrity (Invariant #8)**: Kurdish Sorani and Arabic text shaping, diacritic clearance, and RTL bidirectionality remain verified by deterministic QA.

---

## 3. Requirement Traceability Matrix

| Requirement ID | Area | Architectural Guarantee in ADR 017 |
|---|---|---|
| **FR-028** | Node Editability | Direct interactive translation, scaling, rotation, opacity, and layer ordering inside Hawa Desk. |
| **FR-029** | Vector Assets | Preservation of verified SVG logo structures without raster flattening or synthetic substitution. |
| **FR-032** | Brand Kit Sync | Client DNA palettes, fonts, and verified emblems bind directly to the editor inspector. |
| **FR-034** | Typography | Full native font loading for `Cairo`, `Noto Sans Arabic`, and `Minion Variable Concept`. |
| **FR-035** | Bilingual Layouts | Independent LTR and RTL text node support with accurate text wrapping and alignment. |
| **FR-037** | Diacritic Clearance | Kurdish diacritics (ڵ, ڕ, ێ, ۆ) rendered with verified line-height to prevent clipping. |
| **FR-041** | Inspector UX | Real-time numeric properties inspector following the current layer selection. |
| **FR-042** | Revisions | Every committed change produces an immutable revision with SHA-256 content proof. |
| **FR-044** | Human Approval | Truthful operator approval gate; approval requires verified QA clearance. |
| **FR-045** | Mutation Guard | Post-approval manual edits automatically revoke approval and invalidate publication receipts. |
| **FR-052** | Governed Learning | Observed manual layout corrections are captured by `FeedbackMiner` as candidate rules. |
| **FR-075** | Export Packages | Faithful multi-format export (PNG 1x/2x/4x, SVG, PDF) directly from canonical document state. |
| **NFR-001** | Data Loss | Zero lost edits via dual-store transaction-safe persistence and offline recovery. |
| **NFR-003** | Integrity | Cryptographic SHA-256 verification of canonical document manifests upon load. |
| **NFR-008** | Idempotency | Stable operation IDs and revision guards prevent duplicate saves or lost updates. |
| **NFR-012** | Offline Resilience | Full client-side editing and draft persistence without requiring cloud connectivity. |
| **NFR-016** | Responsive Canvas | Viewport-aware layout adapting cleanly between desktop and narrow mobile displays. |
| **NFR-021** | Fit View Navigation | Dynamic fit-to-view calculation using measured DOM bounding client rects and padding. |

---

## 4. Consequences

### Positive
- Delivers an intuitive, focused, agency-grade editing experience directly inside Hawa Desk.
- Eliminates operator friction caused by requiring external design tool licenses or local Desktop plugins for routine tasks.
- Eliminates 8 major source-confirmed defects (ME-01 through ME-08).
- Provides honest, transparent saving and export feedback without false assurances.

### Negative / Trade-offs
- Advanced photographic manipulation (destructive raster masking, content-aware fill, frequency separation) remains outside the embedded editor scope (delegated to ComfyUI or native Adobe desktop if needed).
- Potential commercial licensing fee for an embedded layout SDK (budgeted and evaluated under ADR 018).
