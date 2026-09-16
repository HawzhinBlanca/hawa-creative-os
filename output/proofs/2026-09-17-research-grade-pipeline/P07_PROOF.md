# P07 Proof: Pairwise Dimension-Wise Judge & Order-Swapping (arXiv:2604.22891)

## Overview
- **Model**: `gpt-6-astra` (Allowed model per `@hawa/domain`)
- **Dimensions**: `hierarchy`, `composition`, `typographic_craft`, `brand_fit`, `legibility`
- **Facts-First Grounding**: Prior to LLM reasoning, deterministic design metrics (P01 LaySPA/arXiv:2402.06945) are supplied as facts.
- **Position Bias Order-Swapping**: Every pair is judged in AB and BA order. Flip disagreements are recorded as ties and discarded.
- **Degraded-Copy Canary**: Deliberately corrupted copy candidate is pitted against authentic candidate; must lose in all 5 dimensions.
- **Single-Survivor Bypass**: When only 1 candidate survives P01, judge calls are bypassed (0 calls, $0.00 cost).

## Verification Results

### 1. Single-Survivor Bypass
- Candidate count: 1
- Calls made: **0**
- Cost: **$0.00**
- Bypass triggered: `true`

### 2. Multi-Candidate Tournament
- Candidates evaluated: `candidate_layout_01, candidate_layout_04`
- Tournament calls made: `4`
- Tournament cost: `$0.138400`
- Tournament winner: `candidate_layout_04`

### 3. Canary Test
- Canary candidate: `candidate_layout_04_canary_degraded`
- Canary lost: **true** (Authentic layout won)
- Dimension votes on canary:
  - **hierarchy**: Authentic winner (A)
  - **composition**: Authentic winner (A)
  - **typographic_craft**: Authentic winner (A)
  - **brand_fit**: Authentic winner (A)
  - **legibility**: Authentic winner (A)

Artifact: [`P07_JUDGE.json`](./P07_JUDGE.json)
