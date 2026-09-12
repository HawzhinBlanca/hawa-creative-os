# ADR 019: Architectural Decomposition Strategy for Hawa Desk ReviewScreen

**Status:** Approved  
**Date:** 2026-09-11  
**Deciders:** Hawzhin, Antigravity Agent  
**Belongs to:** Phase 3 (Editor Architecture & DOM Sanitization) / Phase 4 (Reliability & Maintainability)  
**Parent ADRs:** ADR 017 (Embedded Professional Agency Editor), ADR 018 (Admission of Polotno Engine)  

---

## 1. Context & Problem Statement

`apps/desk/src/screens/ReviewScreen.tsx` has grown to **10,529 lines** of TypeScript/React code within a single monolithic file. While the editor delivers high capability (multi-format vector composition, Kurd-centric typography clearance, Polotno engine bridge, IndexedDB offline draft storage, transactional history trees, and omnichannel export bundles), this monolith poses severe architectural liabilities:

1. **Cognitive Load & Blast Radius**: Any edit to UI styling or toolbars risks introducing regressions into core state invariants (undo/redo transactional boundaries, autosave debounce, or DOM sanitization sinks).
2. **Re-render Granularity**: Fine-grained canvas interactions (e.g. dragging a transform handle or cursor hovering over a layer) trigger re-evaluations across the inspector, layer tree, and diagnostics.
3. **Co-mingling of Concerns**: Hardcoded SVG vector assets, artboard presets, geometry math, Polotno adapter synchronization, and modal dialogs are co-located in the same compilation unit.

---

## 2. Decomposition Architecture

The monolithic `ReviewScreen.tsx` is structured into seven discrete, decoupled component boundaries under `apps/desk/src/components/editor/`:

```
apps/desk/src/
├── screens/
│   └── ReviewScreen.tsx                # Orchestrator & State Coordinator (< 400 LOC)
├── components/editor/
│   ├── StudioToolbar.tsx               # Top navigation, presets, zoom, export, approval
│   ├── CanvasStage.tsx                 # Viewport, artboard, Polotno/Konva bridge, selection
│   ├── InspectorPanel.tsx              # Right rail: Geometry, Kurdish typography, colors, shadows
│   ├── LayerTreePanel.tsx              # Left rail: Layer stack, reorder, visibility, lock, rename
│   ├── HistoryModal.tsx                # History tree timeline, revision branching, snapshots
│   ├── QADiagnosticsDrawer.tsx         # Bottom/overlay: RTL clearance, WCAG contrast, brand kit
│   └── AssetsDrawer.tsx                # Client DNA logos, official marks, template vector assets
├── services/
│   ├── draftStorage.ts                 # IndexedDB/localStorage durable draft storage (ME-02)
│   ├── historyTree.ts                  # Transactional immutable tree-based undo/redo (ME-04)
│   ├── polotnoEngine.ts                # Polotno SDK bidirectional adapter (ADR 018)
│   ├── canvasExport.ts                 # High-res PNG/SVG/HYC/Master Delivery bundler (ME-05)
│   └── sanitizer.ts                    # Strict DOMPurify SVG profile sanitization
└── assets/
    └── editorPresets.ts                # ARTBOARD_CONFIG, client demo SVGs, palette definitions
```

---

## 3. Component Contracts & Responsibility Matrix

| Subcomponent | Scope & Responsibility | Inputs (Props) | Outputs (Callbacks) |
|---|---|---|---|
| `ReviewScreen` (Container) | Owns root editor state (`nodes`, `selectedNodeIds`, `historyTree`, `draftKey`), lifecycle hydration, autosave flush, and task synchronization. | `task: TaskItem` | `onApprove`, `onReject`, `onPublish` |
| `StudioToolbar` | Format switcher (`1:1`, `4:5`, `9:16`), zoom controls (`25%` to `400%`), undo/redo triggers, export actions, and publication CTA. | `format`, `zoom`, `canUndo`, `canRedo`, `draftSavedAt`, `qaScore` | `onFormatChange`, `onZoomChange`, `onUndo`, `onRedo`, `onExport`, `onPublish` |
| `CanvasStage` | The rendering surface. Hosts Polotno engine canvas or fallback interactive SVG vector tree, selection bounds, transform gizmos, and inline text editing. | `nodes`, `selectedNodeIds`, `artboardSize`, `zoom`, `panOffset` | `onNodesChange`, `onSelectNodes`, `onPanChange` |
| `InspectorPanel` | Property inspector for selected node(s). Exposes geometric bounds, font family, weight, Kurdish RTL shaping, digit conversion (Eastern vs. Western), fill/stroke, and drop shadows. | `selectedNodes: CanvasNode[]`, `activeBrandKit: BrandKit` | `onUpdateNodeProperties(nodeId, patch)` |
| `LayerTreePanel` | Visual scene graph tree. Drag-and-drop layer reordering, lock/unlock, visibility toggling, group/ungroup, and node deletion. | `nodes: CanvasNode[]`, `selectedNodeIds: string[]` | `onReorderNodes`, `onToggleLock`, `onToggleVisible`, `onDeleteNodes` |
| `HistoryModal` | Visual tree of historical revisions. Shows user actions, timestamps, divergence branches, and allows jumping to any ancestor node without data loss. | `historyTree: HistoryTree`, `isOpen: boolean` | `onJumpToRevision(nodeId)`, `onClose` |
| `QADiagnosticsDrawer` | Live automated audit panel. Evaluates Kurdish typography clearance, diacritic clipping, WCAG 2.1 AA/AAA contrast ratios, and brand color alignment. | `nodes: CanvasNode[]`, `diagnostics: QADiagnosticResult` | `onAutoFix(ruleId)` |

---

## 4. Architectural Invariants Preserved

During and after decomposition, the following foundational invariants must remain strictly preserved:

1. **Invariant #2 (Live Editable Vector Trees)**: All exportable designs remain discrete, editable vector nodes. No layer flattening into raster bitmaps.
2. **Invariant #5 (DOM Sanitization)**: All raw SVG insertions must pass through `sanitizeSvgContent()` via DOMPurify before entering the DOM or canvas.
3. **P1 Auto-Save Contract**: Unmount flush via `latestDraftRef` and `beforeunload` listener ensures 0 draft loss on navigation, refresh, or tab closure.
4. **Adapter Confinement (ADR 018)**: Polotno-specific types remain strictly encapsulated within the desk package; domain contracts and core repositories remain pure.

---

## 5. Phasing & Migration Plan

1. **Step 1 (Static Asset Extraction)**: Move static asset dictionaries (`DRUSTEE_SVGS`, `KAAE_SVGS`, `ARTBOARD_CONFIG`) to `apps/desk/src/assets/editorPresets.ts`.
2. **Step 2 (Leaf Component Extraction)**: Extract pure presenter components: `HistoryModal`, `QADiagnosticsDrawer`, and `StudioToolbar`.
3. **Step 3 (Panel Extraction)**: Extract `InspectorPanel` and `LayerTreePanel` with explicit property update callbacks.
4. **Step 4 (Stage Decoupling)**: Encapsulate canvas rendering logic inside `CanvasStage`.
5. **Step 5 (Container Refactor)**: Reduce `ReviewScreen.tsx` to a high-level state coordinator (< 400 lines).

---

## 6. Verification & Ratchet

- All 80 test suites (514 unit/integration tests) must remain 100% green.
- `apps/desk` must build cleanly under `vite build` and pass strict TypeScript compilation (`tsc -b`).
- Zero DOM vulnerabilities, zero hardcoded secrets, zero regression on offline draft hydration.
