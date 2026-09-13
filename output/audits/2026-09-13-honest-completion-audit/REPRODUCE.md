# Reproduction Guide: Honest Independent Audit & Evidence Verification

This document provides exact, runnable commands to reproduce all verified engineering fixes, live vertical slice executions, and unvarnished external blockers documented in [`FINAL_VERIFICATION_REPORT.md`](file:///Users/hawzhin/Hawdesign/output/audits/2026-09-13-honest-completion-audit/FINAL_VERIFICATION_REPORT.md).

---

## 1. Automated Audit Runners

### Full Independent Audit Runner (H01–H14)
Executes all 14 task probes against the live Docker stack, monorepo test runner, database, and external APIs:
```bash
npx tsx scripts/run_independent_completion_audit.ts
```
- **Output:** Saves full structured probe results to `output/audits/2026-09-13-honest-completion-audit/RAW_PROBES_EVIDENCE.json`.
- **Expected Summary:** `8 PASS, 2 PARTIAL, 2 BLOCKED, 2 FAIL`, `FINAL VERDICT: NOT READY FOR ACCEPTANCE GATES`.

### Live Vertical Slice Execution (H12)
Executes the honest vertical slice against `http://127.0.0.1:8080`:
```bash
npx tsx scripts/execute_independent_live_vertical_slice.ts
```
- **Output:** Emits PDF and PNG exports to `output/audits/2026-09-13-honest-completion-audit/artifacts/`, records live server receipts to `output/audits/2026-09-13-honest-completion-audit/LIVE_VERTICAL_SLICE_RECEIPTS.json`, and cleans up probe tasks in Postgres.

---

## 2. Verifying Remediated Artifacts

### Authentic PDF 1.7 Validation (H09)
Run strict `pypdf` parser over the generated PDF export:
```bash
python3 -c "
import pypdf
reader = pypdf.PdfReader('output/audits/2026-09-13-honest-completion-audit/artifacts/task_slice_1789284247477_export.pdf')
print('Strict PDF Validation Results:')
print('  Pages:', len(reader.pages))
print('  MediaBox:', reader.pages[0].mediabox)
print('  PDF Version:', reader.pdf_header)
print('  OutputIntents:', reader.trailer.get('/Root', {}).get('/OutputIntents'))
"
```
- **Expected Output:**
  - Pages: 1
  - MediaBox: `RectangleObject([0, 0, 810, 1012.5])`
  - PDF Version: `%PDF-1.7` (or `%PDF-1.4`)
  - Zero xref errors or warnings.

### Dynamic Measured RPO Disaster Recovery Drill (H11)
Run the live recovery drill measuring dynamic backup duration:
```bash
pnpm --filter @hawa/db test test/live-recovery-drill.test.ts
```
- **Expected Output:** Passes in ~2.7s; logs measured RPO in minutes (`measuredRpoMinutes <= 15.0`), replacing previous hardcoded `0.25`.

### Live Claude Opus 5 Inference with Thinking Budget (H12 / H14)
Probe Anthropic Claude Opus 5 API with `max_tokens=4000`:
```bash
curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "messages": [{"role": "user", "content": "Return valid JSON visual critique with overallScore"}],
    "max_tokens": 4000
  }' | jq '{ model: .model, usage: .usage, content_preview: .content[0].text[:200] }'
```
- **Expected Output:** Returns HTTP 200 with `output_tokens > 0` and non-empty critique text, verifying thinking tokens no longer starve the output.

---

## 3. Verifying Live Core & Security Probes

### H01: Authenticated Task Loading
```bash
# 1. Unauthenticated request returns HTTP 401 with JSON problem details
curl -i -s http://127.0.0.1:8080/v1/tasks
# Expected: HTTP/1.1 401 Unauthorized, Content-Type: application/json, {"title":"Unauthorized"}

# 2. Authenticated request loads persisted tasks
curl -s -H "Authorization: Bearer hawa_prod_operator_bearer_token_entropy_7721" \
  "http://127.0.0.1:8080/v1/tasks?limit=5" | jq '{ total: .total, sample_title: .items[0].title }'
# Expected: HTTP 200 with real database tasks (total > 1400)
```

### H03: Strict Approval Authority & Preconditions
```bash
# 1. Operator role spoofing rejected
curl -s -X POST http://127.0.0.1:8080/v1/tasks/00000000-0000-4000-8000-000000000001/revisions/00000000-0000-4000-8000-000000000002/decisions \
  -H "Authorization: Bearer hawa_prod_operator_bearer_token_entropy_7721" \
  -H "Content-Type: application/json" \
  -d '{"action":"APPROVED","actorRole":"operator","comment":"spoofed approval"}' | jq .
# Expected: HTTP 403 Forbidden ("Only reviewers or art directors can approve revisions")

# 2. Invalid action rejected
curl -s -X POST http://127.0.0.1:8080/v1/tasks/00000000-0000-4000-8000-000000000001/revisions/00000000-0000-4000-8000-000000000002/decisions \
  -H "Authorization: Bearer hawa_prod_reviewer_art_director_key_entropy_8814" \
  -H "Content-Type: application/json" \
  -d '{"action":"MAYBE_APPROVE","actorRole":"art_director"}' | jq .
# Expected: HTTP 400 Bad Request ("INVALID_ACTION")
```

### H05: Scoped Idempotency Conflict Detection
```bash
KEY="idemp_probe_$(date +%s)"

# First request
curl -s -X POST http://127.0.0.1:8080/v1/tasks \
  -H "Authorization: Bearer hawa_prod_operator_bearer_token_entropy_7721" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Original Task","clientId":"c1000000-0000-4000-8000-000000000002","brief":"Initial brief"}'

# Replay with altered payload
curl -i -s -X POST http://127.0.0.1:8080/v1/tasks \
  -H "Authorization: Bearer hawa_prod_operator_bearer_token_entropy_7721" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Tampered Task","clientId":"c1000000-0000-4000-8000-000000000002","brief":"Tampered brief"}'
# Expected: HTTP/1.1 409 Conflict ("IDEMPOTENCY_PAYLOAD_MISMATCH")
```

---

## 4. Reproducing Unvarnished External Blockers

### H04: Canva Connect Missing Credentials (BLOCKED)
```bash
node -e "
import('./packages/integrations/dist/canva-connect-client.js').then(({ CanvaConnectClient }) => {
  const client = new CanvaConnectClient();
  client.createDesign({ title: 'Test' }).catch(err => console.log('Expected failure:', err.message));
});
"
# Expected Output: Throws fail-closed: "Canva Connect API credentials are not configured in environment"
# Blocker: CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are missing in production environment.
```

### H06: OpenAI gpt-6-astra Entitlement (BLOCKED)
```bash
curl -i -s -X POST https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"ping"}]}'
# Expected Output: HTTP 403 Forbidden ("Project does not have access to model gpt-6-astra")
```

### H12: Google Drive Service Account Credentials Missing (FAIL)
```bash
curl -i -s -X POST http://127.0.0.1:8080/v1/tasks/00000000-0000-4000-8000-000000000001/publish \
  -H "Authorization: Bearer hawa_prod_reviewer_art_director_key_entropy_8814" \
  -H "Content-Type: application/json" \
  -d '{"destination":"google_drive"}'
# Expected Output: HTTP 422 Unprocessable Entity ("CREDENTIALS_MISSING")
# Blocker: GOOGLE_SERVICE_ACCOUNT_KEY lacks private key for production Drive publishing.
```
