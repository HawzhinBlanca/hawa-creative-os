# Architecture Route Decision: Canva Integration & Model Gateway

**Task:** CV-03  
**Status:** QUALIFIED & VERIFIED  
**Evidence Directory:** `evidence/canva-migration/2026-09-11-run-1/CV-03/`  

---

## 1. Executive Summary & Route Selection

Following empirical testing of environment credentials, model provider endpoints, Canva runtime capabilities, and export format fidelity, the primary architectural transport route for Hawa is established:

1. **Design Studio Transport: Native Canva Editor Handoff (Status: `tested` / `manual`)**
   - Hawa provides deep-link workspace handoff (`https://www.canva.com/design/:design_id/edit`).
   - The human designer operates directly within Canva's native interface, utilizing full Canva Pro features, KAAE brand kit typography, and layout tools.
   - Hawa does not attempt to embed an unapproved iframe canvas or maintain internal canvas state machines.

2. **Automation Assistant Transport: Canva MCP (Status: `tested_bounded`)**
   - Used for bounded transactional edits: replacing known text containers, adjusting element bounds, swapping brand assets.
   - Unlocking full novel layout generation via MCP is marked `unsupported` because Canva MCP does not allow adding new text boxes or changing typefaces.

3. **Backend Service API: Canva Connect REST API (Status: `blocked`)**
   - Private production integrations require Canva Enterprise contracts and review.
   - Credentials (`CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`) are not present in the runtime environment.
   - Hawa backend will NOT rely on Connect API until/unless enterprise credentials are authenticated.

4. **Export & Capture Transport: Supervised Export & Ingest (Status: `tested`)**
   - Print exports (PDF Print with CMYK, bleed, and crop marks) are produced via Canva native download UI.
   - Digital exports (lossless PNG) are downloaded and ingested into Hawa's task artifact store.
   - Hawa validates format integrity, calculates SHA-256 digests, runs preflight analysis, and manages client approval and Google Drive delivery.

5. **Model Gateway Status (Status: `operational_gpt4o_claude5_only`)**
   - Anthropic: `claude-sonnet-5` (tested, 200, 1.2s latency), `claude-opus-5` (tested, 200).
   - OpenAI: `gpt-4o` (tested, 200), `gpt-4o-mini` (tested, 200, 3.1s latency).
   - All other requested speculative models (`gpt-6-astra`, `gpt-image-2.5-sunburst`, `claude-3-5-sonnet-20241022`) returned HTTP 404 and are classified as `unsupported` / unavailable.

---

## 2. Route Disposition Matrix

| Capability | Chosen Route | Status | Rationale & Evidence |
|---|---|---|---|
| **Novel Design Creation** | Native Canva Web Editor | `manual` | Empirically verified; full tool palette available to designer |
| **Template Duplication** | Canva Web / MCP Clone | `tested` | Cloned design `DAHU6ovIEc4` from `DAHR4TSWs60` |
| **SVG Master Upload** | Direct File Import | `unsupported` | Uploading SVG flattens into single image element; 0 live text nodes |
| **Manual Editing** | Native Canva Web Editor | `tested` | High usability; native Arabic/Kurdish font support |
| **Programmatic Copy Edit** | Canva MCP (bounded) | `tested` | Transaction `1349343667361672919` successfully committed text change |
| **Element Geometry Read** | Canva MCP Start Tx | `tested` | Successfully returned 5 element bounding boxes & IDs |
| **Print Export (CMYK)** | Native Canva Download | `tested` | Feasibility study confirmed CMYK + bleed PDF export |
| **Automated Print Export**| Connect API / MCP | `unsupported` | Neither API exposes CMYK or bleed controls |
| **Digital PNG Export** | Native Canva / Download | `tested` | High-resolution PNG verified with SHA-256 |
| **Source Backup** | Hawa Structured Brief + Assets | `manual` | Canva cloud is master; SVG is outlined vector, not editable source |

---

## 3. Acceptance Verification

- **Explicit Routes:** Every lifecycle phase (Creation, Edit, Observation, Export) has an explicit, tested route documented in `CAPABILITIES.json`.
- **No False Entitlements:** Codex AI host connectors are explicitly distinguished from Hawa backend services.
- **Model Truth:** Only models with verified 200 OK inference (`gpt-4o`, `gpt-4o-mini`, `claude-sonnet-5`, `claude-opus-5`) are enabled in Hawa's configuration. Unavailable models remain disabled.
