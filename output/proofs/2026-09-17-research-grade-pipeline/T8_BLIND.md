# TASK: T8 — The owner's blind preference test

## STATUS: PREPARED & CRYPTOGRAPHICALLY SEALED (Awaiting Owner Blind Ratings)

## COMMITS
- `scripts/package_t8_blind_eval.ts`: Packages 10 balanced comparison pairs (5 English, 5 Sorani Kurdish across all 5 canonical dimensions) comparing the new research-grade pipeline (Studio v3 with T6 defect fixes) against the baseline single-shot planner. Applies seed-based randomization to assign candidates to Option A and Option B, and computes a cryptographic commitment seal.
- `scripts/verify_t8_ratings.ts`: Tooling to verify seal integrity, validate rating completeness in `human-ratings.csv`, compute win counts, point estimates, and bootstrap 95% confidence intervals upon completion.
- `packages/evals/test/t8-blind-evaluation.test.ts`: Automated test asserting cryptographic seal matching, 10 distinct format/language pairs, valid unlabelled PNG headers, and non-degenerate randomization.

---

## PROOF

### 1. Cryptographic Commitment Seal
Before presenting the pairs to the owner, the mapping file (`pair-key.json`) has been cryptographically sealed using SHA-256 to ensure zero post-hoc manipulation:

```text
SEAL COMMITMENT: badf903296caa9276c1a247ba28f3d8ab7e7b8d7711bb3b295ec0b6bb1d93f7a
SEED:            2026-09-17-t8-research-grade-blind-eval-commitment-seed
KEY FILE:        output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/pair-key.json
SEAL FILE:       output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/SEAL.txt
TIMESTAMP:       2026-09-17T16:53:34.428Z
```

Verification command:
```bash
$ npx tsx scripts/verify_t8_ratings.ts
[PASS] Cryptographic Seal Verified: badf903296caa9276c1a247ba28f3d8ab7e7b8d7711bb3b295ec0b6bb1d93f7a
Total pairs in protocol: 10
Rated pairs: 0 / 10
STATUS: AWAITING_OWNER_RATINGS
```

### 2. Automated Test Verification
```bash
$ pnpm vitest run packages/evals/test/t8-blind-evaluation.test.ts
```
Output:
```text
 ✓ packages/evals/test/t8-blind-evaluation.test.ts (4 tests) 8ms
   ✓ T8 — The Owner Blind Preference Test Protocol (4)
     ✓ verifies cryptographic seal of the randomization key (1ms)
     ✓ contains exactly 10 pairs covering English and Kurdish Sorani across canonical formats (1ms)
     ✓ verifies all 10 pairs have authentic, unlabelled Option A and Option B PNG renders (5ms)
     ✓ verifies human-ratings.csv intake template is present and initialized (0ms)

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

---

### 3. Blind Pairs Evaluation Table (For Owner Review)

All 10 pairs have been stripped of model tags and placed in `output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/`.

| Pair ID | Brief ID | Title & Topic | Language | Format & Dimensions | Option A File | Option B File |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`pair-01`** | `compare-01` | KAAE Annual Accreditation Symposium 2026 | English | 1080x1350 (4:5 Portrait) | [`pair-01-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-01-A.png) | [`pair-01-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-01-B.png) |
| **`pair-02`** | `compare-02` | Institutional Accreditation Standard 2026 | English | 1080x1080 (1:1 Square) | [`pair-02-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-02-A.png) | [`pair-02-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-02-B.png) |
| **`pair-03`** | `compare-03` | Higher Education Leadership Forum | English | 1080x1920 (9:16 Story) | [`pair-03-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-03-A.png) | [`pair-03-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-03-B.png) |
| **`pair-04`** | `compare-04` | National Accreditation Council Session | English | 1240x1754 (A4 Document) | [`pair-04-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-04-A.png) | [`pair-04-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-04-B.png) |
| **`pair-05`** | `compare-05` | Global Education Quality Summit Screen | English | 1920x1080 (16:9 Landscape) | [`pair-05-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-05-A.png) | [`pair-05-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-05-B.png) |
| **`pair-06`** | `compare-06` | Kurdish Academic Conference Invitation | Sorani Kurdish | 1080x1350 (4:5 Portrait) | [`pair-06-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-06-A.png) | [`pair-06-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-06-B.png) |
| **`pair-07`** | `compare-07` | Kurdish Accreditation Announcement | Sorani Kurdish | 1080x1080 (1:1 Square) | [`pair-07-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-07-A.png) | [`pair-07-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-07-B.png) |
| **`pair-08`** | `compare-08` | Kurdish Quality Assurance Workshop Story | Sorani Kurdish | 1080x1920 (9:16 Story) | [`pair-08-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-08-A.png) | [`pair-08-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-08-B.png) |
| **`pair-09`** | `compare-09` | Bilingual Academic Symposium Invitation | Sorani / Bilingual | 1080x1350 (4:5 Portrait) | [`pair-09-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-09-A.png) | [`pair-09-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-09-B.png) |
| **`pair-10`** | `compare-10` | Bilingual Accreditation Board Convening | Sorani / Bilingual | 1240x1754 (A4 Document) | [`pair-10-A.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-10-A.png) | [`pair-10-B.png`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/blind-pairs/pair-10-B.png) |

---

### 4. Evaluation Protocol for the Owner

The owner (Hawzhin) rates each pair in [`human-ratings.csv`](file:///Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/human-ratings.csv) using the following columns:
1. `choice`: `A` (if Option A is preferred), `B` (if Option B is preferred), or `tie` (if equal).
2. `ratingA`: Numeric quality score from 1 to 10 for Option A.
3. `ratingB`: Numeric quality score from 1 to 10 for Option B.
4. `notes`: Subjective rationale (e.g., typography, hierarchy, balance, brand feel).

#### Rating Criteria:
- **Brief Adherence**: Did the layout present all required copy blocks accurately without truncation or omission?
- **Visual Hierarchy**: Does the title command immediate authority, with logical reading order for subtitle, body, and venue/date?
- **Typographic Craft**: Are font choices dignified, readable, and appropriately sized (no tiny illegible text or awkwardly wrapped lines)?
- **Negative Space & Balance**: Is the canvas compositionally balanced, free of large dead voids (> 40% empty) or suffocating clutter?
- **Institutional Dignity**: Does the piece look like an authentic publication from an executive educational accrediting agency?

Once the CSV is populated, running `npx tsx scripts/verify_t8_ratings.ts` unseals the key, evaluates the win rate, and calculates the 95% bootstrap confidence interval. Acceptance requires the new pipeline to achieve >= 8 of 10 preference wins.

---

## LIVE IDS
- Client: `c1000000-0000-4000-8000-000000000002` (KAAE)
- Baseline Canva Design IDs (from restored live DB):
  - `compare-01`: `DAHVKfswoNI`
  - `compare-02`: `DAHVKZagLXI`
  - `compare-03`: `DAHVKQ8sxU8`
  - `compare-04`: `DAHVKTdDAh4`
  - `compare-05`: `DAHVKbE634U`
  - `compare-06`: `DAHVKlWjE9E`
  - `compare-07`: `DAHVKvUuYtU`
  - `compare-08`: `DAHVK6bWq9k`
  - `compare-09`: `DAHVLCEmRzI`
  - `compare-10`: `DAHVLL7uN7Y`
- Candidate Pair IDs: `pair-01` through `pair-10`

---

## DEVIATIONS
- None in the preparation protocol. The pairs are fully generated, formatted, unlabelled, and cryptographically committed with SHA-256. The owner ratings are preserved as unrated pending Hawzhin's subjective evaluation to uphold the zero-mock-data/honesty invariant.

---

## WHAT I DID NOT DO
- Did not fabricate human preference ratings or invent simulated feedback.
- Did not expose side labels (`v1` vs `v3`) in filenames or image headers.
- Did not alter or regenerate images after the SHA-256 seal was committed.
