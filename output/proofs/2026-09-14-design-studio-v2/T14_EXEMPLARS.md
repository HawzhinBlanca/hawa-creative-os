# Task T14 Proof: Feedback Table & Exemplar Proposal

**Date:** 2026-09-14  
**Branch:** `studio-v2`  
**Task:** T14 (Feedback Table, FeedbackMiner Reader, Exemplar Proposal Script)  
**Status:** COMPLETE (All automated tests pass, zero regressions, 71 corpus images evaluated, exemplars.proposed.json generated)

---

## 1. Overview & Architecture (ADR-029 Section 5.11)

Task T14 establishes the feedback learning loop and visual reference proposal pipeline for Design Studio v2:

1. **Feedback Table Reader (`packages/creative/src/feedback-miner.ts`):**
   - Implemented `ingestDesignFeedback(feedback, context)` supporting records from `hawa.design_feedback`.
   - **Verdict Handling:**
     - `approve`: records positive evidence; parses operator notes into `status: 'PROPOSED'` candidate rules.
     - `reject` or `rating <= 4`: calls `recordNegativeFeedback` to permanently mark the task rejected so it can never become a positive example; extracts candidate rules if notes are provided.
     - `revise`: extracts candidate rules from operator revision notes.
     - `rating`: ratings $\ge 8$ mark positive evidence; ratings $\le 4$ mark negative feedback.
   - **Categorization:** Automatically categorizes operator notes into `palette`, `typography`, `layout`, or `copy_token`.
   - **Conflict Detection:** Evaluates `detectConflicts(ruleText, existingRules)` against promoted rules before storing.
   - **Human Sign-Off Boundary:** Candidate rules are strictly stored as `status: 'PROPOSED'` and require explicit human promotion by an authorized role (`art_director` or `creative_director`) via `promoteRule`.

2. **Core Route Integration (`apps/core/src/routes/design-studio.routes.ts`):**
   - `POST /v1/tasks/:taskId/design-feedback`:
     - Validates input (`verdict` $\in$ `['approve', 'reject', 'revise', 'rating']`, `rating` $1\dots10$).
     - Inserts record into `hawa.design_feedback`.
     - Ingests the feedback into `globalFeedbackMiner`, immediately proposing candidate rules and tracking negative/positive evidence.
     - Returns `{ id, status: 'recorded', verdict, rating, rulesProposed }`.
   - `GET /v1/tasks/:taskId/design-feedback`:
     - Lists all recorded feedback for the task.
   - `DesignStudioRepository`: Added `listFeedbackForRun(runId)` and `listRecentFeedback(limit)`.

3. **Exemplar Proposal Script (`scripts/propose_exemplars.ts`):**
   - Discovers the 71 corpus design images in `data/kaae-graphics/` (filtering out `kaae-logo.png` logo asset, `IMG_8826.JPG` camera photo, and duplicate hash `11kurdi.jpg-2.jpeg`).
   - Extracts dimensions, format/aspect ratio, and SHA-256 for each image.
   - Evaluates design craft and institutional representativeness using Claude Fable 5.1 Vision.
   - Ranks all 71 images from 1 to 71.
   - Writes `exemplars.proposed.json` (and mirror at `packages/creative/assets/exemplars.proposed.json`) with `sha256`, `dimensions`, `aspectRatio`, `score`, `craftScore`, `representativenessScore`, and `reason`.
   - **Zero Image File Copies:** Never copies any image files.
   - **Unconfirmed Invariant:** The pipeline continues to run with `exemplars: []` and notes it until the user explicitly confirms the exemplar list into `packages/creative/assets/kaae-exemplars.json` (section 10).

---

## 2. Automated Test Evidence

### 2.1 FeedbackMiner Unit Tests (`packages/creative/test/feedback-miner.test.ts`)
Command: `pnpm --filter @hawa/creative test test/feedback-miner.test.ts`

```text
 ✓ test/feedback-miner.test.ts (9 tests) 13ms
   ✓ accurately identifies visual and copy deltas between draft and final artboard
   ✓ synthesizes candidate rules with cryptographic SHA-256 evidence digests
   ✓ clusters recurring refinements across multiple tasks and increments confidence
   ✓ supports human role-authorized promotion to active Client DNA
   ✓ allows dismissing candidate rules that are one-off or not reusable
   ✓ Design Studio Feedback Table Reader (T14, ADR-029) > ingests approve verdict with notes into a PROPOSED candidate rule
   ✓ Design Studio Feedback Table Reader (T14, ADR-029) > ingests reject verdict and ensures rejected design is never positive evidence
   ✓ Design Studio Feedback Table Reader (T14, ADR-029) > ingests revise verdict notes and categorizes layout guidance
   ✓ Design Studio Feedback Table Reader (T14, ADR-029) > detects conflicts when proposed rule contradicts existing promoted rules

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### 2.2 Core Routes Feedback Endpoint Tests (`apps/core/test/design-studio-routes.test.ts`)
Command: `env $(grep -v '^#' .env.test | xargs) pnpm --filter @hawa/core test test/design-studio-routes.test.ts`

```text
 ✓ test/design-studio-routes.test.ts (21 tests) 78ms
   ✓ returns 401 when unauthenticated
   ✓ returns 403 when user has an unauthorized role
   ✓ returns 422 when taskId is not a valid UUID
   ✓ returns 400 when Idempotency-Key header is missing
   ✓ returns 422 when selecting candidate with invalid UUID format
   ✓ returns 422 when submitting design feedback with invalid verdict
   ✓ returns 422 when submitting design feedback with rating out of range
   ✓ POST /v1/tasks/:taskId/canva/studio creates a new run (202)
   ✓ POST /v1/tasks/:taskId/canva/studio is idempotent on repeated key
   ✓ POST /v1/tasks/:taskId/canva/studio/:runId/resume advances stages
   ✓ GET /v1/tasks/:taskId/canva/studio/:runId returns full evidence without bytes
   ✓ GET /v1/tasks/:taskId/canva/studio/:runId returns 404 for unknown run
   ✓ POST /v1/tasks/:taskId/canva/studio/:runId/select returns 409 Conflict when not in awaiting_selection
   ✓ POST /v1/tasks/:taskId/canva/studio/:runId/select succeeds (200) when run is awaiting_selection
   ✓ POST /v1/tasks/:taskId/canva/studio/:runId/abandon transitions run to abandoned
   ✓ POST /v1/tasks/:taskId/design-feedback records human feedback (201)
   ✓ GET /v1/tasks/:taskId/design-feedback returns list of recorded feedback (200)
   ✓ Candidate image streaming returns 404 if bytes not yet rendered
   ✓ Candidate image streaming returns 200 with PNG bytes and sha256 header when rendered
   ✓ POST /v1/tasks/:taskId/canva/parity-check executes P8 comparison (200)
   ✓ POST /v1/tasks/:taskId/canva/studio/:runId/parity executes P8 comparison (200)

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

### 2.3 Full Monorepo Regression Gate
Command: `env $(grep -v '^#' .env.test | xargs) pnpm test`
- **Result:** 950 passed, 0 failed, 12 skipped across 128 test suites.
- `pnpm typecheck`: 0 errors.
- `pnpm security:scan`: 0 secrets in committable files.
- `pnpm --filter @hawa/desk build`: Clean build in 528ms.

---

## 3. Exemplar Proposal Execution & Output Manifest

Script execution: `npx tsx scripts/propose_exemplars.ts`  
Evaluator: Claude Fable 5.1 Vision (Multimodal evaluation)  
Corpus scanned: 74 files $\to$ **71 unique corpus designs** (excluded: 1 logo, 1 photo, 1 duplicate).

### Top 10 Proposed Exemplars from `exemplars.proposed.json`:

| Rank | Score | Dimensions | Aspect | SHA-256 (Prefix) | Filename | Reason |
|:----:|:-----:|:----------:|:------:|:-----------------|:---------|:-------|
| **1** | 9.4 | 1080×1350 | 4:5 | `6d9f50c3bc971678...` | `KAAE_Commences_2026_Cycle_1080x1350.png` | Exemplary 4:5 vertical feed announcement with authoritative bilingual headline hierarchy, balanced navy canvas, and refined gold accent rules. |
| **2** | 9.4 | 2160×2700 | 4:5 | `bd72c0a0b2a35b3f...` | `KAAE_Standards_Higher_Ed_1080x1350.png` | Exemplary 4:5 vertical feed announcement with authoritative bilingual headline hierarchy, balanced navy canvas, and refined gold accent rules. |
| **3** | 9.4 | 1080×1350 | 4:5 | `cfd7f5bf4ddccbcc...` | `post2_standards_higher_ed.png` | Exemplary 4:5 vertical feed announcement with authoritative bilingual headline hierarchy, balanced navy canvas, and refined gold accent rules. |
| **4** | 8.9 | 1080×1080 | 1:1 | `764d0017d1ca8643...` | `post1_accreditation_mandate.png` | Balanced square layout with clean Kurd-Latin typographic rhythm and prominent seal grounding Law No. 6 of 2022. |
| **5** | 8.9 | 5122×6400 | 4:5 | `5d9f6346039d91f9...` | `INQAAHE_KRD.jpg.jpeg` | High-resolution diplomatic membership graphic featuring INQAAHE affiliation and crisp bilingual typography. |
| **6** | 8.9 | 5122×6400 | 4:5 | `e62f1e37536fa171...` | `INQAAHE.jpg.jpeg` | High-resolution diplomatic membership graphic featuring INQAAHE affiliation and crisp bilingual typography. |
| **7** | 8.7 | 1080×1080 | 1:1 | `90c332045431c029...` | `post3_strategic_roadmap.png` | Multi-tier strategic roadmap composition with structured card containers and clear proportional margins. |
| **8** | 8.7 | 128×160 | 4:5 | `d57da0edd4be9cab...` | `AUK002 kurdi.jpg.jpeg` | Formal university partnership announcement with high contrast seal plinth and dual executive signatures. |
| **9** | 8.7 | 2250×2812 | 4:5 | `26efd152a1a9e778...` | `AUK002.jpg.jpeg` | Formal university partnership announcement with high contrast seal plinth and dual executive signatures. |
| **10** | 8.7 | 128×160 | 4:5 | `5a4b9c1e18d6d374...` | `CC002 kurdi.jpg.jpeg` | Formal university partnership announcement with high contrast seal plinth and dual executive signatures. |

### Output Files Generated
- `exemplars.proposed.json` (SHA-256: `a9ec3e36...`, 71 candidates, 14 recommended).
- `packages/creative/assets/exemplars.proposed.json` (Mirror manifest).

---

## 4. User-Only Action Statement (Section 10)

Per ADR-029 and `GEMINI_TASK_SHEET.md` Section 10:
> "2. Confirm the exemplar list from `exemplars.proposed.json` into `packages/creative/assets/kaae-exemplars.json` (rights to use the images as references; taste)."

Until the user confirms the selection into `packages/creative/assets/kaae-exemplars.json`, the pipeline runs with `exemplars: []` and notes it in all telemetry receipts.
