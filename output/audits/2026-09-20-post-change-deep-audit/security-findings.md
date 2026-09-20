# Post-change security and authoritative-state audit

> **Latest-candidate amendment (20 September, 20:51 UTC):** S1–S4 below describe the earlier source, not the newest local edits. Root reran the same real-route probe: missing-client and rejected-transaction paths preserve DNA/version/proposal; historical content/hash remain stable; cross-client dismiss returns 403; authorized SSE delivery succeeds. These repaired boundaries are credited in REPORT.md and ROOT_RESULTS.json. S5/source-level integration qualifications remain open. Running-container hashes still differ from these latest local fixes. Historical results and explanations below are retained for provenance.

20 September 2026. Reviewed **`6d3c583791a404c914e25b77dda558b16d26bd6c`**, including changes from `73a3b6b`; existing dirty worker/test/evidence files were preserved and are outside this sub-audit's findings. Used the code-review skill's security/correctness/error-path review. Read the prior `2026-09-20-completion-reality-check/REPORT.md` before constructing alternate negative controls. This is a new source audit, not a replay claim attached to an old hash.

**Verdict: request changes.** The exact missing-client corruption case was repaired, but the same business operation still changes active and historical state on a different rejection boundary. A separate governance endpoint bypasses the strengthened role/client checks. There are useful fixes here, but authoritative configuration and scoped access are not yet closed.

## Executed scope and artifacts

Run `node --import tsx output/audits/2026-09-20-post-change-deep-audit/security-probe.ts`. Results are captured in `security-results.json`. Exit 0 means the experiment ran; it does not mean acceptance passed. The script invokes the real application and routes with disposable random credentials and process-memory fixtures. Its database is an explicit failure double; it is not a real PostgreSQL test. It disables the database URL and all global fetch calls, records **zero network attempts**, and writes no production/app data. No provider calls, deployment, production DB queries/mutations, or application repairs were performed.

## Verified fixes worth preserving

- The earlier same-client promotion with a missing authoritative client now returns 404 **without changing DNA**. The old claim that this particular 404 still modifies DNA is stale for this source.
- An operator claiming `role: administrator` in DNA rollback receives 403.
- Drustee-rule promotion through an Aster URL receives 403.
- The repository no longer upserts arbitrary new contents over a preexisting `(client_id, version)` record: `/Users/hawzhin/Hawdesign/packages/db/src/repositories/client.repository.ts:122` compares existing hashes and throws for different contents. This is a real source improvement over the previous historical-overwrite path.
- SSE now drops domain events without required tenant/client metadata and checks cached authentication on its heartbeat. Both improve the prior implementation, subject to the delivery/revalidation qualifications below.

## S1 — P1: a rejected database transaction still changes active DNA

**Reproduced.** With a matching authoritative-client lookup followed by injected transaction failure, promotion returns **500**, but the rule appears in active DNA (**false → true**) and version increases **1 → 2**. The rule miner is rolled back to **DISMISSED**, leaving two operational representations disagreeing. This differs from the missing-client path repaired in the latest changes.

Cause: `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:8320` mutates the shared DNA's `layoutRules` and `:8323` increments its version before opening the durable write at `:8340`. The catch at `:8362` only changes the miner's rule status; it does not restore DNA. Candidate-rule rollback has the same ordering pattern: shared DNA is changed before the persistence attempt (`:8447` onward). GET DNA falls back to that Map during DB failures (`:7547`), so this is observable to operators precisely when the authoritative store is unavailable.

The repaired missing-client path also changes the proposal from **PROPOSED → DISMISSED** even though its response is 404; the compensating `rollbackPromotedRule` does not restore the prior status (`:8305`, `/Users/hawzhin/Hawdesign/packages/creative/src/feedback-miner.ts:711`). A failed operation can therefore discard a pending proposal even when DNA is unchanged.

Requirements: FR-017, FR-054, FR-069, NFR-020. **Closing proof:** one transaction for rule transition, new DNA revision and audit record; update caches only from committed rows. Inject failure before/after every persistence step, including missing client and transaction denial. Assert active DNA, historical snapshots, proposal status and version all remain unchanged on rejection. Repeat with real isolated PostgreSQL, two Core processes and a restart. Response-code-only tests do not close this defect.

## S2 — P1: successful promotion mutates older snapshot contents without changing their hashes

**Reproduced.** Reading a baseline Aster snapshot, promoting a new rule, and rereading the same snapshot ID shows its content changed while its saved hash stayed identical. Recomputing the hash over the newly returned snapshot DNA no longer matches that saved hash.

Cause: promotion mutates the live nested `guidelines.layoutRules` array (`/Users/hawzhin/Hawdesign/apps/core/src/app.ts:8320`). Seed snapshots reference the same DNA object (`:944`); newer snapshots use shallow spread (`:8335`), retaining the nested guidelines object. Neither is an immutable snapshot. This proof concerns the served in-memory snapshot path; it does **not** claim the new repository overwrites an existing PostgreSQL version. The database fallback/merged snapshot route makes truthful separation of these two stores particularly important.

An additional source inconsistency exists at `:8357`: stored DNA gains `__commitMessage` after `hash` was calculated over the unaugmented DNA. `computeDnaHash` hashes the complete canonical object (`:183`). A proof claiming that DB `content_hash` hashes the exact stored DNA must account for this discrepancy explicitly.

Requirements: FR-017, FR-069, NFR-020 and immutable-version evidence. **Closing proof:** deep immutable value objects or authoritative immutable rows; metadata outside the hashed body or a defined canonical hashing contract. Re-read every historical revision after several promotions/rollbacks and after process restart. Every unchanged revision must retain identical canonical bytes and matching hash; intentionally mutating a nested rule must be detected.

## S3 — P1: dismiss remains a role/client bypass around protected rule rollback

**Reproduced.** After an administrator promotes an Aster rule, an authenticated **operator** can POST `/clients/client-nova/candidate-rules/<AsterRuleId>/dismiss` and receive **200**. The Aster rule becomes **DISMISSED** even though the route names Nova. Aster's active DNA still includes its text.

Cause: `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:8406` checks only authentication, ignores the URL client and calls `dismissRule(ruleId)`. `/Users/hawzhin/Hawdesign/packages/creative/src/feedback-miner.ts:720` changes status for any matching rule, including PROMOTED rules. This sidesteps role/client checks added to promote and rollback. It also creates a mismatch between `getPromotedRules()` and stored/live DNA.

Requirements: FR-054, FR-069, NFR-006/NFR-020. **Closing proof:** resolve rules by tenant/client/id, authorize the specific lifecycle transition, and either allow dismiss only for pending proposals or route active-rule retirement through the same protected transaction as rollback. Exercise every endpoint against pending/promoted/dismissed states and requester/operator/reviewer/admin principals; test foreign-client URLs, not only the promote route. Denial must preserve rule state and DNA.

## S4 — P2: fail-closed SSE now silently drops legitimate application updates

**Bounded reproduction plus decisive source path.** A real Core SSE connection returned 200 and its handshake. A real authorized DNA edit returned 201, but the expected domain event was not observed during a 200 ms window. Delivery happens synchronously at the broadcaster, so the source confirms why: `broadcast('dna:updated', { clientId, version, sha256 })` at `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:7633` omits `tenantId`; `/Users/hawzhin/Hawdesign/apps/core/src/routes/system.routes.ts:191` discards it. Existing QA/comment producers also omit scope (`app.ts:5305`, `:7378`). This is not a claim that every UI screen lacks a polling fallback.

**Closing proof:** preserve fail-closed checks; enrich events from verified server/task context before broadcast. Test one authorized recipient receives every supported event and unauthorized recipients receive none. Include absence/forgery negative controls. Do not fix delivery by accepting unscoped domain events again.

## S5 — P1 for restricted-user admission: Studio read/RLS client boundary remains unimplemented

**Source-confirmed; no live exploit executed.** The changed `DesignStudioRepository.withClient` accepts an optional client ID, but `getRunById` still calls it with a tenant string only (`/Users/hawzhin/Hawdesign/packages/db/src/repositories/design-studio.repository.ts:140`). The GET evidence route calls `getRunById(runId, tenantId)` then retrieves all candidate evidence without checking client membership (`/Users/hawzhin/Hawdesign/apps/core/src/routes/design-studio.routes.ts:140`). Similar read paths exist for images and feedback.

All five Studio policies still check only the tenant setting (`/Users/hawzhin/Hawdesign/packages/db/migrations/013_design_studio.sql:38`, `:71`, `:92`, `:120`, `:142`), and no later migration changes them. Merely setting `app.client_id` does not enforce it when policies never read it. Current shared-key identity design primarily exposes broad office roles; this audit does not claim an already deployed restricted designer was exploited. It does establish that the client-isolation acceptance remains open.

Requirements: NFR-006, FR-068, NFR-020. **Closing proof:** actual membership-aware RLS and a mandatory verified principal/client scope across repositories/routes. Run a matrix as `hawa_app` (not owner/superuser): same tenant/different clients, different tenants, revoked memberships, URL/task/run mismatches, evidence/image/feedback reads and all mutations. Record zero forbidden bytes/writes/provider calls.

## Remaining source-level qualifications

- Normal DNA POST still calculates a version and checks optional expectedVersion against its Map (`app.ts:7567–7572`) before the database repository locks the authoritative row. Old destructive overwrite is fixed, but a stale process may reject a correct expected version or receive VersionConflict/500; two-process restart/concurrency qualification is not established by same-process tests.
- Client alias lookups are still performed before `withRlsContext`; a correctly restricted application DB identity can see no client without session scope. Test the actual runtime role and do not rely on owner bypass.
- SSE heartbeat calls synchronous `verifyRequestAuth`, whereas cross-instance database revocation is checked by asynchronous `ensureSessionLoaded` only on request entry (`app.ts:1066`, `:1541`). Same-process logout checking improved; cross-instance open-stream revocation is still not demonstrated. No new token-exfiltration experiment was performed.

The architectural next step is a single scoped governance application service with durable transitions and immutable snapshots. No new orchestration framework or deployment topology is needed to solve these defects. The current evidence supports useful local fixes, not the claimed end-to-end authoritative-state guarantee.
