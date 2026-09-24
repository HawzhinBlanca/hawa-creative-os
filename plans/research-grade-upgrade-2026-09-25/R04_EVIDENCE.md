# R04 — Private evaluation corpus inventory and split guard

**Date:** 2026-09-25. **Status:** in progress; no real 200-task corpus or final holdout has been admitted.

## Implemented slice

`scripts/build_eval_corpus.ts` inventories a private `cases.json` into an ignored, owner-readable directory under `data/evaluations/`. It reads real brief and asset bytes, records their SHA-256 hashes, and records a hash of each source's separate evaluation-approval file. The output contains metadata and hashes, never brief text or asset bytes. A path or symlink escaping the private source directory is refused; empty/oversized files, missing approval evidence, duplicate case IDs, malformed dates and missing reconstruction basis are refused. It will not overwrite a prior run.

The deterministic split groups shared campaign IDs, request lineages, declared derivatives, identical brief hashes, normalized exact text and high-similarity text before assigning development, calibration or final holdout. Any group previously used for tuning is forced to development. The seed is stored only in the private output alongside a hashed manifest; `--seal` requires at least 200 cases, three clients and 80/20/100 cases by split. Its status is `machine_sealed_pending_review`: recorded authorization and near-duplicate checks still need independent human verification before a final study can be registered.

Input is a private JSON object with `cases`. Each case has `caseId`, `clientId`, `campaignId`, `requestLineageId`, optional `derivativeOf`, `language` (`en`, `ckb`, `ar`, `mixed`), `format`, `taskClass`, `sourceKind` (`historical` or `reconstructed`), optional `reconstructionBasis`, `sourceRecordedAt`, `evaluationApprovedBy` (an opaque actor ID), `evaluationApprovedAt`, `previouslyUsedForTuning`, `briefFile` (UTF-8 text), `assetFiles` and `approvalFile`. Paths are relative to the input file's directory. The approval file is hashed, not copied. The operator must independently confirm its authority and scope; a hash alone does not prove legal or client permission.

Example invocation: `pnpm exec tsx scripts/build_eval_corpus.ts --input <private-dir>/cases.json --out data/evaluations/<new-run-name> --seed <predeclared-hex> --seal`. Omit `--seal` for an incomplete inventory. The seed and full manifest stay in the ignored private output, away from raters.

## Verification and open work

- Three focused tests pass: derivative/tuning leakage refusal, reproducible 200-case split, and missing-approval/symlink-escape refusal. TypeScript builds pass.
- An end-to-end synthetic CLI smoke refused a one-case `--seal` before creating output, then generated an inventory whose manifest had no brief text; the temporary output was removed. This verifies the command path, not the availability of a real corpus.
- There is no asserted count of eligible real office cases. Existing golden/compare briefs are largely KAAE development material and cannot be relabeled as an independent final holdout. No source authorization document was inspected or copied into this repository.
- Human review must confirm permissions, campaign lineage, visually similar derivative designs, class/format/language balance and the blinded study's pre-registration. R04 remains open until the corpus and independent review exist; R05/R24 may not use a machine seal as proof of creative superiority.
