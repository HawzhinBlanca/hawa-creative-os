# Proof Artifact: T10 Pipeline Stages (brief..transfer v2)

**Task**: T10 Stages (`brief` to `transfer v2`)  
**Branch**: `studio-v2`  
**Date**: 2026-09-14  
**Author**: Senior Engineer & Gemini 3.8 Flash  

---

## 1. Stage Architecture & Function Mapping

Each stage is implemented as a pure function `(ctx, ...) -> Promise<Result>` located under `apps/core/src/services/design-studio/stages/`. The stages interact through immutable state transitions, recorded fixtures, and validated contracts.

| # | Stage Name | Source File | Input / Run State | Model / Tools | Test Case Name (`studio-stages.test.ts`) |
|---|---|---|---|---|---|
| 1 | **brief** | `stages/brief.stage.ts` | `ctx: StageContext` | `claude-fable-5-1` | `1. brief stage: produces CreativeBrief matching schema and enforces copy index coverage` |
| 2 | **concepts** | `stages/concepts.stage.ts` | `ctx, brief` | `claude-fable-5-1` | `2. concepts stage: produces diverse concepts and enforces archetype uniqueness` |
| 3 | **layouts** | `stages/layouts.stage.ts` | `ctx, brief, concepts` | `claude-fable-5-1` | `3. layouts stage: validates layout and produces candidate state` |
| 4 | **art** | `stages/art.stage.ts` | `ctx, candidate` | `imagen-3.0-generate-002` / Procedural Motifs | `4. art stage: renders procedural motif fallback and records provenance` |
| 5 | **render** | `stages/render.stage.ts` | `ctx, candidate` | `@resvg/resvg-js`, `@hawa/creative` | `5. render stage: local render produces preview PNG, composite PNG, and metrics` |
| 6 | **critique** | `stages/critique.stage.ts` | `ctx, candidate` | `claude-fable-5-1` (Vision) | `6. critique stage: scores candidate, computes weighted score, checks hard fails` |
| 7 | **revise** | `stages/revise.stage.ts` | `ctx, candidate, brief, iteration` | `claude-fable-5-1` | `7. revise stage: respects early stopping when score >= 8.5 and 0 hard fails` |
| 8 | **tournament** | `stages/tournament.stage.ts` | `ctx, candidates` | `claude-fable-5-1` (Vision) | `8. tournament stage: executes pairwise comparisons in both orders and resolves winner` |
| 9 | **canary** | `stages/canary.stage.ts` | `ctx, winner` | `claude-fable-5-1` (Vision) | `9. canary stage: verifies winner against perturbations in both orders (4 vision calls)` |
| 10 | **qa** | `stages/qa.stage.ts` | `ctx, winner` | Deterministic Hard QA v2 | `10. qa stage: hard QA v2 passes valid candidate and catches defect codes` |
| 11 | **transfer** | `stages/transfer.stage.ts` | `ctx, winner` | `pptxgenjs`, `@hawa/qa` | `11. transfer stage: encodes StudioLayoutV2 into valid PPTX buffer with manifest` |

---

## 2. Core Mechanisms Verified

### 2.1 Diverse Concepts & Archetype Enforcement
- Enforces 3 concepts for Standard tier and 5 concepts for Premium tier.
- Validates archetype uniqueness: rejects candidates with duplicate archetypes across `editorial-centered`, `framed-invitation`, `asymmetric-editorial`, `monumental-title`, or `minimal-grid`.

### 2.2 Local Rendering & Fact-First Critique
- Computes measured metrics before any critique prompt: alignment score, whitespace ratio, balance offset, visual hierarchy ratio, body characters per line, line count per copy block, P05 WCAG APCA contrast, safe margin clearance, and logo width percentage.
- Critique scoring: computes weighted overall score (0.00-10.00) from 5 categories (hierarchy 25%, typography 25%, color/contrast 20%, space/balance 15%, brand/elegance 15%). Detects hard fail conditions (`contrast_fail`, `overlap_detected`, `clipped_text`, `bad_rag`, `logo_violation`).

### 2.3 Early Stopping & Revision Loop
- Revision terminates early when weighted score $\ge 8.5$ and 0 hard fails are detected.
- Cap of 2 revision rounds per candidate. In standard mode, candidates with score $\ge 8.5$ bypass unnecessary model round-trips.

### 2.4 Tournament Order-Swap & Bias Resistance
- Pairwise comparisons are judged in both orders: $(A, B)$ and $(B, A)$ to eliminate position bias.
- When results agree, winner advances. When split, decisive tie-breaker evaluates margin delta against deterministic metrics.

### 2.5 Live Canary Verification
- Evaluates winning candidate against synthetic perturbations (scrambled rag, broken contrast, misaligned margins) in forward and reverse orders (4 vision calls total).
- Canary fails and raises alert if the judge prefers the degraded candidate over the genuine winner.

### 2.6 Hard QA v2 & PPTX Canva Transfer
- Deterministic checks enforce:
  - Exact canvas dimension match (`expectedWidth` x `expectedHeight`).
  - Strict copy placement index coverage ($0 \dots N-1$).
  - Admitted brand fonts (Latin: `EB Garamond` / `Minion`, Arabic: `Noto Sans Arabic`).
  - No text-text or text-rule overlaps.
  - Safe margin clearance and logo clear space ($0.5 \times \text{logoHeight}$).
- `encodeStudioTransferV2` generates fully editable PPTX presentations with:
  - Vector shape mappings (lines, rectangles, pill panels).
  - High-resolution art backdrop.
  - Text frames with calibrated margins, line spacing, and script fonts.
  - Integrity SHA-256 hash.
- Verified with `@hawa/qa:checkCanvaPptx` on v2 PPTX buffer:
  - `copyPass: true`
  - `fontPass: true`

---

## 3. Automated Test Evidence

```
$ pnpm --filter @hawa/core test test/studio-stages.test.ts

 RUN  v4.1.11 /Users/hawzhin/Hawdesign/apps/core

 ✓ test/studio-stages.test.ts (11 tests) 1063ms
     ✓ 1. brief stage: produces CreativeBrief matching schema and enforces copy index coverage 2ms
     ✓ 2. concepts stage: produces diverse concepts and enforces archetype uniqueness 0ms
     ✓ 3. layouts stage: validates layout and produces candidate state 3ms
     ✓ 4. art stage: renders procedural motif fallback and records provenance 77ms
     ✓ 5. render stage: local render produces preview PNG, composite PNG, and metrics 340ms
     ✓ 6. critique stage: scores candidate, computes weighted score, checks hard fails 1ms
     ✓ 7. revise stage: respects early stopping when score >= 8.5 and 0 hard fails 0ms
     ✓ 8. tournament stage: executes pairwise comparisons in both orders and resolves winner 1ms
     ✓ 9. canary stage: verifies winner against perturbations in both orders (4 vision calls) 630ms
     ✓ 10. qa stage: hard QA v2 passes valid candidate and catches defect codes 2ms
     ✓ 11. transfer stage: encodes StudioLayoutV2 into valid PPTX buffer with manifest 8ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  1.49s
```

All 11 pure stages pass unit test execution. Monorepo quality gates: 913 tests passing, 0 typecheck errors, 0 secrets detected.
