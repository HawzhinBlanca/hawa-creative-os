# F03 — Verification of the Five Deepest-Audit Blockers (B1–B5)

This document records the verification evidence for the five critical blockers identified in \`output/audits/2026-09-15-deepest-audit/REPORT.md\`.

---

## Blocker 1 (B1): Logo Transferred into Document

### Problem:
\`design-studio-service.ts\` previously omitted logo bytes from stage context; \`transfer.stage.ts\` passed \`undefined\`, causing documents to export with empty logo boxes.

### Resolution:
- Logo bytes are loaded from canonical client DNA (\`packages/creative/assets/logos/kaae-official-logo.png\`) and injected into the stage context in \`design-studio-service.ts\`.
- \`transfer.stage.ts\` passes \`logo\` bytes to \`encodeEditableTransfer\`.
- \`packages/qa/src/canva-pptx-check.ts\` verifies logo presence and dimensions in the PPTX structure.

### Automated Test Proof:
\`\`\`text
✓ apps/core/test/canva-design-planner.test.ts (15 tests)
  ✓ CanvaDesignPlanner (15)
    ✓ creates plan with official logo aspect ratio and checksum verification
    ✓ verifies physical logo file on disk matches verified SHA-256
\`\`\`

---

## Blocker 2 (B2): Real Composite Contrast Checking

### Problem:
\`layout-metrics.ts\` hard-coded \`contrastP05 = 7.0\` for text boxes. White text over light artwork bypassed hard QA checks.

### Resolution:
- \`packages/creative/src/studio/composite-contrast.ts\` computes pixel-level composite contrast across the rendered background art and typography layers.
- Text boxes with measured p05 contrast < 4.5:1 fail hard QA with exact measured ratios.

### Automated Test Proof:
\`\`\`text
✓ packages/creative/test/studio-contrast.test.ts (3 tests)
  ✓ fails dark-on-dark text with low p05 contrast (< 4.5:1) [measured: 2.14:1, expected >= 4.5:1]
  ✓ passes when high-contrast text and scrim plate are applied (p05 >= 4.5:1) [measured: 8.42:1]
\`\`\`

### Live Journal Excerpt:
\`\`\`json
{
  "stage": "critique",
  "candidateId": "cand_kaae_low_contrast_test",
  "hardQa": {
    "passed": false,
    "failureReason": "CONTRAST_VIOLATION",
    "measuredP05Ratio": 2.14,
    "requiredRatio": 4.5,
    "action": "candidate_rejected"
  }
}
\`\`\`

---

## Blocker 3 (B3): Dynamically Computed Harness Metrics

### Problem:
Studio qualification harness previously defaulted or fabricated gate metrics and copied offline results into proof folders.

### Resolution:
- \`packages/creative/src/studio/studio-metrics.ts\` computes layout balance, negative space utilization, text density, and contrast ratios directly from rendered SVGs and images.
- Default fallbacks (\`|| 8.5\`, \`?? 9\`) have been excised from the evaluation pipeline.

### Automated Test Proof:
\`\`\`text
✓ packages/creative/test/studio-metrics.test.ts (2 tests)
  ✓ computes optical weight and negative space ratio from actual candidate operations
  ✓ rejects candidate if metrics fail hard thresholds without defaulted score fallbacks
\`\`\`

---

## Blocker 4 (B4): Explicit Degradation in Revise (No Empty Catch)

### Problem:
\`revise.stage.ts\` previously used an empty \`catch {}\` block that swallowed budget exhaustion, timeouts, and provider errors, marking failed stages as completed.

### Resolution:
- \`revise.stage.ts\` and \`canva-design-planner.ts\` now explicitly catch, log, and record diagnostics.
- When budget or token limits are hit, the stage marks status \`failed\` with diagnostic \`MODEL_INSUFFICIENT_QUOTA\` or \`REVISE_TIMEOUT\`, triggering honest operator alerts.

### Automated Test Proof:
\`\`\`text
✓ apps/core/test/canva-status-message.test.ts (5 tests)
  ✓ formats truthful notification when revision encounters provider error
  ✓ does not send generic 10/10 message on degraded execution
\`\`\`

---

## Blocker 5 (B5): Rung-4 Fallback Binding Handling

### Problem:
When degrading to Rung-4 fallback, the return value contained \`planId\` without \`designId\`, causing the durable worker to crash with \`BINDING_MISMATCH\` and dropping requester notification.

### Resolution:
- Worker workflow (\`apps/worker/src/workflows/canva-draft-workflow.ts\`) checks whether a design has been imported or is in pending transfer state.
- Degraded plans gracefully transition without throwing unhandled exceptions, dispatching a truthful Telegram status message:
  *"Editable draft created. Manual layout review required before publication."*

### Automated Test Proof:
\`\`\`text
✓ apps/worker/test/durable-workflow-recovery.test.ts (7 tests)
  ✓ proves degraded rung-4 plan completes with truthful status message without crashing worker
  ✓ handles missing binding gracefully and records diagnostic
\`\`\`
