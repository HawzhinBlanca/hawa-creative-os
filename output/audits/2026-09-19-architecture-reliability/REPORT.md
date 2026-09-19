# Hawdesign architecture and reliability audit
Date: 2026-09-19. Source: `664ad55b85930b3cd29c6be170fc13f0d2876f66`. Scope: Hawdesign in this workspace, not the earlier ChatGPT/Consensus health project.

## Verdict
**Not production-qualified against its own specification. Not “10/10.”** Several important guarantees are contradicted by reproducible counterexamples, not merely missing documentation. A dependable, bounded office system is achievable on this foundation. Absolute reliability and universally top-tier creative output are not provable promises.

The problem is less the choice of technologies than gaps between the intended boundaries and their implementation: authoritative state in process memory; non-idempotent effects outside the durable workflow; incomplete scope/approval checks; and evidence that sometimes claims more than it measures. More models, agents, connectors, or a wholesale framework rewrite would not repair these guarantees.

Use [TASK_SHEET.md](TASK_SHEET.md) for the ordered remediation and [PROOF_REQUEST.md](PROOF_REQUEST.md) as the completion contract. No remediation task is completed by this audit.

## Evidence and limitations
Three independent bounded reviews covered security/architecture, durable effects, and evaluation integrity. They used current source plus isolated synthetic probes. Root ran local checks and read-only production container/database settings. No app implementation, deployment, production record, external publication, or paid model request was changed by this audit.

Evidence labels:
- **REPRODUCED:** a saved isolated counterexample exercised the actual source. It is not a live-provider or production exploit.
- **SOURCE-CONFIRMED:** the current implementation shows the defect; full deployed reproduction not attempted.
- **OBSERVED:** read-only current runtime measurement.
- **UNQUALIFIED:** sufficient proof was not found; this alone is not proof the capability fails.

This is a deep targeted audit, not an exhaustive penetration test or a full production qualification. No full test suite, real-provider crash drill, clean-host disaster recovery, sustained load test, or blind human design assessment was run.

## Highest-priority findings
| ID | Finding and consequence | Evidence | Requirements |
|---|---|---|---|
| F01 | Publisher fresh-instance replay and concurrent calls duplicate Drive files and Sheets rows. Lost successful responses also produce duplicates; a moved Sheet row can cause another task's row to be overwritten. Two publication routes use different logical keys. | REPRODUCED with fresh instances, concurrency, moved rows and injected response loss; source confirmation for route-key divergence. Not a live process-kill drill. [Durability details](DURABILITY_FINDINGS.md). | FR-047, FR-049, FR-060; NFR-001 |
| F02 | Publication initially accepts a deliberately incorrect remote checksum as verified. Matching name/size/type is insufficient content proof. | REPRODUCED: wrong remote SHA-256 still yields complete/verified. Later read-back improvements do not fix this initial completion gate. | FR-048; NFR-020 |
| F03 | Client DNA/snapshots and policy surfaces remain process-local. An acknowledged change is not authoritative durable state; snapshot authors can come from request bodies. | REPRODUCED DNA loss after new app instance and spoofed author; production route has no DB branch. `apps/core/src/app.ts:6497–6576`. | FR-017, FR-069, FR-078; NFR-001, NFR-015 |
| F04 | Studio access is tenant-only, not client/user-scoped; operations do not consistently bind URL task, stored run and actor. SSE broadcasts lack per-subscriber scope filtering. | SOURCE-CONFIRMED; isolated wrong-task abandon reproduction. No live cross-client exploit attempted. [Security details](SECURITY_ARCHITECTURE_FINDINGS.md). | FR-011, FR-043, FR-077; NFR-006 |
| F05 | Approval pins are task-scoped, without a complete artifact/revision/binding/QC relationship. QC selection is not explicitly latest/current attempt. | SOURCE-CONFIRMED; old-export and earlier-PASS/later-FAIL acceptance require integration negatives. Do not mislabel permissive DB-free tests as a production bypass. | FR-041, FR-044, FR-045; NFR-020 |
| F06 | Editable transfer silently changes supported visual properties: ellipse becomes rectangle; rotation, transparency, stroke and text properties are lost while the manifest retains richer claims. | REPRODUCED in generated PPTX XML; no Canva live round-trip run. V2 is disabled in observed production. | NFR-008, NFR-009; FR-075 |
| F07 | Worker terminal notification errors are swallowed into journalled success; direct Core send and unregistered default notification transport leave recovery incomplete. Partial publication can hydrate into a state ordinary retry rejects. | SOURCE-CONFIRMED. Workflow existence does not make every external effect durable. | FR-051, FR-059, FR-060, FR-064 |
| F08 | Evaluation outputs can falsely qualify empty evidence or an always-abstain model. Legacy acceptance reports redefine normative gates; local CI prints global ship-readiness without proving it. | REPRODUCED: missing metrics become 8.5/9.0 scores, 100% swap consistency and matching parity; always-abstain gets 200/200. [Evaluation details](PROOF_QUALITY_FINDINGS.md). | FR-057; NFR-024, NFR-025 |
| F09 | The deployed build is older than source fixes; tested component quality is not the observed production lane. | OBSERVED stamp `5180108`; both design flags off. Two container source hashes exactly match that commit, not HEAD. See [RUNTIME_EVIDENCE.json](RUNTIME_EVIDENCE.json). | NFR-013, NFR-025 |
| F10 | Recovery is not qualified to RPO ≤15 minutes / RTO ≤4 hours. Active production WAL archiving is off. Nightly script defaults to another same-host folder, not encrypted independent off-host storage, and can ignore remote upload failure. | OBSERVED DB settings; SOURCE-CONFIRMED script; clean-host recoverability UNQUALIFIED. Alternative pgBackRest/restic scripts exist but their deployed operation was not established. | FR-070; NFR-003 |
| F11 | Shared static role credentials, browser token storage and query-token paths weaken attributable, revocable least-privilege access. | SOURCE-CONFIRMED, not proof of current compromise. Prioritize alongside scope enforcement before multi-user exposure. | FR-043, FR-069; NFR-006, NFR-015 |

### Current runtime evidence
Production Core reports commit `5180108b824a30551731f11eb9f677abb9f29c65`. Its included `app.ts` SHA-256 is `83ef0ed0badeb016bc3f6469d4a25230452df7f61c24e1387fe9abb86f44f4c8`; publisher SHA-256 is `dd5102b67f16d27bc7020af62b28c79ce443e1963344531a9fedeecf6936a482`. Both match `git show 5180108:<path>`; HEAD differs. This verifies two included sources, not every compiled artifact's provenance. Both DESIGN_PIPELINE_V3 and DESIGN_STUDIO_V2 are off. Do not enable them merely because a newer component report says PASS.

Read-only `SHOW archive_mode; SHOW archive_command; SHOW wal_level;` returned `off`, `(disabled)`, `replica`. This disproves an active WAL-archiving/PITR claim for this instance, not the existence of all other backups. `infra/backup/nightly_backup.sh:31–51` restores a dump into the same PostgreSQL server, strips owner/privilege restoration, checks counts, then archives locally by default. `deployment/backup.sh` and `deployment/restore-test.sh` describe a stronger separate path; existence is not operational evidence. The weekly schema drill explicitly contains no production data and is not an office disaster-recovery proof.

### Positive evidence that must not be discarded
- Modular packages, PostgreSQL, durable workflow infrastructure, explicit contracts, content hashes, Canva adapters and many useful regression tests are real assets.
- Today's source fixes remove fabricated publication bytes/row numbers, make reconciliation honestly audit-only, pin selected exports, use real QA and improve read-back/completion handling. Those changes deserve credit but are not all deployed.
- September 18 P10 evidence contains real provider receipts and 20 component runs. Its mixed-commit, narrow-archetype, same-model judging scope does not establish full delivery reliability or independent human quality.
- Selected local verification today: typecheck PASS; blueprint validator 591 PASS / 0 FAIL; 7 test files / 60 tests PASS. These are useful checks, not acceptance Gates A–H.
- Security scanner self-test PASS, but repository scan FAILED on a disposable test credential literal at `apps/desk/test/desk-auth.test.ts:18`. This appears to be a fixture false positive, not an established leaked credential. Fix the fixture classification narrowly; do not weaken scanning globally.

## Architecture worth retaining, boundaries worth repairing
Keep the selected Canva-first workflow, PostgreSQL, current durable workflow engine and ports/adapters. ADR 025 retires old editors; ADR 030's latest amendment allows the configured provider choices. Do not resurrect archived editor admissions or treat old model-policy wording as current.

Required execution shape:

`authenticated scoped command → DB transaction (state + audit + outbox) → durable effect worker → provider receipt/read-back → DB reconciliation → verified completion`

Each arrow crossing a side-effect boundary needs a stable identity, expected revision/fencing where appropriate, persisted intent, honest unknown outcomes and an explicit recovery rule. HTTP routes should delegate to application services enforcing these invariants; a giant route file is not itself a proof of failure, but the duplicated state/side-effect rules here are.

An approval must name one immutable tuple: tenant/client/task, revision, Canva binding/capture version, source hash, export hashes, QC report/hash/profile, and authenticated approver. Publication consumes that tuple, not whatever is newest or merely belongs to the task.

“Exactly once” must mean one logical result under at-least-once delivery with reconciliation—not a claim that network delivery itself happens only once. Where a provider cannot resolve an ambiguous send safely, expose an uncertain state for authorized resolution rather than blindly retrying.

## What would justify a release
All blocking task gates must pass on one identifiable build/configuration; independently inspect the raw results. Then complete the normative 3-client / ≥100-production-task pilot with no critical isolation, factual-copy, wrong-approval or data-loss escapes and ≥95% completion without technical rescue. Measure stated latency, cost, availability and recovery targets. Require native-language and blinded human design review separately from machine QA.

A credible outcome is **qualified for named workflows, clients, versions and limits**, with known residual risks. Never “all future designs are 10/10.” A single counterexample is enough to reject the present guarantee; a collection of passing tests is not enough to establish an unlimited one.
