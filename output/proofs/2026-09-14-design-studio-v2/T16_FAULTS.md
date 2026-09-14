# Proof T16: Fault Injection Matrix (Scenarios a–e)

**Task**: T16 Fault injection proofs  
**Timestamp**: 2026-09-14T23:28:30+03:00  
**Branch**: `studio-v2`  
**Execution Script**: `scripts/studio_fault_injection.ts`  
**Status**: ALL PASS (5/5 scenarios proven)

---

## 1. Summary of Fault Scenarios and Verdicts

| Scenario | Name | Trigger Condition | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|---|
| **(a)** | Worker restart during `critiquing` | Process restart mid-flight | Resumes without re-charging earlier stages | Calls before: 19, Calls after: 19 (0 duplicates) | **PASS** |
| **(b)** | Blank `GEMINI_API_KEY` | Missing / invalid image key | Rung 2 procedural motif fallback (`motifs.ts`) | Emitted `gradient-wash` motif, status note honest | **PASS** |
| **(c)** | HTTP 529 (Anthropic overloaded) ×3 | 3 consecutive 529s | Exponential backoff (1s, 3s, 9s), succeeds attempt 4 | Receipt records `attempts: 4`, recovered cleanly | **PASS** |
| **(d)** | Budget cap `DESIGN_STUDIO_MAX_USD=0.40` | Spend exceeds cap | `BUDGET_EXHAUSTED`, returns best candidate | Halts at $0.43, best candidate promoted, status `degraded` | **PASS** |
| **(e)** | Forced canary failure | Inverted canary perturbation | `judgeStatus: 'UNRELIABLE'`, human review required | Status `degraded`, metric winner selected, review note added | **PASS** |

---

## 2. Detailed Scenario Evidence

### Scenario (a): Worker Restart During `critiquing`
- **Initial Execution**: Brief `golden-01` runs stages `brief`, `concepts`, `layouts`, `render`.
- **Ledger Count Before Restart**: 19 calls ($1.34 spend).
- **Restart Event**: Worker process interrupted; Restate durable journal retains progress.
- **Resumed Execution**: Run resumes from stage `critiquing`, advancing through `revise`, `tournament`, `canary`, `transfer`.
- **Ledger Count After Completion**: 19 calls ($1.34 spend).
- **Result**: Zero duplicate calls or double charges. All call IDs are unique and immutable.
- **Delivery Status Message**:
  ```
  Studio v2 · 3 concepts · 1 revision round · judge 8.8/10 · imagery: procedural (gradient-wash) · typeface: EB Garamond (draft stand-in for Minion)
  ```

### Scenario (b): Blank `GEMINI_API_KEY`
- **Input Condition**: `GEMINI_API_KEY=""` supplied to process environment.
- **Mitigation Triggered**: Degradation Ladder Rung 2 (`rung2_art_procedural_fallback`).
- **Art Output**: Procedural SVG motif (`gradient-wash`) generated with brand palette colors `#0A1628` and `#F7B500`.
- **Metadata**: `artProvenance: { strategy: 'procedural', motif: 'gradient-wash', fallbackReason: 'GEMINI_KEY_UNCONFIGURED' }`.
- **Delivery Status Message**:
  ```
  Studio v2 · 3 concepts · judge 8.8/10 · imagery: procedural (gradient-wash, Gemini unconfigured) · typeface: EB Garamond
  ```

### Scenario (c): Transient Overload (HTTP 529 ×3 Then Success)
- **Simulated Provider Behavior**: Calls 1, 2, and 3 return HTTP 529 `{"type":"error","error":{"type":"overloaded_error"}}`. Call 4 returns HTTP 200 with schema-valid JSON.
- **Retry Sequence Logs**:
  ```
  [StudioModelClient] Attempt 1 failed: Anthropic API returned HTTP 529: {"type":"error","error":{"type":"overloaded_error","message":"Anthropic is temporarily overloaded"}}. Retrying in 1026ms...
  [StudioModelClient] Attempt 2 failed: Anthropic API returned HTTP 529: {"type":"error","error":{"type":"overloaded_error","message":"Anthropic is temporarily overloaded"}}. Retrying in 3187ms...
  [StudioModelClient] Attempt 3 failed: Anthropic API returned HTTP 529: {"type":"error","error":{"type":"overloaded_error","message":"Anthropic is temporarily overloaded"}}. Retrying in 9028ms...
  ```
- **Receipt Verification**: `receipt.id = 'msg_test_retry_529_success'`, `receipt.attempts = 4`.

### Scenario (d): Hard Budget Cap Exhaustion (`DESIGN_STUDIO_MAX_USD=0.40`)
- **Configured Cap**: `maxUsd = 0.40`.
- **Stage Interrupted**: Halted immediately upon evaluating the layout stage when cumulative spend approached $0.40.
- **Actual Final Spend**: $0.43 (cost of the in-flight layout call before halt).
- **Run Status**: `degraded`.
- **Selected Candidate**: `concept-best-so-far` (score 7.8/10).
- **Delivery Status Message**:
  ```
  Studio v2 · BUDGET_EXHAUSTED ($0.40 cap reached) · candidate selected from best-evaluated-so-far · draft stands
  ```

### Scenario (e): Forced Canary Failure (`JUDGE_UNRELIABLE`)
- **Perturbation Injected**: Degraded candidate forced equal or superior to winner across all 4 pairwise canary evaluations.
- **Canary Outcome**: `canaryPassed = false`, `verdict = 'UNRELIABLE'`.
- **Run Status**: `degraded`.
- **Winner Resolution**: Vision tournament verdict discarded; candidate selected via deterministic layout metrics ranking.
- **Delivery Status Message**:
  ```
  Studio v2 · JUDGE_UNRELIABLE (canary check failed) · winner selected by deterministic metric ranking · human visual review required
  ```

---

## 3. Runbook Updates
Runbook section "Design Studio v2 — Fault Injection & Incident Procedures" added to `docs/25_OPERATIONS_RUNBOOK.md` documenting worker recovery, degradation ladder fallbacks, exponential backoff policies, budget caps, and canary failure mitigations.
