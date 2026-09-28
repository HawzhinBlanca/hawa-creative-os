# ADR-039: Separate Engineering Preflight from Product Admission

**Date:** 2026-09-25  
**Status:** Accepted for the research-grade branch; product admission remains open.  
**Requirements:** FR-065, FR-069, NFR-011, NFR-013, NFR-025; R03 and R27 in `plans/research-grade-upgrade-2026-09-25/PLAN.md`.

## Context

The old release script initialized `status: QUALIFIED` after its test stages, regardless of Gates A–H. Its Gate B and Gate G were hard-coded `PASS`; other gates could use older evidence; Gate F could be explicitly unrun. The checked-in 2026-09-21 dossier says `QUALIFIED` despite `cleanTree: false` and an unrun Gate F. A source test suite cannot measure a deployed image, publication reconciliation, restore, or human design preference.

## Decision

1. The seven-stage script reports an **engineering preflight** for the clean tracked source candidate. It rejects dirty input before regenerating/checking manifest files and never invents test counts. A test skip or failed negative refusal drill cannot pass.
2. Gates A–H require independently verified evidence bound to the exact candidate commit, source manifest hash and inspected deployment receipt. Prior-candidate drill files cannot be auto-promoted. Gate F also requires a blinded human design study; a review UI test is insufficient.
3. The default deploy preflight may pass while product admission is open, allowing a controlled deployment for measurement. Its evidence says `ENGINEERING_PREFLIGHT_PASSED_ADMISSION_OPEN`. The `--require-admission` mode fails until all gates pass. R27 must implement the current-candidate evidence verifier and full admission dossier before `QUALIFIED` can be emitted by the CLI.
4. The 2026-09-21 `QUALIFIED` record is historical and superseded as a release verdict. Retain it for audit, with the contradiction documented.

## Consequences

No universal 10/10 or production pilot exit can be inferred from technical preflight. A candidate can be deployed for a bounded, reversible pilot only under its separate rollout controls and explicit unresolved-gate report.
