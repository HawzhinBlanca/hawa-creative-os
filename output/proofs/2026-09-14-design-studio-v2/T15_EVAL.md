# Proof T15: Evaluation Harness (24 Golden Briefs, Offline Runner, Live Runner, Ratings Intake)

**Task**: T15 Evaluation harness  
**Timestamp**: 2026-09-14T23:26:00+03:00  
**Branch**: `studio-v2`  
**Status**: COMPLETE (Offline runner green in `pnpm test`)

---

## 1. Golden Brief Dataset Summary (24 Briefs)

The 24 golden briefs are located in `packages/evals/src/design-studio/briefs/`. The dataset covers all required formats and language distributions adhering to KAAE institutional design standards.

### Language Breakdown
- **English (Latin script)**: 12 briefs (50.0%)
- **Sorani Kurdish (Arabic script)**: 8 briefs (33.3%)
- **Mixed Bilingual (Latin + Arabic scripts)**: 4 briefs (16.7%)
- **Total**: 24 briefs

### Format Distribution
- **1080×1350** (4:5 Portrait): 6 briefs
- **1080×1080** (1:1 Square): 6 briefs
- **1080×1920** (9:16 Mobile Story): 4 briefs
- **1240×1754** (A4 Portrait): 4 briefs
- **1920×1080** (16:9 Landscape Screen): 4 briefs

### Brief Registry Table

| Brief ID | Name | Lang | Format | Aspect Label | Subset / Origin |
|---|---|---|---|---|---|
| `golden-01` | KAAE Annual Accreditation Symposium 2026 | EN | 1080×1350 | 4:5 Portrait | `compare-01` |
| `golden-02` | Institutional Accreditation Standard 2026 | EN | 1080×1080 | 1:1 Square | `compare-02` |
| `golden-03` | Higher Education Leadership Forum | EN | 1080×1920 | 9:16 Story | `compare-03` |
| `golden-04` | National Accreditation Council Session | EN | 1240×1754 | A4 Portrait | `compare-04` |
| `golden-05` | Global Education Quality Summit Screen | EN | 1920×1080 | 16:9 Screen | `compare-05` |
| `golden-06` | Kurdish Academic Conference Invitation | CKB | 1080×1350 | 4:5 Portrait | `compare-06` |
| `golden-07` | Kurdish Accreditation Announcement | CKB | 1080×1080 | 1:1 Square | `compare-07` |
| `golden-08` | Kurdish Quality Assurance Workshop Story | CKB | 1080×1920 | 9:16 Story | `compare-08` |
| `golden-09` | Bilingual Academic Symposium Invitation | MIXED | 1080×1350 | 4:5 Portrait | `compare-09` |
| `golden-10` | Bilingual Accreditation Board Convening | MIXED | 1240×1754 | A4 Portrait | `compare-10` |
| `golden-11` | KAAE Quality Assurance Executive Briefing | EN | 1080×1350 | 4:5 Portrait | Golden expansion |
| `golden-12` | KAAE Institutional Review Board Forum | EN | 1080×1080 | 1:1 Square | Golden expansion |
| `golden-13` | Higher Education Fellowship Announcement | EN | 1080×1920 | 9:16 Story | Golden expansion |
| `golden-14` | KAAE Strategic Curriculum Framework Release | EN | 1240×1754 | A4 Portrait | Golden expansion |
| `golden-15` | Academic Leadership Masterclass Keynote | EN | 1920×1080 | 16:9 Screen | Golden expansion |
| `golden-16` | University Governance Summit 2026 | EN | 1080×1350 | 4:5 Portrait | Golden expansion |
| `golden-17` | KAAE Doctoral Program Standards Announcement | EN | 1080×1080 | 1:1 Square | Golden expansion |
| `golden-18` | Kurdish Accreditation Standards Manual Notice | CKB | 1240×1754 | A4 Portrait | Golden expansion |
| `golden-19` | Kurdish Higher Education Plenary Presentation | CKB | 1920×1080 | 16:9 Screen | Golden expansion |
| `golden-20` | Kurdish Institutional Evaluation Workshop | CKB | 1080×1350 | 4:5 Portrait | Golden expansion |
| `golden-21` | Kurdish Academic Excellence Forum | CKB | 1080×1080 | 1:1 Square | Golden expansion |
| `golden-22` | Kurdish University Quality Delegate Briefing | CKB | 1080×1920 | 9:16 Story | Golden expansion |
| `golden-23` | Bilingual Quality Benchmark Round Table | MIXED | 1080×1080 | 1:1 Square | Golden expansion |
| `golden-24` | Bilingual International Academic Exchange Screen | MIXED | 1920×1080 | 16:9 Screen | Golden expansion |

---

## 2. Evaluation Harness Architecture

The evaluation harness is implemented under `packages/evals/src/design-studio/`:

1. **`types.ts`**: Complete type contracts for briefs, run results, reports, canary judgments, tournament results, parity results, and bootstrap confidence intervals.
2. **`loader.ts`**: Loads and strictly validates all golden briefs and comparison subsets. Validates non-empty copy, contiguous 0-indexed copy blocks, and script tagging (`latin` vs `arabic`).
3. **`offline-runner.ts`**: End-to-end deterministic runner exercising all 10 pipeline stages:
   - Brief generation (P1)
   - Concept proposals (P2)
   - StudioLayoutV2 layout synthesis (P3)
   - Render & Hard QA v2 validation (`validateLayoutV2`)
   - Critic rubric scoring (P4)
   - Layout revision (P5)
   - Position-bias controlled tournament with order swap (P6)
   - Dual-perturbation canary check (P6)
   - Editable PPTX transfer v2 and Canva check (`checkCanvaPptx`)
   - Degradation ladder rungs (Rung 1 Opus fallback, Rung 2 procedural motif fallback, Rung 3 judge unavailable, Rung 4 single-shot planner fallback)
   - Hard budget cap enforcement (`BUDGET_EXHAUSTED` with best-so-far candidate recovery)
4. **`live-runner.ts`**: Live driver that executes requests against the running Hawa Core API (`POST /v1/tasks/:taskId/canva/studio` and `resume`), tracking ledger spend, receipts, and Canva design bindings.
5. **`report-generator.ts`**: Generates structured `report.json` and human-readable `report.md` comparing run metrics directly against thresholds D1–D8.
6. **`ratings-intake.ts`**: Parses `human-ratings.csv`, calculates blind preference rate (v2 vs v1), Spearman rank correlation $\rho$, judge pairwise agreement, and 10,000-sample bootstrap 95% confidence intervals.
7. **`blind-pairs.ts`**: Packages the 10 comparison pairs into randomized blind pairs (`<pairId>-L.png`, `<pairId>-R.png`) with a sealed `pair-key.json` and human ratings intake CSV template.

---

## 3. Test Evidence

Executed via `vitest run packages/evals/test/design-studio-eval.test.ts`:

```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign/packages/evals

 ✓ test/design-studio-eval.test.ts (9 tests) 144ms
   ✓ loads and validates all 24 golden briefs with exact language and format breakdown
   ✓ verifies the 10 compare briefs are an exact subset
   ✓ runs the offline runner through all stages on an authentic brief
   ✓ correctly simulates and records degradation ladder rungs
   ✓ enforces budget cap and terminates stage with honest BUDGET_EXHAUSTED
   ✓ handles canary failure by flagging judge as UNRELIABLE
   ✓ processes human ratings intake with bootstrap 95% confidence intervals and Spearman correlation
   ✓ packages blind pairs and generates a sealed pair key
   ✓ runs all 24 briefs through the offline runner and generates report

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Duration  740ms
```

### Full Repository Gate Results
- `pnpm typecheck`: Clean (0 errors)
- `pnpm test`: 127 passed, 2 skipped (964 passed, 12 skipped)
- `pnpm security:scan`: 0 secrets detected
- `python3 scripts/validate_pack.py`: PASS=515 WARN=0 FAIL=0
