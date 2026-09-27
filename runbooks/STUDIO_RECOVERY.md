# Recovering held Studio model calls

Requirements FR-060/065/067/079 and NFR-001. ADRs 086 and 087.

## Inspect and stop

1. Open the task's Studio panel and **Resolve held model calls**. Read the original
   provider/model, request/response IDs when present, and unknown versus estimated
   cost. A timeout, process crash or stale run is not proof of non-acceptance.
2. Stop an active run through its existing owner. A manual run has **Abandon**;
   RequestLifecycle-owned work retains its existing workflow controls. Settlement
   refuses active runs and cannot change request ownership or advance a task.
3. Do not re-key a request, erase calls, or switch to the alternate planner to
   bypass uncertainty. Those paths check all unresolved Studio calls for the task.

## Obtain evidence and settle

1. Obtain terminal provider receipts or support confirmation for **every unresolved
   call**. Provider-confirmed non-acceptance requires a final cost of zero; confirmed
   completion requires a known final reported cost. Unknown acceptance or cost
   remains held. A request ID or empty dashboard alone is insufficient evidence.
2. Sign in as a named office administrator. Shared administrator keys cannot settle.
3. Reload the recovery evidence. Enter the final cost, provider/support reference,
   digest of the retained evidence, and reason. The optional local file picker
   computes SHA-256 without uploading the evidence file. Keep that file in the
   office's evidence archive.
4. **Record Studio settlement** freezes the snapshot and action before submission.
   If the answer is lost, reload or use **Retry saved settlement**. Do not replace
   the saved action. A changed snapshot requires reloading before correction.
5. The panel shows administrator-attested cost separately from original unknown
   cost or provider estimates. Original calls, run budget/status and task ownership
   are unchanged. Settlement sends no model request, supplies no missing design
   result, and cannot waive approval or export QA.
6. New generation is an explicit, separately billable action under the task's owner.
   A transferred run's later parity calls have their own identities and holds;
   earlier settlements do not cover them. The original call identity cannot replay.

Previously admitted calls can still return their first late outcome. Compare that
receipt with the separate attestation and investigate any disagreement. This tool
records staff evidence; it does not automatically verify invoices or provider claims.

API: GET `/v1/tasks/<taskId>/studio-recovery/<runId>` returns original receipts,
settlement history, `snapshotHash`, `canSettle`, and `requiresStop`. POST the same
path plus `/settlement`, with UUID `Idempotency-Key`, `expectedSnapshot`, `reason`,
and `calls` entries containing `callId`, `conclusion`, `reportedCostUsd`,
`evidenceReference`, `evidenceSha256`. Named session, CSRF and active membership
apply. Task/client/run scope, stopped state, snapshot and exact coverage are checked
under locks. Evidence is append-only with FORCE RLS and SQL authority checks.

General model-response replay and automated provider lookup are not implemented.
Synthetic test identities and provider fixtures do not constitute live billing,
human design review, or production readiness evidence.
