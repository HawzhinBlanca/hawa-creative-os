# Architecture and security audit — 19 September 2026

Source reviewed: `664ad55b85930b3cd29c6be170fc13f0d2876f66`. This is an independent source audit with three offline reproductions, not a production penetration test. No application fixes, production writes, provider calls or external messages were performed. The companion probe makes zero network calls, disables the database and operates on disposable process memory. Its successful exit means the experiment completed, not that the system passed.

The coordinating audit observed deployed stamp `5180108`, with `DESIGN_PIPELINE_V3=off` and `DESIGN_STUDIO_V2=off`. Therefore the Studio findings below do not establish that the ordinary deployed automatic pipeline currently uses the defective V2 encoder. Explicit Studio HTTP routes are registered regardless of those feature flags; future activation also requires closing these gates. Deployment/source equivalence is a separate acceptance obligation.

## Verdict

The selected modular-monolith/PostgreSQL/Restate/Canva arrangement is viable for a robust small-office service. It does not need a framework replacement or a microservice rewrite. Its current implementation does not satisfy its own architecture/security contract: some authoritative configuration still lives in process memory, new Studio tables have weaker scope controls than the older task tables, and the richer renderer/transfer contract is measurably inconsistent. A perfect or globally best score cannot be established from this evidence. A bounded release with explicit workloads, supported features and measured failure/recovery criteria is achievable after the following gates pass.

Positive controls observed: the domain state machine has no HTTP/provider/database imports; standard DB code offers transactional RLS context; Canva authorization uses PKCE/encrypted credentials and durable operation records; default HTTP registration rejects anonymous access; the webhook secret no longer authorizes normal API calls; ambiguous creation results are represented rather than blindly replayed. These strengths are real but do not establish every route or boundary as safe.

## A1 — P1: acknowledged Client DNA changes are volatile and reseeded

**Confirmed:** `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6497` updates `clientDnas` at line 6516 and `clientSnapshots` at 6531, returns 201 at 6535, and performs no database write, expected-version comparison or durable audit append. Maps are process globals at lines 215–216; every `createApp()` unconditionally seeds them from line 433 onward. Budgets have the same process-only configuration pattern at lines 6936–6957. The active planner separately loads the fixed KAAE JSON reference pack (`/Users/hawzhin/Hawdesign/apps/core/src/services/design-studio/design-studio-service.ts:173`), rather than consuming those edited DNA records.

**Executed proof:** a valid disposable operator saved a changed Drustee name; the real handler returned 201 and version 2. Constructing another application instance reset it to the seeded name and version 1. This is an isolated in-memory reproduction. Static inspection confirms the same DNA route has no database branch even when Core is configured with PostgreSQL.

**Effect:** an acknowledged configuration edit can vanish on restart; two Core replicas can disagree; the studio may use reference data that differs from the Desk's apparent source of truth. This violates FR-017, FR-078 and NFR-020 and the PostgreSQL-operational-truth invariant.

**Required task/proof:** move authoritative DNA, snapshots and budgets to scoped versioned repositories, make render/reference selection consume the pinned revision, use conditional expected-version updates, and keep a process cache replaceable. Prove save → kill process → reload, two-replica read consistency, concurrent stale edit rejection, and restore-from-backup preservation. Identify the exact DNA hash/version used in a completed design. A passing HTTP response in one process does not close this task.

## A2 — P1: privileged DNA history accepts a caller-supplied author

**Confirmed:** `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:6525` uses `body.createdBy || 'operator'`; manual snapshots similarly use `body.createdBy || 'art_director'` at line 6565. DNA mutation checks authentication but not a client-specific management capability; reads enumerate the unscoped shared map. The server also spreads caller fields including `tenantId` into the returned DNA at line 6511.

**Executed proof:** the genuine DNA HTTP handler accepted the string `fabricated-author` and wrote it into the snapshot returned by the genuine read handler. No real user or permanent record was modified.

**Effect:** audit identity is not evidence of the human who made a change, and authentication alone stands in for scoped authorization. FR-054, FR-069, FR-078 and NFR-006 are not proven.

**Required task/proof:** authorize the server-resolved principal against tenant/client capabilities, derive author and tenant server-side, and append immutable audit entries. Test forged author/tenant, role downgrade, missing membership, cross-client mutation and stale revisions using independently authenticated users; verify denied actions leave both data and audit history unchanged except for a denied-action record.

## A3 — P1 before Studio admission: Studio scope is tenant-only and mutation methods ignore task binding

**Confirmed source:** `/Users/hawzhin/Hawdesign/packages/db/migrations/013_design_studio.sql:38` permits rows solely when `tenant_id` equals a session setting. The same pattern appears for candidates (71), judgments (93), calls (122) and feedback (146); no membership/client/actor check exists in those policies. `/Users/hawzhin/Hawdesign/packages/db/src/repositories/design-studio.repository.ts:110` sets only tenant context; `getRunById` at 138 takes no principal/client. No later migration replacing these policies was found.

`/Users/hawzhin/Hawdesign/apps/core/src/routes/design-studio.routes.ts:143` retrieves run evidence using that repository. It validates run/task association for this read but not the caller's task/client permission. `/Users/hawzhin/Hawdesign/apps/core/src/services/design-studio/design-studio-service.ts:714`, `:1621` and `:1647` retrieve a run by run ID and tenant for resume/select/abandon, without comparing the provided task ID with `run.task_id` or applying scoped capability checks.

**Executed limited proof:** the real `abandon` method with a fake repository returned `abandoned` and requested a write when both the supplied task ID and actor differed from the stored run. This proves the missing method-level binding check; it is not a live-database exploit. The full restricted-role RLS exploit remains unexecuted. Current static-key session issuance mainly exposes office-wide operator/reviewer/admin identities, so this audit does not claim a currently deployed restricted designer was compromised.

**Effect:** the new Studio boundary cannot honor the client-isolation guarantee if a scoped staff role is admitted; a mistaken or forged task URL can mutate a different run. Requirements NFR-006/NFR-020 and MASTER_SPEC invariant 5.

**Required task/proof:** use one mandatory scope object with verified tenant/user/client/task identifiers, enforce membership and task-derived client policies in PostgreSQL, make all child foreign keys/scopes consistent, and validate URL/task/run/candidate associations for every operation. Run real `hawa_app` role tests (no superuser/owner bypass) across same-tenant different clients, different tenants, revoked memberships, wrong task URL, wrong run, and candidate from another run. Include GET/image/feedback/resume/select/abandon/parity and verify zero calls, writes or bytes on denial.

## A4 — P1 before rich Studio admission: transfer silently changes supported design features

**Confirmed and reproduced:** `/Users/hawzhin/Hawdesign/packages/creative/src/studio/transfer-v2.ts:196` writes every shape as `pptx.ShapeType.rect`, makes its fill opaque, drops rotation/radius/stroke, and hides the line. Text serialization at 213 omits letter spacing and opacity. Those attributes are supported by `/Users/hawzhin/Hawdesign/packages/creative/src/studio/layout-v2.ts:34` and the preview renderer at `/Users/hawzhin/Hawdesign/packages/creative/src/studio/render-layout-v2.ts:537` and `:688`.

The real encoder was given a 20%-opaque ellipse, 45-degree rotation and blue stroke. PPTX XML contained rectangles, no ellipse, no requested alpha, no rotation and no blue stroke. The manifest still described the shape as an ellipse with opacity and blue stroke. Text opacity and spacing also disappeared. Existing `/Users/hawzhin/Hawdesign/packages/creative/test/transfer-v2.test.ts` covers font normalization/bounds/RTL/line pitch, not this feature fidelity.

**Effect:** the artifact a local judge evaluated is not the artifact delivered to Canva; structured evidence can describe properties absent from the transferred bytes. FR-028, FR-029, FR-031, FR-038, NFR-020 and the no-silent-degradation invariant apply. The automatic V2/V3 flags were off in the inspected deployment; this is a current explicit-Studio and future-admission defect, not a claim about every current single-shot draft.

**Required task/proof:** establish an executable feature-support matrix and preserve each admitted property end to end; reject unsupported properties before paid work or emit a visible, approval-blocking diagnostic. Golden-test each property and combinations through local render → PPTX XML → native Canva import/edit/reopen → real exported PNG/PPTX. Compare geometry, text, fonts, alpha, stroke, ordering and source editability; bind approval to the actual exported bytes. Require failure injections that intentionally drop each feature and demonstrate the gate catches them. Do not substitute checking the source manifest for inspecting the produced bytes.

## A5 — P1 for scoped staff admission: event delivery has no tenant/client filtering

**Confirmed source, not dynamically exploited:** `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:415` broadcasts every event to every subscriber. `/Users/hawzhin/Hawdesign/apps/core/src/routes/system.routes.ts:171` authenticates through the wrapper but subscribes without retaining principal or allowed client scope; line 181 sends the entire event data. Events include created task objects, QA reports, comments, publishing data and client updates. The stream does not periodically revalidate a session after initial authorization.

**Effect:** API/DB row filtering cannot protect data already sent through an unscoped live stream. An expired/revoked session's existing stream may remain connected. NFR-006 and FR-069 apply. Current office-wide role exposure qualifies practical exploitability as in A3, but it does not satisfy the intended scoped-role architecture.

**Required task/proof:** attach verified tenant/client scope and session expiry to each subscription and to every event, filter before delivery, and terminate/revalidate revoked sessions. Test parallel client-A/client-B streams, wrong-tenant events, role changes and revocation; capture actual stream frames and prove forbidden payload bytes never appear.

## A6 — P2: session design does not meet the declared individual-identity/browser-secret boundary

**Confirmed source:** `/Users/hawzhin/Hawdesign/apps/core/src/app.ts:1607` authenticates shared role keys and maps people to two seeded human IDs rather than individual Workspace OIDC identities. Lines 1030–1073 persist session hashes and periodically reload them, which is a useful improvement, but on a DB lookup failure retain cached authority. `/Users/hawzhin/Hawdesign/apps/desk/src/services/auth.ts:20` stores bearer tokens in localStorage. The Studio and SSE UI put the same bearer in URLs (`/Users/hawzhin/Hawdesign/apps/desk/src/components/StudioPanel.tsx:143`, `/Users/hawzhin/Hawdesign/apps/desk/src/services/eventStream.ts:51`). API errors also include `c.req.url` at app.ts:329. No token theft or log disclosure was attempted.

**Effect:** individual human attribution/revocation cannot be guaranteed by shared role credentials; browser-script access and URL-handling surfaces carry reusable credentials. This is a gap against `docs/14_SECURITY_THREAT_MODEL.md` section 4 and NFR-006/FR-069, not proof of an active breach.

**Required task/proof:** individual office identity, secure HTTP-only sessions with CSRF/origin checks, and scoped expiring media tickets where needed. Keep service identity separate. Test role/member revocation across replicas and DB outages, session rotation, logout, forged cookies, and diagnostic/access-log redaction. Prove browser storage and image/stream URLs contain no reusable office bearer.

## A7 — P2: architectural boundaries are only partially realized

**Confirmed source:** `apps/core/src/app.ts` is 8,019 lines and contains initial data, auth/session logic, workflow operations, approvals, publishing, mutable configuration and callbacks. `DesignStudioService` is 1,725 lines and creates provider clients, queries tables, controls budgets, advances stages and encodes/imports transfers. The package split exists, and domain transitions are separately testable, but a package list alone does not establish the required thin HTTP/application/domain boundaries. The current core also retains several old task/workflow paths and process-only controllers; they must be inventoried before removal.

**Required task/proof:** retain the selected deployment topology, extract bounded application services/repositories behind the current routes, explicitly identify the one authoritative workflow for each supported command, and retire duplicate production paths after equivalence tests. Add import-boundary checks and route-contract tests. Prove identical externally observable behavior and stable task identity through both automatic and operator-driven entry points. No new multi-agent framework or generic orchestration platform is justified by this audit.

## Current improvement that must not be reported as an unfixed defect

`/Users/hawzhin/Hawdesign/packages/integrations/src/reconciliation-service.ts:44` now explicitly says it compares in-memory tasks with previously recorded publication receipts, not Google Drive/Sheets. It no longer invents repair rows. Historical wiki claims that this repair is still fabricated are stale for the reviewed source. Actual external read-back/reconciliation remains an unfulfilled production capability; truthfully reporting its absence is progress, not proof it exists.

## Evidence and closing rule

Run `node --import tsx output/audits/2026-09-19-architecture-reliability/offline-architecture-probe.ts`. The captured results are `OFFLINE_ARCHITECTURE_EVIDENCE.json`. This audit executed only those three offline probes; cross-client live-RLS, browser token theft, provider import/export, restore, load and production restart tests were not executed by this sub-audit. Each remediation must attach exact source/deployment hashes, command, raw result, negative controls, artifact hashes and reviewer verdict. A unit mock, feature flag, success toast, source manifest or historical statement alone cannot close an end-to-end gate.
