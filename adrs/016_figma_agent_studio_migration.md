# ADR 016: Migration to Figma Agent Studio (Figma Design + Figma Buzz)

**Status:** Approved  
**Date:** 2026-09-06  
**Deciders:** Hawzhin, Antigravity Agent  
**Supersedes:** ADR 002 (HyCanvas Studio), ADR 003 (.hyc Source), ADR 014 (Fallback Editor), ADR 015 (Editor Admission Decision)

---

## Context

In Hawdesign v1.0, significant engineering was dedicated to developing an in-house browser vector studio editor (HyCanvas), a bespoke JSON document schema (`.hyc`), and custom canvas rendering. 

While HyCanvas proved the viability of deterministic vector tree round-trips in isolated testbeds, real-world agency production for institutional clients (such as KAAE) revealed structural limitations:
1. Re-implementing professional design tool features—such as multi-phase mathematical Guilloche curve rendering, 3D embossed specular lighting, complex font ligature shaping, and auto-layout variations—diverted core focus away from proprietary agency intelligence.
2. Human art directors and clients work natively in Figma, requiring frictionless handoffs, live component libraries, and direct visual inspection.
3. High-volume marketing campaigns require instant template substitution and multi-aspect ratio resizing (1:1, 4:5, 9:16, 16:9), which Figma Buzz delivers natively.

---

## Decision

We migrate Hawa Creative OS to **Figma Agent Studio v2.0.0**:

1. **Figma Design** is the master creative environment for brand kits, design tokens, component variables, and novel compositions.
2. **Figma Buzz** is the high-velocity production factory for recurring social cards, announcements, and variant resizing.
3. **Hawa Figma Bridge** (based on a curated, hardened fork of `southleft/figma-console-mcp`) serves as the local Desktop Plugin API bridge on loopback (`ws://127.0.0.1:43001`), operating with:
   - Mandatory task write leases (`figma_leases`).
   - Strict staging area confinement (`30_AI_STAGING`).
   - Expected revision locking (`expected_revision`).
   - HarfBuzz Kurdish Sorani typography pre-validation (`Cairo`, `Noto Sans Arabic`).
4. **Hawa Core** maintains absolute ownership over task lifecycle, PostgreSQL Client DNA, deterministic QA validation, model orchestration, and Google Drive/Sheets publishing.
5. All existing operational infrastructure (Google Drive, Google Sheets, WhatsApp/WAHA, Telegram, and Hawa Desk PWA) is preserved.

---

## Invariants Preserved

- **Invariant #1 (Client Scope Immutability)**: Client scope is locked before Figma file retrieval or staging writes.
- **Invariant #2 & #4 (Live Vector Fidelity)**: Protected copy, logos, and factual text remain live, editable native Figma text layers; AI image models generate ingredients only.
- **Invariant #5 (Single Writer Lease)**: Only one agent holds an active write lease on a task at any given time.
- **Invariant #8 (Kurdish Typographic Integrity)**: All Sorani/Arabic glyphs undergo clearance and HarfBuzz shaping verification.
- **Invariant #10 & #12 (Idempotent Publication)**: Exports to Google Drive and Google Sheets remain content-addressed and strictly idempotent.

---

## Consequences

- **Positive**:
  - Unlocks genuine 10/10 visual production quality matching high-end international design standards.
  - Zero maintenance burden on custom web canvas rendering or custom vector serializers.
  - Native designer collaboration inside Figma.
  - Fast, zero-model-cost variant resizing via Figma Buzz.
- **Negative / Mitigations**:
  - Dependency on local Figma Desktop app and bridge WebSocket for live autonomous execution.
  - *Mitigation*: Fallback sandbox emulation in `FigmaBridgeAdapter` ensures offline CI tests, local builds, and development continue without hard failure.
