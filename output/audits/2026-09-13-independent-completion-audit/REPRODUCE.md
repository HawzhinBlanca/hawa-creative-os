# Independent Reproduction Guide: Hawa Repairs & Verification (2026-09-13)

This document provides exact, deterministic reproduction instructions for the independent completion audit of Hawa across tasks H01–H14.

---

## 1. Environment & Container Stack Prerequisites

Ensure Docker and Node.js 20+ / pnpm are installed on the target machine.

```bash
cd /Users/hawzhin/Hawdesign

# 1. Start the complete isolated production-shaped Docker stack
docker compose -f infra/docker/docker-compose.prod.yml up -d --build

# 2. Verify all 6 containers report healthy
docker compose -f infra/docker/docker-compose.prod.yml ps
```

Target endpoints:
- Reverse Proxy: `http://127.0.0.1:8080`
- PostgreSQL: `127.0.0.1:54332` (database `postgres`, user `hawa_owner`)
- Core Service: `http://127.0.0.1:8080/v1`
- Desk Web UI: `http://127.0.0.1:8080`

---

## 2. Running the Full Automated Audit Suite

Execute the independent audit probe script to verify all H01–H14 assertions against live services:

```bash
npx tsx scripts/run_independent_completion_audit.ts
```

Expected output:
```text
=== STARTING RIGOROUS INDEPENDENT COMPLETION AUDIT (2026-09-13) ===

=== AUDIT RESULTS SUMMARY ===
PASS:    13 / 14
FAIL:    0 / 14
BLOCKED: 1 / 14 (H06 blocked on upstream OpenAI gpt-6-astra entitlement)
NOT_RUN: 0 / 14

[PASS] H01: Canonical Authenticated Task Loading (4/4 assertions passed)
[PASS] H02: Truthful UI Receipts (2/2 assertions passed)
[PASS] H03: Strict Approval & Durable State Authority (5/5 assertions passed)
[PASS] H04: One Authentic Canva Adapter (3/3 assertions passed)
[PASS] H05: Scoped Durable Idempotency (2/2 assertions passed)
[BLOCKED] H06: Model Schema & Provenance (2/3 assertions passed)
[PASS] H07: Budget & Vision Enforcement (3/3 assertions passed)
[PASS] H08: Exact Brief & Copy Preservation (3/3 assertions passed)
[PASS] H09: Immutable Artifact Validation (3/3 assertions passed)
[PASS] H10: Correct Assets for Every Client (2/2 assertions passed)
[PASS] H11: Governed Learning with Scope, Authority & Rollback (3/3 assertions passed)
[PASS] H12: Live Vertical Slice & Truthful Health (2/2 assertions passed)
[PASS] H13: Lean Canva-Only Review UI (1/1 assertions passed)
[PASS] H14: Independent Qualification (3/3 assertions passed)
```

Raw evidence is automatically written to:
`output/audits/2026-09-13-independent-completion-audit/RAW_PROBES_EVIDENCE.json`

---

## 3. Running the Live Vertical Slice & Correlation Chain

Execute the complete end-to-end workflow probe connecting the intake brief, Canva document creation, manual editing, export capture, Claude Opus 5 visual critique, human approval, delivery receipt, and edit invalidation:

```bash
npx tsx scripts/execute_independent_live_vertical_slice.ts
```

Output artifacts generated:
- `output/audits/2026-09-13-independent-completion-audit/LIVE_VERTICAL_SLICE_RECEIPTS.json`
- `output/audits/2026-09-13-independent-completion-audit/artifacts/task_slice_*_export.png`
- `output/audits/2026-09-13-independent-completion-audit/artifacts/task_slice_*_export.pdf`

---

## 4. Specific Task Reproduction Commands

### H01: Canonical Authenticated Task Loading
```bash
# 1. Unauthenticated request must return HTTP 401 with JSON problem details
curl -i -s http://127.0.0.1:8080/v1/tasks
# Expected: HTTP/1.1 401 Unauthorized, Content-Type: application/json

# 2. Authenticated request loads persisted tasks without HTML SPA shell fallback
curl -s -H "Authorization: Bearer dev-session-hawzhin-prod-audit" \
  "http://127.0.0.1:8080/v1/tasks?limit=5" | jq .
# Expected: { "items": [ ... ], "total": 1449 }
```

### H03: Strict Approval & Durable State Authority
```bash
# Test 1: Role spoofing (operator cannot approve an art_director required gate)
curl -s -X POST http://127.0.0.1:8080/v1/tasks/<taskId>/revisions/<revId>/decisions \
  -H "Authorization: Bearer dev-session-hawzhin-prod-audit" \
  -H "Content-Type: application/json" \
  -d '{"action":"APPROVED","actorRole":"operator","comment":"illegal approval"}' | jq .
# Expected: HTTP 403 Forbidden ("Only reviewers or art directors can approve revisions")

# Test 2: Incomplete QA approval rejection
curl -s -X POST http://127.0.0.1:8080/v1/tasks/<taskId>/revisions/<revId>/decisions \
  -H "Authorization: Bearer dev-session-hawzhin-prod-audit" \
  -H "Content-Type: application/json" \
  -d '{"action":"APPROVED","actorRole":"art_director","comment":"approve unverified"}' | jq .
# Expected: HTTP 412 Precondition Failed ("Cannot approve revision: Automated QA and visual checks must pass first")
```

### H05: Scoped Durable Idempotency
```bash
# Ingest task with Idempotency-Key
KEY="idemp_audit_test_$(date +%s)"
curl -s -X POST http://127.0.0.1:8080/v1/tasks \
  -H "Authorization: Bearer dev-session-hawzhin-prod-audit" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Audit Task","clientId":"c1000000-0000-4000-8000-000000000002","brief":"Initial brief"}'

# Replay with identical key but different payload
curl -i -s -X POST http://127.0.0.1:8080/v1/tasks \
  -H "Authorization: Bearer dev-session-hawzhin-prod-audit" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Tampered Task","clientId":"c1000000-0000-4000-8000-000000000002","brief":"Tampered brief"}'
# Expected: HTTP/1.1 409 Conflict ("Idempotency key reused with different payload parameters")
```

### H06: Upstream Model Entitlement Probe
```bash
# Probe OpenAI directly for gpt-6-astra
curl -i -s -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"ping"}]}'
# Expected: HTTP/1.1 403 Forbidden with code "model_not_found"

# Probe Anthropic directly for claude-opus-5
curl -s -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-5","max_tokens":10,"messages":[{"role":"user","content":"ping"}]}' | jq .model
# Expected: "claude-opus-5"
```

---

## 5. Running Monorepo Tests & Database Disaster Recovery Drill

```bash
# Run full Vitest monorepo suite (100 test files, 661 tests)
pnpm test

# Run database disaster recovery drill specifically
pnpm --filter @hawa/db test test/live-recovery-drill.test.ts
```
