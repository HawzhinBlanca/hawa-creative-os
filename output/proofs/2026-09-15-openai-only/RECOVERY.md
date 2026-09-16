# L06/L08 Recovery & Resilience Verification Record

- **Date**: 2026-09-15
- **System**: Hawa Creative OS (Branch `studio-v2`, Commit `15d6d18`)
- **Governing ADR**: [`adrs/030_openai_only_canva_telegram_system.md`](file:///Users/hawzhin/Hawdesign/adrs/030_openai_only_canva_telegram_system.md)
- **Specification**: [`output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md`](file:///Users/hawzhin/Hawdesign/output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md)

---

## 1. Interruption Boundary Matrix & Fault Drills

All 5 core interruption points were evaluated across unit and integration fault injection suites (`packages/testkit/test/faults.test.ts`, `apps/core/test/fault-recovery-security-cv20.test.ts`, and `apps/core/test/canva-connect-live-boundary.test.ts`):

| Boundary | Interruption Scenario | Expected State & Behavior | Verified Reconciliation Outcome | Status |
|---|---|---|---|---|
| **B1: Webhook Ingress** | Network drops or duplicate delivery of identical Telegram update (`sourceEventId`). | Idempotent persistence before processing. Duplicate returns 200 without creating extra tasks or model runs. | `FI-001` test verifies duplicate event produces exactly one logical event and task in PostgreSQL. | **VERIFIED** |
| **B2: Model Dispatch** | Upstream OpenAI returns 429 rate limit or network socket resets mid-stream. | Status marked `uncertain`. Circuit breaker records failure. Restate triggers bounded exponential backoff with idempotency key. | `FI-008` & `FI-021` verify 429 triggers retryable error; circuit breaker opens at 3 consecutive failures. | **VERIFIED** |
| **B3: Canva Import Submission** | Server crash after PPTX uploaded but before `designId` binding committed. | Transaction advisory lock released. Resume step queries existing import job by request key; binds design without re-import. | `canva-connect-live-boundary.test.ts` ("imports stored source exactly once under races and binds after service replacement"). | **VERIFIED** |
| **B4: Canva Export Polling** | Worker killed while Canva export is in `submitted` or `creating` state. | Export operation ID preserved in durable step journal. Resuming worker polls status and retrieves bytes without initiating duplicate export. | `canva-connect-live-boundary.test.ts` ("persists a submitted export, resumes after service replacement, stores real bytes"). | **VERIFIED** |
| **B5: Telegram Delivery** | Process crashes between sending message and writing outbox receipt. | Delivery idempotency key prevents duplicate broadcast. Message status reconciled from Telegram delivery ledger. | `telegram-delivery-receipt.test.ts` & `telegram-first-class-adapter.test.ts` verify replay protection and receipt matching. | **VERIFIED** |

---

## 2. Invariant Invalidation & Stale Approval Protection

Under Invariant #11 and Gate F (`apps/core/test/gate-f-review-invalidation.test.ts`):
1. **Post-Approval Invalidation**: If an authorized operator opens Canva and modifies a layer after approval was granted, the server detects the document revision increment (`version > approvedVersion`).
2. **Fail-Closed Gate**: The server strictly invalidates the existing approval token, flags `APPROVAL_STALE`, and blocks publication to Telegram or Google Drive until a fresh human review is conducted on the new export hash.
3. **No Silent Inheritance**: Later manual edits survive reopen/export, but never silently inherit an older approval.

---

## 3. Unresolved Uncertainty Policy

In compliance with Section 3 and Section 5 (L02/L08):
- An interrupted external call whose outcome cannot be cryptographically or deterministically resolved is stored as `status = 'uncertain'`.
- It is never fabricated into an optimistic `ok` or hardcoded `failed`.
- Operators inspect uncertain states through the Desk administration console (`/operations/runs?status=uncertain`) where manual resume or cancellation can be commanded.
