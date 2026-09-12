# Hawdesign remediation contract: fresh reality check

2026-09-09. Source HEAD remains `f597bffbf8af3fb1bc65f1028dc161f095ab9ccf`. This pass verifies the proposed remediation, not a new completed release. No application source, deployed configuration, database rows, credentials, or running containers were changed. The original audit remains intact.

**Verdict:** the critical audit findings still reproduce. Starting with honest publication states and durable storage is sound, but the proposed nine-step list understates the work and is not sufficient as written. Database access, schema compatibility, least privilege, atomic writes, and preservation of current volatile state must come before a production persistence cutover. Authentication cannot wait until after the system starts persisting privileged actions.

The 2/10 rating is an expert judgment, not an experimentally exact quantity. The material facts are the repeated boundary failures. Perfect-score language should not migrate from marketing into the audit itself.

## Newly verified blockers

| Observation | Fresh evidence | Consequence |
|---|---|---|
| The database really contains 52 application tables, under schema `hawa` | `database.log`: `hawa|52` | Table count was real. Existence is not evidence that Core uses them. An initial public-schema lookup found none; the corrected qualified lookup established the actual schema. |
| `hawa.tasks` and `hawa.task_events` both contain zero rows, while the live API reports one task | `database.log`, `summary.json` | At this observation, the live task is not in those operational ledger tables. Preserve the volatile task before production restart or replacement. |
| Core's actual `DATABASE_URL` fails authentication | `core-db-connection.json`: SQLSTATE `28P01` | Merely importing the DB repository will not produce a working database connection. No secret value was printed or changed. |
| The configured database username corresponds to a superuser/BYPASSRLS role | `database.log`: both role flags true | Correcting the password alone would still leave application access overly privileged; forced RLS does not constrain a superuser. Use a separate restricted application role. |
| Repository and SQL disagree | `sql-contract-errors.log`; `packages/db/src/types.ts:68`; `db/schema.sql:226` | Repositories query unqualified `tasks`, use `status` instead of `state`, string priorities instead of constrained integers, and fields absent from the normative table. Runtime friendly IDs also need explicit mapping to UUID identities. |
| Outbox repository targets a nonexistent table | SQL query rejects `hawa.outbox`; schema declares `hawa.outbox_commands` | The existing outbox cannot simply be wired into Core as-is. |
| RLS context setter emits an unsupported parameter position | `packages/db/src/client.ts:32` uses parameterized `SET LOCAL`; equivalent SQL rejects `$1` | Use parameterized `set_config` inside the transaction and verify context cleanup. The SQL syntax was checked via the database socket; the repository itself could not execute through Core because its connection fails first. |
| Repository writes do not establish an atomic aggregate | `task.repository.ts:32`, `:84`; `outbox.repository.ts:30` | Task/event creation is separate unless a transaction is deliberately supplied; status updates do not compare expected state/version; leasePending ignores its limit and has no expiring lease handling. |

## Earlier failures rerun in isolated processes

`summary.json`, `probes.json`, `restart-probe.json`, and `restate.log` record the current results:

- Fake bearer text and spoofed Desk header each return task-create 201.
- Unauthenticated decision returns 201 and the empty-design task becomes APPROVED.
- Foreign-task revision decision returns 201. This records a bad decision; it is not proof of a foreign-task publication.
- Missing physical file publication returns complete and verified, with zero network attempts.
- Deliberately wrong model gets 200/200 correct according to the current evaluator.
- Previously acknowledged isolated task returns 404 from a new process.
- Running Restate registry still has zero services.
- Fresh `pnpm test`: **400 passed, 3 failed** across 62 files. Failures are ingress-state expectations. No current all-green claim is valid.

The original probe script was copied into this new evidence folder with its output path adjusted; original evidence was not overwritten. Its writes occur only in separate in-process test apps, not in production. SQL checks used read-only transactions. The failed attempted Core query batch is not claimed as successful testing; connection failure is separately captured, and equivalent SQL statements were then tested via the local PostgreSQL socket.

## Corrections to the proposed nine steps

1. **Fail-closed is containment, not a working publisher.** Replacing fake success with unavailable is necessary, but does not complete delivery. Audit every caller: core publish, chat publish, standalone editor, export-package, reconciliation, health, and UI badges. They must not invent receipts or ignore failure. The supported result types/API schemas also need to express pending, failed, and unverified states without fabricating required Drive IDs.
2. **Do not persist spoofed authority.** Establish authenticated actor/client context before accepting writes into durable production storage. Otherwise forged approvals become persistent forged approvals. Testing a private endpoint is not an authorization policy.
3. **Storage is an atomic aggregate, not Map serialization.** Task, event, expected aggregate version, and outbox command must commit together. Revision documents and approvals must also remain available after restart. A JSON snapshot of Maps would preserve the wrong schema and omit concurrency guarantees.
4. **Restate registration alone is not acceptance.** A registered service must receive real durable invocations, journal effects, survive interruption, and resolve unknown remote outcomes by readback. A health response or service name proves none of that.
5. **Do not use HTTP 422 for every failure.** Invalid factual copy or missing required design assets can be 422. Missing identity is 401; denied permission is 403; stale revision/idempotency-body conflict is 409; unavailable required dependency is 503. An unknown remote delivery outcome must remain pending/unverified until reconciled, rather than being blindly retried as a known failure.
6. **Repair the test oracle, not just three assertions.** First establish the intended asynchronous ingress contract. An ingress acknowledgment and later human_review state are different facts. Prove invalid inputs fail and valid tasks progress through real workflow evidence. Do not relabel every state to the observed value just to turn green.
7. **Mock tests still have a legitimate place.** Put fakes in explicit test-only dependencies. Production paths may never silently select them. Add tests showing that malformed, missing, stale, or wrong results fail—even when filenames and request titles differ from the original audit examples.
8. **Real adapter qualification is missing from the rewritten list.** It still requires a real editable source create/save/reopen, independent export inspection, real Drive upload/readback, and one verified Sheet row. Purging mocks does not satisfy those requirements.
9. **Restore in a disposable environment.** The recovery drill must dump real test-populated data, restore it into an empty isolated database/stack, and verify tasks, revisions, events, approvals, assets, permissions, and resumed workflow behavior. Do not wipe the production database to prove this. RPO/RTO measurements and artifact checks are required.

## Where implementation should begin

**Milestone A: an honest, authenticated, durable intake slice with publication explicitly unavailable.** This is narrower and more testable than announcing Steps 1–2 complete across the entire app.

| Order | Work | Evidence required before moving on |
|---|---|---|
| A0 | Preserve current live task and related volatile state; establish exact source/deployment baseline | Sanitized inventory, export checksums and recoverability check; original remains available |
| A1 | Contain all fabricated completion and unverified approval paths | No success receipt or COMPLETE state without real evidence; all callers render unavailable/failure truthfully |
| A2 | Repair DB connectivity and restricted role; align schema-qualified types/repositories and RLS context | Actual app connection; correct mappings; forbidden cross-client access denied under non-superuser role |
| A3 | Implement one authenticated task-create/read path backed by task/event/outbox transaction | 201 only after commit; DB unavailable produces no acknowledged task; no memory fallback |
| A4 | Enforce stable idempotency and optimistic concurrency | Same key/body returns one result; same key/different body rejects; concurrent duplicate attempts create one task/event/command; stale writer conflicts |
| A5 | Prove persistence and rollback under failure in isolated stack | API restart and container recreation preserve task; interrupted transaction produces all-or-none rows; reconnect succeeds; independent SQL readback agrees with API |
| A6 | Migrate remaining maps by aggregate and test each journey | No stale in-memory read path; events/revisions/approvals survive restarts together; lifecycle tests cover actual DB rather than a fake query builder |

After A, wire actual Restate invocation and approval/QA gates, then real publisher/source adapters. Only then enable external publication. Follow with UX correction, ground-truth evaluations, full restore, and the real office pilot. Each milestone retains a reproducible evidence directory and traceability IDs; none earns an automatic 10/10 badge.

Relevant requirements: NFR-001 (no lost acknowledged event), NFR-003 (recovery), NFR-015/FR-069 (attribution), FR-043/044 (approval), FR-047–050 (publication and reconciliation), FR-060 (workflow recovery). Relevant normative sources: `MASTER_SPEC.md`, `docs/10_WORKFLOW_RELIABILITY.md`, `docs/13_GOOGLE_DRIVE_SHEETS.md`, `docs/14_SECURITY_THREAT_MODEL.md`, `db/schema.sql`, `db/rls.sql`, and `docs/29_ACCEPTANCE_GATES.md`.

**Status: reality check completed; remediation not implemented.** The existing system still has the defects above. This evidence should be used to approve or execute concrete milestones, never as a replacement completion certificate.
