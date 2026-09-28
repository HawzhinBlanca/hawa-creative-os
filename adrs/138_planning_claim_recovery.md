# ADR-138: A Canva Plan Claimed Before Its Paid Call Is Carried On After a Core Restart

**Date:** 2026-09-29
**Status:** Implemented and locally qualified; not deployed.
**Requirements:** FR-059, FR-060, NFR-001.
**Changes a foundation:** ADR-101 ("Resume materializes a retained typed layout … without contacting a model"): resume may now make the plan's one paid call, only when that call was never admitted.
**Builds on:** ADR-101 (durable Canva planner calls), ADR-131 (planning slots and the named busy wait), ADR-135 (the acknowledgement and the design start together).

## 1. Context

Since ADR-135 a Telegram brief opens a RequestLifecycle request, which sends the acknowledgement and starts the design run at the same time. In the chaos scenario `R1.K0` (Core killed for 5 s while the acknowledgement is sent) the kill could therefore land in the design's planning. The run then ended `DESIGN_PLANNING` after its 30 resume polls (60 s), and the request never got a draft (ADR-135 section 5, 2026-09-28).

`CanvaDesignPlanner.generate()` (`apps/core/src/services/canva-design-planner.ts`) has three durable moments:

1. the **claim**: a `canva_design_plans` row in `planning`, under the tenant's planning lock and the task's request key;
2. the **admission** of its one paid call: a `canva_planner_calls` row (`started`), whose primary key is the plan's id, committed with its allowance reservation **before** any transport (ADR-101);
3. the recorded **outcome** (`completed`, with the typed layout), from which `resume()` rebuilds the editable source without a model.

A Core that died between 1 and 2 left a claim with no admission. `resume()` answered it "Planning is claimed but no paid call is recorded. It can be retired; this resume never dispatches a model", every time. Nothing else ever finished it: the worker's retry of `/canva/generate` with the same key, and its resume polls, got that answer until they gave up. Between 2 and 3 the call is uncertain (it may have reached the provider), and ADR-101 rightly forbids sending it again. After 3, resume already recovers.

The window between 1 and 2 is not small: it holds the exemplar images read from disk, the prompt with any reference images, and the reservation estimate over that body.

## 2. Decision

- **A claim with no admitted call is carried on** (`carryOnClaim`, called by `resume()`, and so by a same-key `generate()`). Admission is committed before transport, so the absence of an admission row proves the model never received this plan: making the call now is the first and only paid call, not a second one.
- **Exactly once, under the plan's own id.** The carried-on call is admitted like any other: in one transaction that locks the task row, rechecks generation is allowed, the task version, client, request owner, studio calls, the client reference and the spending allowance (`hawa.enforce_canva_planner_call`), and inserts the call row with the plan's id. A second process carrying the same claim on (or the original, if it was only slow) finds that row (or hits its primary key), sends nothing, and answers where the plan stands (`PlannerCallAlreadyAdmitted`).
- **Only the same plan.** The claim's inputs are recomputed and must hash to the claimed request (with the model the claim fixed). If they changed, the plan fails `PLAN_INPUT_CHANGED`; if the task no longer allows generation, or the reference or copy is refused, it fails with that code. Nothing was admitted or spent in either case. An unavailable store or database is asked again, not failed.
- **An admitted call is still never sent again** (ADR-101 unchanged): a claim whose call is `started` stays `planning` until its outcome or named cost evidence settles it.
- Chaos points `core.planner.after-claim` and `core.planner.after-admission` mark both moments, for the chaos suite and the process-kill tests.

No migration. No worker change: the design run's retry of `/canva/generate` and its resume polls reach `resume()`, which now carries the claim on.

## 3. Consequences

- A Core restart during planning costs the design a few seconds instead of the draft: the request goes on to its draft with one planner call.
- A Core that dies while the call is in flight (after admission) still leaves an uncertain call; the design run ends `DESIGN_PLANNING` after 60 s and the charge is settled in Operations, as before. That window is the transport itself.
- "Resume" in the Desk can now spend: on a claim with no admitted call it makes that plan's one call, under the same allowance admission as Generate.

## 4. Verification

- `apps/core/test/canva-design-planner.test.ts`, "a Core killed during planning (ADR-138)", real PostgreSQL, a child process SIGKILLed at the chaos point: a claim carried on by the same key (one model call, draft imported, a second ask plans nothing); two processes carrying one claim on at once (one model call, one admission; the other answers `planning`); inputs changed or the task paused after the claim (fails with nothing admitted); killed after admission (never sent again, stays `planning`). Red first: with only the two chaos points added to the unchanged planner, the first three failed and the fourth passed.
- Chaos: `R1.K0` repeated and the deterministic `R1.K0P` (Core killed at `core.planner.after-claim`), each checking one plan with one admitted, completed call and no paid call twice. Results: `plans/lean-design-implementation-2026-09-28/RECONCILIATION_PROOF.json`.
