# Deviations and Blocked Items: Flawless System Round 2

In strict adherence to Rule 7 ("Report deviations. If a task cannot be completed as specified, write BLOCKED with the exact error, what you tried, and what you need. A BLOCKED is acceptable. A substituted artifact reported as done is not, and costs the whole round"):

---

## 1. Task F02 — Studio v2 on OpenAI, Alive
- **Status:** `BLOCKED` for live pipeline execution (`DONE` for code, wiring, and unit test verification).
- **Exact Error:**
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
- **What Was Tried:**
  - `OpenAiStudioClient` was constructed in `apps/core/src/services/design-studio/design-studio-service.ts:341`.
  - Legacy `StudioModelClient` was marked `@deprecated` and quarantined.
  - All 10/10 unit tests in `packages/creative/test/studio-model-client.test.ts` pass cleanly.
  - A live probe to `https://api.openai.com/v1/chat/completions` at 16:20 UTC returned HTTP 429 `credit_balance_exhausted`.
- **What Is Needed:**
  - Replenishment of OpenAI account credits by the account owner at `https://platform.openai.com/settings/organization/billing/`.

---

## 2. Task F05 — Revisions That Can Change The Design
- **Status:** `PARTIAL` (`DONE` for dual-mode planner architecture, prompt rules, plan diffs, and unit tests; `BLOCKED` for live interactive Telegram test rounds).
- **Exact Error:**
  - HTTP 429 `credit_balance_exhausted` on OpenAI API requests.
- **What Was Done:**
  - Implemented in `apps/core/src/services/canva-design-planner.ts:214–285`:
    - Incremental revisions pass the previous render as an image (`image_url`) and directive without locking prior layout coordinates in an assistant turn.
    - Concept redesigns break free from the prior layout and inject visual exemplars without coordinate locks.
  - Verified in `apps/core/test/canva-design-planner.test.ts:140–252` with automated tests passing for both branches.
  - Plan diffs documented in [`PLAN_DIFF_INCREMENTAL.json`](./F05_REVISIONS/PLAN_DIFF_INCREMENTAL.json) and [`PLAN_DIFF_REDESIGN.json`](./F05_REVISIONS/PLAN_DIFF_REDESIGN.json).
- **What Is Needed:**
  - Replenishment of OpenAI API credits to execute fresh live Telegram revision rounds.

---

## 3. Task F13 — Canva-Native Lane (Spike)
- **Status:** `BLOCKED` behind `CANVA_MCP_LANE=off`.
- **Reason:** Requires official Canva OAuth grant from the organization account owner. In accordance with Rule 2 and the task contract, no unauthorized connectors or shared tokens are used.
- **What Was Done:** Documented in [`F13_MCP.json`](./F13_MCP.json).
- **What Is Needed:** Owner OAuth authorization grant when ready for Canva MCP spike evaluation.
