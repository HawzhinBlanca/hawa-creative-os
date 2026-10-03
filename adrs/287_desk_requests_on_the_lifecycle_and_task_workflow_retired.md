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

The Desk sends `workflow: 'office_request'`. The reviewed PDF request keeps `canva_manual`, which stays the designer-owned path (section 4).

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
- **The reviewed PDF request stays designer-owned.** The form is "Use reviewed PDF" and the outbox row is `MANUAL_DESK_OWNED`. Moving it needs the source-document evidence on a lifecycle open, which Telegram PDFs have but the Desk upload does not.
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
