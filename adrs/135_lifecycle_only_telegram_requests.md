# ADR-135: Every Telegram Request Takes the Lifecycle Path; the Old Path Only Finishes Its Own

**Date:** 2026-09-28
**Status:** Stage 1 deployed with the combined release. Stage 2 (2a–2d) implemented and locally qualified on 2026-09-29, after production answered `stage2Ready: true`; not deployed (section 9).
**Requirements:** FR-001, FR-004, FR-060, NFR-001, NFR-003, NFR-013.
**Changes a foundation:** ADR-052 (executor pin at creation: its chat flag is removed), ADR-059 (new-brief admission: no chat is left on legacy intake), ADR-129 (the Core poller as the rollback of the worker poller is retired). Builds on ADR-034.
**Map:** `plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT.md`.

## 1. Context

On 2026-09-28 the owner decided: "put everything on the new path, we don't need any other path, let's perfect this path." Production has run `HAWA_TELEGRAM_POLLER=worker` and `HAWA_LIFECYCLE_CHATS=*` since then.

Mapping the old path at `3f3d71ca` showed that the flag did not do what it said:

1. **New legacy requests were still created.** In a chat with any earlier Core-pinned task, an ordinary brief without `/new` went to legacy intake and became a new Core-pinned task (`hasLegacyTask`, ADR-059). Every chat that used the bot before the switch is such a chat; the owner's first test after the switch (task `dca13ce5`, 16:33Z) was a legacy task. Questions, greetings, standing rules and anything legacy intake's own classifier read as a brief also reached its "new request" stage.
2. **Replies to an open legacy draft were refused** as `STALE_REQUEST_REPLY`: they carry no lifecycle message link. ADR-059 meant them to stay on legacy intake.
3. **A legacy draft button could become a lifecycle revision.** A callback's data was read as message text, and in a chat with exactly one lifecycle request waiting for changes it was projected as that request's revision directive.
4. **Core's poller could not be a rollback.** It feeds only legacy intake, so rolling the poller back to Core (the ADR-129 procedure) would send every new request down the old path; runbook 20 already warned that lifecycle replies through it were never exercised.

The newest production dump (`predeploy_20260928T175243Z`, restored on the test server) holds 0 Restate-pinned tasks and 111 open legacy Telegram tasks in 15 chats (97 `received`, 12 `human_review`, 1 `paused`, 1 `failed_operator`; 110 untouched for four days).

## 2. Decision

**Stage 1 (ready to merge).**

- **Every Telegram chat is lifecycle-owned.** `HAWA_LIFECYCLE_CHATS` and `lifecycleOwnsChat` are removed. Treating unset as `*` was rejected: any other value (a list, an empty string set by mistake) would still send chats down the old path, and "no setting can do it" is simpler to hold and to test than "the default is right". Core logs the variable as ignored when it is still set. ChatInbox's `legacy` intake mode stays on the wire (a draining worker colour sends it for a chat's first update) and is answered exactly like `lifecycle`.
- **The old intake finishes its own requests and starts none.** It is reached only in a finish-only scope (`services/legacy-telegram-scope.ts`): when Core's internal intake hands it an update (header `x-hawa-intake-scope: finish-only`), and always in production, whoever calls the route. Updates go there only when they are about a legacy request (`services/legacy-telegram-routing.ts`): a callback query (lifecycle notices carry no buttons); a reply naming a legacy task of the chat; an unlinked message where the chat's newest request of the last 48 hours is an open legacy one (legacy intake's own reading window, `telegram-intake/replies.ts`). Questions, greetings and standing rules without a waiting request are still answered there. In that scope the route refuses its "new request" stage before it sends anything, and `persistChatIntake`, which writes every legacy task, refuses a Telegram task outside the lifecycle unless it continues an open (not complete, rejected or cancelled) legacy request of the same chat and not a lifecycle one. The refusal (`409 LEGACY_REQUEST_REFUSED`, reason `NEW_REQUEST`, `REQUEST_CLOSED` or `LIFECYCLE_OWNED`) becomes ChatInbox's existing `new-brief-required` notice: "send /new followed by the full design brief". `/new` always opens a lifecycle request. Every other brief opens one directly.
- **Core no longer polls, and the Core poller is not a rollback.** `telegramPollerOf` always names the worker, production options never start Core's loop, "Poll now" and webhook registration answer 409 (a webhook would bypass RequestLifecycle and stop the worker's getUpdates), compose defaults to `worker`, and `deploy.sh` refuses any other value before a backup or change, in pre-flight too. The worker still polls only with `worker`, so a stale `core` stops intake loudly (the watchdog alerts: Core's health names the worker) instead of routing it to the old path. A broken worker poller is rolled back with the worker: the previous colour (ADR-129 blue/green) or the previous release.
- **The lead can see when stage 2 may merge without SQL.** `GET /v1/operations/legacy-path` (administrators, read-only, one RLS-scoped transaction) answers the open legacy Telegram tasks by state and pin with the 50 least recently updated, Core requester sends still pending, legacy Delivery workflow runs in flight, the newest legacy task, and `stage2Ready`.
- Existing tasks keep their stored pin and executor (ADR-052). Desk, webhook and WhatsApp tasks are unchanged.

No migration: the pin, publication executor and receipts already exist. Migration 069 was not needed.

**Stage 2 (separate commits; merge only on `stage2Ready: true`).** Delete the Core poller and its rollback machinery, and the Delivery workflow's `reportTo: 'core'` path for non-lifecycle tasks. The finishing readers of the legacy intake cannot be removed cleanly yet, because the lifecycle path still delegates questions, greetings and standing rules to the same route; the written plan is in the map, section 6.

## 3. Consequences

- A chat whose newest request of the last 48 hours is an open legacy one needs `/new` for a new brief until that request is finished or 48 hours pass; everywhere else a plain brief opens a lifecycle request.
- The 111 open legacy tasks will not close on their own. Until the office finishes, rejects or cancels them, stage 2 waits and replies to them keep reaching legacy intake.
- A requester who replies to a finished legacy design, or presses "other size" on it, is asked for `/new` instead of getting a paid revision on the old path.
- Legacy intake's bilingual split (one graphic per language) has no lifecycle equivalent yet: an English-and-Kurdish brief opens one lifecycle request. Not changed here.
- Tests that build legacy tasks through `/webhooks/telegram` outside production keep working until stage 2.

## 4. Acceptance

Red run first, against the unchanged `3f3d71ca` sources with the new tests: 13 of 14 failed (every behaviour in section 1, the endpoint's 404, the backstop and the poller), 1 passed (a replayed event, which was already allowed). Results of the implementation, the updated suites and the chaos run are recorded in section 5.

## 5. Local qualification — 2026-09-28

- New tests: 3 files, 14 passed. Affected files together: 25 files, 321 passed, 2 skipped (the opt-in Core-kill drills for PDF sources and voice, which then passed separately with `HAWA_SOURCE_RECOVERY=1 HAWA_VOICE_RECOVERY=1`: 2 of 2).
- `pnpm run typecheck` (580 strict test roots) and `pnpm run lint` passed.
- Full suite (`HAWA_TEST_WORKERS=3`): 579 files; 4863 passed, 2 failed, 58 skipped. The webhook-registration test expected the 200 that ADR-135 now refuses; it was updated (6 of 6 then). The release-manifest seal test (`r11-release-gate` 1) fails on any source change until the release record is refreshed; RELEASE_MANIFEST.json was not edited.
- Production-shaped data: the newest dump counted on the test server (numbers in section 1); the scratch database was dropped.
- Chaos suite, worker mode, whole suite once (`run.ts --poller worker` at `9aedea64`, taken through the shared `hawa-chaos-lock`; 1091 s, peak 1365 MiB): 41 scenarios, **39 passed, 2 failed**. R1.K14 timed out: its second Deliver press went through the Desk helper, which waits for the request to be `approved`, and the request was already delivering. R1.S2.K5b expected the killed acknowledgement send to be uncertain and saw no office alert. Both expectations were corrected in `b3aceaaa` (the second press goes straight to Core and must start no second Delivery run; the expected alert follows the acknowledgement's own send marks). Targeted re-runs of the corrected scenarios: R1.K14 passed twice; R1.S2.K5b failed once more under the first correction (marks `[attempted, attempted, sent]` with one alert, where the correction expected none) and passed under the second (an attempt without a result expects one alert). In the last re-run R1.K0, which passed in the whole-suite run, ended `DESIGN_PLANNING`: since ADR-135 the acknowledgement and the design start together, so a 5 s Core kill during the acknowledgement can land in the design's planning; the plan stays `planning` and the run gives up after its 30 resume polls. Legacy intake acknowledged before the design started, so this was never exercised before. It is a lifecycle reliability finding, not fixed here, and R1.K0 is flaky until it is.
- An earlier attempt ran the chaos suite from a copy of the tree outside the repository (so stage 2 could be edited meanwhile); its setup hook hung for 30 minutes after starting Postgres, with no process or connection to show where. It is not counted; the run above is from the worktree itself.

Details: `plans/lean-design-implementation-2026-09-28/LEGACY_PATH_RETIREMENT_PROOF.json`. Not executed: a deploy, a live Telegram chat, the load test (`scripts/load/run.ts` now refuses `--poller core` and was not run).

## 6. Stage 2 (merge only on `stage2Ready: true`)

**2a — Core's poller removed.** Core's poll loop and update handler, the `enableTelegramPolling` option, `createPolledUpdateHandler` (the dead-letter helpers stay: the worker's `/park` uses them), "Poll now" and webhook registration with their Desk controls (webhook info and delete stay: delete clears a webhook set outside Hawa, which would stop the worker's getUpdates), and `deploy.sh`'s hold, release and exit note for Core's poller value (ADR-129 finding 1); step 7 starts with `HAWA_TELEGRAM_POLLER=worker` and the ADR-135 refusal stays. Tests of those pieces went with them; the worker poller's tests cover polling, offsets, the kill switch and dead letters. Left in place, with no production caller: the getUpdates machinery of `TelegramBridgeDaemon` in `@hawa/integrations` (entangled with its status and `processUpdate`, and covered by that package's own tests) and `PostgresTelegramPollState.recordFailure`; they can go in a follow-up with those tests.

**2b — the Delivery workflow for tasks RequestLifecycle does not own.** `startWorkflowDelivery`, `recordFinishedRun`, `finishWorkflowDelivery`, `DELIVERY_OWNED_BY_CORE`, the publish route's hand-off to the workflow, `POST /v1/internal/tasks/:taskId/delivery-finished`, the prepare route's legacy branch (now `409 LEGACY_WORKFLOW_DELIVERY_RETIRED`) and the worker's `reportTo: 'core'` report. A non-lifecycle task pinned `restate`, or whose publication the workflow started, is refused by both publish routes (`409 Delivery Workflow Retired`) rather than handed to Core, which would send its files again; a journaled `reportTo: 'core'` input is refused by the worker before any effect. The contract keeps the `'core'` literal so an old journal still parses. Tests: the Core-pinned and refusal cases of `delivery-workflow.test.ts` stay; its end-to-end cases of the removed path are deleted; the worker's `lifecycle-delivery.test.ts` runs every case as a signed request-owned run. Coverage lost with the path and to be ported before 2b merges: the workflow-mode prepare's hold of a credential failure when an earlier upload has a durable Drive reservation (`ARCHIVE_STATE_UNCERTAIN`), which request-owned delivery shares; `lifecycle-office-desk-bridge.test.ts` covers request-owned prepare but not that case.

**Stage 2 local qualification — 2026-09-28.** 2a: the 20 directly affected files plus the Desk tests, 68 files, 556 passed; deploy.sh tests 4 files, 36 passed. 2b: 12 affected files, 100 passed after one assertion was widened (the request owner's report route answers a bad body with 400, the removed route with 422). `pnpm run typecheck` (579 strict test roots) and `pnpm run lint` passed. Full suite on the stage 2 head (source identical to the final stage 2 commits; the later rebase moved only documentation and the chaos corrections under them): 578 files; 4830 passed, 1 failed, 58 skipped; the failure is the release-manifest seal (`r11-release-gate` 1), as in stage 1. The chaos suite was not re-run on stage 2: its scenarios reach neither Core's poller nor the non-lifecycle Delivery path.

## 7. Reconciled with ADR-136 on the mainline — 2026-09-29

This ADR was written from `3f3d71ca`; ADR-136, deployed meanwhile, fixed the same cutover from the
other side. Stage 1 was merged on top of it, keeping one implementation of each rule they share:

- **Which updates belong to an old request.** ADR-136's reading (`legacyOwnedUpdate`, now in
  `apps/core/src/services/legacy-telegram-routing.ts`) replaced this ADR's `taskIdNamedByReply` and
  `isLegacyTaskOfChat`: a button; a reply naming a legacy task; a reply to a message the outbox sent for
  one (a delivered file); any reply in a chat with legacy tasks and no lifecycle request (a change
  prompt or clarification question that names no task). Its tests and the chaos scenario `R10.H1`
  cover the last two, which this ADR's reading refused as stale replies. It runs before the lifecycle
  routing, as in ADR-136, and hands the update to the finish-only scope of this ADR. "Legacy" is read
  as here: no request owner, whatever the pin.
- **The 48-hour window.** This ADR's `newestRecentRequestIsOpenLegacy` replaced ADR-136's "a Core task
  created in the last 48 hours" check, which sent such a brief to legacy intake to start a new Core task.
- **Rollback.** ADR-136's Core-poller forwarding to `ChatInbox` was removed with Core's poller; the
  rollback is the previous worker colour or the previous release (section 2). ADR-136 is marked partly
  superseded.
- Tests: ADR-136's six intake cases keep passing with two conscious changes (its Core requests are now
  written as legacy intake wrote them, since no path creates one any more; the brief next to a recent
  Core design and the reply to a delivered file now expect the finish-only answers); its three poller
  cases were removed with the poller. Details and results:
  `plans/lean-design-implementation-2026-09-28/RECONCILIATION_PROOF.json`.
- Section 3's bilingual gap is closed by ADR-139; the R1.K0 finding in section 5 by ADR-138.

## 8. Stage 2 rebased onto the reconciled mainline — 2026-09-29

The three stage 2 commits (`300d4d67`, `b74a5df3`, `dee299e6`) were rebased onto the reconciled stage 1
(ADR-136 kept where section 7 says, ADR-138 and ADR-139 on top) as branch `legacy-retirement-stage2`,
still not merged: it waits for `stage2Ready: true`. The case 2b named as lost is ported to the request-owned
path: `lifecycle-office-desk-bridge.test.ts`, "holds a credential failure when an earlier Drive upload of
this request is still reserved" (503 `ARCHIVE_STATE_UNCERTAIN`, the task held in `publishing` and shown as
`ARCHIVE_RECONCILIATION`, no requester send, and a failed report of the run keeps it so). It fails when the
reservation check in `omnichannel-delivery.ts` `failBeforeDrive` is removed.

## 9. Stage 2 completed on the combined release — 2026-09-29

The owner closed every open legacy task; production answered `GET /v1/operations/legacy-path` with 0 open legacy Telegram tasks, 0 pending or failed Core requester sends, 0 legacy Delivery runs and `stage2Ready: true`. Stage 2 was then finished on top of the combined release `73b75f44` (ADR-140, ADR-141, the Desk audit release):

- **2a and 2b** were cherry-picked unchanged (only the pack manifest conflicted, and was regenerated), with the ported Drive-reservation test of section 8. ADR-140's behaviour is kept: a thanks or receipt with no waiting request opens no request and is thanked back, now by the lifecycle's own answer.
- **2c, the old intake's finishing readers.** The answers the lifecycle path still needed were moved first, into `apps/core/src/services/lifecycle-chat-answers.ts`: greetings, questions and thanks (ADR-140's words), a standing rule said in chat (saved for the chat's client with `telegram-rules-intake.ts`), `/status`, `/rules`, `/forget`, `/start`, `/help`, a chat `/approve`, `/publish`, `/revise` or `/reject` ("Designs are approved in Hawa Desk"), `/redo`, an edited message, a group "/task …" (asks for `/new`) and a group message that is not a brief (kept, unanswered). Each answer is recorded once per update (`inbox_events`, `<chat>:<update>`, kind `telegram_chat_answer`) and given again word for word when the worker asks again; ChatInbox sends it under `chatinbox:chat-answer:<update>` (new `lifecycleAction: 'chat-answer'`), so Core's bridge sends none of them. Then: every button press is a stale reply with a receipt (only the old intake's messages carried buttons; the spinner is stopped once through the bridge), a reply to an old-intake message is a stale reply through the lifecycle's own routing, and an unlinked brief beside an old request opens a lifecycle request (the 48-hour window is gone). Deleted: the route `/webhooks/telegram` and its readers (`telegram-intake/{media,callbacks-and-commands,replies,changes,requester-actions,questions}.ts`), `legacy-telegram-routing.ts`, `legacy-telegram-scope.ts` and the `persistChatIntake` backstop, the in-chat approve publishing (it was already unreachable: the route refused every non-requester button and `/approve` before reaching it), the brand-guidelines PDF reader and the reference/album finders only the readers used, the dead requester composers, the unanswered-draft reminders (they reminded only old-intake tasks, with the buttons that now do nothing) and the Telegram webhook secret's `adapter` principal on `/api/webhooks/*` (the secret is never a credential now).
- **2d, Core's requester sends.** Core's own delivery writes no `notify.published` (both sites), `coreQueuedFiles` is gone, and a Drive failure before upload returns the task to approved with the failure (no chat-only send, no `202 DELIVERED_TO_CHAT_ONLY`). A task that came from a Telegram chat without a request owner is refused before any effect (`409 LEGACY_TELEGRAM_DELIVERY_RETIRED`) instead of being archived with its requester never told. The worker's sender and `deliveredByWorkflow` are replaced by a stub that ends an old command at once as `REQUESTER_SEND_RETIRED`, sending nothing (a redrive from the Desk cannot send stale files).
- **What stays** (the map's class c): TaskWorkflow and the outbox's `task.created` dispatch, `runCanvaDraft`, Core's Drive/Sheets delivery for Desk, WhatsApp and webhook tasks, `persistChatIntake`, `prepareChatCampaignDraft`, the classifier, `parkTelegramUpdate`, the pin column and every old row (readable in the Desk; the publication report still reads old `notify.published` rows). `GET /v1/operations/legacy-path` stays as a standing check that the old path is empty.
- **Chaos.** `R10.H1` (old requests made on a Core-polling release, continued after the deploy) was removed: there is nothing left to continue, and the stale-reply answers are unit-tested. `R10.K1` and `R10.K2` stay (rolling back to the previous release); R10 now starts on this release. They were not run here.
- Beyond the written plan, and why: the reminders, the webhook-secret principal, the guidelines PDF reader and the Telegram delivery refusal are all things that only the old path used or needed; leaving them would have kept buttons, a credential and a send path with nothing behind them. No schema change and no migration: the tables and old rows stay for history.

Known and not changed here (found while doing this): while a lifecycle request waits for the requester, any unlinked message is taken as its revision, commands included (`/status` becomes a revision directive); and a group message that the heuristics read as a brief opens a lifecycle request (the old intake kept group chatter as passive messages). Both predate stage 2.

**Qualification, 2026-09-29** (worktree of `73b75f44`, commits `58caa3ae`, `ea580ddd`, `eb1cea3e`, `62e68e73` for 2a/2b and the ported test, `bbf73fce` for 2c, `02a36732` for 2d, `57235e73` for the chaos change):

- 2a and 2b after the cherry-pick: their 23 test files, 290 passed.
- 2c and 2d: the 56 affected test files together (`HAWA_TEST_WORKERS=3`), 495 passed, 5 skipped. That run first failed 3 ADR-140 thanks cases: the answer's own `kind` field overwrote the intake envelope's `kind: 'handled'`; renamed (`inquiry`) and re-run, 77 of 77 in that file. New tests: the moved answers (greetings, questions, `/start`, `/help`, unknown commands, `/approve` family, `/status`, a rule saved, listed and forgotten once, a rule without a client, an edited message, group chatter and a group `/task`, button presses whatever their data) with their word-for-word replay; the stale-reply answers to old-intake replies and buttons (and a waiting lifecycle request untouched); the route's 404 under every prefix; ChatInbox's `chat-answer` notice (once per update after a crash, parse mode kept, malformed answers refused); the Telegram delivery refusal; the retired `notify.published` command.
- `pnpm run typecheck` (582 strict test roots) and `pnpm run lint` passed.
- Full suite (`HAWA_TEST_WORKERS=3`): 581 files; 4870 passed, 1 failed, 57 skipped. The failure is the release-manifest seal (`r11-release-gate` 1), as before: RELEASE_MANIFEST.json was not edited.
- Chaos suite, worker mode, whole suite once (`run.ts --poller worker` at `57235e73`, through `hawa-chaos-lock`, torn down after): 44 scenarios passed, 645 invariants, 0 failed, 936 s, sampled peak 1154 MiB. `R10.K1` and `R10.K2` were not selected (they run alone and need the previous release built); not run.
- Not executed: a deploy, live Telegram, the R10 rollback scenarios, the load test.
