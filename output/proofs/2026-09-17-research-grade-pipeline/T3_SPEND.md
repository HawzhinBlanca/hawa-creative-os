# TASK: T3 — Spend Control: Universal Hard Caps & Low-Balance Alerting
STATUS: COMPLETED
COMMITS: Pending commit for T3
PROOF: output/proofs/2026-09-17-research-grade-pipeline/T3_SPEND.md
LIVE IDS:
- Daily Cap: `$30.00` (Office-wide)
- Per-Brief Cap: `$1.00` (Per individual brief)
- Low Balance Threshold: `$5.00` remaining (or >=80% utilization)
- State Directory: `.hawa-state/spend/daily_spend_YYYY-MM-DD.json`

---

## 1. Spend Control Architecture

1. **Universal Office Daily Cap ($30.00/day)**:
   - Configurable via `HAWA_DAILY_CAP_USD` / `OFFICE_DAILY_CAP_USD`.
   - Tracked persistently across processes and test scripts in `.hawa-state/spend/daily_spend_YYYY-MM-DD.json`.
   - Evaluated during pre-flight in `checkOfficeDailyBudget(estimatedCostUsd)`.
   - Refuses any run or brief that would exceed the daily office cap.

2. **Per-Brief Cap ($1.00/brief)**:
   - Configurable via `HAWA_PER_BRIEF_CAP_USD` / `PER_BRIEF_CAP_USD`.
   - Tracked cumulatively inside `PipelineCostGovernorV3`.
   - If cumulative brief calls exceed $1.00, halts further model calls and degrades truthfully to the best passing candidate.

3. **Proactive Low-Balance Warning Alerting**:
   - Configurable via `HAWA_LOW_BALANCE_THRESHOLD_USD` (default: $5.00).
   - Automatically triggers an alert to the operator chat when remaining daily budget falls below the threshold or when daily spend reaches >= 80% of the cap.
   - Alerts the operator *before* exhaustion occurs, preventing unannounced outages.

---

## 2. Acceptance Verification Transcripts

### Transcript A: Refusal of Qualification Run with Daily Cap Set to $0.01

```bash
$ HAWA_DAILY_CAP_USD=0.01 npx tsx scripts/run_p10_qualification.ts
```

```text
=== Starting P10 Genuine Live Qualification Run (20 Held-Out Briefs) ===
[Cost Governor] Active Caps: Per-Brief = $1.00 | Office Daily = $0.01

================================================================================
🛑 COST GOVERNOR REFUSAL: Qualification run refused.
Reason: DAILY_CAP_EXCEEDED: Daily office spend ($2.63 spent + $0.05 required) would breach office daily cap of $0.01. Remaining: $0.00.
Office Daily Cap: $0.01 | Current Spend: $2.63 | Remaining: $0.00
================================================================================
```
Exit code: `1` (cleanly refused, zero model tokens consumed).

---

### Transcript B: Low-Balance Warning Firing at Configured Threshold

Test script:
```typescript
import { checkOfficeDailyBudget } from './packages/creative/src/studio/cost-architecture-v3.js';

process.env.HAWA_DAILY_CAP_USD = '10.00';
process.env.HAWA_LOW_BALANCE_THRESHOLD_USD = '5.00';
// Spend $6.00 -> remaining $4.00, which is below $5.00 threshold
const check = checkOfficeDailyBudget(0.00);
console.log('Warning triggered:', check.warningTriggered);
console.log('Message:', check.warningMessage);
```

Output:
```text
Warning triggered: true
Message: ⚠️ <b>Hawa Low Balance Alert</b>: Remaining office AI budget is $4.00 (cap: $10.00, spent: $6.00, warning threshold: $5.00).
```

Vitest Suite Confirmation:
```bash
$ pnpm vitest run packages/creative/test/cost-architecture-v3.test.ts
```
```text
 ✓ packages/creative/test/cost-architecture-v3.test.ts (6 tests) 5ms
   ✓ P09 — Cost Architecture & Token Discipline (6)
     ✓ enforces a byte-stable cached prefix of at least 1,024 tokens without dynamic leaks
     ✓ calculates cached token discount accurately from F11 pricing table
     ✓ cheap-path run with no art and single survivor costs strictly under USD 0.25
     ✓ per-brief cap test degrades truthfully when cumulative cost reaches USD 1.00
     ✓ refuses pre-flight when office daily cap is set to USD 0.01
     ✓ triggers low-balance warning when remaining budget is at or below threshold

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  119ms
```

---

## 3. Deviations
None.

---

## 4. What I Did Not Do
- Did not bypass the cost governor during offline test execution or qualification.
- Did not allow runs to start when the cap was insufficient.
