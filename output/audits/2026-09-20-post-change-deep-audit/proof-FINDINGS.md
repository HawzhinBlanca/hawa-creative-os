# Post-change proof/evaluation audit

> **Latest-candidate amendment (20 September, 20:51 UTC):** PF-01 is repaired locally by explicit --live refusal (exit 1); PF-03's all-503 experiment now reports FAILED with noncompliant empty latency groups and honest HTTP traces. SLO CLI exit remains 0 after returning failed evidence. PF-04's wholesale replacement is now detected; baseline passes. A new `--append-copy` mutation, however, preserves approved text and adds an unauthorized claim to all 60 actual exports, while every assertion still passes. PF-02 was independently rerun and still gives 200/200 to ambiguous identities and 10/10 to an invalid visual response. See REPORT.md and ROOT_RESULTS.json for current findings; historical raw outputs below are not presented as the newest local result.

20 September 2026. Inspected HEAD `6d3c583791a404c914e25b77dda558b16d26bd6c` plus existing working tree. Scope: evaluator/admission, operational measurement, native fidelity, benchmark protocol. Manifest, deployment, recovery and application security are handled by other workstreams. No application files or previous evidence files were changed. Existing dirty worker/tests/W06/pilot artifacts were left intact. No network/provider call, paid generation or database connection was made.

The testing-strategy skill informed the distinction between actual code under injected failure, component assertions, real service execution, live provider work and human acceptance. New probes only write their own audit output through the audit orchestration. Original scripts' evidence writes are intercepted.

## Verdict

The repairs are real but incomplete. The latest default tournament no longer admits simulated roles, and SLO failure counts are now honest. However, **an unimplemented live-mode flag relabels the same fake execution as live and qualified**. Measured 0% availability still earns QUALIFIED. The native fidelity assertions cannot detect replacement of every exported text string. Thus remaining work is not merely requesting live-test budget or human signatures: software proof gates still need correction.

## Current findings and acceptance requirements

### P1 / PF-01: `--live` launders the unchanged fake tournament into live qualification

`/Users/hawzhin/Hawdesign/scripts/run_model_tournament.ts:36` derives `isLive` only from an argument. The next line still constructs default `EvaluationRunner`, whose constructor at `/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:30` uses `FakeModelGateway`. Script line 72 always constructs `OfflineRunner`. No branch wires real models or a real Studio runner. Nevertheless, lines 142–143 label this LIVE_MODEL_EVALUATION/simulated=false; lines 167–205 admit roles and overall qualification solely because the flag is present and synthetic scores pass.

Fresh actual-script execution, no scoring replacements: default produces UNQUALIFIED_SIMULATION, all roles SIMULATED_NOT_ADMITTED, exit 1 (**fixed**). Add only `--live`: zero attempted fetches, 200/200, all four roles ADMITTED, QUALIFIED, exit 0 (**new bypass**). Probe: `proof-tournament-mode.mjs [--live]`. Results: `proof-results.json`.

The existing R10 tests at `/Users/hawzhin/Hawdesign/packages/evals/test/r10-model-tournament.test.ts:6` still certify the saved historical artifact, including its QUALIFIED at line 16 and ADMITTED roles at lines 87–90. They do not validate this script's actual adapter mode, receipts or current model configuration.

Fix/proof: reject `--live` until a real adapter/runner is provided; derive evidence class from sealed executable dependency provenance and observed provider receipts, not a user flag. Offline/fake dependencies must be ineligible for admission even under live configuration. Replay the flag bypass; require failure before qualification. Then execute explicitly approved current-model/production-retrieval evaluations with complete attempts, raw receipts and current configuration hashes. Gate D, FR-020/021/056/057/058.

### P1 / PF-02: scoring still accepts ambiguous identities and an invalid visual response

The evaluator now rejects absent client/project identities, but `/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:116` and 134 preserve blanket sentinel exemptions; lines 119 and 137 accept substring identity in either direction. A single identical response identifying **all clients and all projects together**, with wrong factual copy, passes all 200 cases. The fake gateway default likewise returns the same sentinel IDs across clients and passes 200/200. No brief-builder call or protected-copy comparison occurs in this routing/brief method.

The visual evaluator at lines 347–355 sends only one text payload, no image, with an empty response schema. Lines 360–369 explicitly reject just two named invalid strings and negative confidence. Lines 391–402 turn truthy `passed` into fallback scores and verdicts. Injecting `{decision: 'NOT_A_VALID_VERDICT', passed: 'false'}` yields **10/10, 100%, zero critical violations**. This is an evaluator defect, not a claim that the production pairwise judge accepts that response.

Probe: `proof-routing-variants.mjs`; latest complete raw output: `proof-routing-visual-results.json`. These are direct calls to the actual evaluator with an injected offline gateway.

Fix/proof: schema-validate real booleans and per-dimension outputs; require exact canonical identity with explicit allowed-alias resolution, never general substring/sentinel exceptions. Test wrong-but-present, cross-client, ambiguous concatenations, extra/omitted protected text, NaN/out-of-range values and invalid enum variants. Evaluate brief generation and critical fact preservation separately; an identity score cannot prove them. Frozen expected outcomes and independent IDs must cover each role and actual retrieval path. Gate D/E, FR-057, NFR-009.

### P1 / PF-03: operations measurement counts failures but still certifies total outage

Improvement: `/Users/hawzhin/Hawdesign/scripts/measure_operations_slo.ts:60` through 70 count attempted requests independently from successful ones, and lines 288–289 use that denominator. The old `successfulCalls = totalCalls` defect is gone.

Remaining defect: percentile(empty) returns zero at line 21; only successful calls enter latency arrays at 82–83/110–111/143–144; comparisons at 304/312/320 therefore pass empty groups. Overall status remains literal QUALIFIED at line 295, unrelated to availability compliance at line 352 or kill-switch failure at line 339. Trace lines 255 and 264 print literal `201 Created` rather than actual response statuses. Queue/backoff at lines 158–179 remain local integer/math simulations, not production queue measurements.

Fresh probe runs the real measurement function with only its database/app dependency boundaries replaced in memory; every app call returns JSON HTTP 503. Result: **0/111 successful, 0% availability/noncompliant; all three latency groups have zero samples, 0ms and compliant=true; kill switch false; overall QUALIFIED; successful return**. The first two trace stages still say 201 Created. Probe: `proof-slo-all-fail.mjs`; raw output in `proof-results.json`. This is an injected-failure test of measurement logic, not live operational load evidence. It bypasses original DB initialization and intercepts artifact output.

Fix/proof: hard qualification conjunction across all required measured predicates, minimum sample/coverage gates, empty metrics UNMEASURED, honest response-derived traces, per-operation error and timeout counts, and explicit simulation labels. An all-503 run, failed kill switch, zero samples, mixed failures and below-target availability must refuse qualification. Production capacity needs actual queues/workers/concurrency telemetry; a short local test cannot certify monthly availability. Gate C, R12/W05, NFR-002/004/005.

### P1 / PF-04: all 60 exported texts can be corrupted without the fidelity tests noticing

Improvement: `/Users/hawzhin/Hawdesign/packages/creative/test/native-script-fidelity.test.ts:201`–202 now assert orthography and clearance for the 20 Sorani inputs. The older claim that these checks are merely recorded is no longer accurate for those 20 cases.

Remaining defect: synthetic assertions at lines 117–131 check XML tag/font/alignment presence and direction computed from the original input. Real assertions at lines 195–202 check XML structure plus QA of the original text. Neither compares extracted output text with required copy. Line 152 takes only the first expected copy block. The 20 “real commercial” samples at lines 51–54 are the first 20 existing routing fixtures converted into simple layouts, not independently documented native production designs.

A mutation harness executes the **actual five test bodies and assertion conditions** with real encoder and QA modules, substituting a small node:assert facade for Vitest and intercepting writes. Baseline: all five PASS. Mutant: replace every copy block supplied to the encoder with `AUDIT CORRUPTED FACTUAL COPY 999999`. All 60 PPTX exports independently confirmed to contain the corrupt replacement; **all five test bodies still PASS, 40/40 +20/20, componentFidelityVerdict PASSED**. This is a test-sensitivity counterexample, **not evidence that the unmodified encoder currently corrupts copy**. It did not run the full Vitest suite/global setup or overwrite the dirty W06 evidence file.

Probe: `proof-native-copy-mutation.mjs [--corrupt-copy]`; raw outputs in `proof-results.json`. The initial probe launches had a package-local fflate resolution error; the harness resolver was corrected and both successful reruns are recorded. Application source was unchanged.

Fix/proof: extract all output text blocks and compare exact logical text, protected punctuation/numbers/URLs, expected node count/order and source binding. Add output mutations for missing/duplicated/reordered/corrupted blocks, wrong logo/font and flattening; each must fail. Keep input orthography distinct from rendered glyph fidelity. Complete the normative current-release native import/edit/save/reopen/export and human review corpus; XML presence alone cannot prove native typography. Gate A/E, NFR-009, W06.

### P2 / PF-05: benchmark protocol remains unready for a superiority claim

`/Users/hawzhin/Hawdesign/docs/benchmark-protocol.md:23` still labels the repeatedly used `evals/routing_brief.jsonl` strictly held out. Its use in scoring, repair development and the W06 source above is established; it can be a regression set, not a fresh unseen acceptance holdout. The prior explicit cross-family requirement **was fixed** at line 110 to follow ADR-030. However the replacement says using a different tier plus swaps/grounding prevents generator self-preference; this is an unmeasured guarantee, not an established consequence.

The protocol usefully requires genuine human reviews, no cherry-picking, no AI-filled ratings and hard correctness gates. Remaining proof design needs include: actually new sealed holdout; separate calibration from acceptance; operator/time equivalence for professional comparisons; tie/failed-output handling; a prespecified inferential test and clustering; a genuine non-inferiority margin/confidence interval rather than just labeling 45% wins+35% ties non-inferiority (line 129); reviewer disagreement and native Arabic as well as Sorani coverage; complete cost and failed/retried run latency. “Triple-blind” (line 62) should name which participants/analysts are blinded and how the key is controlled. A different model tier is not independent human evidence. These are protocol deficiencies, not a measured finding of poor creative output.

## Bounded status after changes

| Item | Current status |
|---|---|
| Default simulated admission refusal | Verified fixed |
| Fake gateway reading expected answers | Removed in inspected current source; it now uses fixed sentinels/keywords |
| Missing identity rejection | Fixed for missing values; wrong-present/ambiguous variants still pass |
| Missing swap denominator/report | Source now divides by all runs and checks missing measurements; earlier repair should be credited |
| Attempted/successful HTTP denominator | Fixed; overall SLO admission remains broken |
| Orthography/clearance assertion for 20 Sorani inputs | Added; output-copy mutation remains undetected |
| ADR-030 model-family conflict | Fixed in protocol; unsupported anti-bias guarantee remains |
| Current native Canva, held-out live models, genuine human acceptance | NOT_RUN in this audit; not conferred by any offline probe |

## Reproduction and scope

Run from `/Users/hawzhin/Hawdesign` with `node --import tsx` followed by the probe path under this directory. Exact commands, exit codes and stdout are in `proof-results.json`; the additional visual negative is in `proof-routing-visual-results.json`. All source references above are current working-tree line numbers at the audited HEAD, not historical report lines. Full suite was deliberately not rerun because some tests rewrite previous proof artifacts. No inference about malicious intent, failure frequency, or global product ranking follows from these findings.
