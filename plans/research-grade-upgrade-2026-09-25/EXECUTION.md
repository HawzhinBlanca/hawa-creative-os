# Completion checkpoint

## 2026-09-27 — Named budget policy administration (ADR-098, locally qualified)

Desk Operations now reads current shared limits, consistent daily usage and
paginated policy history, and lets a current named administrator review and append
office/client/role limits with a reason. SQL checks version/hash/authority under the
existing spending admission lock; direct runtime table mutation remains denied.
Exact replay precedes stale-revision checks and preserves the original receipt.
Lower caps retain prior charges/reservations; zero stops new admissions, and
removing an override restores its default. Browser actions are saved by office/user
before dispatch and retained across uncertain answers, remounts and newer policies.

Source e0c8744; tested candidate and fresh app images **7743355**. Full regression:
**4019 passed, zero failed,59 skipped**,483 passing/7 skipped files,130.84seconds.
Focused SQL/Core/domain/Desk and migration checks:88 passed across9files; final
browser-safe import follow-up:5 Desk tests/build pass. All491 active test roots and
source/scripts compile. Lint981/1053 (nine existing egress exceptions), scanner,
11-pattern self-test and blueprint991/0/0 pass. The new workspace dependency reuses
existing domain code; no third-party package was added. First failures are retained.

Fresh Core/worker/Desk images all identify7743355 with sourceChanges empty. The
selected full-app synthetic scenario passes63 workflow/recovery invariants;43
scenarios were not selected. Twenty-one real Chrome/budget checks pass: explicit
change review, named cookie/CSRF, refusal of shared authority and foreign origins,
deliberately lost successful response followed by reload and exact replay, stale
proposal refusal, actual Core restart and zero additional model requests. Original
synthetic limits are restored and the temporary administrator revoked. Review and
form screenshots were visually inspected. Isolated health at11:27:37 UTC remains
degraded, with PostgreSQL/Restate connected and zero paused/backoff/inbox jobs;
live Canva/model/Telegram API remain unverified and both new design flags off.

No production change or real provider request. Next: replace hard-coded fixture
PASS100% displays with actual evaluation evidence; remaining paid paths; typed
completed-result recovery; real office/native Canva/human multilingual/design and
held-out quality admission; independent-host restore and controlled rollout. The
whole-app goal remains active. See R21_NAMED_SPENDING_POLICY_PROOF.json and
runbooks/SPENDING_POLICY.md.

## 2026-09-27 — Exact-call accounting (ADR-097, locally qualified)

Migration 053 adds named, immutable revisions of exact Studio/evaluation/voice
cost evidence. Original outcomes and execution holds remain; unused allocations
can be released using terminal evidence while the greatest retained cost counts.
Snapshot checks include late outcomes and prior attestations. Foreign-key scope,
SQL authority/immutability, concurrent revisions, exact keyed replay and original
receipt preservation are covered. Desk Operations exposes paginated call costs,
local evidence-file hashing, attributed history, conflict notices and saved retries.

Full regression on sealed candidate **885779f**: **4002 passed, zero failed,
59 skipped** (480 passing and seven skipped files), 123.28 seconds. Focused
correction suites passed 112 tests; named-cookie/origin controls passed 19 tests;
the final form layout passed 12 Desk tests and its production build. All 488 test
roots and source/scripts compile; lint remains 981/1053 with nine existing provider
egress exceptions. Scanner and its 11-pattern self-test pass. Initial failures
remain in the proof: route/migration inventories, RLS helper hoisting, probe setup,
and deployed nginx dropping the browser port. The proxy now preserves full Host
authority while Core continues refusing a different-port browser origin.

Fresh Core/worker/Desk images all identify **885779f**, with no changed source.
The selected synthetic full-app rehearsal passed 63 workflow/recovery invariants
(one scenario executed; 43 not selected). Twenty deployed Chrome/accounting checks
passed, including cookie/CSRF, immutable original receipt, actual Core restart,
exact action replay and zero additional provider requests. The temporary named
administrator was revoked. Final screenshot inspection confirms readable form
labels, cost history and controls. Evidence is local and synthetic; no real invoice,
paid provider call, real delivery or production deployment was qualified.

At 11:02:50 UTC /14:02 Baghdad, isolated health is degraded: PostgreSQL/Restate
connect, paused/backoff/inbox and parked-message counts are zero, while live
Canva/model/Telegram API checks remain unverified. Both new design flags stay off.
Budget policy administration, other paid paths, typed result recovery, truthful
fixture-case presentation, real operational/human/quality admission and independent
restore/controlled rollout remain open. The whole-app goal is not complete.
See R21_CALL_COST_ACCOUNTING_PROOF.json and runbooks/CALL_COST_ACCOUNTING.md.


### Final ADR-096 source and runtime qualification, 2026-09-27

Shared office/client/role admission is locally qualified for Studio, fixture
evaluation and retained voice. Implementation404b2eb, fixture-corrected sourcee870775,
full tested seal3f1cff9: **3987 passed, zero failed,59 skipped** (485files;
478passed/7skipped),120.52seconds. Initial full3984/3/59 exposed a historical
migration020 fixture using the wrong input schema; corrected without altering the
old migration. All486 test roots, source/scripts, lint981/1053 (nine existing
provider-egress exceptions), Desk build, security/11-pattern self-test and
blueprint979/0/0 pass. Focused86 and migration follow-up19 include actual Core kills.

A real Chrome inspection exposed unreadable receipt buttons. UI-only follow-up
7f85334 applies existing Desk styles, with10 affected tests and a successful build.
Fresh isolated runtimeb3d10f7 has matching Core/worker/Desk image labels, no changed
source and63 deployed workflow/recovery checks. Eighteen additional checks verify
migration052, saved allocations, no invented evaluation client, zero-allowance
refusal with zero model transport, unchanged replay, and Chrome display/reload/close.
Synthetic policy is restored and the test administrator revoked. The two unmatched
Gemini fake responses are intentional uncertain-outcome controls. No live provider,
real delivery, human approval or production deployment occurred.

Current isolated health remains degraded because Canva/model/Telegram API are
unverified; PostgreSQL/Restate connect with zero paused/backoff/inbox counts and
both new design flags off. This is a fresh synthetic test app, not live admission.
Next: named policy/accounting repair (including completed estimated/unknown calls),
other paid paths, typed result recovery, truthful fixture-result presentation,
real office/native Canva/human/held-out quality and independent recovery/rollout.
Proof: R21_SHARED_SPENDING_PROOF.json; screenshots and failed-first logs are retained.

## 2026-09-27 — Shared office admission (ADR-096, candidate)

Migration 052 shares the original Studio daily policy and PostgreSQL lock with
fixture evaluation and retained-voice admissions. It binds the request allowance,
policy version, client/role and database admission time before transport. Unknown
and estimated obligations remain held across midnight; original known costs and
larger overruns survive settlement. Evaluations do not invent a client. Voice
budget refusal preserves the original audio and manual copy review. Desk exposes
the shared balances and separate daily allocation/request bound/usage values.

Two initial Core controls proved zero allowances still dispatched. Later runtime
SQL testing exposed a foreign-client admission through the office-role helper;
explicit ownership and a composite foreign key fix it. Final connected evidence:
**86 tests /13 files pass**, including cross-path races, role/client/office caps,
stale snapshot and malformed/changed identities, previous-day obligations,
settlement maxima, native Core SIGKILL/replay, retained audio and UI cost clarity.
All486 strict test roots, source/scripts, lint981/1053 (nine existing provider-egress
exceptions), Desk build and security/11-pattern self-test pass. Earlier failures
remain in the evidence; full sealed regression follows.

No runtime image, live provider call or production change. Named policy/cost
repair, other paid-path integration, typed completed-stage recovery, fresh runtime,
real Canva workflow/human/held-out quality and independent recovery remain open.
Proof: R21_SHARED_SPENDING_PROOF.json. Operation: runbooks/STUDIO_DAILY_BUDGETS.md.

### Final ADR-094/095 source qualification, 2026-09-27

Source `78c9094`, tested seal `2fbedf9`: **3,973 passed, zero failed, 59 skipped**
across 484 files (477 passing /7 skipped), 114.96 seconds. All 485 strict test
roots, source/scripts, lint (981 any /1053; nine existing egress exceptions),
Desk build, security scanner/11-pattern self-test, blueprint 975/0/0 and source
manifest pass. All 18 source hashes matched. Production dependency audit reports
zero known vulnerabilities with no exclusions; CycloneDX lists 314 components.

This qualifies the shared schema repair and candidate parser compatibility. The
app still needs shared evaluation/voice daily budgets, administration/accounting
repair, typed completed-stage recovery, fresh runtime/browser and real office/
Canva/human quality/independent-host qualification. Runtime and production are
unchanged. See R21_GATEWAY_SCHEMA_PROOF.json.


## 2026-09-27 — Shared response schemas and parser patch (ADRs 094–095, candidate)

Replaced the partial gateway checker with pinned Ajv and format validation.
Schemas compile before transport; malformed/unknown/async/external-reference
contracts fail without spending. Finite JSON and all declared schema constraints
apply to cloud/local answers. No answer mutation; execution provenance and exact
schema hash are envelope metadata. Evaluation calls now declare their consumed
fields and use replay protocol v2. A rejected paid answer retains cost/quote/hash
and stops replay/new work until reconciliation.

Forty initial controls failed before the repair. Final connected verification:
230 tests/22 files, including actual Core SIGKILL/replay. Strict types cover 485
active test roots; source/scripts, lint (981 any /1053, nine existing egress
exceptions) and Desk build pass. Initial type import issues and sandbox IPC/DB
failures are retained in logs; no suppression was added.

Dependency review found a published fix for the two old ignored image-size
advisories. ADR-095 pins 2.0.4 under pptxgenjs 4.0.1, removes both exclusions, and
passes 77 transfer/Canva-package tests plus zero-vulnerability production audit.
CycloneDX lists 314 components. Full sealed regression is pending. No new runtime
image, native browser run, live provider call or production deployment. Shared
evaluation/voice daily admission, budget administration/accounting repair, stage
recovery and fresh/live/independent-host qualification remain open.
See R21_GATEWAY_SCHEMA_PROOF.json.


### Final ADR-093 request-spending qualification, 2026-09-27

Source `13a4acd`, tested seal `8a47f63`: **3920 passed, zero failed, 59 skipped**
across483 files (476 passed/7 skipped),113.74seconds. Strict source/scripts and
484/484 test roots, lint986/1053 with9existing egress exceptions, Desk build,
security scanner/11-pattern self-test, blueprint969/0/0 and manifest pass.
All18 source hashes matched before evidence finalization. This is local request
spending qualification; no new runtime image, live bill or production rollout.

A separate read-only probe confirmed the old shared schema checker incorrectly
accepts fractional integers, non-finite numbers and prohibited extra properties.
Those three controls are saved in the proof's follow-up evidence and remain
unfixed. Correct this gateway prerequisite next, then complete shared evaluation/
voice office limits, recovery/admin controls and fresh/live qualification.

## 2026-09-27 — Gateway request spending bounds (ADR-093, candidate)

The shared gateway now quotes each exact serialized provider body at reviewed
model-specific rates, applies native output caps and one total time allowance,
freezes input/egress/budget across fallback, and refuses invalid/unpriced/expired
or unaffordable work before dispatch. Missing usage stays unknown; Google thoughts,
Anthropic cache input and Sol long-context/cache-writing bounds are accounted for.
Reported overruns stop further work and survive evaluation ledger replay. Desk
distinguishes request bounds from usage estimates. Existing caller dollar caps and
model/reasoning/image selections remain unchanged; the now-documented shared
default output cap is 2,048 and evaluation requests declare it explicitly.

Regression controls first reproduced 22 failures. Connected final verification:
12 files/150 tests passed, including actual evaluation process-kill/replay tests.
Source/scripts, all484 strict test roots, lint986/1053 with9existing egress exceptions
and Desk build pass. Full sealed regression is pending. No paid call, runtime image,
browser qualification or production deployment was performed.

This qualifies request bounds only. Shared evaluation/voice office admission,
budget administration/accounting repair, completed-stage recovery, fresh candidate,
real office/native Canva/human quality and independent-host restore remain open.
See R21_GATEWAY_SPENDING_PROOF.json.

### Final ADR-092 source qualification, 2026-09-27

Source `2ad54b1`, tested seal `32e31b4`: **3879 passed, zero failed,
59 skipped**, 474 passing files/7 skipped, 115.23 seconds.
All 482 strict test roots, source/scripts, ordered lint (991 any; nine existing
provider-egress exceptions), Desk build, zero-secret scan, blueprint 965/0/0 and
source manifest passed. Final tests include malformed policy/identity controls,
Core pre-transport refusal, the updated Desk wording and actual Core-kill recovery.
No runtime image, deployment, native browser check or paid provider call occurred.
This qualifies Studio daily accounting only; whole-app admission remains open.

## 2026-09-27 — Studio daily scope budgets (ADR-092, locally qualified)

Migration 051 derives office/client/model-role daily obligations from the existing
call and settlement ledgers. Database admission serializes across tasks and Core
connections, retains estimated/uncertain obligations across office midnight, fixes
admission timestamps and policy/role identities, and refuses missing historical
accounting. Append-only policy revisions use expected versions and action IDs;
Desk exposes the Studio daily balances and holds. Default daily scope ceilings
inherit the existing USD 30 office ceiling; owner-configured overrides are supported.

Initial 22 DB tests passed. Diagnostic full run: 3869 passed, 6 failed, 59 skipped.
Failures identified old schema expectations/manifest, a membership-check hoisting
regression, retained-policy cleanup and direct receipt fixtures without scope.
After corrections and historical-ledger checks, 10 files/91 tests passed, including
Core zero-transport refusal and the existing actual Core-kill recovery tests. A final
allocation/identity negative test and final Desk wording await the sealed full run.
Strict checking covers all 482 test roots. See R21_DAILY_STUDIO_BUDGET_PROOF.json.

The former R03 PostgreSQL-budget claim was broader than its actual file-controller
test. This evidence qualifies Studio only. Evaluation/voice/gateway budgets, named
Desk policy administration, historical accounting repair tooling, completed-result
recovery, fresh runtime/browser qualification and real office pilot remain open.
Production and the prior isolated runtime are unchanged; schema 051 is local source.

## 2026-09-27 — Studio pre-dispatch spending reservations (ADR-091, locally qualified)

Migration050 stores immutable request-body quotes. Under the task lock, admission
requires recorded/attested cost plus outstanding reservations plus the next quote
to fit the run cap. Missing usage keeps its reserve; complete usage, definite
rejection or exact settlement releases unused funds. A provider overrun is saved
and stops further work. No automatic quality/model/output reduction. Desk shows
reserved and available funds. Text receipts preserve absent provider identifiers,
standard service tier is explicit, and Astra long-context rates are counted.

Three DB red controls failed before implementation. Connected14-file suite passed
177 tests, including actual text/image-vision Core SIGKILL with durable quotes,
after correcting negative-zero and deliberately inconsistent price fixtures.
The initial full run had3851 pass/10 fail/59 skip: fake provider model identity
caused overrun/cascading active-run holds; the old source manifest also correctly
rejected schema050. Fixture corrected. Types481/481, lint and Desk build pass.
First sealed regression7909793:3862 passed/0 failed/59 skipped. An additional
production-price workflow exposed an over-conservative long-context quote.
Policyv2 now chooses the context tier from the conservative input bound; both
production and dev v3 workflows pass in a60-test correction run. No model/quality,
output-limit or budget increase. Final v2 sealed full regression passed; qualification below.
See R21_SPENDING_RESERVATIONS_PROOF.json.

Final policyv2 qualification: source9725093, tested sealc626584,
full regression3863 passed/0 failed/59 skipped across480 files.
The normal suite now contains both production and dev v3 full-flow controls at
unchanged USD2 limits. All481 test roots compile; source/scripts, lint(991 any),
Desk build, security scanner/11-pattern self-test and source manifest pass.
Actual Core text and art/vision kills retain durable quote evidence. Earlier
failed controls remain in the proof. No runtime image or production deployment.


Quotes are conservative operating estimates, not invoice guarantees. Broader
role/office/day caps, typed result recovery, fresh candidate, named live pilot,
native Canva edit/save/reopen, human quality/cost evaluation and independent-host
restore remain open. Production and isolated app deployments are unchanged.


Updated 2026-09-27; retain the faster, more economical completion method.
Branch: `codex/research-grade-design-system`. Scope and acceptance remain in `PLAN.md` and `WORK_ITEMS.csv`.

## Latest checkpoint — 2026-09-27, individual art accounting qualified locally

ADR-090 fixes hidden paid work discovered while designing USD reservations. Each
image attempt and vision verdict now has its own ledger admission, receipt and
budget update. Uncertain verification and failed accounting hold the pipeline;
malformed verdicts cannot approve generated art. The actual image-complete /
vision-accepted / Core-SIGKILL drill passed with durable accounting, restart
refusal and explicit settlement, without replaying paid work.

Full regression:3830 passed/0 failed/59 skipped across479 files. Strict typing:
480/480 active test roots,0 errors. Source build, script types, lint and security
checks pass. Proof: `R21_ART_CALL_ACCOUNTING_PROOF.json`. Production is unchanged;
the isolated app still runs the earlierb641928 candidate/schema049.

Next remains hard USD reservations at these individual paid boundaries, then typed
completed-stage recovery. Price/input/output bounds must cover the actual provider
request; current auto-quality image estimates are not an invoice ceiling. Live
pilot, native Canva edit/save/reopen, human multilingual/design review, held-out
model/retrieval/cost qualification and independent-host/offsite restore remain open.
Existing Workspace/native-edit questions remain unanswered.

## Latest checkpoint — 2026-09-27, complete test type gate qualified locally

ADR-089 replaces the wrapper that ignored compiler failures and filtered source
errors. Independent discovery covers all479 active test roots, including Core,
Worker and browser tests, and detects tests in new directories. Strict Node/Desk
compilation now passes with0 errors (restored baseline406; intermediate119). The
failed diagnostics are retained in `R01_TEST_TYPE_GATE_PROOF.json`.

Full regression:3813 passed/0 failed/59 skipped across478 files. This predates one
final new-directory gate control. Final targeted verification:7 passed/0 skipped,
including six real compiler negative/positive controls and the edited document
fixture through four actual Core SIGKILL boundaries and same-host DB/blob restore.
Final `pnpm typecheck`, `pnpm lint`, Desk build and security checks pass. The release
seal names the final source; no new image or browser execution is claimed.

Runtime changes repair the canonical retrieval conflict fields and declare existing
inline image input support. Fixture changes use current contracts and actual HTTP
adapters with deterministic transports. Production is unchanged; the isolated app
remains the earlierb641928 candidate/schema049.

Next: hard USD reservations and typed completed-stage recovery. Named live intake
through delivery, native Canva edit/save/reopen, human multilingual/design review,
independent-host/offsite restore and held-out model/retrieval/cost qualification
remain open. Existing Workspace/native-edit questions remain unanswered. Whole-app
admission and the broader R01 release programme remain in progress.

## Latest checkpoint — 2026-09-27, named evaluation settlement

Source69039f9 / sealed candidate571b522 implements ADR-085/migration048. Named staff
can close held fixture evaluations with exact snapshot, terminal provider evidence
and known reported costs. Original unknown outcomes and stopped reports remain
unchanged; settlement/replay sends no model request. Desk retains pending keys through
response loss, busy and authority errors. Final3756/0/59 full tests and50/50 deployed
checks pass. Failed-first evidence is retained in R21_EVALUATION_SETTLEMENT_PROOF.json.

Production is unchanged. Next engineering: general Studio provider reconciliation
and response recovery. Continue the named live pilot, native save/reopen and human
multilingual acceptance, independent/off-host recovery, and held-out model/retrieval
measurements. Existing Workspace configuration and native-edit approval questions
remain unresolved; do not invent their answers. R21 and whole-app admission remain open.

## Working method

- Finish connected user journeys with their failure recovery and acceptance evidence. Keep the existing architecture.
- During implementation, run the affected unit, integration and failure tests. Run the full required release checks at a coherent milestone before qualification or deployment; repeat them for concrete new risk or changed code.
- Batch source, tests, traceability and one concise evidence update. Seal a release candidate once it is actually ready for that gate. Do not create another seal solely to rephrase status.
- Read this checkpoint and the relevant source/evidence sections on continuation. Use scoped searches and short logs. Maintain the historical evidence without copying its whole history into every update.
- Keep engineering, live-operation and human-quality acceptance separate. Complete available engineering while real corpus preparation and human review remain pending; no synthetic result substitutes for them.
- Reuse fixtures, the existing Restate workflow and the pinned dependency stack. Add a dependency or redesign only when a measured need justifies it.

## Current result (2026-09-27 — real Canva export and partial reconstruction)

Source `751556f`: current Hawa OAuth refresh/read and real PNG/PDF/PPTX export
succeeded for a disposable copy of an existing Hawa import fixture. Three exact
English blocks survive actual export and reimport as native addressable text.
Current source QA passes exact copy and fixture fonts, and refuses wrong-copy and
wrong-family controls. Reconstruction regenerates element IDs, shifts text boxes
up 2–3 px and increases their height 2–3 px; 2.2452% of decoded PNG pixels differ.
This establishes partial layout reconstruction, not a lossless or account-loss
recovery claim. See `R19_NATIVE_CANVA_PROOF.json` and `R19_EVIDENCE.md`.

A one-field native draft edit preserved other text and geometry. The commit tool's
required approval did not arrive, so the draft was cancelled; committed edit/save/
reopen remains NOT RUN. No native transactions are open. No Hawa task/binding,
approval, publication or delivery was created. Two test designs, four export jobs
and one import were created; the existing OAuth connection rotated normally.
App services and flags were unchanged. R19 remains in progress. Next: approved
save/reopen, real multilingual fixtures, current full-app live flow and human
acceptance; independent-host recovery and measured model/retrieval gates remain open.

## Prior result (2026-09-27 — nightly archive integrity and monitoring)

Source `fdc1f5a`, tested seal `da69f21`: ADR-081 qualifies
**71 backup Python tests and 16 database lifecycle tests**, with
no skips. A red-before run proved that a missing retained pack and a failed cloud
upload both returned success. Every required old/new file pack is now checked
before archive publication, retention or GC. Restore validates paths/types/hashes
and stages only requested files before creating a scratch database. Dump publication
is atomic and last; failed checksum commands cannot pass by comparing empty results. One archive lock covers backup, restore and retention; contention
preserves an active workspace, and crashes release the lock. The incomplete `gs://`
transport refuses before a dump. Local encrypted archive support remains active.

The watchdog now requires the latest successful whole-night receipt and original
capture time with matching local dump/checksum metadata. A fresh dump from a failed
archive attempt is unhealthy. Test types, shell syntax, security, blueprint
**899/0/0**, release verification and all 12 source-hash checks pass. Full app regression
was not rerun for these host scripts. See `R10_ARCHIVE_INTEGRITY_PROOF.json` for exact
source hashes, failed-first evidence, scope and remaining gates.

Loaded host backup/watchdog jobs read this checkout on their next invocation. Job
definitions were not changed, app services were not restarted, and qualification
used only disposable test databases/archives. No production backup/restore or live
notification command was launched. Off-host copying, an independent recovery host,
coherent production capture, real Canva/human/live acceptance and retrieval/model
measurements remain open; R10 and whole-app admission remain in progress.

## Prior result (2026-09-27 — coordinated application recovery)

Source `a3de8c3`, tested seal `10a8087`: **57/57 deployed checks pass** in the selected full-app recovery
scenario; 43 other chaos scenarios are intentionally unselected. At two external
effect boundaries, authenticated encrypted PostgreSQL/Restate/blob copies restore
to fresh volumes. Both restores match **86 tables / 133 RLS policies / 4 registered
blobs** before writers resume. The original pending Delivery survives both restores,
adopts the existing Drive file, never repeats the uncertain Telegram file send,
and completes one publication/Sheet row after explicit synthetic staff observation.
Staff settlement and its replay send nothing further. External fakes stay alive.

A real build-context gap copied ignored private test files into prior candidate
images. Docker now excludes `.run` and backup snapshots; the actual rebuilt Core
and worker images prove the private directory is absent. Earlier failed harness
runs and the presence-only counterexample are retained in
`R10_COORDINATED_RESTORE_PROOF.json`. No credential contents were read.

**50 backup Python tests**, **11 fake-wire tests**, harness types, lint and blueprint
**895/0/0**, security and release-manifest verification pass. All 11 qualified
source hashes match the clean sealed checkout. No runtime app logic changed; the prior 3,634-pass / 59-skip full
app regression remains historical. Temporary helpers/private archives are removed;
original and both restored store sets remain for the retained disposable candidate.
Production is unchanged. This is coherent same-host synthetic recovery; R10 remains
in progress. Real providers, real staff review, unequal capture-window repair,
independent-host/off-host durability and production RPO/RTO are unqualified.

Next: independent-host/off-host recovery and production capture qualification;
real Canva manual edit/reopen with multilingual/human review; a supervised live
intake-to-delivery pilot; held-out retrieval and role-model quality/cost measurements.

## Prior result (2026-09-27 — isolated encrypted database recovery)

ADR-079 adds an opt-in pinned pgBackRest image/configuration and reproducible offline
PITR drill. Final physical restore includes a post-backup task, excludes a later task,
finishes recovery, matches **86 tables / 133 RLS policies**, and preserves tenant
isolation. Natural WAL archive lag **59.573s**; restore/verification **6.632s**.
Wrong-key and missing-WAL controls pass; temporary resources are removed. **43 backup
Python tests pass** and Compose renders correctly. See `R10_PITR_PROOF.json` and
`R10_EVIDENCE.md` for failures, exact hashes and limits. Source `c02ed26`, seal
`de5ad14`: source hashes, release manifest, security and blueprint **891/0/0** pass.
Production is unchanged.

The full app regression below remains historical: no application source changed
and it was not rerun for this infrastructure slice. This same-host synthetic result
does not qualify production RPO/RTO or full-system recovery. Next: pending Restate
journal replay with matched database/files and side-effect reconciliation; clean-host
off-host recovery; real native Canva/multilingual human acceptance; supervised live
delivery; retrieval relevance/latency and model quality/cost measurements.

## Prior result (2026-09-27 — durable controls and saved Studio recovery)

Source e09438a, browser corrections e1468e4, test correction
fbb44d5, tested seal dd62672: **34/34 deployed checks** and
**452 files / 3,634 full tests passed; 7 files / 59 skipped**.
Types, lint, production Desk image, security, blueprint 881/0/0 and release manifest
passed. Runtime sources are unchanged from the deployed candidate; production is
unchanged. R26_TASK_CONTROL_PROOF.json retains earlier failures and exact receipts.

Pause/resume/cancel now commit expected-version, keyed, actor-attributed receipts
with task state. Resume restores the operator checkpoint; cancel closes the task.
New paid/design admissions lock current task authority and refuse paused, closed or
approved/publishing tasks. Previously admitted outcomes remain recordable. Saved
Studio runs survive reload; Desk reports recorded models and accurate status/actions.

Browser created one unadvanced Studio run, restored it after reload, paused and
resumed to the prior state, then cancelled and reloaded. Advancement was disabled
while paused/cancelled. Three durable controls, one retained run, zero model calls.
R26_TASK_CONTROLS.png and R26_TASK_PAUSED.png record the visible state. The first
full run failed 52 tests (51 stage-only stubs plus one route inventory); unchanged
database guard tests and all repaired harnesses passed before the full rerun.

Next: clean-host WAL/PITR and Restate recovery qualification; real native Canva
edit/reopen and multilingual/human review; a supervised live intake-to-delivery pilot;
retrieval relevance/latency and role-model quality/cost measurements. Synthetic
external services and office identities do not qualify those gates. No 10/10 claim.

## Prior implementation (2026-09-27 — durable controls and generation admission)

ADR-078 adds task-state admission at Studio creation, every paid call, candidate
selection, planner reservation, redrive queueing and Canva blank/import creation.
Task locks serialize cancellation and admission; authenticated caller scope is
preserved under runtime RLS. Previously admitted responses and imports retain their
outcomes. Concurrent resume promises are scoped to both task and actor.

The old cancel route actually set failed_operator; pause/resume/retry all targeted
planning and swallowed storage failures. Durable controls now require reason,
expectedVersion and a stable key. Cancel records cancelled; pause records paused;
resume restores the recorded operator checkpoint. Events and state commit together,
with original receipt replay. Generic retry refuses without a saved execution
checkpoint and directs the operator to the saved run. Desk exposes controls, reads
saved Studio history after reload, disables unavailable generation, reports recorded
models and expires/dismisses saved-request messages. RequestLifecycle keeps ownership.

Affected qualification: **16 files / 279 tests passed**; source build and Desk build
pass. Full release suite, fresh candidate/browser and final source seal are pending.
Failed-first cases and fixture corrections are retained in R26 evidence. Production
unchanged; real native/human/provider/retrieval/clean-host gates remain open.

## Current result (2026-09-27 — blank-design policy)

Implementation `196daf2`, corrected candidate `4686e90`, tested seal `6ff3659`:
manual Desk request → blank Canva creation → explicit synthetic manual edit →
checked PNG/PPTX → review → simulated approval/publication passed **29/29 fresh
deployed checks**. Runtime image labels match the candidate; eight services were
newly created, provider callers/parser have internal networks, and no runtime
source changed between candidate and tested seal. Prior PDF/voice/restart/import
checks remain in the same rehearsal. See R26_BLANK_POLICY_PROOF.json.

Full sealed regression: **450 files / 3,574 passed; 7 files / 59 skipped**, 103.00s.
Affected run: 8 files/139 passed, then the expanded blank-policy file/19 passed
(including restricted runtime RLS); counts overlap. Types, lint, production Desk
build, security, blueprint **873/0/0** and release manifest passed. Initial fixture,
type and scanner failures are recorded in the proof. First source-196daf2 rehearsal
passed 28 transport checks, but browser inspection found missing defaultLocale in
the synthetic DNA. Corrected fixture and directory assertion qualify this run;
no runtime validator was weakened.

The existing export operation now freezes matching source policy or exact manual
copy plus active, hashed, human-authored Client DNA families. Migration 046 prevents
policy mutation. Historical-key replay is stable after DNA changes; new review,
approval and publication reject superseded policy. Manual font checks inspect the
script declarations of each run without default or family-prefix admission.
No import row is invented; another design's source or another actor's inaccessible
source cannot provide a fallback. The retained policy accompanies source review.

Browser created task `a0516d5c-118a-4adc-9d9c-4fa4251e38cc`, used blank creation and Capture for
Review, and reached Needs Approval with two exports and zero imported sources.
The bright warning and gray disabled Confirm Approval were visually inspected;
PNG/PPTX stayed selected, the dialog was cancelled and the task remains unapproved.
Screenshot: R26_BLANK_POLICY.png. Provider editing is an explicit fake fixture;
real native edit/reopen and human quality remain unqualified. Production unchanged.

Next: qualify remaining Desk status/control behavior (hard-coded Studio models,
stale intake/binding messages, closed-task action admission). Flags govern automatic
intake in the inspected code; establish the explicit Studio action contract before
changing availability. Then live native/human/provider acceptance, retrieval
measurements and clean-host WAL/PITR/Restate restore. App-wide completion is unproven.

## Prior implementation (2026-09-27 — blank Canva checking, ADR-077)

Blank manual designs now admit exact saved copy with active hash-verified,
human-authored Client DNA font families. New export operations freeze checking
policy before submission; only a matching design's imported source is eligible.
Migration 046 protects policy immutability. Review, approval and publication check
that manual policy remains active, while replay retains historical results.
Manual font checking inspects declared Latin/complex-script faces per run, with no
default-family or prefix match. Copy remains unchanged; native editability and
font-file/glyph coverage remain separate. Approval warning and disabled appearance
are corrected in source. The candidate harness now includes a synthetic native
blank creation/manual edit/capture/review/publication path.

Affected checks: 8 files / 139 tests passed; the expanded 19-case blank-export
suite also passed, including restricted runtime-role admission/review. Initial new-suite failures were an invalid synthetic actor UUID and a reused
synthetic design ID; fixes preserve the database constraints. Types/lint/Desk build
and security scan passed (the scanner first rejected a literal synthetic test token;
it now uses generated fixture tokens). Fresh deployed rehearsal, browser inspection, full sealed regression and
release qualification are still pending for these changes. Production unchanged.

The first source-196daf2 candidate passed 28/28 transport/workflow checks. Browser
inspection then found its new synthetic Client DNA omitted defaultLocale, so Desk
correctly refused the malformed directory. The fixture now supplies a complete
listing identity and the rehearsal asserts directory usability. Runtime validation
is unchanged. Repeat the fresh rehearsal and browser before final qualification.

## Prior result (2026-09-27 — source-backed manual review)

Implementation `b78810a`, test correction `177c2c3`, tested seal `619827c`:
manual Desk generation/import → Capture for Review → current source/preview review
→ simulated approval/publication passed **25/25 fresh deployed checks**. Stable
keys, hash/version matching, actual PPTX text identities, concurrent replay,
recapture and one-time approval invalidation are verified. Native Canva status
stays unverified. Migration 045 permits later Canva review checkpoints with the
same genuine PPTX hash. Browser operator confirmation stays disabled.

Exact sealed regression: **449 files / 3554 passed;
7 files / 59 skipped**. 151 affected + 42 test-correction
checks; types/lint/Desk build/security, tested blueprint 867/0/0 and manifest passed.
The initial two full-suite failures and their fixes remain in R26 evidence.
Runtime images still match `b78810a`; the later changes touched tests only.
See R26_MANUAL_REVIEW_PROOF.json and R26_MANUAL_REVIEW.png. Production unchanged.

Next engineering: admit exact saved copy and approved font policy for checked
exports of blank Canva designs (currently imported source is required), fix the
low-contrast approval warning, and qualify remaining Desk control states. Then
complete real Canva edit/reopen, named human multilingual/creative acceptance,
live delivery/billing, retrieval evaluation and clean-host WAL/PITR/Restate
recovery. Keep the goal active; app-wide completion is not established.

## Prior implementation checkpoint (2026-09-27 — manual captured review, ADR-076)

Manual Desk capture now retains PNG and checked PPTX under stable action keys and
records an attributable review using exact submitted copy and live text identities
read from the retained source. Matching capture versions and byte hashes are
required. Recapture updates source/preview evidence, invalidates approval once,
and refuses stale or closed-task replay. Native Canva verification remains unknown.
Migration 045 permits distinct Canva review checkpoints retaining the same PPTX
hash; other studios retain source uniqueness. Preview checks match their image's
capture version. Operator-required tasks no longer claim an automatic draft failed.

Affected regression: **14 files / 151 tests passed**, including real Core resume
and approval routes, concurrent replay, copy failure, changed binding, source
identity refusal, recapture/invalidation, closed tasks and migration retry. Source
and test types, lint, Desk production build and secret scan passed at the implementation
checkpoint. Fresh deployed candidate and full sealed regression are still pending.
The prior 3,531-test result below does not qualify these changes. Continue with the
extended R1.S3.SOURCES candidate scenario, then browser and release qualification.
Live native edit/reopen, human multilingual/creative acceptance, actual delivery,
retrieval performance and clean-host recovery remain open. No production change.

## Prior result (2026-09-27 — full-app candidate and Desk copy repair)

The isolated Core/Desk/worker/PostgreSQL/Restate/nginx/real Docling rehearsal passed
**22/22 checks**, including PDF exact-copy intake, manual voice revision, process
restart at review, simulated delivery and bilingual Desk intake/generation replay.
Browser testing found a real saved-copy rejection: the planner expected a legacy
headline/divider. Structured Desk copy now stays exact in both languages and the
explicit generation button works against the simulated Canva service. Model
progress wording now points to the actual receipt.

Final source `196d415`, tested seal `94321df`: **447 files / 3,531 tests passed**,
**7 files / 59 skipped**; 47 focused tests, types/lint/security and clean manifest
passed. Core/worker/Desk image labels match source `196d415`; no dirty runtime
sources were present. The first reset left inactive-profile nginx/Docling alive;
the corrected reset now proves all eight containers are newly created. See R26_EVIDENCE.md and R26_CANDIDATE_PROOF.json for exact
image IDs and limits. The disposable app is kept on loopback port 56081.
Production and flags remain unchanged.

Next: correct Desk's misleading automatic-failure wording for manual requests
while preserving the retired-generator spending guard, verify the manual
capture/review/export journey, then qualify real Canva edit/reopen and named human
approval/delivery. Native multilingual quality, retrieval relevance/latency,
clean-host WAL/PITR/Restate restore and independent creative-quality gates remain
open. Synthetic adapters and silent audio establish no live provider or 10/10
claim.

## Prior result (2026-09-27 — durable retained voice)

ADR-075/migration 044 completes local engineering for retained Ogg Opus → locked
client/privacy/model admission → one durable paid attempt → requester exact-copy
review → new/current revision. Desk exposes originals and full unreviewed transcripts.
Unknown outcomes are not retried; actual cost stays unknown. No model is admitted
or production service changed by this work.

All 185 distinct affected tests have passing final observations across the final
affected run and corrected duration-fixture follow-up. The real Core process drill
passed 40 checks across five kills and six starts; all provider replies are synthetic.
Typecheck, lint, Desk build and zero-secret scan passed. Final source `d92014c`
(implementation `aaa5ff7`), tested seal `0621da8`: **447 files / 3,528 tests passed**,
**7 files / 59 tests skipped**. The opt-in voice drill passed separately; blueprint
**859/0/0** and release manifest verified. Initial full run had one task-enum
classification false positive, corrected with an 18-test follow-up before the final
green run. Production remains on its earlier healthy build.
See R07_VOICE_RECOVERY_PROOF.json, ADR-075 and runbooks/REQUEST_SOURCE_REVIEW.md.

Next: qualify the isolated Core/Desk/worker/Docling candidate, then the complete real
request → editable Canva design → revision → named approval → verified export/delivery
and reopen journey. Real multilingual voice/PDF quality, cited Design Plans and
retrieval relevance/latency, clean-host WAL/PITR/Restate recovery and independent
human creative review remain required. App-wide 10/10 is not established.

## Prior result (2026-09-27 — honest voice evidence boundary)

ADR-074 removes fabricated confidence/language/duration and automatic price rewrites
from voice evidence, separates captions, bounds provider transport and holds legacy
voice before download so missing audio cannot turn into a caption-only design.
The standalone text-inspection route preserves exact text and still refuses audio.
Affected checks: **5 files / 55 tests**, source/test types and lint passed. Source
`a03f2fb` / tested seal `d19abb6`: **445 files / 3,498 tests passed**, **6 files /
58 tests skipped**; blueprint **855/0/0**, zero-secret scan and release manifest
verified. No deployment, provider-model or flag change.

Next is the complete retained-audio → trusted locked-client policy → durable paid
transcription → requester copy review journey, with unknown call outcomes preserved
across restart. Then the isolated Core/Desk/worker/Docling canary and complete live
Canva request/revision/approval/export/delivery journey. Retrieval quality, clean-host
recovery and human creative-quality gates remain open. See R20_EVIDENCE.md and
R20_VOICE_EVIDENCE_PROOF.json for the exact scope and remaining work.

## Prior result (2026-09-27 — Telegram PDF source workflow)

The Telegram PDF → retained original → reviewed exact copy → owned request path is
implemented for new briefs and current revision/clarification replies. Admission
freezes the client before IO; refused updates remain refused after restart/flag
changes. Source originals remain available in Desk even if extraction stops.
A demonstrated cross-client task-file download hole is fixed in migration 043.

Affected checks passed **14 files / 180 tests**, including **26 invariants** across
five actual Core kills and six starts, one download/extraction/task/event/outbox.
Typecheck, lint, Desk build and zero-secret scan passed. The separate Docker/Restate
PDF correction-notice scenario passed 5/5 invariants with two completed invocations
and one critical requester prompt. The first full suite passed 3468 tests with one
old tenant-only fixture failure (58 skipped). A follow-up test exposed old-migration
policy replay bypass; mandatory client restrictions and updated actor fixtures now
pass 5 files/30 tests, including the Core crash drill again. Final sealed regression: source `f4adf23`, tested seal `0fd198b` passed **444 files / 3469 tests**, with **6 files / 58 tests skipped**. Blueprint **851/0/0** and release manifest verified. The opt-in Core and Docker/Restate proofs passed separately as recorded above. No production deployment or flag change. See ADR-073, R07_EVIDENCE.md, R12_EVIDENCE.md,
R07_SOURCE_RECOVERY_PROOF.json and runbooks/REQUEST_SOURCE_REVIEW.md.

Next: voice with reviewed copy,
locked client egress and durable paid-call uncertainty, followed by the complete
real request → editable design → revision → approval → export/delivery journey.
Prepare the qualified Core/Desk/worker/Docling candidate for an isolated office-work
canary: the running production containers were healthy on inspection, but the new
source candidate and PDF sidecar have not been deployed.
Cited Design Plans and retrieval relevance/latency, clean-host/WAL/PITR/Restate
recovery and independent human creative-quality admission remain in scope.
Production services and enrolment flags are unchanged; app-wide 10/10 is unproven.

## Prior result (2026-09-26 — PDF process-crash and restore proof)

The retained-PDF source → approval/search → reviewed request journey survives four
actual Core SIGKILL boundaries and a PostgreSQL/blob restore into fresh storage.
Original test storage is removed before reopening; PDF bytes, named approval history,
exact citations/copy, task identity and the single outbox command survive. Corrupt
restored bytes fail closed while revocation remains available. OpenAPI and Core
fixtures now describe the real parser's coordinate object; Desk exposes its type.

Focused acceptance passed **8 files / 76 tests**, including the opt-in drill's **31
invariants**, four kills and six Core starts. Typecheck, lint, Desk build and secret
scan passed. **Sealed regression:** source `9e3c3b9`, seal `bec1998` passed **442 files / 3440 tests**, with **5 files / 57 tests skipped**. The opt-in crash/restore drill passed separately in the 76-test focused run. Blueprint **845/0/0** and clean-tree release manifest verified. Production remains unchanged.
See `R12_EVIDENCE.md`, `R12_DOCUMENT_RECOVERY_PROOF.json` and the Docling runbook.
The normal full suite reports this gated drill as skipped; its explicit passing run
is recorded separately. No production service, configuration or flag changed.

Next engineering work: Telegram PDF/voice with reviewed exact-copy handoff, cited
Design Plans and measured retrieval quality/latency. Separate release admissions:
real multilingual office sources, live Workspace/provider/export/reopen, clean-host
WAL/PITR + Restate recovery with measured RPO/RTO, and independent human design review.
This local quiesced fixture restore does not close those gates or claim app-wide 10/10.

## Prior result (2026-09-26 — approved PDF reference search)

Desk can explicitly approve/revoke exact saved PDF evidence through a live named
client DNA manager or administrator, search approved passages with original page
citations, and reopen the source into the reviewed-request flow. Migration 042 keeps
approval events and derived chunks immutable, verifies current authority and original
bytes, and filters active tenant/client/approval state before PostgreSQL lexical
ranking. Concurrent/replayed decisions and uncertain browser responses reconcile
without reactivating a revoked source. No automatic model context or DNA activation.

Focused checks passed **9 files / 71 tests**; source/test typecheck, lint, Desk build
and secret scan passed. **Sealed regression:** source `dbf1646`, seal `7694ef9` passed **442 files / 3440 tests**, with **4 files / 56 tests skipped**. Blueprint **843/0/0** and clean-tree release manifest verified; production flags remain off. This evidence-only recording changes no implementation. See ADR-072, `R12_EVIDENCE.md` and `R12_DOCUMENT_KNOWLEDGE_PROOF.json`.
R12 remains in progress: real corpus relevance/latency, vector/reranker and cited
Design Plans, Telegram PDF/voice, live Workspace/provider/export/reopen/restore and
independent human-quality admission remain open. Production remains unchanged.

## Prior result (2026-09-26 — retained PDF request handoff)

Desk can retain an original PDF and its immutable local extraction, reopen saved
sources, explicitly confirm exact copy, and save one request with original-source
evidence. Lost-response retries preserve the complete request/key. Client isolation,
actual byte hashes, append-only receipts, GC roots, task/event/outbox atomicity and
exact copy into the Canva planner are checked. See ADR-071, `R12_EVIDENCE.md` and
`R12_DOCUMENT_HANDOFF_PROOF.json`.

Focused verification: **9 files / 103 tests passed**; source/test typecheck, lint,
Desk build and secret scan passed. The policy/operator-handoff correction passed **6 files / 37 tests** after the
first full run caught one policy performance regression (3,423 passed/1 failed/56
skipped). Source `96f1f5e`, seal `a28e9d3`: **440 files /
3,426 tests passed; 4 files / 56 tests skipped**. Release manifest and blueprint
**839/0/0** passed. Subsequent evidence recording changes no implementation. Production remains unchanged. Telegram PDF/voice, governed knowledge
indexing, actual office PDF fidelity, live provider/Workspace/export/reopen/restore
and independent human quality remain open. This is another completed local slice,
not application-wide release admission.

## Prior result (2026-09-26 — R12 local PDF inspection)

Desk's client Brand DNA view can inspect PDFs through a client-authorized local
Docling service. The parser preserves source-byte hashes, actual page coordinates
and stable chunk IDs; it refuses partial/unsupported results. Preview content is
unsaved and unapproved, and cannot activate brand rules or create tasks. One active
inspection per Core process, bounded upload/output/time and an isolated non-root
parser container limit resource use. See ADR-070, `R12_EVIDENCE.md`,
`R12_DOCLING_PROOF.json` and `services/docling/README.md`.

Six parser defects were reproduced before implementation. The real isolated
container/TypeScript probe passed six checks, and outbound access was refused.
Final focused checks passed **5 files / 39 tests**; full typecheck, lint, Desk
build and zero-secret scan passed. The final source `dab5623`, seal `d6f2612`,
passed 438 files / 3,410 tests with 4 files / 56 tests skipped, release manifest
verification and blueprint 835/0/0. Native text
order is unverified; OCR, tables and images are not extracted. Retained/approved
knowledge ingestion, lifecycle PDF/voice intake, live Workspace/provider/export/recovery
and independent quality admission remain open. No production configuration or
flag changed.

## Prior result (2026-09-26 — R07 original image files)

Images sent through Telegram's file/document option now work as first briefs,
current request revision/clarification replies and confirmed albums. Intake uses
the original file, verifies actual bytes and size, and preserves the original
source metadata in Core. Both design paths use the existing task-owned image
bindings. Invalid or unsupported files cannot become caption-only requests.
Historical holds replay unchanged. See ADR-069, `R07_EVIDENCE.md` and
`runbooks/CONFIRMED_PHOTO_ALBUMS.md`.

The focused group passed **5 files / 125 tests**, after reproducing six media
admission failures and the missing new-photo source record. Full typecheck, lint
and zero-secret scan passed. The final disposable recovery batch passed **3
scenarios / 25 invariants**: singleton and album image files reached one child
and simulated delivery after Core SIGKILL/replay; a PDF stayed held with one
sender notice and office alert. No unmatched model calls. The first batch exposed
a harness wait on future reminders; the corrected final batch preserves those
timers while checking ready work. Exact source hashes and results are in
`R07_IMAGE_DOCUMENT_DRILL.json`. Source `c6ce07d`, seal `b2e9eaa`, passed
**435 files / 3,385 tests**, with **4 files / 56 skipped**; manifest and blueprint
**831/0/0** verified.
Live Workspace/provider workflow, PDF/voice intake, export/reopen/recovery and
independent creative-quality gates remain open. No production flag or deployment
changed.

## Prior result (2026-09-26 — R07 confirmed photo albums)

Album parts are saved without starting a task. The sender replies to one photo
with `/use_album` to freeze two to ten supported images and hand the complete
selection to one new brief or current request revision/clarification. Every image
is bound to that task and reaches both design paths in the confirmed order.
Failed downloads block confirmation; changed sources, conflicting scope/content,
late parts and duplicate submissions are refused or replay their recorded result.
Captionless replies preserve factual copy. See ADR-068,
`runbooks/CONFIRMED_PHOTO_ALBUMS.md` and the newest `R07_EVIDENCE.md` section.

The affected group passed **6 files / 110 tests**, then the album file passed
**11/11** with two added boundary checks. Typecheck, lint and zero-secret scan
passed. The disposable Core SIGKILL drill passed **10/10 invariants**: one child,
two image bindings/downloads, one projection and one successful planner call with
both photo hashes; simulated review/delivery reached rev 8 `delivered`. Exact
source hashes and results are in `R07_ALBUM_DRILL.json`. Seal `14f1166` (source
`cbb81ca`) passed **435 files / 3,366 tests**, with **4 files / 54 tests skipped**;
release manifest and blueprint **827/0/0** verified.

Next admission remains the live Workspace reviewer/provider journey, other media,
clean-host recovery and independent creative-quality evaluation described in
`WORK_ITEMS.csv`. No production flag or deployment changed.

## Prior result (2026-09-26 — R07 captionless request replies)

A captionless single photo can now answer the exact current lifecycle revision
or clarification notice. Core rechecks the reply's request/revision in the task
transaction, keeps the original exact copy and records that the image contains
no written instructions. Unlinked, stale and cross-request photos cannot create
a task. Stored decisions and completed receipts replay after restart and flag
rollback. See ADR-067 and the newest `R07_EVIDENCE.md` section.

Affected Core/worker checks passed **4 files / 75 tests**; source/test typecheck
and lint passed. The disposable Core SIGKILL drill passed **10/10 invariants**:
one child/photo/download, one projection, planner received the photo hash and
simulated review/delivery reached rev 8 `delivered`. The source hashes and exact
results are preserved in `R07_CAPTIONLESS_PHOTO_DRILL.json`. Seal `eec002e`
(source `1fc4466`) passed **434 files / 3,353 tests**, with **4 files / 53 tests
skipped**, and manifest verification. At that checkpoint albums, other media,
live Workspace/provider output and independent human quality remained open.
No production flag or deployment changed.

## Prior result (2026-09-26 — R11 registered-client Desk scope)

The request form and Brand DNA editor now use the authorized client directory,
with no packaged KAAE-only choices or guessed default client. A saved draft keeps
its original scope if that client becomes unavailable. DNA editor state is keyed
by client, isolating delayed reads and saves. Core returns canonical client UUIDs
and checks active, writable client/project scope before manual intake writes.
Exact current/legacy retries return the original task and DNA metadata even after
the directory changes; changed intent is refused. See ADR-066 and `R11_EVIDENCE.md`.

The corrected final affected group passed **3 files / 18 tests**. The broad source
run preceding the fixture correction had **3,339 passed / 1 failed / 52 skipped**;
the failure was a nonexistent user-fixture column, now repaired and retested.
Typecheck, lint and Desk build passed. The sealed candidate `4972f49` (source `26dc8b6`) then passed **434 files /
3,346 tests**, with **4 files / 52 tests skipped**; manifest verification passed. No deployment, new-client onboarding, live provider output or human
quality acceptance is claimed. Workspace configuration and the remaining research
plan gates stay open; production lifecycle flags remain off.

## Prior result (2026-09-26 — R08 chat-to-Desk review)

Chat notifications now open the exact recorded task/revision, including after
Google Workspace sign-in and outside the first queue page. Unavailable tasks
cannot silently become a different queue entry. An old notification blocks
approve/revise/reject until the reviewer explicitly inspects the current revision;
a further revision change blocks them again. Legacy and lifecycle notifications
keep the database-derived link in their durable receipts. A separate office chat
receives the ready-draft review notice. The old chat-action endpoint returns an
explicit non-decision Desk handoff. See ADR-065, migration 039 and
`R08_EVIDENCE.md` nineteenth pass.

Focused checks passed **10 files / 110 tests**, followed by **2 files / 35 tests**
for off-page/open-tab navigation, subsequent revision changes and the office notice.
The full source suite excluding only the unsealed release gate passed **431 files /
3,327 tests**, with **4 files / 52 tests skipped**. Full TypeScript, lint, zero-secret
scan and Desk production build passed. The exact source manifest is sealed next.
No production migration, live sign-in, external delivery or human quality admission
is claimed. `runbooks/CHAT_REVIEW_ACCEPTANCE.md` defines the deployed handoff check.
R08 and the wider `WORK_ITEMS.csv` remain open; production lifecycle flags stay off.

## Prior result (2026-09-26 — R08 named review and assignment administration)

Named Google Workspace reviewers can now decide older Core-owned tasks with
the same client/project assignment check as request-owned reviews. The task
transaction repeats the identity, session, membership and assignment check,
then records the matched assignment and version in the append-only decision.
Named administrators can grant, renew, reactivate and revoke assignments in
Desk Settings with expected versions, idempotent action IDs, required reasons
and immutable change history. Direct application-role assignment changes
without named action metadata are refused. See ADR-064, migration 038 and
`R08_EVIDENCE.md` eighteenth pass.

The affected group passed **9 files / 57 tests**. The full source suite
excluding the unsealed release gate passed **430 files / 3,314 tests**, with
**4 files / 52 tests skipped**. Full typecheck, lint, zero-secret scan and
Desk production build passed on the final source. Exact-tree release checks
are still being sealed. A trusted operator must still provision each
verified Google identity and its memberships. No live Google, deployed
reviewer, provider receipt or independent design-quality acceptance is
claimed. R08 and release admission remain open; production lifecycle flags
stay off.

## Prior result (2026-09-26 — R07 revision-photo design handoff)

The revision-photo crash drill exposed a real Canva planner gap: although
the child photo was durably attached, the planner never read that file, and
the fake model parser rejected its tagged revision prompt. The planner now
verifies the exact child-owned blob and sends it to the model without saving
image bytes in its request. It ignores inherited inline photos, restricts
prior plans and previews to the same request, and checks request ownership
under the generation lock. The final-source isolated Core SIGKILL/replay
drill passed **10/10 invariants**: one photo download and projection, two
completed ChatInbox invocations, the exact photo hash in the successful
model call, and the child design at rev 5 `in_review`/`human_review`.
Focused tests passed **2 files / 36 tests**; the source suite excluding the
unsealed release gate passed **425 files / 3,294 tests** with **4 files /
52 tests skipped**. Lint and full typecheck passed. See `R07_EVIDENCE.md`
and ADR-062. The fake result proves handoff and review state; live visual
use and human quality remain open, and production lifecycle flags stay off.

## Prior result (2026-09-26 — R07 revision-photo restart drill)

The disposable worker-poller/Restate stack passed `R1.S3.REVISION_PHOTO`:
an authenticated office revision left a request waiting, Core stored the
requester's photo decision, was killed before creating the child task, and
restarted. Retry plus a second Restate key yielded one rev-4 projection,
one child-owned attachment and one download; all eight invariants passed.
The source suite passed 425 files / 3,292 tests with 4 files / 52 tests
skipped, lint/typecheck passed, and blueprint validation was 803/0/0.
The unmatched call was later identified as the Canva revision planner, not
Design Studio; the current result above corrects it. This first drill did
not qualify a successful revised design or live operation. See
`R07_EVIDENCE.md`. A release seal proves this source snapshot only; it does
not change the open creative and live-operation admissions.

## Prior result (2026-09-26 — R07 new-brief admission worktree)

**Cutover replay follow-up:** Core now checks whether the same Telegram update was
already committed by legacy intake before preparing a lifecycle request. The focused
PostgreSQL intake file passed 21 tests and Core TypeScript passed. The wider 3,280-test
source result below belongs to the preceding `99eb6b0` checkpoint; it was not rerun
for this follow-up.

**The missing first-brief handoff is now locally wired.** Core stores a hash-bound,
prepared Telegram brief, then ChatInbox sends one keyed `RequestLifecycle.open` so the
request owner creates the task. `/new <brief>` opens a separate request in a busy chat;
unknown replies are refused, and legacy tasks keep the Core delivery executor. The
focused intake set passed 3 files / 51 tests; adjacent delivery/open tests passed 4
files / 34 tests; lint and full source/test typecheck passed. See ADR-059 and
`R07_EVIDENCE.md`. The wider source suite excluding the unsealed release-manifest
gate passed 425 files / 3,280 tests, with 4 files / 48 tests skipped. The flag
remains off pending process-kill, media, and live admission.

## Prior result (2026-09-26 — R07 source checkpoint `7d322b0`)

**Question reminders now start from a confirmed Telegram send mark.** ADR-058
adds a private sender callback, Core mark/revision/question validation, and
office-hour day-1/day-5 timers. The legacy SQL scans exclude request-owned tasks.
Affected checks passed 15 files / 156 tests; the wider source suite excluding the
unsealed release-manifest test passed 425 files / 3,274 tests, with 4 files /
48 tests skipped. Lint and full typecheck passed. This is local evidence; no
killed-process or live Telegram claim follows from it.

**Studio clarification now has a local end-to-end path.** A verified failed Studio run
projects a persisted question and pauses the task. An answer linked to the current
question creates one child task with the original brief and Telegram update, closes the
paused task, advances the request, and starts the next DesignRun. The worker schedules
revision-bound day-1 and day-5 question reminders and skips them after an answer.
The affected lifecycle set passed 10 files / 87 tests; repository lint and full
typecheck passed. See `R07_EVIDENCE.md` for the exact coverage and limits.

**Requester revision directive routing is implemented and locally tested:**

- **`projectLifecycleRequesterRevisionWithIntake`** (Core `lifecycle-projection.ts`): atomically persists a
  requester's revision task from the raw Telegram update text and advances the request `manual → designing` in
  one idempotent transaction. Guarded by `pg_advisory_xact_lock` on the request; has idempotency receipt and
  conflict detection identical to the office-side projection.
- **Core intake route now accepts `mode=lifecycle`**: when mode is `lifecycle` and the chat has an open
  restate-owned manual-stage request at `rev ≥ 3`, Core extracts the directive text from the update, calls
  the projection above, and returns `lifecycleAction: 'requester-revision'` with the new task ID, round,
  directive, and priorTaskId. If no matching request is found it falls through to legacy intake.
- **Worker `ChatInboxCore.intake` passes `requestId`** from its journaled mode as a historical hint.
  Core reads the current manual requests from PostgreSQL; the chat pointer does not choose the target.
- **`InboxContext.sendLifecycleDecision`**: when Core returns `lifecycleAction: 'requester-revision'`,
  `handleUpdate` calls this method, which uses `ctx.objectSendClient(RequestLifecycleApi, requestId)` to fire
  `RequestLifecycle.requesterDecision` (the VO's state machine advances to `designing` and starts the next
  design run). The call is idempotent via `chatinbox:revision:<update_id>` key.
- **292 lifecycle tests pass** (`worker + core/lifecycle`); `tsc --noEmit` clean on both packages.
- **Integration evidence**: new test `routes a requester revision directive to the open lifecycle request
  (Q/A loop)` in `lifecycle-internal-intake.test.ts` seeds a manual-stage lifecycle request in the DB,
  sends a Telegram text update in lifecycle mode, and verifies the full projection response.

**R07 reminder and notice hardening (current working tree):** An office revision emits a critical,
keyed requester notice and schedules a 24-hour reminder for that exact request revision. A replay after
state save reissues the same keys, so a worker crash cannot silently drop the notice or timer. The reminder
checks the current revision and stage and uses the critical sender's PostgreSQL send mark. Office comments
are sent as literal text, avoiding Telegram HTML parsing of untrusted content. ChatInbox now preserves its
lifecycle mode and request ID after both handled and parked updates; a requester decision send is awaited
inside the Restate handler, so a failed dispatch replays from its journaled Core answer. Focused worker/Core
tests: 3 files / 34 tests passed; worker TypeScript passed. This is local proof, not a live delayed-send drill.

**R07 reply binding and revision context (current worktree):** Core selects the only waiting manual
request in a chat or a reply linked to its exact revision notice. When two requests wait, an unlinked
message gets a durable, actionable choice refusal. A late reply to a completed notice is refused.
The same Telegram update replays its committed projection by update ID and full update hash, including
reply target, even after the request advances. The worker adopts that projection once rather than
writing revision 4 again. The child task inherits exact copy, format and studio policy from the prior
brief, with a parent task and revision directive. Missing source brief and automatic daily limit
produce durable blocked receipts and a critical sender notice; no new design starts. Focused tests:
3 files / 38 tests passed; Core and worker TypeScript and repository lint passed. This is local
PostgreSQL/worker proof. It does not cover a deployed chat, concurrent process kill or provider result.

Prior milestones still hold: ChatInbox cutover (`1902c32`); multi-round journey (`f25ebf1`); delivery routes;
the last full suite passed 421 files / 3,237 tests before the reminder changes.

## Next useful milestone

1. **Finish R07 admission and recovery**: prove the new-brief and question paths through a killed
   Restate worker, PostgreSQL replay and live Telegram; qualify media/album intake and fallback
   with the lifecycle flag before a canary. The second-request pointer hazard is locally
   contained by database selection and exact reply binding.
2. **Final exports and provider boundaries**: qualify R11–R19 exports and R20–R23 provider boundaries.
3. **Canary & admission**: deploy only after a coherent release gate, then run live recovery and blind human
   creative-quality acceptance. No current source or local test result establishes production admission.


## 2026-09-27 — multilingual capture and honest font QA

Capture source `2d4c4de`: four real Canva imports, fifteen exports, forty exact independent native strings. Initial metadata mismatch refused; recapture accepted. Probe ordering failure resumed the saved import, with no duplicate. Actual PDF font resources disproved the glyph/license conclusion inferred from PPTX family names. Core, compact DB task projection and Desk now expose declared family evidence with unknown glyph coverage; legacy QC hashes stay unchanged and the list retains RTL review-required state.

Red 12 failed/52 passed; final 9 files/122 passed after sequential DB rebuild; types/lint/Desk build pass. Full regression not rerun; no app deployment, model calls, approval or messages. Human language, actual style boundaries, multi-font/narrow layouts, real office designs, committed native save/reopen, full live workflow and independent-host recovery remain open. See R19_MULTILINGUAL_PROOF.json and R18/R19 evidence.


## 2026-09-27 — live-data upgrade and current candidate

Source be2b70c: production preflight found schema 22/46, no reviewer OIDC configuration, healthy HTTP/Canva and unrecorded image revision. Consistent live-data clone in separate test PostgreSQL applied all 24 pending migrations; SHA-256 comparisons preserve 76 historical tables, including 1612 tasks, 110 approvals and 47 publications. Replay applied zero and verified 46; application-role task read succeeded; both private clones removed. Accepted proof uses SHA-256 after an earlier MD5 comparison. Production schema/images remain unchanged.

Fresh isolated full app: 36/36 invariants, 1 selected scenario passed/43 unselected; four deployed font-QA reads agree across list/detail and preserve unknown glyph coverage. Images match be2b70c, runtime source changes empty. External providers and identities remain synthetic. No real approval, message, deployment or full regression run. Workspace-domain input is pending. Runbook: runbooks/LIVE_PILOT.md; proof R26_LIVE_PREFLIGHT_PROOF.json. Next: named office identity, production backup/cutover gate, real native/human pilot, independent-host recovery and quality/cost evidence.


## 2026-09-27 — truthful copy language in both import encoders

FR-034/035/036; source correction only, no native Canva qualification. Both encoders
had hard-coded `ku` for RTL while PptxGenJS silently defaulted other copy to `en-US`.
They now validate language tags, bind them by exact-copy index and record `copyLocales`
in the import manifest; unspecified copy is `und`. Plain and accented paragraph runs
carry the same tag. Core uses only explicitly labelled Desk/reviewed-PDF fields with
identical copy/order; old script-derived language labels are not authority. Studio
binds the label to the original text hash and makes revised/legacy copy undetermined.

Red: 12/12 failed as expected. Focused: 8 files/81 passed, then a planner follow-up
with the new explicit Desk persistence case passed 36/36 (82 distinct tests across
the two passing runs). An intermediate suite import failure was fixed without a new
dependency. Creative build, project/script/test TypeScript and lint passed. Full
regression, deployed candidate and real Canva import/export were not rerun.

FR-036's 2026-09-19 blanket qualification is not supported by this active import path.
Language provenance is now explicit, but universal node locale/copy reference and
normalization policy remain unqualified. Existing word-joiner/paragraph formatting
and font-based direction heuristics remain separate work. Source tags do not prove
native Canva metadata retention, rendered language quality or human acceptance.
See `R19_LOCALE_PROOF.json`; production is unchanged, and R19 remains in progress.


## 2026-09-27 — native locale/style capture and paragraph direction truth (ADR-082)

Capture source `aefeabc`: two real imports and six exports preserve fourteen exact
PPTX strings, Studio line breaks and per-character text colors across three declared
font families. The ten-string sheet has zero changed decoded pixels out of 2.4M
against its older capture. Canva rewrites locales to ar-EG/en-US, so source language
provenance must remain in Hawa. The read-only content tool concatenates paragraph
breaks and supplies no native element IDs/style spans; it is not an exact source map.

Actual `rtl="true"` paragraph attributes exposed the old parser's false absent-metadata
claim. New checks read both XML boolean spellings, inspect each paragraph, preserve
explicit source directions in the frozen export policy, and separate metadata from
rendered bidi. Mixed text is not automatically RTL. Core no longer waives explicit
false/invalid flags when no true flags remain. Every eligible Arabic/Sorani export
requires the existing hash-bound visual assertion, even with correct metadata. Desk
and Client DNA copy now describe that boundary without promising rendered isolation.

The real-file approval test exposed another production bug: canonical task-copy
objects were passed to a string-only evaluator. Both saved shapes are now read
exactly; wrong/malformed task copy cannot be replaced by a passing capture receipt.
The isolated gate rejects no assertion, wrong hash and absent selected PNG, then
accepts the correct synthetic reviewer assertion. This is not a real human approval.

Red: 10 failed/16 passed. Final connected group: **8 files/128 passed, zero skips**.
Project/script/test TypeScript, lint and Desk build pass. Intermediate native-gate
failures are retained. Full regression and deployed-image qualification were not rerun.

A retained negative control remains open: Studio's Arabic-font fallback overrides
explicit rtl:false before import. Current QA detects it against requested direction.
Next repair: respect explicit direction in the transfer and verify the real round trip.
Human typography review, committed native edit/save/reopen, broad office corpus and
full live workflow remain open. No production deployment/migration, model call or
message occurred. See `R19_LOCALE_CANVA_PROOF.json`; full admission remains false.


## 2026-09-27 — explicit Studio direction repaired and native control captured

Studio now honors `rtl:false` independently of Arabic font family in both the
transfer plan and all text paragraphs. Font fallback applies only when direction
is unspecified; cursive tracking, line spacing and color-run behavior are preserved.
Regression: three font cases fail before the repair; final eight files/67 tests
pass after it. Project/script/test types and lint pass. The initial sandbox test
ran zero tests; two test-fixture type omissions were corrected and not concealed.

One real Canva import/three exports preserve six exact multiline strings and all
color runs. Three unchanged control boxes have zero changed pixels out of 565,800;
the repaired mixed box changes 9,247 pixels. Four RTL paragraphs retain true flags;
eight explicitly LTR paragraphs have absent flags and stay unknown for metadata.
The checker accepts them only with required visual review; no full release pass.
The read-only native tool matches flattened text only. Time-token isolation and
native-reader review remain unqualified. No production change, paid model call,
real approval, editing transaction or message. Retained older failing control is
unchanged. See `R19_EXPLICIT_DIRECTION_PROOF.json`. Refreshed deployment and full
regression are the next qualification step.


### Refreshed candidate and full regression qualification

Implementation `34eac23`, sealed candidate `8dd04cc`: the refreshed isolated app
passes all 36 workflow invariants, with real offline Docling and synthetic external
providers/identities. Core/Desk/worker image labels match the candidate, runtime
source changes are empty, and four list/detail QA reads agree. Compiled Core/QA
evaluate two retained real Canva files: corrected direction requires visual review,
old explicit direction conflict fails, and altered canonical task copy fails both.
Compiled Studio respects all six requested directions. No provider/model call
is needed for these compiled checks. The first probe used the wrong report-field
name; that probe error was corrected without changing runtime code.

First full regression: 3,685 passed/2 failed/59 skipped. Both failures were old
backup expectations superseded by ADR-081. Updated tests require corrupt/locked
packs to fail before restore with unknown store counts, and incomplete cloud
transport to fail before a dump/upload/collection. Isolated backup follow-up 6/6
passed; final full regression **3,687 passed, zero failed,
59 skipped** across 464 files. Test types pass. Runtime is unchanged
from candidate 8dd04cc; the final full run includes the uncommitted test-only correction.
Earlier failed test receipts remain in the proof.

This is engineering evidence for the isolated candidate. Production, actual human
review, native edit/save/reopen, mixed-token isolation and live delivery remain
unqualified; Workspace reviewer configuration, off-host/independent recovery and
held-out creative quality/cost gates remain open. See R19_EXPLICIT_DIRECTION_PROOF.json.

## 2026-09-27 — Shared gateway and evaluation uncertainty hold (ADR-083)

The shared gateway now stops after network/timeout uncertainty, HTTP 408/5xx,
unreadable or unusable successful output, schema failure or observed model
mismatch. A later provider cannot conceal the earlier acceptance or bill. Errors
retain bounded provider receipt facts and unknown cost without private response
content. Explicit rate rejection still permits an authorized bounded fallback;
valid JSON null/false/zero is a completed answer, never a reason to call again.

The evaluation runner stops further routing and visual model calls on that hold,
reports attempted and unexecuted cases separately, and leaves aggregate pass rate
null. Desk labels the run stopped and suppresses even an obsolete stored 100%.
This is an in-process safeguard; evaluation reports still lack a durable call
ledger and restart reconciliation. Studio's separate persistent ledger does not
cover these evaluation calls.

Original regression: 28 failed/1 passed. First gateway follow-up: 45 passed/1 failed;
the old multimodal-header fixture sent a Google response to Anthropic before
falling through and now explicitly selects Google. Final connected checks:
17 files/131 passed/zero failed/zero skipped, including a real localhost response
lost mid-body with one observed request. Project/script/test types, lint and Desk
build passed. Earlier failed receipts are retained. No full-suite rerun or rebuilt
app candidate belongs to this slice; the earlier 3,687-test result and isolated
8dd04cc candidate remain historical. No paid model call, production change,
human approval or message occurred. R20/R21 remain in progress.

Proof: `plans/research-grade-upgrade-2026-09-25/R21_GATEWAY_HOLD_PROOF.json`.
Next: durable evaluation admission/recovery and candidate verification, followed
by the real named-review/edit/revision/delivery pilot, independent recovery and
held-out quality/cost qualification.

Initial pre-commit scanner rejected a synthetic response marker named secret. Renamed it privateBody without changing runtime behavior or the marker value; the gateway follow-up passed 41 tests, zero failures. Final acceptance of the commit hook is checked separately.

## 2026-09-27 — Durable fixture evaluation replay and recovery (ADR-084)

Migration 047 and the existing evaluation tables replace Core's in-memory history.
A stable Desk action UUID admits one tenant-scoped run; a changed name conflicts.
Each model request is recorded before transport. Completed calls replay an
allowlisted scoring projection and receipt metadata; raw prompt/free-text output
is not stored. Corpus, visual image, evaluator protocol and source seal bind replay.
Database loss starts no fallback work, and a new action cannot bypass an incomplete
run or pending/uncertain call. The call admission and first outcome are immutable.

Desk retains a failed HTTP action through refresh, offers resume on incomplete
history, and exposes observed provider/model facts, estimated costs and unknown
amounts. Fixture diagnostics remain admissionEligible:false. Recovery checks the
saved admission before current provider availability, so removing a provider cannot
skip an earlier uncertain call.

Connected checks: 23 files/181 passed, zero failed/skipped; final affected follow-up
4 files/14 passed including the new version-mismatch refusal. Two real SIGKILL
boundaries each observed one localhost provider request: the missing answer stays
held with no replay fetch; a committed reply is reused and subsequent never-admitted
calls can proceed. Runtime-RLS tests also cover tenant isolation, concurrency,
immutable outcomes, HTTP retry/fresh Core history and a database failure before the
next admission. Types, lint and Desk build pass. The initial typecheck's two missing
safeAction fields were corrected. Full regression and refreshed candidate follow
source sealing; earlier source/candidate results do not qualify this migration.

Provider billing lookup/settlement, independent-host recovery, the real named-review
Canva/revision/delivery pilot, and human quality/cost qualification remain open.
No production change, real model call, human approval or message. R20/R21 remain
in progress. Proof: `R21_DURABLE_EVALUATION_PROOF.json`;
operation: `runbooks/EVALUATION_RECOVERY.md`.

### Candidate packaging and full-regression correction

Initial sealed candidate 448c79c passes 36 synthetic workflow invariants, but its
evaluation POST returns503 before any provider call: the image omitted the three
root fixture files and RELEASE_MANIFEST.json. The retained file-existence/HTTP
negative control proves all four omissions and zero fake-provider calls. The
Dockerfile now copies only those required resources and evaluates the replay
identity during image build. The probe's first fake-ledger URL was wrong; it was
corrected before that measurement.

First full regression: **3,739 passed, six failed, 59 skipped**. The failures are
explicit old migration/table/policy counts and an old expectation that evaluation
history exists without PostgreSQL. Corrected checks require migration047,55 base
tables/27 policies, and503 without storage; they also assert the new ledger/table
policy by name. Base RLS now covers the ledger before versioned migrations too.
The schema text check is explicitly labeled as inventory, not a recovery drill.
Affected follow-up: **8 files/33 passed**, including runtime RLS and both actual
process-kill cases. Final full regression and corrected image checks follow.

### Final full regression and deployed evaluation proof

Packaged source2d1e56b, sealed candidate34d10d5: **3,745 tests pass, zero fail,
59 are skipped**. The rebuilt candidate passes36workflow invariants and14additional
evaluation controls. Its one synthetic Google request receives a held failure;
Core restarts, the same action returns the identical saved report, and fresh or
changed actions cannot bypass that outcome. Call details retain unknown cost and
observed provider facts without saved model output. Image source labels agree.

A final CSS-only follow-up pins the evaluation panel to its right-hand grid cell:
opening the full-width call-receipt section must not move it into the narrow
sidebar column. The Desk build passes; the full regression above covers the prior
layout and unchanged runtime logic. A final candidate refresh follows this visual
layout correction. Production and real provider/approval/quality admission are
unchanged and unqualified.

### Final packaged checkpoint

Final sourcef057b1e (implementation2ffd37e, packaging2d1e56b), candidate81ea4c3:
all36workflow invariants and14deployed evaluation controls pass, including one
Core restart and exactly one synthetic provider request. The candidate includes
the CSS-only receipt layout correction and all three runtime image source labels
match. The full3,745-pass/59-skip regression belongs to34d10d5; backend logic is
unchanged afterward and the CSS follow-up has a separate successful Desk build.
No production upgrade, live provider bill, human approval or message occurred.
Provider settlement, real office workflow, independent recovery and human creative
qualification remain open. Final proof: R21_DURABLE_EVALUATION_PROOF.json.


## 2026-09-27 — Truthful fixture evaluation evidence (ADR-099)

2026-09-27 ADR-099 source candidate: corpus-bound per-case diagnostics, missing visual scores remain unreported, actual suite/call data and selected-run UI; 61 focused tests and 494 strict roots pass. Full sealed/runtime qualification pending. See plans/research-grade-upgrade-2026-09-25/R01_EVALUATION_EVIDENCE_PROOF.json. Live/human admission remains open.

The old UI hard-coded passing cases, model scores, latency and canary states. The visual evaluator invented optional numeric scores. New reports retain case outcomes and exact corpus hashes, while old reports remain aggregate-only. Unavailable rubric evidence is distinct from measured failure; incomplete scoring has no pass percentage. The fixture protocol is v3. Dataset counts come from validated files, unknown IDs refuse, and UI reads do not dispatch generation. First failures are retained in the proof.

Final ADR-099 on33a4dc7:4036 passed/0 failed/59 skipped;494 strict roots;61 focused plus18 final Desk checks. Fresh matching isolated app passes63 workflow/recovery and17 Chrome checks; saved case hashes/statuses, RTL unexecuted labels and zero model work while browsing verified. Synthetic fixtures cannot admit models or native Canva; live/human/independent-host gates and whole-app completion remain open.

Isolated health at 2026-09-27 11:59:41 UTC /14:59 Baghdad remains degraded: PostgreSQL and Restate connected, zero paused/backoff/inbox workflows; Canva/model/Telegram API unverified, design flags off. Production unchanged. Initial browser session/selector failures and faint neutral labels are recorded with their corrections. Next: remaining paid paths and typed completed-result recovery, then real office/provider/Canva/human/held-out studies, independent-host restore and controlled rollout.
