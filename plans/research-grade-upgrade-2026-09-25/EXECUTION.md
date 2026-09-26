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

## Current result (2026-09-26 — R12 local PDF inspection)

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
build and zero-secret scan passed. Exact sealing and full regression follow this
source/evidence commit. Native text
order is unverified; OCR, tables and images are not extracted. Retained/approved
PDF ingestion, lifecycle PDF/voice intake, live Workspace/provider/export/recovery
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
