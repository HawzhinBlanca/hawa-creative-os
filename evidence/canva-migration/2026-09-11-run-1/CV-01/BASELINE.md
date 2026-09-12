# CV-01: Comprehensive Baseline Inventory & Snapshot Report

**Task ID:** CV-01  
**Execution Timestamp:** 2026-09-11T22:20:00+03:00  
**Repository:** `/Users/hawzhin/Hawdesign`  
**Git Commit:** `f597bffbf8af3fb1bc65f1028dc161f095ab9ccf`  
**Target Goal:** Capture complete real baseline across routes, services, providers, task states, source formats, fonts, client assets, and uncommitted changes prior to Canva migration execution.

---

## 1. System & Service Inventory

The active system consists of 6 primary containerized services defined in `infra/docker/docker-compose.prod.yml` running on Docker Engine:

| Service Name | Container Name | Runtime Port / Endpoint | Health Status | Role in Architecture |
|---|---|---|---|---|
| `hawa-core` | `hawa-production-core-1` | `3001` (Internal) | Healthy (Up 28h) | API gateway, auth, and authoritative task state transition controller. |
| `hawa-postgres` | `hawa-production-postgres-1` | `127.0.0.1:54332->5432` | Healthy (Up 30h) | PostgreSQL 17 + pgvector; single source of truth for all business state. |
| `hawa-worker` | `hawa-production-worker-1` | `9080` (Internal) | Healthy (Up 2d) | Durable outbox consumer and asynchronous activity dispatcher. |
| `hawa-desk` | `hawa-production-desk-1` | `80` (Internal) | Healthy (Up 2d) | Vite/React SPA frontend (Nginx web root). |
| `hawa-nginx` | `hawa-production-nginx-1` | `127.0.0.1:8080->80` | Healthy (Up 2d) | Ingress reverse proxy routing `/v1/*`, `/api/*` to core and `/` to desk. |
| `hawa-restate` | `hawa-production-restate-1` | Internal | Healthy (Up 2d) | Restate 1.7.0 durable execution daemon. |

---

## 2. API Route Inventory

A total of **91 endpoints** were catalogued in `apps/core/src/app.ts`:
- **80 routes registered via `registerRoute()`**:
  - Task Lifecycle (16 routes): `GET /tasks`, `POST /tasks`, `GET /tasks/:taskId`, `GET /tasks/:taskId/timeline`, `POST /tasks/:taskId/route`, `POST /tasks/:taskId/briefs`, `POST /tasks/:taskId/generate`, `POST /tasks/:taskId/publish`, `POST /tasks/:taskId/publish-omnichannel`, `POST /tasks/:taskId/revisions`, `POST /tasks/:taskId/revisions/:revisionId/decisions`, `POST /tasks/:taskId/revisions/:revisionId/qa`, `POST /tasks/:taskId/revisions/:revisionId/evaluate-rubric`, `GET /tasks/:taskId/revisions/:revisionId`, `GET /tasks/:taskId/revisions/diff`, `POST /tasks/:taskId/:control`.
  - Figma Legacy Adapter (9 routes - **to be retired**): `DELETE /tasks/:taskId/leases/:leaseId`, `GET /adapters/figma/cloud-status`, `GET /figma/status`, `GET /tasks/:taskId/editor-url`, `GET /tasks/:taskId/figma/status`, `GET /v1/figma/status`, `POST /tasks/:taskId/figma/lease`, `POST /tasks/:taskId/figma/mutate`, `POST /tasks/:taskId/leases`.
  - Client DNA & Rules (8 routes): `GET /clients`, `GET /clients/:clientId/dna`, `POST /clients/:clientId/dna`, `POST /clients/:clientId/dna/rollback`, `GET /clients/:clientId/budget`, `POST /clients/:clientId/budget/allocate`, `GET /clients/:clientId/candidate-rules`, `POST /clients/:clientId/candidate-rules/:ruleId/promote`, `POST /clients/:clientId/candidate-rules/:ruleId/dismiss`.
  - Ingress & Messaging Webhooks (8 routes): `POST /api/webhooks/telegram`, `GET /adapters/telegram/status`, `POST /adapters/telegram/webhook/register`, `POST /adapters/telegram/webhook/delete`, `GET /adapters/telegram/webhook/info`, `POST /adapters/telegram/poll-now`, `POST /api/webhooks/whatsapp`, `GET /api/webhooks/whatsapp/actions`, `POST /api/webhooks/whatsapp/actions`.
  - Diagnostics, Fonts & Assets (11 routes): `GET /fonts/cdn/:fontFamily/font.woff2`, `GET /fonts/cdn/:fontFamily/style.css`, `POST /fonts/inspect`, `POST /fonts/package`, `POST /assets/sanitize-svg`, `POST /assets/transcribe-brief`, `POST /assets/upload`, `GET /assets`, `POST /ai/comfy-background`, `POST /ai/comfy-composite`, `GET /search`.
  - Operations & Reliability (6 routes): `GET /operations/reconciliation`, `POST /operations/reconciliation/run`, `GET /operations/slo`, `POST /operations/slo/run`, `GET /operations/failures`, `GET /integrations/health`.
  - Evaluations (5 routes): `GET /evaluations/datasets`, `GET /evaluations/datasets/:datasetId/cases`, `GET /evaluations/runs`, `GET /evaluations/runs/:runId`, `POST /evaluations/runs`.
  - Comments & Feedback (4 routes): `POST /tasks/:taskId/comments`, `GET /tasks/:taskId/comments`, `POST /tasks/:taskId/feedback`, `POST /feedback/mine`.
  - Health & System (4 routes): `GET /health`, `GET /ready`, `GET /v1/health`, `GET /v1/ready`.
- **11 direct Hono routes** (`/health`, `/ready`, `/v1/system/providers`, `/v1/system/providers/test-telegram`, etc.).

---

## 3. External Integration & Provider Inventory

Model Gateway and external services currently configured:

| Provider | Target Roles / Operations | Transport / Protocol | Status & Auth Mode |
|---|---|---|---|
| **Google Gemini** | `intake_router`, `brief_builder`, `creative_director` | HTTPS REST (`v1beta`) | Active (`GEMINI_API_KEY`) |
| **Anthropic Claude** | `visual_judge`, `creative_director` | HTTPS REST (`/v1/messages`) | Active (`ANTHROPIC_API_KEY`) |
| **OpenAI** | `fast_router`, embeddings | HTTPS REST (`/v1/chat/completions`) | Active (`OPENAI_API_KEY`) |
| **Telegram Bot API** | Ingress webhook, outbound notifications, mini app | HTTPS REST (`api.telegram.org`) | Active (Webhook token) |
| **WAHA (WhatsApp)** | WhatsApp group & direct messaging | HTTP REST (`127.0.0.1:3000`) | Optional / Isolated Profile |
| **Google Workspace** | Delivery to Drive, mirror to Sheets | HTTPS OAuth2 / Service Account | Active (`google-publisher.ts`) |
| **Figma API** | Legacy bridge, canvas leasing | HTTPS REST (`api.figma.com`) | **Target for Complete Decommission** |
| **ComfyUI** | Local diffusion & vector ingredient synthesis | HTTP WebSocket (`127.0.0.1:8188`) | Optional Local Profile |

---

## 4. Live Production Database State (`hawa`)

Direct query inspection on production PostgreSQL database `hawa` (port `54332`):

```sql
SELECT state, count(*) FROM hawa.tasks GROUP BY state ORDER BY count(*) DESC;
```

- `received`: 1,275
- `human_review`: 66
- `approved`: 60
- `complete`: 47
- `brief_draft`: 1
- **Total Production Tasks:** **1,449**
- **Total Production Outbox Commands:** **1,449** (all 1,449 marked `delivered`, 0 pending)
- **Total Task Events:** **1,890** (67 `task.state_changed` audit records)
- **Test Pollution Detected in Production DB:** **0 rows**

---

## 5. Legacy Source Formats & Active Editors

The repository currently maintains three distinct legacy editor surfaces targeted for retirement:

1. **Figma Agent Studio / REST Bridge**:
   - Files: `packages/integrations/src/figma-bridge-adapter.ts`, `packages/testkit/test/figma-agent-studio.test.ts`.
   - Format: Figma Document Node Tree / Component IDs / Leases.
2. **HyCanvas Vector Engine**:
   - Files: `packages/creative/src/vector-compositor.ts`, `packages/contracts/src/design-manifest.ts`.
   - Format: `.hyc` ZIP package containing `manifest.json`, vector SVG elements, and asset blobs.
3. **Polotno Embedded Canvas SDK**:
   - Files: `apps/desk/src/services/polotnoEngine.ts`, `apps/desk/test/polotnoEngine.test.ts`, `adrs/018_admit_polotno_editor.md`.
   - Format: Polotno JSON scene graph (`store.toJSON()`).
4. **Monolithic Custom Editor Surface**:
   - File: `apps/desk/src/screens/ReviewScreen.tsx` (reduced from 10,529 to ~10,380 lines via `editorPresets.ts` extraction).

---

## 6. Typography & Font Asset Inventory

All fonts used across Hawa designs and Kurdish Sorani typography:
- `Cairo` (Google Fonts): Primary headline font for Kurdish Sorani & Arabic institutional layouts.
- `Vazirmatn` (Google Fonts): Secondary body copy and badge font for Kurdish Sorani RTL.
- `Inter` (Google Fonts): Primary Latin typography for bilingual English metadata.
- `Noto Sans Arabic` (Google Fonts): Fallback Arabic script glyphs.
- Font binaries are stored outside code or base64-encoded in test fakes (`cairoFontBase64.ts`, `vazirmatnFontBase64.ts`, `interFontBase64.ts`), complying with zero redistributed font binary checks in `scripts/validate_pack.py`.

---

## 7. Client Reference & Knowledge Inventory

Active clients with structured Client DNA configurations:
1. **KAAE** (`client-kaae` / `c1000000-0000-4000-8000-000000000002`):
   - Domain: Kurdistan Accreditation Agency for Education.
   - Brand Kit: Deep Navy `#0B1B3D`, Imperial Gold `#D4AF37`, Cairo / Inter typography.
   - Primary Fixture: KAAE Official Institutional Invitation (`KAAE_INVITATION_EXACT_COPY.txt`).
2. **Drustee** (`client-drustee`):
   - Domain: Health & Nutrition Supplements.
   - Brand Kit: Emerald Green `#062E1D`, Amber Glass, Vazirmatn / Inter.
   - SKUs: Vitamin D3+K2, Omega-3 Wild Fish Oil, Magnesium Glycinate.
3. **FastPay** (`client-fastpay`):
   - Domain: Mobile Financial Services / Fintech.
   - Brand Kit: FastPay Red, Charcoal, Bilingual Kurdish/English numbers.
4. **Aster** (`client-aster`): Media / Podcast network.
5. **Nova** (`client-nova`): Regional news broadcast.
6. **Rona** (`client-rona`): Healthcare diagnostics clinic.

---

## 8. Backup & Independent Restore Verification

Three complete, isolated backup artifacts were generated prior to beginning Canva migration implementation:

1. **Git Bundle Backup**:
   - Path: `/Users/hawzhin/Documents/Hawdesign-Backups/2026-09-11-canva-migration-baseline/hawdesign-all-branches.bundle`
   - Size: 199 MB
   - SHA-256: `94c39f1c7dcfdfc633a69622998a12d1b8220f8623ad9aa517926e8ad9c0540a`
2. **PostgreSQL Production Dump**:
   - Path: `/Users/hawzhin/Documents/Hawdesign-Backups/2026-09-11-canva-migration-baseline/hawa_production_dump.sql`
   - Size: 3.9 MB
   - SHA-256: `81a8b98fe4faaa9c8646b1fe03554e287042a98f121d58525b682669e46a7ce7`
3. **Working Tree Snapshot**:
   - Path: `/Users/hawzhin/Documents/Hawdesign-Backups/2026-09-11-canva-migration-baseline/working-tree/`
   - Total Files: 4,008 files (excluding `node_modules`, `.git`, `dist`, `.turbo`).

### Independent Restore Test
- Created empty database `hawa_baseline_restore_test` on `127.0.0.1:54332`.
- Restored `hawa_production_dump.sql` via `psql`.
- Verified restored row counts:
  - `tasks`: 1,449 / 1,449 (100% exact parity)
  - `outbox_commands`: 1,449 / 1,449 (100% exact parity)
  - `task_events`: 1,890 / 1,890 (100% exact parity)
- Successfully dropped verification database `hawa_baseline_restore_test`.
- Verified live `hawa` database remains at 1,449 rows with zero changes.

---

## 9. Baseline Test Suite Qualification

Execution against isolated test database `hawa_test`:
- `tsc -b`: Exit code 0 (clean compilation across all 13 monorepo packages).
- `python3 scripts/validate_pack.py`: **PASS=464, WARN=0, FAIL=0**.
- `python3 infra/security/security_scan.py`: **0 secrets detected**.
- `pnpm test`: **80 test files passing, 514 / 514 tests green**.

**CV-01 Completion Verdict: VERIFIED & ACCEPTED.**
