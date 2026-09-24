# Phase 2 implementation design: Restate owns the request lifecycle

Base: `studio-v2` at `79b70e0`, read-only. Phase 0 and 1.1 have landed (`git log`: phase 0.1–0.6 merges, `c3e042c`). Phases 1.2 (one status vocabulary) and 1.3 (splitting `app.ts`) have **not** landed: `apps/core/src/app.ts` is still 11,307 lines and holds the 1,650-line Telegram closure (lines 4217–5870).

Because of that, this design depends on Phase 1 only where noted:
- Slice 2.1 can ship before 1.3.
- Slice 2.3 needs a "decide" mode in the Telegram intake. That is much cheaper once 1.3 has moved the intake into its own module.

---

## 1. Today's request life, traced

### 1.1 Step by step

| # | Step | Code (file:line) | Where state lives | What a restart loses | Idempotent by |
|---|---|---|---|---|---|
| 1 | **Poll.** `getUpdates` runs one poll at a time and hands each update to the handler in order. The offset moves only after the handler returns. | Poll loop: `packages/integrations/src/telegram-bridge.ts:265-366` (`pollOnce`, `pollOnceExclusive`, `startPolling:370`). Core wires it up at `app.ts:11249-11290`. `apps/core/src/index.ts:48` hard-codes `enableTelegramPolling: true`. Poll-now route: `routes/system.routes.ts:99`. | Offset: Postgres `hawa.integration_health.cursor_value`, via `PostgresTelegramPollState` (`services/telegram-poll-state.ts:30`). Failed-attempt count: Postgres (`recordFailure`). Poll lock (`pollQueue`) and `lastUpdateId`: memory. **Kill switch: module-level memory** (`app.ts:257` `channelKillSwitches`). | The update being handled is polled again. **The kill switch resets to "on"**, so intake resumes after a restart. | `inbox_events.source_event_id = "<chat>:<update_id>"`, checked by `telegramUpdateHandled` (`app.ts:3575`). |
| 1a | **Hand-off and dead letter.** A failing update is retried, then parked after 5 attempts (about 30 s). | `services/polled-update-dispatch.ts:52-103`; `parkTelegramUpdate:167`. The "deliver" step calls `app.request('/api/webhooks/telegram?generate=true')` in-process (`app.ts:11261`). | `inbox_events` row `parked-update-<id>`; office alert through the outbox `notify.office:telegram-update-parked:<id>`. | Nothing. | The parked row is written once (`WHERE NOT EXISTS`). |
| 2 | **Intake closure.** Order: auth, allowlist, `rq:` buttons (`4247`), refusal of every other callback and of `/approve` (`4255-4274`), edited message (`4278`), duplicate check (`4402-4416`), voice/PDF, reply-target resolution (`4960-5010`), clarification (`5181-5236`), classification (paid), standing rules, then `persistChatIntake`. | `app.ts:4217-5870`; `services/chat-intake.ts:198-270`; `TaskRepository.createTaskAggregate` (`packages/db/src/repositories/task.repository.ts:468-596`). | One transaction writes `tasks` + `task_events(task.created)` + `outbox_commands(task.created)`, under advisory lock `hashtext(idempotencyKey)`. **`pendingClarifications` is memory** (`app.ts:538`, 1 h TTL). **`acknowledgedAlbums` is memory** (`app.ts:536`). The acknowledgement is sent directly, not through the outbox (`app.ts:2485`). | A pending "new or revise?" question: the answer is then misread. Album acks (a second ack per album). An ack whose send was cut off: a retry finds `duplicate:true` and sends none. **Classification is paid again** if Core dies after classifying and before saving. | Outbox key `chat:telegram:<chat>:<update_id>` (payload hash checked). Inbox row `<chat>:<update_id>`, or `<chat>:<update_id>_<suffix>` for answers and sizes. |
| 2a | **Daily cap** | `chat-intake.ts:219-230` counts `outbox_commands WHERE command_type='task.created' AND payload->>'autoGenerate'='true'`. | Postgres. | — | — |
| 3 | **Dispatch** | Outbox consumer (live colour only; `apps/worker/src/index.ts:122-156`, `live-colour.ts`): `task.created`/`task.dispatch` handlers (`outbox-consumer.ts:384-406`). `TaskWorkflowDispatcher.dispatch` (`workflow-dispatcher.ts:46-138`) sends POST `/TaskWorkflow/task-wf-<id>[-redrive-n]/run/send`. Studio re-drive enqueues `task.dispatch` (`app.ts:2616-2660`). | Outbox row plus a 60 s lease. `inFlightSubmissions` is worker memory (harmless). | Nothing: the lease expires and the command is claimed again. | The workflow key (Restate answers 409 for a second start). |
| 4 | **Design run** | `TaskWorkflow.run` (`worker/src/index.ts:102-114`) calls `runCanvaDraft` (`canva-draft-workflow.ts:245-568`). Every step is an HTTP call to Core carrying `Idempotency-Key` (`workflow-studio-<runKey>`, `workflow-studio-resume-<runKey>-<runId>-<n>`, `workflow-preview-<runKey>`, `workflow-check-<runKey>`, `workflow-<runKey>`). Retry: `CORE_STEP_RETRY`, 10 min (`index.ts:51`). | Restate journal. Core persists studio stages, Canva operations, `design_studio_calls` (the cost ledger) and `canva_export_bytes`. | A worker kill replays from the journal. Since 0.1, a deploy leaves the run pinned to the old colour. | Core idempotency keys per step. **Exception: the parity check** (`:536-545`) is not deduplicated and is capped at 5 attempts. |
| 5 | **Outcome back to Core** | `reportOutcome` retries for 1 h (`canva-draft-workflow.ts:150-161`), POST `/v1/tasks/:id/notifications/canva-status` → `canvaStatusHandler` (`app.ts:7756-8102`). It bridges the revision and QC (`canva-task-outcome.ts:265`), transitions state (`:85`), writes `notify.telegram` to the outbox, **then sends inline** (`app.ts:8012`) with `availableAt+60s`, and **sends photos directly** (`8069`, `8086`). If Core stays down past the hour: `outcome-without-core.ts:42-108` writes the requester message, an office alert and `task.outcome`, and the outbox handler re-posts (`outbox-consumer.ts:443-466`). | Postgres: `design_revisions`, `qc_runs`, `tasks.state`, outbox. `tasks` memory map updated as a side copy (`7884`, `7925`). | **The photos**: a crash between the text and the photos loses them, and a retry deduplicates on the text key and returns before the photos. | `notify.telegram:<taskId>:<STATUS>[:<CODE>]:<runId or designId>` (`app.ts:7954`). |
| 6 | **Questions** | (a) Classifier "new or revise?": memory map (step 2). (b) Studio `NEEDS_CLARIFICATION`: the task goes `paused`, the question sits in `design_studio_runs.stages.directed.clarify`, and the message is part of step 5. `pendingQuestion` (`app.ts:3912`) re-derives it with SQL. An answer arrives by reply (`4983-4998`) or button `rq:a1..a3` (`requester-actions.ts:58`) → `answerQuestion` (`3953`), which creates a new revision task and `closeAnsweredQuestion`. | (a) memory; (b) Postgres, inferred from 4 joins. | (a) lost; (b) nothing. | `persistChatIntake` key `<chat>:<update>_answer_<taskId>`. |
| 7 | **Requester buttons** | `rq:<action>:<taskId>`: stateless, since the task id is in the callback data (`requester-actions.ts:17`). Handled at `app.ts:3674-3788`: ok, chg, dsg, sizes (`makeOtherSize:3811`). **`act:` tokens**: the `activeTokens` / `consumedTokens` maps are memory (`integrations/src/telegram-security.ts:57-60`), so a restart kills them. Separately, **`app.ts:4255` refuses every non-`rq:` callback before the `act:` branch at `4305` can run**, so that branch is dead code. | `inbox_events` kinds `telegram_requester_*`; outbox office alerts. | `act:` tokens (unreachable anyway). | `inbox_events <chat>:<update>`; office key `notify.office:requester-approved:<taskId>`. |
| 8 | **Office decisions in the Desk** | Approve/revise: POST `.../revisions/:revisionId/decisions` (`app.ts:8408`). Guard `pendingChangeOf` (`4068`, used at `8536`); `expectedTaskVersion` is compared with `readCurrentTask` (`~8548`). Deliver: POST `/tasks/:id/publish` (`7308`), which calls `reopenInterruptedDelivery` (`4088`) and `changeBlockingDelivery` (`4106`). The Desk sends **no idempotency key** for either (`apps/desk/src/api/client.ts:470-486`). | `approvals`, `tasks` (Postgres). The rule "a change is pending" is recomputed from SQL at 3 sites. | Nothing durable. A double click can race. | None at the HTTP layer. `tasks.version` check only when the Desk sends it. |
| 9 | **Delivery** | `executeOmnichannelPublish` (`2970`) marks the task in `deliveriesInFlight` (**memory Set**, `2968`), then `deliverOmnichannel` (`2986-3440`): approved→publishing, publication row keyed `pub_key_<taskId>_<approvalId>` (`3119`), Drive/Sheets, **`notify.published`** outbox (`3352-3392`, key `deliveredNotificationKey`, `services/delivery-notification.ts:46`), completion. Worker: `notify.published` handler (`outbox-consumer.ts:475-581`) with send marks in `inbox_events` (`worker/src/delivery-notification.ts:86-126`). `inFlightPublications` is a memory Map (`726`). | Postgres (publications, outbox, send marks), plus memory. | **A task stuck in PUBLISHING** until someone presses Deliver again (`reopenInterruptedDelivery` checks the memory Set). | Publication key; outbox key; send marks `<commandId>:<artifactId|notice>` (sent / attempted / uncertain). |
| 10 | **Reminders** | `setInterval` every 15 min (`app.ts:11212-11221`) → `remindUnansweredDrafts` (`services/draft-reminders.ts:163-214`) → outbox `notify.telegram`. | Derived from SQL each pass (`draftsToRemind:124`, `questionsToRemind:70`). | Nothing, but it runs only in Core and only in office hours at pass time. | `notify.telegram:reminder<day>:<taskId>`, `notify.telegram:question-reminder<day>:<taskId>`. |

### 1.2 Findings that shape the design

1. **Legacy SQL treats outbox rows as facts.** At least these read `outbox_commands(task.created)` to get the request payload, the chat and the parent chain:
   - `replyDesign` (app.ts:4043), `pendingQuestion` (3912), `questionFollowUp`, `pendingChangeOf` (4068), `askHistory`, `handleRequesterAction` facts (3693-3706)
   - `askLedger`, `draftsToRemind`, `questionsToRemind`
   - `findRequestAwaitingReference`, `findAlbumRequest`
   - the **daily cap** (`chat-intake.ts:221`)

   These read `notify.telegram` rows whose `status='CANVA_DRAFT_READY_FOR_VISUAL_REVIEW'` and `state='delivered'` to mean "the draft was sent": `draftsToRemind:133`, `questionsToRemind:81`, `replyDesign` "finished" (~4052), the "newer ready" check at 3731, the Canva URL lookup at 3700.

   **Consequence:** tasks owned by the lifecycle must still get a `task.created` outbox row (marked not dispatchable), and a sent draft must be projected as a `notify.telegram` row with `state='delivered'`. Otherwise every legacy query breaks for them. Section 2.8 covers this.
2. **The worker's database identity is the Art Director.** It uses userId `00000000-0000-4000-b000-000000000002` (`worker/src/index.ts:164`, `outbox-consumer.ts:309`, `outcome-without-core.ts:47`). The contracts name that id `ART_DIRECTOR_USER_ID` (`packages/contracts/src/identities.ts:15`). New worker writes must use `SYSTEM_AUTOMATION_USER_ID`.
3. **The worker's token is the operator's token.** `HAWA_BEARER_TOKEN` maps to `role:'operator'`, the same as `HAWA_API_KEY` and `HAWA_DESK_SECRET` (`app.ts:1510-1525`). Internal lifecycle endpoints need their own `HAWA_WORKER_TOKEN` that maps to a `service` role.
4. **The Telegram API base URL is hard-coded in 15 places** (telegram-bridge.ts:291, 402, 407, 430, 463, 491, 673, 713, 728, 775, 845; app.ts:1701; system.routes.ts:550, 577; creative cost-architecture-v3.ts:292). **`dispatchOutboundMessage` hides `retry_after`**: a 429 comes back as `TELEGRAM_REJECTED_429` (`telegram-bridge.ts:740`).
5. **Model API base URLs are hard-coded too** (model-gateway.ts:486/583/662, canva-design-planner.ts:381, telegram-classifier.ts:450, creative studio). `CANVA_BASE_URL` and `GOOGLE_DRIVE_API_BASE_URL` / `GOOGLE_SHEETS_API_BASE_URL` are configurable. This drives the choice of chaos-harness transport (section 6).
6. **`inbox_events UNIQUE (integration_id, source_account_id, source_event_id)` does not deduplicate.** `integration_id` is always NULL and NULLs are distinct, so all deduplication is `WHERE NOT EXISTS` and races across processes. Per-chat serialisation in `ChatInbox` removes the race within a chat.
7. **Removing a service from the worker build breaks blue/green.** `scripts/restate-bluegreen.ts:15-17,180` shows Restate keeps a service the new build does not host on the old deployment, and `finishDrains` refuses to delete a deployment that any service still routes to. So a service can never be removed from the build; it can only become a shim. `WORKER_SERVICES` (`:180`) and `LiveColourGate` (`live-colour.ts:29`, which reads `GET /services/TaskWorkflow`) must learn the new services.

---

## 2. Target components

**Code layout (new):**
- `packages/contracts/src/lifecycle.ts`: payload types shared by Core and the worker.
- `packages/domain/src/request-lifecycle.ts`: the pure state machine, with no SDK and no HTTP (AGENTS.md: "domain logic independent of HTTP… storage").
- `packages/domain/src/office-hours.ts`
- `apps/worker/src/lifecycle/`: `chat-inbox.ts`, `request-lifecycle.ts`, `design-run.ts`, `delivery.ts`, `telegram-sender.ts`, `telegram-poller.ts`, `core-client.ts`, `shims.ts`
- `apps/core/src/routes/lifecycle-internal.routes.ts`

### 2.1 Shared payload types (`packages/contracts/src/lifecycle.ts`)

```ts
export type LifecycleOwner = 'core' | 'restate';
export interface Versioned { v: 1 }                       // every handler input; fields only ever added, optional

export interface OutboundMessage {
  key: string;                                            // deterministic, see 2.9
  chatId: string;
  kind: 'text' | 'photo' | 'document' | 'callback_answer';
  text?: string; parseMode?: 'HTML'; replyMarkup?: unknown;
  exportRef?: { tenantId: string; taskId: string; artifactId: string; sha256: string }; // bytes read by the sender, never journaled
  filename?: string; caption?: string; mimeType?: string;
  callbackQueryId?: string;
  class: 'critical' | 'courtesy';                         // critical = fenced by send marks, uncertain → office alert
  onSent?: { requestId: string; what: 'draft' | 'question' | 'reminder' | 'delivery_notice' | 'ack'; taskId: string };
}

export interface DraftIntake {                            // what Core's classifier decided a new request is; no image bytes
  title: string; rawText: string; clientId: string | null;
  headlineEn?: string; headlineCkb?: string; copyEn?: string; copyCkb?: string;
  designInstructions: string; exactCopy: unknown[];
  autoGenerate: boolean; variant?: { width: number; height: number };
  designStudio?: boolean; studioOptions?: Record<string, unknown>;   // referenceImageBase64 forbidden here
  photoFileIds?: string[];                                // Telegram file_ids; Core downloads them
}

export type IntakeDecision =
  | { kind: 'handled'; messages?: OutboundMessage[] }                   // legacy path or rule/command done in Core
  | { kind: 'clarify'; remember: PendingClarification; messages: OutboundMessage[] }
  | { kind: 'new_request'; requests: Array<{ index: number; draft: DraftIntake }>; messages?: OutboundMessage[] }
  | { kind: 'answer'; requestId: string; questionId: string; answer: { text?: string; option?: number; photoFileIds?: string[] }; callbackQueryId?: string }
  | { kind: 'requester'; requestId: string; taskId: string; action: 'ok' | 'chg' | 'dsg' | 'sst' | 'ssq' | 'sls'; callbackQueryId?: string; actorId: string }
  | { kind: 'change'; requestId: string; replyToTaskId: string; directive: string; photoFileIds?: string[] }
  | { kind: 'park'; reason: string };

export interface PendingClarification { rawText: string; photoFileIds?: string[]; taskId?: string; askedAt: number; updateId: number }
```

### 2.2 ChatInbox (Virtual Object, key = Telegram chat id) and the poller

```ts
// apps/worker/src/lifecycle/chat-inbox.ts
export interface HandleUpdateInput extends Versioned { update: TelegramUpdate; polledAt: number }
export interface ChatInboxState { v: 1; pendingClarification?: PendingClarification; albumsAcked?: Record<string, number> }

export const ChatInbox = restate.object({
  name: 'ChatInbox',
  handlers: {
    handleUpdate: restate.handlers.object.exclusive(
      { idempotencyRetention: { days: 7 }, journalRetention: { days: 1 } },
      async (ctx: restate.ObjectContext, u: HandleUpdateInput): Promise<{ outcome: 'routed'|'handled'|'parked'|'duplicate' }> => {...}),
    get: restate.handlers.object.shared(async (ctx) => ChatInboxView),
  },
  options: { inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 10 },
             retryPolicy: { initialInterval: 2000, exponentiationFactor: 2, maxInterval: 30000, maxAttempts: 500, onMaxAttempts: 'pause' } },
});
```

**`handleUpdate` algorithm:**
1. Read the mode inside a journaled step:
   ```ts
   const mode = await ctx.run('mode', () => lifecycleOwnsChat(chat, process.env) ? 'lifecycle' : 'legacy')
   ```
   This is the **one read of the per-chat flag**. It is journaled so that a replay on another colour agrees.
2. Call intake using the `runUnlessBusy` pattern (`canva-draft-workflow.ts:179`): for `k = 0..4`, run
   ```ts
   ctx.run(`intake-${k}`, () => core.intake({ update, mode, chat: state }))
   ```
   - Inside the step, Core 503 `DATABASE_UNAVAILABLE` throws `RetryableError`. It is not journaled, so it retries without limit, capped at 30 s intervals. This matches today's rule "a database outage never dead-letters".
   - Any other 5xx, 408, 429 or network error returns `{ retryable: true, reason }` as the journaled value. The loop then does `ctx.sleep(2**k s)` and moves to step `k+1`. The chat is pinned for at most about 30 s, the same as today's bound.
   - A 4xx returns final.
   - After 5 retryable answers, the decision is `park`.
3. Route the decision with **one-way sends only**:
   ```ts
   ctx.objectSendClient(RequestLifecycle, requestId).open|answer|requesterDecision(evt, rpc.sendOpts({ idempotencyKey }))
   ```
   - `requestId` for a new request is `uuidFromKey(\`req:${chat}:${update_id}:${index}\`)`, using the same v5-style hash as `updateAggregateId` in `polled-update-dispatch.ts:147`.
   - `messages` go to `ctx.objectSendClient(TelegramSender, m.chatId).send(m, {idempotencyKey: m.key})`.
   - `clarify` sets `pendingClarification`. Every other decision clears it. This replaces `app.ts:538` / `5181-5236`.
   - Albums replace `app.ts:536` and are pruned after 15 min.
4. Parking: `ctx.run('park', () => core.park(update, reason))` (Core runs `parkTelegramUpdate`, unchanged), then a courtesy `PARKED_UPDATE_NOTICE` to the sender through TelegramSender.

**Poller** (`apps/worker/src/lifecycle/telegram-poller.ts`) runs **only in the live colour**, through `runWhileLive` / `LiveColourGate` (`live-colour.ts`), the same gate as the outbox:
- Loop: check the kill switch (Postgres `integration_health.state='disabled'` on the telegram `office-kill-switch` row, cached 5 s). Then `getUpdates?offset=N+1&timeout=25`.
- For each update, in order: POST `${RESTATE_INGRESS_URL}/ChatInbox/${encodeURIComponent(chatKey(update))}/handleUpdate/send` with header `idempotency-key: tg-<update_id>`.
  - On 2xx, `setOffset(update_id)`, reusing `PostgresTelegramPollState` moved to `packages/db/src/telegram-poll-state.ts`.
  - Otherwise stop the batch and back off.
- `chatKey` is `message|edited_message|channel_post|callback_query.message.chat.id`, else `from.id`, else `misc`. This is the logic of `updateOrigin`, `polled-update-dispatch.ts:120`.
- On 429 from `getUpdates`, sleep `retry_after`.

### 2.3 RequestLifecycle (Virtual Object, key = request id)

**Request id.** One request is the chain of rounds of one design. Each round keeps its own `tasks` row, exactly as today, because the Desk and the ledger read tasks. A size (`sst`/`ssq`/`sls`) is a **new request** with `parentRequestId`.

**State** (a single key `lc`, kept small: no image bytes, texts capped):

```ts
export type Stage = 'designing' | 'awaiting_answer' | 'in_review' | 'manual' | 'approved'
                  | 'delivering' | 'delivered' | 'expired' | 'cancelled';

export interface LifecycleStateV1 {
  v: 1;
  requestId: string; tenantId: string; clientId: string | null; chatId: string | null;
  owner: 'restate';
  origin: { kind: 'telegram'; chatId: string; updateId: number } | { kind: 'size'; parentRequestId: string; action: string };
  rev: number;               // +1 per accepted transition = projection's expected revision
  stage: Stage;
  stageEpoch: number;        // +1 per stage change; delayed events carry it
  stageSince: number;        // ctx.date.now()
  round: number;             // 0 = first design
  rounds: Array<{ round: number; taskId: string; kind: 'design'|'change'|'answer';
                  runId?: string; runAttempt: number; runInvocationId?: string;
                  outcome?: { status: string; code?: string; designId?: string; revisionId?: string } }>; // ≤ 12, older compacted
  question?: { id: string; taskId: string; question: string; options: string[]; askedAt?: number };
  draft?: { taskId: string; revisionId?: string; designId?: string; sentAt?: number };
  requester: { signedOff?: { taskId: string; at: number }; designerAsked?: { at: number } };
  approval?: { approvalId: string; taskId: string; revisionId: string; actionId: string; at: number };
  delivery?: { deliveryId: string; approvalId: string; startedAt: number; outcome?: 'delivered'|'chat_only'|'uncertain'|'failed'; sheetsConfirmed?: boolean };
  reminders: string[];       // 'draft:1:<taskId>', 'question:5:<qid>', …
  outcomeDeferred?: { runId: string; since: number };  // Core down past the projection window
  sizes: Record<string, string>;                         // action -> child requestId
  seen: string[];            // last 64 event ids (dedupe beyond idempotency retention)
}
```

**Handlers.** All are exclusive except `get`. Each runs for seconds and never awaits another object or a workflow.

```ts
open(ctx, e: OpenEvent): Promise<{ accepted: boolean; taskId?: string }>
  // OpenEvent = Versioned & { eventId; requestId; tenantId; chatId: string|null; origin; draft: DraftIntake; parentRequestId?; parentTaskId? }
designFinished(ctx, e: Versioned & { eventId: `dr-finished:${runId}`; runId; round; taskId; report: CanvaStatusReport }): Promise<void>
answer(ctx, e: Versioned & { eventId; questionId; answer; callbackQueryId?; actorId }): Promise<void>
requesterDecision(ctx, e: Versioned & { eventId; taskId; kind: 'ok'|'chg'|'dsg'|'size'|'change'; sizeAction?; directive?; photoFileIds?; callbackQueryId?; actorId }): Promise<void>
officeDecision(ctx, e: Versioned & { eventId: `desk:${actionId}`; actionId; actor: { userId; role };
               kind: 'approve'|'revise'|'reject'|'deliver'|'redrive'|'draftCaptured'|'cancel'|'retryArchive';
               taskId; revisionId?; expectedRev?; approval?: ApprovalDraft; comment? }): Promise<OfficeDecisionResult>
  // OfficeDecisionResult = { accepted: true; rev; stage } | { accepted: false; code: 'STALE_REVISION'|'CHANGE_PENDING'|'WRONG_STAGE'|'NOT_CURRENT_DRAFT'; message }
deliveryFinished(ctx, e: Versioned & { eventId: `dl-finished:${deliveryId}`; deliveryId; outcome; uncertain: string[]; sheetsConfirmed: boolean }): Promise<void>
messageSent(ctx, e: Versioned & { eventId: `sent:${key}`; key; what; taskId; at; messageId?: string; uncertain?: boolean }): Promise<void>
remind(ctx, e: Versioned & { eventId; kind: 'draft'|'question'; day: 1|5; stageEpoch; taskId }): Promise<void>
expire(ctx, e: Versioned & { eventId; stageEpoch }): Promise<void>
cancel(ctx, e: Versioned & { eventId; by: 'office'|'requester'; actor?; reason? }): Promise<void>
retryProjection(ctx, e: Versioned & { eventId; runId }): Promise<void>
get: shared → LifecycleView  // { requestId, stage, rev, round, currentTaskId, question?, draft?, approval?, delivery? }
```

Service options:
```ts
{ journalRetention: { days: 7 }, idempotencyRetention: { days: 7 },
  inactivityTimeout: { minutes: 1 }, abortTimeout: { minutes: 5 },
  retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60000, maxAttempts: 300, onMaxAttempts: 'pause' } }
```

**Handler template.** The pure part lives in the domain package:

```ts
export function plan(s: LifecycleStateV1 | undefined, ev: LifecycleEvent, now: number): Plan
export function apply(s, ev, projected: ProjectionResult, now): { next: LifecycleStateV1; effects: Effect[]; reply?: unknown }
```

The shell in the worker:
1. `s = upgrade(await ctx.get('lc'))`, `now = await ctx.date.now()`.
2. If `s.seen` contains `ev.eventId`, return the stored or neutral reply.
3. `p = plan(s, ev, now)`. If `p.ignored`, log and return.
4. Project, when `p.ops.length`:
   ```ts
   r = await ctx.run(`project:${s.rev + 1}`, () => core.project(requestId, { expectedRev: s.rev, rev: s.rev + 1, key: `${requestId}:${s.rev + 1}:${ev.type}`, ops: p.ops }), PROJECT_RETRY)
   ```
5. `{ next, effects } = apply(...)`, then `ctx.set('lc', next)`.
6. Emit effects in order. Allowed effects:
   - `send` → `ctx.objectSendClient(TelegramSender, chat).send(m, {idempotencyKey: m.key})`
   - `startDesignRun` → `ctx.workflowSendClient(DesignRun, runId).run(input)`; store its `invocationId`
   - `startDelivery` → `ctx.workflowSendClient(Delivery, deliveryId).run(...)`
   - `schedule` → `ctx.objectSendClient(RequestLifecycle, id).remind|expire(evt, rpc.sendOpts({ delay, idempotencyKey }))`
   - `openChild` → `objectSendClient(RequestLifecycle, childId).open(...)`
   - `cancelRun` → `ctx.cancel(invocationId)`

**State machine.** "Proj" is the ops that `plan` returns. Effects are sends.

| Stage (from) | Event | Guard | Proj ops (one Core transaction) | Next stage | Effects |
|---|---|---|---|---|---|
| — | `open` | no state yet | `createRequest` (requests row owner=restate + round-0 task via `persistChatIntake`, the `task.created` outbox row **recorded, not pending**) → `{taskId, autoGenerate, autoGenerateDeclined, messages(ack)}` | `designing` if autoGenerate and a client, else `manual` | ack messages; `startDesignRun(dr-<taskId>)` |
| `designing` | `designFinished` | `e.runId === rounds[round].runId` (else ignored: stale run) | `recordOutcome{taskId, report}` → `{hasDraft, revisionId, toState, question?, messages, officeAlerts}` | draft → `in_review`; `NEEDS_CLARIFICATION` with a question → `awaiting_answer`; otherwise `manual` | messages (draft link and photo with `onSent:'draft'`, or question with `onSent:'question'`); alerts to the office chat |
| `designing` | `designFinished` | Core does not answer for `PROJECT_RETRY` (30 min) | — (step gave up) | unchanged; `outcomeDeferred` | the `composeOutcomeUnrecorded*` texts to the requester and office (critical); `schedule retryProjection` in 10 min |
| `awaiting_answer` | `answer` | `questionId === s.question.id` | `createRound{kind:'answer', parentTaskId, answers: question.taskId, directive+answer, photoFileIds}` + `closeQuestion` → `{taskId, messages}` | `designing` (round+1) | "Got it" / cap notice; callback answer; `startDesignRun` |
| `in_review` | `requesterDecision ok` | `taskId === draft.taskId` (else Core composes "newer version exists" / "change in progress") | `recordRequesterAction{ok}` → `{messages, officeAlert}` | `in_review` (signedOff) | ack + office alert (`notify.office:requester-approved:<taskId>`) |
| `in_review` | `requesterDecision chg` | same | `recordRequesterAction{chg}` | `in_review` | change prompt |
| `in_review` | `requesterDecision change` (a typed reply with directive) | `replyToTaskId` resolves to `draft.taskId` (Core's `replyDesign`) | `createRound{kind:'change', parentTaskId: draft.taskId, directive}` | `designing` (round+1) | ack; `startDesignRun` |
| `in_review`, `expired` | `requesterDecision dsg` | — | `recordRequesterAction{dsg}` + office handoff (askHistory) | `manual` | messages |
| `in_review`, `approved`, `delivered` | `requesterDecision size` | v3 chat; `sizes[action]` unset | `recordRequesterAction{size}` | unchanged | `openChild(uuidFromKey(req:size:<requestId>:<action>))` with `origin.kind='size'` |
| `in_review` | `messageSent draft` | `taskId === draft.taskId` | `recordDraftSent` (writes `notify.telegram` row `state='delivered'`) | same | `schedule remind{draft, day 1}` at `nextOfficeMoment(sentAt+24h)`; `schedule expire` at `sentAt+14d` |
| `awaiting_answer` | `messageSent question` | question id matches | `recordQuestionSent` | same | `schedule remind{question, day 1}` |
| `in_review`, `awaiting_answer` | `remind` | `stageEpoch` matches; key not in `reminders` | `composeReminder{taskId, kind, day}` → `{skip, message}`; skip when the requester wrote in the chat since sentAt (today's `NOT EXISTS inbox_events`) | same | reminder; day 1 → `schedule day 5` at `nextOfficeMoment(sentAt+5d)` |
| `in_review`, `awaiting_answer` | `expire` | `stageEpoch` matches | `transition{paused or keep, note}` | `expired` | office alert |
| `in_review`, `expired` | `officeDecision approve` | `taskId===draft.taskId && revisionId===draft.revisionId`; no open change round; `expectedRev` (when given) `=== s.rev` | `recordApproval{taskId, revisionId, approval}` → `{approvalId}` | `approved` | — |
| `in_review` | `officeDecision revise` | same task | `transition revision_requested` | `manual` | — |
| `manual` | `officeDecision draftCaptured` | taskId in rounds | `bridgeCapturedRevision` | `in_review` | draft message (optional) |
| `manual` | `officeDecision redrive` | no live run | `prepareRedrive{taskId}` (abandons a stale studio run, as `app.ts:2626-2646` does) | `designing` | `startDesignRun(dr-<taskId>-a<n>)` |
| `approved` | `officeDecision deliver` | approvalId matches; no open change round | `transition approved→publishing` | `delivering` | `startDelivery(dl-<requestId>-<approvalId>)` |
| `delivering` | `deliveryFinished` | deliveryId matches | `recordDelivery{outcome, sheetsConfirmed}` | `delivered` | office alert if `uncertain` or `failed` |
| `delivered` | `officeDecision retryArchive` | `!sheetsConfirmed` | — | `delivering` | `startDelivery(…:archive:<n>)` |
| any non-terminal | `cancel` | — | `transition cancelled` | `cancelled` | `cancelRun` when designing |
| any | an event not listed | — | — | unchanged (ignored and logged; a `officeDecision` returns `WRONG_STAGE`) | — |

"One place decides a change is pending" is the guard *open change round* (`rounds[round].kind ∈ {change, answer}` and not finished). It replaces `pendingChangeOf` at `app.ts:4068/4106/8536` for lifecycle-owned requests.

### 2.4 DesignRun (Workflow, key = `dr-<taskId>[-a<n>]`)

```ts
export interface DesignRunInput extends WorkflowInput, Versioned {
  lifecycle: { requestId: string; round: number; runId: string };
}
export const DesignRun = restate.workflow({
  name: 'DesignRun',
  handlers: { run: async (ctx: restate.WorkflowContext, input: DesignRunInput): Promise<WorkflowOutput> => … },
  options: { ingressPrivate: true, workflowRetention: { days: 7 }, abortTimeout: { minutes: 10 } },
});
```

- It reuses `runCanvaDraft` unchanged apart from one new optional parameter:
  ```ts
  report?: (status: string, body: Record<string, unknown>) => Promise<void>
  ```
- When `report` is present, `finish()` (`canva-draft-workflow.ts:313-337`) calls it **instead of** `reportOutcome` + `recordWithoutCore`. `report` is:
  ```ts
  ctx.objectSendClient(RequestLifecycle, requestId).designFinished({ v: 1, eventId: `dr-finished:${runId}`, runId, round, taskId, report: body }, rpc.sendOpts({ idempotencyKey: `dr-finished:${runId}` }))
  ```
  It is journaled and exactly-once, so there is no Core dependency and no one-hour window.
- `runKey` is still `taskId` or `taskId-redrive-n` (pass `redriveAttempt`), so Core's studio and Canva idempotency keys are identical to today's.
- On cancellation (`TerminalError` with code 409 at the next await), catch it, run `abandonUnsettledRun`, then `finish('CANCELLED')`. RL ignores that report.
- **`TaskWorkflow` stays registered for good.** It serves legacy requests until 2.5, then becomes a shim (section 4). The gate and `WORKER_SERVICES` go on using it.

### 2.5 Delivery (Workflow, key = `dl-<requestId>-<approvalId>[:archive:<n>]`)

```ts
export interface DeliveryInput extends Versioned { requestId: string; deliveryId: string; tenantId: string; taskId: string;
  approvalId: string; revisionId: string; chatId: string | null; officeChatId: string | null; reportTo: 'lifecycle' | 'core' }
export type DeliveryOutcome = { outcome: 'delivered'|'chat_only'|'uncertain'|'failed'; uncertain: string[]; sheetsConfirmed: boolean; reason?: string };
```

1. Prepare:
   ```ts
   prepared = await ctx.run('prepare', () => core.post(`/v1/internal/lifecycle/${requestId}/deliveries/${approvalId}/prepare`), CORE_STEP_RETRY)
   ```
   This is `deliverOmnichannel` without the transition to `publishing` and without the `notify.published` enqueue. It runs Drive and Sheets, both idempotent through `pub_key_<taskId>_<approvalId>`. It returns `{ files: DeliveredFileRef[], chatOnly, archiveProblem?, sheetsConfirmed, title, driveFolderId, spreadsheetId, sheetRowNumber }`. If this step gives up, the delivery is reported `failed`.
2. For each file, send the document through the chat's TelegramSender. The **awaited call** is allowed because this is a workflow, not a Virtual Object:
   ```ts
   r = await ctx.objectClient(TelegramSender, chatId).send({ key: `${deliveryId}:file:${artifactId}`, kind: 'document', exportRef, filename, class: 'critical' })
   ```
3. Send the notice. Its text is `composeDeliveredMessage` (already in `worker/src/delivery-notification.ts:151`) with the sent and uncertain counts. Key: `${deliveryId}:notice`.
4. Report. `reportTo:'lifecycle'` sends `RequestLifecycle.deliveryFinished`. In slice 2.2 only, `reportTo:'core'` posts `/v1/internal/tasks/:taskId/delivery-finished` (see 3.2).

### 2.6 TelegramSender (Virtual Object, key = chat id)

```ts
export type SendResult = { outcome: 'sent'; messageId?: string } | { outcome: 'uncertain'; error: string } | { outcome: 'refused'; error: string };
export const TelegramSender = restate.object({
  name: 'TelegramSender',
  handlers: { send: async (ctx: restate.ObjectContext, m: OutboundMessage & Versioned): Promise<SendResult> => … },
  options: { ingressPrivate: false /* Core's office alerts in 2.5 */, idempotencyRetention: { days: 7 },
             retryPolicy: { initialInterval: 1000, exponentiationFactor: 2, maxInterval: 60000, maxAttempts: 200, onMaxAttempts: 'pause' } },
});
```

`send` does its work in one `ctx.run('send', …)`. The fence for critical messages reuses `readSendMarks` / `writeSendMark` (`worker/src/delivery-notification.ts:86-126`) with `commandId = "lc:" + m.key`:

1. Read the marks for the key.
   - `sent`: return the stored result.
   - `attempted` or `uncertain`: return `{uncertain}` and **do not send again**.
2. Write `attempted`.
3. Send through the bridge. Bytes come from `readStoredExportBytes` (`:50`) and are checked against `sha256`.
4. Classify the answer:
   - success: mark `sent`.
   - **429**: mark `failed`, then `throw new restate.RetryableError('TELEGRAM_RATE_LIMITED', { retryAfter: retry_after * 1000 })`.
   - pre-connection error or 5xx: mark `failed` and throw (retried).
   - `DELIVERY_UNCERTAIN` or `RECEIPT_INVALID`: mark `uncertain` and return uncertain.
   - 400 or 403 (bot blocked, chat not found): mark `failed` and return refused.

After the step:
- If critical and uncertain, and this chat is not the office chat: `ctx.objectSendClient(TelegramSender, office).send(alert, { idempotencyKey: m.key + ':uncertain-alert' })`, using `composeMessageUncertainAlert` / `composeDeliveryUncertainAlert`.
- If `m.onSent` is set: `objectSendClient(RequestLifecycle, onSent.requestId).messageSent(...)`.

Courtesy messages (acks, callback answers) skip the marks: they accept Telegram's own at-least-once window.

Needed change in `telegram-bridge.ts:740,845`: on 429 return `{ success:false, error:'TELEGRAM_RATE_LIMITED', retryAfterSeconds: body.parameters.retry_after }`.

### 2.7 Reminders

`packages/domain/src/office-hours.ts`:
```ts
export function nextOfficeMoment(atMs: number, zoneOffsetH = 3, open = 9, close = 20): number
```
It returns `atMs` when that falls inside office hours, otherwise the next 09:00 Erbil time. It is the same window as `inOfficeHours`, `draft-reminders.ts:119`.

Delays are `nextOfficeMoment(sentAt + 24h) - now` and `nextOfficeMoment(sentAt + 5d) - now`; expiry is at `sentAt + 14d`. Time comes only from `ctx.date.now()`, which is journaled.

A test override `HAWA_LIFECYCLE_REMINDER_SCALE` (for example `0.0001`) is read once per invocation inside `ctx.run('config')`. The chaos suite uses it.

### 2.8 Core internal API, Postgres and RLS

**None of these endpoints exists today.** The nearest things:
- `canva-status` (`app.ts:8103`) is idempotent only by its outbox key and sends messages itself.
- `TaskRepository.transitionState({expectedVersion})` (`task.repository.ts:598`) supports optimistic concurrency, but no HTTP route exposes it with a key.
- The decisions route's `expectedTaskVersion` compares against `tasks.version`, which comments and other writes also bump.

Everything below is new, in `apps/core/src/routes/lifecycle-internal.routes.ts`, authenticated by `HAWA_WORKER_TOKEN`, with RLS context `{tenantId: from body (the RL state), userId: SYSTEM_AUTOMATION_USER_ID, role: 'operator'}`.

| Endpoint | Purpose | Built from |
|---|---|---|
| `POST /v1/internal/telegram/intake` `{update, mode, chat}` → `IntakeDecision` | 2.1: forwards to the existing closure. 2.3: decide mode. | `app.ts:4217-5870` / the 1.3 module |
| `POST /v1/internal/telegram/park` | Dead-letter an update. | `parkTelegramUpdate` |
| `POST /v1/internal/lifecycle/:requestId/project` `{expectedRev, rev, key, tenantId, ops: ProjectionOp[]}` → `{status:'applied'|'replayed', results}` | The **only** lifecycle writer. | new |
| `GET /v1/internal/lifecycle/:requestId` | Postgres view for reconciliation. | new |
| `POST /v1/internal/lifecycle/:requestId/deliveries/:approvalId/prepare` | Delivery step 1. | `deliverOmnichannel` (`2986-3340`) |
| `POST /v1/internal/tasks/:taskId/delivery-finished` | Slice 2.2 only. | new |

`ProjectionOp` is one of:
`createRequest | createRound | recordOutcome | recordRequesterAction | recordDraftSent | recordQuestionSent | closeQuestion | composeReminder | recordApproval | bridgeCapturedRevision | prepareRedrive | transition | recordDelivery`.

`recordOutcome` is `canvaStatusHandler` (`7756-8102`) with its sends removed. It returns the composed text, the photo as an `exportRef` (never bytes), and the office alerts as messages.

**How `project` behaves.** In one transaction:
1. `SELECT … FROM hawa.requests WHERE request_id=$1 FOR UPDATE`.
2. If the key exists in `lifecycle_projections`, return the stored result (`replayed`).
3. If `requests.rev ≠ expectedRev`, answer **409 `STALE_REVISION`** with `{pgRev}`, or `AHEAD` when `pgRev > rev` (the case after a Restate restore).
4. Apply the ops. Each op uses `taskRepo.transitionState` with `fromState` and `expectedVersion`, read under the same lock.
5. Set `requests.rev = rev`; insert `lifecycle_projections(key, result)`.
6. Commit, then `broadcast('task:*')` for the Desk.

The worker treats 409 as terminal. On `AHEAD` it runs a reconciliation handler: it re-reads the Postgres rev and sets `s.rev = pgRev` (for example after a Restate restore) and alerts the office. On `STALE_REVISION` it pauses and alerts, because that can only mean two writers.

**Migration** `packages/db/migrations/019_request_lifecycle.sql`, mirrored in `db/schema.sql`, `db/rls.sql` and `db/03-grants.sql`:

```sql
CREATE TABLE hawa.requests (
  request_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hawa.tenants(id),
  root_task_id uuid NOT NULL, current_task_id uuid NOT NULL, parent_request_id uuid,
  owner text NOT NULL CHECK (owner IN ('core','restate')), stage text NOT NULL, rev bigint NOT NULL DEFAULT 0,
  chat_id text, draft_sent_at timestamptz, question_asked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, root_task_id) REFERENCES hawa.tasks(tenant_id, id));
ALTER TABLE hawa.tasks ADD COLUMN request_id uuid;                          -- NULL = legacy (owner core)
CREATE INDEX tasks_request_idx ON hawa.tasks(tenant_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE hawa.lifecycle_projections (
  tenant_id uuid NOT NULL, request_id uuid NOT NULL, rev bigint NOT NULL, idempotency_key text NOT NULL,
  result jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, idempotency_key));
-- kill switch survives restarts: integration_health.state = 'disabled' on the channel's own row
-- (shipped in 1.3/G8: hawa.integrations kind telegram|waha, name 'office-kill-switch'; not the bot's
-- row, which telegram-poll-state.ts sets to 'healthy' on every accepted update and so would release it)
```

- **RLS:** add `requests` and `lifecycle_projections` to the task-scoped policy loop in `db/rls.sql:116-130`. They join to `tasks` through `root_task_id`, using the hoisted-membership form from migration 016 (`generate-rls-hoist-migration.ts`).
- **Grants:** insert/update/select for `hawa_app`; select only for the Desk read paths.
- **`createTaskAggregate`** gets an option `outboxState?: 'pending' | 'recorded'`. With `'recorded'` the `task.created` row is inserted with `state='delivered'`, `delivered_at=now()`, `last_error='OWNED_BY_LIFECYCLE'` and `payload.lifecycleOwner='restate'`. Every legacy query and the daily cap keep working, and `claimDue` never selects the row.

### 2.9 Idempotency key catalogue

| Side effect | Key | Deduplicated by |
|---|---|---|
| Update enqueued | `tg-<update_id>` | Restate ingress (7 days) |
| Intake saved | `chat:telegram:<chat>:<update_id>` + inbox `<chat>:<update_id>` | Postgres (existing) |
| Open request | `open:<requestId>`, requestId = `uuid(req:<chat>:<update>:<i>)` | Restate + `requests` PK |
| Every projection | `<requestId>:<rev>:<eventType>` | `lifecycle_projections` |
| Round task | `persistChatIntake` sourceEventId `lc-<requestId>-r<round>` | outbox unique key |
| Design run | workflow key `dr-<taskId>[-a<n>]`; Core keys `workflow-studio-<runKey>` … | Restate workflow; Core |
| Design finished | `dr-finished:<runId>` | Restate + `seen` |
| Message | `<requestId>:<rev>:msg:<i>`; office alerts `notify.office:<reason>:<taskId>` (as today) | send marks `lc:<key>` |
| Reminder | `remind:<requestId>:<kind>:<day>:<taskId>` (+ `reminders[]`) | Restate + state |
| Office decision | `desk:<actionId>`: a UUID the Desk makes per click and reuses on retry | Restate ingress idempotency |
| Approval row | `approvals` keyed by `<requestId>:<rev>:officeDecision` | `lifecycle_projections` |
| Delivery | workflow `dl-<requestId>-<approvalId>`; publication `pub_key_<taskId>_<approvalId>`; files `dl-…:file:<artifactId>`; notice `dl-…:notice` | Restate; Postgres; send marks |
| Size child | `uuid(req:size:<requestId>:<action>)` | Restate + `sizes[]` |

---

## 3. Slices

**The flag.** `HAWA_LIFECYCLE_CHATS`, a comma list or `*`, parsed like `isV3PilotChat` (`chat-intake.ts:71`). It is read in exactly two places:
- `ChatInbox` step `mode`, when an update might open a request.
- Core's publish route in slice 2.2 only.

After a request is open, **only `requests.owner` (or `tasks.request_id IS NOT NULL`) decides**. The owner is written once, by the `createRequest` op. Sizes inherit it. Rounds are the same request. Tasks made in the Desk stay `core` during Phase 2.

### 2.1 Poller to the worker; ChatInbox (4 d)

- **Replaces:**
  - `index.ts:48`: becomes `enableTelegramPolling: process.env.HAWA_TELEGRAM_POLLER !== 'worker'`.
  - `app.ts:11256-11289` (`createPolledUpdateHandler` wiring, `startPolling`).
  - `routes/system.routes.ts:99` poll-now: becomes 409 "the worker polls" while `HAWA_TELEGRAM_POLLER=worker`.
  - The global `pollQueue` serialisation.
  - The memory kill switch (`app.ts:257`, `ingress.routes.ts:26`): persisted in `integration_health`. Done in 1.3/G8 (`services/channel-kill-switches.ts`): each channel has its own `office-kill-switch` integrations row, not the bot row, because the poll state marks the bot row `healthy` on every accepted update. The worker's poller reads that row.
- **Adds:**
  - `telegram-poller.ts`; `ChatInbox` (legacy mode only: the intake step posts to `/v1/internal/telegram/intake`, a thin wrapper that calls today's closure with the webhook secret checked internally).
  - `WORKER_SERVICES += ['ChatInbox']`.
  - `PostgresTelegramPollState` moved to `packages/db`.
- **Per-chat aspect:** the poller switch is **global**, because one bot has one `getUpdates` consumer. Per-chat routing arrives in 2.3.
- **Rollback:** set `HAWA_TELEGRAM_POLLER=core` and restart Core. Both pollers share the Postgres offset row. Invocations already queued still call Core, which deduplicates them.
- **Tests:**
  - Unit: `chatKey`; poller advances the offset only after 2xx; kill switch honoured; 429 on `getUpdates`.
  - Handler: 4xx final; 5 retryable answers park; `DATABASE_UNAVAILABLE` never parks.
  - Acceptance (plan):
    - (a) Fake Telegram serves a 20 MB `getFile` for chat A with a 60 s delay. Chat B's text is acknowledged in under 5 s.
    - (b) The same update is enqueued twice (offset store forced to fail once): one `tasks` row, one ack.
    - (c) Worker killed with -9 inside `intake-0` (chaos point `core.intake.after-classify`): one task, at most 2 classifier calls in the fake-model ledger.
  - Chaos: K1–K5 in section 6.
- **Cutover:** after one week on the owner's bot with zero parked updates not caused by the fakes.

### 2.2 Delivery workflow and TelegramSender (4 d)

- **Replaces, for tasks whose chat is flagged at the moment of Deliver:**
  - `executeOmnichannelPublish` / `deliveriesInFlight` (`app.ts:2968-2984`).
  - The `notify.published` enqueue (`3352-3392`, and the chat-only variant at `3159-3180`).
  - `reopenInterruptedDelivery` (`4088`).
  - The worker's `notify.published` handler (`outbox-consumer.ts:475-581`) for those tasks.
- **Publish route** (`7308`), when flagged: validate as today, then POST `${ingress}/Delivery/dl-<taskId>-<approvalId>/run/send` with `DeliveryInput{reportTo:'core'}`. A 409 from Restate means "already delivering" and is answered 202 with the delivery id. The route writes `publications.executor='restate'`, a new column, before starting.
- **Old path refuses:**
  - `reopenInterruptedDelivery` returns `'no'` when `executor='restate'`.
  - `deliverOmnichannel` refuses such tasks with 409 `DELIVERY_OWNED_BY_WORKFLOW`.
  - The outbox `notify.published` handler dead-letters a command whose task has `executor='restate'`. It is a guard; it should never fire.
- `delivery-finished` (Core) does the completion transition from `3325-3341` and `3394-3411`.
- **Tests:**
  - Unit: TelegramSender classification table (sent / 429 / uncertain / refused / pre-connection / marks already present).
  - `composeDeliveredMessage` counts.
  - Chaos K15–K18: files arrive exactly once in the fake Telegram's received log. When a kill falls after Telegram accepted the file and before the mark, the file is present once and exactly one office alert names it.
  - Telegram 429 `retry_after=3` on the second file: all files arrive, the second at least 3 s later.

### 2.3 RequestLifecycle: open, design, questions, requester decisions, reminders (6 d)

- **Prerequisite:** the intake decide mode. Without 1.3 this means a parameter threaded through `app.ts:4217-5870`. With 1.3 it means the extracted module returns `IntakeDecision` instead of calling `persistChatIntake`, `answerQuestion`, `handleRequesterAction` and `makeOtherSize`.
- In `mode:'lifecycle'` Core **never** saves a task, sends a message, or moves a state for a new request. For a *target* task it resolves `requests.owner`:
  - `restate`: route (answer / requester / change).
  - `core`: run the legacy handler inline and return `handled`. This is how old requests finish on the old path.
- In `mode:'legacy'`, a target with `owner='restate'` is still routed to RL. This is what makes un-flagging a chat safe.
- **Replaces for lifecycle-owned requests:**
  - `pendingClarifications` (`538`, `5181-5236`) → ChatInbox state.
  - `acknowledgedAlbums` (`536`).
  - `pendingQuestion` / `answerQuestion` as the record (`3912`, `3953`) → `s.question`.
  - `handleRequesterAction` effects (`3674-3788`) → RL.
  - Reminder SQL (`draft-reminders.ts:70,124`): add `AND t.request_id IS NULL`.
  - `canvaStatusHandler` (`7756`): refuses with 409 `LIFECYCLE_OWNED` when `tasks.request_id` is set.
  - The worker's `task.created`/`task.dispatch` handlers (`outbox-consumer.ts:384-406`): refuse permanently when `payload.lifecycleOwner==='restate'`, a guard since those rows are never pending.
- **Office decisions in 2.3 (interim):** the decisions and publish routes keep deciding. For lifecycle-owned tasks they also send `RequestLifecycle.officeDecision` **one-way** with `eventId desk:<fresh uuid>`, so the stage follows. `pendingChangeOf` still works because round tasks are in Postgres.
- `WORKER_SERVICES += ['RequestLifecycle','DesignRun','TelegramSender','Delivery']`.
- **Tests:**
  - Pure: `decide` table tests, one per row of the state machine plus every ignore case (stale run id, stale question id, stale epoch, wrong draft task). `upgrade()` of every historical state shape. `nextOfficeMoment` (08:59, 09:00, 19:59, 20:00, midnight, Friday).
  - Handler: a small `FakeObjectContext` in `packages/testkit/src/fake-restate-context.ts` that records `run/set/send/delay` and can "crash" after any recorded entry and replay.
  - Acceptance:
    - (a) Answer given 3 simulated days later (scale 0.0001) continues the request.
    - (b) A deploy (blue→green with a changed RL build) between question and answer changes nothing, and `sys_invocation` shows no RT0016.
    - (c) A Core restart, a worker kill and a Restate restart between reminder scheduling and firing leave exactly one reminder per (task, day) in the fake Telegram log.
    - (d) Two chats, one flagged and one not, with interleaved requests: each takes its own path, and `requests.owner` is set only for the flagged chat's new requests.

### 2.4 Office decisions (2 d)

- **Desk:** `recordDecision` and `publish` (`apps/desk/src/api/client.ts:470-486`) send `Idempotency-Key: <actionId>`. The id is made per click, kept while the request is pending, and reused on retry. `GET /tasks/:id` returns `lifecycle: {requestId, rev, stage, owner}`.
- **Core:** for `owner='restate'`, the decisions route (`8408`) keeps its **read-only** validation (role scope, QC pass, pinned exports, empty design). It then does not write anything; it calls:
  ```
  POST ${ingress}/RequestLifecycle/<requestId>/officeDecision   (header idempotency-key: desk:<actionId>, synchronous, 30 s timeout)
  ```
  The result maps to HTTP: `accepted` → 200; `CHANGE_PENDING` → 409 with `pendingChangeWords`; `NOT_CURRENT_DRAFT` / `STALE_REVISION` → 409; `WRONG_STAGE` → 422.
- The same forwarding applies to publish (`7308` → `kind:'deliver'`), redrive (`8263` and `/redo`, `app.ts:2497` → `kind:'redrive'`), cancel (`8190` `:control` → `cancel`), and Desk capture (`recheckBoundDraft`, `2584` → `draftCaptured`).
- `pendingChangeOf` and `changeBlockingDelivery` are no longer called for these tasks.
- **Tests:** a double click gives one approval row. Core killed with -9 after RL accepted and before the Desk got its answer, then a Desk retry with the same id, gives the same 200 and one row. An approval of an old round while a change is being made is refused by RL.

### 2.5 Retire (2 d)

**Precondition:** `SELECT count(*) FROM hawa.tasks WHERE request_id IS NULL AND state NOT IN (terminal…) AND created_at > <cutover>` is 0, and no outbox `task.*` rows are pending.

**Delete:**
- The outbox handlers `task.created`, `task.dispatch`, `task.outcome` (`outbox-consumer.ts:384-406, 443-466`).
- `TaskWorkflowDispatcher` (`workflow-dispatcher.ts`) and `outcome-without-core.ts`.
- `pendingClarifications`, `acknowledgedAlbums`, `deliveriesInFlight`, `inFlightPublications`, the `telegramActionTokenService` maps and the whole `act:` branch (`app.ts:4291-4396`, unreachable).
- `reopenInterruptedDelivery`.
- The reminder timer (`11212-11221`).
- `polled-update-dispatch.ts`'s `createPolledUpdateHandler`.
- The poll-now route.

**Keep:**
- `TaskWorkflow` as a shim.
- The outbox table, as the intake record.
- The Canva sweeper (`app.ts:11222-11247`).

`enqueueOfficeAlert` (`3611`) moves to TelegramSender through ingress, with the same keys.

### 2.6 Cutover and operations (2 d)

- **Cutover:** `HAWA_LIFECYCLE_CHATS=*` plus `HAWA_LIFECYCLE_FROM=<ISO date>`. The `mode` step returns lifecycle only when the flag matches and `now >= FROM`. Owners never change after creation.
- **Nightly Restate backup** (`infra/backup/restate-nightly.sh`):
  1. Throw the kill switch; the poller stops enqueueing.
  2. Wait for `sys_invocation` running = 0, or 5 min.
  3. `docker compose stop restate`.
  4. `tar` the `restate_data` volume into the existing encrypted archive.
  5. `start`, then release the kill switch.
- **Monthly restore drill:** into the chaos compose (section 6), then run scenario R1 (Section 6.3) on the restored copy. The expected `AHEAD` reconciliations must resolve with no resends.
- Document the payload rules of section 4 in `infra/docker/README.md` and ADR-034 §2.4.

---

## 4. Payload evolution and blue/green

**Rules:**
1. **Payloads.** Every handler input carries `v`. Fields are only added, and only as optional. Types never change and fields never get new meanings; add a field instead. A contract test in `packages/contracts/test/lifecycle-payloads.test.ts` keeps JSON fixtures of every historical payload, and each must still decode.
2. **Handlers.** A handler is never removed while anything may target it:
   - delayed sends: `remind` at most +5 d, `expire` +14 d, `retryProjection` +10 min;
   - ingress idempotency retention: 7 d;
   - in-flight invocations.

   Removed handlers become shims in `apps/worker/src/lifecycle/shims.ts`:
   ```ts
   async (ctx, e) => { ctx.console.warn('shim', e); return neutral }
   ```
   Each shim records `retiredAt`. A test fails if a name in `HANDLERS_EVER` (a checked-in list) is missing from the build before `retiredAt + 21 d`.
3. **Services.** A service is never removed from the build (finding 1.2.7). `WORKER_SERVICES` = all services ever. A test compares the names bound in `apps/worker/src/index.ts` with it.
4. **State.**
   - State is one key `lc` with `v`. `upgrade()` reads every older version.
   - For rollback safety, a new stage or field that an older build would not understand ships in two deploys: first the reading, then the writing.
   - An older build that meets an unknown `v` or stage treats the event as ignored, **does not `ctx.set`**, and returns a retryable error for exclusive handlers except `get`. The invocation then waits for the rollback to be undone instead of corrupting state.
5. **Delayed events** carry `stageEpoch`. A delayed invocation is not pinned until it starts, so it runs on the live colour's code. That is the point, and it is why rules 1 and 2 matter.

**How blue/green meets Virtual Objects and delayed sends:**
- Object state belongs to service and key, not to a deployment. Green reads state that blue wrote, and a draining blue may still write state that green then reads, which is why the rules apply in both directions.
- Restate keeps one exclusive invocation per key across both colours. A green `RequestLifecycle` invocation for key K waits behind blue's in-flight one, so there is no interleaving.
- The drain query (`status <> 'completed'` pinned to blue) counts running, suspended and backing-off invocations. It does **not** count scheduled delayed sends, which have no pin yet. Verify this on 1.7.10 with a chaos test (section 6.3, D2) before relying on it.
- Long work is DesignRun (minutes, at most about 15 min when busy) and Delivery (minutes), so `finish-drains --wait-seconds 900` still fits. RL, ChatInbox and TelegramSender pin for seconds. ChatInbox pins for at most about 30 s of backoff, or longer only during a Core database outage.
- **Never await an object or workflow from a Virtual Object.** That suspends the invocation, keeps it pinned, and blocks the key. Only DesignRun and Delivery may await TelegramSender.
- A running blue DesignRun reports `designFinished` to RL, and green's RL takes it. Blue's payload shape must therefore stay accepted (rule 1).
- `LiveColourGate` keeps probing `TaskWorkflow`, which stays hosted as a shim, so the gate and `planDeploy` (`restate-bluegreen.ts:157`) need no change.

---

## 5. Risks specific to this code base

| Risk | Mitigation |
|---|---|
| **Logic that must stay in Core** because it needs Core services: classification (paid), transcription and PDF reading (paid), standing rules, client DNA and brand guidelines, bilingual split, album/reference merging, `persistChatIntake` daily cap under its advisory lock, the studio and cost ledger (`design_studio_calls`), Canva Connect (token rotation, operations), QC (`evaluateCanvaExportQc`), revision bridging, all message composition (HTML, i18n, `composeCanvaStatusMessage`), approval gates, Drive and Sheets. | Core becomes "domain services + projection + composition" behind `/v1/internal/*`. RL decides; Core never decides a stage for lifecycle-owned requests. Types live in `packages/contracts`; a contract test posts fixture payloads to each internal route. |
| **Paid calls repeated during intake** (Core dies after classifying, before saving) | Core writes an `inbox_events` row `<chat>:<update>:decision` holding the `IntakeDecision` before returning. A retry reads it. The chaos assertion is at most 1 classifier call per update when the kill falls after the decision is written. |
| **Telegram at-least-once**: updates arrive twice; sends have no idempotency | In: `tg-<update_id>` plus Core's inbox deduplication. Out: send marks with "never resend uncertain" plus an office alert. Courtesy messages accept the window. Callback answers are best-effort; Telegram refuses answers that are too late, which is harmless. |
| **Canva operations outlive a run**; cancelling a DesignRun mid-import | `abandonUnsettledRun` on cancel. The Canva sweeper stays. `CANVA_RECONNECT_REQUIRED` is retried as now (`canva-draft-workflow.ts:22`). |
| **Cost ledger**: the parity check (`:536`) is the only paid step Core does not deduplicate | It stays capped at 5. DesignRun keys are per round and attempt, so an answer delivered twice starts nothing twice (`dr-<taskId>`). |
| **Legacy SQL reads outbox rows as facts** (finding 1.2.1) | `task.created` rows are recorded non-dispatchable. `recordDraftSent` / `recordQuestionSent` write `notify.telegram` rows with `state='delivered'` only after a confirmed send. Migrating those queries to `hawa.requests` columns is tracked for after 2.5. |
| **RLS scopes for projection writes** | Tenant comes from RL state, never from event payloads. Identity is `SYSTEM_AUTOMATION_USER_ID` with the operator role (`tasks_write` requires `can_write_client`; migration 012 grants it). `requests` and `lifecycle_projections` join the task-scoped policies. The worker's direct DB access (send marks, export bytes) moves from the Art Director id to `SYSTEM_AUTOMATION_USER_ID`. |
| **Worker token = operator token** | New `HAWA_WORKER_TOKEN` accepted only on `/v1/internal/*`, mapped to a `service` principal. `/v1/internal/*` refuses every other token. |
| **A Restate restore rolls state back** | `AHEAD` reconciliation; send marks in Postgres prevent resends. Core's studio idempotency keys prevent paid re-runs even when Restate has forgotten the workflow key. |
| **Silent pauses** (`onMaxAttempts:'pause'`) | `/health` already reports paused, backing-off and inbox counts (`services/restate-invocations.ts`). The watchdog alerts on paused > 0 or inbox > 50. |
| **A long intake in one chat** (20 MB PDF) | Blocks that chat's ChatInbox only. Set `abortTimeout` to 10 min. |
| **Legacy memory maps read by internal endpoints** (`tasks`, `events`) | Internal endpoints use Postgres only (`readCurrentTask` strict). Code review rule: no `tasks.get(` in `lifecycle-internal.routes.ts`. |

---

## 6. Chaos suite, runnable locally

### 6.1 Topology

`packages/testkit/chaos/docker-compose.chaos.yml`, project `hawa-chaos`, isolated from `hawa-production` and `hawa-test`:

| Service | Image | Notes |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17`, named volume | `fsync=off` is safe for process kills (the host OS survives) and models no power loss. |
| `restate` | `ghcr.io/restatedev/restate:1.7.10`, named volume | Admin port 9070 published to 127.0.0.1 for the driver. |
| `core` | `Dockerfile.core` | Env: `DATABASE_URL`, `RESTATE_INGRESS_URL`, `HAWA_WORKER_TOKEN`, `HAWA_TELEGRAM_POLLER=worker`, `HAWA_LIFECYCLE_CHATS=<owner test chat>`, `CANVA_BASE_URL=http://fakes:9000/canva`, `GOOGLE_*_BASE_URL=http://fakes:9000/google`, `HAWA_CHAOS_CONTROL_URL=http://fakes:9000/__chaos`, `NODE_EXTRA_CA_CERTS=/chaos-ca/ca.pem`. |
| `worker-blue`, `worker-green` | `Dockerfile.worker` | Same env plus `HAWA_WORKER_SELF_URI`. |
| `fakes` | Node, `packages/testkit/chaos/fakes/server.ts` | See 6.2. |

`extra_hosts` points `api.telegram.org`, `api.openai.com`, `generativelanguage.googleapis.com` and `api.anthropic.com` at `fakes` for both Core and workers.

**Transport choice.** Extra hosts plus a test certificate authority exercises the real hard-coded URLs unchanged (finding 1.2.4–5). The `fakes` container generates a CA and a leaf certificate with those subject names at start and writes `ca.pem` to a shared volume. The alternative, an undici dispatcher preload, needs no TLS but bypasses the real URL code; it is kept as a fallback. The production compose already uses the same `extra_hosts` trick for Telegram (`docker-compose.prod.yml`, core `extra_hosts`).

### 6.2 Fakes (`packages/testkit/chaos/fakes/`)

- **`telegram.ts`**
  - Implements `getUpdates` (scripted queue per test), `sendMessage`, `sendPhoto`, `sendDocument`, `answerCallbackQuery`, `getFile`, `/file/bot…/<path>` (configurable size and delay), `getMe`.
  - Records `received[]` with `{seq, method, chat_id, text hash, document sha256, at}`.
  - Faults per `(method, chat)`: `429 {retry_after}` for the next N calls; `5xx`; **process then drop the connection** (models "uncertain"); a delay.
- **`models.ts`**
  - OpenAI chat completions and images, Gemini `generateContent` and `interactions`, Anthropic messages.
  - **Record and replay:** answers are fixtures keyed by `(model, sha256(system prompt + first user message))`, stored in `packages/testkit/chaos/fixtures/models/*.json`. They are recorded once against a studio run on the owner's chat with `HAWA_FAKE_MODELS_RECORD=1` proxying to the real APIs.
  - **Paid-call ledger** `{fingerprint, n}` for the no-paid-call-twice assertion.
- **`canva.ts`**
  - The Connect paths used by `canva-connect-client.ts` (`/oauth/token`, `/designs`, `/imports[/:id]`, `/exports[/:id]`) plus export download URLs served by itself.
  - Faults: 5xx and 429 per path.
- **`google.ts`**: reuses `packages/integrations/test/fake-drive-server.ts`.
- **`chaos-control.ts`**
  - `POST /__chaos/hold {point, n}` arms a named point. `GET /__chaos/wait?point=` long-polls until it is reached. `POST /__chaos/release`.
  - Named points are reached through a new no-op helper `chaosPoint(name)` in `packages/observability`. It does nothing unless `HAWA_CHAOS_CONTROL_URL` is set; when set, it POSTs and waits for release.
  - Placed at:
    - `core.intake.after-decision`
    - `core.project.after-commit` (before the HTTP response)
    - `core.outcome.after-bridge`
    - `core.delivery.after-drive`
    - `worker.sender.after-telegram` (before the `sent` mark)
    - `worker.poller.after-enqueue` (before `setOffset`)
    - `worker.rl.after-project` (before `ctx.set`)

### 6.3 Driver and scripted requests

The driver is `packages/testkit/chaos/chaos.test.ts`, run with `HAWA_CHAOS=1 pnpm vitest run packages/testkit/chaos`. Setup:
1. `docker compose -p hawa-chaos up -d --build`.
2. Apply `db/schema.sql`, `rls.sql`, migrations and seed.
3. `npx tsx scripts/restate-bluegreen.ts register blue`, with the admin URL overridden.
4. For each scenario × kill point: reset the fakes, run the script, and at the armed point `docker kill -s KILL hawa-chaos-<target>-1` then `docker start`. Or, for Restate or Postgres, kill at a time offset.
5. Wait for quiescence: `sys_invocation` running and backing-off = 0, fake Telegram idle for 5 s.
6. Check invariants.

**R1: happy path, owner chat**

| Step | What happens | Kill points |
|---|---|---|
| S1 | Brief update | K1 worker at `poller.after-enqueue`; K2 Restate right after `getUpdates`; K3 Postgres at `setOffset` |
| S2 | `ChatInbox` intake | K4 Core at `intake.after-decision`; K5 worker mid-intake |
| S3 | RL `open` → project | K6 Core at `project.after-commit`; K7 Postgres during project; K7b worker at `rl.after-project` |
| S4 | DesignRun | K8 worker between Canva resume polls; K9 **deploy** to green with a patched worker build that adds a `ctx.run` in DesignRun (`chaos/fixtures/next-worker.patch`); K10 Restate mid-run; Canva 5xx ×3 and 429 on exports |
| S5 | Outcome → draft and photo | K11 Core at `outcome.after-bridge`; K12 worker at `sender.after-telegram` (expect uncertain + one office alert); K13 Telegram 429 `retry_after=3` |
| S6 | Requester taps `rq:ok` | K5 again |
| S7 | Desk approve (HTTP with actionId) | K14 Core after RL accepted |
| S8 | Desk deliver | K15 Core at `delivery.after-drive`; K16 worker between files; K17 Postgres during mark write; K18 Restate between files |

**R2: silent requester (reminder scale 0.0001).** Draft sent, no reply; day 1 and day 5 reminders, then expiry.
- D1: worker, Core and Restate each killed between scheduling and firing.
- D2: deploy to green between scheduling and firing. The reminder must fire on green and blue must drain.

**R3: change, question, answer.**
1. Reply "make the logo bigger" to the draft.
2. The model fixture returns `NEEDS_CLARIFICATION`; the question is sent.
3. Deploy.
4. Tap `rq:a1`.
5. New round, new draft.

Kills are placed at the `answer` project step and at `designFinished`.

**R4: two chats.** Chat A sends a 20 MB PDF with a 60 s `getFile` delay; chat B sends text. B is acknowledged in under 5 s.

**R5: rollback.** Un-flag the owner chat mid-R3. A reply to a lifecycle-owned draft is still routed to RL; a new brief goes to the legacy path.

**Invariants** (SQL, fake ledgers and Restate SQL):
- Exactly one `requests` row per script request. `tasks` count equals the expected rounds. `design_revisions` per task = 1.
- `approvals` = 1. `publications` = 1, `state='complete'`.
- Fake Telegram: each logical key's message appears once. A key marked `uncertain` appears at most once and has exactly one office alert. No reminder appears twice.
- Paid-call ledger: every fingerprint at most once per run attempt, except parity at most 5. Classifier at most 1 per update, except kills before the decision is written, which allow at most 2.
- Restate: `SELECT count(*) FROM sys_invocation WHERE status='paused'` = 0. No invocation's `last_failure_error_code` is `RT0016`. After R2-D2, blue's pinned count reaches 0 and blue is deleted by `finish-drains`.
- The final stage for each request is the expected one: `delivered`, or `expired` for R2.

**Budget.** About 40 min for the full matrix, run locally before each slice is marked done. The lead re-runs it (plan principle 7). Each slice's acceptance names its subset: 2.1 → R1 S1–S3 and R4; 2.2 → R1 S8; 2.3 → R1 S1–S6, R2, R3, R5; 2.4 → R1 S7–S8.

---

### Critical Files for Implementation
- /Users/hawzhin/Hawdesign/apps/core/src/app.ts (Telegram closure 4217-5870; `canvaStatusHandler` 7756-8102; delivery 2968-3440; decisions 8408; publish 7308; polling 11249-11290; memory maps 536/538/2968/257)
- /Users/hawzhin/Hawdesign/apps/worker/src/canva-draft-workflow.ts (`runCanvaDraft`, `finish()` 313-337: the seam for the `DesignRun` report)
- /Users/hawzhin/Hawdesign/apps/worker/src/index.ts (service bindings, `durableContext`, live-colour gate) together with /Users/hawzhin/Hawdesign/scripts/restate-bluegreen.ts (`WORKER_SERVICES`, drain rules)
- /Users/hawzhin/Hawdesign/packages/db/src/repositories/task.repository.ts (`createTaskAggregate` outbox state, `transitionState` expected version) with /Users/hawzhin/Hawdesign/db/schema.sql and /Users/hawzhin/Hawdesign/db/rls.sql (new `requests` and `lifecycle_projections` tables)
- /Users/hawzhin/Hawdesign/packages/integrations/src/telegram-bridge.ts (poller moves to the worker; 429 `retry_after`; send results used by `TelegramSender`) with /Users/hawzhin/Hawdesign/apps/worker/src/delivery-notification.ts (send marks reused as the exactly-once fence)