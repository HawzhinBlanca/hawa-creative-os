# ADR-142: The Owner's First Request — Run Limit, Photos, Copy and the Office Retry

**Date:** 2026-09-29
**Status:** Implemented and locally qualified; not deployed.
**Requirements:** FR-013 (a Design Brief with exact copy), FR-059 (provider and budget failures request human action without losing completed work), FR-060 (resume without repeating side effects), FR-079 (per-run budgets and visible cost before a rerun), NFR-001.
**Changes a foundation:** ADR-091 (Studio spending reservations): the text bound of the reservation policy, `studio-2026-09-27-v2` → `studio-2026-09-29-v3`. ADR-135/ADR-126: a request-owned design that ended without a draft gains an office action, the retry.
**Builds on:** ADR-091, ADR-133 (daily scope), ADR-135 (lifecycle-only intake), ADR-143 (albums settle), ADR-145 (requester wording).

## 1. Context

After the natural-language release was deployed, the ADR-143 sweep opened the owner's pending album (2026-09-29 19:24:53Z): six field-visit photos and, as the caption, the brief of a KAAE report cover (task `ba4469f2`). The Studio wrote the brief ($0.15323) and failed at `laying_out`:

> BUDGET_EXHAUSTED … no candidates passed hard QA before budget cap was reached.

The office's day had $29.85 of $30 left and the run $1.85 of its $2 limit. The Desk also showed no reference photos, no client name, and the title "KAAE: Here is the text and the photos:…". The task ended `failed_operator`, and nothing could start it again without the requester sending everything a second time.

Each finding was reproduced against fake providers at production prices (the exact stage inputs: six 1280×960 JPEGs as Telegram delivers a photo, the owner's words, the album opened by the worker's settle and by the sweep):

1. **The run limit.** The refusal came from `assertStudioBudgetAdmission` in `DesignStudioRepository.recordCallStart`: the layout call's advance reservation, **$2.13**, was larger than the **$1.85** left. The images were not the cause: the layout call already sends each photo at 768 px and low detail (309 tokens a photo, about $0.16 for six). The reservation counted **two tokens per UTF-8 byte** of text on top of the 16,000-token output limit ($0.80 at $50/M). A byte-level tokenizer never spends more than one token on one byte, so the doubled count bounded nothing more; the real call costs about a third of the reservation. `handleBudgetExhaustion` then reported "no candidates passed hard QA" for a run that had laid out nothing.
2. **The photos.** They were stored (`hawa.task_files`, role `reference_image`, six rows) and reached the Studio (`requestImages` returned six for both the settle and the sweep). The Desk's "references" is `referenceAssets`, a free-text reference-notes field that no Telegram request fills; the task detail listed no photos. Separately, a request-owned album whose files no longer matched its manifest became "no images" at the caller (`optionalImages`), and a v2 run then fell back to the single-shot planner without the photos.
3. **The title.** `doIngestChatCampaignTask` took the first paragraph as instructions and the next line, "Here is the text and the photos:", as the headline and copy block 0.
4. **The client name.** `GET /v1/tasks/:id` had no `clientName` field at all; the list endpoint has one. The task row carried the KAAE client.
5. **The retry.** A request-owned task could not be re-driven (`LIFECYCLE_OWNED`); RequestLifecycle had no action for a first design that ended without a draft; the requester's reply to it is kept for the office (ADR-144), and the native handoff covers only manual requests and revisions.

## 2. Decision

### 2.1 Reservation policy v3

Message text is reserved at **one token per UTF-8 byte** (`TEXT_TOKENS_PER_BYTE`), a hard bound for byte-level BPE and for byte-fallback tokenizers. The JSON schema keeps two tokens a byte (the provider renders it into its own grammar text). Framing (1,024 + 128 per message), vision bounds, the declared output limit, the short/long context price selection, and overrun detection (`STUDIO_BUDGET_RESERVATION_EXCEEDED` holds the run) are unchanged. v1 and v2 quotes stay as recorded evidence. The owner's layout call reserves **$1.61** under v3.

### 2.2 The brief reads photos at most 1280 px on their long side

Six full-size phone photos sent as files (4032×3024) reserve $1.94 of vision input in one brief at production prices, more than a run can then leave for its layout. The brief downscales an image only when its long side is over 1280 (`BRIEF_IMAGE_MAX_EDGE`), the size Telegram delivers a photo in and the size the owner's brief read; the design itself still places the original photo.

### 2.3 A request larger than the run has left is named as such

When admission refuses one request because its reservation exceeds what the run has left (`StudioBudgetExhaustedError.shortfall`) and no layout exists yet, the run fails with **`STUDIO_RUN_LIMIT_TOO_SMALL`**, not "no candidate passed hard QA":

> STUDIO_RUN_LIMIT_TOO_SMALL at stage laying_out: the next model request needs a $2.13 advance reservation and the run has $1.85 of its $2 limit left ($0.15 spent). Nothing was sent for it and no layout was made. Retry the design once the run limit (DESIGN_STUDIO_MAX_USD) fits the request.

The worker records that code (from the result or a replayed diagnostic). The requester hears a new catalogue line (`OUTCOME_MESSAGES.designTakingLonger`), in their language: "{title} needs a little more time. The office is on it and will send your draft here; you don't need to send anything again." With no office chat to alert, they hear the existing follow-up line instead. A run that did spend its limit on candidates keeps the `BUDGET_EXHAUSTED` handling.

### 2.4 The request's own photos are never dropped silently

A request-owned album whose stored files differ from its manifest, or a photo of an unsupported type, stops the run with the reason ("The request's photos cannot be used: …"). No pipeline, v2 or v3, designs it without them.

### 2.5 A line that introduces the text is an instruction

A line ending with a colon that speaks of the text (text, copy, wording, words, content; Sorani دەق, نووسین, ناوەڕۆک, وشە) and is addressed to the designer ("Here is the text and the photos:", "Please use this text:", "Text:", "دەقەکە:", "ئەمە دەقەکەیە:") goes to the instructions, and each exact line after it is one copy block, in order, in its own script and direction. A copy line that ends with a colon ("Speakers:", "Date:", "وشەی سەرۆک:") is not one. Without an introducer, paragraphs stay one block each, as before. The owner's caption now gives the title "KAAE: KAAE K-12 Pilot Study…" and three blocks.

A request stored before this change is read by the same rule where its copy is read for a design (`savedDesignCopy`): a leading copy block that is an introducer moves to the instructions and each line after it is one block. The stored request is not rewritten. A task titled from its introducer ("KAAE: Here is the text and the photos:…") is "your design" to the requester (`designName`). This is what makes the retry of task `ba4469f2` print only the owner's three lines.

### 2.6 The task detail names its client and shows its photos

`GET /v1/tasks/:id` returns `clientName`, `referenceImages` (album order, each with its authorised `/v1/tasks/:id/files/:sha256` URL) and `referenceImageCount`. The Desk shows the client and the photos. `referenceAssets` stays the reference-notes text it is.

### 2.7 The office retries a design that ended without a draft

`POST /v1/tasks/:taskId/redrive` (the Desk's existing "Re-drive Generation") and `POST /v1/tasks/:taskId/lifecycle/retry-design`, for a request-owned task, send a signed office event through the office gateway (`OfficeDecisionGateway.retryDesign`) to the request's own object (`RequestLifecycle.officeRetry`). Body: `{ "reason": "…" }` (optional); header `Idempotency-Key` optional (a UUID; by default one action per request revision, so a second press is the same retry). Roles: operator, art director, creative director, office admin, administrator; never a service identity.

- It applies only when the request is `manual` and its current revision is a design outcome of that task with **no draft and no question**, the task is `failed_operator`, no Studio run of the task is unfinished, and the office has not sent a draft back for changes.
- Core's projection (`/v1/internal/lifecycle/:id/office-retry`, receipt `…:officeRetry:desk:<actionId>`) moves the task `failed_operator → received` with an attributed event and the request `manual → designing`, one revision on.
- The same task is designed again under the DesignRun **`dr-<taskId>-a<n>`** (the attempt run id Core's lifecycle write guard already admitted) with `redriveAttempt: n`, so its Studio run has its own key (`workflow-studio-<taskId>-redrive-<n>`). Its outcome is projected like the first one.
- At most **three** retries per task (`RETRY_LIMIT_REACHED`); after that a designer takes it over.
- The requester is sent nothing by the retry; they hear the outcome as they would have heard the first.

## 3. Consequences

- **Cost.** Reservations are not charges; actual spend per design is unchanged by 2.1. Every Studio, planner and probe text call reserves less for its text (the owner's layout call $2.13 → $1.61; the brief $0.81), so a $2 run can admit a layout after a brief with six photos. The run limit ($2, 24 calls), the office's daily scope ($30) and the role scopes are unchanged. 2.2 lowers the actual cost of a brief with full-size photos (six 12 MP photos: about 86,000 input tokens → about 9,000). Each office retry pays for one more design (about $0.60 at production prices, measured over 16 production runs), at most three per task.
- The margin under $2 for the owner's layout is $0.24; a request with a much longer brief, or ten photos, may still exceed it. It then fails with 2.3's diagnostic and the office can raise `DESIGN_STUDIO_MAX_USD` and retry (2.7) — never silently.
- The Studio still places **every** photo the request carries (hard QA `PHOTOS`), although the owner wrote "you don't have to use all the photos". Choosing a subset is not implemented here.
- An introducer line in the middle of copy ("Here are the words of our president:") splits the message there; the copy above it moves to the instructions, not lost, but out of the exact copy.
- **Deployment.** Core and worker deploy together. New Restate handlers: `RequestLifecycle.officeRetry` and `OfficeDecisionGateway.retryDesign` (a new worker deployment registers them; no service is added or removed). A new Core with the old worker answers a retry 503 (`LIFECYCLE_GATEWAY_UNAVAILABLE`/uncertain) and changes nothing. No migration. Rollback to the previous release leaves any attempt run in flight to finish or be abandoned by the stale-run handling; its outcome route would refuse the attempt run id, so roll back only with no retry in flight.

## 4. Verification

- Unit and PostgreSQL (fake providers, production-tier prices): `apps/core/test/album-report-cover-studio.test.ts` — the album opened by its settle and by the sweep carries six photos to the task and the Studio; a mismatched album stops the run and never calls the fallback planner; the owner's six-photo cover is laid out and transferred with all six photos placed (layout reservation < $1.70; **fails under v2 with the production diagnostic's numbers: $2.13 needed, $1.85 left, $0.15 spent**); a $1 run limit fails as `STUDIO_RUN_LIMIT_TOO_SMALL` with no layout call, and the office retry then transfers a draft of the same task. `apps/core/test/lifecycle-office-retry.test.ts` — the Desk's re-drive through the signed gateway, the request object and Core's projection; replay; attempt outcomes; the three-retry limit; refusals. `apps/worker/test/request-lifecycle-office-retry.test.ts`, `apps/core/test/brief-introducer-copy.test.ts`, `apps/core/test/task-detail-client-and-photos.test.ts`, `apps/desk/test/task-reference-photos.test.ts`, `apps/core/test/brief-reference.test.ts`, `apps/core/test/canva-status-message.test.ts`, `apps/worker/test/studio-failure-code.test.ts`, `packages/creative/test/studio-spending-reservation.test.ts`.
- Chaos (worker mode, fakes): `R1.S3.ALBUM_COVER_RETRY` — the owner's album and words, the first plan refused, the Desk's re-drive, the retried draft in review with all six photos sent to the design model. Results in section 5.

## 5. Local qualification — 2026-09-29

- The reproduction: with policy v2 restored for one run, `album-report-cover-studio.test.ts` failed exactly as production did (`STUDIO_RUN_LIMIT_TOO_SMALL at stage laying_out: … needs a $2.13 advance reservation and the run has $1.85 of its $2 limit left ($0.15 spent)`); with v3 the same run transfers a draft placing the six photos (brief reserved $0.81 and spent $0.15323; layout reserved $1.61). Each new test was also run against the code before its fix and failed there (introducer: 5 of 7; task detail: 2 of 3; mismatched album: the fallback planner was called; retry: `LIFECYCLE_OWNED`).
- Chaos, worker mode, fakes for Telegram, Canva and the models (`npx tsx packages/testkit/chaos/run.ts --poller worker --only R1.S3.ALBUM_COVER_RETRY,R1.S3.ALBUM_BRIEF,R1.S3.ALBUM_RESTART,R1.S3.ALBUM_ASK,R1.S3.ALBUM,R1.S3.DOCUMENT_ALBUM,R1.0,R1.S3.K1`, through `hawa-chaos-lock`): **8/8 scenarios, 123/123 invariants**, 278 s, peak 950 MiB. `R1.S3.ALBUM_COVER_RETRY` 23/23: six 1280×960 JPEGs with the owner's caption, one request, the first plan refused (HTTP 400, the design ended without a draft, the office alerted once), the Desk's re-drive answered 202 (attempt 1, `dr-<task>-a1`), a second press answered 200 `replayed`, the retried draft in review at rev 4 with **all six photos, in album order, sent to the design model**, title "KAAE: KAAE K-12 Pilot Study…" and the three lines as copy, the task detail naming the client with six reference photos, receipts open → failed outcome → office retry → draft outcome, two DesignRun invocations completed, no paused invocation, no journal mismatch, and nothing asked of the requester. Results: `plans/lean-design-implementation-2026-09-28/ADR142_ALBUM_CHAOS_RUN.json` (and the scenario alone, `ADR142_ALBUM_COVER_RETRY_CHAOS_RUN.json`). The first run of the new scenario failed two of its own checks, both in the harness: its model-ledger filter read earlier scenarios' plans, and the generic "no office alert without an uncertain send" did not know a design may fail on purpose; the scenario now reads the ledger from its own start and declares `operatorAlerts: 1`.
- `pnpm lint` and `pnpm typecheck` (597 test roots) passed. The full suite is recorded in section 6.
- Not run: the real models, Canva or Telegram; a real Sorani reader's check of the new line (listed in `SORANI_REVIEW.md`).

## 6. Full suite and the production retry

Full suite (`HAWA_TEST_WORKERS=3 pnpm test`, Desk built, after every commit of this change): 596 files; **5406 passed, 67 skipped, 2 failed**: `r11-release-gate.test.ts` test 1 (expected: `RELEASE_MANIFEST.json` is not re-sealed on this branch) and `validate-pack-tool-caches.test.ts` (the refreshed manifest named this ADR and its chaos results before they were committed; it passes once they are). The earlier run of the same suite also showed `design-studio-orchestrator` "scopes a second-client Studio transfer" timing out at 30 s once under load; it passed alone and in this run.

After Core and the worker are deployed together, task `ba4469f2-90b6-4b28-95e0-2535ec6496d5` (request `01fdb694-0005-5371-a41f-a3516649574e`) is retried by the office, once, from the Desk (the task's Studio panel, **Re-drive Generation**) or with:

```
POST /v1/tasks/ba4469f2-90b6-4b28-95e0-2535ec6496d5/redrive
Authorization: Bearer <an administrator, art director or operator credential; not the worker token>
Content-Type: application/json
Idempotency-Key: <a new UUID v4; optional, and the same one on any resend>

{ "reason": "Retry after ADR-142: the layout reservation now fits the run limit." }
```

`POST /v1/tasks/<taskId>/lifecycle/retry-design` takes the same body. Expected answer: HTTP 202 `{ "requestId": "01fdb694-…", "taskId": "ba4469f2-…", "rev": 3, "stage": "designing", "runId": "dr-ba4469f2-90b6-4b28-95e0-2535ec6496d5-a1", "attempt": 1, "taskState": "received", "replayed": false }`. A 409 `NOT_RETRYABLE` means the request is not at `manual` after a no-draft outcome (read it first: `GET /v1/tasks/ba4469f2-…` shows `requestId`, `status` OPERATOR_REQUIRED, `clientName` and six `referenceImages`); a 503 `OFFICE_RETRY_UNCERTAIN` is resent with the same `Idempotency-Key`. The run designs the stored task with the three lines (2.5) and the six photos; the requester hears the draft's outcome in the usual words; the office's Desk review follows as for any draft.
