# Hawdesign: current-system audit and route to excellence

20 September 2026 · Audited commit `9c22026f444c81494d286354960a0b10efaa1176`

## Verdict

**Promising architecture; advanced beta; not independently production-qualified.** My rough engineering judgment is **5/10 overall**, with **7/10 architectural direction, 4/10 production trust and 2/10 qualification integrity**. These are subjective maturity judgments, not calculated benchmark scores, probabilities, or a global ranking. Creative superiority is **unmeasured**: assigning it a numerical rating would pretend we ran comparisons we did not run.

The important bottleneck is no longer a missing model or framework. The system can still acknowledge non-durable changes, bypass authorization, duplicate delivery, overwrite unrelated data, and certify failures as successes. Adding intelligence on top does not resolve those defects. The chosen Canva/PostgreSQL/Restate foundations are viable; replacing them is not justified by this audit.

“World-class” is a defensible target for a defined workload—editable, brand-correct Sorani/Arabic/English office design—but cannot mean perfect reliability or universal creative superiority. This is an inference and a recommended product focus, not a measured ranking.

## What changed, and what I actually checked

Three independent audit workstreams inspected security/state, durable delivery, and qualification/creative quality. The root auditor replayed their isolated counterexamples and checked release, recovery, operational measurement and runtime provenance. The code-review skill structured the security/correctness review and separation of defects from missing evidence.

Read-only runtime inspection found Core stamped with the audited commit. Three selected source hashes inside Core matched the checkout: Core app, Google publisher and Studio transfer-v2. This corrects the September 19 stale-runtime observation, but is **not** complete compiled-image attestation. Worker and Core were recreated September 20; Desk's container was older. Both global Studio flags were off, **but two allowlisted pilot chats can still run the pipeline**. PostgreSQL `archive_mode` was off and `archive_command` disabled. No private chat identifiers or credentials were retained. Container IDs, flag counts and source readback are in [RUNTIME_OBSERVATIONS.json](RUNTIME_OBSERVATIONS.json).

Real improvements credited: healthy moved-row reconciliation; shared publication keys; publication intent ordering; approval row locking and latest-QA selection; terminal notification enqueue; rejection of absent judge votes; better editable-transfer property mapping; corrected always-abstain scoring; removal of invented live-evaluation defaults and unused paid critique. Backup tooling also gained optional encryption and decrypt verification. These repairs matter, but do not establish full qualification.

## Current release-blocking counterexamples

These are actual application/adapter/evaluator code executed against isolated transport or database doubles—not production exploitation. Each report distinguishes execution from source-only findings.

| Boundary | Fresh observation | Consequence |
|---|---|---|
| Authorization | Operator supplies administrator role to DNA rollback; handler returns 200 and administrator attribution | Caller-controlled privilege remains on a mutation route |
| Client isolation | Candidate belonging to one client can be promoted through another client's URL; task-only events can escape scoped SSE filtering | Scope is not enforced uniformly |
| Durable state | UI-style client alias misses database lookup; DNA update returns 201 with zero database transactions | “Saved” can still mean only process memory |
| Publication | Fresh instance/concurrency/lost success response creates duplicate files or rows | An intent row is not yet restart-safe reconciliation |
| Sheet safety | Shift row, fail identity lookup with 503: unrelated row overwritten; COMPLETE returned | New identity check fails open on uncertainty |
| Completion | Wrong remote checksum, same size/type: initial publication still verified/COMPLETE | Delivered content not truly verified at completion |
| Notification | Core 503 is swallowed inside journaled step; replay never requests notification again | Work may finish without durable terminal notification |
| Qualification | Force every tournament component to fail: four roles ADMITTED, overall QUALIFIED, exit 0 | “Qualified” is partly hardcoded rather than measured |
| Evaluation coverage | Missing client/project/brief passes 200/200; only 1 of 24 swap measurements yields 100% PASS | Missing evidence disappears from success criteria |
| Release identity | Verifier accepts fabricated commit, dirty tree and empty component/model coverage | Self-consistent manifest is not proof of deployed identity |

Detailed locations, requirement mappings and replays: [security/state](SECURITY_ARCHITECTURE_FINDINGS.md), [durability](DURABILITY_FINDINGS.md), [proof quality](PROOF_QUALITY_FINDINGS.md), and [root execution results](ROOT_EXECUTION_RESULTS.json). The release probe uses an in-memory synthetic manifest and does not replace the real one. The tournament probe intercepts its output write; the unchanged runner's “wrote evidence” console line is not an actual file write.

Additional source-confirmed gaps: persisted intents are best-effort before external writes; the production outbox consumer has no working notification transport registered; export approval does not enforce the complete revision→capture→QA→approval lineage; Studio read authorization remains broader than client scope. No real database corruption/exploit was attempted to establish these source findings.

## Why the new proof dossiers still overclaim

- **Pilot:** R14's test ends at synthetic approval, not verified production delivery. Leakage/flattening counters are initialized to zero, not measured. Useful route integration is mislabeled as a 100-task production pilot.
- **Human quality:** R13 is labeled qualified although genuine blind ratings remain absent. A valid CSV does not authenticate human judgments. XML transfer checks are useful but cannot prove native Canva edit/save/reopen fidelity.
- **Recovery:** `scripts/disaster_recovery_drill.sh` performs useful isolated database restoration, but its RPO is marker-to-backup elapsed time, not data loss after a disaster (line 182); RTO stops before the whole service is usable (254–255). Workflow resumption is inferred from pending-row counts (309–312). Test assets and event samples do not restore production editable assets and Restate execution state. Default replica is same-host and the encryption fallback is a committed default. The recorded result therefore does not qualify whole-system clean-host RPO/RTO. Current off-host backup configuration was not independently inspected.
- **Operations:** `scripts/measure_operations_slo.ts` records successful-request latency and derives successful count from total count (284–287), omitting request failures. Local queue/backoff exercises do not prove production load capacity or monthly availability. Empty latency samples must not score zero and pass.
- **Release:** `scripts/enforce_release_gate.sh` permits `--skip-tests` yet emits qualification; named A–H statuses are hardcoded (214–226). `infra/docker/deploy.sh:82` uses check-and-echo lists whose failure does not abort under shell error mode; an isolated shell-semantics probe confirmed this, without running deployment. The current release manifest verifier passed while blueprint integrity failed. These measure different things and must not be conflated.

## Verification ledger

| Executed check | Result and honest scope |
|---|---|
| Typecheck | PASS |
| Blueprint/package integrity | **FAIL: 601 passed, 10 failed**; stale hashes, sizes and coverage |
| Secret scan self-test / final scan | PASS; initial new-audit fixture false positives corrected without weakening scanner |
| Current manifest verifier | PASS, but fresh negative control demonstrates inadequate validation |
| R09 saved-evidence tests | 8 PASS; tests assert saved report fields, **not a fresh restore** |
| Six isolated probe families plus shell semantics | Replayed; counterexamples above confirmed |
| Full test suite, production fault injection, clean-host restore, live model benchmark, native-editor roundtrip, blind human evaluation | **NOT RUN in this audit** |

No application code was changed, no deployment performed and no paid provider generation requested. Only audit artifacts and a concise memory update were written. This is a deep bounded audit, not an exhaustive penetration test or assurance that no further defects exist.

## Research-backed direction

Primary sources checked on 20 September 2026:

- [Google SRE: implementing SLOs](https://sre.google/workbook/implementing-slos/) defines service objectives around user experience and good events divided by all eligible events, rather than an absolute reliability promise. Apply this to verified delivery, latency, failures and operator rescue; decide release policy from measured error budgets.
- [AWS: transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) explains atomic state/event recording and idempotent processing despite duplicate delivery. Apply it to mandatory intent persistence and effect reconciliation, not merely inserting an optional row.
- [PostgreSQL 17: continuous archiving](https://www.postgresql.org/docs/17/continuous-archiving.html) distinguishes base backups plus WAL recovery from logical dumps. Select a recovery method that demonstrates the stated data-loss target and separately recover configuration, assets and workflow state.
- [OWASP ASVS](https://owasp.org/projects/asvs) supplies testable application-security requirements. Use a scoped review of authentication, authorization, data protection and logging; do not label the app compliant simply because a scanner passes.
- [Zheng et al.: LLM-as-a-judge](https://arxiv.org/abs/2306.05685) documents judge biases and human comparison. It supports human calibration and order-sensitivity checks—not importing its chatbot agreement numbers into graphic design.
- [Graphic-Design-Bench, April 2026](https://arxiv.org/abs/2604.04192) evaluates complementary layout, typography, text, perceptual and structural capabilities. Adapt relevant held-out tasks alongside local native-script/brand tests. Its [official implementation](https://github.com/lica-world/GDB) documents incomplete coverage and evolving definitions; pin and verify before use. This research does not establish Hawdesign's rank.

The resulting recommendation is to **repair trustworthy measurement first, then authoritative boundaries and real recovery, then prove creative advantage on held-out work**. Preserve ADR-030's selected model-family policy; independent human judging does not require adding another model provider. No new framework or vector database is justified without a measured bottleneck.

## Completion target

Follow [TASK_SHEET.md](TASK_SHEET.md) in dependency order. Require raw independently replayable evidence, exact release identity, genuine human decisions and a real three-client/100-task pilot. Ship only when the applicable normative A–H gates are actually satisfied. No report, model vote or count of passing tests may substitute for an unexecuted acceptance gate.
