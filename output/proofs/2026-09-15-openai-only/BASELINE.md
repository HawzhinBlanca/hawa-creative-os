# L00 Baseline Inventory & System State

- **Date / Timestamp**: 2026-09-15T09:27:00Z
- **Working Tree Commit**: `15d6d18`
- **Branch**: `studio-v2`
- **Specification Document**: `output/plans/2026-09-15-openai-only/GEMINI_TASK_SHEET.md`
- **Governing Architecture Decision**: `adrs/030_openai_only_canva_telegram_system.md`

---

## 1. Running Container Stack & Image Identity

| Container Name | Image Tag | Image ID / Digest | Created Timestamp | Status |
|---|---|---|---|---|
| `hawa-production-core-1` | `hawa-production-core:latest` | `sha256:cb7f3d70eadd6057f04324718fa1bf9a866d7744a1968ec422d7bff2a693a123` | `2026-09-14T21:38:04Z` | Up (healthy) |
| `hawa-production-worker-1` | `hawa-worker:canva-only-20260913` | `sha256:a9af78910c916c1a68736aa80e4d0c20a09abdf274bd7d1330d21fc4ab4709e2` | `2026-09-14T20:35:45Z` | Up (healthy) |
| `hawa-production-desk-1` | `hawa-desk:canva-only-20260913` | `sha256:7c98d96943ef4102657cf11d5a7a9798ef26c86aaa79f95081f1c5b93ca27f56` | `2026-09-14T20:35:41Z` | Up (healthy) |
| `hawa-production-nginx-1` | `nginx:1.27-alpine-slim` | `sha256:d82...` | `2026-09-13T21:21:00Z` | Up (healthy) |
| `hawa-production-restate-1` | `ghcr.io/restatedev/restate:1.7.0` | `sha256:e14...` | `2026-09-13T21:21:00Z` | Up (healthy) |
| `hawa-production-postgres-1` | `pgvector/pgvector:pg17` | `sha256:a93...` | `2026-09-13T21:21:00Z` | Up (healthy) |

---

## 2. Database State & Invariants

- **Database**: PostgreSQL 17 with `pgvector`
- **Applied Migrations** (table `hawa.schema_upgrades`):
  - `001_canva_bindings.sql` through `013_design_studio.sql` (13 upgrades applied, all hashes verified).
- **Core Entity Counts**:
  - `hawa.tasks`: 1,511 rows
  - `hawa.canva_bindings`: 25 rows
  - `hawa.design_studio_runs`: 18 rows
  - `hawa.design_studio_calls`: 99 rows
- **Backup & Health Verification**:
  - Nightly verified backups active (`infra/backup/snapshots/hawa_20260915T003005Z.dump`, 77.8 MB).
  - Self-healing watchdog active every 5 minutes in launch agents.

---

## 3. Active Provider Routes Prior to L01 Migration

| Path | Primary Model | Fallback / Imagery | Status | Problem / Blocker |
|---|---|---|---|---|
| **Legacy Planner** | `claude-opus-5` | None | **OFFLINE** | Fails with Anthropic HTTP 400 "credit balance is too low". |
| **Studio v2 Stages** | `claude-fable-5-1` | `gemini-3-pro-image` | **BROKEN** | 15–25 calls/run; Anthropic billing exhausted; overlapping text in layout generation; transfer missing logo bytes. |
| **Target Architecture** | `gpt-6-astra` | `gpt-image-2.5-sunburst` | **TARGET** | Single provider policy under ADR-030; Canva-only editing; deterministic collision-free layout flow. |

---

## 4. Existing OpenAI Credential Status

- **Credential**: `OPENAI_API_KEY` exists in runtime environment and root `.env` (`sk-proj...`, 164 chars).
- **Endpoint Connectivity**: Probed `https://api.openai.com/v1/models` successfully (HTTP 200, 20 models visible).
- **Target Model Probing**:
  - `gpt-6-astra` returned `403 model_not_found` (`Project proj_Joi7d0agEUBGRv7hTEVp6szc does not have access to model gpt-6-astra`).
  - `gpt-image-2.5-sunburst` returned `403 model_not_found`.
  - Available fallback/current generation models in project: `gpt-4o` (HTTP 200) and `gpt-image-1` (HTTP 200).
- **Discipline Policy**: As required by L01 and Section 4 of the task sheet, model access boundaries are documented transparently without model substitution or fabricated receipts.
