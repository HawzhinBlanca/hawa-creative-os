# Completion checkpoint

Updated 2026-09-26 after the user requested faster, more economical completion.
Branch: `codex/research-grade-design-system`. Scope and acceptance remain in `PLAN.md` and `WORK_ITEMS.csv`.

## Working method

- Finish connected user journeys with their failure recovery and acceptance evidence. Keep the existing architecture.
- During implementation, run the affected unit, integration and failure tests. Run the full required release checks at a coherent milestone before qualification or deployment; repeat them for concrete new risk or changed code.
- Batch source, tests, traceability and one concise evidence update. Seal a release candidate once it is actually ready for that gate. Do not create another seal solely to rephrase status.
- Read this checkpoint and the relevant source/evidence sections on continuation. Use scoped searches and short logs. Maintain the historical evidence without copying its whole history into every update.
- Keep engineering, live-operation and human-quality acceptance separate. Complete available engineering while real corpus preparation and human review remain pending; no synthetic result substitutes for them.
- Reuse fixtures, the existing Restate workflow and the pinned dependency stack. Add a dependency or redesign only when a measured need justifies it.

## Current result (2026-09-27 — isolated encrypted database recovery)

ADR-079 adds an opt-in pinned pgBackRest image/configuration and reproducible offline
PITR drill. Final physical restore includes a post-backup task, excludes a later task,
finishes recovery, matches **86 tables / 133 RLS policies**, and preserves tenant
isolation. Natural WAL archive lag **59.573s**; restore/verification **6.632s**.
Wrong-key and missing-WAL controls pass; temporary resources are removed. **43 backup
Python tests pass** and Compose renders correctly. See `R10_PITR_PROOF.json` and
`R10_EVIDENCE.md` for failures, exact hashes and limits. Production is unchanged.

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
