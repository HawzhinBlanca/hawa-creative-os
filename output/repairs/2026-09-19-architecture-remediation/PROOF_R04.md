# Proof Dossier: Task R04 — Enforce Principal, Tenant, Client, Task, and Run Scope Everywhere

**Date:** 2026-09-19  
**Status:** QUALIFIED / PROVED  
**Normative Standards:** ADR-001, ADR-011, FR-011, FR-043, FR-066-069, FR-077, NFR-006, NFR-007  
**Test Evidence:**  
- `apps/core/test/r04-scope-enforcement.test.ts` (10/10 passed)  
- `apps/core/test/core.test.ts` (28/28 passed)  
- `apps/core/test/design-studio-routes.test.ts` (21/21 passed)  
- `apps/core/test/r03-authoritative-config-postgresql.test.ts` (7/7 passed)  
- `apps/core/test/governed-learning-dna-lifecycle.test.ts` (6/6 passed)  

---

## 1. Defect Analysis & Counterexamples

### 1.1 Long-Lived Static Admin/Operator Keys in URL Query Parameters
- **Baseline Defect:** The application allowed passing static credentials (such as `HAWA_ADMIN_KEY` or `HAWA_BEARER_TOKEN`) via `?access_token=...` query parameters on SSE streams and image endpoints. This exposed long-lived root keys to browser URL histories, web server access logs, reverse-proxy logs, and HTTP Referer headers.
- **Counterexample Observed:** Supplying `?access_token=hawa_admin_local_dev_key` to `/v1/events/stream` authenticated the user as root `administrator`.
- **Remediation:** In `apps/core/src/app.ts`, query parameter authentication was restricted exclusively to active, short-lived issued desk sessions in `issuedSessions`. Any attempt to pass a static bearer key via query parameter is rejected immediately with `401 Unauthorized`.

### 1.2 Unauthenticated Server-Sent Events (SSE) Stream
- **Baseline Defect:** `/v1/events/stream` lacked mandatory authentication checks, permitting arbitrary unauthorized connections to listen to internal system events and real-time task mutations.
- **Remediation:** Enforced `verifyRequestAuth(c)` at the ingress of `/v1/events/stream` in `apps/core/src/routes/system.routes.ts`, returning `401 Authentication Required` when no valid session or credential is provided.

### 1.3 Missing Task & Actor Scope Enforcement in DesignStudio
- **Baseline Defect:** `DesignStudioService.abandon()`, `doResume()`, and `selectCandidate()` accepted arbitrary `taskId` parameters without verifying that `run.task_id === taskId`. Furthermore, any actor could mutate or abandon a design run initiated by another operator without administrative or art-director privileges.
- **Remediation:**
  - Enforced `run.task_id !== taskId` check, throwing `CanvaFlowError(403, 'TASK_SCOPE_MISMATCH')`.
  - Enforced actor ownership check: unless the calling principal has role `'administrator'` or `'art_director'`, `run.actor_id !== s.actorId` throws `CanvaFlowError(403, 'ACTOR_SCOPE_MISMATCH')`.
  - Enforced tenant boundaries: all database queries for design runs require matching `tenant_id`.

### 1.4 Cross-Tenant & Cross-Client Event Leakage
- **Baseline Defect:** Real-time event broadcasts published every task mutation to every connected stream subscriber regardless of tenant ID or client ID.
- **Remediation:** In `apps/core/src/routes/system.routes.ts`, SSE subscriber filters events against `auth.tenantId` and `auth.clientId` (unless caller is superadmin), guaranteeing cross-tenant and cross-client event isolation.

### 1.5 Immediate Session Revocation
- **Remediation & Proof:** Verified that `DELETE /v1/auth/session` removes the session from both memory cache and PostgreSQL durable storage (`hawa.active_sessions`), instantly blocking any subsequent API calls with `401 Unauthorized`.

---

## 2. Verification Suite Results

```bash
$ vitest run test/r04-scope-enforcement.test.ts test/core.test.ts test/design-studio-routes.test.ts

 ✓ test/design-studio-routes.test.ts (21 tests) 77ms
 ✓ test/core.test.ts (28 tests) 53ms
 ✓ test/r04-scope-enforcement.test.ts (10 tests) 28ms

Test Files  3 passed (3)
     Tests  59 passed (59)
```

Total regression across core test suites: **72/72 tests passed**.
