# P01 — Deterministic Design Metrics Calibration & Proof

**Date:** 2026-09-17
**Repository Branch:** `studio-v2`
**Specification:** arXiv:2402.06945 (Computational Aesthetics), LaySPA composite scoring, WCAG 2.1 AA legibility.

## 1. Validity Statement

> **Empirical Validity:** Computational aesthetic measures correlate with human judgement at about $\rho = 0.68$, rising to $\rho = 0.74$ on structured compositions, which is our case. That is enough to gate on and not enough to decide by; the owner's blind preference in P10 remains the arbiter.

## 2. Fixture Split (2026-09-17 Owner Review)

Per Art Director review recorded in `packages/creative/assets/kaae-exemplars.json`:
- **Positive Fixtures (6):** Exactly the six owner-confirmed exemplars. All six calibrate in the top band (composite $\ge 0.80$) with 0 failing metrics.
- **Negative Fixtures (6):** Exactly the six dropped review entries. All six must fail the deterministic gate on their specific named defects.

## 3. Calibration Table: Six Confirmed Exemplars (Positive Fixtures)

| Metric | Quality Weight | Ex 1 (post1) | Ex 2 (post2) | Ex 3 (post3) | Ex 4 (AUK) | Ex 5 (CC) | Ex 6 (CUE) | Mean |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Text Legibility (WCAG 2.1 AA)** | 0.12 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Grid Appropriateness** | 0.12 | 0.917 | 1.000 | 0.833 | 1.000 | 1.000 | 1.000 | **0.958** |
| **Alignment (arXiv 2402.06945)** | 0.12 | 0.792 | 0.901 | 0.999 | 0.999 | 1.000 | 1.000 | **0.949** |
| **Balance (arXiv 2402.06945)** | 0.12 | 0.943 | 0.944 | 0.960 | 0.906 | 0.921 | 0.921 | **0.933** |
| **Justification (arXiv 2402.06945)** | 0.08 | 0.750 | 0.750 | 0.950 | 0.950 | 0.950 | 0.950 | **0.883** |
| **Regularity (arXiv 2402.06945)** | 0.08 | 0.671 | 0.615 | 0.648 | 0.552 | 0.570 | 0.570 | **0.604** |
| **Typeface Pairing (F12 Admitted)** | 0.08 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Negative Space Distribution** | 0.08 | 0.950 | 0.950 | 0.970 | 0.950 | 0.950 | 0.950 | **0.953** |
| **Semantic Layout Hierarchy** | 0.08 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Semantic Typography Hierarchy** | 0.08 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Occlusion / Calm Region** | 0.02 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Type-Scale Conformance** | 0.02 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Candidate Degeneracy Check** | Gate | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | **1.000** |
| **Composite Score** | **1.00** | **0.926** | **0.941** | **0.952** | **0.956** | **0.958** | **0.958** | **0.949** |
| **Gate Result** | - | PASS | PASS | PASS | PASS | PASS | PASS | **100% PASS** |
| **Execution Time** | - | 0.72ms | 0.20ms | 0.37ms | 0.09ms | 0.11ms | 0.05ms | **0.26ms** |

## 4. Dropped Review Entries (Negative Fixtures)

All 6 dropped entries from `droppedInReview` fail the deterministic gate on their specific defect:

| Fixture | Former Rank | Expected Defect | Gate Result | Flagged Metrics | Diagnostic Reason |
| :--- | :---: | :--- | :---: | :--- | :--- |
| **KAAE_Commences_2026_Cycle_1080x1350 (Dropped: Circular & Low Contrast Footer)** | - | `textLegibility` | **FAILED (BLOCKED)** | `textLegibility, regularity` | {"failingIssues":["Text 2 (footer) contrast 3.81:1 < 4.5:1"],"count":3} |
| **kaae 5 kurdi (Dropped: Photograph of officials with caption bar)** | - | `semanticLayout` | **FAILED (BLOCKED)** | `gridAppropriateness, negativeSpace, semanticLayout, semanticTypography` | "Lacks primary title/headline hierarchy — photograph with caption bar cannot establish institutional composition" |
| **call for kurdi (Dropped: Large dead area / excessive void)** | - | `regularity` | **FAILED (BLOCKED)** | `regularity` | "EXCESSIVE_DEAD_AREA: Vertical gap exceeds 25% canvas height without composition" |
| **image16 (Dropped: 16:9 PowerPoint slide)** | - | `gridAppropriateness` | **FAILED (BLOCKED)** | `gridAppropriateness` | "WRONG_CANVAS_GENRE: 16:9 presentation slide aspect ratio rejected for social/announcement canvas (admitted: 1:1, 4:5, 9:16)" |
| **image17 (Dropped: 16:9 PowerPoint slide)** | - | `gridAppropriateness` | **FAILED (BLOCKED)** | `gridAppropriateness` | "WRONG_CANVAS_GENRE: 16:9 presentation slide aspect ratio rejected for social/announcement canvas (admitted: 1:1, 4:5, 9:16)" |
| **image19 (Dropped: 16:9 PowerPoint slide)** | - | `gridAppropriateness` | **FAILED (BLOCKED)** | `gridAppropriateness` | "WRONG_CANVAS_GENRE: 16:9 presentation slide aspect ratio rejected for social/announcement canvas (admitted: 1:1, 4:5, 9:16)" |

## 5. Known-Bad Layout Gating Proof

The deterministic gate was verified against the 3 representative audit failure modes from 2026-09-15/16 audits.

| Case | Target Defect | Composite Score | Gate Result | Failing Metrics Flagged | Execution Time |
| :--- | :--- | :---: | :---: | :--- | :---: |
| **Known-Bad 1 (Off-Grid Bilateral Collapse)** | `gridAppropriateness` | 0.788 | **FAILED (BLOCKED)** | `gridAppropriateness, regularity` | 0.06ms |
| **Known-Bad 2 (Low Contrast Royal/Midnight Navy)** | `textLegibility` | 0.741 | **FAILED (BLOCKED)** | `textLegibility, negativeSpace, semanticLayout, semanticTypography` | 0.02ms |
| **Known-Bad 3 (Boxy Bilateral Grid DAHVV23EF_8)** | `typefacePairing` | 0.743 | **FAILED (BLOCKED)** | `gridAppropriateness, typefacePairing` | 0.04ms |

## 6. Degeneracy Detection Proof

- **Degenerate Candidate Set Test (3 near-identical layouts, mean geometric distance < 15px):**
  - **Result:** Degenerate = `true` (Correctly flagged)
  - **Pairwise Distances:** [1,0.5,1.21] px
  - **Reason:** Pairwise geometric distance (0.5px) indicates near-identical candidates
  - **Execution Time:** 0.04ms

- **Non-Degenerate Candidate Set Test (Diverse 3 layouts from confirmed exemplars):**
  - **Result:** Degenerate = `false` (Correctly accepted)
  - **Pairwise Distances:** [294.13,241.4,226.79] px

## 7. Performance and Runtime Invariants

- **Average Metric Evaluation Time:** 0.26ms per layout (< 50ms requirement)
- **Total Wall Time for 6 Exemplars:** 2.19ms
- **External Network / API Calls:** Exactly 0
- **Cost:** $0.0000
