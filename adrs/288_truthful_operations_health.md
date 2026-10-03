# ADR-288: Truthful Operations Health: Canva Check, Production Call Evidence, Request Funnel and Approval Target

**Date:** 2026-10-03
**Status:** Implemented on branch `claude/opstruth` (from `claude/release-2` 3ad1aff2). Not deployed.
**Requirements:**
- NFR-002: office intake and review availability; the office must see when a dependency stops.
- FR-064: a failed step exposes its error class and the next safe action.

**Changes a foundation:** no. No migration, no new dependency, no paid call. One free Canva GET every ten minutes.
**Builds on:**
- ADR-155: office alerts and the lifecycle stale sweep.
- ADR-158: health semantics with the paid probe off ("disabled", Canva "unverified" not degraded).
- ADR-230: chat-only delivery (publication left open, task complete).
- ADR-240 and ADR-254: the canary chat range and the canary client.

**Number:** 288. Checked free on 2026-10-03 across every branch (`git log --all -- adrs docs/adr`), the main checkout and every worktree under `.claude/worktrees` and `.worktrees`. The highest number in use was 286.

## 1. Context

Production `/v1/health` on 2026-10-03 (build 1e6881ac) read:

| Field | Value | What was true |
|---|---|---|
| `dependencies.canva` | `unverified` | Nothing ever asked Canva. An expired connection was found only when a design failed at the transfer. |
| `dependencies.modelProvider` | `disabled` | The production models drafted every request (tier production). "disabled" described the paid probe, which is off (ADR-158), not the provider. |
| `lastVerifiedProgressAt` | `null` | Set only when a paid probe was sent, so null for good with the probe off. |
| `funnel` (48 h) | 29 briefs, 8 drafts, 1 approval, 1 delivery; draft→approval and approval→delivery 0 samples | See below. |

The funnel had five faults:

1. **Timings and counts read different windows.** The counts read events in the window (an approval row created in the last 48 h). The timings read only tasks briefed in the window. A request briefed before the window and approved or delivered inside it was counted and never timed.
2. **Delivery was timed only from a completed publication.** A chat-only delivery (ADR-230: the requester has every file, the office's Google archive is not connected) completes the task and leaves its publication open. It was never timed.
3. **Every task was a brief.** A revision round, an office retry ("try again") and an answered question each create a task in the same request. Each counted as a brief, so "29 briefs, 8 drafts" overstated the loss.
4. **The nightly canary's requests were counted.**
5. **Approvals and deliveries were sums.** They added task states (`approved`, `complete`) to approval and publication rows. One request that was approved and published counted twice.

There was no alert for a draft that waits too long for office approval in working time. The stale sweep (ADR-155) reminds after 2 wall-clock hours per request stage.

## 2. Decision

### 2.1 Canva readiness check

`CanvaReadinessProbe` (`apps/core/src/services/canva-readiness.ts`) runs every 10 minutes in production (`HAWA_CANVA_READINESS_PROBE=off` stops it). It uses the connection designs transfer under, the Primary Operator's:

1. Read `hawa.canva_connections`. If there is no row, or its status is not `active` or `refreshing`, the result is **expired** and Canva is not asked.
2. `CanvaConnectService.authorizedClient` refreshes the token if it is due. This is the same guarded, claimed rotation every design uses. If Canva will not renew the sign-in (`CANVA_RECONNECT_REQUIRED`), the result is **expired**. If Canva refuses the integration's refresh credentials (`CANVA_TOKEN_REFRESH_REFUSED`), the result is **revoked**.
3. `CanvaConnectClient.probeCurrentUser()` sends one `GET /v1/users/me`, with no retry. This call is free, reads none of the office's designs and changes nothing.
   - 2xx: **connected**.
   - 403: **connected**. Canva accepted the token but not the scope.
   - 401: **revoked**.
   - 429, 5xx or a network error: **unreachable**.
   - If the integration settings are missing: **unconfigured**.

Health reports `dependencies.canva` with this status, and `canvaReadiness: {status, checkedAt, attemptedAt, detail}`.

- **Degraded:** `expired`, `revoked` and `unreachable`. An open circuit breaker still reads `outage` or `degraded` first.
- **Caching:** an answer is kept for 10 minutes. Health never asks Canva more often than that. Only the first read, before any answer exists, waits for the check, and for at most 8 s.
- **Debounce:** one unanswered check keeps the previous answer, with a detail saying so, and is retried in 2 minutes. A second unanswered check in a row reports `unreachable`. This Mac's internet drops for a moment more often than Canva does.
- **Alerts:** all go through the outbox (`notify.telegram`, aggregate `integration`), the path the stale sweep uses, to every office member.
  - Moving into `expired` or `revoked` alerts once per connection. The key is `notify.office:canva-readiness:<status>:<generation>`. A reconnect changes the generation, so a later loss is alerted again.
  - `unreachable` alerts once it has lasted 30 minutes, at most once a day per connection.
  - The wording is plain English. It says what stopped, what it means (drafts will stop or be delayed) and what to do (connect Canva again in Hawa Desk, Settings), or that nothing needs doing yet.
- **Deploy gate and watchdog:** the deploy gate (`deploy.sh`) already treats `canva: unreachable` as an internet warning. It does not fail on `expired` or `revoked`, which are not release faults. The watchdog pages on degraded health that has these values.

### 2.2 Model provider and last verified progress

With a paid probe scheduled, nothing changes. With the probe off, the provider's status comes from production's own calls. No call is made.

**Sources.** These ledgers already record whether the provider answered each call:

- `design_studio_calls`: `ok`, `error` or `uncertain`.
- `canva_planner_calls` and `requester_intent_calls`: `response_received`, `not_accepted` (a provider 4xx) or `unknown`.

Health reads them for the last 7 days.

**Status** (counting calls in the last 24 h):

- **connected:** at least one of the newest three calls was answered.
- **failing:** none of the newest three were answered. This makes health degraded.
- **idle:** no calls. This does not make health degraded, and the watchdog's ok-set already includes `idle`.

**Evidence shown.** `modelCalls` gives `recentCalls`, `recentAnswered`, `lastAnsweredAt`, `lastFailedAt` and `lastFailure` (a code only). `lastPaidProbe.status` still says `disabled`, which is true of the probe.

**`lastVerifiedProgressAt`** is the newest of three times:

- a paid probe sent,
- a model call answered,
- a Canva draft made (`lastDraftAt`).

Calls and drafts made by the canary count. They prove the provider and the pipeline work.

**Not seen.** Model calls made outside these three ledgers are not counted. If production makes calls only through such a path, health reads `idle`, not `connected`. This is honest, but incomplete.

### 2.3 Funnel metric definitions

A **request** is one `hawa.requests` row together with all its tasks, which share a `request_id`. A task from before the request lifecycle (no `request_id`) is its own request. Requests touched in the last 90 days are read.

**Excluded everywhere:** canary requests. A request is the canary's when any of these hold:

- its chat id is in the reserved range [2^52, 2^53);
- the `sourceChannelId` of a task's `task.created` command is in that range;
- a task is for the canary client (`CANARY_TEST_CLIENT_ID`).

How many were left out is reported as `excluded.canaryRequests`.

**Stage times** (each is the first one in the request):

| Stage | When |
|---|---|
| Brief | The earliest of the request's creation and its first task's creation. |
| Draft | The first Canva binding on any of its tasks (any direction, any round). |
| Approval (evidence) | The first approval row with decision `approved`, or the first `task.state_changed` event to `approved`. |
| Approval (state only) | Used only when there is no evidence: a task in state `approved`, `publishing` or `complete`, read at its `completed_at`, otherwise its `updated_at`. It is counted, never timed. |
| Delivery | The first completed publication, or the first task in state `complete`, read at its `completed_at`, then its `complete` event, then its `updated_at`. A chat-only delivery counts. |

**Counts.** Each request is counted at most once per stage. The window is `windowHours`, 48 by default.

- `briefsCount`: requests briefed in the window.
- `draftsCount`, `approvalsCount`, `deliveriesCount`: requests whose first draft, first approval or first delivery fell in the window.
- `briefsDrafted`: requests briefed in the window that have a draft by now.
- `cancelledBeforeDraft`: requests briefed in the window that have no draft and ended. They are split by cause:
  - `requesterWithdrew`: the withdraw event's actor is the requester.
  - `officeCancelled`: the withdraw event's actor is the office.
  - `systemFailed`: the newest task is `failed_operator` or `failed_retryable`.
  - `other`: the request is `cancelled`, `expired` or `rejected` for another reason, or a pre-lifecycle task is `cancelled` or `rejected`.

**Stage durations.** Each one is timed for every request whose *later* event fell in the window, wherever the earlier event fell. Each reports p50 and p95 using `percentile_cont` interpolation.

- brief→draft: brief to first draft.
- draft→approval: first draft to first approval evidence. Revision rounds are included, so the three stages add up to brief→delivery.
- approval→delivery: first approval evidence to first delivery.

A sample needs recorded evidence. An approval known only from a task's state has no time of its own, so it adds no sample.

**North star** (`northStar`, last 7 days, canary excluded):

- `deliveredDesigns`: requests first delivered in the 7 days.
- `firstDraftApprovalRate`: among requests first approved in the 7 days, the share approved on the first draft (`approvedFirstDraft` of `approvals`). A first-draft approval has no office `revision_requested` decision, and no more than one of the request's tasks got a Canva draft. A requester's revision round or a redo is its own drafted task. The rate is null when there were no approvals.
- `medianBriefToDeliveryHours`: the median of brief→delivery over the requests delivered in the 7 days, with `briefToDeliverySamples`.

**Compatibility.** Existing fields keep their names and types for the Desk. Stall detection (`status: stalled`) is unchanged. It is task-based and is checked before `idle`, so a stalled canary request is still a stall.

The Desk Operations screen shows the north-star line and the before-draft line when Core sends them.

### 2.4 Approval target alert

`sweepApprovalSla` (`apps/core/src/services/approval-sla.ts`) runs every 15 minutes, with the lifecycle stale pass.

**What it alerts on:** a draft in office review (task `human_review`) that has waited longer than the target in working time.

**Defaults** (each can be changed by environment variable):

| Setting | Variable | Default |
|---|---|---|
| Target | `HAWA_APPROVAL_SLA_BUSINESS_HOURS` | 4 working hours |
| Days | `HAWA_OFFICE_DAYS` | Sunday to Thursday |
| Hours | `HAWA_OFFICE_HOURS` | 09:00 to 17:00 |
| Time zone | `HAWA_OFFICE_TIMEZONE` | Asia/Baghdad |

A value that cannot be read keeps its default. Offsets come from Intl, so a time zone with daylight saving works.

**Rules:**

- Waiting starts at the draft's last `task.state_changed` event to `human_review`, or at the task's last update if there is none.
- **One alert per draft.** The key is `notify.office:approval-sla:<task>`, and every office member gets the alert, as in the stale sweep. A revision round is a new task, so its draft is a new draft.
- Canary drafts are skipped.
- A draft that has waited more than 14 days is not alerted on a first sweep.
- At most five drafts are alerted per pass.

**Wording** (plain English): "A draft has been waiting for office approval for 6 working hours, longer than the 4-hour target: "Graduation banner" for KAAE. It has waited since Thursday 16:00 (Baghdad time). Please approve it or ask for changes." This is followed by the Desk review link when one is configured.

**Relation to the stale sweep:** this alert is in addition to the stale sweep's 2-hour wall-clock `in_review` reminder (ADR-155), which is unchanged. That reminder exists because a draft once waited overnight. The two measure different things: the reminder is a prompt, and this is the office's target. Whether to keep both is the owner's decision (see 4).

## 3. Consequences

- Health can now say Canva is connected, which it never could. The office hears within about 10 minutes when the connection expires or is withdrawn, not at the next failed design.
- Production health reads `modelProvider: connected | idle | failing` with the evidence. Health can now be degraded by `failing`, which pages through the watchdog.
- The funnel numbers drop: per request, canary excluded, with no double counts. Every counted approval and delivery that has recorded evidence is timed. The north-star numbers are available to the Desk.
- There are new outbox rows of aggregate type `integration`. The worker's `notify.telegram` handler sends them as it sends any office alert.

## 4. Open

- **Office hours and working days** (Sunday to Thursday, 09:00 to 17:00) are an assumption. The owner should confirm them and set `HAWA_OFFICE_HOURS` and `HAWA_OFFICE_DAYS`.
- **Two review reminders.** The owner should decide whether the 2-hour wall-clock `in_review` stale reminder stays beside the 4-working-hour target alert.
- **The production cause is inferred.** The exact cause of production's "1 approval, 1 delivery, 0 samples" was not read from production data: no SQL is run on production. Faults 1 and 2 in section 1 each produce that picture, and both are reproduced in `apps/core/test/funnel-request-units.test.ts`. Which of them caused it is an inference.
- **Unconfirmed Canva scope.** Canva's documentation does not say whether `GET /v1/users/me` needs a scope beyond the three Hawa requests (`design:meta:read`, `design:content:read`, `design:content:write`). A 403 is read as connected, so a scope refusal cannot show as an outage.

## 5. Evidence

- `apps/core/test/funnel-request-units.test.ts` (6): red on the old funnel (briefs 8 instead of 5, drafts 4 instead of 2, no north star, a 12 h window [6, 2, 5, 5] instead of [4, 1, 1, 2]), green after.
- `apps/core/test/health-semantics.test.ts` (4)
- `apps/core/test/paid-model-health.test.ts` (5)
- `apps/core/test/canva-readiness.test.ts` (8)
- `apps/core/test/approval-sla.test.ts` (5)
- `apps/desk/test/operations-presentation.test.ts` (2)
- Unchanged and passing: `funnel-monitor`, `funnel-stall-condition`, `production-entrypoint`, `lifecycle-only-telegram`, `lifecycle-internal-intake`, `telegram-poller-owner-health`, `core`, `fault-recovery-security-cv20`, and the integrations Canva client tests.
