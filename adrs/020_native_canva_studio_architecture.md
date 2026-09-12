# ADR 020: Native Canva Studio Architecture and Embedded Canvas Retirement

**Status:** Approved  
**Date:** 2026-09-11  
**Deciders:** Hawzhin, Antigravity Agent  
**Belongs to:** Canva Migration (CV-02)  
**Supersedes:** ADR 016 (Figma Agent Studio Migration), ADR 018 (Admission of Polotno Engine)  
**Parent ADRs:** ADR 001 (Office Inbox), ADR 004 (Restate Architecture), ADR 008 (PostgreSQL Client DNA), ADR 011 (Drive & Sheets Delivery), ADR 012 (Governed Learning)  

---

## 1. Context & Rationale

Prior architectural decisions admitted an embedded canvas within Hawa Desk (first HyCanvas in ADR 002, then an evaluated Polotno Konva engine in ADR 018, preceded by an exploratory Figma bridge in ADR 016). While embedded canvas engines offered local browser execution, operating a bespoke graphics editor inside Hawa Desk introduced significant structural liabilities:
1. **Ongoing Maintenance Overhead:** Maintaining multi-format geometry math, font rendering, Kurdish/Arabic RTL text shaping, complex layer hierarchies, and custom toolbar interactions required thousands of lines of fragile client-side canvas code.
2. **Feature Disparity:** Commercial design requirements (advanced templates, typography, rich image masking, brand kits, and export formatting) outpaced what an internal single-engineer codebase could sustainably provide.
3. **Operational Reality:** The production workflow demands native, effortless editing by human designers, backed by robust brand kit integration and reliable CMYK PDF Print outputs.

Canva provides an industry-leading, native design environment with mature typography, rich templates, collaborative editing, and professional print export facilities. Adopting native Canva as the primary design studio allows Hawa to shed the embedded canvas engine entirely and focus exclusively on its core strengths: **intelligent creative planning, strict brand DNA governance, multi-channel ingress, workflow orchestration, artifact preflight verification, and automated client delivery**.

---

## 2. Decision

1. **Retire Embedded Canvas Runtimes:** All internal canvas editors (Figma bridge, Polotno SDK, HyCanvas, and bespoke Konva components) are retired from Hawa Desk. Further development on embedded editor toolbars or decomposition is halted.
2. **Adopt Native Canva Studio Handoff:** Hawa Desk introduces a dedicated Canva Studio handoff. Tasks link directly to their corresponding native Canva design (`https://www.canva.com/design/:design_id/edit`). Human designers perform manual adjustments and visual creation natively in Canva.
3. **Establish Clear Three-Tier Boundary:**
   - **Hawa System of Record:** Retains intake messaging (Telegram, WhatsApp), client profiles and brand DNA, creative briefs, task lifecycle orchestration, immutable artifact snapshots, human approval records, and delivery audit trails.
   - **Canva Working Canvas:** Owns the active editable design, layout composition, vector layers, font styling, and native user interaction.
   - **Google Drive / Delivery Destination:** Owns final client publication packages and organized archive folders.
4. **Reconcile Source Ownership & Offline Portability:**
   - **Canva Cloud Design is Master for Layout:** The native Canva design ID is the working master for all visual editing.
   - **No Illusory Vector Portability:** Empirical testing demonstrated that Canva SVG exports convert text into outlined vector paths (0 live text nodes), and importing SVGs flattens artwork into single image bitmaps. Therefore, an exported SVG cannot be claimed as an editable offline master.
   - **True Disaster Recovery:** Disaster recovery and vendor independence are guaranteed by Hawa storing the complete structured creative brief, raw copy text, approved high-resolution brand assets (logos, images, color tokens), and layout recipes in PostgreSQL. If Canva ever becomes unavailable, designs can be reconstructed from Hawa's canonical data.
5. **Immutable Snapshot & Approval Gate:**
   - Hawa never binds approval to a transient Canva URL or volatile cloud design state.
   - For review and approval, exported artifact files (PNG / PDF Print) are ingested into Hawa.
   - Hawa computes SHA-256 digests, runs automated preflight checks, and secures explicit human sign-off on those exact bytes. Only verified, approved bytes are published to Google Drive.

---

## 3. Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                                 HAWA PLATFORM                                     |
|                                                                                   |
|  +---------------------+       +----------------------+       +----------------+  |
|  | Ingress (Telegram,  | ----> |  Durable Workflow    | ----> | Creative Brief |  |
|  | WhatsApp, Desk)     |       |  (Restate / Outbox)  |       | & Client DNA   |  |
|  +---------------------+       +----------------------+       +----------------+  |
|                                            |                                      |
|                                            v                                      |
|                             +-----------------------------+                       |
|                             |  Task & Canva Binding Repo  |                       |
|                             |  (PostgreSQL `hawa`)        |                       |
|                             +-----------------------------+                       |
|                                            |                                      |
|                  +-------------------------+-------------------------+            |
|                  |                                                   |            |
+------------------|---------------------------------------------------|------------+
                   |                                                   |
                   v (Deep-link Handoff)                               v (Ingest Exports)
+--------------------------------------+             +----------------------------------+
|            CANVA CLOUD               |             |          HAWA PREFLIGHT          |
|                                      |             |                                  |
|  - Native Web / Desktop Editor       |             |  - Compute SHA-256 Hash          |
|  - KAAE Brand Kit & Typography       |             |  - Verify CMYK / Dimensions      |
|  - Bounded MCP Assistant Edits       |             |  - Human Approval Lock           |
|  - Export: PDF Print (CMYK) & PNG    |             |                                  |
+--------------------------------------+             +----------------------------------+
                                                                       |
                                                                       v (Verified Delivery)
                                                     +----------------------------------+
                                                     |       GOOGLE DRIVE / SHEETS      |
                                                     |                                  |
                                                     |  - Deterministic Folder Upload   |
                                                     |  - Sheets Tracking Upsert        |
                                                     |  - Telegram Notification         |
                                                     +----------------------------------+
```

---

## 4. Consequences & Migration Impact

### Positive
- **Massive Complexity Reduction:** Eliminates thousands of lines of bespoke canvas engine, toolbar, and font-rendering code in `apps/desk`.
- **Superior Design Quality:** Unlocks Canva's full library, animations, modern templates, and native typography.
- **True Kurdish/Arabic Typography:** Natively supported in Canva with zero custom web font caching or WASM harfbuzz shims.
- **Print Reliability:** Direct Canva PDF Print export supports CMYK color profiles, bleeds, and crop marks verified by real print preflight.

### Negative / Constrained
- **Vendor Boundary:** Manual editing occurs on Canva's cloud infrastructure; offline local canvas editing is retired.
- **Export Discipline:** Ingestion of exports requires a supervised step or automated polling; Hawa must enforce that approvals bind to immutable local files rather than Canva URLs.

---

## 5. Requirement Disposition Summary

- **Preserved (95 requirements):** All messaging ingress, client memory, intelligent planning, governed learning, human reviews, approvals, Google Drive publishing, Sheets tracking, and audit logging remain strictly preserved.
- **Replaced (5 requirements):** Canvas editing (FR-030), manual editor UI (FR-076, FR-077), and local toolbar decomposition are replaced by native Canva editor handoff and the lean Work / Clients / Settings desk.
- **Reconciled / Constrained (5 requirements):**
  - `FR-028` (Editable source): Canva design ID is the working master; Hawa owns the structured assets and brief.
  - `FR-029` (Canonical document): Bound Canva document + Hawa brief form the canonical record.
  - `FR-075` (Studio fallback export): Lossless PNG and PDF Print captured by Hawa serve as release artifacts.
  - `NFR-010` (Portability): Portable reconstruction guaranteed via structured brief and raw vector assets, not lossy outlined SVGs.
  - `NFR-019` (Vendor independence): Strict domain decoupling ensures Canva can be replaced or augmented without breaking ingress, workflow, or delivery pipelines.
