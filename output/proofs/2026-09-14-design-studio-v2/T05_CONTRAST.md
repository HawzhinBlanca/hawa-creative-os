# T05 Proof: Composite p05 Contrast Evaluation Engine

- **Date / Timestamp**: 2026-09-14T09:38:00Z (12:38:00 local)
- **Branch**: `studio-v2`
- **Component**: `@hawa/creative` (`src/studio/composite-contrast.ts`, `test/studio-contrast.test.ts`)

---

## 1. Specification & Methodology

Section 5.2 and 5.3 of `GEMINI_TASK_SHEET.md` define the deterministic contrast requirement:
- Contrast is computed directly against the pixels of the rendered **no-text composite PNG** (1× canvas pixels).
- Rather than taking an average or center-point sample, the engine computes WCAG 2.1 relative luminance and contrast ratio for every pixel in the text box bounding box and sorts them in ascending order.
- The **5th-percentile (p05)** ratio is selected:
  $$\text{p05} = \text{sortedRatios}[\lfloor 0.05 \times N \rfloor]$$
- This guarantees that 95% of the background area behind the text block achieves or exceeds the contrast threshold, preventing text from washing out against background textures, noisy gradients, or dark imagery.
- **Thresholds**:
  - Regular text / body copy: $\ge 4.5:1$
  - Large text ($\ge 32\text{px}$ or $\ge 24\text{px}$ bold): $\ge 3.0:1$

---

## 2. Quantitative Verification Results

### Test Case 1: Dark-on-Dark Adversarial Failure
- **Background**: KAAE Midnight Navy (`#0A1628`, relative luminance $L_{bg} \approx 0.008$)
- **Text**: KAAE Royal Navy (`#1E3A5F`, relative luminance $L_{fg} \approx 0.038$), fontSize 18px body copy
- **Measured Numbers**:
  - Minimum contrast: **1.58:1**
  - Median contrast: **1.58:1**
  - **p05 contrast**: **1.58:1** (Required: $\ge 4.5:1$)
- **Server Validator Verdict**: Hard-fails with error code `CONTRAST`:
  `Text contrast ratio 1.58:1 for copyIndex 0 is below required 4.5:1`

### Test Case 2: Scrim-Protected Passing Layout
- **Background**: Composite background protected by gradient scrim plate (`#0A1628`, opacity 0.85–0.95, effective background luminance $L_{bg} \approx 0.008$)
- **Title Text**: Kurdistan Sun Gold (`#F7B500`, relative luminance $L_{fg} \approx 0.495$), 44px bold
  - **p05 contrast**: **9.24:1** (Required: $\ge 3.0:1$)
  - **Verdict**: PASS
- **Body Text**: Academic Cream (`#FDF8F3`, relative luminance $L_{fg} \approx 0.949$), 20px regular
  - **p05 contrast**: **16.62:1** (Required: $\ge 4.5:1$)
  - **Verdict**: PASS
- **Server Validator Verdict**: All text blocks pass contrast audit (`ok: true`).

---

## 3. Test Suite Execution Output

```bash
pnpm vitest run packages/creative/test/studio-contrast.test.ts
```

```
 RUN  v4.1.11 /Users/hawzhin/Hawdesign

 ✓ packages/creative/test/studio-contrast.test.ts (3 tests) 765ms
     ✓ correctly calculates relative luminance and WCAG contrast ratios
     ✓ fails dark-on-dark text with low p05 contrast (< 4.5:1)
     ✓ passes when high-contrast text and scrim plate are applied (p05 >= 4.5:1)

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  12:38:19
   Duration  950ms
```

---

## 4. Monorepo Quality Gates Verification

- **`pnpm --filter @hawa/creative build`**: Exit 0.
- **`pnpm typecheck`**: Exit 0 across all packages.
- **`pnpm test`**: 119 test files passed (862 passed, 12 skipped, 0 failed).
- **`pnpm security:scan`**: 0 secrets in committable files.
- **`python3 scripts/validate_pack.py`**: PASS=511 WARN=0 FAIL=0.
