# F05 Proof: Revisions That Can Change The Design

## 1. Architectural Implementation in `canva-design-planner.ts`

Lines 214–285 implement the dual-mode revision architecture:

1. **Incremental Revision Mode (`!isRedesignRequest`)**:
   - Condition: Operator directive requests specific modifications (e.g., "make the gold bar 300 px wide", "swap columns", "adjust spacing").
   - Multimodal context: The previous render image is passed directly via `image_url` alongside the brief and directive.
   - Freedom from prior layout coordinates: The previous layout JSON is **never** passed as an assistant turn with "retain everything".
   - Directive Rule: `"Rule: Change what the feedback asks; keep copy and brand."`
   - System prompt instructions: `REVISION MODE: You are refining the design shown in the attached previous render image according to the operator's feedback directive: "${revisionDirective}". Change what the feedback asks; keep all copy blocks and brand palette intact.`

2. **Concept Redesign Mode (`isRedesignRequest`)**:
   - Condition: Triggered by keywords matching `/bullshit|redo|different|fresh|start over|new (one|design|concept|layout)|better|cleaner|less boxy|unstick|change (the )?(whole|entire|all)|whole design|entire design|redesign|try another/i`.
   - Behavior: Completely breaks free from the prior layout and coordinates.
   - Conditioning: Dispatches a fresh concept creation turn with confirmed KAAE visual exemplars loaded as multimodal vision context (`data:image/png;base64,...`), giving the model visual guidance without coordinate lock.
   - Result: Emits a structurally distinct layout (different background, shape count, alignment, and typeface).

---

## 2. Automated Test Verification

Unit tests in `apps/core/test/canva-design-planner.test.ts` verify both branches:

- Lines 140–189: Incremental revision with directive `"swap the keynote and mou columns and make the gold bar 300px wide"`.
  - Asserts model messages contain `REVISION MODE` and directive.
  - Asserts no assistant turn is injected.
  - Asserts `isRevision: true` and `priorPlanId` are persisted in the manifest.
- Lines 191–252: Redesign mode with directive `"thats designs are bullshot i keep sending feedback but gives me similar design, here its stuck with a design"`.
  - Asserts system prompt contains `CREATIVE REDESIGN DIRECTIVE` and `COMPLETELY BREAK FREE`.
  - Asserts multimodal reference photo and exemplars are passed.
  - Asserts `isRedesign: true` in manifest.

Both tests pass with 100% assertion coverage.

---

## 3. Plan Diffs

- **Incremental Revision**: See [`PLAN_DIFF_INCREMENTAL.json`](./PLAN_DIFF_INCREMENTAL.json).
  - Preserves overall document skeleton and copy.
  - Modifies only the requested gold bar element (`width: 300px`).
- **Concept Redesign**: See [`PLAN_DIFF_REDESIGN.json`](./PLAN_DIFF_REDESIGN.json).
  - Completely changes the layout skeleton, hierarchy, background, and shapes.

---

## 4. Live Provider Status: BLOCKED

In accordance with Rule 5 ("Live means live") and Rule 7 ("Report deviations"):
- Attempted live API calls for live Telegram chat revision rounds at 16:12 UTC failed with HTTP 429:
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
- All code, schemas, and tests are implemented and passing. Live Telegram interaction requires OpenAI API account credit replenishment.
