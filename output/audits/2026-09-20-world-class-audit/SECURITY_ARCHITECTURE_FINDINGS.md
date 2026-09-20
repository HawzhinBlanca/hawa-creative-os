# Security, scope and authoritative-state re-audit — 20 September 2026

Reviewed source `9c22026f444c81494d286354960a0b10efaa1176`, including remediation `1b9614d`. No application repair, production data mutation, external request or credential inspection was performed. Previous audit artifacts remain unchanged. This report distinguishes executed local defects, source-derived risks and successful fixes. It does not claim a production exploit or a complete penetration test.

## Decision

The remediation contains useful fixes, but the claim that authoritative configuration and scope enforcement are fully qualified does not survive adversarial checks. The strongest blockers are incorrect successful acknowledgments, governance role/client violations, and scope checks that omit missing metadata. A large module is not itself the finding: the actionable architectural problem is multiple mutation paths implementing different authorization and durability rules for the same business object.

## Improvements verified

- DNA POST now ignores a forged `createdBy` and derives the snapshot author from authentication. The rerun returned `operator_1`, not the submitted forged identity (`apps/core/src/app.ts:7546`).
- Studio resume/select/abandon now reject mismatched task IDs and unauthorized actors, with administrator/art-director exceptions. The original wrong-task abandon probe now returns `TASK_SCOPE_MISMATCH` (`apps/core/src/services/design-studio/design-studio-service.ts:1788`). This closes the specific earlier method-level omission; it does not establish read/RLS scope.
- A new `ClientRepository.saveDnaVersion` provides a database write path and optional expected-version check. It is real code, although not all successful route outcomes reach it.
- Initialization only seeds client Maps when empty (`apps/core/src/app.ts:439`), so a second `createApp()` in the same process no longer erases an existing Map. This is different from durable restart recovery: a new OS process still starts with an empty Map.
- SSE now rejects events carrying an explicit foreign tenant/client. Missing metadata remains a separate defect below.

## SA-01 — P1, reproduced: authenticated operator can authorize its own DNA rollback

Location: `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:8535`.

The route selects `body.role || auth.role`, then checks only that selected string. A real operator credential can send `role: "administrator"`, receive HTTP 200 and `rolledBack: true`, and cause a snapshot attributed to `administrator`. The executed probe used the real HTTP route, genuine configured disposable operator-key authentication and in-memory fixture state. No test-only role header was supplied.

Database configuration does not remove the route-level problem: the mutation still runs under the authenticated operator, and the normal database policy allows operators to write client data. The route also updates the Map first and suppresses database errors at line 8598 before returning success. No production mutation was attempted.

Requirements: FR-054, FR-069, FR-078, NFR-006, NFR-020.

Required repair/proof: derive capability exclusively from the authenticated principal and server-side memberships; execute rollback and audit append atomically before acknowledging. A real-DB role matrix must show an operator remains denied even with forged body roles; database failure must leave active DNA/history unchanged and return failure. Verify the resulting author is an individual server identity.

## SA-02 — P1, reproduced: client A's candidate rule can be promoted into client B

Locations: `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:8235` and `:8244`.

Promotion looks up the rule globally by `ruleId`, then applies its text to the DNA selected by the URL `clientId`; it never verifies `result.rule.clientId` equals the URL client. The real routes accepted a Drustee proposal and promoted it through `/clients/client-aster/candidate-rules/<DrusteeRuleId>/promote`; HTTP 200 resulted and Aster's DNA contained the Drustee-only fixture rule. This was executed with a disposable authenticated administrator in process memory, with test-mode disk writing disabled. This is a cross-client integrity defect even if the administrator legitimately has access to both clients.

Governance persistence is also inconsistent: promotion catches database failures and acknowledges at line 8292, while candidate-rule rollback (`:8340`) updates the Map but has no corresponding database write. Thus the database active DNA and the currently executing feedback miner can disagree.

Requirements: FR-017, FR-054, FR-069, NFR-006, NFR-020; fixed-client-scope invariant.

Required repair/proof: use a scoped rule lookup and one transaction for status transition, new DNA version and audit evidence; make rollback symmetrical and durable. Test A-rule/B-URL, B-rule/A-URL, no client membership, missing rule, repeat request, database failure and process restart. Both the original and target client's content hashes must stay unchanged on denial.

## SA-03 — P1, reproduced with database test double: successful DNA save can skip persistence entirely

Locations: `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:7565`, `:7566`, `:7587`; `/Users/hawzhin/Hawdesign/packages/db/src/repositories/client.repository.ts:16`; `/Users/hawzhin/Hawdesign/db/seed.sql:80`.

The normal UI alias `client-drustee` is passed unchanged as a database `clients.code`, but the seeded code is `drustee`. If alias resolution returns no row, the route skips `saveDnaVersion`, updates the Map and returns 201. The executable probe provides a configured fake database returning no matching client: the genuine HTTP handler returns 201 with **zero attempted database transactions**. This test does not use a real PostgreSQL server; the SQL/seed mismatch is independently visible in source. The alias lookup also occurs outside `withRlsContext`, so a real least-privilege connection can fail to resolve even correct codes.

GET DNA and snapshots catch database errors and silently use the Map (`app.ts:7520`, `:7647`), and `/clients` still lists the Map. A success response therefore does not mean authoritative storage or authoritative reads succeeded. The R03 test `apps/core/test/r03-authoritative-config-postgresql.test.ts:20` recreates the app in the same Node process with shared globals; it does not prove a process/container restart.

Requirements: FR-017, FR-078, NFR-020; PostgreSQL-operational-truth and no-silent-degradation invariants.

Required repair/proof: resolve aliases to canonical UUIDs under verified RLS before every operation, reject unresolved clients, require durable acknowledgment, and explicitly report unavailable authoritative reads. Prove the actual Desk's client IDs against a least-privilege PostgreSQL connection, then terminate the writer process and read from a different process/container. Include replica and DB-outage tests; identical shared-memory state is not restart proof.

## SA-04 — P1, source-confirmed: stale process state can overwrite supposedly versioned DNA history

Locations: `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:7541`, `:7545`; `/Users/hawzhin/Hawdesign/packages/db/src/repositories/client.repository.ts:100`, `:116`, `:129`.

The route computes the new version from its process Map rather than the locked database row. `expectedVersion` is optional. The repository supersedes the current active row and uses `ON CONFLICT(client_id,version) DO UPDATE` to replace DNA, content hash and author on the historical version. After restart or between replicas, a stale seed version can allocate an already existing version and overwrite its content while marking the formerly latest version superseded. If an expected version is supplied, the route may instead reject a valid database version because it compares it with stale local state first.

This scenario was established by source analysis; a real-database corruption probe was intentionally not performed. A database immutability trigger could change the observed symptom to rejection; no new immutability migration was added with R03. Either rejection from stale cache or rewriting history prevents the claimed durable configuration guarantee.

Requirements: FR-017, FR-069, NFR-020.

Required repair/proof: allocate/check versions under the authoritative transaction, separate idempotency identity from version number, forbid changes to existing version content, and make expected revision mandatory for updates. Use two independent processes with a stale cache; a conflicting update must return 409 and preserve every old version hash. Replaying the same idempotency key with different content must fail, not upsert it.

## SA-05 — P1 for scoped-role admission, reproduced: SSE scope filters fail open on normal event shapes

Locations: `/Users/hawzhin/Hawdesign/apps/core/src/routes/system.routes.ts:183`, `:185`, `:195`; real unscoped producers at `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:2089`, `:5266`, `:7352`.

The new tenant comparison returns true when either tenant is missing; client comparison runs only when both event and principal have a client ID. Many real task/QA/comment events carry `taskId` only. An executable probe invokes the genuine SSE handler with a scoped client-A principal and a foreign-client event fixture containing task ID/private data but no tenant/client metadata. The actual emitted frame contains the foreign payload. The test used a fake authenticated principal; current normal shared-key sessions still do not carry a client ID, so the new filter cannot establish restricted-user isolation in the current identity model either.

The stream authenticates once. Its heartbeat neither revalidates sessions nor closes on revocation. The new R04 test verifies a new request after logout, not an already open stream.

Requirements: NFR-006, FR-069 and the security threat model's cross-client disclosure control.

Required repair/proof: mandatory server-derived scope on every event, fail-closed delivery, task-to-client authorization where necessary, and expiry/revocation for open subscriptions. Test real scoped sessions across two clients and tenants; capture emitted frames, not just connection statuses. Include absent/incorrect metadata and revocation while the stream remains open.

## SA-06 — P1 for scoped Studio admission, unchanged source: tenant-only read/RLS policy remains

`/Users/hawzhin/Hawdesign/packages/db/migrations/013_design_studio.sql:38` and the matching candidate/judgment/call/feedback policies still authorize only a matching tenant setting. `/Users/hawzhin/Hawdesign/packages/db/src/repositories/design-studio.repository.ts:110` still sets only tenant context. The GET evidence/image/feedback routes call these repository methods without client-membership enforcement. New task/actor mutation checks do not fix reads or database enforcement. No migration replacing these policies exists in the inspected tree.

This is source-confirmed, not a newly executed production exploit. Requirements NFR-006/NFR-020. Required proof remains a real `hawa_app` role matrix with multiple clients, individual users and revoked memberships, covering reads/images and all mutations. A superuser-based test does not prove RLS.

## Remaining individual-session boundary

The earlier localStorage/shared-key/bearer-URL design is substantially unchanged (`/Users/hawzhin/Hawdesign/apps/desk/src/services/auth.ts:20`, `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:1106`). R04 improves query-token handling and the existing session record provides expiry/revocation for later requests, but individual OIDC identities, HTTP-only browser sessions and full open-stream revocation are not established. This remains a qualification gap, not evidence that credentials were stolen.

## Architectural repair direction and proof rule

Keep the modular monolith, PostgreSQL and durable workflow engine. Consolidate DNA/governance writes into one application service with mandatory scope, database version allocation, authorization and audit append. Route-specific fallback logic is the recurring cause of the measured failures. Use the same verified scope object for HTTP, events and repositories. Fix the observed boundary failures before describing the implementation as fully qualified.

Reproduction: `node --import tsx output/audits/2026-09-20-world-class-audit/security-architecture-probe.ts`. Captured results: `SECURITY_ARCHITECTURE_EVIDENCE.json`. Zero network requests; no real DB/production writes. Successful process exit means the probe ran, not that the product passed. Real PostgreSQL cross-client/restart/concurrency, browser-session and deployed-build tests remain required closing evidence. Each closing proof needs source/deployment identity, exact command, raw results, negative controls, immutable artifact hashes and an independent verdict.
