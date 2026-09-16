# Release & Live Canary Verification Record

- **Date**: 2026-09-15
- **Branch**: `studio-v2`
- **Build Identity**: `15d6d18`
- **Governing ADR**: [`adrs/030_openai_only_canva_telegram_system.md`](file:///Users/hawzhin/Hawdesign/adrs/030_openai_only_canva_telegram_system.md)
- **Specification**: [`output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md`](file:///Users/hawzhin/Hawdesign/output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md)

---

## 1. Deployed Container Images & Exact Digests

| Service | Container Name | Image Digest | Runtime Port | Health Status |
|---|---|---|---|---|
| **Core API** | `hawa-production-core-1` | `sha256:cb7f3d70eadd6057f04324718fa1bf9a866d7744a1968ec422d7bff2a693a123` | `3001` (internal) | **Healthy** (`/v1/health` HTTP 200) |
| **Durable Worker** | `hawa-production-worker-1` | `sha256:a9af78910c916c1a68736aa80e4d0c20a09abdf274bd7d1330d21fc4ab4709e2` | `9080` (internal) | **Healthy** (`/health` HTTP 200) |
| **Desk UI** | `hawa-production-desk-1` | `sha256:7c98d96943ef4102657cf11d5a7a9798ef26c86aaa79f95081f1c5b93ca27f56` | `80` (internal) | **Healthy** (`/` HTTP 200) |
| **Reverse Proxy** | `hawa-production-nginx-1` | `sha256:d82c0b53...` (1.27-alpine-slim) | `127.0.0.1:8080` | **Healthy** |
| **Orchestration** | `hawa-production-restate-1` | `sha256:e14b...` (restate:1.7.0) | `8080` (internal) | **Healthy** |
| **Database** | `hawa-production-postgres-1` | `sha256:a938...` (pgvector:pg17) | `127.0.0.1:54332` | **Healthy** |

---

## 2. Live Health Endpoint Response

Querying `http://127.0.0.1:8080/v1/health` at `2026-09-15T12:12:02Z`:
```json
{
  "status": "healthy",
  "timestamp": "2026-09-15T12:12:02.036Z",
  "lastVerifiedProgressAt": "2026-09-14T21:38:08.478Z",
  "dependencies": {
    "postgres": "connected",
    "canva": "connected",
    "canvaCircuitBreaker": "CLOSED",
    "telegram": "active",
    "waha": "unconfigured",
    "disk": "writable",
    "restate": "connected",
    "modelProvider": "connected",
    "telegramApi": "connected"
  }
}
```

---

## 3. Database Migration Integrity

The database has 13 verified schema upgrades applied (`001_canva_bindings.sql` through `013_design_studio.sql`).
All tables have forced Row Level Security (`FORCE ROW LEVEL SECURITY`) and tenant boundaries verified.

---

## 4. Rollback Plan & Reversibility

If a regression is observed in production:
1. **Preserve Database**: PostgreSQL contains 1,511 real task rows and 25 Canva binding records. Do not drop or wipe database volumes.
2. **Reversible Re-deployment**: Container images are versioned (`hawa-core:canva-only-20260913`, `hawa-worker:canva-only-20260913`). The deployment script `infra/docker/deploy.sh` allows instant rollback to the baseline tag without data loss.
3. **OpenAI Fail-Closed Guarantee**: Disallowed providers remain strictly disabled; rollback does not reactivate unbudgeted or disabled providers.
