# ADR300 — Resume the saved Studio source after a native handoff refusal

**Owner:** codex

Date: 2026-10-03. Status: accepted; targeted qualification passed; not deployed.
Requirements: FR-028/029/038/041, NFR-018/024/025.
Sources: docs/05_CREATIVE_ENGINE.md, docs/30_CURRENT_STUDIO_CONTRACT.md,
MASTER_SPEC.md; existing Studio transfer idempotency and ADR132 rate-limit waits.

## Evidence

The actual six-photo model trial produced a valid local editable source, then
Canva setup was missing in its isolated fixture. The transfer exception entered
the generic Rung4 fallback, which collided with the already saved plan and ended
the run. The integration problem did not require another design. Three actual
orchestrator/database regressions reproduce this for CANVA_SETUP_REQUIRED,
CANVA_TEMPORARILY_UNAVAILABLE and CANVA_RECONNECT_REQUIRED; the existing rate-limit
case already preserves the source correctly.

## Decision

Once the run is transferring its retained editable source, propagate typed
CanvaFlowError refusals through the existing HTTP/worker retry or operator
refusal mechanism. Keep the current stage, exact plan ID/hash/bytes and native
import key. A native integration refusal cannot trigger a paid fallback design.
The existing stage resume rereads the saved source and follows the same import.

This is separate from creative-stage QA failures, which retain their existing
fallback/refusal policy. Preserve permanent refusal codes and all source/client/
permission/hard-QA checks. Do not treat a missing connection as success, create a
new retry loop, add a second workflow, change provider limits or suppress an
uncertain remote import. No new generation preflight is introduced: the live
readiness probe already reports connectivity, and a connection can change after
generation. This change repairs recovery at that concrete boundary.

## Qualification

Verify each refused transfer remains at transferring; restore the dependency,
resume using the same bytes/hash/plan/import key, and assert zero additional
model transport calls. Keep the original failed cases and broader affected
orchestrator/QA tests. These are deterministic integration fixtures, not an
actual newly uploaded Canva design or customer approval/download proof.
Evidence: plans/hawzhin-app-integration-2026-10-02/CRIMSON_NATIVE_FONT_PROOF.json.

## Number reconciliation

Originally recorded as ADR293 on source559fda76. Renumbered to ADR300 when
merging live5f3aec67, which already contains Claude’s independent ADR293.
The decision and runtime behaviour are unchanged. Historical font/handoff
qualification is preserved at its recorded source revision.
