# ADR-230: A Request Can Be Withdrawn, and a Chat-Only Delivery Delivers It

**Date:** 2026-10-01
**Status:** Implemented on branch `claude/request-withdraw-and-chat-delivery` (from production `b83c9f1d`); not deployed.
**Requirements:** FR-005 (requester messages), FR-061 (operators cancel with an audit reason), FR-048 (completion only on read-back receipts), FR-063 (the Desk shows actionable states).
**Changes a foundation:** no. RequestLifecycle gains two transitions (`withdraw`, `reconcileDelivery`); Core gains three internal projections; no migration (`requests.stage` already admits `cancelled`, migration 034), no new dependency, no new paid call.
**Builds on:** ADR-034 (RequestLifecycle owns the request; Core projects it under expected revisions and receipts), ADR-142 (the office acts on a request through the signed office gateway), ADR-144 (one decision per requester update; a cancel was a note), ADR-155 (the only report of paid work is never lost), ADR-200 (office alerts name people and designs).
**Number:** 230, assigned by the lead (Codex holds ADRs up to 216 and migrations 074–077).

## 1. Context

The live test of production `b83c9f1d` on 2026-10-01 (`LIVE_TEST_2026-10-01.md`, L1 and L3):

- **L1, nothing could close a request.** Request 3a4c6ac4 was opened by mistake from "do a better design thats similar to earlier ones". "cancel the last request" got "OK. I've asked the office to cancel …" and the office "Nothing was stopped automatically." The Desk's Cancel answered 409 LIFECYCLE_OWNED. RequestLifecycle had no transition out of `manual` except a native review, and office rejection works only from `in_review` (ADR-144: "RequestLifecycle has no cancel transition"). The request stayed open, stayed the chat's most recent one, and later words bound to it.
- **L3, every Telegram delivery ended "being delivered".** The office Google account is not connected, so Delivery prepares `chatOnly`, sends both files and the final notice (Telegram confirmed each), and reports `chat_only`. `projectLifecycleDeliveryFinish` kept the request `delivering` and the task `publishing`, recording REQUESTER_SEND_UNCONFIRMED. The sends were confirmed; only the archive was missing. Status said "is being sent to you now" hours later, a redo reply to the final message was refused ("a delivery had already started"), and the Desk showed the task publishing for good.

## 2. Decision

### 2.1 Withdraw (L1)

**One writer.** RequestLifecycle's new `withdraw` handler is the only thing that closes a request. It calls Core's `POST /internal/lifecycle/:id/withdraw` with the request's revision (`expectedRev`, `rev = expectedRev + 1`, key `<request>:<rev>:withdraw:<event>`). Core, in one transaction under the request's advisory lock: checks the receipt; moves the current task to `cancelled` (any non-terminal state, with the actor, the event and the stage left in the task event); moves the request to `cancelled` (an existing stage, so no migration); and stores the receipt with the words to send. The object then records `withdrawal` in its state, keeps the design run's identity, and sends the notices under stable keys. A replay of the same event resends the same keys; other content under the same event is refused.

**Withdrawable stages.** Nothing approved yet: `manual` (a request opened for a designer with no draft at rev 1, a design that ended without a draft, a draft the office sent back for changes), `designing`, `awaiting_answer`, `in_review` (automatic and manual-origin). Not `approved`, `delivering` or `delivered`.

**The requester's cancel.** Core's intake decides it, as every requester message (ADR-144):

- A cancel bound for certain (a reply to the design, the only open design, named, or a question answered) on a withdrawable request is recorded as `lifecycleAction: 'withdraw'`. ChatInbox sends `withdraw` to the request object under `chatinbox:withdraw:<update>`. It says nothing itself; the object answers once the request is closed.
- Core admits a requester withdraw only when the intent receipt of that very update decided it for that request in that chat (`UNAUTHORIZED_ACTOR` otherwise): an update id cannot be replayed into a withdraw.
- A cancel picked only by which design moved last (or a model's guess) is asked first: "Do you want me to cancel *title*?". "Yes" (or naming it) withdraws it. This replaces "Do you want me to ask the office to cancel …".
- The requester hears "Cancelled *title*. Nothing more will be made for it." (Sorani alongside, `WITHDRAW_MESSAGES`). Every office member but the requester hears, in ADR-200's style, "Sewa cancelled "*title*" in the chat while it was *stage*. It is closed, and nothing more will be made for it." Being made, it adds that a design already under way may still finish and will not go to review or to them. The short task id is on the last line only; no chat id or UUID is in the body.
- Too late (approved, being delivered, delivered): the cancel is kept for the office as before (a late change of kind `cancel`, so Deliver waits until someone has read it), and the requester is told the truth: "*title* was already approved, so I can't cancel it myself. I've told the office." (or "is already being sent to you, so I can't stop it", or "was already sent to you, so there is nothing left to cancel"). With no office chat to tell: "*title* can't be cancelled from here any more. I've kept your message for the office." The office alert says it came too late and nothing was stopped.
- The request moved between the decision and the withdraw (the office approved it in between): Core refuses the withdraw, keeps the cancel for the office as above, and gives the same truthful words, which the object sends. Nothing changes.

**The office's Cancel.** `POST /v1/tasks/:id/cancel` on a request-owned task (it answered 409 LIFECYCLE_OWNED) now withdraws the request through the signed office gateway (`OfficeDecisionGateway.withdraw`, the ADR-142 path), with the office member as actor and their reason. The Desk's own body is used unchanged (`expectedVersion`, `reason`, `Idempotency-Key`); the key is the action id (a non-UUID key is hashed to one). Core checks the task version, that it is the request's current task and that the stage is withdrawable, and answers the receipt the Desk already reads (`status: CANCELLED`). A second press with the same key answers `replayed`. An approved, delivering or delivered request is refused with the reason in words. The requester is told: "The office has cancelled *title*, so nothing more will be made for it. Tell me whenever you need a new design." No Desk change was needed.

**A design run already in flight** is not stopped (its spend is made; no call is added). Its Canva writes are refused once the request leaves `designing` (`rejectUnownedLifecycleDesignWrite`). When `designFinished` arrives for a withdrawn request, the object records the run's report against the closed task (`POST /internal/lifecycle/:id/withdrawn-outcome`, an `inbox_events` row per run) and stops: no review, no draft alert to the office, nothing to the requester. A replay records nothing more.

### 2.2 Chat-only delivery delivers (L3)

**The rule.** `projectLifecycleDeliveryFinish` closes a `chat_only` report as delivered when the report says nothing is uncertain and every approved file was sent, and Core's own stored Telegram send marks agree: every approved file's mark and the notice's mark is `sent` with a message id (the keys Delivery and TelegramSender use, read by `readDeliverySendSteps`, now shared with the requester-send evidence). The worker's numbers stay a report: without the marks the request stays unconfirmed as before. `assertStoredDeliveryReceipts` is unchanged; it still verifies any Drive or Sheet claim.

**What is recorded.** The task goes `publishing → complete` (reason "Delivered to the requester in the chat; the Drive archive is pending"), the request `delivering → delivered`. The publication is *not* marked complete: its `error_class` is the new `ARCHIVE_PENDING` (not REQUESTER_SEND_UNCONFIRMED), and its `error_detail` keeps the report. Status, ADR-200's redo of a delivered design and replies to the final message now see `delivered`.

**Archiving later** needs Core to upload the approved package of a delivered task to Drive when Google is connected, and a Desk action to start it. That touches `omnichannel-delivery.ts` and the Desk, which Codex owns: a handoff (section 4).

**The repair.** Requests already stuck (`delivering`, REQUESTER_SEND_UNCONFIRMED after a `chat_only` report, e.g. 95eeb08d) are closed by `scripts/repair_chat_only_delivery.ts <requestId> …`, run by a person after the deploy. It signs `{ kind: 'reconcile-delivery', requestId }` with HAWA_WORKER_TOKEN and posts it to `OfficeDecisionGateway.reconcileDelivery`, which checks the signature and calls the request object's `reconcileDelivery`. The object requires a recorded finish still `delivering`, and calls Core's `delivery-reconcile` at the next revision. Core re-reads the report it stored on the publication and the send marks. It closes the request exactly as a new chat-only delivery is closed, or refuses (NOT_CHAT_ONLY, SENDS_UNCONFIRMED) and changes nothing. A second run answers `replayed`. It sends no message.

## 3. Consequences

- A request opened by mistake can be closed by its requester ("cancel it") or the office (Desk Cancel); it then leaves the chat's requests (intake reads only open stages), so later words no longer bind to it.
- `cancelled` is a terminal request stage for request-owned requests: every RequestLifecycle handler refuses it (WRONG_STAGE), reminders and question clocks skip it, the stale sweep does not alert it.
- A cancel the bot is not sure of costs the requester one "yes". A cancel of an approved design is still the office's to handle, now said truthfully.
- The publication audit flags a complete task with no verified Drive file. For an ARCHIVE_PENDING publication that is the truth, and the list of what to archive.
- Mixed deployments: Core and the worker ship together. An older ChatInbox would ignore a `withdraw` answer; an older worker has no `withdraw` or `reconcileDelivery` handler (the script must run after the deploy).
- Not stopped: a design run in flight keeps running to its end (and spends what it spends); only its result is dropped.

## 4. Handoffs

- **Codex (Desk and `omnichannel-delivery.ts`):** an "Archive to Drive" action for a task whose publication is `ARCHIVE_PENDING` (task `complete`, request `delivered`). Core uploads the approved package (`package_manifest`, pinned at approval) to the client's Drive and Sheet with the existing reservations and receipts. Only then does it mark the publication complete and clear the error. It sends nothing to the requester, and it never moves the request. The Desk should show ARCHIVE_PENDING as "Delivered in the chat; not archived yet". Today `publicationAwareTaskStatus` shows such a task as COMPLETE.
- **Lead:** after deploying, run `RESTATE_INGRESS_URL=… HAWA_WORKER_TOKEN=… pnpm exec tsx scripts/repair_chat_only_delivery.ts 95eeb08d-c085-5f7d-b3d8-61049b1fc1fd` (and any other request in `delivering` whose publication holds a `chat_only` report). Withdraw request 3a4c6ac4 from the Desk (Cancel on task 030996c1) or let its requester say "cancel it".

## 5. Verification

- `apps/core/test/request-withdraw.test.ts` (18, per-file database as hawa_app, the worker's own RequestLifecycle and Core client):
  - the requester's cancel in each withdrawable stage (`manual` rev 1 with no draft, `designing`, `awaiting_answer`, `in_review`, `manual` after a revise): request `cancelled`, task `cancelled`, the requester's words, the office's alert by name with no chat id or UUID, and the chat no longer offers it;
  - replays (same keys, one projection, a fresh object answers from Core's receipt) and a forged or unrelated update refused (UNAUTHORIZED_ACTOR);
  - the recency question "Do you want me to cancel …?" and its "yes", and Sorani;
  - too late (approved, delivering) told truthfully, with the Deliver gate; approval racing the withdraw;
  - designFinished after the withdraw (no review, no message, recorded once);
  - the Desk's Cancel through the gateway check (202, then `replayed`), refused when approved, delivering or delivered (with the reason), a stale version, a non-office role, a forged signature.
- `apps/core/test/chat-only-delivery.test.ts` (7):
  - chat-only with Telegram's marks closes the request (ARCHIVE_PENDING, publication open, status "has been delivered");
  - an unconfirmed notice or a short file count closes nothing;
  - the repair through the script, the gateway check and the object (delivered, then `replayed`, a forged signature 401);
  - refused for an uncertain delivery, an unconfirmed notice and missing marks.
- `apps/worker/test/chat-inbox.test.ts` (+2): ChatInbox hands the withdraw over under the update's key once and says nothing; the worker's client reads the answer and refuses a malformed one.
- Changed deliberately, with the reason in each test: `requester-intent-routing.test.ts` (a cancel in review is a withdraw decision; approved is kept and told truthfully), `lifecycle-design-proof.test.ts` (Cancel no longer answers LIFECYCLE_OWNED), and NL scripts S044, S080, S081, S082, S084, S087 (the request is closed; `conversation-harness.ts` gives ChatInbox the object's `withdraw`).
- Red before: with this branch's sources reverted to `b83c9f1d` and the new tests kept, 31 tests fail (18 + 5 + 1 + 1 + 6). The two that pass are guards: a short file count and an unconfirmed notice close nothing.
- Not run: live Telegram, a Restate server, chaos, a native Sorani review.

## 6. Addendum (2026-10-01): a change sent while the design is being made is applied (L8)

**Incident.** Request ab48fb97: at 13:59 "also please add that seats are limited" arrived while the request was `designing`. Intake kept it as a pending change (ADR-144) and told the requester "I've added that …". The draft finished at 14:00 without it and went to office review as if nothing had been said. The office's draft alert did not mention it.

**Decision.** When a design run finishes *with a draft*, Core's design-outcome projection reads the changes kept from that very round. A change counts when it is a late change of kind `change`, kept while the request was `designing` at the revision the run finished at, and not yet read by an office member (`pendingDesigningChanges`). If there are any, the same transaction (`startPendingChangeRound`, under a savepoint) does five things:
- it records the draft as before, then moves its task `human_review → revision_requested`, so it is never reviewed;
- it creates the next round's task as a requester revision does: the draft's brief, exact copy, format and Studio options, `parentTaskId` = the draft's task, `revisionRound` + 1, and the requester's words, in order, as `revisionDirective`;
- it keeps the request `designing` on the new task, at the outcome's revision;
- it marks those changes read by this round (`lifecycle_late_change_ack`, actor `lifecycle_pending_round`), so they are never applied twice and Deliver does not wait for them;
- it returns `pendingRound` with no office alert, and the requester's line "Your first draft of *title* is done. I'm now adding what you asked while it was being made: “…”. The office checks the new version before it comes to you." (`PENDING_ROUND_MESSAGES`).

RequestLifecycle's `designFinished` accepts a `designing` outcome only with `pendingRound`. It moves to the new task and run (round from Core), sends the outcome's message, and starts the run. The handler may now start a design run, but only that one.

The round is the requester's own instruction, so its paid run is allowed. It counts against the daily automatic-design allowance like any change, and makes no other model call.

**When a round cannot start**, the savepoint is rolled back and the draft goes to review as before. This happens when the allowance is used up, the draft's brief cannot be found, or the request already had `MAX_PENDING_ROUNDS` (3) such rounds. In that case:
- The office's alert ends with "NOT IN THIS DRAFT: …", the reason, and every change word for word. A photo caption that would pass 1,000 characters is dropped, so the full text alert goes instead.
- The changes stay unread, so Deliver waits for them.
- The requester hears "Your draft of *title* was finished before your changes could be added: “…”. The office has them …" (or "I've kept them for the office" with no office chat).

A draft with no such change, and a run that ends without a draft, are unchanged. A manual request has no design run, so it never reaches this.

**Replay.** The receipt makes Core's projection idempotent. A finish reported again for the superseded run (`pendingRoundFrom`) resends the same outcome keys and starts the same run under the same workflow key; the marker is cleared at the next outcome.

**Not changed here:** the 13:59 answer ("I've added that …") is L4's wording (another branch). With this change it is true once the draft finishes.

**Merged with ADR-231 (2026-10-01).** ADR-231 had made that answer "I've kept that with *title* for the office …" and the office alert "It is not in the draft being made; add it in the next round or at review." Both were untrue for `designing` once this section applies the change. For `designing` the requester now hears "Got it. I'll add that to *title* as soon as the current draft is done." (`ROUTING_MESSAGES.changeAddedNextRound`; its Sorani line awaits native review). The office alert says "It will be added automatically in a new round when the current draft finishes; if a round can't start, the draft alert will list it.", and its second line begins "If it is not added, …". `manual` and `awaiting_answer` keep ADR-231's wording: this section counts only changes kept while `designing`.

**Verification.** `apps/core/test/pending-change-round.test.ts` (5, through ChatInbox, intake, design-outcome, TelegramSender and RequestLifecycle in the conversation harness):
- the exact live words: no office alert for the first draft, a child round with the words as its directive, the requester's line, and the next draft reviewed normally;
- a replayed finish starts nothing new and sends nothing again;
- the allowance used up: review, the office alert quotes the change, the requester is told the office has it, and Deliver still waits;
- the round limit;
- a draft with no change.

4 of 5 fail on the previous sources; the fifth is the unchanged path.
