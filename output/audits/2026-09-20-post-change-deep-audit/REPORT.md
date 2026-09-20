# Hawdesign — post-change deep audit

20 September 2026. Candidate snapshot: **20:51:31 UTC / 23:51:31 Baghdad**, HEAD `6d3c583791a404c914e25b77dda558b16d26bd6c` **plus uncommitted changes**. Exact file hashes and raw results are in `ROOT_RESULTS.json`. Files changed repeatedly during review; earlier findings below were explicitly replayed against the newer edits. This report supersedes the initial sub-reports where their amendment says so. **FINAL_RECHECK.json records the final runtime/manifest replay and the later blueprint failure: 617 PASS / 2 FAIL.** Finding-source hashes remained unchanged at the final comparison; release metadata changed separately.

## Verdict

**Substantial, real improvement. Still NOT qualified as a robust production system, and no evidence supports “world best” or 10/10.** The selected architecture is viable; a rewrite or another agent framework is not the immediate need. The remaining weaknesses are durable effect reconciliation, enforced client boundaries, trustworthy admission/evaluation, and whole-system recovery proof. Creative superiority has not been measured by this audit.

The code-review skill guided the review toward negative controls, authorization and persistence boundaries rather than test-count claims. No application fixes, deployments, production mutations, provider sends or paid generation were performed. New audit artifacts and memory notes are the only intentional writes. Original evidence was not overwritten. Read-only runtime/aggregate database observations and constant-expression queries in isolated PostgreSQL are labelled separately from offline doubles.

## Genuine fixes, including changes made during this audit

| Boundary | Fresh observation | Limit |
|---|---|---|
| Missing authoritative client | Promotion 404; DNA **and proposal status** unchanged | Offline real-route test with explicit DB double |
| Rejected transaction | Promotion 500; rule absent, version stays 1, proposal stays PROPOSED | Actual persistence/restart still needs isolated DB test |
| Historical snapshot | Promotion no longer changes previous snapshot; saved hash still matches | Served process-memory snapshot tested |
| Rule permissions | Forged-role rollback 403; cross-client promote and dismiss 403 | Full principal/client matrix not executed |
| Authorized live update | Successful DNA edit now reaches authorized SSE subscriber | Cross-instance revocation and multi-tenant producers not qualified |
| Notification enqueue/retry | Core persistence failure refuses; local journal step throws on 503; invalid receipt becomes uncertain with zero scheduled retries | Manual replay is not real Restate crash recovery |
| Export query | Invalid JSONB comparison repaired; missing binding now returns no exports; actual constant SQL accepts passing checks and rejects copy/font/status failure | Full edit/QA/export/approval race not executed |
| Model tournament | Default simulation refuses admission; newest `--live` explicitly exits 1 before fake execution | Real live tournament remains unavailable/unqualified |
| Availability report | All 111 injected requests fail: report now says FAILED, zero-sample latency groups noncompliant, traces say HTTP 503 | CLI still exits 0 after returning failed evidence; queue portions remain simulations |
| Native-copy tests | Replacing all approved copy now fails the actual assertion bodies; baseline passes | Appending unauthorized copy still passes; see F5 |
| Publication | Full-column lookup 503 refuses completion; wrong reported checksum rejects; lost Sheet append reply reconciles in the tested case | Fresh-process/lost Drive reply/concurrent effects still fail |

**Do not continue reporting the earlier rejected-save, mutated historical-snapshot, cross-client dismiss, dropped authorized-event, all-outage QUALIFIED, or `--live` fake-admission counterexamples as current local defects.** They failed on the earlier candidate and are now repaired at the tested boundaries. Initial raw results remain historical evidence, not the latest verdict.

## Remaining findings

### F1 — P1: manifest verification executes manifest text as a shell command

[`scripts/verify_release_manifest.ts:82`](/Users/hawzhin/Hawdesign/scripts/verify_release_manifest.ts:82) checks only that the commit string has 40 characters; line 87 interpolates it into `execSync`. The real verifier executed a fixed harmless `printf` marker embedded in a synthetic in-memory commit field. No file or network effect was used. A correctly recomputed self-checksum did not prevent it.

This is command execution **when someone runs the verifier on an attacker-controlled manifest**, not a demonstrated public HTTP exploit. The dirty-tree rejection happens later, so it does not protect the command boundary. Use strict commit syntax and argument-array process execution; reject invalid schema before using fields. Reproduce with `node --import tsx output/audits/2026-09-20-post-change-deep-audit/release-boundaries.mjs`.

The same probe also demonstrates weak identity validation: with the explicit existing `VITEST=true` dirty-tree bypass to isolate other predicates, an old real commit, invented component image names/models, and README-only source coverage pass. The normal dirty-tree refusal **does work**; the experiment does not claim it was bypassed without that test environment. Existing-commit validation never compares it to HEAD because that comparison is mistakenly nested under `if (!commitExists)`.

### F2 — P1: the release certificate still declares acceptance gates it does not measure

[`scripts/enforce_release_gate.sh:221`](/Users/hawzhin/Hawdesign/scripts/enforce_release_gate.sh:221) emits literal PASS values for seven named gates and `negativeRefusalTest.verified: true`. These are not computed from actual current publication, recovery, native-editing, scope or human-review evidence. The names also differ from normative A–H in `docs/29_ACCEPTANCE_GATES.md` (A Studio, B scope, C workflows, D models, E QA, F human review, G publication, H recovery).

[`infra/docker/deploy.sh:81`](/Users/hawzhin/Hawdesign/infra/docker/deploy.sh:81) checks secrets, pack and local state, but does not invoke this master gate or validate a current evidence attestation before applying. A non-empty build stamp is not immutable build identity. Existing release evidence reports 1,584 passing tests; this audit did not rerun that full suite or equate its count with business qualification. The recent fix that makes skipped tests unqualified deserves credit, but it does not repair unrelated literal gate declarations.

### F3 — P1: publication is not crash-safe or safe against Sheet row movement

Fresh independent replay of the **actual publisher with a synthetic provider transport** reproduced:

- New adapter instances, same command: **2 files / 1 row**.
- Drive accepts upload but reply is lost, then retry: **2 files / 1 row**, eventually COMPLETE.
- Concurrent same-adapter calls: **2 files / 2 rows**, both COMPLETE.
- Another task's row moves into the previously located position between lookup and PUT: **the unrelated row is overwritten**, duplicate own-task rows remain, result COMPLETE.
- Missing remote checksum: file still marked verified/COMPLETE. Changed destination under the same key returns the earlier folder instead of a conflict.

Source: unconditional upload at [`google-publisher.ts:298`](/Users/hawzhin/Hawdesign/packages/integrations/src/google-publisher.ts:298), in-memory receipts at 439, positional Sheet lookup/update at 519/531. Core now persists intent before publication and returns previously completed records, both good fixes; incomplete records still do not supply durable per-effect recovery, and process-local fencing cannot establish multi-process ownership. These are component fault experiments, not claims that live customer duplicates were observed.

Need immutable command/destination hashes, durable claim/lease, per-effect identity/receipt and remote reconciliation. A successful identity read is not an atomic identity-bound Sheet write. Enforce a safe ownership/write protocol and test insert/sort/move/delete interleavings with untouched sentinel rows.

### F4 — P1: evaluator still gives perfect results to ambiguous or invalid responses

Fresh actual evaluator run: one response naming **all clients and projects at once**, with wrong copy, passes **200/200** routing cases. Fixed sentinel exemptions and substring matching remain at [`packages/evals/src/runner.ts:116`](/Users/hawzhin/Hawdesign/packages/evals/src/runner.ts:116) and 134. This cannot establish exact client identity or fact preservation.

An injected visual response `{decision: 'NOT_A_VALID_VERDICT', passed: 'false'}` scores **10/10** because invalid values are not strictly schema-checked and the string is truthy. This evaluator path sends no image. See runner 347–402. This is distinct from the production pairwise judge; the result must not be generalized to that other code path. The latest tournament entry-point refusal closes simulated admission, but it does not fix these scoring defects.

### F5 — P1 for factual-copy acceptance: new text checks prove presence, not exactness

The latest W06 tests now catch wholesale replacement of required text. However, their new `toContain` checks at [`native-script-fidelity.test.ts:122`](/Users/hawzhin/Hawdesign/packages/creative/test/native-script-fidelity.test.ts:122) and 213 allow additional unauthorized claims.

A new mutation preserves each approved text and appends `AUDIT UNAPPROVED EXTRA CLAIM 999999` before the real encoder. All **60 actual PPTX exports** independently contain the extra text; **all five actual test bodies still pass**, and their component evidence says PASSED. Baseline also passes. Reproduce `proof-native-copy-mutation.mjs --append-copy` with `node --import tsx`.

This is a **test-sensitivity defect, not evidence that the unmodified encoder invents text**. The harness uses real encoder/QA and actual test bodies with a lightweight assertion facade; it does not claim a full Vitest run. Compare all extracted logical blocks exactly against authorized source, including count, sequence, duplicates and extras; test rendered/native fidelity separately with real editor round trips and native-speaking reviewers.

### F6 — P1 before restricted-client admission: Studio read scope remains tenant-only

Source inspection: [`design-studio.repository.ts:140`](/Users/hawzhin/Hawdesign/packages/db/src/repositories/design-studio.repository.ts:140) loads by run and tenant; [`design-studio.routes.ts:140`](/Users/hawzhin/Hawdesign/apps/core/src/routes/design-studio.routes.ts:140) returns evidence without a client-membership check. The five Studio RLS policies in migration 013 use `app.tenant_id`, not client membership. Setting an unused client context is not enforcement.

No deployed restricted-user exploit was attempted; current broad office roles and flags affect exposure. This remains an unclosed client-isolation acceptance requirement. Verify same-tenant/different-client access as the actual non-owner application role, plus cross-tenant and revocation controls, across reads, writes and provider effects.

### F7 — P1 qualification gap: the new DR report is not whole-office recovery proof

The latest saved drill has real database backup/restore evidence and reports RPO 15s/RTO 10s. Those numbers measure narrower operations than the claim:

- `RPO_SECONDS = BACKUP_END_SEC - MARKER_EPOCH` at [`disaster_recovery_drill.sh:203`](/Users/hawzhin/Hawdesign/scripts/disaster_recovery_drill.sh:203) measures elapsed marker-to-backup time, not the recoverable data-loss window after loss of the source host.
- RTO stops at line 276 after DB/asset extraction, before any recovered application/worker is operating.
- The “offhost” destination in this evidence is another directory on this same host; no independent failure domain is demonstrated.
- Assets are test fixtures, compiled Studio files and pricing configuration. Workflow snapshots are outbox plus the last 500 task events, not proof of restoring Restate state and resuming real work.
- Workflow “resumptionSafe” is literal true; the drill only counts pending commands (the latest saved run has zero). It does not run workers and observe continuation.
- The RLS test sets `request.jwt.claims`, while policies use `app.tenant_id`. Read-only reproduction under that drill context sees **zero own rows too**. With only one task tenant present, zero foreign rows proves neither a positive control nor separation from populated foreign data.

This audit did **not** rerun the recovery script: it writes a production marker and changes containers. Require an explicitly authorized, independent-host restore of the complete office with real unfinished work, actual credentials/configuration recovery, positive and negative access controls, verified assets, application readiness and no repeated effects.

## What is actually deployed?

Read-only inspection confirms a real recent deployment of Core/Worker/Desk, healthy containers and build stamp `2f92d0814e34996f8963bf33e7a2f336f3393a97`. So “nothing was deployed” would be wrong. However, the latest local fixes are newer than those running sources:

| Sample | Local hash prefix | Running hash prefix | Meaning |
|---|---|---|---|
| Core app | a15abb3c | bd21c95e | Latest governance/SSE fixes not in sampled running source |
| Canva service | 2fc32b61 | 7c6aee24 | Latest export-query fix not in running source |
| Worker notification step | af6b8880 | db8c2aee | Latest retry fix not in running source |
| Outbox consumer | 9abcc9bb | f6459b2a | Latest invalid-receipt classification not in running source |
| Publisher | f008f297 | f008f297 | Audited publisher matches the sampled running source |

V2/V3 global flags were off, but the pilot allowlist had two entries. This is a bounded source/container inspection, not compiled-image attestation or a live endpoint exploit. A later deploy must be verified again; do not silently attribute local fixes to production.

## Verification limits and next action

Fresh typecheck passed after the intermediate edited-file type error was repaired. Blueprint validation initially passed **619 / 0**, but the final rerun returned **617 PASS / 0 WARN / 2 FAIL**: MANIFEST and SHA256SUMS no longer matched RELEASE_MANIFEST.json while those metadata files were being edited. Do not carry the earlier green result forward. Secret scan passed with no findings in its earlier executed snapshot; it was not rerun after every ongoing edit. These are useful checks, not a production certificate. Exact commands, outputs and source hashes are retained in ROOT_RESULTS.json and FINAL_RECHECK.json. Full monorepo suite, real provider failure matrix, Restate kill/restart, whole-host restore, native Canva fidelity, held-out live-model comparison and human pilot acceptance were **NOT_RUN in this audit**.

See `TASK_SHEET.md` for ordered, falsifiable closure criteria. Repair the evidence/admission mechanism and durable boundaries first, then execute authorized integration/recovery gates, then evaluate creative quality on a sealed holdout with genuine human review. More prompts or models cannot substitute for these proofs.
