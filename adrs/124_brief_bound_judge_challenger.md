# ADR-124 — Brief-bound independent judge challenger and its experiment

Date: 2026-09-28. Status: implementation; the challenger is not admitted.
Requirements: FR-057/065/079, NFR-024/025. Normative sources:
docs/05_CREATIVE_ENGINE.md, docs/07_MODEL_REGISTRY_AND_EVALUATION.md,
docs/10_WORKFLOW_RELIABILITY.md, plans/research-grade-upgrade-2026-09-25/EVALUATION_PROTOCOL.md.

## Context

The active P07 judge forces an A/B vote on five dimensions, gives the model the
heuristic layout scores as "ground truth" and defines brand fit as institutional
prestige and academic gravitas. Agreement with it does not establish
client-specific design quality. The R06 calibration interface already supports a
metric-blind packet, ties, abstention, localized findings and human labels.

## Decision

Add one challenger protocol, `brief-bound-dimensional-v1`, on that interface. It
receives the requester's instructions, the recorded brief fields (occasion,
audience, must, mustNot) and the exact copy by copy index, unchanged. It judges
correctness, communication and aesthetic preference separately; each allows A,
B, tie or abstain; findings carry a region and, for copy errors, the copy index.
No layout, metric, rank or prestige wording is sent. Candidates are sent at high
image detail so exact copy can be read.

The model returns no overall winner. The application applies a fixed rule over
both presentation orders: correctness, then communication, then aesthetic
preference. A dimension passes to the next only as a stable tie. An abstention,
a position flip or a pick contradicted by its own severe findings stops the rule
as uncertain; a lower preference never settles an open higher check.

`HAWA_STUDIO_JUDGE_PROTOCOL` selects the judge when the stage runs: unset or
`incumbent` keeps P07; `brief_bound_v1` selects the challenger; any other value
is refused visibly as an unavailable judge, with no model call. The challenger
uses the same eligible top two, the same rendered bytes and assets, the same
two-order match and degraded-copy canary, the same ledger client and budget.
Uncertainty keeps the higher composite and records `humanChoiceRecommended`.
Its judgments keep packet hash, image hashes, verdict, decision and receipt in
the existing table. No migration is needed; 067 is unused.

The experiment harness compares both judges on one corpus, same bytes, same
model, both orders. Its plan is frozen and hashed: primary endpoint seeded-defect
detection (paired, lineage-clustered bootstrap, 10,000 draws), worthwhile effect
+0.10 with lower bound above 0; margins for human agreement and order
consistency (-0.05), clean-control critical findings (at most 0.05) and cost per
case (at most 2x, no unknown cost); at least 20 seeded and 10 clean lineages.
Ties, abstentions, flips, invalid replies and missing calls count as failures.
No outcome admits the challenger; the best is eligibility for a shadow run.

Every request is quoted with the ADR-091 reservation policy before dispatch and
admitted against a run cap and, for dispatching runs, the office daily ledger
used by paid qualification scripts. The first provider error stops the run. A
paid run must type back the plan hash. The synthetic provider answers from the
request hash, never from truth labels; its analysis is `SYNTHETIC_PLUMBING_ONLY`.

## Review corrections — 2026-09-28

An independent review found that the clean-control margin counted a clean
control without a valid challenger answer as clean: an over-flagging reply that
failed validation improved the challenger's result. The analysis now applies the
plan's success counting to that margin too: a clean control not validly
answered in both orders counts against the 0.05 ceiling and stays in the
denominator, and the counts are reported (`margins.cleanControl`). The plan text
and hash are unchanged; its success counting already required this.

An incumbent order flip is now its own outcome, never a tie, so it cannot agree
with a human tie consensus. The analysis reuses the R06 calibration validators,
consensus rule and, through `bootstrapLineageMeans`, the R-study lineage
bootstrap (bit-identical on 200 generated cases). Run records now bind both
image hashes, and the challenger's validly answered cases are passed to
`analyzeBlindJudgeCalibration`, so per-dimension human labels are reported
beside the decision. They do not enter the frozen decision rule: the incumbent
has no matching dimensions, so a paired per-dimension margin cannot be stated,
and adding one would need a new plan version before the first paid run.

Core does not bound request instructions, so the challenger now accepts up to
24,000 characters of instructions and 1,000 per must/mustNot item inside the
unchanged 30,000-character packet bound. A request that still cannot fit is
refused, never truncated, and Core records the refusal's `errorCode` with the
unavailable judge so the class can be counted. When the degraded canary renders
the same bytes as the pick (a layout without title or body roles), no canary
call is made, the pick is untested and not trusted: the composite stands as
`composite_judge_uncertain` with `judgeReliable` null. Every challenger
composite outcome and an unavailable judge under either protocol record
`humanChoiceRecommended`, and the Desk Studio panel shows it as a request to
choose. The incumbent's own tie and canary-failure outcomes are unchanged and
still record it as false.

## Acceptance

Prompt contract, strict schema, reply validation, decision rule, flag parsing,
selection branches (adopt, uncertain, canary failure, missing brief), Core
persistence on isolated PostgreSQL, calibration analysis with dimension labels,
corpus verification, quote-only, synthetic end to end, budget and office-cap
refusal, first-refusal stop, invalid-reply accounting and decision rules; after
review, invalid clean controls against the false-critical margin, incumbent
flips against a human tie, per-dimension calibration from the run record,
long-request bounds, the identical-canary branch, the recorded refusal code and
the Desk notice.

## Local qualification — 2026-09-28

See `plans/lean-design-implementation-2026-09-28/JUDGE_CHALLENGER_PROOF.json`
for the red run, connected results and the retained corpus, quote and synthetic
run. No paid model call, human label, shadow run, deployment or production
flag change occurred. The development corpus is golden-brief material and cannot
serve as a calibration or holdout split.
