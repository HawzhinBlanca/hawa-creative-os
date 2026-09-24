# Plan for splitting `apps/core/src/app.ts` (programme item 1.3)

I read everything at `/Users/hawzhin/Hawdesign` (branch studio-v2, commit 79b70e0) and changed nothing. Line numbers below are for that commit. A route's line is the line of its `registerRoute(` call. The comment lines just above a route belong to the same block. There is always one blank line above each block.

## 0. Main findings

- **Size.** app.ts is 11,307 lines. `createApp` runs from line 528 to line 11307. It registers 94 routes through `registerRoute`, and each one is mounted four times (`/v1`, `/api/v1`, `/api`, and the bare path).
- **Most helpers only need Postgres.** About 70% of the helpers need nothing but `db` and repositories. Only seven closures really hold shared state:
  - `resolveTaskWithFallback` / `readCurrentTask`
  - `resolveClientDna`
  - the delivery block (`executeOmnichannelPublish` and its helpers, plus `deliveriesInFlight`)
  - `LIVE_RUN` / `pendingChangeOf`
  - `redriveTask`
  - `ingestChatCampaignTask`
  - `enqueueOfficeAlert` / `askHistory`

  Moving the first four out before anything else is enough to let groups 1 to 8 run in parallel.
- **The ordering problem is small.** Only 13 overlapping route patterns exist. Eleven of them come from the `POST /tasks/:taskId/:control` catch-all. If the foundation step replaces that catch-all with four explicit paths, registration order stops mattering, apart from `diff` coming before `:revisionId`.
- **Three groups are too big for one module.** Telegram intake is about 2,100 lines, tasks and Desk about 1,170, and revisions and decisions about 1,000. The rule is no route module over 800 lines, so these three are split into sub-modules.
- **The `any` ratchet will bite parallel PRs.** The ceiling is 1053 and I counted 1044 today (392 of them in app.ts). That leaves about 9 of headroom across all parallel PRs together. Every group PR must add no net `any`.
- **More dead code than the plan lists.** Beyond the plan's list:
  - `recordPaidModelBillingError` (1560) is never called.
  - `studio` (654) is only an alias and is never read.
  - `interface LocalClientDnaSnapshot` (717) is unused.
  - `canvaBindingRepo` and `ingressRepo` are in the route context but no module reads them.
  - `POST /messages/:messageId/promote` has no caller anywhere and no test.
- **Two latent bugs found along the way:**
  - `channelKillSwitches` (257) lives at module level, so every `createApp()` in one process shares it. It is also lost on restart.
  - `index.ts:48` never awaits `clientDnaHydrated`, so production serves the DNA fixtures until hydration finishes.

---

## 1. Inventory of `createApp`'s closure

"Kind" means one of three things:
- **S**: a service or singleton instance.
- **T**: truth-holding in-memory state (a Map, Set or `let`).
- **H**: a helper function, where the table says whether it is pure or needs state.

Route references are shown as method, path and line.

### 1a. Services, repositories and configuration (lines 529–731)

| Name | Line | Kind | Used by |
|---|---|---|---|
| `app`, `currentEnv`, `isProduction` | 529–531 | config | `isProduction`: health 1710, `ingestChatCampaignTask`, `findApprovalForDelivery`, Telegram 4217, POST /webhooks/whatsapp 5871, GET /tasks 6226, POST /tasks 6359, POST decisions 8408, hydration 11294 |
| `db` | 532 | S | nearly everything |
| `taskRepo` | 539 | S | reader 1870, redrive, delivery, `reopenInterruptedDelivery`, Telegram, POST /ingress/promote 6117, POST /tasks 6359, GET /tasks/:taskId 6556, GET timeline 6758, POST route 6846, POST briefs 6935, POST generate 7037, POST canva-binding 7724, `canvaStatusHandler`, GET editor-url 8106, POST :control 8190, POST decisions 8408, POST revisions 8956, `handleActionCallback` |
| `clientRepo` | 540 | S | clients.routes.ts, POST dna 9336, GET/POST snapshots 9467/9515, candidate promote 10100, candidate rollback 10287, dna/rollback 10520 |
| `ingressRepo`, `canvaBindingRepo` | 541, 544 | S | only `ingressPersistence` and the route context; no route uses them |
| `outboxRepo` | 542 | S | redrive, delivery, `enqueueOfficeAlert`, outbox routes 7407/7488/7573/7597, publication-state 7624, `canvaStatusHandler`, draft reminders 11213 |
| `revisionRepo` | 543 | S | redrive, POST generate 7037, `canvaStatusHandler`, POST decisions 8408, POST revisions 8956 |
| `canvaConnectService` | 545 | S | `deliverableStore`, redrive, GET export-package 8137, sweeper 11227 |
| `deliverableStore` | 546 | S | delivery, POST decisions 8408 |
| `publicationRepo` | 548 | S | `storedCompletePublication`, delivery, publication-state 7624 |
| `unifiedIngress` | 552 | S | POST /ingress/unified 6063, ingress.routes.ts |
| `problem` | 603 | H, pure | about 80 routes, `onError` |
| `publishExclusively` | 623 | H, needs db | `deliverOmnichannel` only |
| `creativeDirector` | 639 | S | `ingestChatCampaignTask`, POST generate 7037 |
| `qaEngine` | 640 | S (from options) | POST generate 7037, POST qa 8299 |
| `canvaStudio` | 641–651 | S | GET editor-url 8106 only |
| `activeStudioType` | 653 | constant | GET /system/studio-status 9617 |
| `studio` | 654 | alias | **never read (dead)** |
| `publisher` | 655 | S (from options) | `sloDaemon`, delivery, POST publish 7308 |
| `humanApprovalManager` | 656 | S | GET review-desk 8842, POST chat-approval-action 8917 |
| `modelGateway`, `evalRunner` | 657–658 | S | evals.routes.ts (plus the dead copy at 9636) |
| `sloDaemon`, `reconciliationService` | 660–661 | S | system.routes.ts |
| `voiceTranscriber` | 662 | S | Telegram 4439, POST /assets/transcribe-brief 9744 |
| `telegramActionTokenService` | 663 | S | `telegramBridge`, Telegram |
| `telegramAllowedUsers` | 665 | config | `telegramBridge`, `checkAndAlertBilling`, redrive, Telegram, POST /auth/telegram-miniapp 6183 |
| `telegramIntakeUsers` | 668 | config | Telegram only |
| `telegramBridge` | 669 | S | health, billing alert, ingest, redrive, `handleRequesterAction`, `makeOtherSize`, `answerQuestion`, Telegram, `canvaStatusHandler`, poller 11253, system.routes.ts |
| `defaultTenantId`, `operatorUserId`, `adminUserId` | 729–731 | constants | the same value as module-level `DEFAULT_TENANT_ID` (313); clients.routes.ts redefines both |
| `defaultClientId` = `'client-office-1'` | 764 | constant (a fixture id) | ingest, delivery, POST briefs, generate, qa, decisions, feedback, assets upload, search, dispatch-review, evaluate-rubric |

### 1b. In-memory state

| Name | Line | Kind | Written by / read by (routes) |
|---|---|---|---|
| `guidelineReadings` Set<Promise> | 534 | test hook | Telegram 4217; exposed on `app` at 11304 |
| `acknowledgedAlbums` Set | 536 | **T** | Telegram only |
| `pendingClarifications` Map | 538 | **T** | Telegram only |
| `tasks` Map | 689 | **T** (a cache that routes also write) | reader 1870, ingest 2026, redrive 2497, Telegram, POST /ingress/promote 6117, GET /tasks 6226, POST /tasks 6359, GET /tasks/:taskId 6556, GET timeline 6758, POST /messages/:id/promote 6796, POST route 6846, GET publication-state 7624, `canvaStatusHandler` 7756, GET editor-url 8106, POST sweep-failed 8278, POST qa 8299, POST /ingress/rehearsal 9998, `buildSearchEngine` (GET /search 10716), workflow 11106/11137; **modules:** system.routes.ts:326 (GET /operations/failures), :405 (POST /operations/reconciliation/run), canva.routes.ts:78 (POST /tasks/:taskId/canva/design) |
| `events` Map | 690 | **T** | ingest, delivery, Telegram, POST /tasks, GET timeline, POST messages promote, POST route, POST briefs, POST generate, POST :control, POST decisions, POST rehearsal, `handleActionCallback` |
| `rawEvents` Map | 691 | dead | written only by the dead `checkAndRecordIngressEvent`; read at 10644 |
| `briefs` Map | 692 | **T** | ingest, GET /tasks/:taskId, POST briefs, POST generate, GET export-package, POST qa, search |
| `revisions` Map | 693 | **T** | redrive, Telegram, POST generate, `canvaStatusHandler`, export-package, GET /designs/:id/revisions 8292, POST qa 8299, POST decisions 8408, GET review-desk 8842, POST revisions 8956, GET diff 9163, GET :revisionId 9197, POST evaluate-rubric 11045 |
| `decisions` Map | 694 | **T** | POST decisions 8408; `findApprovalForDelivery` reads it only when there is no database (`db ? [] : …`) |
| `feedbacks` Map | 695 | **T** | Telegram, POST /tasks/:taskId/feedback 9254 |
| `clientDnas` Map | 696 | cache plus fixtures | `resolveClientDna`, fixtures 765–1215, POST /tasks, clients.routes.ts (GET /clients, GET dna fallback), POST dna, POST snapshots, candidate promote/rollback, dna/rollback, search, hydration 11294 |
| `clientSnapshots` Map | 718 | **T** plus fixtures | fixtures 1217–1344, GET /clients (module), POST dna, GET snapshots (app and module), POST snapshots, candidate promote/rollback, dna/rollback |
| `evalRuns` Map | 720 | **T** | evals.routes.ts only |
| `uploadedAssets` Map | 721 | **T** | POST /assets/upload 9693, GET /assets 9763, search |
| `workflowControllers` Map | 722 | **T** | `getOrCreateWorkflowController`, which serves workflow state 11131 and workflow action 11137 |
| `rubricReports` Map | 723 | **T** | POST evaluate-rubric 11045, GET rubric-reports 11099 |
| `taskComments` Map | 724 | **T** | POST and GET /tasks/:taskId/comments 9118/9156 |
| `omnichannelReceipts` Map | 725 | **T** | delivery, POST publish 7308, publication-state 7624, publish-omnichannel 10963, publication-receipt 11033, system.routes.ts:416 |
| `inFlightPublications` Map | 726 | **T** | delivery, publish-omnichannel |
| `inMemoryOutbox` Map (from options) | 727 | **T** (only without a database) | delivery, GET outbox 7407, POST outbox redrive 7488, publication-state 7624 |
| `subscribers` Set | 742 | per-process (the SSE connections; legitimate) | `broadcast`, system.routes.ts /events/stream |
| `issuedSessions` Map | 1357 | cache of `desk_sessions` | session functions, `verifyRequestAuth`, auth.routes.ts |
| `lastVerifiedProgressAt`, `lastPaidProbe`, `telegramProbe` | 1545, 1558, 1693 | probe caches | health only |
| `deliveriesInFlight` Set | 2968 | **T** | `executeOmnichannelPublish`, `reopenInterruptedDelivery` |
| `packagedFonts` Map | 9924 | **T** | POST /fonts/package 9926, GET /fonts/cdn/* 9947/9961 |
| **Module-level:** `channelKillSwitches` | 257 | **T, shared across app instances** | `pauseIntakeWhen` (686), health, Telegram, ingress.routes.ts (GET status, POST toggle), system.routes.ts:104 (poll-now) |
| **Module-level:** `globalHistoricalMigrator`, `globalCanvaNativeAdapter`, `globalCanvaCircuitBreaker` | 254–256 | S (process-global) | migration routes 10434–10519; circuit breaker: health, GET /system/studio-status, system.routes.ts |

### 1c. Helpers (function or const), with dependencies and users

| Helper | Lines | Uses | Used by |
|---|---|---|---|
| `resolveClientDna` | 704–715 | db, `clientDnas` | delivery, POST /tasks, GET /tasks/:taskId, POST generate, clients POST dna / POST snapshots / candidate promote / candidate rollback / dna rollback, dispatch-review 10759, publish-omnichannel 10963, evaluate-rubric 11045 → **shared** |
| `broadcast` | 744–761 | `subscribers` | 35 blocks, every group → already `ctx.broadcastEvent` |
| DNA fixtures | 763–1344 | `clientDnas`, `clientSnapshots`, `computeDnaHash`, `kaaeClientDNA` | startup |
| sessions: `persistSession`, `revokeSession`, `ensureSessionLoaded`, `bearerTokenOf`, `saveSession`, `verifyRequestAuth` | 1346–1542 | db, `issuedSessions`, options | `registerRoute`, every route, auth.routes.ts, POST /auth/telegram-miniapp |
| billing and health probes | 1545–1869 | `lastPaidProbe`, `telegramBridge`, db, circuit breaker, … | `honestHealthHandler` (system.routes.ts); **`probeModelProvider` is also used by `sweepFailedTasks`** |
| `resolveTaskWithFallback`, `readCurrentTask` | 1870–1912 | db, `taskRepo`, `tasks` | Telegram, GET /tasks/:taskId, POST route, briefs, generate, publish, export-package, :control, decisions, review-desk, chat-approval, revisions, comments, dispatch-review, `handleActionCallback`, publish-omnichannel, evaluate-rubric, delivery → **shared by 8 groups** |
| public-path sets, `registerRoute`, `handleDecommissionedFigmaRoute` | 1914–1963 | sessions, `problem` | shell |
| `ingestChatCampaignTask` | 2026–2496 | db, `tasks`, `events`, `briefs`, `broadcast`, `telegramBridge`, `creativeDirector`, `isProduction`, `defaultClientId` | Telegram 4217, POST /webhooks/whatsapp 5871 |
| `redriveTask` | 2497–2819 | db, `taskRepo`, `outboxRepo`, `revisionRepo`, `canvaConnectService`, `tasks`, `revisions`, `telegramBridge`, `telegramAllowedUsers`, `LIVE_RUN`, `broadcast` | `sweepFailedTasks`, Telegram, POST /tasks/:taskId/redrive 8263 |
| `sweepFailedTasks` | 2820–2864 | db, **`probeModelProvider`**, `redriveTask` | POST /tasks/sweep-failed 8278 |
| `NO_APPROVAL_TO_DELIVER`, `findApprovalForDelivery`, `storedCompletePublication`, `deliveriesInFlight`, `executeOmnichannelPublish`, `deliverOmnichannel` | 2865–3574 | db, repositories, `decisions`, `events`, `omnichannelReceipts`, `inFlightPublications`, `inMemoryOutbox`, `publisher`, `deliverableStore`, `publishExclusively`, `readCurrentTask`, `resolveClientDna`, `broadcast` | `executeOmnichannelPublish`: Telegram, POST publish 7308, `handleActionCallback` 10803, publish-omnichannel 10963; `storedCompletePublication`: POST publish only |
| `telegramUpdateHandled`, `markTelegramUpdateHandled` | 3575–3610 | db only | Telegram (and `handleRequesterAction`, `answerQuestion`) |
| `enqueueOfficeAlert` | 3611–3639 | db, `outboxRepo` | `handleRequesterAction`, Telegram, **`canvaStatusHandler`** |
| `askHistory` | 3640–3673 | db only | `handleRequesterAction`, Telegram, **`canvaStatusHandler`** |
| `handleRequesterAction`, `makeOtherSize`, `questionFollowUp`, `pendingQuestion`, `answerQuestion` (and the interfaces at 3791 and 3898) | 3674–4013 | db, `telegramBridge`, `broadcast` | Telegram only |
| `LIVE_RUN` | 4014–4016 | constant SQL | redrive, `taskDesignState`, `pendingChangeOf`, `revisionInFlight`, `studioRunInProgressForChat` → **shared** |
| `taskDesignState`, `replyDesign` | 4017–4067 | db | Telegram only |
| `pendingChangeOf` | 4068–4087 | db, `LIVE_RUN` | `changeBlockingDelivery`, **POST decisions 8408** |
| `reopenInterruptedDelivery`, `changeBlockingDelivery` | 4088–4115 | db, `taskRepo`, `deliveriesInFlight`, `pendingChangeOf` | POST publish 7308 |
| `pendingChangeWords` | 4116–4127 | pure | **POST publish 7308, POST decisions 8408** |
| `revisionInFlight`, `studioRunInProgressForChat` | 4128–4162 | db, `LIVE_RUN` | Telegram only |
| `checkAndRecordIngressEvent` | 4163–4216 | `rawEvents`, db | **nobody (dead)** |
| `wahaIngress` | 5869 | S | POST /webhooks/whatsapp |
| `canvaStatusHandler` | 7756–8102 | db, repositories, `tasks`, `revisions`, `enqueueOfficeAlert`, `askHistory`, `telegramBridge`, `broadcast` | POST canva-status 8103, POST canva-ready 8104 |
| `buildSearchEngine` | 10625–10715 | `tasks`, `uploadedAssets`, `rawEvents`, `clientDnas`, `briefs` | GET /search |
| `handleActionCallback` | 10803–10958 | db, `taskRepo`, `events`, `executeOmnichannelPublish`, `resolveTaskWithFallback` | GET and POST /webhooks/whatsapp/actions |
| `getOrCreateWorkflowController` | 11106–11130 | `workflowControllers`, `tasks` | workflow routes |
| `maskKey` | 11205–11209 | none | **nobody (dead)** |
| background jobs | 11213–11293 | db, `outboxRepo`, `canvaConnectService`, `telegramBridge`; the poller calls `app.request('/api/webhooks/telegram')` | shell |
| `clientDnaHydrated` | 11294–11303 | `clientDnas`, db | exposed on `app` |

The module-level exports at lines 207–527 are `canonicalJson`, `computeDnaHash`, `isValidUuid`, `inlineTemplateCopyMissing`, `COPY_REQUIRED_DETAIL`, `qaReportSha256`, `secretsEqual`, `probeDatabase`, `evaluateCanvaExportQc`, `cutText`, `TaskStoreUnavailableError` and `DEFAULT_TENANT_ID`. Every group uses them. `routes/system.routes.ts:7` already imports `probeDatabase` from `'../app.js'`, which is an existing **import cycle**.

---

## 2. Route groups, in the plan's order

Rule used below: "moves with" means the helper or state is used only by that group. "Shares" means it must come from the foundation, through `ctx` or a service import.

### G0: dead code (details in section 6)
- Remove app.ts's `GET /clients` 9283–9300, `GET /clients/:clientId/dna` 9301–9335, and the five evaluation routes 9636–9692.
- Remove **clients.routes.ts:73–78** (the in-memory `GET /clients/:clientId/snapshots`), so that app.ts's Postgres-backed reader at 9467 becomes the live one.
- Also remove: `checkAndRecordIngressEvent` 4163–4216, `maskKey` 11204–11209, `rawEvents` (691, 1983, types.ts:73, and 10644–10645 in search), `recordPaidModelBillingError` 1560–1569, the `studio` alias 654, `LocalClientDnaSnapshot` 717.
- The DNA fixtures 763–1344 move out in two stages (section 6).

### G1: leaves (about 585 lines; modules listed per item)

| Leaf | Routes (line) | Needs from ctx | Moves with |
|---|---|---|---|
| Migration → `routes/migration.routes.ts` | GET /migration/ledger 10434, GET /migration/reconciliation 10448, POST archive 10453, POST migrate 10466, POST reopen-sample 10484, POST rollback-sample 10502 | `historicalMigrator`, `globalCanvaNativeAdapter`, `broadcast` | nothing |
| Assets → `routes/assets.routes.ts` | POST /assets/upload 9693, POST /assets/sanitize-svg 9733, POST /assets/transcribe-brief 9744, GET /assets 9763 | `uploadedAssets` (shared with search), `voiceTranscriber` (shared with Telegram), `defaultClientId` | nothing |
| Simulators → `routes/simulators.routes.ts` | POST /ai/comfy-background 9773, POST /ai/comfy-composite 9855, POST /ingress/rehearsal 9998 | `tasks`, `events`, `broadcast` | nothing (`globalCostGovernor` is a package import) |
| Fonts → `routes/fonts.routes.ts` | POST /fonts/inspect 9901, POST /fonts/package 9926, GET /fonts/cdn/:fontFamily/style.css 9947, GET …/font.woff2 9961 | nothing | **`packagedFonts` (9924)** |
| Rubric → `routes/rubric.routes.ts` | POST /tasks/:taskId/revisions/:revisionId/evaluate-rubric 11045, GET /tasks/:taskId/rubric-reports 11099 | `resolveTaskWithFallback`, `resolveClientDna`, `defaultClientId` | **`rubricReports`** |
| Auth mini-app → append to `routes/auth.routes.ts` | POST /auth/telegram-miniapp 6183 | `saveSession`, `telegramAllowedUsers` | nothing |
| System status → new `routes/system-status.routes.ts` (not system.routes.ts; see G5) | GET /system/revision-metrics 9606, GET /system/studio-status 9617, GET /system/cutover/status 9623, POST /system/cutover/rollback-rehearsal 9630 | `globalCanvaCircuitBreaker` | `activeStudioType` |

### G2: clients and DNA (about 740 lines) → `clients.routes.ts`, plus new `routes/client-learning.routes.ts`
- **Routes:**
  - POST /clients/:clientId/dna 9336
  - GET /clients/:clientId/snapshots 9467 (the one kept by G0)
  - POST /clients/:clientId/snapshots 9515
  - GET /clients/budgets 9973, GET /clients/:clientId/budget 9978, POST …/budget/allocate 9984
  - POST /feedback/mine 10083
  - GET /clients/:clientId/candidate-rules 10094
  - POST …/candidate-rules/:ruleId/promote 10100, POST …/dismiss 10260, POST …/rollback 10287
  - POST …/candidate-rules/propose 10382
  - POST /clients/:clientId/negative-feedback 10409
  - GET /clients/:clientId/learning/data-lineage 10426
  - POST /clients/:clientId/dna/rollback 10520
- **Moves with it:** nothing from the closure.
- **Shares:** `clientDnas` (POST /tasks and search read it), `clientSnapshots`, `resolveClientDna`, `clientRepo`, `options.persistDnaToDisk`, `computeDnaHash`.
- **Second stage of the fixture move:** fixture seeding becomes opt-in.
- **One-line fix:** switch the module's `GET dna` fallback from `clientDnas.get` to `ctx.resolveClientDna`. That is what the deleted app.ts copy did.

### G3: revisions and decisions (about 1,000 lines) → `routes/revisions.routes.ts` and `routes/decisions.routes.ts`
- **`revisions.routes.ts` routes:**
  - GET /designs/:designId/revisions 8292
  - POST /tasks/:taskId/revisions/:revisionId/qa 8299
  - POST /tasks/:taskId/revisions 8956
  - POST and GET /tasks/:taskId/comments 9118/9156
  - **GET /tasks/:taskId/revisions/diff 9163, which must stay before GET /tasks/:taskId/revisions/:revisionId 9197**
  - POST /tasks/:taskId/feedback 9254
  - GET /tasks/:taskId/asks 9595
- **`decisions.routes.ts` routes:** POST …/revisions/:revisionId/decisions 8408 (434 lines on its own), GET /tasks/:taskId/review-desk 8842, POST /tasks/:taskId/chat-approval-action 8917.
- **Moves with it:** `humanApprovalManager` (656), `taskComments` (724).
- **Shares:** `revisions`, `briefs`, `feedbacks` (Telegram), `decisions` (delivery's no-database branch), `events`, `qaEngine` (with G7), `deliverableStore` (with delivery), `pendingChangeOf` and `pendingChangeWords` (with G5), `readCurrentTask`, `resolveTaskWithFallback`, `revisionRepo`, `qaReportSha256`.

### G4: Canva outcome handler (about 470 lines plus 63 lines of helpers) → `routes/canva-outcome.routes.ts`
- **Routes:** POST /tasks/:taskId/canva-binding 7724; `canvaStatusHandler` 7756–8102 serving POST …/notifications/canva-status 8103 and POST …/notifications/canva-ready 8104; GET /tasks/:taskId/editor-url 8106; GET /tasks/:taskId/export-package 8137.
- **Moves with it:** `canvaStudio` (its construction at 641–651 moves into the module), `canvaStatusHandler`.
- **Moves as a service because Telegram also uses it:**
  - `enqueueOfficeAlert` 3611–3639 goes to `services/office-alerts.ts` as `enqueueOfficeAlert(db, outboxRepo, …)`.
  - `askHistory` 3640–3673 goes to `services/ask-history.ts`.
  - app.ts keeps same-name bindings so the Telegram handler still compiles.
- **Shares:** `tasks`, `revisions`, `briefs`, `canvaConnectService`, `telegramBridge`, `revisionRepo`, `outboxRepo`, `evaluateCanvaExportQc`.
- **Precondition:** a worker contract test (section 5, test N4).

### G5: publish and delivery (about 540 lines) → `routes/delivery.routes.ts` and `routes/outbox.routes.ts`
- **Routes:** POST /tasks/:taskId/publish 7308, GET /tasks/:taskId/outbox 7407, POST …/outbox/:commandId/redrive 7488, GET /outbox/failed 7573, POST …/outbox/:commandId/retire 7597, GET /tasks/:taskId/publication-state 7624, POST /campaigns/:taskId/dispatch-review 10759, POST /tasks/:taskId/publish-omnichannel 10963, GET /tasks/:taskId/publication-receipt 11033.
- **Moves with it:** nothing. The delivery machinery is foundation work.
- **Shares:** delivery service, `omnichannelReceipts` (system.routes.ts:416), `inFlightPublications`, `inMemoryOutbox`, `publisher`, `pendingChangeWords`, `readCurrentTask`, `resolveClientDna`, `COPY_REQUIRED_DETAIL`.
- **File ownership:** G5 is the only group allowed to edit system.routes.ts (when it removes `omnichannelReceipts`).

### G6: controls and redrive (about 570 lines) → `routes/controls.routes.ts` and `services/redrive.ts`
- **Routes:** POST /tasks/:taskId/:control 8190 (already turned into explicit `/pause`, `/resume`, `/cancel`, `/retry` by the foundation), POST /tasks/:taskId/redrive 8263, POST /tasks/sweep-failed 8278, GET /tasks/:taskId/workflow/state 11131, POST /tasks/:taskId/workflow/:action 11137.
- **Moves with it:** `sweepFailedTasks` 2820–2864, `getOrCreateWorkflowController` 11106–11130, `workflowControllers`.
- **Moves as a service because Telegram also uses it:** `redriveTask` 2497–2819 goes to `services/redrive.ts` as `createRedrive(deps)`. app.ts keeps the binding `const { redriveTask } = createRedrive(routeContext)`.
- **Shares:** `probeModelProvider` (health), `LIVE_RUN`, `telegramBridge`, `telegramAllowedUsers`, `canvaConnectService`, `tasks`, `revisions`.

### G7: tasks and Desk (about 1,170 lines) → `routes/tasks.routes.ts`, `routes/task-pipeline.routes.ts`, `routes/search.routes.ts`
- **`tasks.routes.ts`:** GET /tasks 6226, POST /tasks 6359, GET /tasks/:taskId 6556, GET /tasks/:taskId/timeline 6758.
- **`task-pipeline.routes.ts`:** POST /tasks/:taskId/route 6846, POST /tasks/:taskId/briefs 6935, POST /tasks/:taskId/generate 7037.
- **`search.routes.ts`:** `buildSearchEngine` 10625–10715 and GET /search 10716.
- **Moves with it:** `buildSearchEngine`.
- **Shares:** `tasks`, `events`, `briefs`, `revisions`, `clientDnas`, `uploadedAssets`, `resolveClientDna`, `readCurrentTask`, `resolveTaskWithFallback`, `qaEngine`, `creativeDirector`, `isProduction`, `inlineTemplateCopyMissing`, `COPY_REQUIRED_DETAIL`.

### G8: WhatsApp and ingress (about 1,000 lines) → `routes/whatsapp.routes.ts`, extend `ingress.routes.ts`, `services/chat-campaign-intake.ts`
- **Routes:** POST /webhooks/whatsapp 5871, GET /waha/health 5935, POST /waha/kill-switch 6037, POST /ingress/unified 6063, POST /ingress/promote 6117, POST /messages/:messageId/promote 6796, and `handleActionCallback` 10803–10958 serving POST and GET /webhooks/whatsapp/actions 10959/10960.
- **Moves with it:** `wahaIngress` 5869, `handleActionCallback`.
- **Moves as a service because Telegram also uses it:** `ingestChatCampaignTask` 2026–2496, with a binding left in app.ts.
- **Shares:** delivery service, `unifiedIngress`, `creativeDirector`, `tasks`, `events`, `briefs`, `telegramBridge`, `secretsEqual`, `isProduction`.

### G9: Telegram intake, last (about 2,100 lines)
- **Scope:** POST /webhooks/telegram 4217–5868, the helpers 3575–3610, 3674–4013, 4017–4067 and 4128–4162, the state at 534–538 and 668, and removal of the bindings left by G4, G6 and G8.
- **It has to be split into modules of 800 lines or fewer:**

| Module | Content | Approx. lines |
|---|---|---|
| `routes/telegram-webhook.routes.ts` | entry: secret, parse, kill switch, dispatch | about 150 |
| `services/telegram-intake/update-state.ts` | `telegramUpdateHandled`, `markTelegramUpdateHandled`, `taskDesignState`, `replyDesign`, `revisionInFlight`, `studioRunInProgressForChat` | about 150 |
| `services/telegram-intake/requester-actions.ts` | `handleRequesterAction`, `makeOtherSize` | about 200 |
| `services/telegram-intake/questions.ts` | 3877–4013 | about 140 |
| `services/telegram-intake/callbacks-and-commands.ts` | 4245–4396 and 4789–4907 | about 270 |
| `services/telegram-intake/media.ts` | voice, photo, document, PDF rules, albums: 4417–4788 | about 370 |
| `services/telegram-intake/replies.ts` | 4908–5394 | about 490 |
| `services/telegram-intake/changes.ts` | 5395–5786 | about 390 |
| new-request tail | 5787–5868, stays in the webhook module | |

- **Order within G9:** do it as 2 or 3 PRs. First the pure database helpers, then the callbacks and commands, then the body.
- **The poller** (11253–11293) stays in the shell until Phase 2.1.

---

## 3. Shared foundation (one engineer, alone, before the parallel groups)

**Principle.** Every helper, and every piece of state, that two concurrent groups need is moved out of the closure or put on `ctx` now. Each moved helper leaves a **same-name binding** at its old place in app.ts, for example `const { resolveTaskWithFallback, readCurrentTask } = createTaskReader({ db, taskRepo, tasks });`. That way no call site changes in this step, and the diff is a pure move.

Steps, in order (two PRs: F1–F8 are pure moves, F9–F12 are wiring):

1. **F1 `apps/core/src/core-helpers.ts`**
   - Move lines 207–527: all the module-level exports listed at the end of section 1c, plus `cutText`, `TaskStoreUnavailableError`, `DEFAULT_TENANT_ID` and `CreateAppOptions`.
   - app.ts re-exports the public ones (`evaluateCanvaExportQc`, `probeDatabase`, `secretsEqual`, `computeDnaHash`, `canonicalJson`, `isValidUuid`, `qaReportSha256`, `inlineTemplateCopyMissing`, `CreateAppOptions`, `ClientDnaSnapshot`). Six test files import these from `../src/app.js`.
   - Change system.routes.ts:7 to import from core-helpers. **This breaks the existing cycle.**
   - Remove the duplicate `ClientDnaSnapshot` (app.ts:207 duplicates types.ts:32).
2. **F2 `apps/core/src/core-context.ts`**
   - Constants: `DEFAULT_TENANT_ID`, `OPERATOR_USER_ID`, `ADMIN_USER_ID`, `DEFAULT_CLIENT_ID`. This replaces the definitions at 313, 729–731 and 764, and the copy in clients.routes.ts.
   - `interface CoreContext`: everything in today's `RouteContext` except `app` and `registerRoute`.
   - `RouteContext extends CoreContext` in routes/types.ts.
3. **F3 `services/task-reader.ts`**: `createTaskReader({db, taskRepo, tasks})`, taken from 1870–1912.
4. **F4 `services/client-dna-resolver.ts`**: `createClientDnaResolver({db, clientDnas})`, taken from 704–715. It could also go next to `loadActiveClientDna` in client-dna-hydration.ts.
5. **F5 `services/live-run.ts`**: `export const LIVE_RUN` from 4014–4016. Also update the comment at design-studio-service.ts:482.
6. **F6 `services/pending-change.ts`**: `pendingChangeOf(db, …)` and `pendingChangeWords`, from 4068–4087 and 4116–4127. Depends on F5.
7. **F7 `services/omnichannel-delivery.ts`**: `createOmnichannelDelivery(deps)`.
   - Contents: `publishExclusively` 623–636, `NO_APPROVAL_TO_DELIVER`, `findApprovalForDelivery`, `storedCompletePublication`, `deliveriesInFlight`, `executeOmnichannelPublish`, `deliverOmnichannel` (2865–3574), `reopenInterruptedDelivery` and `changeBlockingDelivery` (4088–4115). About 780 lines.
   - Depends on F3, F4 and F6.
   - **Rename the `options` parameter** of `executeOmnichannelPublish`/`deliverOmnichannel` to `deliveryOptions` during the move. Today it shadows `createApp`'s `options`, and a factory that takes `deps.options` would silently change meaning.
8. **F8 health probes**: put `probeModelProvider` on the context. It does not move now; it is needed by G6's `sweepFailedTasks`.
9. **F9 replace the catch-all** at 8190 with `for (const control of ['pause','resume','cancel','retry']) registerRoute('post', `/tasks/:taskId/${control}`, …)`. Drop `next()`.
   - Add the missing task check (`readCurrentTask` → 404) to POST /tasks/:taskId/feedback 9254. Today it relies on the catch-all's 404.
   - Consider switching comments 9118 and chat-approval 8917 from `resolveTaskWithFallback` to `readCurrentTask`. That keeps today's 503 when the database is unreadable, which the catch-all currently provides.
10. **F10 complete the context**, typed, with no new `any`. These fields are added to `CoreContext`, and to the `routeContext` literal at 1965:
    - `isProduction`, `clientRepo` (typed), `canvaConnectService`, `deliverableStore`, `qaEngine`, `creativeDirector`, `publisher`, `voiceTranscriber`, `telegramAllowedUsers`, `inMemoryOutbox`, `inFlightPublications`
    - `resolveTaskWithFallback`, `readCurrentTask`, `resolveClientDna`
    - `delivery: { executeOmnichannelPublish, storedCompletePublication, reopenInterruptedDelivery, changeBlockingDelivery }`
    - `probeModelProvider`
    - `options: CreateAppOptions` (this also removes an `any`)
    - Remove `rawEvents`.
    - **After this, no group touches `types.ts` or the `routeContext` literal.**
11. **F11 stubs and registration calls.**
    - Create every target module as an empty `export function registerXRoutes(ctx: RouteContext): void {}`.
    - Add all the calls in one block right after line 2023, in plan order: leaves, clients learning, revisions, decisions, canva-outcome, delivery, outbox, controls, tasks, task-pipeline, search, whatsapp, telegram-webhook.
    - After F9 the order of these calls has no effect (section 4). Groups then only fill in their own files and delete their own blocks.
12. **F12 safety-net tests**: N1 and N2 in section 5.

**Rule for helpers shared only with Telegram.** `redriveTask`, `ingestChatCampaignTask`, `enqueueOfficeAlert` and `askHistory` are shared only with G9, which runs last. So they move with G6, G8 and G4 respectively, and each leaves a same-name binding in app.ts. The binding sits inside the lines that group owns, so it creates no conflict.

**Cycles to watch:**
- system.routes.ts → app.ts. This exists today and F1 fixes it.
- Any new module importing `'../app.js'`. Forbid it: add an assertion in N2 that no file under `src/routes` or `src/services` imports `app.js`.
- Runtime self-dispatch: the poller calls `app.request('/api/webhooks/telegram')`. This is not an import cycle; it stays until Phase 2.1.
- Type-only cycles between `core-context.ts` and the service factories. Use `import type` in both directions; `verbatimModuleSyntax` is on.
- There is **no** logic cycle. The dependencies run one way: delivery → task reader and DNA resolver; sweep → health probe; Telegram → redrive, ingest, delivery, office alerts.

---

## 4. Route order that matters

In Hono 4.13 (the default SmartRouter), matching handlers run in registration order, and the first one to answer wins. I enumerated every route pattern (167, across app.ts and the modules) and found every pair with the same method and segment count that can match the same URL:

1. **The catch-all POST `/tasks/:taskId/:control` (8190).** It runs `readCurrentTask`. It answers 404 when the task is unknown, **before** it checks whether the control is one of the four it handles. Only after that does it call `next()`.
   - **Routes registered earlier, which it therefore does not affect:**
     - system.routes.ts:173 `POST /tasks/:taskId/leases` (the Figma tombstone, which answers 410)
     - design-studio.routes.ts:308 `POST /tasks/:taskId/design-feedback`
     - route 6846, briefs 6935, generate 7037, publish 7308, canva-binding 7724
   - **The six later POSTs it intercepts:**
     - `/tasks/:taskId/redrive` 8263
     - `/tasks/:taskId/chat-approval-action` 8917
     - `/tasks/:taskId/revisions` 8956
     - `/tasks/:taskId/comments` 9118
     - `/tasks/:taskId/feedback` 9254
     - `/tasks/:taskId/publish-omnichannel` 10963
   - **Fix:** F9 replaces it with four explicit paths, and the eleven overlaps disappear.
2. **GET `/tasks/:taskId/revisions/diff` (9163) must stay before GET `/tasks/:taskId/revisions/:revisionId` (9197).** Both stay inside `revisions.routes.ts`, in that order.
3. **The eight shadowed duplicates.** The module copies registered at 2020–2021 win. G0 deletes the app.ts copies (and the module's snapshots route).
4. **Middleware.** The three `app.use('*')` calls (555, 572, 581) and `onError` (590) must stay first in `createApp`.
5. **Registration before the poller.** The Telegram module must be registered before the poller block (11253), which starts at `listen` time. In practice this just means "inside `createApp`".

After F9, registration order across modules is free. The single remaining constraint (item 2) lives inside one file. Test N2 enforces this from now on.

---

## 5. Tests that read app.ts as text

These should be replaced first, in their own PR before G0.

| Test | What it asserts on app.ts text | Behavioural replacement |
|---|---|---|
| `apps/core/test/funnel-stall-condition.test.ts:49–79` (second describe) | the regex `'human_review',…awaiting visual review` (matches 2756, 2791, 7872); the strings `could not record outcome ${status} as state` (7930) and `could NOT be recorded as a Desk revision` (7899) | Post a DRAFT_READY to `/v1/tasks/:id/notifications/canva-status` and assert the task state is `human_review`. Then `vi.mock('../src/services/canva-task-outcome.js')` so `transitionTaskForOutcome` and `bridgeCanvaDraftRevision` throw: assert a 200 `{ok:true}`, the notification enqueued, and `console.error` called with both messages. (The first describe reads funnel-monitor.ts and is unaffected.) |
| `apps/core/test/no-second-system.test.ts:11–20` | no `const globalShared\w+ = new Map` in app.ts | Create two apps; a task created in app A is 404 in app B; toggling `/ingress/channels/telegram/toggle` in A leaves B's `/ingress/status` unchanged. **This will fail today, because `channelKillSwitches` is module-level**; fix it by moving it into `createApp` (then Postgres in G8). Also note the second test in this file: its NODE_ENV allow-list only accepts files named `app.ts`, `index.ts` or `provider-policy.ts`, so extracted code must use `ctx.isProduction`, never `process.env.NODE_ENV`. |
| `apps/core/test/no-auth-backdoors.test.ts:56–62` | no `HAWA_ALLOW_ROLE_HEADER`; no `bypassAuthWithoutDb ?? !db`; no `x-user-role') \|\| body.role` | Set `HAWA_ALLOW_ROLE_HEADER=true` and use plain `createApp()`: an `x-user-role: administrator` request with no token gets 401. `createApp()` with no database, no options and no token gets 401. A POST with `{"role":"administrator"}` and an operator token cannot perform an admin-only action (for example `/system/outbox/requeue`). |
| `apps/desk/test/task-status.test.ts:24–25` | collects in-memory statuses by searching app.ts for `'IN_PROGRESS'`, `'PAUSED'`, `'CHANGES_REQUESTED'`, `'COMPLETED'` | Import the status list from `packages/contracts` (programme item 1.2). Interim: scan every `apps/core/src/**/*.ts`. |
| `packages/testkit/test/no-duplicate-paths.test.ts:11–25` | a 4,000-character slice after `registerRoute('post', '/tasks/:taskId/publish',` must contain `executeOmnichannelPublish(` and not `publisher.publish(ctx,` or `publicationRepo.createPublication(` | `createApp({ publisher: spy })`, approve a task, POST publish: `spy.publish` is called exactly once. A second POST publish answers from the stored publication (`storedCompletePublication`) without calling the spy. Test 2 in the same file (POST /approve is not 200/202) is already behavioural and keeps passing after F9, because the answer becomes a plain 404. |
| `packages/testkit/test/app-decomposition.test.ts:19–25` | app.ts contains `registerAuthRoutes`, `registerClientsRoutes`, `registerEvalsRoutes`, `registerIngressRoutes` | Delete it; N1 covers it. |

Tests and scripts that mention app.ts but need no change: desk `work-screen-truth` and `desk-auth` mention it only in comments; `r11-release-gate` uses a fake hash map.

Scripts that will break as code moves:
- `scripts/verify_all_h01_h14.ts:124–134` searches app.ts for `approve: 'approved'` and `INVALID_DECISION_ACTION`. Retarget it in G3. It is not wired into CI.
- `scripts/lint_provider_egress.ts:27` allow-lists app.ts because of `api.openai.com` at 1579 (the billing probe). If health ever moves, add `services/health*.ts`.

New safety-net tests to add in the pre-step PR:
- **N1, route inventory.** The sorted unique list of `METHOD path` from `app.routes`, compared with a checked-in file. The count is expected to stay the same through every move PR. Only G0's snapshots choice changes a handler, not a path.
- **N2, route order guard.** Compute overlapping pairs from `app.routes`, in order. The allowed set is: the eleven `:control` overlaps (removed in F9's PR), and `revisions/diff` before `:revisionId`. Also assert that nothing under `src/routes` or `src/services` imports `app.js`.
- **N3, control semantics.** An unknown UUID answers 404 on each of the six intercepted routes. pause, resume, cancel and retry answer 202. `/approve` answers 404.
- **N4, worker contract for canva-status.**
  - Callers: `apps/worker/src/canva-draft-workflow.ts:153` and `outbox-consumer.ts:454`.
  - Request body fields: `status`, `code`, `designId`, `detail`, `notifyRequester`, `parity`, `parityError`, `runId`.
  - Answers: 401, 503 (no database), 422 (invalid id), 404, 200 `{notified:false, reason:'REFERENCE_FOR_ANOTHER_REQUEST'}`, 500 (enqueue failed), and 200 `{ok, taskId, status, code, notificationSent, notificationError, notificationCommandId, designId, canvaUrl}`.
  - Keep the recorded bodies in one fixture file that both the worker tests and the Core tests use.
- **N5, snapshots.** GET /clients/:id/snapshots returns Postgres rows. This covers G0's behaviour change.

---

## 6. Dead code, with evidence

The repo-wide searches below covered `apps/`, `packages/` and `scripts/`.

| Item | Where | Why it is dead |
|---|---|---|
| 8 shadowed routes | app.ts GET /clients 9283, GET /clients/:clientId/dna 9301, GET /clients/:clientId/snapshots 9467, POST /evaluations/runs 9636, GET /evaluations/runs 9652, GET …/runs/:runId 9656, GET /evaluations/datasets 9663, GET …/datasets/:datasetId/cases 9671 | Same method and path as clients.routes.ts:19/38/74 and evals.routes.ts:10/26/30/37/45. Those are registered first (2020–2021) and never call `next()`, so the app.ts copies never run. The evals copies are character-for-character identical (`evalRunner` is the same object as `ctx.evaluationRunner`). **Snapshots:** the live one is the module's memory-only reader; app.ts's version at 9467 reads `clientRepo.listDnaSnapshots` from Postgres. Per the plan, delete the module's (clients.routes.ts:73–78) and keep app.ts's. This is a behaviour change, covered by N5. **DNA:** the two copies differ only in the fallback after Postgres (`clientDnas.get` against `resolveClientDna`); delete app.ts's now, and move the module to `resolveClientDna` in G2. |
| `checkAndRecordIngressEvent` | 4163–4216 | No call site anywhere in the repo. It is the only writer of `rawEvents`. Its `inbox_events` key (`source_event_id` with no chat prefix) is incompatible with `telegramUpdateHandled` (3575), which would make it unsafe to bring back. |
| `maskKey` | 11205–11209 (comment at 11204) | Never called. system.routes.ts:35 has its own copy, which it uses at 518. |
| `rawEvents` | 691, context 1983, types.ts:73, read at 10644–10645 | Only the dead function above writes it, so it is always empty. In `buildSearchEngine`, `eventText` is always `''`. Delete the read too. |
| DNA fixtures | 763–1344 (`clientDnas` seeds 765–1215; `clientSnapshots` seeds 1217–1344) | Production calls `hydrateClientDnaFromDb(..., {dropUnknown: isProduction})` (11294). That drops every fixture entry not in Postgres and overwrites the rest. But the fixtures are served until hydration finishes, because `index.ts:48` does not await `clientDnaHydrated`. And 110 test files mention fixture client ids. So this is **not** safe to delete outright. **Stage 1 (G0):** move the data verbatim to `apps/core/src/fixtures/client-dna-fixtures.ts`, exposing `seedClientDnaFixtures(clientDnas, clientSnapshots)`, called where the fixtures sit today; this is behaviour-neutral and removes about 580 lines. **Stage 2 (G2):** make it an opt-in `CreateAppOptions` flag used by a shared test helper, then move the file under `apps/core/test/fixtures/`. **Caveat:** `defaultClientId = 'client-office-1'` (764) is a fixture id that routes use as a production fallback; replace it with an explicit refusal or a configured client. |
| Extra dead code, not in the plan | `recordPaidModelBillingError` 1560–1569 (no caller); `studio` 654 (never read); `LocalClientDnaSnapshot` 717; `canvaBindingRepo` and `ingressRepo` on the context (no module reads them) | |
| Candidates for the owner to decide | `POST /messages/:messageId/promote` 6796 (no caller, no test) | |
| No-Desk-caller routes | comments, rubric, workflow, migration, comfy, review-desk, chat-approval, publish-omnichannel, dispatch-review | The Desk never calls these; only tests exercise them. That matters for the "persist or delete" decision when their maps are removed. |

---

## 7. Parallel schedule

**Rules for the parallel groups:**
- Each group runs in its own worktree and makes its own PRs.
- **First PR: a pure move.** Cut the route blocks, from the leading comment to the closing `});`. Never delete the blank line above a block; every boundary between groups has one, so git merges adjacent deletions cleanly. Paste into the group's own stub module and destructure `ctx`. Review with `git diff --color-moved`.
- **Second PR: remove the in-memory state.** Remove the maps the group owns and read Postgres instead.
- **Groups do not touch:**
  - `routes/types.ts`, `core-context.ts`, the `routeContext` literal, or the registration block
  - the import lists at the top of app.ts (`strict` does not include `noUnusedLocals`, so unused imports are harmless; cleanup removes them)
  - system.routes.ts (only G5 may)
  - another group's module
- **No new `any`.** Type handlers as `(c: Context)`; the ceiling is 1053 and today's count is 1044.
- **Tests.** New tests go in new files. Each PR must pass the full suite and N1–N5.

| Step | Who | Content | Duration | app.ts lines after (approx.) |
|---|---|---|---|---|
| P: test replacement | 1 engineer | Section 5: six replacements, plus N1–N5 | 1 d | 11,307 |
| G0: dead code | same engineer | Section 6, with fixtures stage 1 | 0.5 d | about 10,540 (dead code −183, fixtures −579) |
| F: foundation | 1 engineer, alone | F1–F12 (2 PRs) | 1.5–2 d | about 9,490 (helpers −300, reader and DNA resolver −55, delivery, live-run and pending-change −773, context, stubs and explicit controls +70) |
| Parallel wave | 4 engineers, 2 groups each, in pairs chosen to keep related work together (right) | E1: G1 leaves (−585) + G2 clients and DNA (−740) | 2 d | about 8,165 once E1 merges |
| | | E2: G3 revisions and decisions (−1,002) + G5 publish and delivery (−542); both touch pending-change and `decisions`, so one person holds that context | 2–2.5 d | |
| | | E3: G4 Canva outcome (−525, after N4 is green) + G6 controls and redrive (−566) | 2 d | |
| | | E4: G7 tasks and Desk (−1,166) + G8 WhatsApp and ingress (−992) | 2.5 d | **about 3,380 after all eight** |
| G9: Telegram intake | 1–2 engineers, after G4, G6 and G8 have merged (their bindings get removed) | 3 PRs, as in section 2 | 2 d | about 1,250 |
| Cleanup | 1 engineer | Remove unused imports (about 120 lines); remove the shared maps once they have no readers (`tasks`, `events`, `briefs`, `revisions`, `feedbacks`, `clientDnas`, `decisions`) and their fields in types.ts; system.routes.ts and canva.routes.ts stop reading `ctx.tasks`. Optionally move sessions (1346–1542) to `services/desk-sessions.ts` and health (1545–1869) to `services/health.ts`, adding the latter to the egress allow-list. | 0.5–1 d | about 1,100 without the optional moves, about 600 with them. Target: 1,500 or fewer |

**Why the parallel wave is conflict-free:**
- After F, the eight groups share no helper that any of them moves.
- They delete disjoint line ranges, each separated by a blank line.
- Each group writes only its own new files.
- The only shared counters are the `any` ratchet (budget: no net new `any` per PR) and N1's inventory file, which should not change during moves.

**Truth-holding state and which step removes it:**

| Step | State it removes | Notes |
|---|---|---|
| G1 | `packagedFonts`, `uploadedAssets` | No table exists. Defer to Phase 3.1's blob store, or delete. |
| G1 | `rubricReports` | No table and no Desk caller. Persist to `qc_runs`, or delete. |
| G1 | auth mini-app sessions | Call `persistSession`, not only `saveSession`. |
| G2 | `clientSnapshots`, `clientDnas` | Backed by `client_dna_versions`. |
| G2 | `globalCostGovernor` budgets | No table; flag. |
| G3 | `taskComments` | No table; flag. |
| G3 | `decisions` | `approvals` table exists. |
| G3 | `revisions` | `design_revisions` table exists. |
| G3 | `feedbacks` | `feedback_events` table exists. |
| G5 | `omnichannelReceipts` | `publications` table exists. |
| G5 | `inFlightPublications` | The advisory lock already covers it. |
| G5 | `inMemoryOutbox` | Only used when there is no database. |
| G6 | `workflowControllers` | No table and no Desk caller. Derive from `tasks.state`, or delete. |
| G8 | `channelKillSwitches` | Persist it; this also closes item 0.4. |
| G9 | `pendingClarifications`, `acknowledgedAlbums` | Phase 2.3 replaces the first; `inbox_events` covers the second. |
| Cleanup | `tasks`, `events`, `briefs` | Only once no reader remains. |
| Not covered by any group | `evalRuns` | Evals is already a module; flag for the owner. |

---

### Critical Files for Implementation
- /Users/hawzhin/Hawdesign/apps/core/src/app.ts
- /Users/hawzhin/Hawdesign/apps/core/src/routes/types.ts
- /Users/hawzhin/Hawdesign/apps/core/src/routes/clients.routes.ts
- /Users/hawzhin/Hawdesign/apps/core/src/routes/system.routes.ts
- /Users/hawzhin/Hawdesign/apps/core/test/route-auth-enumeration.test.ts (the template for the N1/N2 route-table tests), together with /Users/hawzhin/Hawdesign/scripts/ratchet_any.ts