# Task T12 Proof: Design Studio v2 Routes and Desk Studio Panel

## Overview
- **Routes File**: `apps/core/src/routes/design-studio.routes.ts`
- **Mounted In**: `apps/core/src/app.ts` via `registerDesignStudioRoutes`
- **Desk Client**: `apps/desk/src/api/client.ts` (`HawaApiClient.studio`)
- **Desk UI**: `apps/desk/src/components/StudioPanel.tsx` mounted in `apps/desk/src/screens/WorkScreen.tsx`
- **Route Tests**: `apps/core/test/design-studio-routes.test.ts` (18 tests passed)
- **Visual Artifact**: `output/proofs/2026-09-14-design-studio-v2/T12_DESK.png`

---

## 1. HTTP Routes (Section 5.9 Specification)

| Method | Path | Status Codes | Description |
|---|---|---|---|
| `POST` | `/v1/tasks/:taskId/canva/studio` | 202, 400, 401, 403, 409, 422, 429 | Starts or retrieves a studio run with mandatory `Idempotency-Key` header |
| `POST` | `/v1/tasks/:taskId/canva/studio/:runId/resume` | 200, 401, 403, 404, 422 | Advances the studio run by one journaled stage |
| `GET` | `/v1/tasks/:taskId/canva/studio/:runId` | 200, 401, 403, 404, 422 | Returns full evidence run tree, candidates, judgments, calls count, without raw bytes |
| `GET` | `/v1/tasks/:taskId/canva/studio/:runId/candidates/:candidateId/:type` | 200, 401, 403, 404, 422 | Streams binary PNG (`preview.png`, `art.png`, `composite.png`) with `X-Content-SHA256` header |
| `POST` | `/v1/tasks/:taskId/canva/studio/:runId/select` | 200, 401, 403, 404, 409, 422 | Operator selects candidate in `awaiting_selection` status to advance to transfer |
| `POST` | `/v1/tasks/:taskId/canva/studio/:runId/abandon` | 200, 401, 403, 404, 409, 422 | Abandons run with required reason to free concurrency slot |
| `POST` | `/v1/tasks/:taskId/design-feedback` | 201, 401, 403, 422 | Records human feedback (verdict: approve/reject/revise/rating, score 1-10, notes) |

All studio endpoints are wrapped in `protect()` requiring valid authentication and authorized roles (`['administrator', 'art_director', 'creative_director', 'operator', 'designer']`). Unauthorized roles receive `403 Design Studio Access Forbidden`. All responses set `Cache-Control: no-store`.

---

## 2. Desk Studio Panel Implementation
- **API Client Additions** (`apps/desk/src/api/client.ts`):
  - `startRun(taskId, key, options)`
  - `resumeRun(taskId, runId)`
  - `getRun(taskId, runId)`
  - `getCandidateImageUrl(taskId, runId, candidateId, type)`
  - `selectCandidate(taskId, runId, candidateId)`
  - `abandonRun(taskId, runId, reason)`
  - `submitFeedback(taskId, payload)`
- **Component Design** (`apps/desk/src/components/StudioPanel.tsx`):
  - Multi-candidate side-by-side comparison view (displaying concepts, typography pairing, color chips, and preview thumbnails).
  - Score display (e.g. 8.9/10), status badges, and tournament rankings.
  - "Select Winner" button for candidates when run is in `awaiting_selection`.
  - Human review feedback controls with 1–10 star rating selector, "Approve", "Reject", "Request Revision" action buttons, and review notes textarea.
  - Lifecycle actions for Starting, Resuming stages, and Abandoning runs.
- **Screen Integration** (`apps/desk/src/screens/WorkScreen.tsx`):
  - Mounted alongside Canva inspector and task details.
  - Successfully compiles via `pnpm --filter @hawa/desk build`.

---

## 3. Visual Artifact
- File: `output/proofs/2026-09-14-design-studio-v2/T12_DESK.png` (1.15 MB, 16:9, PNG format).

---

## 4. Route Test Suite Evidence
Command: `pnpm vitest run apps/core/test/design-studio-routes.test.ts`

```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ apps/core/test/design-studio-routes.test.ts (18 tests) 97ms
   ✓ Authentication and Authorization > returns 401 when unauthenticated
   ✓ Authentication and Authorization > returns 403 when user has an unauthorized role
   ✓ Parameter Validation (422 and 400) > returns 422 when taskId is not a valid UUID
   ✓ Parameter Validation (422 and 400) > returns 400 when Idempotency-Key header is missing
   ✓ Parameter Validation (422 and 400) > returns 422 when selecting candidate with invalid UUID format
   ✓ Parameter Validation (422 and 400) > returns 422 when submitting design feedback with invalid verdict
   ✓ Parameter Validation (422 and 400) > returns 422 when submitting design feedback with rating out of range
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/canva/studio creates a new run (202)
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/canva/studio is idempotent on repeated key
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/canva/studio/:runId/resume advances stages
   ✓ Studio Run Lifecycle > GET /v1/tasks/:taskId/canva/studio/:runId returns full evidence without bytes
   ✓ Studio Run Lifecycle > GET /v1/tasks/:taskId/canva/studio/:runId returns 404 for unknown run
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/canva/studio/:runId/select returns 409 Conflict when not in awaiting_selection
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/canva/studio/:runId/select succeeds (200) when run is awaiting_selection
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/canva/studio/:runId/abandon transitions run to abandoned
   ✓ Studio Run Lifecycle > POST /v1/tasks/:taskId/design-feedback records human feedback (201)
   ✓ Studio Run Lifecycle > Candidate image streaming returns 404 if bytes not yet rendered
   ✓ Studio Run Lifecycle > Candidate image streaming returns 200 with PNG bytes and sha256 header when rendered

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Start at  13:44:32
   Duration  834ms (transform 467ms, setup 0ms, import 662ms, tests 97ms, environment 0ms)
```
