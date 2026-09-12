# ADR 021: Canva Production Cutover and Reversible Release Architecture

**Status:** Approved  
**Date:** 2026-09-12  
**Deciders:** Hawzhin, Antigravity Agent  
**Belongs to:** Canva Migration (CV-22)  
**Parent ADRs:** ADR 020 (Native Canva Studio Architecture), ADR 004 (Restate / Durable Workflow), ADR 008 (PostgreSQL Client DNA), ADR 011 (Drive & Sheets Delivery)  

---

## 1. Context & Motivation

Following successful completion of the native Canva integration (CV-03..CV-16), lean Hawa work desk (CV-17), governed learning (CV-18), historical design migration (CV-19), fault recovery and honest health (CV-20), and the 100-task office pilot qualification (CV-21), Hawa Creative OS is ready for production cutover.

To meet operational resilience standards (FR-060, FR-070, FR-074, FR-075, NFR-003, NFR-013, NFR-020), cutover cannot be an irreversible, destructive transition. The cutover must:
1. Formally switch all admitted task and client classes (KAAE, Drustee, Aster) to Canva as the sole active design studio via a single configuration parameter (`DESIGN_STUDIO_ADAPTER=canva`).
2. Establish a clear release version identity (`v2.0.0-canva-cutover`) with verified before-and-after database and artifact counts.
3. Guarantee a tested, rehearsed rollback mechanism back to the archived prior release (`v1.4.0-legacy-archive`) without losing any Canva working files or creating duplicate deliveries.
4. Strictly reject any silent back-translation of native Canva cloud designs into lossy legacy canvas formats.

---

## 2. Decision

1. **Provider Selection:**
   - Active studio provider is governed by `DESIGN_STUDIO_ADAPTER=canva` (default).
   - Implemented via `CanvaDesignStudioAdapter` (`packages/integrations/src/canva-design-studio-adapter.ts`), conforming fully to the `DesignStudioAdapter` contract (`packages/contracts/src/design-studio.ts`).
   - Admitted client scopes: `kaae` (institutional conference, formal bilingual announcements), `drustee` (telecom promotional campaigns), `aster` (retail commercial).

2. **Reversible Release Packaging:**
   - Release Version: `v2.0.0-canva-cutover`.
   - Prior Archived Release: `v1.4.0-legacy-archive`.
   - Git Tag / Tree: Clean commit tree preserving immutable migration ledgers and baseline archives.

3. **Data Integrity & Reconciliation:**
   - Database counts verified before and after cutover: PostgreSQL `hawa` strictly maintains exactly 1,449 tasks and 1,449 outbox commands, with 0 test pollution.
   - Historical designs migrated: 100% accounted for in `MIGRATION_LEDGER.csv` (10 admitted reconstructed, 1 named Figma blocker documented with no data loss).

4. **Rollback Guarantee:**
   - If an unexpected incident occurs, rollback switches studio routing to the archived manual/prior release handler.
   - **Zero Loss Principle:** Existing native Canva designs created during cutover remain intact in the Canva cloud store; they are never deleted, overwritten, or truncated.
   - **No Lossy Back-Translation:** The system will never attempt to parse native Canva multi-layer designs back into deprecated `.hyc` or Polotno JSON format, avoiding catastrophic typography or RTL bidi degradation.
   - **Zero Duplicate Deliveries:** Outbox reconciliation and idempotency keys guarantee that Google Drive and Google Sheets do not receive duplicate deliveries upon rollback.

5. **Operational Health Probes:**
   - Honest readiness probes dynamically check PostgreSQL, Canva Circuit Breaker, Telegram/WhatsApp channels, and disk write readiness (`/health`, `/health/ready`, `/system/studio-status`).

---

## 3. Architecture & Transition Flow

```
+------------------------------------------------------------------------------------+
|                         HAWA PRODUCTION CUTOVER (v2.0.0)                           |
|                                                                                    |
|   +--------------------------+           +-------------------------------------+   |
|   |   Unified Ingress        | --------> |    Core Application (apps/core)     |   |
|   |   (Telegram / WAHA /     |           |    DESIGN_STUDIO_ADAPTER=canva      |   |
|   |    Desk Work Queue)      |           +-------------------------------------+   |
|   +--------------------------+                              |                      |
|                                                             v                      |
|                                          +-------------------------------------+   |
|                                          |      CanvaDesignStudioAdapter       |   |
|                                          |    (Sole Active Production Studio)  |   |
|                                          +-------------------------------------+   |
|                                                             |                      |
|                              +------------------------------+                      |
|                              |                                                     |
|                              v                                                     |
|              +-------------------------------+                                     |
|              |      Canva Cloud Store        |                                     |
|              |  - Native Kurdish RTL text    |                                     |
|              |  - Vector shapes & brand kits |                                     |
|              |  - Direct designer handoff    |                                     |
|              +-------------------------------+                                     |
|                              |                                                     |
|                              v (Verified Capture)                                  |
|              +-------------------------------+                                     |
|              |      Hawa Preflight & Lock    |                                     |
|              |  - SHA-256 digest on exports  |                                     |
|              |  - Human approval gate        |                                     |
|              +-------------------------------+                                     |
|                              |                                                     |
|                              v (Durable Outbox Delivery)                           |
|              +-------------------------------+                                     |
|              |    Google Drive / Sheets      |                                     |
|              +-------------------------------+                                     |
+------------------------------------------------------------------------------------+
```

---

## 4. Consequences

- **Positive:**
  - Canva is now the single, uniform, production-grade design studio across all admitted clients.
  - No dual-editor ambiguity for operators.
  - Complete rollback safety verified by automated rehearsal.
  - Full adherence to zero test pollution and immutable data contracts.
- **Negative / Operational Bounds:**
  - Inaccessible historical Figma links remain designated blockers until credentials or exports are provided by external owners.
  - Live editing requires active Canva cloud connectivity; during Canva outages, intake continues normally while capture/export awaits circuit recovery.
