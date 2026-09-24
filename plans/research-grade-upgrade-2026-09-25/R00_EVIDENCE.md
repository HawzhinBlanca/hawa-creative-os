# R00 — Current studio contract reconciliation

**Date:** 2026-09-25. **Decision:** ADR 025 remains the selected foundation; this slice reconciles documents and makes no provider change.

## Changes

- `docs/30_CURRENT_STUDIO_CONTRACT.md` now defines Canva as the native working master, Hawa's pinned source/export package, final-export and approval binding, and element-by-element recovery limits.
- `AI_BUILD_PROMPT.md`, `DECISION_SUMMARY.md`, `MASTER_SPEC.md`, `docs/06_EDITABLE_DOCUMENT_STRATEGY.md`, and `docs/11_QA_RTL_MULTILINGUAL.md` point to or express that active contract. The old Phase 0B HyCanvas block is explicitly historical; ADR 025 and pre-reconciliation Git history preserve its context.
- `plans/traceability.csv` changes NFR-010 from the retired `.hyc` promise to the active Canva package. Its older proof is labeled historical, and current editability/recovery admission remains open.
- `packages/testkit/test/current-studio-contract.test.ts` checks the active build prompt, specification, decision, QA, and NFR-010 for drift.

## Verification

`pnpm exec vitest run packages/testkit/test/current-studio-contract.test.ts --silent`: 1 file, 2 tests passed. This verifies document consistency only. It is not a Canva edit/reopen, export, or clean-host recovery proof; those remain R16–R19.
