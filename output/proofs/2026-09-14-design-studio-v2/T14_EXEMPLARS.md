# Task T14 Proof: Feedback Table & Exemplar Proposal

**Date:** 2026-09-14  
**Branch:** `studio-v2`  
**Task:** T14 (Feedback Table, FeedbackMiner Reader, Exemplar Proposal Script)  
**Status:** COMPLETE (All automated tests pass, zero regressions, 71 corpus images evaluated live with Claude Fable 5.1 Vision with full receipts)

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
   - Evaluates design craft and institutional representativeness live using **Claude Fable 5.1 Vision** (`evaluator: "vision"`).
   - Generates distinct, authentic reasons anchored in visible graphic details.
   - Stores full provider receipt (`responseId`, `model`, `inputTokens`, `outputTokens`, `costUsd`) per evaluated design.
   - Ranks all 71 images from 1 to 71.
   - Writes exclusively to `packages/creative/assets/exemplars.proposed.json` (stray root file deleted).
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
Command: `pnpm vitest run apps/core/test/design-studio-routes.test.ts`

```text
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
```

---

## 3. Exemplar Proposal Execution & Output Manifest

- **Script execution**: `npx tsx scripts/propose_exemplars.ts`
- **Evaluator**: Claude Fable 5.1 Vision (Multimodal evaluation)
- **Corpus scanned**: 74 files $\to$ **71 unique corpus designs** (excluded: 1 logo, 1 photo, 1 duplicate hash)
- **Evaluator Breakdown**: 71 Vision evaluations, 0 Heuristic fallbacks (100% vision evaluated)
- **Financial Spend**:
  - Total Input Tokens: 273,762 tokens
  - Total Output Tokens: 11,906 tokens
  - Total Cost: **$2.7500 USD**
  - Average Cost per Design: **$0.0387 USD**

### Top 10 Proposed Exemplars (Live Fable Vision Ranked):

| Rank | Score | Dims | Aspect | Receipt (`responseId`) | Filename | Reason (Claude Fable 5.1 Vision) |
|:---:|:---:|:---:|:---:|:---|:---|:---|
| **1** | 8.7 | 1080×1350 | 4:5 | `msg_011Cf3R9Rx5ku4mia8hauPrA` | `KAAE_Commences_2026_Cycle_1080x1350.png` | Midnight-navy grid canvas with gold-accented Sorani headline, tracked Latin subhead, centered emblem, and three symmetrical feature cards deliver strong hierarchy and generous margins, though the small-caps Latin subhead and card labels run slightly small and the KAAE logo box breaks the palette. |
| **2** | 8.6 | 1080×1080 | 1:1 | `msg_011Cf3RARt9NFN8DCPrAMAcy` | `post1_accreditation_mandate.png` | Navy serif headline 'Advancing Academic Rigor & Institutional Excellence' with gold accent rule, gold-bordered Law No. 6 of 2022 callout, and three navy/gold stat cards (02, MSCHE, 100%) on cream form a disciplined, dignified hierarchy, though the mid-section whitespace gap and stat-card top gradient slightly weaken flow. |
| **3** | 8.5 | 1080×1350 | 4:5 | `msg_011Cf3RAS34uxEFtV8g3xSNu` | `post2_standards_higher_ed.png` | Navy serif headline with gold eyebrow and rule, numbered standard cards with gold left accents and 'Required Evidence' chips on a cream dotted field form a disciplined, dignified hierarchy, though only Latin typesetting is shown and the logo lockup reads slightly small against the generous top margin. |
| **4** | 8.5 | 160×128 | 160:128 | `msg_011Cf3R5FVvjbHPrRphZ97S3` | `kaae 5 kurdi.jpg.jpeg` | Full-bleed institutional photo with a navy gradient scrim carrying two-line white Sorani Kurdish headline over a gold rule and top-left KAAE seal creates clear hierarchy in the brand's navy-gold-cream palette, though the caption crowds the subjects' hands and the small logo lacks a contrast plate. |
| **5** | 8.3 | 1080×1080 | 1:1 | `msg_011Cf3RB3YkqJVo8p2bP7HrJ` | `post3_strategic_roadmap.png` | Serif white headline with gold italic subtitle over Midnight Navy, four evenly spaced glass cards with gold icon tiles and a statutory footer citing Law No. 6 of 2022 deliver a dignified, on-brand institutional roadmap, though the large empty band between header and cards and emoji-style icons slightly weaken polish. |
| **6** | 8.2 | 128×160 | 4:5 | `msg_011Cf3QzQPa6h9GkJCar4rVi` | `AUK002 kurdi.jpg.jpeg` | Clean Sorani Kurdish typesetting with a bold navy headline, gold subhead, and an angled midnight-navy banner pairing the AUK crest, though the wide empty gap between the body text and footer line weakens vertical balance. |
| **7** | 8.0 | 128×160 | 4:5 | `msg_011Cf3R413jZicV7zxouR2FW` | `call for kurdi.jpg.jpeg` | Strong Sorani typographic hierarchy with a gold-on-navy 'بانگەواز بۆ' header block, oversized navy headline, and icon-led benefit panel on a cream grid background, though the faded photo bottom-left slightly competes with the layout. |
| **8** | 8.0 | 128×160 | 4:5 | `msg_011Cf3QzxKwdcf94u3rmULZU` | `CC002 kurdi.jpg.jpeg` | Clean midnight-navy card with gold Sorani headline, white CHEA/CIQG logo panel and overlapping navy 'CHEA CIQG' tab shows strong hierarchy and brand palette, though the KAAE logo floats loosely top-left and the large empty lower band slightly weakens balance. |
| **9** | 8.0 | 128×160 | 4:5 | `msg_011Cf3R1s9vh98NGn1hXaheR` | `CUE002 kurdi.jpg.jpeg` | Clean Sorani/Latin hierarchy in navy headline with gold subtitle and a navy chevron banner framing the CUE logo on cream grid background, though body text is slightly heavy and lower whitespace feels unbalanced. |
| **10** | 8.0 | 2048×1152 | 16:9 | `msg_011Cf3RCB1V8zFvRwwbaW6Qs` | `image16.png` | Clean navy-on-cream impact slide with a gold 'IMPACT' eyebrow, bold navy headline, four large numeric stats with small-caps labels, and a navy-framed photo strip of KAAE events anchored by the centered seal and footer, though the stats row and photo strip leave slightly loose vertical spacing. |

### Output Manifest Artifacts
- Path: `packages/creative/assets/exemplars.proposed.json`
- File Size: 83,934 bytes (~82 KB)
- SHA-256: `0302793177e82e86970a7bc1ce56b0b16f3e0b907cec0f72c2260d5436af9bac`
- Total Entries: 71
- Recommended Count: 12 (Top 12 entries or score $\ge 8.5$)
- Stray root copy (`/exemplars.proposed.json`): Deleted from git and disk.

---

## 4. User-Only Action Statement (Section 10)

Per ADR-029 and `GEMINI_TASK_SHEET.md` Section 10:
> "2. Confirm the exemplar list from `exemplars.proposed.json` into `packages/creative/assets/kaae-exemplars.json` (rights to use the images as references; taste)."

Until the user confirms the selection into `packages/creative/assets/kaae-exemplars.json`, the pipeline runs with `exemplars: []` and notes it in all telemetry receipts.
