# Task CV-08: Preserve WhatsApp with Honest Boundaries

**Task ID:** CV-08  
**Depends On:** CV-06  
**Requirements:** FR-003, FR-004, FR-005, FR-051, FR-071, FR-072  
**Status:** VERIFIED (100% Complete)  
**Date:** 2026-09-11  

---

## 1. Summary of Changes

In task **CV-08**, the WAHA (WhatsApp HTTP API) bridge was audited, hardened, and bounded to authentic operational parameters for the Erbil office collaboration group requirement:

1. **Replaced Fabricated Hashes with Cryptographic SHA-256 Hashes:**
   - Eliminated the length-based hash defect (`waha_hash_${text.length}`).
   - Implemented `computeWahaPayloadHash(rawBody)` producing verifiable 64-character SHA-256 hex digests matching `crypto.createHash('sha256')`.
2. **Dedicated Account & Group Allowlisting:**
   - Isolated the integration to a dedicated office account (`office_waha_session_1`). Strictly prohibited personal account automation.
   - Enforced group allowlists (`allowedGroupJids`: e.g., `120363024847291039@g.us`).
   - Unauthorized group messages are rejected with HTTP 403 `WAHA_FORBIDDEN_GROUP` ("WhatsApp group is not in the office allowlist").
3. **Session Health & QR Disconnect Resilience:**
   - Implemented real session health inspection via `WahaAdapter.health()` and `/api/waha/health`.
   - Distinctly identifies states: `WORKING` (healthy), `SCAN_QR_CODE` (reauth required), `STOPPED` (unavailable), and `OFFLINE` (unavailable).
   - During `SCAN_QR_CODE` or network outage, all in-flight tasks and outbox commands are preserved in the PostgreSQL database; delivery is **never fabricated**; safe fallback instructions point operators to Hawa Desk (`/desk`) and Telegram.
4. **Emergency Office Kill Switch:**
   - Added `WAHA_KILL_SWITCH` environment flag and authenticated `POST /api/waha/kill-switch` endpoint.
   - When active, inbound traffic returns 503 with Desk fallback; outbound dispatches halt immediately with `WAHA_KILL_SWITCH_ACTIVE`, retaining outbox commands for later replay.
5. **Honest Outbound & Reconciliation:**
   - `WahaAdapter.notify()` only reports `delivered: true` upon receiving a real external message ID from WAHA HTTP response.
   - `WahaAdapter.reconcile()` detects outages and reports gaps honestly without inventing receipts.
6. **Meta Official Cloud API vs WAHA Evaluation:**
   - Completed `OFFICIAL_WABA_VS_WAHA_EVALUATION.md` (ADR-021), proving why WAHA is required for internal office design groups (which Meta WABA does not support) while enforcing strict hardware isolation.

---

## 2. Test Verification

The test suite `apps/core/test/waha-honest-adapter.test.ts` passes 7/7 tests:
1. `Real office group test event -> database -> Canva-linked task`: PASS
2. `Replaces length-based hash with true cryptographic SHA-256 payload hashing`: PASS
3. `Group allowlist enforcement: admits allowlisted office group, rejects unauthorized group`: PASS
4. `WAHA session health probe: WORKING, SCAN_QR_CODE, STOPPED, OFFLINE`: PASS
5. `QR disconnect drill: preserves tasks, alerts with fallback instructions, does not fabricate delivery`: PASS
6. `Office kill switch drill: halts outbound immediately, preserves tasks in outbox, returns 503 on inbound`: PASS
7. `Honest outbound reconciliation: detects session gaps, reports outage without invented receipts`: PASS

Zero test pollution verified on production database `hawa` (1,449 tasks, 1,449 outbox commands maintained).

---

## 3. Evidence Artifacts

- [`OFFICIAL_WABA_VS_WAHA_EVALUATION.md`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-08/OFFICIAL_WABA_VS_WAHA_EVALUATION.md)
- [`OFFICE_GROUP_EVENT_TRACE.json`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-08/OFFICE_GROUP_EVENT_TRACE.json)
- [`SESSION_HEALTH_AND_QR_DRILL.json`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-08/SESSION_HEALTH_AND_QR_DRILL.json)
- [`RECONCILIATION_AND_RECEIPTS.json`](file:///Users/hawzhin/Hawdesign/evidence/canva-migration/2026-09-11-run-1/CV-08/RECONCILIATION_AND_RECEIPTS.json)
