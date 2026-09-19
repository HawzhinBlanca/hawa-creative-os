# Proof-gated task sheet
Date: 2026-09-19. Baseline: source `664ad55`, observed production `5180108`.
Status of EVERY task below: **NOT_STARTED**. Audit probes reproduce defects; they do not complete remediation.
Priority “blocking” means blocks broad production qualification, not proof of active exploitation.

## Working rules
- Read linked requirement sources through `plans/traceability.csv` before implementation. Preserve Canva-first ADR 025 and current ADR 030. Add an ADR before changing a foundation.
- Implement complete vertical slices through UI/API, application service, database, durable worker and evidence—not just a mocked unit function.
- Keep business rules out of HTTP/provider adapters. Reuse existing repositories, contracts and durable workflow infrastructure. No new orchestration framework or replacement editor without measured need and approval.
- Preserve existing tasks/artifacts, write reversible migrations, and prove migration/rollback on a disposable realistic clone. Never run destructive tests on production or its PostgreSQL server.
- Real provider calls, provider spending, production rollout, external messages and multi-client pilot require separate authorization and bounded test destinations. This sheet authorizes none of them.
- A completion claim needs the [proof contract](PROOF_REQUEST.md), including a regression that fails before the repair. Unknown, skipped, blocked and unrun are not PASS.

## Order and dependencies
R01 + R02 first. Then R03–R10 can be developed in bounded parallel slices, respecting their dependencies. R11–R13 qualify the integrated candidate. R14 is last.
Do not deploy isolated bug fixes and declare the whole architecture finished.

### R01 — Make evidence truthful and preserve the failing baseline
**Blocking. Owner:** test/evaluation engineer. **Depends on:** none.
**Requirements:** FR-055, FR-057; NFR-024, NFR-025.

Remove invented/defaulted quality results in live-runner. Validate routing output against expected client/project, copy, facts and abstention semantics. Retire—not erase—obsolete “all gates PASS” labels; retain historical evidence with its exact scope. CI summaries must derive their verdict from actual normative gates, not hardcoded text.

**Required proof:** replay the audit's empty-evidence and always-abstain cases: neither may qualify; missing metrics must be unknown/incomplete. Include deliberately wrong-client, altered-number, empty-artifact and copied-receipt negative controls. Invalid evidence must make the qualification command exit nonzero. Preserve the original audit files unchanged.

**Accept only when:** each acceptance claim has a measured source; no synthetic/stubbed result can appear as live qualification. Update traceability with narrow outcomes, not blanket PASS.

### R02 — Establish exact build, configuration and active workflow identity
**Blocking. Owner:** release/platform. **Depends on:** none.
**Requirements:** FR-074; NFR-013, NFR-025.

Choose one canonical deployment topology and document active versus dormant/retired lanes. Emit an immutable release manifest covering commit, tree cleanliness, image digests, migration version, flags, model/prompt/schema/QA versions and runtime identity. Include the UI and worker as well as Core. Keep flags off until their admission gates pass.

**Required proof:** clean build from the named revision; compare deployed artifact hashes/digests to manifest; reproduce on a second clean environment; flag mismatch fails admission. Roll back on staging while preserving acknowledged work. No “stamp only” proof.

**Accept only when:** API, UI, worker, migrations and every downstream proof name the same release/configuration or explicitly identify an intentional version boundary.

### R03 — Put authoritative configuration and policies in PostgreSQL
**Blocking. Owner:** application/data. **Depends on:** R01/R02.
**Requirements:** FR-017, FR-054, FR-069, FR-078, FR-079; NFR-001, NFR-015.

Inventory process Maps and local-only ledgers. Persist Client DNA, immutable snapshots, governance changes, destinations, budgets and any business-authoritative state. Use expected versions, append-only audit, authenticated authors and atomic update/outbox transactions. Caches may accelerate reads, never become the source of truth. Audit enforcement of spend caps across restarts/concurrent workers.

**Required proof:** save→kill process→restart→read identical hash/version; two concurrent expected-version updates yield one winner and one conflict; failed transaction leaves no success response/event; two instances agree; forged createdBy ignored/rejected; concurrent spending reservations cannot exceed the configured cap.

**Accept only when:** no successful authoritative mutation disappears or changes identity after restart, and active workflows retain their original frozen configuration.

### R04 — Enforce principal, tenant, client, task and run scope everywhere
**Blocking. Owner:** security + data. **Depends on:** R02/R03.
**Requirements:** FR-011, FR-043, FR-066–069, FR-077; NFR-006, NFR-007.

Create one authorization contract enforced by routes, services and real non-owner database roles. Bind every run to its task/client/principal permissions. Scope SSE, images, artifacts, search, logs, exports and administration. Eliminate arbitrary actor fields; replace shared-role credentials with attributable revocable sessions appropriate to this private office deployment. Remove long-lived bearer query URLs; define safe short-lived artifact access and log redaction. Validate local-only/egress restrictions at each actual outbound boundary.

**Required proof:** restricted users for client A/B in the same tenant plus tenant C; guessed IDs, wrong-task run URLs, revoked users, SSE subscribers, background jobs and direct runtime-role SQL all denied out of scope. Confirm zero provider calls under local-only and malicious-document instructions. Exercise unauthenticated and role-restricted routes in production-mode staging, not auth-bypassed tests. Session expiry/revocation and URL/log leakage negatives required.

**Accept only when:** unauthorized actions return no protected bytes/events and change no state. Security reviewer signs the exact negative matrix; superuser SQL and fake repositories cannot prove RLS.

### R05 — Make approval an immutable artifact/QC contract
**Blocking. Owner:** domain + QA + data. **Depends on:** R03/R04.
**Requirements:** FR-015, FR-041, FR-043–045; NFR-015, NFR-020.

Bind the authenticated human approval to exact client/task/revision, Canva binding/capture version, source and export hashes, QC attempt/hash/profile and required formats. Require successful current QC for precisely those artifacts. Reject partial lookups and stale captures; serialize/fence competing edit, QA and approval operations. Invalidate downstream permission on edits.

**Required proof:** older exports plus newer passing QA rejected; earlier PASS then later FAIL cannot qualify; concurrent edit/approve has one valid serial outcome; wrong client/role, missing export, changed bytes, stale binding and null/unknown QC cannot publish. Repeat after restart with real isolated PostgreSQL. Positive current-version approval still works.

**Accept only when:** every published byte is traceable to the exact reviewed, authorized tuple.

### R06 — Make publication restart-safe, concurrency-safe and verifiable
**Blocking. Owner:** durable workflow/integrations. **Depends on:** R03/R05.
**Requirements:** FR-045–050, FR-059–060; NFR-001, NFR-014, NFR-020.

Unify every publication route around one canonical key and durable publication/effect ledger. Persist intent before provider calls, record per-file receipts, enforce unique logical output constraints and reconcile ambiguous outcomes. Implement safe remote discovery/reuse, not process Maps. Sheets updates must verify immutable task identity before changing a row; row position alone is not identity. Verify real bytes/checksums or an explicitly documented sufficient provider-supported read-back, destination/permissions and required package completeness. If correctness is unprovable, pause for reconciliation.

**Required proof:** actual isolated DB and workflow, with remote service emulator and then authorized real test providers: concurrent same-key calls; process death before send, after accepted send, before receipt commit; lost upload/append responses; partial multi-file failure; both API routes; wrong checksum; moved/sorted/inserted Sheet rows; deleted remote file. Count remote objects/rows independently, inspect their hashes and verify unrelated rows unchanged.

**Accept only when:** one logical package/row, no unrelated overwrite, no premature COMPLETE, recoverable uncertain states, and no replay of confirmed non-idempotent effects. Run the saved publication counterexamples as regressions.

### R07 — Close the durable workflow through terminal state and notification
**Blocking. Owner:** workflow/backend. **Depends on:** R03/R06.
**Requirements:** FR-051, FR-059–064; NFR-001, NFR-011, NFR-017.

Persist terminal state and notification intent atomically; implement real outbox consumers or an equivalent existing durable effect mechanism. Remove catch-and-success handling. Distinguish retryable, permanent and uncertain delivery. Keep publication successful if notification fails, with visible independent recovery. Restore partial-publication states faithfully after restart.

**Required proof:** Core unavailable before notification creation; transient/permanent provider rejection; kill after accepted send before receipt; worker restart; partial-publication restart; revoked destination. Authorized recovery must not invent delivery IDs or blindly duplicate ambiguous messages.

**Accept only when:** every acknowledged terminal event is durable, every pending/failed/uncertain notification is discoverable, and each blocked workflow exposes one safe actionable recovery path.

### R08 — Prove editable transfer and final output fidelity
**Blocking for V2/V3. Owner:** renderer/Canva integration + native-language reviewer. **Depends on:** R02/R05.
**Requirements:** FR-015, FR-034–039, FR-045, FR-075; NFR-008, NFR-009.

Define an explicit supported feature contract across planner→renderer→PPTX→Canva→export. Implement fidelity or fail unsupported properties before approval. The manifest must describe delivered reality. Validate live text editability and exact English/Sorani/Arabic copy, fonts, glyphs, bidi order, shapes, stroke, alpha, rotation, spacing, logos and clipping.

**Required proof:** enumerate the complete applicable golden admission corpus (including normative Gate A's 40 synthetic and 20 real Sorani briefs), not a selected successful sample. A synthetic feature matrix includes the audit ellipse/rotation/alpha/stroke case; inspect generated XML and actual rendered bytes. Authorized real Canva import→open→edit text→save→reopen→capture/export; compare against the approved version. Native speaker signs critical RTL cases, including applicable Arabic cases. Unsupported features fail visibly, not silently flatten.

**Accept only when:** all declared-supported features survive the entire path; every admitted production design has verified editable source and matching final exports. Unit XML tests alone do not prove Canva behavior.

### R09 — Implement and prove clean-host disaster recovery
**Blocking. Owner:** platform/data. **Depends on:** R02/R03.
**Requirements:** FR-070; NFR-003, NFR-020.

Choose and deploy one tested encrypted off-host backup strategy covering database, workflow state, editable assets, object files, configuration and secure key recovery. Achieve ≤15-minute database RPO with the chosen approach; WAL/PITR is one option, not an untested requirement substitution. Fail backup health if off-host transfer fails. Separate backup, schema rebuild and actual recovery verdicts.

**Required proof:** restore on a separate disposable host/engine with production-like data and roles, no mounted production storage. Record acknowledged marker timestamps versus latest recovered marker, timed core restoration, counts/hashes, RLS/permissions, audit ledger, pending workflows and external-receipt reconciliation. Simulate corrupt/missing latest backup and unavailable archive destination. Verify encryption and key availability without exposing keys.

**Accept only when:** measured RPO ≤15 minutes, RTO ≤4 hours, restored assets reopen, suspended jobs recover without duplicate effects, and failure alerts are observed. Nightly count checks or schema parsing cannot substitute.

### R10 — Qualify model quality independently from workflow correctness
**Blocking for automated creative claims. Owner:** evaluation + design lead. **Depends on:** R01/R08.
**Requirements:** FR-020, FR-021, FR-023, FR-055–058; NFR-009, NFR-024, NFR-025.

Retain real P10 evidence but state its limits. Build a versioned held-out set spanning admitted archetypes, languages, brands, copy densities and adversarial cases. Check semantic correctness, failure/abstention behavior and calibrated judging. Test fallback policies. Never substitute model self-grades for independent design acceptance. Separately qualify retrieval on a corpus independent of expected IDs and test queries, through the actual scoped production retrieval path; measure relevance and negative-example selection and require zero cross-client leakage. Keep model roles within the approved ADR 030 provider policy; calibrate judges against independent human-labeled defects rather than requiring an unapproved provider.

**Required proof:** normative 200-task model tournament with per-case expected outcomes, sealed holdout identity, exact models/prompts/receipts, no cherry-picked reruns, budget/latency records and confidence intervals. Order-swap and adversarial judges must be measured, not defaulted. Predefine thresholds before running and obtain approval for paid tests.

**Accept only when:** each model/role is admitted only for its passed scope, with honestly bounded uncertainty; changing model/prompt/QA versions invalidates affected admissions.

### R11 — Make the release gate reproducible and non-bypassable
**Blocking. Owner:** release/test. **Depends on:** R01/R02; final run after R03–R10.
**Requirements:** FR-074; NFR-012, NFR-013, NFR-024, NFR-025.

Run clean typecheck/build, full applicable tests with correct isolated database, security scan, dependency/container checks and required integration negatives. Repair the scanner's disposable-token false positive narrowly; do not suppress broad files/classes. Use automated CI or an equivalent enforced local signed release gate if no remote exists. Distinguish A–H normative acceptance from ordinary build steps.

**Required proof:** clean-environment full run with totals, skips, failures and raw logs; intentionally break one gate and prove admission refuses it. Verify tests cannot access production DB/provider credentials. Rebuild/retest artifacts must match the release manifest. Capture unchanged pre-existing evidence and worktree diffs.

**Accept only when:** no failing/unrun mandatory gate can yield ship-ready and a second reviewer can rerun the proof.

### R12 — Measure operations, performance and safe failure behavior
**Blocking for stated service guarantees. Owner:** platform/operations. **Depends on:** R06/R07/R09.
**Requirements:** FR-062–065, FR-071, FR-079; NFR-002, NFR-004, NFR-005, NFR-011, NFR-017.

Measure scoped queue limits, retries/backoff, dead letters, overload, storage exhaustion, dependency outage, exhausted credits and per-client spend caps. Separate process liveness from operational readiness. Expose actual receipt-based progress, latency, errors, costs and actionable blocked states. Preserve core business rules in application services as routes are consolidated.

**Required proof:** isolated realistic-size load (target 100 clients/100k tasks/2m chunks/25 users), p95 list ≤1.5s, webhook ≤1s, non-AI transitions ≤2s; bounded queues and costs during outages. Trace one task end-to-end. Demonstrate alerts and operator recovery. Report observed availability over a real measurement window; do not infer 99.5% monthly from a short smoke test.

**Accept only when:** stated targets meet measured conditions, and unsupported scale/availability claims remain explicitly unqualified.

### R13 — Complete blinded human quality and operator usability gates
**Blocking for “top quality.” Owner:** design lead + native-language reviewers + operator. **Depends on:** R08/R10.
**Requirements:** FR-041, FR-076; NFR-009, NFR-016, NFR-021.
Complete T8-style blind ratings with genuine humans; existing T8 artifacts are historical and cannot qualify a changed release without an explicit unchanged-artifact compatibility justification. Bind new ratings to the current candidate manifest and check the seal before and after rating. Expand to predeclared representative cases if its small set is insufficient. Randomize labels/order; compare against an agreed expert/template baseline. Record print-readiness, brand fit, hierarchy, multilingual correctness and meaningful manual repair effort. Test keyboard/focus and operator review/revise/approve/publish without a terminal.

**Required proof:** authentic signed/date-stamped ratings, sample identities and blinded order, disagreements/adjudication, failures and repair times. Set acceptance thresholds with the owner BEFORE rating. Do not backfill human CSV values from an AI judge.

**Accept only when:** human evidence supports a precisely named scope, not a universal “10/10” claim. Pending owner ratings remain BLOCKED, never fabricated.

### R14 — Controlled deployment and office pilot
**Final release gate. Owner:** release lead + owner + independent reviewer. **Depends on:** R01–R13.
**Requirements:** all admitted-scope requirements; normative Gates A–H and Pilot gate.

Get explicit approval for deployment/pilot budget and destinations. Take a verified backup, deploy the attested candidate, run an authorized end-to-end canary through the real deployed API/workflow/Canva/QA/human approval/Drive/Sheets/notification path. Expand only to approved clients/feature flags. Preserve rollback and stop conditions.

**Required proof:** 3 clients and ≥100 actual production tasks; each has complete lifecycle receipts, artifact hashes, editable-source checks and human outcome. Include every task and technical rescue in the denominator. ≥95% complete without technical rescue; no critical copy, client-isolation, wrong-approval or data-loss escapes. Record actual latency/cost and manual work.

**Stop immediately on:** any critical escape, duplicate/overwriting side effect, false COMPLETE, budget breach or unproven recovery. Fix and requalify affected gates on a new named build.

**Accept only when:** owner and independent reviewer sign a bounded release statement listing admitted scope, build/configuration, proof links and residual risks. No fake tasks, create-only counts, component-only renders or mocks count toward the production pilot.
