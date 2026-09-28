# ADR-133: Spending From Before Daily Admission Stays in Its Own Day

**Date:** 2026-09-28
**Status:** Accepted by the owner on 2026-09-28 ("Old days stay in the past"); migration 067. Rehearsed on the 16:09Z production dump.
**Requirements:** FR-079 (per-role budgets and generation caps), FR-062 (expensive model concurrency limited by office scope), FR-059 (a provider or capacity refusal asks for human action without losing work).
**Changes a foundation:** ADR-092 (Studio daily scope budgets) and ADR-101 (durable Canva planner calls): which unresolved records hold today's office allowance, and which make it "history incomplete".

## 1. Context

Daily admission (migration 051, ADR-092) counts today's costs and every unresolved paid record of any earlier day against today's office, client and role limits. A record whose cost is neither final nor quoted marks the office `historyIncomplete`, and `enforce_studio_scope_budget` then refuses every new Studio call with `STUDIO_BUDGET_HISTORY_INCOMPLETE`. ADR-101 added Canva plans to the same aggregate and chose that "old planner plans without paid-call records remain visibly incomplete accounting evidence ... reconciled through the same named accounting surface before more office spending is admitted".

Production reached this release on 2026-09-28 (deploy b94de6a6, 16:50 +03) with 79 such records, all created before either rule existed:

- one Studio call (2026-09-18 15:01Z, `laying_out`, GPT-6 Astra, no reply and no provider request id, in a run that failed); estimate $0, no reservation, no policy version;
- 78 Canva plans (2026-09-13..20; 34 on Claude Opus 5, 43 on GPT-6 Astra, one with no model) with no `canva_planner_calls` row and no `paid_protocol`.

No other ledger records their cost (`hawa.model_invocations` is empty). Both reconciliation surfaces (`/studio-recovery/.../settlement`, `hawa.call_cost_attestations`) require a named office administrator, and production does not configure Google sign-in (ADR-064), so nobody could clear them. The first request after the deploy (the owner's Telegram test, task `dca13ce5`, 2026-09-28 16:33Z) ended `DESIGN_REJECTED (STUDIO_BUDGET_HISTORY_INCOMPLETE)`. Every Studio call and Canva plan for every client was refused in the same way. The chaos and test databases hold no records from before 051, so no gate saw it.

A quote would not have helped. Holding each unknown record at a ceiling above the largest single call on record ($0.2732) keeps $1.00 × 79, or even $0.30 × 79 = $23.70, held against a $30 office day indefinitely.

## 2. Decision

A record from before daily admission was billed, if it was billed at all, on its own day, when no daily limit existed. It cannot consume today's allowance. Migration 067 freezes those records by id into `hawa.pre_admission_spending` (`studio_call`: no policy version, no reservation, status `uncertain`; `canva_plan`: no planner call and no paid protocol), and `studio_scope_budget_internal` leaves them out of today's obligations.

- Nothing is given an invented cost, and the call and plan rows are unchanged. The records stay on the accounting surfaces for reconciliation when a named administrator exists.
- The list is written only by the migration. The runtime role can read it and cannot write it, so a record that appears later without a quote still makes the office history incomplete, exactly as ADR-092 and ADR-101 require.
- Saved run totals that exceed their ledger still block, as before.
- The migration runs with `row_security = off`, so a migration role without the superuser's bypass fails instead of freezing an empty list.

## 3. Consequences

- Studio drafts and Canva plans are admitted again, against the full $30 office day.
- The office's daily view no longer counts these 79 records as held. Their total cost stays unknown, at most what the provider billed on those days.
- Rolling back means dropping the table and restoring 056's function body; the office then blocks again until the records are reconciled.

## 4. Verification

- Rehearsal on the `predeploy_20260928T160938Z` dump, restored into a scratch database on the test server and dropped afterwards: before, office and `creative_director` read `historyIncomplete: true`; after, 78 plans and 1 call were frozen, and both read `historyIncomplete: false` with $30 remaining.
- `packages/db/test/studio-scope-budget.test.ts`: a frozen pre-admission call from an earlier day does not hold a $0.50 office day; the same call unfrozen still refuses admission; `hawa_app` cannot write the list; the existing ADR-092 cases (an unquoted call with a policy version, missing run history) still refuse.
