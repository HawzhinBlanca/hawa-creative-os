# Proof quality and creative qualification audit — 20 September 2026

Source inspected: `9c22026f444c81494d286354960a0b10efaa1176`. Application files unchanged. No provider call, production mutation, or spending. This is a focused audit, not a complete security or production-reliability certification. The testing-strategy skill informed separation of unit, integration, live acceptance, and human evidence.

## Verdict

Real improvements exist. Nevertheless, the current R10 and R14 qualification claims are not trustworthy: one release script admits every role even when all component checks fail; the purported production pilot stops at synthetic approval. These are reproduced or directly demonstrated source defects, not speculation about eventual production quality. Creative superiority remains **unmeasured**, not disproved. A numeric global quality score would be subjective, not an experimentally supported rating.

## Fresh reproducible counterexamples

At the repository root:

```sh
node --import tsx output/audits/2026-09-20-world-class-audit/proof-negatives.mjs
node --import tsx output/audits/2026-09-20-world-class-audit/tournament-failure-probe.mjs
```

Both exited 0. Recorded results: `proof-negatives.json`, `tournament-failure-result.json` in this directory. The second executes the actual qualification script with dependency failures injected and intercepts its output write; it **does not overwrite the original qualification dossier**. The script's subsequent console message claiming a write is its own unmodified message. Both probes forbid fetch; neither needs credentials or a database. These probes test evaluator correctness, not live model quality.

| Probe | Observed result | Interpretation |
|---|---|---|
| Always abstain | 5/200, 2.5% | Old 200/200 bug fixed |
| Default fake gateway | 200/200 | Not a live model tournament |
| Remove client, project, and brief from otherwise valid fake decisions | 200/200 | Identity and brief are not required to pass |
| Only 1 of 24 runs has a swap measurement | 100% swap, PASS row | Missing measurements disappear from denominator |
| All four tournament components fail; all fallback flags false | All roles ADMITTED; fallback PASSED; overall QUALIFIED; exit 0 | Release admission is not computed from its checks |

## Prioritized findings

### PQ20-01 — P1: failed/fake tournament still qualifies every model role

`/Users/hawzhin/Hawdesign/scripts/run_model_tournament.ts:36` constructs the default evaluator; `/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:30` supplies `FakeModelGateway`. The studio tournament explicitly uses `OfflineRunner` at script line 71. Its scores, canary, swap consistency, and parity are fixed simulation values in `/Users/hawzhin/Hawdesign/packages/evals/src/design-studio/offline-runner.ts:316` through 383.

Worse, the actual script hardcodes degradation `PASSED` at line 152, all four `ADMITTED` statuses at lines 164–167, overall `QUALIFIED` at line 169, and a 100% tournament console claim at line 177. Injecting complete failure reproduces those admissions and a success exit. `/Users/hawzhin/Hawdesign/packages/evals/test/r10-model-tournament.test.ts:6` reads a saved JSON dossier; assertions at lines 16–32 and 83–90 certify its strings and numbers, not actual provider performance. `/Users/hawzhin/Hawdesign/output/repairs/2026-09-19-architecture-remediation/PROOF_R10.md:154` incorrectly describes this as empirical 200-task model/retrieval qualification.

Required acceptance: explicit simulation/component/live modes; simulation cannot promote a role; every admission derived from complete predicates; failed/unknown checks cause nonzero exit and no admission. Keep this all-failing negative control permanently. Then run actual registry-resolved models on frozen task inputs and production retrieval, recording all attempts, raw outputs, exact model/prompt/tool revisions, input hashes, metrics, and failures. Applies to Gate D, FR-020/021/056/057/058; a fake tournament also cannot prove Gate E.

### PQ20-02 — P1: routing and swap measurements remain permissive after the repair

`/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:108` explicitly validates client only if supplied. Line 111 exempts the fake sentinel `client-office-1`; line 114 allows substring equality. It never requires successful client/project identity and brief fidelity. The fresh missing-identity probe passes 200/200.

`/Users/hawzhin/Hawdesign/packages/evals/src/design-studio/live-runner.ts:328` averages only measured swaps; `/Users/hawzhin/Hawdesign/packages/evals/src/design-studio/report-generator.ts:23` emits PASS without requiring every expected measurement. The 1-of-24 probe emits 100% PASS.

Required acceptance: mutation tests for missing/wrong client, project, protected copy, and invented facts; strict expected outputs with no fixture-only bypass in admission mode; expected case IDs and measurement denominator checked independently. Missing is UNMEASURED, never successful. Require complete coverage before aggregate pass. Gate D/E, FR-057, NFR-009.

### PQ20-03 — P1: the new 100-task pilot does not reach publication or measure its zero escapes

`/Users/hawzhin/Hawdesign/packages/testkit/test/r14-controlled-office-pilot.test.ts:26` uses the test DB and in-process app. Lines 131–178 create tasks, submit handcrafted text/logo nodes, execute QA, and submit programmatic approval. Line 180 counts completion immediately after approval. There is no successful publication, real Studio generation/transfer, remote package read-back, or human decision on this path. Lines 122–123 initialize leakage and flattening counters to zero; neither is incremented before assertions at lines 187–188. Recovery prerequisites at lines 218–224 check script existence/text, not recovery behavior.

Yet `/Users/hawzhin/Hawdesign/output/repairs/2026-09-19-architecture-remediation/PROOF_R14.md:29` says every task includes publication/delivery; lines 33–36 claim zero escapes/editable Canva bindings. This is useful route integration but false production acceptance labeling.

Required acceptance: retain test under an integration name; genuine pilot denominator fixed before execution; 100 real production tasks over three clients, durable worker and external effects, genuine operator decisions, revision/QC hashes, remote read-back, editable source reopening, failures/retries/rescue time, and management signoff. Only terminal verified deliveries count COMPLETE. Gate F/G and Pilot Exit (`/Users/hawzhin/Hawdesign/docs/29_ACCEPTANCE_GATES.md:66`).

### PQ20-04 — P1: human and native-script quality remains blocked, despite qualified labels

`/Users/hawzhin/Hawdesign/output/repairs/2026-09-19-architecture-remediation/PROOF_R13.md:4` says QUALIFIED while acknowledging missing owner ratings. Line 24 claims synthetic rows are rejected. In fact `/Users/hawzhin/Hawdesign/packages/testkit/test/r13-human-quality-operator-gates.test.ts:54` constructs complete synthetic ratings and accepts them. A parser can enforce format; it cannot authenticate human judgment. Lines 77–125 inspect UI source text for controls/keyboard/focus features, not usability with pilot staff or WCAG conformance. The sealed CSV `/Users/hawzhin/Hawdesign/output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND/human-ratings.csv:6` onward remains blank.

Required acceptance: label protocol readiness separately from human acceptance; genuine sealed, blinded owner/designer and native Sorani/Arabic reviews; preserve ratings, times, author attestation, and exact input/output hashes. No agent may fill missing ratings. Human interaction/accessibility tests need actual browser/device execution and manual checks, not substring assertions. Gate F, NFR-009/021. The `plans/traceability.csv:90` claim of NFR-009 qualification is stronger than this evidence.

### PQ20-05 — P1 qualification gap: editable-transfer unit fixes do not establish native editor fidelity

There are meaningful code repairs: `/Users/hawzhin/Hawdesign/packages/creative/src/studio/transfer-v2.ts:165` maps more text properties, lines 213–218 validate copy block indexing, and `/Users/hawzhin/Hawdesign/packages/creative/src/editable-transfer.ts:72` maps geometry/rotation/fill/stroke properties into PPTX; lines 89–95 convert tracking units. But `/Users/hawzhin/Hawdesign/output/repairs/2026-09-19-architecture-remediation/PROOF_R08.md:158` generalizes XML mapping tests to faithful exact Kurdish editability. XML assertions alone cannot show what Canva renders, substitutes, reflows, or preserves after editing/save/reopen.

Required acceptance: run the normative 40 synthetic and 20 real Sorani cases through current native import, edit, save, reopen, export; include dense Arabic/Sorani/English typography, rotation, alpha, tracking, shape geometry, logo integrity and protected copy. Record source/preview/export hashes and node/text editability, objective comparisons, and native-speaker approval. Missing evidence is not proof of current transfer failure; it is an unfulfilled Gate A/E qualification.

## Improvements that should not be erased by this audit

- The always-abstain counterexample now fails 195/200 as expected. The repair is real but incomplete.
- `/Users/hawzhin/Hawdesign/packages/evals/src/design-studio/live-runner.ts:272` now marks transferred responses without winner, preview hash, or score as incomplete. Old invented numeric defaults should not be described as still present.
- `/Users/hawzhin/Hawdesign/packages/creative/src/studio/pairwise-judge-v3.ts:352` rejects missing/invalid dimension winners instead of silently counting them as votes for B. It computes majority from validated votes at line 381.
- `/Users/hawzhin/Hawdesign/apps/core/src/services/design-studio/stages/v3.stage.ts:217` produces critique from already measured deterministic QA rather than an unused paid narrative. This is a defensible cost/clarity improvement, not proof of human quality equivalence.
- Historical P10 component evidence reports real provider usage, 20 component runs, and measured outcomes with explicit exclusions. Preserve it as historical/component evidence; it is not evidence that the materially changed current end-to-end release passes.
- ADR-030's OpenAI-only text/judge family is the selected foundation. Same-family judging is an independence limitation to disclose, **not** a mandate to add another provider or violate the ADR. Independent blinded human reference judgments are still necessary.

## A credible path to world-class creative performance

1. **Fix the proof machinery first.** Incorporate all five negatives above; test every pass predicate by forcing its failure; correct R10/R13/R14 and traceability claims. Keep old reports as superseded history, not silently edited truth.
2. **Bind proof to the release.** Model, prompt, tools, code, flags, dataset, environment and artifact hashes must be explicit. Material changes invalidate affected admissions. Cheap-model agreement with old expensive-model votes is a useful screening experiment, not proof of human preference or exact replay when references differ.
3. **Freeze a representative held-out benchmark.** Stratify current clients, Sorani/Arabic/English, actual output formats/aspect ratios, typography density, reference fidelity, factual copy, template edits versus novel composition, and adversarial cases. Keep tuning and acceptance sets separate. Prespecify metrics, margins, sample size and exclusions; report by stratum and cluster uncertainty by original brief/client rather than treating repeated votes as independent tasks.
4. **Separate deterministic correctness from taste.** Protected text/numbers/URLs/assets, source structure, editability, font availability and round-trip parity are hard gates. Human comparative preference and revision burden are quality measures. A high judge score must never compensate for a critical factual error.
5. **Collect real blinded comparisons.** Compare current system, previous frozen/audited system (not presumed qualified), and an agreed professional/template baseline with randomized side/order and blinded identity. Use independent designers plus native-script reviewers; report win/tie/loss, defects, disagreement and uncertainty. Lock ratings before unblinding; retain unattractive and failed outputs.
6. **Calibrate the judge against humans.** Measure missed critical defects, false alarms, abstention, agreement, order sensitivity and repeat variability. Canary and order swap are necessary diagnostics, not a substitute for independent preference labels.
7. **Measure the full economics.** End-to-end p50/p95 latency, cost per accepted editable design, retries/rejected generations, image costs, operator minutes and technical rescues must all be counted. Establish approved latency/cost/quality limits before observing the holdout. A cheaper model qualifies by human-quality non-inferiority and hard-gate safety, not agreement with its predecessor alone.
8. **Only then widen the controlled pilot.** Satisfy the actual A–H gates and office exit criteria with current deployment evidence. Retain a bounded pilot when quality or operations are unproven; do not claim universal 10/10 reliability.

Research grounding (primary sources checked 20 September 2026): [Zheng et al., Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) studies positional, verbosity and self-enhancement biases and compares judges with human judgments. Its chatbot agreement results do not transfer numerically to graphic design. [Graphic-Design-Bench](https://arxiv.org/abs/2604.04192) explicitly evaluates structured layout, typography, vector structure and related design tasks across complementary spatial, perceptual, text and structural metrics. This supports broader task coverage than one aesthetic score; it does not establish this application's ranking. Its [official repository](https://github.com/lica-world/GDB) also documents implementation/coverage limitations, so adopting the benchmark would itself require a pinned-version evaluation.
