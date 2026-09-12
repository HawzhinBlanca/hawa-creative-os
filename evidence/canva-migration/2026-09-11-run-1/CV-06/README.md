# CV-06: Unified Ingress Verification & Evidence Report

## Executive Summary
Task **CV-06 ("Unify Desk, Telegram and WhatsApp ingress")** establishes a unified ingress architecture across all customer-facing and office channels (Hawa Desk, Telegram Bot API, WAHA WhatsApp adapter).

All channels now route into a unified `UnifiedIngressService` backed by durable PostgreSQL storage (`inbox_events`, `message_events`, `message_attachments`, `channel_routes`, `integrations`), with strict SSRF defenses, Kurdish Sorani orthography normalization, attachment bounds/SHA-256 deduplication, and conversational gating.

---

## 1. Core Architectural Pillars

### A. Strict Ingress Deduplication & Durable Ingress Journal
- Every ingress payload is committed to `inbox_events` and `message_events` within the tenant RLS boundary before any task or outbox action is evaluated.
- Duplicate events with the same `(tenant_id, channel, source_event_id)` or `(tenant_id, channel, source_message_id, source_revision_id)` return acknowledged receipts without creating duplicate tasks or outbox commands.

### B. Conversational Gating (FR-001, FR-002)
- Ordinary chat messages in group channels remain classified as `MESSAGE_ONLY`.
- No design generation or task pipeline is started unless:
  1. An explicit bot command (`/task`, `/brief`, `#task`, `#brief`) is detected.
  2. A direct desk form submission is submitted.
- Ambiguous intent is flagged as `AMBIGUOUS_NEEDS_CLARIFICATION`, prompting clarification instead of hallucinating design parameters.

### C. Revision Safety (FR-010, FR-068)
- If a source message is edited *before* task generation, the working draft text is updated.
- If a source message is edited *after* a design brief has been approved, the system flags the task for revision (`revision_requested`) in `task_events` with an immutable reason audit, strictly preserving the approved brief without silent alteration.

### D. Bounded Attachments & SSRF Defense (NFR-006, NFR-007)
- Attachments are bounded to 50MB.
- File extensions and MIME types are strictly allowlisted; dangerous executable formats (`.exe`, `.bat`, `.sh`, `.php`, `.js`, `.py`) are rejected.
- Fetch destinations (`validateFetchDestination`) block loopback (`127.0.0.1`, `::1`, `localhost`), RFC1918 private IPv4 subnets, link-local addresses, and cloud provider metadata IPs (`169.254.169.254`).
- SHA-256 deduplication prevents storing duplicate binary objects across disparate messages.

---

## 2. Evidence Files
- `INGRESS_INTEGRATION_TESTS.json`: Vitest execution report of 22 tests (16 unit tests in `packages/integrations` + 6 PostgreSQL integration tests in `apps/core`).
- `MALFORMED_REPLAY_FIXTURES.json`: Replay attack, out-of-order revision, and SSRF malformed fixture validations.
- `ATTACHMENT_DEDUP_PROOF.json`: Deduplication and SHA-256 tamper-detection evidence.

---

## 3. Verification Commands
```bash
# Run unit tests
npx vitest run packages/integrations/test/unified-ingress.test.ts

# Run PostgreSQL integration tests
npx vitest run apps/core/test/unified-ingress-postgres.test.ts

# Run entire monorepo suite (86 test files, 557 tests passing)
npm test

# Verify pack integrity
python3 scripts/validate_pack.py
```
