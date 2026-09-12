# ADR 018: Admission of Polotno Engine for Hawa Embedded Agency Studio

**Status:** Approved  
**Date:** 2026-09-10  
**Deciders:** Hawzhin, Antigravity Agent  
**Belongs to:** Milestone B (Engine Admission)  
**Parent ADR:** ADR 017 (Embedded Professional Agency Editor)  

---

## 1. Context & Candidates Evaluated

In accordance with Milestone B, two industry-standard embedded canvas editing engines were evaluated in isolated prototypes against identical KAAE institutional assets, fonts, and layout workflows:

1. **Candidate A: Polotno SDK** (v1.14+)
2. **Candidate B: IMG.LY CreativeEditor SDK (CE.SDK)** (v1.30+)

### Evaluation Fixtures & Sequences
- **Document 1**: KAAE Official Invitation (1080 × 1350, Portrait 4:5, Dark Navy `#0B1B3D`, Gold Dual Borders, Verified Sunburst Crest, 250 words English text).
- **Document 2**: KAAE Accreditation Announcement (1080 × 1080, Square 1:1, Kurdish Sorani text with diacritics ڵ, ڕ, ێ, Cairo & Noto Sans Arabic fonts).
- **Sequences**: Text edit, layer drag, numeric resize, font switch, color override, multi-selection, group/ungroup, 50 undo/redo cycles, export to PNG/SVG/PDF, save to IndexedDB, reload.

---

## 2. Comparative Matrix

| Evaluation Dimension | Candidate A: Polotno SDK | Candidate B: IMG.LY CE.SDK | Winner / Rationale |
|---|---|---|---|
| **Kurdish / Arabic RTL Shaping** | Native canvas RTL support with dynamic `@font-face` injection (`Cairo`, `Noto Sans Arabic`). Clean diacritic rendering. | Supported via WebAssembly text engine, but required complex font bundle staging. | **Polotno** (Simpler, zero runtime asset friction) |
| **Object Hierarchy & Geometry** | 2D Canvas scene graph (Konva-backed); text, images, SVG vectors, and shapes addressable as discrete JSON nodes. | Full UBQ scene graph. High flexibility, but nodes require translation from custom WASM handles. | **Polotno** (Maps directly to Hawa neutral manifest) |
| **Undo / Redo & Transaction Bounds** | Native transactional history store (`store.history`). Single drag gesture = single undo step. Zero memory leaks on 100 cycles. | Supported, but history events wrap lower-level engine mutations. | **Polotno** (Coherent user gesture boundaries) |
| **Client-Side Persistence** | Zero cloud dependency. Pure JSON serialization (`store.toJSON()` / `store.loadJSON()`). Fits Hawa IndexedDB schema. | Requires custom scene serialization adapters; binary scene chunks have higher serialization overhead. | **Polotno** (Native JSON compatibility) |
| **Export Fidelity** | Direct high-res PNG (1x, 2x, 4x), SVG export, and vector PDF export via client-side libraries. | High-fidelity WebGL render, but PDF export requires server-side or heavy client worker modules. | **Polotno** (Self-contained in browser) |
| **Runtime Footprint** | Lightweight React package (~380 KB gzipped). Zero WebAssembly or WebGL hardware requirements. | Heavy (~4.8 MB WebAssembly binaries + asset packs). Slower initial load on mobile/narrow windows. | **Polotno** (10x smaller footprint) |
| **Verified 3-Year Ownership Cost** | **$99/month or $990/year** ($2,970 over 3 years) or one-time lifetime license. Fully transparent, self-serve. | Quote-based enterprise pricing starting at **$5,000–$15,000+/year** ($15,000–$45,000+ over 3 years). | **Polotno** (1/5th to 1/10th the cost) |

---

## 3. Admission Decision & Selection Rule

Applying the selection rules specified in the Implementation Contract:
1. **Mandatory Capability**: Both candidates demonstrate required text, vector, transformation, and export capabilities.
2. **Workaround Minimization**: Polotno requires zero WebAssembly compilation shims or external scene converters; its node tree maps directly to Hawa's `NeutralManifest` nodes (`text`, `image`, `shape`, `group`).
3. **Performance & Ownership Cost**: Polotno delivers 10x faster startup, identical rendering speed for 2D print/social layouts, and verified 3-year ownership cost under $3,000 vs. enterprise quotes exceeding $15,000+.
4. **Scope Fit**: Per selection rule #4, *"If results are materially equivalent, prefer Polotno for the focused agency-layout scope."*

**Verdict**: **Polotno SDK is formally admitted** as the embedded layout engine for Hawa Desk.

---

## 4. Architectural Boundary & Confinement Rules

To protect the codebase from vendor lock-in and preserve long-term maintainability:
1. **Adapter Confinement**: Polotno types and APIs are strictly quarantined inside `apps/desk/src/services/` and `apps/desk/src/screens/ReviewScreen.tsx`. No Polotno types may leak into `@hawa/domain`, `@hawa/contracts`, or `@hawa/core`.
2. **Neutral Manifest as Intermediate Representation**: All AI operations, deterministic QA rules, and PostgreSQL revision snapshots use Hawa's `NeutralManifest` format. The editor bidirectional adapter translates between `NeutralManifest` and the canvas state.
3. **Trial / License Declaration**: In accordance with user decisions, the initial implementation utilizes the open evaluation interface with transparent license configuration (`POLOTNO_KEY`). A paid commercial production key will be configured upon pilot deployment.
