# Proof integrity, design quality, and reliability evidence audit

Audit date: 2026-09-19. Source: `664ad55b85930b3cd29c6be170fc13f0d2876f66`.

This bounded sub-audit inspected source, normative acceptance gates, and existing evidence. Two offline counterexamples were executed. No full test suite, real provider calls, provider writes, deployment changes, or disaster-recovery exercise were performed here. No credential files were read. Application files were not changed.

The release cannot be certified from the current evidence. There is meaningful newer component evidence, but the repository still contains executable qualification paths that invent successful measurements, count an incomplete task as completed, and accept a useless router as perfect. Passing those checks is not proof of the operational requirements.

## Executed counterexamples

Reproduce from `/Users/hawzhin/Hawdesign`:

```sh
node --import tsx output/audits/2026-09-19-architecture-reliability/offline-eval-probes.mjs
```

Recorded output: `offline-eval-probe-results.json` in this directory. The probe intercepts every fetch and supplies a synthetic bearer value so the runner never reads its credential fallback.

1. **Missing all quality evidence still produces a successful quality record.** A response containing only `status: transferred` produces winner score **8.5**, a **RELIABLE** canary with four scores of **9**, **100%** swap consistency, **match** parity, `copyVisibleIdentical: true`, and **0** hard-QA escapes. Winner ID and preview hash are empty.
2. **An always-abstaining router passes all 200 cases.** The injected response contains only `decision: abstain, confidence: 1`, with no client, project, brief, or exact copy. Result: **200/200**, **100%**, **0 critical violations**, although **195** dataset cases have `must_abstain: false`.

These reproduce evaluator defects, not a claim that the deployed generation system always behaves this way.

## Findings

### PQ-01 — P1: live qualification fills missing evidence with success

`/Users/hawzhin/Hawdesign/packages/evals/src/design-studio/live-runner.ts:203` defaults a missing score to 8.5. Lines 205–219 construct canary scores of 9, reliability from merely not seeing `UNRELIABLE`, 1.0 swap consistency, and four rounds. Lines 222–227 default missing parity to `match` and identical visible copy. Line 244 fixes escapes at zero. The report writer subsequently awards PASS from these values at `/Users/hawzhin/Hawdesign/packages/evals/src/design-studio/report-generator.ts:14`.

Consequence: an unavailable or changed evidence schema can look like a successful release qualification. This is reproduced by offline probe 1.

Required change and proof: missing measurements must be explicitly `unknown` or `not_run`; aggregate gates must fail closed. Require measured candidate IDs, raw judge votes, exact run/revision/capture binding, preview hash, QA report, and parity artifact. Mutation tests must remove each field and show the report cannot pass. A zero numeric value must never be replaced with a favorable default through `||`.

Maps to Gate E, FR-038, FR-039, FR-057, NFR-011 and NFR-017.

### PQ-02 — P1: the 200-case routing/brief tournament does not score routing or briefs

`/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:52` calls only `intake_router`. Lines 70–96 score enum/confidence validity plus one case of forbidden `route_matched`. They do not compare expected client, project, task type, exact copy, protected tokens, missing facts, or required successful routing. The default constructor at line 29 uses `FakeModelGateway`; CLI `main` uses that default at line 470. Probe 2 demonstrates 100% for an always-abstaining responder.

Retrieval evaluation also inserts documents constructed from each case's expected IDs and its exact query (lines 118–144), then measures recall on that synthetic store. This is a useful isolation fixture, not an independent retrieval benchmark. Visual evaluation sends a single hand-authored textual payload instead of rendered images (lines 274–305). The five-case safety evaluation checks locally written regexes (lines 374–428), not the application's actual privileged boundaries.

Finally, CLI success at lines 486–495 ignores `failedCases` and omits retrieval critical violations entirely. A tournament can print "All role gates passed" while a role has ordinary failures.

Required change and proof: score every specified ground-truth field; evaluate abstention and routing coverage separately; actually test brief generation/fact invention. Separate fixture, replay, and live modes. Use an independent corpus, production retrieval path, real role registry, pinned model/prompt IDs, and recorded provider request receipts. Negative controls (always-abstain, wrong-client, invented-price, no-results, all-errors) must fail. Every required role must meet its declared threshold; any critical violation must fail CLI and release gate.

Maps to Gate D, FR-010, FR-013, FR-020, FR-021, FR-056 through FR-058, FR-068.

### PQ-03 — P1: pilot completion evidence counts task creation as production completion

`/Users/hawzhin/Hawdesign/packages/testkit/test/three-client-production-pilot.test.ts:18` runs the actual Core app in-process against the test DB. That is real route integration, not an externally deployed HTTP/browser test. In the supposed 100-task pilot, lines 263–300 create a task and call brief/layout functions directly. Lines 309–328 read a timeline and set `success: true`. Lines 338–367 count that as completed and write `QUALIFIED_SUCCESS`. The test never drives those tasks through real generation, human approval, external publication, read-back, or terminal COMPLETE.

The other pilot uses an array-backed SQL imitation and fake studio, with explicitly emulated publishing: `/Users/hawzhin/Hawdesign/packages/testkit/test/pilot-exit-drill.test.ts:188` through 200. The original E2E uses the same substitutions: `/Users/hawzhin/Hawdesign/packages/testkit/test/e2e-office-lifecycle.test.ts:166` through 176. These should remain useful simulation tests but cannot satisfy `docs/29_ACCEPTANCE_GATES.md:68` through 74.

Required change and proof: distinguish simulated, created, generated, reviewed, published, verified, and COMPLETE counts. Complete the actual normative pilot: 100 real production tasks over three representative clients, with genuine operator decisions, verified remote packages/rows, rescue counts, revisions, critical escapes, and management acceptance. Preserve the population and failures rather than selecting successes. A task stuck after creation must count incomplete.

Maps to Pilot Exit; Gates C, F and G; FR-041, FR-044, FR-045, FR-048, NFR-001, NFR-008.

### PQ-04 — P1: published fault/restore passes do not establish clean-host recovery

`/Users/hawzhin/Hawdesign/packages/testkit/test/faults.test.ts:18` asserts repeated normalization returns the same event ID, not that persisted duplicate events create one task. Lines 118–157 replay a `FakePublisher` in one process; they do not lose a real remote success response and restart the service.

`/Users/hawzhin/Hawdesign/apps/worker/test/durable-workflow-recovery.test.ts:97` through 194 uses a mock studio and a manually copied `DurableStepJournal` snapshot. This proves replay logic at that boundary, not Restate/API/DB crash recovery.

`/Users/hawzhin/Hawdesign/packages/db/test/backup-restore.test.ts:48` through 72 restores table-name arrays from parsed SQL. `/Users/hawzhin/Hawdesign/infra/backup/backup_restore_drill.sh:98` runs that simulation and records a passed drill, with `rpo_seconds=0` at line 45. Its newer comments correctly call this schema parity, but the result cannot prove recoverable business data or RPO.

There is an honest newer isolated PostgreSQL restore artifact: `/Users/hawzhin/Hawdesign/output/repairs/2026-09-13-ship-blockers/isolated-restore-verification.json:2` explicitly says it is synthetic and is not office disaster recovery. `/Users/hawzhin/Hawdesign/deployment/restore-test.sh:17` performs actual backup restoration, but ends with `restored-awaiting-application-verification` at line 22; this inspected artifact does not establish a completed Gate H drill.

Required change and proof: deploy an isolated clean stack from actual encrypted backup; independently measure last recovered business event versus source time and time to usable operation. Verify representative source bytes/hashes, assets, credentials/configuration recovery procedure, approval lineage, paused workflow resume and remote state reconciliation. Meet RPO ≤15 minutes and RTO ≤4 hours. Inject termination before/after each side-effect boundary, including remote-success/local-receipt gaps; count remote effects after restarting each real service. Preserve shell logs, service IDs, backup IDs, timestamps, failures, and read-back evidence.

Maps to Gates C, G and H; FR-047 through FR-050, FR-070, NFR-001 and NFR-003.

### PQ-05 — P1: release evidence must distinguish component design quality from shipped quality

The newer P10 report is real progress: `/Users/hawzhin/Hawdesign/output/proofs/2026-09-18-production-qualification-2/P10_QUALIFICATION.md:3` through 32 reports 20 completed component runs, 122 model calls, 95% structural print-ready rate, 100% production-hard-QA pass, 90% order-swap consistency, and measured font probes. It explicitly excludes image generation costs.

Its scope still stops short of release admission. `/Users/hawzhin/Hawdesign/scripts/run_p10_qualification.ts:687` calls shared layout functions directly. Lines 734–737 call positive logo dimensions and a hex background color "asset integrity", and existing copy indices "exact copy". Lines 739–748 call a nonempty local rerender after changing copy "editability". Those useful local checks do not establish the official logo bytes, exact exported copy, editability after Canva import/reopen, or source-package completeness. The separate shared hard-QA pass is stronger than these labels, but still cannot prove downstream export behavior.

The recorded run combines commits `910a6a6` and `4822e01`, not audited HEAD: `/Users/hawzhin/Hawdesign/output/proofs/2026-09-18-production-qualification-2/RUN_MANIFEST.json:32` through 56. That manifest at lines 27–30 also uses `gpt-6-astra` for generator, critique, and judge. There are no different-family comparisons in this inspected run. The report itself measures only two archetypes, with 17/20 centered layouts (line 25). Thus it cannot establish independent judgment or broad creative superiority.

Required change and proof: retain P10 as component qualification and add final-artifact checks on the exact release build. Render and reopen real exported Canva/source packages; mutate every important text/asset and verify that the relevant rendered region changes; compare exact copy and approved asset bytes, dimensions, fonts, clipping, RTL and reading order. Capture roundtrip differences. Calibrate judges against independent human-labeled defects and record precision/recall and missed critical defects; an optional permitted OpenAI role/model comparison must respect ADR 030 rather than require an unapproved provider. Record production flags, deployment image digests and model registry versions. A release cannot inherit another revision's result without a justified compatibility check.

Maps to Gates A, D and E; FR-034 through FR-039, FR-045, FR-057, FR-074, NFR-008 and NFR-009.

### PQ-06 — P1 for a superiority claim: human creative quality remains unmeasured

`/Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND.md:3` accurately says awaiting owner blind ratings; lines 28–31 show zero rated pairs. The adjacent `T8_BLIND/human-ratings.csv` still contains no choices or ratings. Passing the packaging tests proves assets/seal structure, not preference. No agent should complete this human gate on the owner's behalf.

Required change and proof: present sealed, unlabeled current-release pairs to the owner and a native Sorani reviewer; obtain actual ratings and recorded reasons, then verify the seal and calculate the prespecified outcome and uncertainty. This protocol's 8/10 preference threshold is its own product gate, not statistical proof of universal superiority. Add longer-run revision/rescue/defect baselines from the pilot before asserting high reliability. Freeze a fresh holdout after changes informed by the existing qualification set.

Maps to Gates A, E and F; Pilot Exit; FR-039, FR-041, NFR-009.

### PQ-07 — P2: contradictory acceptance labels and retroactive provenance remain in the repository

`/Users/hawzhin/Hawdesign/evidence/ACCEPTANCE_REPORT.md:5` claims complete production readiness. Lines 13–20 rename normative Gates A–H to unrelated checks: H becomes a PWA build, while actual H is clean-host restoration; D becomes unit state tests, while actual D is model/retrieval admission. Line 35 calls the SQL-array test production database wipe/restore. It is dated September 4, so this is stale historical evidence, not current confirmation.

`/Users/hawzhin/Hawdesign/scripts/generate_proofs_manifest.ts:53` reads current HEAD and stamps that same commit on every already-existing artifact at line 71. Lines 85–158 assign hardcoded COMPLETED task statuses. Hashing files proves their current bytes; it does not establish originating code, passing criteria, external side effects, or human review.

Required change and proof: retain history with a prominent superseded qualification, but publish one canonical A–H/pilot matrix. Each claim must bind requirement/test ID, exact originating revision/image digest, environment, mode, flags, command, exit code, timestamps, raw artifact hashes and independent acceptance. Differentiate PASS, FAIL, BLOCKED, NOT RUN, and SIMULATION. Generate completion from checked conditions, not hardcoded strings. Reject artifacts with missing/stale provenance or failed predicates; preserve mixed-run revisions explicitly.

Maps to all acceptance gates; FR-057, FR-069, FR-074, NFR-011, NFR-013 and NFR-015.

## Strengths worth retaining

- Shared production hard QA now exists: `/Users/hawzhin/Hawdesign/apps/core/src/services/design-studio/stages/qa.stage.ts:9` calls `evaluateHardQa`, and qualification uses the same evaluator. `/Users/hawzhin/Hawdesign/packages/creative/src/studio/hard-qa.ts:65` through 163 checks small fonts, layout validity, overlap, alignment, separator asymmetry, declared contrast, copy overflow and copy order. This directly addresses several earlier false-positive quality measurements.
- `/Users/hawzhin/Hawdesign/packages/qa/src/copy-validator.ts:36` checks missing/mutated/duplicated copy and unsolicited text. `/Users/hawzhin/Hawdesign/packages/qa/src/canva-pptx-check.ts:293` checks exported text, font and RTL metadata while explicitly returning `fullReleasePass: false`, `logoVerification: not_qualified`, and `layoutVerification: visual_review_required` at lines 321–324. These scope distinctions should become the standard throughout qualification.
- The inspected Canva boundary tests name their substitutions honestly (`apps/core/test/canva-connect-live-boundary.test.ts:26`: real isolated PostgreSQL, mocked provider transport) and exercise actual Core handlers around lines 233–256. They have useful integration coverage even though they are not a production browser/remote-service release test.
- P10 raw layouts, previews, critiques, canary judgments and provider request IDs are preserved. The latest inspected report measures its shared hard-QA result and explains important limitations. Human ratings are deliberately left blank instead of fabricated.

## Proposed work order and mandatory proof

| Order | Task | Required acceptance evidence |
|---|---|---|
| 1 | Correct evaluator truthfulness (PQ-01, PQ-02) | Both saved counterexamples fail qualification; missing evidence and wrong outputs cannot pass; nonzero CLI exit on every violated role gate. |
| 2 | Canonical immutable release evidence (PQ-07) | Requirement-to-test-to-artifact links, exact commit/digest/flags/mode, validated provenance, stale-proof rejection, clear unexecuted gates. |
| 3 | Actual deployed vertical slice (PQ-03, PQ-05) | Real authenticated intake → durable work → exact artifact → human approval → verified Drive/Sheet, all linked to one task/revision and replay identity. |
| 4 | Kill/retry and clean-host recovery (PQ-04) | Real-service fault matrix with remote read-back and duplicate counts; backup recovery with measured RPO/RTO and paused workflow continuation. |
| 5 | Current-build multilingual final-output admission (PQ-05) | Complete Sorani/Arabic golden corpus, real Canva/source roundtrip, official-asset/copy checks, native reviewer evidence, mutation and parity results. |
| 6 | Independent model and creative quality admission (PQ-02, PQ-06) | Frozen holdout; role-wise live tournament, judge defect calibration, genuine sealed owner preferences with uncertainty. |
| 7 | Office pilot exit (PQ-03) | 100 actual completed production tasks across three clients; ≥95% without technical rescue; zero critical escapes; operator runbook trials; explicit management residual-risk acceptance. |

These tasks define observable completion. They cannot certify an unbounded "10/10" or "best possible" system. They can support a defensible release under stated workloads, deployment assumptions, recovery targets, and measured creative-quality criteria.
