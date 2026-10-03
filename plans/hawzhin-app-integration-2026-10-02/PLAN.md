# Hawa Studio in hawzhin.app

Owner scope: existing `/designer` becomes the complete browser design workspace.
Existing login; self-service generation, revisions and downloads. No Telegram
account or manually advanced pipeline is required. No new standalone product.

## Verified starting point — 2026-10-02

- Site source: `HawzhinBlanca/hawzhinstt`, commit
  `eae4dc2ae5e883f2b233cf731be76a77a1f64ba6`, connected Lovable project
  https://lovable.dev/projects/bbae9127-1cf1-402a-b1ff-6dbfc5433ccc.
- Registry: `src/lib/workspaceApps.ts`, designer `/designer`, status `soon`.
  Launcher, sidebar and switcher derive from it; update that single registry.
- Actual route: `src/App.tsx`, already ProtectedRoute → RequireAccess →
  AppLayout → Designer. Designer currently renders the coming-soon screen.
- Existing identity: `src/hooks/useAuth.ts`, Supabase auth. Membership authority:
  `supabase/functions/_shared/accessGate.ts` and `has_app_access`.
- Existing Hawa Studio is reusable, but its StudioPanel includes office recovery,
  settlement, stage advancement and cost controls. Do not copy these capabilities
  into public access. Reuse the actual preview/feedback/view behavior with a
  customer transport; operator controls remain in Desk.
- Hawa's current production is the private deployment. An always-on public
  backend and customer permissions are not yet installed. A website login alone
  does not make this backend accessible or authorize its office API.

## Execution and acceptance

| Slice | Requirements | Concrete work | Acceptance gate |
|---|---|---|---|
| Identity | NFR-006, FR-068 | Verify the exact site Auth issuer and current member gate. Persist governed mapping to a Hawa customer, not an office role. | Invalid/expired/other-issuer credentials, revoked member, dependency outage and impersonation fail closed; verified member has no admin/client rights by default. |
| Scope and budgets | FR-006, FR-017, FR-077, NFR-006 | Provision customer workspace/brand; immutable client/project grant, task owner, source/export authorization; atomic quotas, per-job spend and concurrency reservations. | Two customers cannot list, retrieve, stream, edit or download each other's jobs/photos/brand data. Concurrent duplicate submissions consume one job and one reservation. |
| Web intake | FR-001, FR-006, FR-068 | Exact text, language, output dimensions, logo, source photos, references, photo instructions; upload sniffing/quarantine/hash/provenance. | A real six-photo request keeps every original, obeys explicit use-all/count, and otherwise selects content-aware composition; original facts/logo preserved. |
| Durable generation | FR-001, FR-040, FR-060, FR-061 | Web adapter enters existing job controller/outbox/Restate, without fabricated Telegram identity. Recovery-safe progress/history and bounded retries. | Close tab, restart services and reconnect: same task, receipts, budget and result, no repeated uncertain paid call or manual Advance Stage. |
| Preview and revision | FR-029, FR-043, FR-069 | Reuse Studio preview/feedback and revision evidence; expected revision checks, independent customer acceptance event. | Real preview; exact feedback applied; stale or concurrent revisions conflict; changing a design invalidates its old acceptance/download eligibility. |
| Editable downloads | FR-029, FR-043, NFR-006 | Capture/export current native design and serve authorized content hashes; explicit export eligibility policy separate from staff delivery. | Real generated job → native import → advertised PNG/PDF/editable source; title/photo/logo/frame survive; blocked QA gives a truthful reason. Manual Canva acceptance does not count as unattended export proof. |
| Hosting and cutover | FR-070, NFR-006 | Select host, restore DB/Restate/blobs together, HTTPS narrow ingress, provider secrets server-side, private office administration, backups. | Restore/restart real stack; no exposed DB/Restate/office routes; no duplicated poller/worker, no public trusted_office identity; rollback verified. |
| Site launch | FR-076, FR-077, NFR-006 | Replace Designer screen, update single registry only after readiness; same login/shared layout, mobile/RTL flows. | Actual hawzhin.app sign-in → Designer → upload → generate → revise → download without Telegram; second-user isolation/logout/expiry, other three tools regressions, real phone/desktop checks. |

## Hosting decision pending

Asked owner whether to prepare a cloud server, use an existing server, or keep the
computer as an initial team-only host. Recommended commercial arrangement is an
always-on Linux Docker engine reached by the site's narrow authenticated customer
API. No server has been bought, new public tunnel created, DNS changed, or app
published in this task. Do not promise uptime for a sleeping/offline office computer.

## Current work and evidence

- Both repositories have local `codex/hawzhin-app-integration` branches.
- Initial identity adapter: `apps/core/src/customer/supabase-member.ts`. The
  verified member is deliberately only an identity; it is not wired into the
  office authenticator and cannot create a task or grant a role. Customer route,
  persisted mapping, permissions and end-to-end flow remain to be implemented.
- Unit controls: `apps/core/test/workspace-member.test.ts`; results recorded in
  `IDENTITY_PROOF.json` after execution. Doubled Auth/membership transport only;
  no real sign-in, customer route, production switch or live authentication claim.
- Site code is still unchanged; Designer remains coming soon until the actual
  complete customer flow is qualified. Overall status: IN PROGRESS, NOT LAUNCHED.

Sources: verified files above; ADR256; repository traceability-linked documents;
https://supabase.com/docs/reference/javascript/auth-getuser (server verification);
https://docs.lovable.dev/integrations/any-api (reachable backend and secrets);
https://docs.lovable.dev/features/custom-domain (existing domain connection).

## Customer boundary checkpoint — 2026-10-02 (ADR259)

Actual isolated DB/RLS and mounted HTTP checks: 107 passed, zero failures/skips;
741 strict test roots and Core build pass. Website intake/history, uncertainty
replay, RTL and accessibility controls: 11 passed; types and production build
pass. See `CUSTOMER_ADMISSION_PROOF.json` for original failures and corrections.
No public launch. Core always reports generation disabled while the canonical
RequestLifecycle web entry and durable requester sink are pending. The synthetic
TaskWorkflow dispatch is not production-qualified and will be replaced.

Claude's supporting response and branch now exist, including an actual official
PPTX import/export receipt and stronger picture/logo checks. His ADR257/258 are
reserved; this boundary uses ADR259. Merge current production/support before the
next deployment candidate. Hosting choice remains pending.

## ADR260 canonical website entry — 2026-10-02

Implemented locally: stable customer-owned request receipt and quota reservation;
canonical RequestLifecycle outbox submission with a real invocation receipt;
Core-owned draft reconstruction and transaction-time access recheck; owned task
projection and explicit copy locales; separate durable web message records;
selected request detail polling; a total body-read deadline; and customer access
recheck before each new paid Studio reservation. No Telegram send/read marks are
used for web messages. Office keyset regressions found by the full combined suite
were repaired without dropping customer isolation. Migration083 remains unreleased
and was corrected before its first deployment; migration084 adds the canonical
web receipt/message tables and the narrow generation gate.

Affected proof:68 lifecycle/ownership/database tests,36 timeout/ledger tests in an
overlapping follow-up,13 website tests; all pass without failures/skips.745 active
backend test roots compile. Full website previous checkpoint:837 pass; current
website and combined-source qualification in progress. Exact failed full-run and
query-plan attempts are retained in WEB_LIFECYCLE_PROOF.json.

Next required slices: ordered photo admission, current captured previews, owned
revision/seen-question/cancel actions, independent customer acceptance and safe
PNG/PPTX download; hosting gateway and real two-user/RTL/Canva/restart admission.
The application still enforces generation disabled, and the launcher remains soon.

Final admission follow-up:56 affected backend tests passed,0 failed/skipped, including actual chat intake and shared budget regressions. Website full suite:840 passed,0 failed/skipped;14 affected tests pass after correcting the nested main landmark. These counts replace the earlier checkpoint wording for their respective tested source. Full-engine/source seal and public customer journey remain open.

Private lifecycle transport correction: direct HTTP ingress is refused by actual Restate (400, private service). Signed `ChatInbox.webOpen` now verifies worker command refs, Core matches the retained command and live ownership, and the existing SDK sends to private RequestLifecycle. Isolated real Restate rehearsal passed (same genuine replay receipt, one evidence read/projection/message, tamper403).91 affected tests pass,0 failed/skipped. See ADR260 and WEB_LIFECYCLE_PROOF.json. Full-engine regression is next; public generation and launcher remain disabled.

First sealed combined full regression:8061 passed,1 failed,67 skipped. The failure was the normative route inventory missing the two intentionally added worker-only endpoints. The reviewed inventory delta is exactly those two POST routes; all22 route inventory tests pass after correction. Final full requalification pending.

## Final verified checkpoint

Engine tested commit1fcc15bb:8062 passed,0 failed,67 skipped; source manifest verified. Website6d46370:840 passed,0 failed/skipped;3 actual Chromium synthetic-transport controls pass, plus types/build/affected lint. The browser found and repaired a shared nested main landmark missed by unit wrappers. Hawa gateway actual isolated Restate replay/private handoff/tamper proof passes. No deployment, publication, public generation or customer/provider acceptance claim. Subsequent commits record evidence only. Ordered photos/current preview/actions/acceptance/download/hosting and real customer journey remain required.

## ADR261 customer photo continuation —2026-10-02

Website uploads/reorder/automatic-all-count now implemented locally, with immutable owner/client receipts, native ffmpeg decode bounds, same-key replay and durable originals. Six-photo actual Core projection and Studio reads retain requester order; actual Restate SDK preserves six refs unchanged. Explicit count is exact in deterministic solver/hard QA; source photos cannot be dropped by a model classification. Failed uploads block submission until resolved or explicitly removed.216 focused tests,842 website tests and5 browser controls pass. First full engine8071/2/67 is retained: release seal/untracked ADR manifest refusals require a clean committed source before final qualification. No public launch, generation or deployment.

Next coding slice is current captured previews, then owned actions and independent acceptance/downloads. Public hosting choice and real Supabase/customer/Canva/native RTL/restart verification remain pending. Unreleased migration085 adds photo receipts and retains all old blob GC roots.

Final sealed source4cb7bc51 qualifies:8073 passed,0 failed,67 skipped; source-manifest verified, blueprint1933/0/0,745 active test roots plus Core/worker/scripts types pass. Website3455659:842 tests and5 real Chromium synthetic-transport checks pass; full lint0 errors/14 inherited warnings, types/build pass. Source and upload scope qualification remain local; paid native/customer/hosted acceptance is not inferred. See PHOTO_ADMISSION_PROOF.json. Photos are locally implemented; current captured preview is the next required slice.


## ADR262 current captured native preview —2026-10-02

Customer detail now carries bounded metadata for the current primary bound Canva PNG. A narrow owner/live-grant database routine preserves raw native-table isolation, refuses stale request/binding/capture/hash and observed native-version mismatch, and returns stored bytes only for an authenticated current read. Strict native PNG/hash validation and two-read concurrency bounds protect Core; no-store/no provider URL prevents browser authority leaking. Site hashes bounded authenticated bytes before a transient object URL, and clears it on capture/selection/access changes. Preview is explicitly a capture, not final QA, acceptance or editable-download proof.

99 connected engine controls,847 website tests and6 actual Chromium synthetic-transport controls pass. See CURRENT_PREVIEW_PROOF.json; full sealed source qualification pending. Migrations083–086 remain unreleased, public generation disabled, Designer launcher soon. Next: owned revision/answer/cancel controls and independent acceptance/current-QA PNG/PPTX download. Hosting and real customer/provider/native language/recovery admission remain open.

Final sealed engine1d8ccdd4:8082 passed/0 failed/67 skipped;745 active test roots/Core types, source manifest, blueprint1937/0/0, any ratchet952≤1053 and provider-egress checks pass. Websitee4e5492:847/0/0 tests,6/0/0 browser controls and types/build/affected lint pass. Full source checkpoint is qualified locally; no deployment/public switch or live customer/native quality admission. Current preview is implemented locally; owned actions are next.


## ADR263 customer workflow actions —2026-10-02

Owned revise, answer, explicit seen and cancellation now reuse the private RequestLifecycle and existing intake/revision/task ledger. Immutable body/hash/user/revision receipts and a canonical outbox bind retries; committed projections reconcile after lost replies and revocation. Permanent intake refusal rolls back partially created child tasks and records a refused action. Original exact text and ordered photos survive; replacement facts require a separate explicit field. Manual-origin requests cannot invent an automatic design owner. A narrow customer basis routine provides current task/revision/stage/automatic origin without widening customer table privileges.

The browser retains and displays the exact saved payload/key, waits for applied/refused acknowledgement, keeps unsent feedback on its reviewed version/question, and requires explicit review after a change. Receipt stages are not approval. Seen names the actual web message; reminders use the existing office calendar.

182 connected checks, 746 strict test roots, Core/worker/scripts typing and provider-egress/any limits pass. Website856 tests and7 actual Chromium controls pass; transport is synthetic Auth/customer. Actual isolated Restate1.7.10 verifies private HTTP refusal, signed references, awaited SDK handoff, one owner projection/ack/cancellation notice and genuine stable invocation replay. Its first run exposed the dropped asynchronous handoff; original failure is retained and repaired. Full sealed regression is pending. See CUSTOMER_ACTIONS_PROOF.json. No public launch, deployment, paid provider or native/human quality claim. Next slices remain acceptance/downloads, website CI, hosting and genuine customer/native/recovery admission.

First full action sourceab5f0a2e:8098 passed/2 failed/67 skipped, retained unchanged. Both failures were existing narrow-worker outbox INSERT/fallback paths: PostgreSQL parsed the private action table referenced by a customer-specific policy. Policy now applies only TO hawa_app; no worker privilege widened. Sixty actual worker/customer controls pass after repair. Clean source reseal/full qualification is required before completion of this slice.


Final ADR263 sealed65e6d024 qualification:8100 passed/0 failed/67 skipped;746 strict roots/Core/worker/scripts types, source manifest and blueprint1941/0/0 pass. Website223ff54:856/0/0 tests and7/0/0/flaky0 Chromium controls; types/build/affected lint pass. Original worker-policy failures remain unchanged in proof history; customer-specific policy now applies only to Core's app role. Actual isolated Restate owner handoff/projection/ack/cancel/replay passes; no native/public quality inference. Actions are implemented locally. Next: independent customer acceptance/current-QA/hash/native-version PNG/editable PPTX downloads, CI repair, hosting and real two-user/native/edit-save/re-export/restart acceptance. CI diagnosis confirms26 stale lock declarations,4 missing scripts, Node18/test-engine incompatibility, undeclared coverage provider and actual npm-ci peer resolution failure. Migrations083–087 stay unreleased; generation stays disabled and launcher soon.


## ADR264 reproducible website rebuild —2026-10-02

Website0dbab21 now passes normal isolated/worktree npm-ci with exact root pins,
valid dependency graph, types including test/browser/build configs, lint0errors/
14inherited warnings, production/PWA build,853 deterministic unit tests and7
synthetic Chromium Designer controls. Required peer/runtime/script/coverage-tool
repairs are qualified; original failures remain. Engine runtime and migrations
are unchanged from the previously qualified ADR263 source.

The old live anonymous RLS test accepted network/credential/server errors as
success. It is now a separate explicit live gate, with actual permission/empty
read classification controls; no live RLS pass is inferred. Global coverage fails
unchanged thresholds (37.27lines/35.82statements/31.17functions/29.14branches).
Production performance fails three missing protected-member fixtures; two checked
Auth screenshots fail absent reviewed baselines. Audit has0high/critical and6
moderate findings. Complete CI/Linux/native/customer admission remains open.
See WEBSITE_CI_PROOF.json and ADR264 for commands, hashes and failure history.

Next remains customer acceptance plus current native-version/critical-QA/hash-bound
PNG/editable PPTX downloads, remaining release gates, hosting/HTTPS/coordinated
restore and real two-user/Supabase/Canva/Arabic-Sorani/edit-save/re-export/restart/
other-app/human quality acceptance. No public switch, push or deployment.


## ADR265 customer native review check —2026-10-02

Read-only current native file eligibility is implemented locally. A narrow owned
bundle checks the exact preview and paired editable export/current QC/source/policy,
active brand version and pending-action barrier. Core rehashes/parses real bytes,
checks dimensions/copy/fonts/direction/source pictures and then reads Canva through
the stored actor connection; live scope and canonical evidence are rechecked afterward.
No staff approval or customer acceptance is issued. Native RTL visual review remains
required. One exported picture cannot qualify two source objects.

132 focused backend controls,746 strict roots,858 website tests and8 real Chromium
synthetic Auth/customer checks pass. Full sealed engine regression pending.
See CUSTOMER_REVIEW_PROOF.json for exact limitations and original failed attempts.
Next: canonical customer acceptance and authorized hash/native/QA-bound downloads.
Public generation stays disabled;083–088 are unreleased; no deploy or launch.

First sealed ADR265 full runefbeca3e:8110passed/2failed/67skipped. Both failures
are explicit migration inventories still ending at087. Startup LAST and the real
concurrent-upgrade expected list now include exactly088. Original full report is
retained; focused migration and final sealed qualification are required.


Final ADR265 sealed342a6512:8112passed/0failed/67skipped; source manifest
verified. Native review eligibility is locally qualified, not a customer acceptance
or download implementation. Website5a12787:858/0/0 and8/0/0/flaky0 actual
Chromium synthetic controls, types/build/affected lint/scanner pass. Original
migration inventory and synthetic scanner failures are retained. Next is canonical
independent customer acceptance/current native/QA/hash-bound downloads. Existing
website release gates, hosting/HTTPS/restore and real two-user/native language/
edit-save/re-export/restart/other-app/human quality still block public launch.

## ADR266 independent customer acceptance/downloads — 2026-10-03

Implemented through the existing immutable actions/outbox/private RequestLifecycle.
Acceptance pins reviewed PNG/PPTX and the full native evidence fingerprint,
repeats actual-file and native checks, reauthorizes at commit, advances the owner
revision once, and waits for durable acknowledgement before download eligibility.
It retains the current task in office human review. Each authenticated download
rechecks actual bytes/native state and live current evidence. Changed native state,
QA, captures, source/policy, scope, revisions or pending actions block downloads.
Retries reconcile committed outcomes before provider or current grant access.
Current accepted requests release their quota slot; an admitted revision reserves it
again. Core exposes the download checksum through CORS; the browser verifies it,
length, content type and actual hash before creating a download.

98 focused backend checks, including actual restricted-role migration/HTTP controls,
and all746 strict test roots pass. Website acceptance journey and unit qualification
are tracked in CUSTOMER_ACCEPTANCE_PROOF.json. Full sealed backend regression pending.
Public generation stays disabled, Designer launcher soon and083–089 unreleased.
Existing release CI, hosting/HTTPS/restore, hosted two-user/native RTL/edit-save/
reexport/restart/other-app and human quality gates remain open.


Final ADR266 sealed3334b115:8128 passed/0 failed/67 skipped;98 focused and
746 strict roots pass. Website a8fdd2e:863/0/0 and9/0/0/flaky0 synthetic
Chromium controls. Release source seal and blueprint1953/0/0 verified. Acceptance
and actual current-file downloads are now locally qualified. Cross-lane integration
of Claude designint01b3e243 (ADR271/273/274/275), existing release gates,
hosting/HTTPS/restore and hosted two-user/native RTL/edit-save/reexport/restart/
other-app/human quality remain open; no deployment or public switch.


## ADR277 real managed identity/Core boundary — 2026-10-03

Website ADR0019 provisions a fresh owned vendor fixture automatically:126 website
migrations and25 actual Auth/REST/private Storage checks pass. An independent
engine DB applies89 upgrades through the production runner. Actual Auth-issued
tokens traverse production createApp HTTP/native access RPC and restricted
hawa_app RLS.20 controls pass: two accounts/brands, request read isolation,
workspace/account revocation, office-key refusal, CORS and the closed generation/
upload guard. Direct repository receipt seeding is not public generation/design.

Native19/1 exposed invalid signature Auth403 bad_jwt misclassified as503. ADR277
maps only that bounded identity error to401. Contract red33/1 then113/0 and757
strict roots/types/lint/egress/ratchet pass. Prior full8,277/0/67 is not rerun.
All owned Core/DB/roles/vendor resources/private files are removed; ten prior
container IDs/states unchanged. NATIVE_CUSTOMER_CORE_PROOF.json records scope.
No production write, push, deployment or paid call. Hosted TLS/DNS/browser login/
upload, generation/worker/native Canva/quality, coverage/remote CI/restore/hosting/
cutover remain open. Full app goal stays active.


## ADR278 actual browser canonical intake — 2026-10-03

Existing explicit generation startup switch now reaches the production factory; defaults/example/public remain off. Malformed switches and generation-on/API-off refuse.82/2 baseline →118/0/0 contracts;757 strict roots/types/security/egress/ratchet pass. Actual production browser/native Auth/Core/restricted DB form201, reload and exact body/key replay200 pass9 browser/22 native Core controls on fresh126/89 migrations. Native stored declared Sorani copy/story geometry/owner and one canonical outbox command match. No projected task/worker/provider/Canva result is fabricated. All owned resources/private inputs removed; ten prior containers unchanged. Prior expiry8/0/default services25/full suites retained, not rerun; coverage FAIL. Whole worker/Canva/photos/hosted/native human quality/CI/restore/hosting/cutover remain open. NATIVE_INTAKE_PROOF.json.


## Website ADR0022 actual worker/browser handoff — 2026-10-03

Website a11cf9c on unchanged engine7641f7fb passes9 actual browser intake,7 real
worker/Restate and8 post-worker browser controls plus22 actual Core controls.
One actual request/task/open command, two durable web notices; fresh login/reload
shows Needs attention/no invented preview, second-member exact-ID read denied.
Worker uses distinct service/design credentials and a separate restricted login
with no task writes or RLS bypass. Current source/dependency binding and native
Restate1.7.10 registration verified; no synthetic Core or design handler.

Automatic outcome DESIGN_REJECTED/CLIENT_REFERENCE_CHANGED comes from the
identity-only fixture's incomplete brand record. This qualifies actual handoff
and truthful refusal reporting, not successful generation. Next use a valid
versioned client reference for the real photo/provider/Canva journey. Native
preview/revision/acceptance/download, fonts/RTL/edit-save-reexport/human quality,
hosted customer/other-three-tools/PWA, interrupted state/recovery, coverage/current
full regression/remote CI/security, hosting/HTTPS/coordinated restore/cutover remain
open. Defaults/public off/Soon unchanged. No push/deploy/paid/provider call.

Historical cached Core image was absent and refused before engine setup; current
28fe72f2 dependencies match current mounted source. First native handoff6/0 had
stale parent cleanup metadata; the fresh lane reloads the child's marker and
retains exact container/login/volume cleanup. Both fixtures and private inputs
removed; ten prior containers unchanged. Current full suites/expiry/coverage not
rerun. NATIVE_WORKER_HANDOFF_PROOF.json cross-links the website report/hash.

## Valid brand/font provider wait and actual paid v3 trial — 2026-10-03

Website cb3b77b/ADR0023 now proves the unchanged real browser request with actual
versioned DNA, verified stored logo/palette and fonts that cover its mixed copy.
23 Core/9 browser intake/8 worker/8 browser readback pass. Native Restate's exact
dr-<browser-task-id> records MODEL_NOT_CONFIGURED/backing-off; the providerless
fixture keeps the queued request/notice after native login/reload. Initial
21-vs20 guard, vendor bootstrap failure, Noto glyph refusal and6/2 incorrect
terminal-outcome assertions remain in the proof. Production retry policy is unchanged.
All five owned fixtures cleaned; ten pre-existing containers unchanged. No paid
provider or Canva is connected to this web lane, and it proves no completed design.

A separate actual gpt-6.1-sol workshop trial uses v3 (stored tournament evidence),
13 calls/$0.19488/182.5s, passes local QA and produces a PPTX with5 exact live copy
strings/7 text shapes/2 pictures. Inter/Inter ExtraBold are admitted KAAE poster
faces; Crimson Pro is the document heading preference, not a universal poster rule.
The suspected root-only source-channel bypass is disproved: the task repository
retains both root and payload and the real tournament is explicitly v3. The trial
script now records the stored mode and input hashes to prevent future guesswork.
Native Canva upload remains unverified: connector raw PPTX upload403, then a fresh
URL400 Unsupported file format ZIP. Browser upload confirmation is pending.
Model judge status is advisory, not human-quality admission. No production
deployment/push/public activation. Full customer provider/Canva/photos/revision/
accept/download, native RTL/fonts/edit-save-reexport/human/taste, hosted tools/PWA,
interrupted state/restore/coverage/CI/hosting/cutover remain open.

Evidence: NATIVE_BRAND_PROVIDER_WAIT_PROOF.json and LIVE_CLIENT_GENERATION_PROOF.json.


## Actual six-photo HTTP failure and repair — 2026-10-03

Six actual browser file uploads/replay/order/use-all/member isolation pass13/0. Native worker first projection fails409 IDEMPOTENCY_CONFLICT because openDraft omits customerWebPhotos. Retain4/6 worker and23/1 Core; all owned resources removed. ADR279 preserves only strict bounded web photo manifests; retained owner brief remains authoritative. Mounted HTTP regression red409→200;86 connected checks/757 typed roots/lint pass. Native rerun and full release pending. CUSTOMER_PHOTO_HTTP_PROOF.json.

ADR279 second native lane retains13/0 browser,4/6 worker,23/1 Core; UNVERIFIED_DESIGN at hash-only original read. One-connection mounted HTTP reproduces409. Complete owner-verified reference keeps hash/size checks and needs no additional metadata connection.86 focused/757 roots/lint pass; native and current full gates pending. Prior f5d9ec8c full8288/0/67 retained, not transferred to this runtime.


## Six-photo native final checkpoint — 2026-10-03

Website79c388c / tested engine371e18a9:24 Core/13 actual browser intake/10 restricted worker/9 browser readback pass. Six exact originals/order/task files/all policy survive; same-file replay retains six receipts and foreign-member attachment is refused. Exact native DesignRun MODEL_NOT_CONFIGURED/backing-off remains a providerless wait, not generation. Two native failures and both mounted red assertions retained; all three fixtures and private inputs removed, ten pre-existing containers unchanged. Full8288/0/67,750 passing files/6 skipped,86 connected/757 typed roots/lint pass. Documentation-only final changes; runtime equals tested371e18a9. CUSTOMER_PHOTO_HTTP_PROOF.json. Real provider/Canva/creative/native/human/hosted/recovery/coverage/CI/hosting/cutover remain open.


## Actual customer model failure and standard constraints — 2026-10-03, ADR292

Website1263be2 retains56 actual native transport controls and15 no-network relay
controls. Eight real Sol calls ($0.0956035 pinned quote) produced no valid design:
three standard proposals/repairs violated story bounds. Typed website photos were
retained, but their intent was absent from brief/standard layout prompts. This is
failure evidence, not native Canva/customer/human admission.

ADR292 repairs the prompt/normalization agreement with existing story hard QA,
brief/standard photo directives, and flexible automatic website coverage. Exact
copy, media ownership, hard validation and v3 profile admission remain unchanged.
Four initial red checks, two brief red checks and one automatic-policy red check
are retained. Rebuilt182 connected checks/759 strict roots/lint pass; initial full
8296/1/67 has the correct unsealed release-manifest refusal. Clean seal/full/native
repeat and the Claude release-3 merge (including its new bidi-js dependency) remain
pending. No deployment or human/quality/Canva/source-success claim.
Evidence: STANDARD_CUSTOMER_STORY_PROOF.json and website REAL_PROVIDER_CUSTOMER_PROOF.json.


### 2026-10-03 — Story repeat and bounded repair context

Sealed06ed25a8 full8297/0/67 passes. Fresh actual Auth/browser/Core/worker/Restate/Sol transport56/0 passes; real design still fails on logo/title collisions,8 calls/$0.131076 at pinned rates,0 preview/source/Canva/human approval. All owned resources/private files removed; ten previous containers unchanged. Repair now receives the normalized rejected layout as untrusted JSON, pixel units and expanded logo clear space explicitly, and schema coverage follows admitted automatic/all/count policy. Red1/3 -> focused106/0,759 strict roots/lint PASS. Native repeat and Claude release merge remain pending. Do not claim design or customer completion.


### 2026-10-03 — Real editable source and Claude release-3b integration

Actual enginebe34b755/website runtime1263be2 produces one local PNG/PPTX winner through13 paid Sol calls/$0.2094244 at pinned rates. Inspection verifies two exact live-text blocks, all six original hashes/ordered placements and seven independent pictures. Native design still FAILED because this isolated fixture has no Canva grant; no delivered customer or human quality approval. All owned resources/private inputs removed; ten prior containers unchanged. Website evidence52fba87.

Pinned Claude release-3b b56020bf brings lifecycle Desk intake, true operations health, all paid spend reporting, Sorani raster shaping and canary/intake fixes. Shared moved parser preserves strict web photo manifests, including empty website marker; empty substitution for actual photos remains409. Rebuilt mounted HTTP regression81/1 ->107 focused/813 strict roots/lint PASS. Retain stale-export27-failure lane. Both full traceability histories retained. Commit/seal/combined full and native repeat remain pending; do not deploy an older office release. Native Canva specific-file upload permission, customer/human/hosted/coverage/recovery/cutover remain open.


## Focused native compatibility and handoff recovery — 2026-10-03

Actual authorized hero_storyboard native bytes expose a missing Crimson Pro Bold
full-name alias. Pinned font metadata verifies it is the requested Crimson Pro
family; exact native titles/fonts and all5 pictures/logo now pass. ADR209 adds
only that measured name, retaining unknown-family and manual DNA refusals.
ADR293 corrects native setup/connectivity/reconnect exceptions entering a
second-design fallback: transfer now retains the source and uses the existing
retry/operator path. Resumption preserves exact plan/hash/bytes/import key and
makes no new model calls. Genuine red cases retained;163 affected checks, build,
813 strict roots/types/ratchet/egress pass. No full regression repeat or new
provider/native upload/deployment. CRIMSON_NATIVE_FONT_PROOF.json records scope.

Live office b56020bf is healthy/Canva connected/Sol6.1. Native acceptance metadata
and titles remain accessible read-only. A manually imported earlier design is
not the new customer workflow; actual new preview/revise/accept/editable download,
human multilingual/real-client quality and hosted release gates remain open.
Specific new-file upload approval and hosting choice are still unanswered.
