# TASK: T5 — Qualify the whole pipeline, not one stage

## STATUS: BLOCKED ON LIVE BILLING (Code & Full-Pipeline Engine Implemented & Verified)

## COMMITS
- Pipeline & Runner Implementation:
  - `packages/creative/src/studio/box-critique-v3.ts`: Added `cachedTokens` tracking to vision critique receipt.
  - `packages/creative/src/studio/pairwise-judge-v3.ts`: Added `cachedTokens` tracking to pairwise judge order comparison receipt.
  - `scripts/run_p10_qualification.ts`: Completely rewritten to execute the full multi-stage pipeline:
    1. Retrieval (P02) via `ExemplarRetrievalIndex`
    2. Layout Candidate Generation (P03) via `generateLayoutCandidatesV3` (emitting `P03_LAYOUT` ledger rows)
    3. Box-Grounded Vision Critique (P05) via `generateBoxGroundedCritique` with Set-of-Mark debug overlay and deterministic facts (emitting `P05_CRITIQUE` ledger rows)
    4. Gated Refinement (P06) via `refineCandidate` when metrics fail (emitting `P06_REFINE` ledger rows)
    5. Order-Swapped Pairwise LLM Judge (P07) via `comparePairWithOrderSwap` evaluating presentation order AB and BA (emitting `P07_JUDGE_AB` and `P07_JUDGE_BA` ledger rows)
    6. Real Degraded Canary Defeat (P07) via `evaluatePairOrder(winner, canaryCandidate, 'AB')` where winner must beat the degraded canary by majority vote across the 5 judge dimensions (emitting `P07_CANARY` ledger rows)
    7. Multi-Row Ledger emitting at least 5 rows per brief (100+ rows across 20 briefs) with completion ID, request ID, tokens, cached tokens, and exact recomputed microdollar costs.
    8. Per-brief journals (`JOURNALS/brief_XX.json` and `.md`) recording full dimension votes and critique feedback.
- Automated Integration Gate:
  - `packages/creative/test/full-pipeline-qualification.test.ts`: Verifies complete multi-stage execution, Set-of-Mark critique, order-swapped judge, real canary defeat, and multi-row ledger math (100% green).

---

## PROOF

### 1. Integration Verification Evidence
Executed `vitest run test/full-pipeline-qualification.test.ts`:
```
 ✓ test/full-pipeline-qualification.test.ts (1 test) 2280ms
   ✓ T5 Full Pipeline Qualification Path (1)
     ✓ runs complete multi-stage pipeline: retrieval, critique, order-swapped judge, and canary defeat (2279ms)

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  19:42:10
   Duration  2.74s
```

All 33 test files in `@hawa/creative` (205 tests) and all workspace builds (`pnpm -r build`) pass cleanly.

### 2. Live Provider Execution Transcript
Executed live runner: `npx tsx scripts/run_p10_qualification.ts`
```
=== Starting P10 Genuine Live Qualification Run (20 Held-Out Briefs) ===
[Cost Governor] Active Caps: Per-Brief = $1.00 | Office Daily = $30.00

--- Dispatching Batch 1/10 (brief_01_en_square, brief_02_en_square) ---
[P10 LIVE] Starting Brief 1/20: brief_01_en_square (Square)...
[P10 LIVE] Starting Brief 2/20: brief_02_en_square (Square)...
P10 Qualification Runner Failed: OpenAiModelHttpError: Model API returned HTTP 429: {
    "error": {
        "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        "type": "insufficient_quota",
        "param": null,
        "code": "credit_balance_exhausted"
    }
}
    at OpenAiStudioClient.createStructuredCompletion (/Users/hawzhin/Hawdesign/packages/creative/src/studio/openai-studio-client.ts:274:19)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async generateLayoutCandidatesV3 (/Users/hawzhin/Hawdesign/packages/creative/src/studio/layout-generator-v3.ts:853:5)
    at async executeBriefLive (/Users/hawzhin/Hawdesign/scripts/run_p10_qualification.ts:454:21)
    at async Promise.all (index 1)
    at async main (/Users/hawzhin/Hawdesign/scripts/run_p10_qualification.ts:879:26)
```

### 3. Direct Provider Billing Verification
```bash
$ curl -s https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```
Returns:
```json
{
    "error": {
        "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        "type": "insufficient_quota",
        "param": null,
        "code": "credit_balance_exhausted"
    }
}
```

---

## LIVE IDS
- Full-Pipeline Qualification Runner: `scripts/run_p10_qualification.ts`
- Automated Pipeline Test Suite: `packages/creative/test/full-pipeline-qualification.test.ts`
- Destination Target: `output/proofs/2026-09-17-research-grade-pipeline/T5_FULL_QUALIFICATION/`

---

## DEVIATIONS
- None in code or architecture. The full multi-stage pipeline is completely wired and verified with integration tests.
- Live qualification run cannot complete across the 20 held-out briefs until the user restores API credits on the OpenAI billing account (`credit_balance_exhausted`). Per user instructions (`synthesis/how-hawzhin-works.md`), this is documented explicitly rather than simulated with mock data.

---

## WHAT I DID NOT DO
- Did not fabricate synthetic ledger rows, fake token counts, or artificial request IDs.
- Did not reduce the judge back to `Math.sign()` over composite scores; the judge is wired to real pairwise dimension-wise comparisons with order swapping and LLM canary defeat.
- Did not skip the vision critique or Set-of-Mark visual annotation stage.
