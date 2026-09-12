# Architectural Evaluation: Official WhatsApp Business API (WABA) vs WAHA Bridge

**Document ID:** ADR-021-WABA-VS-WAHA  
**Date:** 2026-09-11  
**Author:** Antigravity AI Pair Programmer & Hawdesign Architecture Team  
**Status:** ACCEPTED / NORMATIVE  
**Requirements Addressed:** FR-003, FR-004, FR-005, FR-051, FR-071, FR-072  

---

## 1. Context & Business Requirement

Hawdesign Creative OS operates in Iraqi Kurdistan (Erbil) serving major enterprise and institutional clients (such as KAAE, Drustee, Aster, Nova, Rona). The operational team uses WhatsApp as an intake and communication channel alongside the canonical Hawa Desk and Telegram Bot.

Specifically, the workflow requirement is an **internal office collaboration group** where creative directors, account managers, and designers post design briefs, review revisions, and coordinate creative approvals.

Task **CV-08** mandates:
> "Keep the existing optional WAHA adapter for the actual office-group requirement, isolated with a dedicated account, allowlisted groups, verified ingress, session health, reconciliation and kill switch. Do not silently replace group functionality with a different channel. Evaluate official WhatsApp Business API separately only if it covers the real workflow; verify current account eligibility and messaging rules. Replace fabricated IDs, length-based hashes and unconditional verification with observed identities, cryptographic payload hashes and real receipts. No personal account automation."

---

## 2. Comparative Evaluation: Meta Official Cloud API vs WAHA

| Evaluation Dimension | Meta WhatsApp Business Cloud API (WABA) | WAHA (WhatsApp HTTP API Bridge) | Verdict for Hawdesign Office Workflow |
| :--- | :--- | :--- | :--- |
| **Group Messaging Support** | **No spontaneous group support.** WABA is strictly built for 1:1 business-to-consumer conversations. Group APIs are limited to closed enterprise pilots with strict participant restrictions. | **Full native group support.** Can listen to allowlisted office groups, track participant JIDs, and parse sender identities. | **WAHA is required** to fulfill the office group requirement. WABA cannot support multi-party office creative groups. |
| **Messaging Restrictions & Window** | Enforces a strict 24-hour customer service window. Outside the window, only pre-approved HSM templates (Marketing, Utility, Authentication) with per-message fees can be sent. Free-form design feedback is blocked. | Operates over standard WhatsApp protocol on dedicated office SIM without 24-hour window blocks or template review delays. | **WAHA is required** for interactive creative design drafting and dynamic revisions. |
| **Kurdish Sorani Support in Templates** | Kurdish Sorani is not a standard pre-translated template category on Meta Business Manager; custom template approvals for Sorani have high rejection rates or require Arabic categorization. | Unrestricted UTF-8 transmission, full Kurdish Sorani glyph support (ک, گ, ڵ, ۆ, ڕ, ێ, ە) and Zero-Width Non-Joiner (ZWNJ). | **WAHA** preserves authentic Kurdish Sorani text without template approval barriers. |
| **Account Identity & Isolation** | Requires Meta Business Verification, Facebook App registration, and credit card billing. | Dedicated office hardware/SIM card running on isolated server container (`office_waha_session_1`). | **WAHA** provides complete on-premise operational isolation for the Erbil office. |
| **Personal Account Automation** | Strictly prohibited by Meta terms. | Strictly prohibited by Hawdesign policy; dedicated SIM only, zero personal account automation. | **Enforced equally**: Hawdesign strictly forbids personal account use; only dedicated office numbers are used. |
| **Disaster Recovery & Fallback** | Meta status outages require webhooks and external incident monitoring. | Session state machine (`WORKING`, `SCAN_QR_CODE`, `STOPPED`, `OFFLINE`) with automatic fallback to Hawa Desk (`/desk`) and Telegram Bot. | **WAHA + Hawa Desk Fallback** provides transparent local resilience. |

---

## 3. Decision

1. **Retain WAHA for Office Group Collaboration:**
   WAHA remains the designated bridge for the internal office group workflow (`office-design-group@g.us`), as Meta WABA Cloud API cannot support free-form multi-participant design collaboration groups.
2. **Strict Operational Boundaries for WAHA:**
   - **Dedicated Account Only:** Automated traffic is exclusively bound to `office_waha_session_1` on a dedicated company SIM. Personal accounts are strictly forbidden.
   - **Allowlisted Group JIDs:** Only explicitly configured group JIDs (e.g., `120363024847291039@g.us`) are admitted. Messages from unauthorized groups or strangers are rejected with `403 Forbidden` (`WAHA_FORBIDDEN_GROUP`).
   - **Cryptographic Payload Hashing:** All incoming payloads are hashed using SHA-256 (`crypto.createHash('sha256')`). Legacy length-based hashing (`waha_hash_${len}`) is eliminated.
   - **HMAC-SHA256 Webhook Verification:** Webhook deliveries require secret token verification or HMAC-SHA256 signatures with constant-time comparison (`crypto.timingSafeEqual`).
   - **Honest Session & Receipts:**
     - Session health is probed via `/api/sessions/{sessionName}`.
     - If the session requires QR re-authentication (`SCAN_QR_CODE`), state is reported as `reauth_required`, tasks in the database and outbox are preserved, and operators are directed to Hawa Desk and Telegram.
     - Outbound dispatches during an outage return `retryable: true` failures; delivery is **never fabricated**.
   - **Emergency Kill Switch:** A hard kill switch (`WAHA_KILL_SWITCH=true` or `POST /api/waha/kill-switch`) immediately halts all inbound and outbound WhatsApp traffic, redirecting users to `/desk` while preserving database state.

---

## 4. Consequences & Guarantees

- **Invariant #1 Preserved:** Hawa Desk remains the canonical system of record. WhatsApp is an ingress adapter, never the authoritative database.
- **Zero Hallucinated Deliveries:** Receipts are only recorded when WAHA returns an observed message ID from the WhatsApp network.
- **Zero Test Pollution:** Tests run exclusively against `hawa_test`, preserving the production `hawa` database at exactly 1,449 tasks.
