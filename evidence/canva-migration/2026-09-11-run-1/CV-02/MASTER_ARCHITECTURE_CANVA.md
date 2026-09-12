# Master Architecture Specification: Hawa Native Canva Studio Migration

**Audit Date:** 2026-09-11  
**Task:** CV-02  
**Governing ADR:** ADR 020 (`adrs/020_native_canva_studio_architecture.md`)  
**Superseded ADRs:** ADR 016 (Figma), ADR 018 (Polotno Embedded)  

---

## 1. Architectural Invariants & Boundary Contracts

The Hawa architecture is structured around three strictly quarantined domains:

```
+---------------------------------------------------------------------------------------------------------+
|                                        1. HAWA CONTROL PLANE (SOVEREIGN)                                |
|                                                                                                         |
|  - PostgreSQL `hawa`: Canonical tasks, outbox_commands, task_events, client_profiles, brand_dna         |
|  - Ingress: Telegram webhook, WhatsApp (WAHA) webhook, Lean Desk Work intake                            |
|  - Orchestration: Durable execution (Restate / Outbox transaction loop)                                |
|  - Creative Planner: Structured brief generation, exact copy lock, client DNA retrieval                 |
|  - Studio Repository: `canva_bindings` (task_id, client_id, canva_design_id, export_hash, version)      |
|  - Quality Preflight: CMYK color space check, dimensions, Kurdish diacritic clearance                   |
|  - Approval Engine: Human review gate, immutable SHA-256 approval lock                                 |
+---------------------------------------------------------------------------------------------------------+
                                 |                                        ^
       Canva Handoff Deep-Link   |                                        | Ingest Verified Artifacts
       `https://canva.com/...`   v                                        | (PDF Print CMYK / PNG)
+--------------------------------------------------+   +--------------------------------------------------+
|          2. CANVA STUDIO (CREATIVE MASTER)       |   |         3. GOOGLE DRIVE / SHEETS (DELIVERY)    |
|                                                  |   |                                                  |
|  - Native Web / Desktop Canva Pro Studio         |   |  - Google Drive Client API                       |
|  - KAAE Institutional Brand Kit & Fonts          |   |  - Organized folder hierarchy                    |
|  - Vector layers, rich typography, masks         |   |  - Idempotent upload by content SHA-256          |
|  - Bounded MCP Assistant (text replace, layout)  |   |  - Google Sheets operations log upsert           |
|  - Export: PDF Print (CMYK, bleed), PNG          |   |  - Telegram channel client notification          |
+--------------------------------------------------+   +--------------------------------------------------+
```

---

## 2. Source Ownership & Disaster Recovery Contract

### 2.1 The Working Master
The **Canva Cloud Design** (referenced by `canva_design_id`) is the authoritative working master for layout, typography, layer hierarchy, and visual design.

### 2.2 The Sovereign System of Record
**Hawa PostgreSQL** is the authoritative system of record for:
- Task requirements, deadlines, client identity, and message provenance.
- The approved creative brief (exact headline, body copy, required CTA, dimensions).
- Client brand DNA (approved vector SVG logos, primary/secondary hex color palettes, font specifications).
- Immutable artifact history (SHA-256 hashes, byte sizes, preflight check results, human approver identity, approval timestamp).

### 2.3 Reconciliation of Offline Portability (FR-028, NFR-010, NFR-019)
- **Empirical Reality:** Exporting an SVG from Canva converts all text into outlined path vectors (94 paths, 0 live text nodes). Importing an SVG into Canva flattens the artwork into a single bitmap image. Therefore, an SVG is not an editable offline master.
- **Disaster Recovery Guarantee:** If Canva service is interrupted, full disaster recovery is achieved because Hawa retains the structured brief, raw copy, vector logos, and color tokens in PostgreSQL. Any design can be reconstructed either in a fresh Canva design or an alternate studio using Hawa's sovereign data.

---

## 3. The Lean Desk: Work / Clients / Settings

With the embedded canvas retired, `apps/desk` transitions from a 10,000-line embedded canvas to a clean, focused 3-tab operational cockpit:
1. **Work:** Canonical task list, status filters, ingress promotion, Canva studio launch button, artifact dropzone/ingest, preflight status, and approval controls.
2. **Clients:** Client directory, brand DNA manager, approved vector logo vault, official typography rules, and past delivery archives.
3. **Settings:** Integration health monitor (Telegram, WhatsApp, Canva bindings, Model gateway, Google Drive, PostgreSQL).

Further work on Polotno toolbars, decomposition, or Konva canvas bridges is permanently stopped.
