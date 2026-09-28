# Model Registry and Evaluation System

## 1. Principle

Models are volatile components, not architecture. The system resolves a **role** to an exact tested deployment.

Prohibited production references:

```text
latest
best
auto
provider-default
unversioned rolling alias (unless the provider offers no snapshot and policy explicitly accepts it)
```

## 2. Model roles

| Role | Required capabilities | Provisional challengers |
|---|---|---|
| `intake_router` | multilingual structured classification, calibrated abstention | Gemini 3.8 Flash, GPT-5.6 Terra, Claude Fable 5.1/local challenger |
| `brief_builder` | exact fact preservation, schema output, Sorani/Arabic understanding | same pool plus stronger models for hard cases |
| `creative_director` | visual reasoning, novel composition, references, structured plan | GPT-5.6 Sol, Claude Opus 5, Gemini high-end challenger |
| `visual_judge` | image understanding, rubric consistency, defect detection | a different family from creator |
| `feedback_classifier` | scoped taxonomy, low cost, high precision | fast models/local model |
| `rule_miner` | cross-task evidence synthesis, conservative proposal | deep reasoning model |
| `image_general` | generation/editing/reference fidelity | GPT-Image-2, Gemini image, FLUX.2 |
| `image_vector` | graphic/vector output | Recraft V4.1 Vector and evaluated alternatives |
| `image_local` | private/low-cost generation | FLUX.2 Klein 4B or newer admitted local model |
| `embedding_multimodal` | English/Sorani/Arabic text + visual similarity | Qwen3-VL-Embedding 2B/8B and challengers |
| `reranker_multimodal` | query-conditioned visual/text relevance | Qwen3-VL-Reranker 2B/8B and challengers |

## 3. Registry fields

Each deployment records:

```text
role
provider and transport
exact model ID/version/snapshot
endpoint/base URL
capabilities
input/output modalities
context and image limits
structured-output/tool behavior
region/data policy
client egress eligibility
parameter profile
prompt version
known defects
fallback chain
cost policy
latency budget
evaluation run and score
admission state: candidate | shadow | canary | primary | fallback | retired
valid-from / valid-until
```

## 4. Evaluation corpus

Minimum launch corpus: **200 historical or faithfully reconstructed office tasks**.

Suggested mix:

- 70 Sorani, 55 English, 45 Arabic, 30 mixed-language;
- 80 routine social designs;
- 45 podcast/video cards;
- 30 event/product posters;
- 20 ambiguous routing cases;
- 15 correction-heavy cases;
- 10 adversarial prompt-injection/permission cases.

No task may appear in both tuning/development and final holdout sets.

## 5. Role-specific metrics

### Routing

- exact client/project/task label;
- confidence calibration;
- abstention on ambiguity;
- explanation evidence precision;
- zero out-of-scope client selection.

### Brief extraction

- exact fact/copy preservation;
- requirement recall;
- invented-fact rate;
- missing-information detection;
- schema validity;
- language/direction correctness.

### Creative direction

Blind native/design reviewers score:

- task fulfillment;
- originality without brand drift;
- hierarchy/composition;
- cultural fit;
- useful asset decomposition;
- editability feasibility;
- repairability;
- cost/latency.

### Visual judge

- precision/recall for seeded defects;
- false-block rate;
- calibration by severity;
- consistency across language and style;
- inability to override hard rules.

### Retrieval

- Recall@K and nDCG@K;
- approved-example precision;
- exact asset/rule recall;
- negative-example exclusion;
- cross-client leakage = zero;
- latency and GPU memory.

## 6. Tournament protocol

1. Freeze dataset, prompts, tool schemas, and scoring rubric.
2. Resolve exact model versions and parameter profiles.
3. Run each candidate without revealing model identity to human judges.
4. Repeat stochastic creative cases enough to measure variance.
5. Use deterministic programmatic checks before subjective review.
6. Normalize cost and latency but do not let cheapness hide quality failures.
7. Select a primary and fallback per role—not one universal winner.
8. Publish a decision record with failures and confidence intervals.

## 7. Admission gates

A candidate becomes primary only when:

- no critical safety/permission failure occurs;
- hard requirement performance meets the role threshold;
- it improves a declared objective or reduces cost materially without quality loss;
- its failure behavior is known;
- the fallback path has passed;
- replay/canary/rollback are ready.

## 8. Deployment progression

```text
candidate → offline benchmark → shadow → 5% canary → 25% canary → primary
```

- Shadow results never mutate production state.
- Canary tasks remain human-approved.
- A regression in exact-copy, routing, cross-client isolation, or schema validity triggers immediate rollback.
- Model/provider removal must be survivable by switching registry state.

## 9. Creator–judge separation

The visual judge should not normally be the same model/version that generated the plan or image. This does not guarantee independence, but it reduces identical blind spots. Hard QA remains deterministic.

## 10. Cost control

- Fast models handle routine parsing/classification.
- Deep models are invoked only for ambiguity, novel direction, rule mining, or difficult QA.
- Routine template tasks may use no image model.
- Candidate count and image resolution are explicit budgets.
- Prompt/context hashes enable safe caching only where semantics permit.
- The UI displays expected and actual cost per task/revision.

## 11. Model retirement

When a provider announces deprecation:

- freeze exact affected workflows;
- rerun the benchmark on replacement candidates;
- shadow the winner;
- migrate before shutdown date;
- retain old invocation/provenance records;
- never silently map an old model name to a different behavior.

## 12. Design Studio v2 Model Registry & Evaluation Addendum

Design Studio v2 introduces specialized model assignments and benchmark protocols:

### Admitted Deployments for Design Studio v2
| Role | Primary Model | Fallback Deployment | Structured Output Mode |
|---|---|---|---|
| `studio_planner` | `claude-fable-5-1` | `claude-opus-5` | Strict JSON Schema (`DesignPlanV2`) with prompt cache prefix |
| `studio_critic` | `claude-fable-5-1` | `claude-opus-5` | Multimodal Vision + JSON Schema (`CritiqueResult`) |
| `studio_judge` | `claude-fable-5-1` | `claude-opus-5` | Multimodal Pairwise Tournament + JSON Schema |
| `studio_art_generator` | `gemini-3-pro-image` (Nano Banana Pro) | Procedural SVG Motifs (`motifs.ts`) | Image generation endpoint; SynthID + $\Delta E2000$ validation |

### Evaluation Protocol & Golden Harness
- **Golden Brief Corpus**: 24 authentic KAAE institutional briefs (`packages/evals/src/design-studio/briefs/`) spanning 12 English, 8 Sorani Kurdish, and 4 mixed-language requirements across standard aspect ratios (`1080x1350`, `1080x1080`, `1080x1920`, `1240x1754`, `1920x1080`).
- **Offline CI Runner**: Fast, deterministic mock evaluation suite (`offline-runner.ts`) integrated into standard `pnpm test` verifying D1–D8 evaluation pipeline invariants without external network dependencies.
- **Statistical Confidence**: `ratings-intake.ts` computes 10,000-resample bootstrap 95% confidence intervals and Spearman rank correlation ($\rho$) for judge vs. human preference alignment.
- **Position Bias Protection**: Tournament matches execute bidirectional presentation swaps (`Candidate A vs B` and `Candidate B vs A`). Asymmetric verdicts are logged as position-bias conflicts.

### Shared gateway uncertainty and evaluation holds (ADR-083, 2026-09-27)

A dispatched model request with unknown acceptance (including HTTP 408/5xx), or
an unusable successful response, must stop the current logical call. Another
provider's success cannot settle that request's cost. Return a non-retryable hold
with observed provider/model, attempts, HTTP status and bounded request-header ID;
unknown cost stays null. Exclude raw provider bodies and exception text. A definite
rate rejection may follow the authorized bounded fallback policy.

Evaluation batches must stop further model calls on this hold and distinguish
attempted failures from unexecuted cases. A stopped tournament has no aggregate
pass percentage and is not admission evidence. The current implementation enforces
this during one process; a durable evaluation-call ledger, restart recovery and
provider reconciliation remain required before qualifying resumable evaluations.

### Durable fixture evaluation recovery (ADR-084, 2026-09-27)

Fixture tournaments use the existing tenant-scoped eval_runs table and a per-run
ordinal call ledger. The action UUID, request hash, corpus/image/protocol/source
identity and first call outcomes are immutable. Save admission before transport;
replay only the retained scoring projection and gateway receipt metadata. Raw
prompts and free-text responses are excluded. This narrow fixture retention rule
does not authorize storing general client model output.

A repeated action returns or resumes its saved run. A pending or uncertain call
holds the run and blocks fresh actions until reconciliation; provider availability
changes cannot bypass the saved admission. A version conflict requires the original
candidate. Database unavailability must not invoke an in-memory model path. Desk
retains the action through HTTP failure/refresh and exposes incomplete status and
sanitized call receipts. Provider settlement and live billing remain unqualified.

### Attributed closure of held fixture runs (ADR-085, 2026-09-27)

A named office administrator may close a held fixture evaluation by recording the
exact observed ledger snapshot and terminal provider evidence for every unresolved
call. The provider/support reference, retained-evidence digest and known reported
final cost are separate administrator attestations; they do not replace the original
unknown outcome or establish automated invoice verification. Unknown cost or
acceptance remains held. A confirmed non-acceptance requires zero cost.

Settlement is append-only, tenant-scoped, keyed and transactionally authorized. It
refuses an active execution or changed snapshot. The old report and call outcomes
remain unchanged, closed runs admit no new calls, and the settlement sends no model
request. Any subsequent evaluation is explicitly requested new billable work. See
runbooks/EVALUATION_RECOVERY.md. Automatic provider lookup and general Studio reply
recovery remain separate work.


### Shared gateway request bounds (ADR-093, 2026-09-27)

Each paid request must fit a quote for its exact serialized body before transport.
The versioned policy prices the selected model, explicit native output cap and
conservative text/image input bounds. Invalid, expired or unpriced requests stop;
the gateway never reduces a supplied cap or chooses a cheaper model to fit. The
default cap is 2,048 combined generated tokens, including thinking. Evaluations
now declare that cap explicitly; their existing dollar allowances are unchanged.
Client egress, inputs and allowance are frozen across authorized fallback attempts.
One time budget covers the full call.

Complete native usage records a conservative estimate with its cost basis; missing
or malformed usage remains unknown. Google thought tokens and Anthropic cache
categories count. Reported model mismatches or bound overruns require review and
stop further calls. Evaluation runs retain the quote/hash and observed overrun,
stop on budget refusal, and distinguish unexecuted cases. These provider estimates
do not prove invoice amounts or office-wide durable allocation; that integration
remains separate. Price policy expiry and sources are in ADR-093.


### Shared response schema enforcement (ADR-094, 2026-09-27)

The gateway compiles the frozen application schema before any provider transport.
Pinned Ajv supports default draft-07 and explicit draft-2019-09 / draft-2020-12.
Unknown keywords/formats/dialects, unresolved external references, malformed and
async schemas fail with MODEL_SCHEMA_INVALID and zero cost/dispatch. Schemas are
trusted application code, never model/upload content. They are bounded to 128 KiB,
depth 64 and 10,000 values; the compiled cache retains at most 128 schemas.

Every cloud/local answer must be finite plain JSON (at most 8 MiB, depth 128 and
100,000 values) and pass the compiled schema. No coercion, property removal or
default insertion occurs. Invalid paid output keeps its usage/quote evidence and
blocks another provider call. The validated answer is returned and hashed unchanged;
execution provenance and responseSchemaSha256 live on the response envelope.
Historical absent metadata stays absent. Diagnostics omit answer/schema content.

Routing/visual fixture calls now supply explicit schemas for their consumed fields.
Fixture replay protocol v2 binds these schemas into its identity. An incompatible
in-progress run retains the original version hold. Schema enforcement does not
turn fixture results into independent model/design qualification.

### Shared office spending admission (ADR-096, 2026-09-27)

Migration 052 extends the Studio policy/lock to original evaluation and retained
voice ledgers. Evaluations reserve their full frozen request allowance against
office and model-role limits; voice reserves inspected audio cost against office,
client and voice-role limits. No duplicate balance counter is introduced. All
admission uses database timestamps, Asia/Baghdad days and READ COMMITTED queries
after the same office lock. Parent/task/source locks precede the spending lock.
Voice client identity also has a tenant/client foreign key; office-role permission
alone does not prove that an arbitrary client ID belongs to that tenant.

Complete finite usage or definite non-acceptance releases unused funds. Missing
usage, uncertain calls and received voice without billing evidence retain their
allocation across midnight. Missing historical allocation holds further spending;
an observed overrun remains recorded. Exact settlements preserve the greater of
observed and administrator-attested cost. Refused evaluations stop before transport;
refused voice preserves original audio and manual copy review. Original admission
and outcome identities are immutable; exact duplicate voice replay remains valid
after the allowance is exhausted.

This covers Studio, fixture evaluations and retained voice. Other provider-egress
paths, named policy administration/accounting repair, typed completed-stage replay,
fresh runtime qualification and live billing/office admission remain open. See
runbooks/STUDIO_DAILY_BUDGETS.md and R21_SHARED_SPENDING_PROOF.json.


### Exact-call cost evidence (ADR-097, 2026-09-27)

A named administrator can append snapshot-bound terminal cost evidence for an
exact Studio, evaluation or retained-voice call, including completed replies with
missing billing data. SQL verifies current authority, source identity, revision,
terminal evidence and the observed snapshot under parent/source and office locks.
Original receipts and all earlier attestations remain immutable. Shared daily and
Studio run admission retain the highest original, settled or attested cost; unused
reservations can then be released. A late receipt preserves any higher charge and
shows disagreement. Accounting does not clear execution holds or replay paid work.
Desk Operations shows paginated original costs, reserved amounts, attributed
history and conflicts. Unknown cost remains unknown; evidence files stay local.
See runbooks/CALL_COST_ACCOUNTING.md. Live billing, policy administration and typed
result recovery retain separate acceptance gates.


### Source-bound fixture evidence (ADR-099, 2026-09-27)

Saved fixture reports identify corpus bytes by SHA-256 and individual cases as
passed, failed, not executed or unreported. Missing visual rubric scores cannot
be replaced by numeric defaults; incomplete scoring has no aggregate pass rate.
The replay protocol is v3. Completed legacy reports remain immutable and can
supply only their recorded aggregates, not reconstructed per-case outcomes.

Desk selects a saved run explicitly and matches case evidence to the exact corpus
identity. Dataset counts are measured from validated files, not fixture constants.
Browsing RTL definitions does not run the RTL corpus. Suite counts, call models,
latency and timestamps come from retained evidence. Candidate ranking, native
editability, canary results and human scores remain unknown unless independently
measured. Reading these views sends no generation request. Existing retained-action
retry, shared spending, and named settlement boundaries remain authoritative.


### Durable paid health probes (ADR-100, 2026-09-27)

Scheduled OpenAI health probes reserve their exact bounded request against the
shared office and `health_probe` role allowance before transport. PostgreSQL
serializes admission across Core instances and restarts, enforcing the longer of
the previous/current intervals and retaining uncertain calls across configuration
changes and midnight. Each attempt has a stable call ID, protocol, request hash,
reservation/policy version and one immutable outcome with actual receipt metadata,
latency and complete usage. Unknown facts remain null. Health GETs never dispatch.

Timeouts, ambiguous HTTP failures, invalid successful receipts, model mismatches
and bound overruns require reconciliation. A named administrator can append exact
terminal cost evidence through existing Operations accounting. After the interval,
this allows a new scheduled probe within current limits; it never replays the old
call or converts financial evidence into provider health. Original observations
remain immutable. Pre-ledger observations gain no fabricated costs. See
runbooks/PAID_HEALTH_PROBES.md and R21_PAID_HEALTH_PROBES_PROOF.json for qualification.

### Brief-bound judge challenger and its experiment (ADR-124, 2026-09-28)

The R06 calibration interface now also accepts the `brief-bound-dimensional-v1`
protocol: actual brief and exact copy, correctness, communication and aesthetic
preference judged separately with tie and abstention, localized findings, no
scores shown, and optional human labels per dimension. The incumbent P07 prompt
remains unchanged and remains the default.

`scripts/run_judge_experiment.ts` compares both judges on one pinned corpus with
the same bytes, model and both presentation orders. Its plan is frozen and
hashed before any run: seeded-defect detection is primary (paired,
lineage-clustered bootstrap; worthwhile effect +0.10, lower bound above 0), with
margins for human agreement and order consistency (-0.05), clean-control
critical findings (at most 0.05) and cost per case (at most 2x). Ties,
abstentions, flips, invalid replies and missing calls count as failures,
including a clean control the challenger did not answer validly, which counts
against the critical-finding ceiling. The analysis reuses the R06 label
validators and consensus rule and the R-study lineage bootstrap, and reports the
challenger's validly answered cases through the calibration analyzer, per
dimension; those dimension results are exploratory and outside the decision. Each request is quoted
before dispatch with the Studio reservation policy and admitted against a run cap
and the office daily ledger; the first provider error stops the run; a paid run
must confirm the plan hash. Synthetic and quote-only runs measure no judgment.
No outcome admits the challenger; the best outcome is shadow eligibility under
section 8. The golden-brief corpus is development material only.
