# R07 — RequestLifecycle ownership and projection (in progress)

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
