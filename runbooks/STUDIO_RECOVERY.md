# Recovering held Studio model calls

Requirements FR-060/065/067/079 and NFR-001. ADRs 086, 087 and 088.

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

## Spending and call limits

New art work records each image attempt and its vision check as separate calls
(ADR-090). A two-attempt art pass can therefore consume four call slots. Each
request checks current limits before transport; a saved art aggregate is reporting
only and does not add another charge. Older aggregate receipts may omit vision
costs and are retained as historical evidence, not recalculated as complete bills.

A lost vision reply holds the run even when the generated image is already saved
in the receipt ledger. The receipt contains its hash, not recoverable image bytes.
`MODEL_CALL_ACCOUNTING_FAILED` also holds the run: inspect the admitted calls and
first outcomes before any new work. Never clear that condition by retrying art or
selecting a procedural result. Completed-stage response recovery remains open.

Desk shows the cumulative number of admitted calls and spending counted from the
run's receipts, including later parity checks on a transferred design. The saved
run budget is a historical snapshot; it is not permission to reset those totals.
Administrator-reported additional cost is displayed separately. A late receipt
cannot reduce a higher settled amount used for admission.

- `BUDGET_EXHAUSTED`: no further model call can be admitted on this run. Calls
  already admitted can still finish and record costs. Review the current result
  before explicitly requesting separately billable work.
- `STUDIO_BUDGET_HISTORY_INCOMPLETE`: the saved spend or call count exceeds the
  available ledger. Preserve the history; do not lower the counters or erase calls.
  Inspect the evidence and resolve uncertainty before a separately requested new run.
- `STUDIO_BUDGET_INVALID`: fix invalid configured limits before requesting new work.
  USD must be finite and positive; the call cap must be a positive safe integer.
  Missing historical settings do not authorize default spending.

Before ADR-091, the USD limit stopped new requests only after recorded spending
reached it. The reservations below now account for admitted work before transport;
they remain estimates rather than invoice guarantees. Shared office/client/role
limits are described in [Shared daily spending](STUDIO_DAILY_BUDGETS.md).
No settlement automatically supplies a missing stage result or retries its model.


## Spending reservations (ADR-091)

Desk shows recorded estimates, additional administrator-reported cost, reserved
funds and available funds separately. A completed reply without usable token
counts can still reserve money. Restarting or cancelling does not free it.
Unknown acceptance still requires exact-call terminal settlement as above.

A new call that cannot fit its quote stops before provider transport. Preserve
its requested model, quality and output limit; a smaller budget does not authorize
an automatic quality reduction. `STUDIO_BUDGET_UNQUOTABLE` means the payload needs
a qualified bound. `STUDIO_BUDGET_RESERVATION_EXCEEDED` means a recorded provider
charge exceeded the quote: retain the charge and review the pricing policy.
The old run remains held; do not rewrite its quote or lower its cost to resume it.

These quotes use published rates and conservative token bounds, not invoices.
Google image estimates without complete modality usage retain the whole model
output reservation. OpenAI auto image quality reserves the highest quality.
Historical rows have no fabricated quote. ADRs 092/096 add shared daily limits for
Studio, evaluations and retained voice. Other paid-path integration, named cost
repair for completed estimated/unknown calls and live invoice reconciliation
remain pending.
