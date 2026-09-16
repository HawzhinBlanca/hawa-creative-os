# P04 — Art Layer Conditioned on Layout Proof

**Date:** 2026-09-17  
**Model:** `gpt-image-2.5-sunburst` (OpenAI image generation, conditioned on editable layout)  
**Specification:** CreatiPoster (arXiv:2506.10890), Section 5.4 / P7 Art Rules, Calm Region Invariant  

---

## 1. Summary of Execution

- **Art Layers Generated:** 2 layout-conditioned art layers (1:1 square, 4:5 vertical portrait).
- **P01 Gate Status:** Both layouts passed P01 deterministic design metrics prior to calling image generation.
- **Provider Status:** 2 / 2 generated via `gpt-image-2.5-sunburst` (0 procedural fallbacks required).
- **Quality & Size:** `quality: 'medium'`, sizes derived from canvas geometry (1024x1024 and 1024x1536).
- **Calm Region Invariant:** Measured pixel luminance and variance prove the calm typography region is **both darker and lower-variance** than the outer perimeter on both layers.
- **Occlusion Metric:** 100% pass rate (text boxes sit cleanly within the declared calm region).
- **Composite Contrast:** 100% pass rate across all text boxes (all text boxes exceed 4.5:1 WCAG AA contrast).

---

## 2. API Receipts & Token Accounting

| Art Layer | Model | Response ID / Request ID | Image Tokens | Cost (USD) | Latency |
| :---: | :--- | :--- | :---: | :---: | :---: |
| **Art Layer 1 (1:1 Square)** | `gpt-image-2.5-sunburst` | `req_97aded1216e042628a96ae3f4bcfb49b` | 439 | $0.01317 | 15200ms |
| **Art Layer 2 (4:5 Portrait)** | `gpt-image-2.5-sunburst` | `req_67072d6216d34f72ad0f09d6d2f71ba1` | 343 | $0.01029 | 13908ms |

---

## 3. Calm Region Measurements (Invariants Verification)

| Layer | Region | Mean Luminance ($L$) | Variance ($sigma^2$) | Std Dev ($sigma$) | Calm Darker? | Calm Lower Variance? |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **Layer 1 (1:1)** | **Calm Region** | **0.01321** | **0.000081** | 0.009 | **PASS (True)** | **PASS (True)** |
| Layer 1 (1:1) | Outer Canvas | 0.02378 | 0.00143 | 0.03781 | - | - |
| **Layer 2 (4:5)** | **Calm Region** | **0.00948** | **0.000995** | 0.03154 | **PASS (True)** | **PASS (True)** |
| Layer 2 (4:5) | Outer Canvas | 0.02066 | 0.003923 | 0.06263 | - | - |

---

## 4. Composite Contrast & Occlusion Results

| Layer | Occlusion Score | Occlusion Result | Composite Contrast Result | p05 Contrast by Box (copyIndex) |
| :---: | :---: | :---: | :---: | :--- |
| **Layer 1** | 1.000 | **PASS** | **PASS (100% $ge 4.5:1$)** | Box 0: 4.88:1, Box 1: 17.48:1, Box 2: 17.48:1, Box 3: 12.12:1, Box 4: 12.12:1, Box 5: 12.12:1, Box 6: 7.24:1 |
| **Layer 2** | 1.000 | **PASS** | **PASS (100% $ge 4.5:1$)** | Box 0: 17.18:1, Box 1: 7.38:1, Box 2: 17.18:1, Box 3: 17.16:1 |

---

## 5. Artifacts Produced

- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/art_01.png`
- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/composite_01.png`
- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/layout_with_art_01.json`
- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/art_02.png`
- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/composite_02.png`
- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/layout_with_art_02.json`
- `output/proofs/2026-09-17-research-grade-pipeline/P04_ART/RECEIPTS.json`
