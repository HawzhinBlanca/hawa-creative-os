# Canva creation reconciliation

ADR-108; FR-060/NFR-020. Applies to the original import or blank-design operation.

## What the status means

- `submitted`: a remote import job is known and can still be checked automatically.
- `uncertain`: creation may already have happened. Do not submit another document.
- `failed` with retained nonacceptance or matching provider-failure evidence: a new
  import key may be admitted. Replaying the original key returns its original result.
- Historical `failed` without that evidence is displayed as uncertain. The old row
  is preserved; its label alone cannot authorize another creation.

After the polling deadline, Core stops automatic checks and the task's Canva
operation history explains that reconciliation is required. An unavailable job,
expired authorization or a missing response is not evidence of no design.

## Recover the original work

1. Open the task's Canva operation history and identify the original operation.
2. Reconnect the account that submitted it if necessary. An authorized art director
   or administrator can request an import check; Core uses the original connection.
3. Use **Check import** to query the original job. A successful single-design result
   binds that design; no new import is submitted. A still-pending or unavailable
   result remains held. Polling age does not change this decision.
4. If a design ID was returned before the local handoff stopped, inspect it in Canva
   and use the existing native binding handoff for this task. Then capture and verify
   the actual source/export before human approval.
5. If the job ID or design identity cannot be established, retain the hold and inspect
   the submitting Canva account/provider evidence. This release does not offer a
   generic abandon-and-retry action for uncertain creation.

Do not edit database statuses, change the idempotency key, rerun the planner or create
a blank design to bypass uncertainty. They do not establish what Canva already did.
An old failed record may require the same investigation. No historical failure proof
is fabricated automatically.

Exports have a separate read-only retry policy. This creation rule does not turn an
export into approved evidence or waive copy, font, native editability or human checks.

## Verification boundary

Acceptance uses real isolated PostgreSQL and fake Canva transport, including lost
replies, missing jobs, old pending jobs, multiple/mismatched results, reconnects and
concurrent completion. Live provider behavior, native manual recovery and full release
admission remain separately qualified.
