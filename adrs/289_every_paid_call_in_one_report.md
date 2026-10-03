# ADR-289: Every Paid Model Call in One Report

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/costledger` (from `claude/release-2` 3ad1aff2). Not deployed.
**Requirements:**
- FR-079: real-time budget debiting.
- The owner's question "where does the money go?", which has to be answerable for calls outside the Studio as well.

**Changes a foundation:** no. There is no migration, no new dependency and no new paid call. The change is one read-only report, one route, a Desk table and a stricter egress lint.
**Builds on:**
- ADR-093: gateway spending policy.
- ADR-096: one office allowance across ledgers.
- ADR-101: Canva planner calls.
- ADR-133: pre-admission spending.
- ADR-144, ADR-200 and ADR-232: the intake router and its office and copy readers.
- ADR-159: uncertain call expiry.
- ADR-164: verified office call cost.

**Number:** 289. Checked free on 2026-10-03 across `git log --all -- adrs`, the main checkout and every worktree under `.claude/worktrees`. The highest number found was 286. Claude's block is 270–289.

**File location:** this repository keeps decisions in `adrs/NNN_title.md`. The task named `docs/adr/ADR-289-*.md`, but there is no `docs/adr` directory, so this follows the repository's convention.

## 1. Context

The task assumed that only Design Studio calls are reserved and recorded, and that the intake router, classifiers, voice, vision, judging outside the Studio and some image paths are not.

Reading every call site showed something different. Each live paid call is already admitted into a durable ledger before it is sent. The office day (`hawa.studio_scope_budget_internal`, last redefined in migration 068) counts every one of those ledgers against the shared allowance under a budget role.

There were three real gaps:

1. **Intake readings were invisible.** The intake router's readings are written to `hawa.requester_intent_calls` and charged to the `intake_router` role. That covers the requester reader (ADR-144), the office reader (ADR-200) and the copy reader (ADR-232). They were missing from the Desk's call list (`/v1/spending/calls`), whose SQL page function knows only five kinds. The only place they showed up was today's `intake_router` bucket on the spending-policy page.
2. **No view of spend by day.** Nothing showed spend by day. Only today's buckets existed.
3. **Two paid functions write no ledger row.** Nothing stopped a future caller from wiring them up. They are `classifyInboundTelegramMessage` and `generateConditionedArtLayer`.

## 2. Inventory

Scope: every provider call site in `apps/*/src` and `packages/*/src`. That means every `fetch` to an OpenAI, Anthropic or Google model endpoint, plus every `resolveModel()` user that dispatches. No file imports a provider SDK. The same list is now the code-level map `PROVIDER_EGRESS_LEDGERS` in `scripts/lint_provider_egress.ts`.

| Call site | What it pays for | Role (office day) | Ledger, idempotency | Before | Now |
|---|---|---|---|---|---|
| `packages/creative/src/studio/openai-studio-client.ts`, through Core's ledger client in `design-studio-service.ts` `createStageContext` | Every Studio text call: brief, concepts, layouts, critique, revise, tournament, canary, parity, edit, the v3 pipeline's judge (pairwise and brief-bound), refinement, box critique, visual review, art direction | `creative_director`; `visual_judge` for critiquing, judging and parity | `design_studio_calls`, admitted before dispatch; retained-result replay per substep (ADR-122) | Ledgered | Ledgered, now also summed by day and role |
| `gemini-image-provider.ts` `requestStudioArtImage` and `runVisionCheck`, through Core's `requestImage` and `visionClient` | Studio artwork (OpenAI or Google) and its vision check | `asset_photoreal` | `design_studio_calls` (stage `art`) | Ledgered | Ledgered |
| `apps/core/src/services/canva-planner-call.ts` | Canva layout planning | `creative_director` | `canva_planner_calls`; the primary key is the plan id (ADR-101) | Ledgered | Ledgered |
| `apps/core/src/services/requester-intent-model.ts` `readOnce`, used by the requester, office (`office-intent-model.ts`) and copy (`request-copy-extraction.ts`) readers | Reading a requester's or office member's message, and choosing copy from a request sentence | `intake_router` | `requester_intent_calls`, one row per update and reader (UNIQUE tenant and update; reader offset); admitted before dispatch | Ledgered and charged, **missing from the call list** | **In the call list and the summary** |
| `packages/integrations/src/voice-transcriber.ts`, through `lifecycle-voice.ts` | Voice-note transcription (whisper-1) | `voice_transcriber` | `inbox_events` `lifecycle_voice_attempt`, one per client and audio hash | Ledgered | Ledgered, its held reservation now shown |
| `apps/core/src/routes/assets.routes.ts` `/assets/transcribe-brief` | Nothing: audio is refused with 412 and text never reaches a provider | None | None | No provider call | No provider call |
| `apps/core/src/services/paid-model-probe.ts` | Scheduled billing health probe | `health_probe` | `paid_model_probe_calls` | Ledgered | Ledgered |
| `packages/integrations/src/model-gateway.ts` `ResilientModelGateway`, used only by `DurableEvaluationService` | Evaluation runs (Google, Anthropic, OpenAI) | The call's own `role` | `eval_model_calls` with `budget_reservation` | Ledgered | Ledgered |
| `apps/core/src/services/telegram-classifier.ts` `classifyInboundTelegramMessage` (model branch) | A message classification, sent with the latest preview image | Would be `intake_router` | **None** | Unledgered, **no production caller** (tests only) | Unledgered and still unused; **the lint refuses a production caller** |
| `packages/creative/src/studio/art-generator-v3.ts` `generateConditionedArtLayer` | A gpt-image call | Would be `asset_photoreal` | **None** | Unledgered, **no production caller** (`scripts/generate-p04-proof.ts` only) | Same, and **the lint refuses a production caller** |
| `routes/simulators.routes.ts` `/ingress/rehearsal`, and `bounded-creative-planner.ts` through the in-memory `CostGovernor` | Nothing: synthetic token counts go into an in-memory governor | None | None | No provider call | No provider call. Its "receipts" are not spend. |
| `packages/evals/src/judge-experiment.ts`, and every script under `scripts/` (qualification, experiments, live trials) | Operator-run paid experiments on the same key | None | Their own run receipts or manifests | Off-ledger by design (outside the service) | Unchanged; see §5 |

The creative package's judge, critique, refinement and vision functions build their own `OpenAiStudioClient` from `process.env.OPENAI_API_KEY` when no `client` is passed. This fallback is not on the Core path. Every Core caller passes the ledger client (`layouts.stage.ts`, `v3.stage.ts`, `pipeline-v3.ts` forwards `options.client`). Only scripts rely on it.

## 3. Decision

### 3.1 Intake readings appear in the call list

`CallCostKind` gains `intake_router`.

`CallCostAccountingService.list` merges the SQL page (`hawa.office_call_cost_page`) with `requester_intent_calls`:
- The merge uses the same `(startedAt, kind, id)` order in one statement, so a cursor from either source is exact.
- Equal times are tested.

An intake item shows the following:
- Its model and status (`response_received`, `not_accepted` or `unknown`; `started` when Core stopped before writing the outcome).
- Its reader and its chat.
- Its counted cost, by the office day's own rule from migration 068: the usage cost when the provider reported usage (0 when it refused), else the whole reservation.

An intake reading is **never attested**:
- `canRecord` is false.
- `POST …/evidence` returns 409 `CALL_COST_NOT_ATTESTABLE`.
- The office day treats every intake row as final, so nothing is held for it, and evidence could not change its charge.

### 3.2 One summary by day and role

`GET /v1/spending/summary?days=N` (1–92, default 14) totals every paid call of the last N office days (Asia/Baghdad, today included) by day and budget role. Each role total carries:
- `calls`.
- `accountedUsd`: the same per-call figure the list shows.
- `awaitingEvidence`.
- `heldUsd`: the reservation still held beyond the counted cost.

The figure for attestable kinds is `hawa.office_call_cost_evidence(...).accountedCostUsd`. No second cost rule exists, and the test checks that the summary equals the list added up.

The route needs **administrator or operator membership**, checked in SQL. An auditor cannot read `eval_model_calls` under its row policy, and a total silently missing that ledger would be wrong, so an auditor gets 403 instead.

The Desk's call-cost panel shows the summary above the call list, with plain role names. It labels intake rows "intake reading (requester|office|copy)" and hides the evidence form for them.

### 3.3 Unledgered paid functions stay unused

`scripts/lint_provider_egress.ts` now maps each provider file to the ledger that records its calls (`PROVIDER_EGRESS_LEDGERS`). This replaces an unannotated allowlist. The stale `system.routes.ts` entry is gone: that file no longer reaches a provider.

`UNLEDGERED_PAID_EXPORTS` lists the two paid functions that write no row. The lint fails if production code anywhere in `apps/*/src` or `packages/*/src` references one of them. Routing either one into service needs its ledger first: `readOnce` for a message reading, the Studio ledger client for an image.

### 3.4 Intake is never blocked so hard that a requester gets no reply

Nothing changes here, and this ADR records the existing behaviour. `readOnce` returns null, with no call sent, in each of these cases:
- The allowance is refused (`officeSpendingRefusal`).
- The client's consent is missing.
- There is no key.
- Admission fails.

Intake then plans from the rules alone (ADR-144 §2, ADR-286): the requester is asked a short question or answered by the rules, and is never left without a reply. A pre-flight block on intake would only add a second refusal path, so none was added.

### 3.5 One price source for counted cost (addendum, 2026-10-03)

A call's counted cost comes from one source for every text ledger: the list price in `pricing.json`, applied to the usage the provider reported. Usage is uncached input, cached input (`prompt_tokens_details.cached_tokens`), cache writes when a provider reports them, and output. The ledgers covered are:
- Studio receipts.
- Intake readings.
- Canva planner calls.
- Health probes.

The price is computed once, in `packages/creative/src/studio/list-price.ts`:
- `OpenAiStudioClient.calculateCost` (Studio) and `studioTextUsage` (intake, planner and probe) both call `priceTextUsage`.
- The long-context multipliers for Astra and Sol above 272K input tokens are applied there.
- The result is rounded up to the micro-dollar, so a counted cost is never understated.

The conservative reservation rates (`spending-reservation.ts` `textRates`) now bound only what is **held** before a call settles. That is admission and the within-reservation check. They are never a call's counted cost.

Before this change, an intake, planner or probe call on `gpt-6.1-sol` was counted at $4.50 per 1M input tokens (input plus a full cache write), while the same usage in the Studio was counted at $2. Cached input was not discounted at all.

Effects:
- Studio receipts change by at most one micro-dollar, from round-half to round-up.
- Ledger rows written before this change keep the cost they recorded. Paid-call rows are immutable, and their cached-token counts were never stored, so they cannot be re-priced exactly.
- Test: `office-spending-report.test.ts` gives an intake reading and a Studio call the same Sol usage: 420 input, of which 100 cached, and 30 output. Both report $0.000950 counted, which is the list price, below either reservation.

`cost-architecture-v3.ts` `calculateCallCost` is a separate cost model for the design-cost analysis, not a ledger. It still has its own default table.

## 4. Consequences

- The office can now see what reading messages costs, per day, next to the Studio's spend.
- `/v1/spending/calls` items may now have `kind: intake_router`. The Desk client and the OpenAPI description are updated. The evidence route's kind enum is unchanged.
- The summary adds up calls in the ledgers. It does not include the office day's "run snapshot says more than its ledger" correction row (migration 068's last UNION), nor ADR-133 pre-admission records, because they are not calls. The office day's spent figure can therefore be slightly higher than the summary for a day with such a run.

## 5. Open items found, not fixed here

1. **Voice transcriptions never become final. This needs a migration, so it was stopped and not implemented.**
   - **The cause.** Whisper reports no usage, so the voice outcome is recorded with `actualUsd: null`.
   - **What the outcome record can carry.** The `inbox_events` outcome payload is free JSON and is written once at completion. It could carry a price-list `actualUsd` (seconds ÷ 60 × the deployment's `usdPerMinute`), and the evidence function would then count it.
   - **Why that is not enough.** The SQL that decides when a voice call is *final* would still not release the hold. A received transcription becomes final only through an attestation, both in `hawa.studio_scope_budget_internal` (migration 068) and in `hawa.office_call_cost_evidence` (migration 072). The only automatic attestation, ADR-159's System Automation `reservation_expiry`, is restricted to `canva_planner` by `hawa.protect_call_cost_attestation` (migration 072). Writing a "trusted office" attestation from automation would misattribute it. So each received voice note keeps holding its reservation on every later office day.
   - **What a migration would change.** Any of the following releases the hold:
     - Treat a voice outcome of `received` that carries a numeric `actualUsd` ≤ its reservation as final, in both functions.
     - Or let `reservation_expiry` (or a new `price_list` evidence type) cover `voice`.
   - **Why it was not written.** Migration numbers collide with Codex's unreleased 083–089, so per the coordinator no migration was written. Meanwhile the summary shows each voice note's reservation as `heldUsd`, and an administrator can attest it in the Desk.
2. **Two price tables. Resolved by §3.5** for ledger rows written from now on.
3. **Operator scripts.** Qualification runs, experiments and live trials under `scripts/` spend on the production key with no office ledger row. They keep their own receipts. Writing them into the office ledger would need a tenant and scope they do not have.
4. **The creative package's env-key fallback.** `client ?? new OpenAiStudioClient({ apiKey: process.env.OPENAI_API_KEY })` remains in the judge, critique, refinement and vision functions for the scripts. Removing it would make `client` required and break every script.

## 6. Evidence

The tests are all local. No provider was called and no money was spent.

- `apps/core/test/office-spending-report.test.ts` (6; the sixth is the §3.5 parity test):
  - Each intake reader writes one row per paid call. A replayed update writes none and makes no second call. The cost equals the price table (`gpt-4.1-mini`: 420 in and 30 out is $0.000216).
  - The list shows intake rows read-only, charged as the office day charges them, including unknown and never-finished rows, and isolated by tenant.
  - Pagination at equal times omits and repeats nothing.
  - The summary by day and role equals the list added up, with voice held shown, day-bound validation, and membership-based 403 for auditors.
  - The HTTP route works.
- `apps/desk/test/call-cost-accounting.test.ts` (+1): the summary table and a read-only intake reading.
- `packages/creative/test/sol61-candidate.test.ts`: usage is now priced at list price and equals `calculateCost`.
- `scripts/test/lint-provider-egress.test.ts` (+2): a production caller of an unledgered paid function is refused; the repository passes and every provider file names a ledger.
- `apps/core/test/fixtures/route-inventory.txt`: four new route lines for `/spending/summary`.
