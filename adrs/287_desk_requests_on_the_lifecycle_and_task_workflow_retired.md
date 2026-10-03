# ADR-287: Desk "New Task" Opens a Lifecycle Request; the Task Workflow Is Retired

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/legacy2` (from `claude/release-2` 3ad1aff2). Not deployed.
**Requirements:**
- FR-001: tasks are created through Hawa Desk and adapter events.
- FR-004: one logical decision per message.
- FR-060: long-running work resumes without repeating side effects.
- NFR-001, NFR-003: idempotent side effects and durable execution.

**Changes a foundation:** yes.
- ADR-066 / ADR-071: Desk manual intake. The "New task" form no longer saves a designer-owned task.
- ADR-034: the request owner. RequestLifecycle gains a third channel, the Desk.
- ADR-135 stage 2: its section 9 kept TaskWorkflow and the outbox's `task.created` dispatch. They are retired here.

There is no migration and no new dependency. No Restate service is removed: TaskWorkflow and TaskService stay bound (`apps/worker/src/services.ts`).

**Number:** 287. It was checked free on 2026-10-03 in this checkout, the main checkout, every worktree under `.claude/worktrees` and every local and remote branch. The highest number found was 286.

## 1. Context

ADR-135 stage 2 put every Telegram request on RequestLifecycle and deleted the old Telegram intake. Production answers `GET /v1/operations/legacy-path` with `stage2Ready: true`: 0 open legacy tasks, 0 legacy Delivery runs, and the newest legacy task is from 2026-09-28.

Two paths still sat outside the request lifecycle:

1. **The Desk's "New task".** The form saved a task with `workflow: 'canva_manual'`. Its outbox row was recorded `MANUAL_DESK_OWNED`, so the worker never claimed it. No draft was made unless an operator opened the task and pressed Generate. 52 such requests sat in RECEIVED until they were cancelled on 2026-10-02.
2. **The task workflow.** This is the path from the outbox's `task.created` / `task.dispatch` to the Restate services `TaskWorkflow` and `TaskService`, which ran `runCanvaDraft` and reported to Core's task status route. It had a fallback recorder (`outcome-without-core.ts`) and an embedded runner for a worker without Restate. After stage 2 its only producers were dormant or legacy:
   - WhatsApp intake (no webhook secret is configured in production, so it answers 503);
   - message promotion and unified ingress (no Desk caller);
   - Core's studio re-drive of a legacy task.

## 2. Decision

### 2.1 Desk "New task" opens a RequestLifecycle request

The Desk sends `workflow: 'office_request'`. The reviewed PDF request kept `canva_manual`, the designer-owned path (section 4), until the addendum (section 6) moved it onto the lifecycle too.

Core handles it in `apps/core/src/services/office-desk-request.ts`, in one transaction. The transaction starts in the office member's own scope.

1. **Admission.**
   - The client, and the project if one is named, must be writable for the member. Its active brand DNA is pinned. Both checks are exactly the manual intake's (`prepareManualIntake`).
   - The body is checked field by field. At least one copy field is required.
   - Only a signed-in member may save one. The office tenant only. A service or adapter principal is refused 403.
2. **Core makes the request's first projection itself.** `projectLifecycleOpen` receives a round-zero brief and the Desk evidence:
   - platform `hawa_desk`, channel `desk:<member's user id>`;
   - the exact copy as blocks;
   - the client's default canvas (KAAE 1080×1350, a client pack's own, else 1080×1080), as for a Telegram brief;
   - Studio on.
   - `autoGenerate` follows `AUTO_GENERATE_CHAT_DESIGNS` and the client's onboarding policy, as for Telegram. When either says no, the request opens for a designer and the office is alerted (`manualOpenAlert`).
   - The task's `task.created` payload keeps the Desk body (`workflow: 'office_request'`, with the copy fields as typed). So `savedDesignCopy` and `savedDesignCopyLocales` read the copy and its languages exactly as they read a Desk task's.
3. **The outbox command `office.request.open`** (aggregate `request`, key `office-open:<Desk Idempotency-Key>`) carries the open event: `open:<requestId>`, the channel and the normalised brief.

The worker forwards it.

- `TaskWorkflowDispatcher.dispatchDeskOpen` signs the event with the worker credential.
- It sends it to `OfficeDecisionGateway.openDeskRequest` under the command's key, and requires Restate's invocation receipt.
- The gateway checks the shape and the signature. It then sends `open` to the private RequestLifecycle object under `open:<requestId>`.

RequestLifecycle's own projection call replays Core's receipt: the same key and the same brief, normalised by the same `openDraft` (moved to `services/lifecycle-open-draft.ts`). It then starts the DesignRun.

- A brief with other content is refused (409 IDEMPOTENCY_CONFLICT).
- A Desk brief Core never admitted is refused (409 UNAUTHORIZED_ACTOR).

The same Desk key with the same body answers the same task (200). Another body under that key is refused (409).

From the open on, the request is an ordinary lifecycle request: draft, office review in the Desk, approval, Deliver, delivery.

**Nothing is ever sent to a Desk channel.** The requester is the office member, who follows the request in the Desk.

- TelegramSender answers `desk_only`, a new member of the `SendResult` union.
- RequestLifecycle does not upgrade a chat for it.
- The Delivery workflow sends no file and no notice to it.
- Core completes a Desk request's delivery on its stored Drive and Sheet receipts, with no file sent (`lifecycle-delivery-projection.ts`).
- A Studio clarification question on a Desk request goes to a designer (the `manual` stage, the office alerted), never to a chat.

### 2.2 The task workflow is retired

**Deleted from the worker:**

- `workflow.ts`: TaskWorkflowRunner and its refusal error. Its input and output types move to `design-input.ts`, which DesignRun uses.
- `TaskWorkflowDispatcher.dispatch` and its embedded runner.
- `outcome-without-core.ts`, `reportNotRunnable`, and the `recordOutcome` parameter of `runCanvaDraft`.
- The two message composers only the recorder used.

**Kept, refusing:**

- TaskWorkflow and TaskService stay bound, as every service a build ever hosted does. They answer any invocation with TerminalError `LEGACY_WORKFLOW_RETIRED` (410) before any effect.
- The outbox completes a command for a request-owned task as before.
- It dead-letters any other `task.created` or `task.dispatch` as `LEGACY_WORKFLOW_RETIRED` (permanent, no Restate submission, no paid call).
- Core's re-drive of a studio task outside RequestLifecycle used to queue a `task.dispatch`. It now answers 409 `LEGACY_WORKFLOW_RETIRED` and messages nobody.

## 3. Rollback

Roll back to the previous release (`3ad1aff2`, or whichever build `~/.hawa/current` pointed to before).

- **Requests already opened.** Desk requests opened by this release are RequestLifecycle requests with ordinary rows. The previous release shows and reviews them like any lifecycle request.
- **Their messages and delivery.** The previous release knows no `desk:` channel. Anything its lifecycle objects send to one (a reminder, a notice) goes to Telegram, is refused, and alerts the office. A Desk request delivered on it ends `REQUESTER_SEND_UNCONFIRMED` and stays `delivering` until this release is restored or the office closes it.
- **Desk forms.** The Desk is built into the release, so the rolled-back Desk sends `canva_manual` again. A browser still running this release's Desk would send `office_request`; the previous Core saves that as an ordinary task, whose dispatch its task workflow refuses for an operator to follow up.
- **Commands in flight.** An `office.request.open` command still pending at rollback is unknown to the previous worker. It fails visibly (unknown command) and can be re-driven from the outbox once this release is back.

No data is migrated in either direction.

## 4. Consequences and what is not changed

- **Desk requests now get automatic drafts, and spend.** The Studio's own budget and spending policy bound them. A Desk member is exempt from the daily automatic-draft caps, as an office director on Telegram is.
- **The reviewed PDF request stayed designer-owned.** The form is "Use reviewed PDF" and the outbox row was `MANUAL_DESK_OWNED`. Moving it needed the source-document evidence on a lifecycle open, which Telegram PDFs had but the Desk upload did not. The addendum (section 6) gives it that evidence.
- **Some producers still write a pending `task.created`.** API callers of `POST /v1/tasks` without a workflow, message promotion, unified ingress and WhatsApp still do. Their tasks are dead-lettered `LEGACY_WORKFLOW_RETIRED` and stay in the Desk for a designer. None is used in production today. Routing them to RequestLifecycle, or removing them, is left for when one is wanted.
- **`runCanvaDraft` keeps one legacy branch.** Without a lifecycle reporter it still reports to Core's canva-status route. DesignRun always passes the reporter. About sixty step tests drive that seam, and Core's canva-status route keeps its legacy outcome handling. Both can go once those tests use the lifecycle reporter.
- **The outbox's `task.outcome` handler stays.** It drains any row the recorder wrote before this release.
- **The hawa-chaos drivers are unchanged.** `candidate-sources.ts` and `studio-settlement.ts` create `canva_manual` tasks and drive Studio on them, and that path still exists.

## 5. Qualification — 2026-10-03

Run in the worktree, targeted files only. The full suite and the chaos suite were not run: the machine was running a production deploy gate.

- **New Core tests,** `apps/core/test/office-desk-request.test.ts`: 5 of 5 passed.
  - Admission in one transaction.
  - The worker's replay and a changed brief refused.
  - Same-key replay and conflict.
  - Refusals with nothing recorded: no copy, an inactive or unknown client, a malformed client, a service principal, a PDF body.
  - A forged worker open.
  - The designer stage when drafts are off.
  - No question on the Desk channel.
  - Delivery completed on receipts with no file sent.
- **Red check.** The delivery, question and forged-open rules were reverted and three of the five failed. They were restored after.
- **New worker tests,** `apps/worker/test/office-desk-request.test.ts`: 5 of 5 passed.
  - The signed dispatch under the command key, with a receipt.
  - The outbox handler.
  - Gateway refusals.
  - The lifecycle open.
  - A Desk delivery that sends nothing.
- **Desk.** `manualTaskIntake.test.ts` and `document-request.test.ts`: 18 of 18 passed.
- **Commit 1, affected suites:** 62 files, 651 tests passed. These were the Core lifecycle, delivery, copy and intake tests, every worker test file, and the Desk intake tests.
- **Commit 2, affected suites:** 62 files, 521 tests passed. These were every worker test file, Core's re-drive, control, outbox and design-proof tests, and testkit's duplicate-path, service-list and request-log tests.
- **Static checks.** `tsc -b`, `tsc --noEmit`, the scripts project and the test typecheck (793 test roots) passed. So did the `any` ratchet (964 of 1053) and the egress lint.
- **Not executed:** the full suite, the chaos suite, a deploy, a live Desk request.

## 6. Addendum — the reviewed PDF request opens on the lifecycle (2026-10-03)

**Status:** Implemented on branch `claude/deskpdf` (from `claude/release-3`). Not deployed. No migration.

### 6.1 Context

Section 4 left the Desk's reviewed-PDF form on `canva_manual`, so a PDF request got no automatic draft. A Telegram PDF brief already opens on RequestLifecycle with its reviewed source: `reviewedSource` on the task's creation event (ADR-145's `ReviewedSourceEvidence`) and the original as the task's `source_document` file. Both channels retain the PDF the same way: the bytes in the blob store and the extraction receipt in `hawa.client_documents`. What the Desk lacked was a confirmation the lifecycle could carry: the Telegram evidence names Telegram update ids, which a Desk save does not have.

### 6.2 Decision

**The form.** The reviewed-PDF form sends `workflow: 'office_request'` and the `sourceDocument` it already named: the receipt id, the source and extraction hashes the member reviewed, and `confirmed: true`. The copy is the member's typed English and Sorani fields, as before. The extracted text is never sent.

**Admission.** Core's Desk intake (`office-desk-request.ts`) admits it in the same single transaction as a "New task", in the office member's own scope:

1. The client and project are checked and the brand DNA pinned (`prepareManualIntake`), as in section 2.1.
2. The named receipt is checked by `verifyDocumentSource`. This was split out of the manual path's `prepareDocumentIntake` (`client-documents.ts`), which now calls it, so both paths apply the same rules:
   - the member's tenant role is administrator or operator, the existing boundary for confirming PDF copy;
   - the receipt belongs to this client;
   - its source and extraction hashes are the reviewed ones;
   - the original bytes are stored and read back intact.
3. `deskReviewedSource` builds the evidence.

**The evidence model.** `ReviewedSourceEvidence` (`@hawa/contracts`) becomes a union of two variants with the same core fields:

- `kind`, `sourceSha256`, `extractionSha256`, `extractorVersion`, `documentId`, `clientId`;
- `confirmation: 'request_copy_reviewed'`, `confirmedBy`, `copySha256` (sha256 of the request's raw text).

The Telegram variant keeps its two update ids. The Desk variant has:

- `origin: 'hawa_desk'`;
- `confirmedBy: 'desk:<user id>'`;
- a required `documentId`;
- `pageCount`.

Its page references are the extraction's own. The receipt `documentId` is immutable, and each extracted chunk carries its page number. The form has no per-page copy selection, so no per-block page is claimed.

**The open.** `projectLifecycleOpen` takes the evidence with Core's Desk receipt. It refuses with `UNVERIFIED_DESIGN` if the evidence names another client or hashes other words than the brief's raw text. It then writes, as for a Telegram PDF:

- the evidence on the task as `reviewedSource`;
- the original as the `source_document` task file.

Only identities cross to the worker. The `office.request.open` brief carries the confirmed words and no source reference. The worker's replay matches Core's receipt as in section 2.1.

**The Studio's copy.** `savedDesignCopy` and `savedDesignCopyLocales` read a Desk PDF request's labelled Desk fields verbatim, with their languages: no emoji, divider or remark clean-up. They do not use the Telegram branch, which reads `exactCopy`. Nothing is invented. A request without copy is refused at intake.

**Idempotency.** The body hash under the Desk's Idempotency-Key covers the named receipt. The same save answers the same task, even after the parser is gone: the earlier save is found before anything is checked again. Other words, or another receipt, under the same key are refused with 409.

**The Desk's refusals.** The form shows the server's own words:

- 403: an operator must save it, or the PDF is not in this client;
- 409: the evidence changed;
- 422: no confirmation, or no copy.

A 409 on a fresh key is definitive for a PDF request: nothing was made. A retry record frozen by the earlier Desk, which differs only by `canva_manual`, is retried exactly as it was sent under its key.

### 6.3 Unchanged

- `canva_manual` with `sourceDocument` stays on the server for API callers, the hawa-chaos drivers, and a browser still running the earlier Desk.
- A Desk PDF request takes the client's default canvas, as a Desk "New task" does. A Telegram PDF without a size takes 1080×1350.
- A redo of a reviewed-source request is not converted into a fresh round by the office retry (`lifecycle-office-retry.ts`). The rule is the same for both channels.

### 6.4 Rollback

Roll back to the previous release.

- Requests opened by this addendum are ordinary lifecycle requests. The previous Core reads their `reviewedSource` with the Telegram copy branch, which needs `exactCopy` in the Desk body. A Studio re-run on such a request would therefore refuse with `COPY_REQUIRED` and go to a designer. It invents nothing.
- The rolled-back Desk sends `canva_manual` again.

### 6.5 Qualification — 2026-10-03

Targeted files only. The full suite and the chaos suite were not run: a deploy gate runs the full suite.

- **New Core tests,** `apps/core/test/office-desk-pdf-request.test.ts`: 2 of 2 passed.
  - **The open:** an automatic `designing` lifecycle request; `reviewedSource` equal to the expected evidence on the outbox row and the creation event; the `source_document` file; no extraction text and no source reference in the worker's brief; the Studio's copy and languages verbatim; the Desk task view's original PDF; the worker's replay; same-key replay after the parser is gone; a changed body refused.
  - **Refusals, with nothing recorded:** no confirmation, a malformed id, changed source or extraction hashes, an unknown or other client's receipt, no copy, a client-scoped designer, and damaged original bytes.
- **Desk tests,** `apps/desk/test/document-request.test.ts` (9, two new) and `manualTaskIntake.test.ts`: 20 of 20 passed.
- **Red check.** The six changed source files were restored to `claude/release-3` with the new tests in place. Four tests failed (both Core tests and two Desk tests) and seven passed. The frozen-record retry passes on the old Desk by construction: the old Desk sent `canva_manual` itself.
- **Affected suites:** 36 files, 613 passed, 2 skipped (opt-in recovery drills). These were every Core test touching saved copy, the lifecycle open, documents or Desk requests, the worker's Desk-open and ownership tests, and the Desk intake tests.
- **Static checks.** `pnpm typecheck` (802 test roots) and `pnpm lint` passed, including the `any` ratchet (975 of 1053) and the egress lint.
- **Not executed:** the full suite, the chaos suite, a deploy, a live Desk PDF request with the parser sidecar.

