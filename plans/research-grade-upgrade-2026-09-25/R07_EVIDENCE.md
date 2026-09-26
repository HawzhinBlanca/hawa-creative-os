# R07 — RequestLifecycle ownership and projection (in progress)

## 2026-09-27 — requester-reviewed Telegram PDF workflow (ADR-073)

Core now freezes an explicit active client or exact current request reply before
downloading, retains hash-verified original bytes, extracts candidate text locally,
and waits for an exact `/use_source` copy confirmation from the original sender in
the same chat/topic. New and revision/clarification requests use the existing
lifecycle and expected revisions. The planner and Desk preserve the confirmed
strings, including whitespace, underscores and Sorani. Explicit Size captions use
the existing supported dimension bounds; the new-request default is visible.

Admission/refusals survive restart, client-code reassignment and flag rollback.
Confirmation retains its exact serialized update because JSONB key ordering cannot
reconstruct the original hash. Worker notices use the existing critical sender.
The new task-file RLS policy closes a demonstrated cross-client original-download
hole. Desk also lists/downloads retained originals after parser failure; late
responses cannot cross a client change. Files named .pdf cannot override the
byte-verified image path: PDF extraction requires an explicit PDF media type and
verified PDF bytes. Unknown/unsupported media still needs correction.

**Measured acceptance:** 14 affected files / 180 tests passed with real PostgreSQL
and runtime RLS, plus source/test typecheck, lint, Desk build and zero-secret scan.
The included opt-in drill passed **26 invariants**, **five actual Core SIGKILLs**
and **six Core starts**. Admission, bytes, extraction, confirmation and task commit
all lose their HTTP acknowledgement before restart; the final state has **one
download, one extraction, one task, one task event and one outbox command**.
Client-code reassignment cannot change the admitted client. The real offline Docling
fixture is served through a bounded local HTTP bridge; the real downloader receives
two fixed Telegram-shaped responses. Child processes use a fresh cwd, synthetic
session/config and an outbound fetch guard. Production was not changed.

The updated Docker/Restate `R1.S3.MEDIA` scenario separately passed **5/5
invariants** with the real worker poller: one immutable missing-client refusal,
one critical requester correction prompt, no task or failure parking, and two
completed ChatInbox invocations under different Restate idempotency keys. Its
fake-provider receipt is included in the same proof file. Earlier dated all-PDF
hold results are historical; the current scenario reflects explicit PDF admission.

The crash result, source hashes, limits and earlier failed runs are in
`R07_SOURCE_RECOVERY_PROOF.json`; usage/recovery is in
`runbooks/REQUEST_SOURCE_REVIEW.md`. Sealed full regression is pending for this
source checkpoint. The standard suite skips this opt-in drill; its explicit pass
is recorded above. Voice, real office source fidelity, live Telegram/Restate/Canva
export, clean-host recovery and independent human quality remain open. No request
copy confirmation promotes knowledge or approves a design.

## 2026-09-26 — original image files and preserved source evidence (ADR-069)

Telegram images sent as documents now follow the same request-owned path as
photos: a captioned first brief, a captioned or captionless exact current revision
or clarification reply, and an explicitly confirmed album. One shared parser
selects the original document file ID and excludes its thumbnail. File names
never become local paths. Explicit unsupported types and excessive declared sizes
are refused before download; actual byte signatures and byte counts determine
the retained type, hash and size. Absent/generic MIME hints are allowed for
inspection. A misleading image name/MIME cannot admit PDF or oversized bytes.
Mixed carriers, animation/live-photo payloads and unsupported files hold the whole
input instead of starting a design from only its caption.

The work also found that first-image briefs dropped the original Telegram update
while constructing the small worker draft. Core now stores that update alongside
its new-brief decision and copies the stored record into the task's inbox event
inside projection. The worker still receives only the typed image reference; it
cannot supply replacement source evidence. Older decisions keep their original
replay behavior without invented metadata. Revision projection independently
requires a saved image decision for either file carrier. No dependency, table or
new workflow was added. Requirements: FR-002, FR-004, FR-011, FR-060, NFR-001,
NFR-006. Usage is in `runbooks/CONFIRMED_PHOTO_ALBUMS.md`.

**Verification:** before the runtime changes, six image-file cases failed
with 422 holds, and one photo control exposed the missing stored source update
(7 failed / 47 passed). The first assertion mistakenly looked for the source in
the deliberately small worker draft; it was corrected to inspect Core's actual
decision, and that missing-record failure was reproduced before implementation.
The final focused group passed **5 files / 125 tests**. It covers first briefs,
both revision/answer forms, albums, exact copy, original-file selection, stored
source, changed intent, forged/missing file proof, unknown MIME, unsafe filenames,
spoofed/oversized bytes, mixed media and historical holds after flag rollback.
Full source/test typecheck, lint and zero-secret scan passed.

The final disposable Docker batch passed **3 scenarios / 25 invariants**, with
40 scenarios skipped by selection: `R1.S3.IMAGE_DOCUMENT`,
`R1.S3.DOCUMENT_ALBUM` and `R1.S3.MEDIA` using the worker poller. The singleton
and album each survived Core SIGKILL after its durable decision/confirmation but
before child projection. Retry and a second Restate key produced one owned child,
one projection, one download per original file, all selected content hashes in
one successful revision planner call and simulated approval/delivery at request
rev 8 `delivered`. The PDF remained held with one sender notice and office alert;
no task was created. There were no unmatched model calls. The complete report and
13 tested source hashes are in `R07_IMAGE_DOCUMENT_DRILL.json`.

The first batch was stopped after a read-only check showed only two future
`RequestLifecycle.reminderTick` invocations remained. The old generic idle check
counted those scheduled reminders as active work, preventing the following PDF
scenario from settling. The corrected check excludes only that scheduled service
handler; running/backing-off invocations, ready outbox commands and recent
Telegram calls still prevent quiescence. The final batch passed with reminders
retained. This is a harness correction, not cancellation of production reminders.

Exact candidate sealing and its full regression suite follow this source/evidence
commit. Real Workspace/provider output, PDF/voice intake, clean-host recovery and
independent visual-quality admission remain open. No production flag or deployment
changed.

## 2026-09-26 — confirmed photo albums through one owned request (ADR-068)

Core now saves each album part before any task or paid design starts. The sender
replies to a stored photo with `/use_album` after all photos have finished sending.
A transaction freezes the ordered selection, original captions/reply context and
confirmation source hash. The prepared brief or exact current request reply then
uses the existing lifecycle owner. Scope includes tenant, chat, sender and topic;
the new manifest contains only hashes, media types and sizes. Projection verifies
the frozen record and attaches all images to the child/new task atomically. Both
Studio and the active Canva planner verify and consume that task's manifest order.
Captionless request replies preserve the existing exact copy.

The collection admits two to ten supported still photos, at most 20 MiB per image
and 100 MiB total. Received identities persist before network I/O, so a failed
download cannot disappear from the confirmed selection. Mixed media, conflicting
captions/replies, changed source identity and partial/oversized collections are
refused. Late photos cannot mutate a frozen album; another confirmation cannot
create a second design. Historical media holds remain held on replay. Recorded
parts/confirmations survive flag rollback, and retained images remain reachable
by garbage collection. Migration 040 supplies collection/reply indexes and the
blob-reference view. Requirements: FR-004, FR-011, FR-060, NFR-001 and NFR-006.

**Verification:** final affected Core/worker/planner/schema checks passed **6 files /
110 tests**. Two subsequent size/count checks brought the album file to **11/11**
passing tests. Full source/test typecheck, repository lint and zero-secret scan
passed. The initial test run exposed a malformed projection fixture, an obsolete
album-hold assertion and a planner assertion that omitted existing approved brand
examples; these were corrected and the affected tests rerun. No red-before proof
is claimed for this new feature.

The isolated Docker drill `R1.S3.ALBUM --poller worker` passed **1 scenario /
10 invariants** at **2026-09-26 19:09 UTC** (40 scenarios skipped by selection).
Two album parts created no child before confirmation. Core was killed after
freezing the album and before child projection. Restart plus a second Restate key
produced one child task, one requester projection, two child-only image bindings,
one download per photo and one successful revision planner call carrying both
content hashes. Simulated office review and approved delivery reached request
rev 8 `delivered`, child `complete`; both intakes completed, no model calls were
unmatched, and no ready outbox work remained. `R07_ALBUM_DRILL.json` preserves the
report and tested source hashes. Exact source sealing and its full regression
suite follow this source/evidence commit.

**Limits:** explicit confirmation defines the selected set, not proof that every
intended photo reached Telegram/Core. The local image/model/provider fakes and
simulated office approval do not establish visual quality or live provider use.
Voice, documents/PDFs, real Workspace/provider workflow, clean-host admission and
independent human quality remain open. No production flag or deployment changed.
Requester/operation instructions are in `runbooks/CONFIRMED_PHOTO_ALBUMS.md`.

## 2026-09-26 — captionless photos through exact current replies (ADR-067)

A single photo without a caption can now continue a revision or clarification
when it replies to the recorded notice for that exact current request revision.
Core checks the outgoing message identity at routing and again inside the task
projection transaction. The existing photo decision, blob reference, task file
binding and revision receipt handle recovery. An unlinked photo stays held even
when only one request waits. Unknown/stale replies are refused, and a saved photo
decision cannot authorize a different request's reply.

The application labels a captionless submission as having **no written
instructions** and tells the planner to preserve the existing factual copy. The
original Telegram update is retained; no image text is promoted into exact copy.
Shared parsing rejects albums and mixed/unsupported media at the same boundary
used by projection. Requirements: FR-011, FR-060, NFR-001 and NFR-006.

**Verification:** the new captionless revision test failed before the change
(`park-update`, 422), while the captioned control passed. The final affected
Core/worker group passed **4 files / 75 tests**. It covers two waiting requests,
exact reply selection, child-only file binding and Studio retrieval, unchanged
exact copy, clarification, late answers, replay after flag rollback, a pending
photo decision across Core reconstruction, and a direct projection attempting to
use another request's notice. TypeScript source/test checks and repository lint
passed. The disposable Docker `R1.S3.CAPTIONLESS_PHOTO` drill passed at
2026-09-26 18:45 UTC: **1 scenario / 10 invariants**, with 39 scenarios skipped by
selection. Core was killed after committing the image decision and before child
projection. Restart plus a second Restate key produced one child task, one file
binding/download and one requester projection. The planner received the exact
image hash; both intakes completed; simulated approval/delivery reached request
rev 8 `delivered` and child `complete`, with no ready outbox work or unmatched
model calls. The preserved JSON report is `R07_CAPTIONLESS_PHOTO_DRILL.json`,
including the tested source-file hashes. The exact sealed regression suite follows
this source/evidence commit.

**Limit:** this does not admit unlinked photos, albums, voice or PDF/document
messages. Local model/file fakes cannot establish visual use or human quality.
Live provider, deployed workflow and release admission remain open; production
lifecycle flags stay off.

## 2026-09-26 — correction and Canva revision-photo completion

The prior drill's unmatched model call was **Canva's revision planner**, not
Design Studio. Its fake understood a plain JSON brief but not the tagged
revision prompt. More importantly, the real planner read only legacy inline
image options: the child task's correctly attached lifecycle photo never
reached the model. This corrects the diagnosis in the earlier dated section
below; that section remains as the record of the first drill.

The planner now reads and verifies `reference_image` from the exact
request-owned task, records only its hash, media type and size in the saved
request, and attaches the bytes to the model call. It fails before a model
call if the owned blob is unavailable. It ignores inherited inline image
options for request-owned work, pins the request ID under the generation
lock, and restricts prior Canva plan/preview lookup to a parent in the same
request. The fake planner now accepts tagged revisions and records attached
image hashes without image bytes. A focused PostgreSQL test was red before
the fix because the child photo was absent from the model request; it now
checks the actual attached bytes, hash-only durable record, inherited-image
refusal, and missing-blob refusal. The fake-provider test covers the tagged
revision and hash ledger.

The disposable Core SIGKILL/replay drill now waits for the child design to
finish and checks the final request stage and model ledger. The final-source
rerun passed **10 invariants**: one child file/download/projection, both
completed ChatInbox invocations, a rev-5 `in_review` request with the child
in `human_review`, and exactly one successful Canva planner call containing
the child's photo hash. No model call was unmatched. Focused planner/fake
tests passed **2 files / 36 tests**, repository lint and full source/test
typecheck passed, and the source suite excluding only the unsealed
release-manifest gate passed **425 files / 3,294 tests**, with **4 files /
52 tests skipped**. Blueprint validation and release sealing follow this
source/evidence checkpoint.

**Limit:** The 1,024-byte fake JPEG and deterministic fake layout establish
handoff, scope, replay and review-state behavior, not a model's visual use of
the photo or design quality. Live Telegram/Canva and blinded human review
remain open. The production lifecycle chat flag stays off.

## 2026-09-26 — revision photo survives a killed Core process

The disposable `hawa-chaos` stack now exercises the full entry path for a
requester revision photo: a first brief reaches `in_review` at request rev 2,
an authenticated Desk art director requests revision at rev 3, and the worker
poller hands a captioned Telegram photo to ChatInbox. Core commits the
hash-bound photo decision and is then killed with SIGKILL before creating the
child task. On restart, ChatInbox retries the same update; a second Restate
key replays it again. The drill checks one rev-4 requester projection, one
owned child task, a file attached only to that child, one photo download, no
parked update, and two completed ChatInbox invocations. It separately permits
only the future lifecycle reminder to remain scheduled, with no ready outbox
command. This adds a real
process-crash proof to ADR-062 for FR-011, FR-060, NFR-001 and NFR-006.

**Verification:** `pnpm exec tsx packages/testkit/chaos/run.ts --only
R1.S3.REVISION_PHOTO --poller worker` passed **1 scenario / 8 invariants**
on a newly built, disposable stack at 2026-09-26 06:51 UTC. The runner log
records the Core kill between the decision and projection, revs 1–5, the
child's sole 1,024-byte JPEG attachment, one download, and both completed
intakes. Repository lint and TypeScript source/test checks passed. The full
source suite excluding only the unsealed release-manifest gate passed **425
files / 3,292 tests**, with **4 files / 52 tests skipped**. Blueprint
validation passed **803/0/0**. The first two attempts
found harness assumptions: a legacy draft-button wait did not describe a
lifecycle review, and generic quiescence waited on a deliberately scheduled
future reminder. The corrected drill checks the persisted request state and
immediately actionable work.

**Limit:** The fake model server intentionally has no Design Studio model
fixture for this image revision. It recorded one unmatched model call, and
the child ended `failed_operator`; this drill proves durable ownership and
replay, **not** a successful revised design, live Telegram receipt, or human
creative quality. Those admissions remain open. The production lifecycle
chat flag stays off.

## 2026-09-26 — requester revision and clarification photos stay with their request (ADR-062)

Core now admits a captioned single Telegram photo as a requester revision or Studio
clarification answer only after the current lifecycle request is selected. An exact
reply to its notice identifies one request; an unlinked photo in a chat with two
waiting requests is refused before download. Core stores the validated bytes by
content hash and commits a separate decision bound to the update hash, chat and
request. The pending decision protects the blob from garbage collection. A fresh
Core can finish projection from that decision even if the chat flag and Telegram
download are unavailable. The projection checks the exact decision and blob metadata,
then attaches the file to the new child task in the same transaction as task
ownership, request revision and replay receipt. Studio reads that task-owned image.
The worker receives the existing child task identity and directive, without image
bytes. Requirements: FR-011, FR-060, NFR-001 and NFR-006.

**Verification:** focused Core intake and schema-upgrade checks passed **2 files /
33 tests**. They cover two simultaneous requests, exact reply selection, task-only
file binding, Studio retrieval, a photo clarification answer, no second download
after flag rollback, a saved-decision restart fixture, ambiguous-chat refusal,
changed-update conflict and pending-decision garbage-collector retention. Repository
lint and full source/test TypeScript checks passed. The exact source suite, excluding
only the unsealed release-manifest gate, passed **425 files / 3,292 tests**, with
**4 files / 51 tests skipped**. Its first run had 3,291 passes and one stale
newest-migration test assertion; that assertion was updated for migration 033, and
the complete suite then passed. The release seal follows the source commit.

**Limit:** These are isolated PostgreSQL and fake Telegram checks. The restart fixture
recreates Core after a committed decision; it is not a killed Docker process or a
live Telegram receipt. Albums, captionless photos, voice, documents and PDFs remain
on the explicit hold path. Real creative use and human approval remain open, and
the production lifecycle chat flag stays off.

## 2026-09-26 — a single captioned photo belongs to its lifecycle request (ADR-061)

Core now accepts a single Telegram photo with a caption when the message resolves to
an unambiguous new brief in a lifecycle chat. It downloads the bytes, checks the size
and image signature, stores them in the content-addressed blob store, and commits a
hash-bound new-brief decision containing only the blob reference. The worker's
RequestLifecycle event carries that reference, never the image bytes. A pending
decision keeps the blob reachable to garbage collection through migration 032.
Projection verifies the worker's exact reference against the committed decision and
blob metadata, then inserts the task, Restate-owned request, revision receipt and
`task_files(reference_image)` row atomically. Studio reads and verifies that owned
file, without borrowing nearby unbound chat photos. A missing or corrupt owned file
now fails the Studio image lookup instead of silently dropping the reference.
Requirements: FR-011, FR-060, NFR-001 and NFR-006.

**Verification:** focused PostgreSQL and migration checks passed **5 files / 62
tests**. They cover changed-update conflict, forged blob reference, pending and
projected garbage-collector references, no second download on replay, owned Studio
retrieval, missing store, unreadable bytes and unsupported media. Repository lint and
full source/test typecheck passed. The full source suite, excluding only the
intentionally unsealed release-manifest gate, passed **425 files / 3,288 tests**,
with **4 files / 51 tests skipped**. The disposable Docker scenario `R1.S3.PHOTO`
passed a Core kill after the stored decision, restart and replay under a second
Restate key: one request, task, file binding, download and requester acknowledgement.
An exact-code Docker rerun passed both `R1.S3.PHOTO` and `R1.S3.MEDIA`
from one clean disposable stack: **2 scenarios passed**, with the other 36 skipped
by selection. The latter confirms a captioned document image still parks for
operator review. Blueprint validation and the sealed-tree release gate follow the
source and manifest commits.

**Limit:** This admission is for a captioned single-message photo and first brief.
It does not cover albums, captionless images, media on requester revisions, voice,
PDF or documents; these still park for office follow-up. Signature and size checks
do not prove every image can be decoded or used creatively. The disposable fake
provider is not a live Telegram or Canva receipt, and this source change does not
qualify production cutover. `HAWA_LIFECYCLE_CHATS` remains off by default.

## 2026-09-26 — owned designs cannot borrow nearby unbound photos (ADR-060)

Studio's legacy image lookup inferred that a photo belonged to a task from the same
chat and nearby time. A red-before isolated PostgreSQL test linked a design task to
a Restate-owned request, left a prior chat photo unbound, and showed that Studio
returned that photo as input anyway. Studio now reads only images attached to the
owned task's creation event when `tasks.request_id` is set. A second fixture proves
an image explicitly attached to that task remains usable. Core-owned tasks retain
their existing photo behavior. ADR-060 records the scope decision and the required
explicit media binding for later lifecycle intake. Requirements: FR-011, NFR-006.

**Verification:** the focused Studio and adjacent legacy-reference set passed
**4 files / 16 tests** after the red run. Repository lint and full source/test
typecheck passed. The source suite, excluding only the intentionally unsealed
release-manifest gate, passed **425 files / 3,286 tests**, with **4 files / 50 tests
skipped**. Blueprint validation passed **799/0/0**. The sealed-tree release gate
follows the evidence commit.

**Limit:** This prevents inferred cross-request photos in an owned design; it does
not supply a lifecycle image. The media update is still parked under ADR-059 until
Core can retain a verified, request-bound image reference and DesignRun can read it.
Live image admission, album grouping, voice/PDF use, killed-process replay and human
quality review remain open. The production lifecycle flag remains off.

## 2026-09-26 — text refusal survives a chat flag rollback

The media replay review exposed the same cutover problem for existing text refusals.
A red-before PostgreSQL test showed that a stale, unlinked reply returned a deliberate
`STALE_REQUEST_REPLY` in the flagged chat but created a legacy task (`intakeStatus:
201`) when the identical update was repeated after the flag was removed. Core now
replays every stored hash-bound routing refusal before selecting lifecycle or legacy
intake. A changed payload under the same update ID returns `IDEMPOTENCY_CONFLICT`.
ADR-059 records the ownership reason. Requirements: FR-060 and NFR-001.

**Verification:** the focused Core/worker set passed **2 files / 50 tests** after
the change, including the original refusal, rollback replay, changed-payload
conflict and absence of a task. Repository lint and full source/test typecheck passed.
The full **425-file / 3,285-
test** source result and `R1.S3.MEDIA` isolated Docker run in the next section belong
to source `29774a1`, immediately before this text-refusal follow-up; they have not
yet been rerun on the follow-up source. Live cutover and full media admission remain
open; the production flag remains off.

## 2026-09-26 — flagged media is held instead of creating a wrong-owner task

A red-before PostgreSQL test showed that a captioned photo in a flagged chat returned
`intakeStatus: 201` and created a legacy Core task: lifecycle intake inspected only
`message.text`, so the media and caption bypassed its new-brief route. Core now records
a hash-bound refusal for lifecycle media before legacy intake can create a task.
ChatInbox journals that answer, parks the update through Core's durable dead-letter
path, and leaves one follow-up notice for the requester and one office alert. An
identical update still replays the refusal after a flag rollback; changed content
under the same update ID conflicts. The guard covers photo, album part, voice, audio,
document, video, animation, caption, channel post and edited message carriers. Its
production sender check uses the existing Telegram intake allowlist. ADR-059 records
why the route holds the complete update until the lifecycle media contract exists.
Requirements: FR-060 and NFR-001.

**Verification:** the final focused Core/worker tests passed **2 files / 50 tests**,
including a journal replay of the hold, changed-payload conflict, flag rollback,
photo, voice, PDF, album part, channel post and edited message. The isolated Docker
Telegram/Core/Restate/PostgreSQL scenario `R1.S3.MEDIA` passed on the final source:
two deliveries under distinct Restate keys produced **zero tasks**, one routing
receipt, one parked update, one requester notice and one office alert. Both intake
invocations completed, and the fake-provider network recorded no unmatched model
calls. Repository lint and full source/test typecheck passed. The source suite,
excluding only the intentionally unsealed release-manifest gate, passed **425 files /
3,285 tests**, with **4 files / 50 tests skipped**. Blueprint validation and the
sealed-tree release gate follow the evidence commit.

**Limit:** Media is deliberately parked and requires office follow-up; it is not yet
usable as image, voice or guideline input for a lifecycle design. This run does not
prove album grouping, durable media retrieval, process-kill recovery during media
download, a live Telegram receipt or the final release gate. The production
lifecycle chat flag remains off.

## 2026-09-26 — real Core-kill replay of the first flagged brief

The first disposable-stack run exposed a Restate 570 nondeterminism error after Core
was killed immediately after storing the new-brief decision. `ChatInbox` had read
its own Restate state inside `ctx.run('mode')`: the first execution recorded a nested
state read, while replay of the completed run skipped that read and could not match
the journal. The handler now reads chat state directly through Restate's context,
before its Core intake run. The worker unit journal refuses nested state access so
this specific mistake regresses visibly. The chaos Compose file also had a duplicate
worker-token mapping that prevented the initial stack build; the duplicate was removed.

**Verification:** the focused worker file passed **24 tests**. The real isolated
`hawa-chaos` stack then killed Core after it committed a flagged chat's first
instruction-only brief decision, restarted it, and resent the same Telegram update
under a second Restate key. `R1.S3.K1` passed: one task, one Restate-owned manual
request, one revision-1 Core projection, one requester acknowledgement, completed
request-owner and both intake invocations, and a Telegram offset past the update.
The drill used fake providers on the isolated internal network; no unmatched model
call occurred. The initial red run's Restate 570 and the intermediate test-only
invocation-count failure are not counted as passing runs. The source suite, excluding
only the unsealed release-manifest gate, passed **425 files / 3,280 tests** with
**4 files / 49 tests skipped** (the new chaos scenario is skipped in ordinary runs).
Repository lint and source/test typecheck passed. Blueprint validation and the
sealed-tree release gate follow the evidence commit.

**Limit:** This qualifies one manual first-brief admission and Core crash/replay on
the source checkout. It does not qualify a worker or Restate restart, an automatic
design, photos/voice/albums, live Telegram acceptance, clean-host restore, or the
closed request-to-delivery flow. The production lifecycle flag remains off.

## 2026-09-26 — legacy receipt wins across a chat flag change (ADR-059 addendum)

After the first-brief checkpoint, a second cutover replay was found: an update already
committed by the Core poller could be seen again by ChatInbox after the chat flag
changed. Core now checks the existing Telegram intake receipt before preparing a
lifecycle open, and returns that old task as a duplicate. The focused PostgreSQL
intake file passed **21 tests**, including old-update replay after flag change;
Core TypeScript passed. The earlier **425 files / 3,280 tests** source result belongs
to the immediately preceding `99eb6b0` checkpoint and was not rerun for this
small follow-up. Live cutover and killed-process evidence remain open.

## 2026-09-26 — first and concurrent Telegram briefs reach the request owner (ADR-059)

Before this change, no production ChatInbox path called `RequestLifecycle.open`. A flagged
chat with no waiting revision fell through to legacy task creation; the live flag alone
could pin that legacy task to the lifecycle delivery executor without a request owner.
Core now prepares a brief with the same client and factual-copy parser as legacy intake,
stores its draft and complete-update hash under the Telegram update ID, and returns a
deterministic request ID without creating a task or sending an acknowledgement. A retry
replays that decision even after the chat flag changes. ChatInbox journals the answer and
sends `open:<requestId>` to RequestLifecycle; the object projects the task and sends its
keyed acknowledgement. A fresh flagged chat admits an ordinary full brief; `/new <brief>`
opens a separate request while another waits. A reply to an unknown or stale lifecycle
notice is refused. Existing Core tasks keep their Core delivery pin, and a newly flagged
chat with historical Core tasks needs `/new` to open a separate lifecycle request.
Instruction-only text opens manual review; greetings and questions retain legacy chat
handling. Requirements: FR-060, NFR-001.

**Verification:** focused intake/worker/ownership tests passed **3 files / 51 tests**
against isolated PostgreSQL and worker journals, including changed-payload conflict,
lost Core answer, failed open dispatch replay, busy-chat second brief, stale reply,
manual instruction, and old task pin. Adjacent delivery and automatic-open tests passed
**4 files / 34 tests**. Full repository lint and source/test typecheck passed. The wider
source suite excluding only the intentionally unsealed release-manifest gate passed
**425 files / 3,280 tests**, with **4 files / 48 tests skipped**. This local proof does not establish a killed
Restate/PostgreSQL admission, media or album cutover, a live Telegram receipt, or the
final release gate. The lifecycle chat flag remains off in production; R07 is in progress.

## 2026-09-26 — confirmed question sends own the reminder clock (ADR-058)

The earlier R07 question timer started when Core projected `awaiting_answer`, before
Telegram confirmed the question. Now the projection leaves `question_asked_at` empty.
TelegramSender commits a critical `sent` mark with a positive message ID, then emits a
keyed private `questionSent` callback. Core checks that exact mark, the current request
revision and task, and the persisted Studio question before storing the mark timestamp.
The request object stores that timestamp and schedules day-1 and day-5 reminders for
the next 09:00–20:00 Erbil moment. A callback replay after Core commit uses the same
timestamp; a crash after state save reissues the same timer keys. Refused or uncertain
sends start no timer. Stale ticks still check request stage, revision and question ID.
Older already-scheduled ticks retain those checks across blue/green deployment. The
legacy SQL draft and question scans now exclude request-owned tasks, so two reminder
owners cannot act on one task. TelegramSender is private to internal Restate callers;
repository call sites already use those object clients. Requirements: FR-060, NFR-001.

**Verification:** affected tests passed **15 files / 156 tests** against isolated
PostgreSQL and worker fakes. They cover no pre-send timestamp, absent and mismatched
marks, fresh-Core confirmation replay, sender callback crash after a confirmed mark,
uncertain-send suppression, state-save crash before timers, next office moment, and
legacy owner exclusion. The route inventory now names the new endpoint and two
previously omitted lifecycle routes. The source suite excluding only the intentionally
unsealed R11 release-manifest test passed **425 files / 3,274 tests**, with **4 files /
48 tests skipped**. Repository lint and full source/test typecheck passed. This is not
the sealed release suite, a killed Restate/PostgreSQL drill, or a live Telegram receipt.
R07 stays **in progress**; the lifecycle flag remains off.

## 2026-09-26 — verified Studio question and requester answer

Core now enters `awaiting_answer` only when a `NEEDS_CLARIFICATION` outcome matches a
persisted failed Studio run for the same tenant and task, with a valid question and options.
It pauses that task and commits the question, request revision, timestamp, and escaped
Telegram question notice together. A forged question report leaves the request in its
manual operator state. RequestLifecycle saves the question before sending the critical
notice and schedules revision-bound day-1 and day-5 reminders under stable Restate keys.
Reminders skip after the request advances; replies to the sent question or reminder bind
to that request even when another request in the chat is waiting.

Core resolves an answer against the current question and exact Telegram reply target.
In one transaction it saves a new task with the original factual brief, answer directive,
parent design context, original Telegram update and full update hash; closes the paused
question task; and advances `awaiting_answer → designing` with a hash-bound receipt.
The worker adopts that receipt, acknowledges the answer with a critical sender key and
starts the next DesignRun. A duplicate update returns the original result; an ambiguous,
late, or mismatched answer is refused without a new task. Clarification answers require
the persisted Telegram update identity, including when a worker handler is called directly.
Requirements: FR-060 and NFR-001. R07 remains **in progress**.

**Verification:** the affected lifecycle set passed **10 files / 87 tests** against
isolated PostgreSQL and worker fakes. It includes the question→answer→new DesignRun
journey, two waiting requests, duplicate and late answers, a forged Studio question,
state-save replay, and stale reminder ticks. `pnpm lint` and `pnpm typecheck` passed;
the first unprivileged typecheck was blocked by local IPC and the same command passed
with access to that IPC. These are local tests. Reminder timing is currently elapsed
from the question projection, not anchored to a confirmed Telegram send or moved to
the next office moment. A killed Restate/PostgreSQL replay of this exact question path,
busy-chat new-brief admission, live Telegram delivery, and the final release gate remain
open. The lifecycle flag remains off.

## 2026-09-26 — revision reply binding and Core receipt adoption

The per-chat `requestId` stored by ChatInbox is only a hint: Core now reads every waiting
RequestLifecycle request in that chat. One waiting request can receive a directive directly; when
two wait, the Telegram message must reply to the exact sent revision notice or reminder. The notice
send mark binds its message ID to a request and revision. An ambiguous message or late reply gets a
durable refusal receipt and a critical keyed notice asking for the correct reply. The same refused
update cannot later be reinterpreted after another request advances.

Core first looks for a committed intake projection by Telegram update ID. A retry after Core moves
the request to `designing` returns that projection instead of creating a legacy task. Its receipt
binds the full update hash, including the replied-to message. RequestLifecycle then verifies and
adopts Core's exact revision-4 receipt and child task; it does not post a second projection. The
child task inherits the parent task's factual copy, dimensions, studio settings and design
instructions, and records the parent task, round and revision directive. A missing parent brief or
daily automatic limit rolls back the task and request transition, stores a durable refusal, and
sends an actionable critical notice. Requirements: FR-060 and NFR-001.

**Verification:** `pnpm exec vitest run apps/core/test/lifecycle-internal-intake.test.ts
apps/worker/test/chat-inbox.test.ts apps/worker/test/request-lifecycle-requester.test.ts`
passed **3 files / 38 tests** against isolated PostgreSQL and worker fakes. Coverage includes two
waiting requests, exact and stale linked replies, lost-answer replay, changed update body and reply
target, inherited child payload, worker adoption without a second Core write, capped and missing
brief refusals, and sender notice handoff. Core and worker TypeScript checks and repository lint
passed. No full-suite or sealed-release claim follows from this focused run. `HAWA_LIFECYCLE_CHATS`
remains off; live Telegram, process-kill and provider-result admission, clarification answers and
explicit new-brief routing in a busy chat remain open.

## 2026-09-26 — requester notice and delayed reminder hardening

An office `revise` decision now sends a critical requester notice and schedules a revision-bound 24-hour
reminder through Restate. The persisted-state replay branch reissues both operations under stable
idempotency keys; TelegramSender's critical send mark prevents an uncertain transport result from becoming
a second message. The reminder checks the exact request revision and `manual` stage before sending, and
uses a critical send mark. Reviewer text is sent as literal Telegram text, so angle brackets and ampersands
cannot break HTML formatting or create markup. Requirements: FR-060, NFR-001; R07 remains in progress.

**Verification:** `pnpm exec vitest run apps/worker/test/request-lifecycle-office.test.ts
apps/core/test/lifecycle-office-desk-bridge.test.ts` passed **2 files / 16 tests** on the working tree;
`pnpm --filter @hawa/worker exec tsc --noEmit` passed. The tests cover a lost Core answer, crash after
state save, stable replay keys, literal reviewer text, matching and stale reminder ticks, and the
authenticated Desk projection. The initial sandbox run could not connect to local PostgreSQL (`EPERM`);
the same focused test command then passed with local service access. No live 24-hour timer, deployed
restart, or production Telegram receipt was measured. Clarification questions, late answers and full
requester Q/A remain open.

## 2026-09-26 — chat mode persistence and decision handoff

Review found `ChatInbox.handleUpdate` replaced its stored view without `mode` or `requestId` after both
handled and parked updates. A lifecycle chat therefore reverted to legacy intake on its next update.
The handler now retains both fields. Its requester-decision dispatch previously used a dynamic import
after the handler returned and swallowed errors, risking a committed Core projection with no lifecycle
signal. The import and keyed object send are now awaited inside the handler; a failure replays the
journaled intake answer and retries the same decision key. Requirements: FR-060, NFR-001. This is a
local repair; the per-chat pointer still needs design for a second open request in the same chat.

**Verification:** `pnpm exec vitest run apps/worker/test/chat-inbox.test.ts
apps/worker/test/request-lifecycle-office.test.ts apps/core/test/lifecycle-office-desk-bridge.test.ts`
passed **3 files / 34 tests**, including consecutive lifecycle updates, failed decision dispatch and
journal replay, a parked update, office state-save crash, and the Desk projection. Worker TypeScript
and repository lint passed. The first lint attempt was blocked by the sandbox's local IPC policy;
the same command passed with local access. No live Telegram or delayed Restate reminder was exercised.

**Date:** 2026-09-25. **Status:** in progress. This is a containment step, not RequestLifecycle completion.

ADR-034 and `output/plans/2026-09-24-architecture-programme/PHASE2_DESIGN.md` define `RequestLifecycle` as the durable owner of a request after slice 2.3. The current worker binds TaskService, TaskWorkflow, ChatInbox, Delivery and TelegramSender, but does not bind RequestLifecycle. Core currently starts Delivery with `reportTo: 'core'`. A caller could nevertheless submit the reserved `reportTo: 'lifecycle'` input to the public workflow. Previously Delivery would prepare an archive and send files, then emit a one-way completion event to a service this worker did not host. That could leave the request without an authoritative completion record.

Delivery now rejects any non-`core` report target before its prepare, archive, Telegram send or report steps. The dormant one-way client was removed. The focused worker check passed **3 files / 13 tests**; its negative test asserts zero Core posts, sends and durable steps for the reserved target. Package and script TypeScript checks passed. On the fixed tree, the full suite passed **406 files / 3,030 tests** with 4 files / 48 tests skipped. An earlier concurrent run loaded the new test against an old module while source files were being edited and reported one failure; it was superseded by this fixed-tree run, not counted as a clean pass. `HAWA_LIFECYCLE_CHATS` and the design flags remain off by default. A source-candidate manifest is stamped after this checkpoint; no deployed image is implied.

This does not implement request-level questions, late answers, reminders, office decisions, projection, cutover pinning or restore. R07 and downstream R08–R10 remain open. Before permitting `reportTo: 'lifecycle'`, implement and register the complete service, versioned event and projection contracts, and restart/duplicate/uncertain-effect drills on the exact candidate image. The guard should then be replaced by the proven lifecycle report path as one promotion, not removed independently.

## Second pass — atomic first projection, before cutover

**Source:** `8fbeb9f` (2026-09-25). The first lifecycle projection now has a worker-credential-only Core route and migration 023. In one PostgreSQL transaction, it saves the Telegram brief as a task, records its `task.created` outbox row as delivered with `OWNED_BY_LIFECYCLE`, pins `tasks.request_id` and `requests.owner='restate'`, and stores a revision-1 projection receipt with a SHA-256 input fingerprint. The request ID is locked before checking the receipt, so simultaneous retries and a retry through a newly constructed Core return one task and one result. Changed content under the same key returns 409. A source event already owned by legacy intake returns 409; its task remains unassigned and its outbox row remains pending. The route admits only a round-zero `createRequest` operation and constructs an allowlisted draft, ignoring caller-supplied identity fields. A fresh production-style database and its narrow grants were exercised. The route inventory and both versioned-upgrade checks include migration 023.

**Verification:** the new isolated-PostgreSQL file passed **4 tests**; the focused migration, route, and fresh-production checks passed **3 files / 29 tests**; source and test TypeScript checks passed; the repository blueprint validator reported **741 pass / 0 warning / 0 failure**. A full suite before updating the migration expectation and source-candidate manifest passed **3,082 tests** and failed three checks: two still named migration 022, and the release manifest named the previous tree. The migration tests were then updated and their focused run passed **3 files / 15 tests**. The fixed-source suite, excluding only the release-manifest file until sealing, passed **409 files / 3,079 tests**, with **4 files / 48 tests skipped**. The earlier three-failure run is not counted as green. The source-candidate manifest and complete suite are verified after the evidence commit; the source suite is not a deployed-image or Restate restart drill.

**Remaining:** no worker `RequestLifecycle` service is registered, and `ChatInbox` still journals `legacy` mode only. The new route has no production caller; it does not start a design run or send a client acknowledgement. Answer, reminder, late-answer, office-decision, delivery, request-level replay and restore paths remain open. R07 stays **in progress** and `HAWA_LIFECYCLE_CHATS` remains off by default. This migration and endpoint do not authorize cutover or a 10/10 claim.

## Third pass — private manual-open handler

**Source:** `05d5d0d` (2026-09-25). The worker now binds `RequestLifecycle` as an internal-only Restate Virtual Object, and the blue/green service inventory includes its name so a later build must continue hosting it. Its first handler accepts only a versioned, round-zero **manual** Telegram request under the matching request key. It projects through the Core route above, stores the request state and input hash, then emits one critical acknowledgement through `TelegramSender` under `${requestId}:1:ack`. Repeating the open, including after a crash between state storage and send, emits the same fenced message key. A changed input, wrong object key or automatic-design request is refused before the Core effect. The handler intentionally does not claim it can start or complete an automatic design.

**Verification:** worker unit tests exercise projection-once, duplicate content, wrong key, automatic-design refusal, and crash-before-send replay. A worker-to-Core isolated-PostgreSQL test deliberately loses the first HTTP response **after Core commits**; the retry returns one task and one projection receipt and schedules one acknowledgement. Service-inventory tests keep the Restate deployment list equal to the worker binding. The focused set passed **3 files / 12 tests**; TypeScript passed; the fixed source suite excluding the manifest test until resealing passed **410 files / 3,085 tests**, with **4 files / 48 tests skipped**. Pack validation passed **741/0/0**. A final sealed-tree manifest and complete-suite result follow this evidence checkpoint; these in-process tests are not a killed Restate instance or a live Telegram receipt.

**Remaining after this pass:** `ChatInbox` still journals `legacy` mode for every update and never calls the new handler, so no production chat is cut over. The service has no design-finished, answer, requester/office-decision, reminder, expiration or delivery-finished handlers; no automated design run starts, and the manual acknowledgement has not been exercised against live Telegram. R07, R08–R10 and their deployed restart/restore gates remain open. The lifecycle flag remains off by default.

## Fourth pass — fence the legacy executor at both current boundaries

**Source:** `712992b` (2026-09-25). A task with `tasks.request_id` now receives `409 LIFECYCLE_OWNED` at both legacy Canva outcome aliases before the handler changes task state or emits a notification. The worker checks the persisted task owner before either `task.created` or `task.dispatch` invokes `TaskWorkflow`; a requeued command for a lifecycle-owned task is consumed without launching that executor. A command claiming `lifecycleOwner: restate` without a matching request-owned task is permanently failed as an ownership inconsistency, rather than guessed into the legacy path. The check uses the persisted owner as authority, not the command payload alone.

**Verification:** the isolated PostgreSQL test file passed **3 tests**. It covered both outcome aliases with unchanged task events and outbox rows, requeued creation and dispatch with zero legacy dispatch calls, a forged lifecycle marker, and an ordinary legacy task that still accepts its outcome. TypeScript passed. The fixed source full suite passed **413 files / 3,099 tests**, with **4 files / 48 tests skipped**. The source and test checks are local; there is no deployed Restate restart or live external-effect receipt in this pass.

**Remaining:** the private manual-open handler still has no production caller or design completion handler. Direct invocation of the legacy `TaskWorkflow` ingress and direct design endpoints are separate cutover surfaces; before enabling lifecycle chats, bind the design run to an owner-aware completion contract and prove those surfaces cannot produce a second authoritative outcome. Request questions, answers, reminders, late answers, office decisions, delivery, restore and complete request-level replay remain open. R07 stays **in progress** and the lifecycle flag remains off.

## Fifth pass — direct legacy workflow refuses a request-owned task

**Source:** `ca26b45` (2026-09-25). Core's authenticated task read now exposes the persisted nullable `requestId`. `TaskWorkflow` and `TaskService` share `runCanvaDraft`; for an automatically generated invocation with a client, it already journals that task read before any Canva or Studio effect. The legacy runner now returns `LIFECYCLE_OWNED` from that read when the task belongs to RequestLifecycle. It checks ownership before its legacy scope-mismatch outcome handler, so a malformed direct invocation cannot post even a rejected legacy outcome. Legacy tasks keep their existing journal step order and design behavior. `PHASE2_DESIGN.md` now requires a future DesignRun to match this persisted owner and report through RequestLifecycle.

**Verification:** two focused files passed **33 tests**. An isolated PostgreSQL test checks the real Core response has the request ID for a lifecycle-owned task and null for a legacy task. The workflow test checks an owned response causes only one GET, no design or outcome call, including a replay of the journaled read and a mismatched client input. Source and test TypeScript checks passed. The clean source full suite passed **413 files / 3,100 tests**, with **4 files / 48 tests skipped**. These are local tests, not a live Restate ingress or paid-provider drill.

**Remaining:** a direct operator design endpoint can still initiate Studio work for an owned task, and `DesignRun` with an owner-aware completion report has not been implemented. The private RequestLifecycle handler still accepts manual opens only; ChatInbox never routes to it. Automatic design, question/answer, reminders, late answers, decisions, delivery, restart and restore proof remain open. R07 is **in progress**; flags stay off and this is not 10/10 admission.

**Contract follow-up:** source `597f655` declares `requestId` as an optional nullable UUID in `Task.schema.json` and asserts that shape in the contract suite. The task-status schema generator reported no drift; the focused schema and ownership checks passed **2 files / 20 tests**. This only documents the new ownership field. The shared `Task.schema.json` still describes older fields as required (`direction`, `sensitivity`) although the current task-detail response omits them, and it excludes other current response fields under `additionalProperties: false`. Full wire-response schema reconciliation remains open before treating this API contract as complete.

## Sixth pass — automatic round-zero design and owned outcome

**Source:** `fc0bda2` (2026-09-25). A private automatic `RequestLifecycle.open` projects the request and task first, then starts one `DesignRun` keyed `dr-<taskId>` from the **persisted Core execution policy**. Core's daily-cap refusal becomes a manual request and does not start paid work. The new run reads `tasks.request_id` in the existing durable scope step; it proceeds only when that owner equals its lifecycle request ID. Its terminal report goes one-way to `RequestLifecycle.designFinished`, never to the legacy Canva status route. The object projects revision 2 through a worker-only Core route. One transaction locks the request, verifies revision/stage/current task, records the task transition and any Desk revision/QC run, advances `requests.rev`, and stores a SHA-256-bound receipt. A draft needs an actual bound Canva design for the same task and client. The result supplies a fenced requester message and, for a failed run with a separate configured office chat, a fenced office alert. The object stores state before sending either message; a retry after a lost response or a crash at the send boundary uses the original projection and message keys. The design outcome Core step retries through an outage without a duration cap, because dropping the only report of a paid run would strand the request.

**Verification:** focused automatic-open, DesignRun ownership, Core PostgreSQL outcome, route-inventory, manual-open and blue/green service-list checks passed **5 files / 39 tests**. They cover a crash after saving open state, daily-cap fallback, a crash after saving outcome state, changed-report conflict, forged owner refusal with zero paid/outcome calls, a successful owned run reporting without the legacy status route, an unbound-design rejection, task event/revision/receipt atomicity, replay through a new Core app, and worker-only authentication. The exact source `fc0bda2` passed TypeScript checks and the source suite excluding the unsealed R11 release-gate file: **414 files / 3,103 tests passed; 4 files / 48 tests skipped**. Blueprint validation passed **741/0/0** after refreshing its file hashes. The release manifest and complete exact-tree suite are checked after this evidence commit; the earlier manifest-stale full run's **3,108 passes and one release-gate failure** is not claimed as a clean gate.

**Remaining:** no production chat calls the new automatic handler: ChatInbox still journals `legacy`, and `HAWA_LIFECYCLE_CHATS` remains off. This implements only round zero. Question/answer, change rounds, requester and office decisions, reminders, expiry, delivery, direct operator design fencing, bounded stuck-run recovery, Restate process-kill/restore, live Telegram/Canva receipts, and the shared task wire schema remain open. The current message gives a Canva link but does not attach lifecycle decision buttons. R07 and the G2 end-to-end admission remain **in progress**; this source test is not evidence of production recovery or creative quality.

## Seventh pass — direct Canva and Studio writes require DesignRun proof

**Source:** `1c89f29` (2026-09-25). A request-owned task's Canva and Studio POST routes, including generation, resume, abandon, export, parity, candidate selection and manual Canva binding, now require a worker-only HMAC proof. The proof binds the persisted request ID, task ID, run ID, method and exact URL path. Core checks the task's `request_id`, `requests.owner='restate'`, current task and `designing` stage before entering the provider or mutation handler. The owned `DesignRun` signs its Core writes with `HAWA_WORKER_TOKEN`; the existing operator bearer token alone cannot produce the proof. The worker credential is not sent to Core in these requests. A proof copied to a different route or used after the request leaves `designing` is refused. Legacy tasks keep their existing routes, and the adjacent human design-feedback route remains available. This closes the direct Canva/Studio operator write surface identified after the sixth pass; it is an authentication fence, not an exactly-once receipt. Existing operation idempotency and reconciliation remain necessary.

**Verification:** the isolated PostgreSQL test exercises all **14** Canva/Studio/binding POST route shapes without a proof, path-bound proof acceptance at representative early-validation points, refusal after the request stage advances, unchanged plan/run/binding tables, and the legacy and human-feedback controls. The worker test asserts the signed headers on the real DesignRun generation call. Focused ownership checks passed **2 files / 9 tests**; the broader Canva/Studio route set passed **7 files / 122 tests**. TypeScript and included-test checks passed. The exact source `1c89f29` passed the full source suite excluding only the unsealed release-manifest gate: **415 files / 3,106 tests passed; 4 files / 48 tests skipped**. Blueprint validation passed **741/0/0**. The release manifest and sealed-tree suite are checked after this evidence commit.

**Remaining:** ChatInbox still sends every chat through the legacy journal; lifecycle chats remain disabled. Other task design routes outside Canva/Studio, including legacy task generation and manual revision creation, still need an explicit ownership policy before cutover. Questions, change rounds, requester and office decisions, reminders, expiry, delivery, bounded stuck-run recovery, killed-process/restore proof, live provider receipts and full task wire-schema reconciliation are also open. The HMAC proof is valid for its scoped run and path while the request is designing; the run ID shape and request stage are checked, but Core has no independently persisted current DesignRun attempt to authenticate a redrive. R07 stays **in progress** and this local gate does not qualify a 10/10 claim.

## Eighth pass — legacy task controls and generation cannot compete with RequestLifecycle

**Source:** `f1f13fa` (2026-09-25). The older task routing, brief and design-generation routes now read persisted request ownership using Core's system automation identity and refuse a request-owned task before changing scope, storing a brief or creating a design. The generic revision route refuses while lifecycle design is active. It permits a manual office revision only for the request's current task, at `stage='manual'`, from an office designer/operator role; the revision transaction locks and rechecks the request row before inserting. Direct task pause/resume/cancel/retry/redrive routes also refuse request-owned tasks. The shared redrive service checks `tasks.request_id` before any Telegram, outbox or Canva effect, so the Telegram `/redo` command cannot bypass the HTTP route; the failed-task sweep excludes owned tasks. A refused `/redo` tells the requester that no new design started. The four legacy controls now require authentication, closing a separate authorization gap found during this review.

**Verification:** isolated PostgreSQL tests were red before the route guards: a request-owned route reached ordinary `400 Bad Request`, and a direct control reached ordinary `409 Conflict` rather than an ownership refusal. After the change, the test checks four legacy design routes, five task controls, direct redrive service refusal, zero dispatch commands, automatic sweep exclusion, a manual office revision, reviewer rejection, stale-round refusal and unchanged design tables. Database-outage regression initially found the new guard returned 500 instead of the established 503; it now fails closed with 503. The final focused group passed **4 files / 44 tests**, the surrounding task/revision/Telegram group passed **9 files / 80 tests**, and TypeScript with included tests passed. The exact source `f1f13fa` passed the source suite excluding only the unsealed release-manifest gate: **415 files / 3,110 tests passed; 4 files / 48 tests skipped**. Blueprint validation passed **741/0/0**. The release manifest and sealed-tree suite follow the evidence commit.

**Remaining:** the ownership boundary is still a local, pre-cutover guard. The current request must eventually receive a versioned `officeDecision draftCaptured` after any manual revision; a generic revision write alone does not advance RequestLifecycle. Other task mutations and approval/delivery routes need a full ownership audit as R08–R10 are built. ChatInbox still routes legacy; question/change rounds, requester and office decisions, reminders, expiry, delivery, persisted active-redrive identity, killed-process/restore drills, live Telegram/Canva receipts and wire-schema reconciliation remain open. R07 remains **in progress** and does not establish 10/10 production readiness.

## Ninth pass — legacy review and delivery cannot write a lifecycle-owned task

**Source:** `34fe5d7` (2026-09-25). The durable task reader now exposes its persisted `request_id` to Core's internal routes. Both legacy publication routes refuse a request-owned task before choosing a delivery executor. The legacy Desk decision route refuses before writing a revision decision; `RevisionRepository.recordApproval` repeats the guard under the task row lock, so a direct repository caller cannot append or replay a legacy approval. Core's own and slice-2.2 workflow delivery paths refuse before archive, Telegram or publication work, and the old workflow's completion reporter checks the task owner under its transaction. These are pre-cutover ownership fences; they do not implement the future `RequestLifecycle.officeDecision` or delivery protocol.

**Verification:** a red-before PostgreSQL test showed an authorized art director's legacy `revise` call returned **201** and wrote an approval on a request-owned task. After the fix, the test exercises the reviewer route, both publish routes, the worker-only delivery prepare endpoint and direct approval repository call; all return/refuse with `LIFECYCLE_OWNED`, leaving zero approvals, publications and `notify.published` commands. The focused ownership file passed **8 tests**, TypeScript including tests passed, and the fixed source suite excluding only the unsealed release-manifest file passed **415 files / 3,111 tests** with **4 files / 48 tests skipped**. The release manifest and exact sealed-tree suite follow this evidence checkpoint. This is local PostgreSQL proof, not deployed delivery or requester receipt proof.

**Remaining:** ChatInbox still routes every chat through legacy intake and no production caller opens RequestLifecycle. Questions, answer/change rounds, office/requester decisions, delivery, reminders, restore drills, active-redrive identity, live provider receipts and complete task wire-schema reconciliation remain open. The manual office revision path still needs a versioned `draftCaptured` event. R07/R08 remain **in progress** and R09 remains planned; no production flag is enabled.

**2026-09-25 addendum (source `f58c67b`):** The earlier remaining list describes the stage above. The first request-owned office approval and delivery claim/report are now locally wired; R08 and R09 are **in progress**. ChatInbox cutover, later question/change rounds, real delivery receipts, process-kill replay and clean-host restore remain open. See `R08_EVIDENCE.md` and `R09_EVIDENCE.md`.

## Tenth pass — revision-3 office request state and projection

**Source:** `cc55fcd` (2026-09-25). `RequestLifecycle` now has its first private office decision: a reviewer requests changes to the current round-zero draft. The object validates request/task/revision identity and a restricted office role, then receives a versioned, hash-bound Core projection. Core commits the approval, task state/event, request revision and replay receipt together. A duplicate design-finished report after this decision is recognized as the already stored revision-2 outcome. Local PostgreSQL and journal tests passed, followed by the source suite **416 files / 3,114 tests**, with **4 files / 48 tests skipped**. Detail and limits are in `R08_EVIDENCE.md` fifth pass.

**Remaining:** The handler has no authenticated Desk caller, and ChatInbox still uses legacy mode. Questions, late answers, reminders, requester decisions, later design rounds, `draftCaptured`, delivery, deployed process-kill/restore, and external receipts are open. No lifecycle flag was enabled; R07 remains **in progress**.

## Eleventh pass — authenticated Desk entrance for the first office action

**Source:** `33a2fb2` (2026-09-25), ADR-040. Core's signed-in Desk route now forwards a first request-owned `revision_requested` action through a signed, narrow public Restate gateway to the private RequestLifecycle object. The route does not write the owned approval itself. The action UUID and authenticated actor are bound into the event; a retry after a lost answer reaches the object even when the request has advanced. The local Core–gateway–object–projection chain passed a lost-response and fresh-Core retry test with one approval. The source suite passed **417 files / 3,116 tests**, **4 files / 48 tests skipped**; complete sealed-tree verification follows the evidence commit. R08_EVIDENCE.md sixth pass carries details and limits.

**Remaining:** ChatInbox remains legacy and production lifecycle flags remain off. Only the first office revision request is supported; question/late-answer/reminder, later draft capture and rounds, requester decisions, approval/rejection, lifecycle delivery, actual Restate process-kill/restore and live effects remain open. R07 stays **in progress**.

## Twelfth pass — isolated Restate process-kill replay

**Source:** `apps/worker/drills/office-restate-harness.ts` and `R08_RESTATE_KILL_DRILL.md` (2026-09-25). The production gateway and private RequestLifecycle handlers ran on Restate 1.7.10 against a disposable instance. A synthetic Core projection wrote its receipt once and killed the worker before returning. After restart, Restate replayed the invocation, reached request revision 3, and returned the original approval. Direct ingress to the lifecycle handler was refused. The focused result and exact limits are recorded in the drill report.

**Remaining:** This proves one narrow worker replay path with a file-backed synthetic Core side effect. It does not prove PostgreSQL, clean-host restore, live providers, or the closed request-to-delivery lifecycle. R07 stays **in progress**.
