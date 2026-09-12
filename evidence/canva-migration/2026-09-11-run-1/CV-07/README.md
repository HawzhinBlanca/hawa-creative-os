# CV-07: Telegram First-Class Adapter & Security Verification Report

## Executive Summary
Task **CV-07 ("Keep Telegram as a real first-class adapter")** establishes production-grade Telegram integration for the Hawa Creative OS.

Telegram is maintained as a real first-class bidirectional channel, supporting Bot API commands, webhook and durable polling receive modes with offset persistence, cryptographically bound callback action tokens, server-side Telegram Mini App identity verification, and deep linking to native Canva design editing and Hawa Desk Studio review.

---

## 1. Architectural Highlights

### A. Cryptographically Bound Action Tokens
- Interactive button callbacks are bound to `task_id`, `revision_id`, `action`, `actor_id`, `expires_at`, and a cryptographically random `nonce`.
- Tokens are packed into a compact format (`act:<tokenId>:<signature16>`) fitting within Telegram's strict 64-byte `callback_data` ceiling.
- **Single-Use Nonce & Replay Defense**: Consumed tokens are recorded; subsequent replay attempts are rejected with `403 Forbidden` (`REPLAY_DETECTED`).
- **Actor Authorization**: Only users matching the bound `actor_id` or present in `allowedUserIds` can approve tasks. Unknown users are rejected with `403 Forbidden` (`UNAUTHORIZED_ACTOR: Unknown users cannot approve`).
- **Stale Revision Defense**: If a design brief or task revision increments before an approval token is executed, the token is rejected with `409 Conflict` (`STALE_REVISION`).

### B. Telegram Mini App (Web App) Identity Verification (FR-071)
- Implements standard Telegram cryptographic validation:
  `HMAC-SHA256(data_check_string, HMAC-SHA256("WebAppData", botToken))`
- Verifies `initData` server-side, validates expiration timestamp, and maps verified Telegram users to authenticated operator sessions.
- Rejects tampered hashes, stale payloads (>24h), and unauthorized users.

### C. Polling Offset Persistence & Outage Recovery
- Supports explicit polling alternative with durable `TelegramOffsetStorage`.
- Outages (e.g. HTTP 502, network timeouts) increment error counters and set `degraded: true` with truthful error logs.
- Network failure is never replaced with fabricated Telegram success.
- Upon recovery, polling resumes exactly from `lastUpdateId + 1` without duplicating previous updates.

### D. Native Canva Linking
- Real authorized office events link to tasks in `tasks` and create native Canva bindings in `canva_bindings`.
- Telegram preview cards provide direct deep links:
  - `⚡ Open Desk Studio`: Points to canonical `/review?doc=...&taskId=...&mode=review`
  - `🎨 Edit in Canva`: Points directly to `https://www.canva.com/design/<canvaDesignId>/edit`

---

## 2. Evidence Files
- `AUTHORIZED_OFFICE_EVENT_TRACE.json`: End-to-end trace from Telegram authorized event through database to Canva binding.
- `CALLBACK_SECURITY_MATRIX.json`: Replay attack, expired token, foreign user, stale revision, and Mini App identity test evidence.
- `OUTAGE_RECOVERY_PROOF.json`: Offset persistence and truthful failure reporting verification.

---

## 3. Verification Commands
```bash
# Run CV-07 specific integration test suite
npx vitest run apps/core/test/telegram-first-class-adapter.test.ts

# Run entire monorepo test suite (87 test files, 565 tests passing)
npm test

# Verify pack integrity
python3 scripts/validate_pack.py
```
