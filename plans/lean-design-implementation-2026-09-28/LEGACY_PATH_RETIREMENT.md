# Retiring the old Telegram request path

Date: 2026-09-28. Source: `codex/research-grade-design-system` at `3f3d71ca`.
Owner decision (2026-09-28): "put everything on the new path, we don't need any other path, let's
perfect this path." Production runs `HAWA_TELEGRAM_POLLER=worker` and `HAWA_LIFECYCLE_CHATS=*`.
Decision record: `adrs/135_lifecycle_only_telegram_requests.md` (ADR-135).

"New path" means: worker poller -> Restate `ChatInbox` -> Core `POST /v1/internal/telegram/intake`
-> `RequestLifecycle` / `DesignRun` / `Delivery` (`reportTo: 'lifecycle'`). A task on it has
`tasks.request_id` set and `delivery_executor_pin = 'restate'`.

"Old path" means every way a Telegram request is created or finished outside `RequestLifecycle`:
Core's legacy Telegram intake (`/webhooks/telegram`), the Core poller that feeds it, Core's own
delivery with the worker's `notify.published` sender, and the Delivery workflow in `reportTo: 'core'`
mode for non-lifecycle tasks.

Classes used below:

- **(a)** needed only to create NEW legacy requests; dead once every chat is lifecycle-owned.
- **(b)** needed only to FINISH Telegram tasks already on the old path; dead once none is open.
- **(c)** shared with things that stay: Desk-created tasks (no chat, never enrolled,
  `lifecycleOwnsChat` in `packages/contracts/src/lifecycle-delivery.ts`), manual/Desk design runs,
  webhook/unified-ingress tasks, WhatsApp (WAHA) intake, and the lifecycle path itself.
- **(d)** the Core Telegram poller (`HAWA_TELEGRAM_POLLER=core`) and its rollback role.

## 1. What production does today (found while mapping)

These are behaviours of the code at `3f3d71ca` with `HAWA_LIFECYCLE_CHATS=*`. Each has a failing
test written before the fix (ADR-135, "Red run").

1. **New legacy requests are still created.** In a chat that has ever had a Core-pinned Telegram
   task, an ordinary brief without `/new` falls through to legacy intake and becomes a new
   Core-pinned task (`hasLegacyTask`, `apps/core/src/routes/lifecycle-internal.routes.ts:481-491`).
   Every chat that used the bot before the switch is such a chat. Questions, greetings, standing
   rules and anything legacy intake's own classifier reads as a brief also reach the legacy
   "new request" stage (`apps/core/src/routes/telegram-webhook.routes.ts:185-276`) through the
   final fall-through (`lifecycle-internal.routes.ts:609-626`).
2. **Replies to a legacy draft are refused.** A reply to an open legacy task's draft has no
   lifecycle message link, so it is answered `STALE_REQUEST_REPLY`
   (`lifecycle-internal.routes.ts:461-462`) and never reaches legacy intake. Since the switch a
   requester cannot change an open legacy design by replying to it, contrary to ADR-059 ("existing
   core-owned tasks remain on legacy intake").
3. **A legacy draft button can become a lifecycle revision.** A callback query's data is read as
   the message text (`lifecycle-internal.routes.ts:363-366`). In a chat with exactly one lifecycle
   request waiting for changes, `chooseWaitingChatRequest` picks it and the button data
   (`rq:ok:<uuid>` etc.) is projected as a requester revision directive (`:526-589`).
4. **The lifecycle open has no bilingual split.** Legacy intake made one request per language for
   an English-and-Kurdish brief (`splitBilingualRequest`, `telegram-webhook.routes.ts:234-256`); the
   lifecycle open (`lifecycle-internal.routes.ts:492-523`) makes one. Not fixed here (out of scope;
   see ADR-135 "Not done").
   Fixed on the mainline on 2026-09-29 by ADR-139.

## 2. Production data (newest dump, no production SQL)

`infra/backup/snapshots/predeploy_20260928T175243Z.dump` (sha256 verified against its `.sha256`),
restored into scratch database `scratch_retire_0928` on hawa-test-postgres (127.0.0.1:55432) and
dropped afterwards. Schema at migration 067.

| Measure | Value |
| --- | --- |
| Tasks pinned `restate` | 0 |
| `hawa.lifecycle_projections` rows | 0 |
| Tasks pinned `core` | 1,613 |
| Open (state not `complete`/`rejected`/`cancelled`) Telegram tasks, all `core`, `request_id` null | **111** in 15 chats: 97 `received`, 12 `human_review`, 1 `paused`, 1 `failed_operator` |
| Of those, not updated for 4 days or more | 110 |
| Newest legacy Telegram task | created 2026-09-28 16:33Z (`failed_operator`) |
| Publications | 47, all `executor = 'core'`, all `complete` |
| Open tasks with no chat (no `sourcePlatform`; Desk-shaped, mostly `Pilot Task …` test fixtures written to production before 2026-09-18) | 1,455; class (c), not part of the gate |

So stage 2 is gated on **111** open legacy Telegram tasks, almost all stale `received` rows that
will not move on their own: an office member has to finish, reject or cancel them in the Desk.

## 3. The map

Line numbers are at `3f3d71ca`.

### 3.1 Intake: creating and routing requests

| Item | Where | Class | Depends on it | Tests |
| --- | --- | --- | --- | --- |
| `HAWA_LIFECYCLE_CHATS` / `lifecycleOwnsChat` | `packages/contracts/src/lifecycle-delivery.ts:18-25`; read at `lifecycle-internal.routes.ts:231,324,439,461,466`, `lifecycle-source-intake.ts:58` | (a) | the enrolment decision of every Telegram update; the chaos compose list | `lifecycle-internal-intake.test.ts` (22 `stubEnv` sites), `lifecycle-source.test.ts`, `lifecycle-album.test.ts`, `lifecycle-voice*.test.ts`, `chat-intake-flag-scoping.test.ts` |
| Intake `mode: 'legacy'` | `lifecycle-internal.routes.ts:179-182`; worker default `apps/worker/src/lifecycle/chat-inbox.ts:118-122` (only `lifecycle` sticks, `:244-245`) | (a) as a routing switch; the wire value stays for a draining worker colour | ChatInbox's first update of every chat | `chat-inbox.test.ts:111,198-265,467` |
| `hasLegacyTask` guard | `lifecycle-internal.routes.ts:481-491` | (a) (finding 1) | new briefs in every pre-switch chat | `lifecycle-internal-intake.test.ts:559` |
| Legacy "new request" stage: instruction-only, bilingual, single request | `telegram-webhook.routes.ts:185-276` | (a) | the fall-through at `lifecycle-internal.routes.ts:609-626`; the Core poller (`app.ts:1090`); a registered webhook | ~30 Core test files build legacy tasks through it (list in §5) |
| Legacy readers before that stage: `readMedia`, `handleCommand`, `readReply`, `makeChange`, `handleRequesterAction`, `handleCallbackQuery` | `apps/core/src/services/telegram-intake/{media,callbacks-and-commands,replies,changes,requester-actions,questions}.ts` | (b), plus (c) for the answers to questions, greetings and standing rules, which the lifecycle path still delegates (`lifecycle-internal.routes.ts:473-474`) | replies/buttons on legacy drafts; question/greeting answers in every chat | `telegram-requester-loop`, `requester-buttons`, `other-sizes`, `clarifying-questions`, `question-followups*`, `feedback-revision-messages`, `feedback-font-request`, `early/late-reference-image`, `album-settle`, `telegram-understanding`, `client-rules`, `telegram-unknown-task` |
| `telegram-intake/update-state.ts` (`telegramUpdateHandled`, `replyDesign`, …) | `:24-147` | (c) | legacy route, `lifecycle-internal.routes.ts:235,395`, `lifecycle-source-intake.ts:62` (the "old receipt wins" dedup) | via the above |
| `chat-campaign-intake.ts` (`prepareChatCampaignDraft`, `ingestChatCampaignTask`) | `:533,539` | (c) | lifecycle open `:493`; WhatsApp `whatsapp.routes.ts:81`; legacy route | `intake-client-routing`, `intake-unicode-routing`, `kurdish-intake-no-invented-copy`, `intake-long-invitation`, `chat-intake-durability` |
| `persistChatIntake` pin rule (legacy fallback stays `core`; predecessor pin inheritance) | `apps/core/src/services/chat-intake.ts:279-311` | (c) (WhatsApp and every legacy round use it); the `restate` inheritance branch for non-lifecycle rounds is (b) | lifecycle projection (`lifecycle-projection.ts:287,843`), legacy intake, WhatsApp | `chat-intake-flag-scoping.test.ts:111-180` |
| `telegram-classifier.ts` | `classifyWithHeuristics:197`, `classifyInboundTelegramMessage:392` | (c) | lifecycle open `:469`, legacy | `telegram-classifier*.test.ts` |
| Standing rules by chat | `telegram-rules-intake.ts`, `standing-rules-chat.ts` | (c) while the lifecycle path delegates rule sentences to legacy intake | legacy `readReply` | `client-rules`, `standing-rules-chat` |
| WhatsApp / WAHA | `apps/core/src/routes/whatsapp.routes.ts:36,102,204,398` | (c) | own webhook; Core delivery | `chat-two-way-approval`, `control-semantics` |

### 3.2 Design execution

| Item | Where | Class | Depends on it | Tests |
| --- | --- | --- | --- | --- |
| TaskWorkflow / TaskService, dispatcher, `task.created`/`task.dispatch` handlers | `apps/worker/src/workflow.ts:76-120`, `index.ts:101-127,143-150`, `workflow-dispatcher.ts:48-188`, `outbox-consumer.ts:452-476` | (c): the only automatic-design executor for every task without `request_id` (Desk, webhook, WhatsApp, redrive) | Core `restate-probe.ts:12`; `services.ts:10` names must stay bound | `workflow`, `canva-draft-*`, `durable-workflow-recovery`, `lifecycle-ownership-fence` |
| `runCanvaDraft` | `apps/worker/src/canva-draft-workflow.ts:288` | (c): DesignRun calls it (`lifecycle/design-run.ts:36-38`) | both executors | `canva-draft-*`, `request-lifecycle-design` |
| Core outcome reporting for non-lifecycle runs (`reportOutcome`, `outcome-without-core.ts`, `task.outcome`) | `canva-draft-workflow.ts:176-187,270-281,376-382`; `outcome-without-core.ts:43-111`; `outbox-consumer.ts:513-536` | (c) (Desk and webhook tasks) | TaskWorkflow | `canva-outcome-without-core`, `canva-status-contract` |

### 3.3 Delivery

| Item | Where | Class | Depends on it | Tests |
| --- | --- | --- | --- | --- |
| Core direct publisher (`executeOmnichannelPublish` / `deliverOmnichannel`, Drive + Sheets) | `apps/core/src/services/omnichannel-delivery.ts:335-1139` | (c) (Desk, WhatsApp, webhook tasks) | `delivery.routes.ts:270-324,555-637`, `whatsapp.routes.ts:265` | `verified-delivery-drive-sheets`, `pinned-delivery`, `publish-sheets-unconfirmed`, `r06-publication-safety`, `delivery-without-drive`, … |
| `notify.published` enqueue (requester files to a Telegram chat) | `omnichannel-delivery.ts:747-767,1035-1045` | (b): only Telegram tasks have a requester chat (`resolveRequesterChat`, `:949-970`) | worker sender below | `delivery-notification`, `r07-outbox-terminal-state` |
| Worker `notify.published` sender and `deliveredByWorkflow` fence | `apps/worker/src/outbox-consumer.ts:306-314,322-328,545-660` | (b); a command can still be pending after its task is `complete` | Core enqueue | `outbox-delivery-notice`, `outbox-send-receipt`, `outbox-delivery-uncertain`, `outbox-claims`, `chaos-points` |
| Legacy Delivery workflow (`startWorkflowDelivery`, `recordFinishedRun`, `finishWorkflowDelivery`, `DELIVERY_OWNED_BY_*`, restate block of the publish route, `delivery-finished` route, prepare route's `requestId === taskId` branch, worker `reportTo: 'core'`) | `omnichannel-delivery.ts:1185-1465`; `delivery.routes.ts:216-268`; `delivery-internal.routes.ts:63-66,86-111`; `apps/worker/src/lifecycle/delivery.ts:109,202-217` | (b), for non-lifecycle tasks pinned `restate` (0 in production) | `deliveryExecutorOfTask` (`:308-322`) | `delivery-workflow.test.ts:261-560`, `apps/worker/test/lifecycle-delivery.test.ts` (default `reportTo: 'core'`) |
| Telegram in-chat approve (`rq:ok`, `/approve`) publishing a legacy task | `telegram-intake/callbacks-and-commands.ts:100,247` | (b) | legacy buttons | `requester-buttons`, `telegram-unknown-task` |
| `reopenInterruptedDelivery` | `omnichannel-delivery.ts:1147-1171` | (c) apart from its `restate` check (b) | Core publish routes | `delivery-restart.test.ts` |
| Request-owned Desk delivery, prepare route, `reportTo: 'lifecycle'` | `delivery.routes.ts:91-193`; `delivery-internal.routes.ts:46-84`; `lifecycle/delivery.ts` | stays (new path) | — | `lifecycle-office-desk-bridge`, `lifecycle-delivery` |
| Pin column and immutability trigger | `packages/db/migrations/031_task_delivery_executor_pin.sql`; `publications.executor` `022` | stays (history); no migration needed | all of the above | `schema-upgrade.test.ts` |

### 3.4 The Core poller and its rollback role (d)

| Item | Where | Depends on it | Tests |
| --- | --- | --- | --- |
| Selector `telegramPollerOf` | `apps/core/src/services/telegram-poller-owner.ts:13`; `entrypoint-options.ts:18` (`enableTelegramPolling`) | Core's poll loop, `/v1/health.telegramPoller`, status route, "Poll now", the watchdog | `production-entrypoint`, `telegram-poller-owner-health`, `lifecycle-internal-intake.test.ts:1207-1230` |
| Poll loop | `apps/core/src/app.ts:1075-1135` (handler `app.request('/api/webhooks/telegram?generate=true')` at `:1090`); bridge `packages/integrations/src/telegram-bridge.ts:272-571`; `polled-update-dispatch.ts` `createPolledUpdateHandler` (the file's `parkTelegramUpdate` is (c)) | legacy intake only; it has no lifecycle routing | `telegram-safety:108-215`, `channel-kill-switch-persistence`, `polled-update-dispatch`, `telegram-polling-waits-for-client-dna`, `request-log-context:146`, `packages/integrations/test/telegram-poller-safety` |
| "Poll now" | `apps/core/src/routes/system.routes.ts:111-132`; Desk `apps/desk/src/api/client.ts:365`, `screens/SettingsScreen.tsx:82-95,192-198` | — | `auth-negative-controls:157,227`, `channel-kill-switch-persistence` |
| Webhook registration (points Telegram at the legacy route) | `system.routes.ts:137-…`; Desk Settings `:42,270` | — | `telegram-first-class-adapter` |
| Deploy hold/release of Core's poller value | `infra/docker/deploy.sh:75-128,467-477,565,580-581` | ADR-129 | `packages/testkit/test/deploy-sh-operations-findings.test.ts:55-160` |
| Watchdog | `infra/ops/watchdog.sh:36-55,165-187` (alerts only when Core names `worker`) | — | `packages/testkit/test/watchdog-telegram-poller.test.ts` |
| Documented rollback | `infra/docker/README.md:98-146` ("Roll back: set it to `core`"); ADR-129 (`:94-104`); `runbooks/20_architecture_operations.md:207-235` (and its warning that a rollback stops lifecycle requests and was never drilled on this branch); compose defaults `infra/docker/docker-compose.prod.yml:24,126`; `infra/docker/.env.example:15` | — | `scripts/load/test/runbook.test.ts` |

The Core poller only ever feeds legacy intake. A rollback to it therefore means "new requests on the
old path", which the owner has ruled out. ADR-135 retires it as a rollback in stage 1 (Core no longer
polls whatever the variable says; `deploy.sh` refuses `core`), and stage 2 deletes its code. The
rollback for a broken worker poller is the previous worker colour (ADR-129 blue/green) or the
previous release.

### 3.5 Chaos suite (`packages/testkit/chaos`)

| Scenarios | Path at `3f3d71ca` | Stage 1 |
| --- | --- | --- |
| R1.0, R1.K0-K15, R1.D1 (`chaos.test.ts:182-387`) | unenrolled chat: legacy intake, TaskWorkflow, Core delivery + `notify.published` | every chat is lifecycle; each is re-pointed at the lifecycle equivalent of its fault (table in ADR-135) |
| R1.W0, R1.S1.K1-K3, R1.S2.K4/K5/K5b, R1.DUP (`:389-470`) | ChatInbox, then legacy intake | same scripts; the brief now opens a lifecycle request |
| R4 (`:920`) | legacy intake in two chats | same script through the lifecycle path |
| R1.S3.*, L2.* (`:476-918`) | lifecycle | unchanged apart from chat allocation |
| `--poller core`, `HAWA_LIFECYCLE_CHATS` list, `flaggedChat()` (`run.ts:32-47`, `docker-compose.chaos.yml:29-32,65-68`, `chaos.test.ts:31-33,54-61,86-87`) | two modes | worker only |

## 4. Knowing when stage 2 may merge, without production SQL

Nothing existed that counts tasks by executor. Stage 1 adds `GET /v1/operations/legacy-path`
(administrator only, read-only, one RLS-scoped transaction), which answers:

- `openTasks`: open Telegram tasks without a request owner, with `byState`, `byPin`, `chats`, the
  oldest `updatedAt` and up to 50 `{id, state, pin, createdAt, updatedAt}` rows to act on in the Desk;
- `pendingRequesterSends`: `notify.published` commands not yet `delivered` or `failed`;
- `legacyWorkflowDeliveriesRunning`: non-lifecycle publications with `executor_run > executor_finished_run`;
- `newestLegacyTaskCreatedAt`: proves no new legacy task appears after stage 1 is deployed;
- `stage2Ready`: all three counts are zero.

The lead reads it with an administrator session (or the Desk) — `curl -H 'Authorization: Bearer …'
https://<desk>/api/v1/operations/legacy-path` — and merges stage 2 only on `stage2Ready: true`.
Against the dump above it answers 111 open tasks, 0 pending sends, 0 running legacy workflows.

## 5. Tests that build legacy tasks through `/webhooks/telegram`

Stage 1 keeps the legacy route's new-request stage for callers outside production that do not set
the finish-only scope, so these files keep building legacy fixtures; production can no longer
reach it (ADR-135). Stage 2 moves or deletes them with the stage.
`chat-two-way-approval` (skipped), `core`, `voice-ingress-and-webhook`, `chat-intake-durability`,
`telegram-first-class-adapter`, `h11-governed-learning-scope`, `auth-negative-controls`,
`verified-delivery-drive-sheets`, `track-b-gates`, `telegram-unknown-task`, `telegram-understanding`,
`telegram-safety`, `telegram-requester-loop`, `telegram-paid-guards`, `telegram-intake-edges`,
`split-g9-telegram-intake`, `requester-buttons`, `request-remarks`, `request-log-context`,
`r07-outbox-terminal-state`, `question-followups`, `question-followups-review`, `pinned-delivery`,
`other-sizes`, `kurdish-intake-no-invented-copy`, `intake-unicode-routing`, `intake-long-invitation`,
`intake-client-routing`, `human-approval-binding`, `gate-f-review-invalidation`,
`feedback-revision-messages`, `feedback-font-request`, `early-reference-image`,
`delivery-notification`, `client-pack-intake`, `clarifying-questions`,
`channel-kill-switch-persistence` (all under `apps/core/test/`), plus
`apps/desk/test/status-honesty.test.ts`, `packages/integrations/test/telegram-live-ingress.test.ts`
and `packages/testkit/test/nginx-internal-boundary.test.ts`.

## 6. Stage 2: what is deleted, and when

Stage 2 merges only when `GET /v1/operations/legacy-path` answers `stage2Ready: true` on production
(no open legacy Telegram task, no Core requester send pending, no legacy Delivery run in flight).
Until then every piece below still finishes real requests. The office has to finish, reject or cancel
the 111 open legacy tasks first; almost all are stale `received` rows.

Separate commits on the same branch, after stage 1:

- **2a, the Core poller (d).** Core's poll loop and its update handler (`app.ts`), the
  `enableTelegramPolling` option, `createPolledUpdateHandler` (the dead-letter helpers
  `parkTelegramUpdate`/`PARKED_UPDATE_NOTICE`, which the worker's `/park` uses, stay), the "Poll now"
  and webhook-registration routes and their Desk controls, the bridge's getUpdates machinery in
  `@hawa/integrations`, `PostgresTelegramPollState.recordFailure`, and `deploy.sh`'s hold, release and
  exit-note functions for Core's poller value (the ADR-135 refusal stays). Tests of those pieces go
  with them; the worker poller's own tests cover polling, offsets, kill switch and dead letters.
  Strictly this commit does not depend on the gate (Core has not polled since stage 1); it is kept
  in stage 2 so a stage 1 deploy can still be compared against a Core that has the code.
- **2b, the Delivery workflow for non-lifecycle tasks (b).** `startWorkflowDelivery`,
  `recordFinishedRun`, `finishWorkflowDelivery`, `DELIVERY_OWNED_BY_CORE`, the publish route's
  restate block, `POST /v1/internal/tasks/:id/delivery-finished`, the prepare route's
  `requestId === taskId` branch and the worker's `reportTo: 'core'` branch. A non-lifecycle task can
  then only be delivered by Core; one pinned `restate` (none exists in production, and the gate
  counts any open one) is refused. One test lost with it must be ported before 2b merges: the
  workflow-mode prepare's hold on a durable Drive reservation (ADR-135 section 6). Tests: `apps/core/test/delivery-workflow.test.ts` keeps
  the Core-pinned cases and the refusal; `apps/worker/test/lifecycle-delivery.test.ts` runs its cases
  with `reportTo: 'lifecycle'`.

Not cleanly separable, therefore a written plan only:

- **2c, the legacy intake's finishing readers (b).** `telegram-intake/{changes,requester-actions,questions,media}.ts`,
  most of `replies.ts`, the route's new-request stage, `legacy-telegram-routing.ts`, the finish-only
  scope and the `persistChatIntake` backstop. They share one route with what the lifecycle path still
  delegates to it: the answers to greetings and questions, standing rules said in chat
  (`telegram-rules-intake.ts`, `standing-rules-chat.ts`), the "Designs are approved in Hawa Desk" answer
  to `/approve` and to office buttons, edited-message and group-chat handling. Order: (1) move those
  answers into a small lifecycle-side module called from `lifecycle-internal.routes.ts` where it now
  calls `legacyFinish`, answering through ChatInbox notices instead of the Core bridge; (2) route
  callbacks and replies naming a legacy task to `STALE_REQUEST_REPLY`/`new-brief-required`;
  (3) delete the readers, the route's Telegram task creation (WhatsApp keeps `ingestChatCampaignTask`),
  and the ~30 Core test files that build legacy tasks through `/webhooks/telegram` (section 5), moving
  what they prove about copy extraction and client routing onto `prepareChatCampaignDraft`, which the
  lifecycle open uses. The bilingual split (one graphic per language) was ported to the lifecycle
  open on 2026-09-29 (ADR-139), so step 3 no longer loses it.
- **2d, Core's requester sends for legacy tasks (b).** The `notify.published` enqueue in
  `deliverOmnichannel` (both sites), `coreQueuedFiles`, the worker's `notify.published` handler and
  `deliveredByWorkflow`, and the Telegram in-chat approve (`rq:ok`, `/approve`) publishing. Once no
  legacy Telegram task is open, `resolveRequesterChat` finds no chat for any task Core delivers (Desk,
  WhatsApp and webhook tasks have none), so the enqueue is dead; but it sits inside Core's shared
  publish transaction and the chat-only fallback of `failBeforeDrive`, and six worker outbox test files
  exercise it, so it goes after 2c with its own review. A `notify.published` command that ended
  `failed` cannot be redriven afterwards (the endpoint reports `failedRequesterSends`).

What stays after all of stage 2: TaskWorkflow and the outbox's `task.created` dispatch (WhatsApp,
webhook and redriven tasks), `runCanvaDraft` (DesignRun uses it), Core's own Drive/Sheets delivery for
Desk and WhatsApp tasks, the pin column (history), `parkTelegramUpdate`, the classifier,
`prepareChatCampaignDraft` and `persistChatIntake`.
