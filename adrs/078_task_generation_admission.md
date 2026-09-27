# ADR-078: Task authority at every design admission

Date: 2026-09-27  
Status: Accepted  
Requirements: FR-060, FR-061, FR-064, NFR-017, NFR-020

## Evidence and decision

Closed tasks could start a fresh Studio run and the paid-call ledger did not lock
or inspect task state. Seven new regression cases failed before the change.
A check only in Desk or at resume entry cannot stop a later stage call after a
concurrent cancellation.

Use the existing shared task-state vocabulary. New design generation is refused
for complete, cancelled, rejected, paused, approved and publishing tasks, including
publication reconciliation states. Unknown task state also refuses admission.
A paused task must resume or resolve its question; an approved task needs a revision;
a closed task needs a new request. These are eligibility checks, never grants of
actor, client, model, budget or provider permission.

Studio run creation, candidate selection, planner reservation, blank creation and
new Canva imports check state under the task lock. Every Studio model-call
reservation locks the same task with the authenticated actor's RLS scope, verifies
its run/client binding, and checks eligibility before inserting the call ledger.
No transaction is held over provider transport. This is the admission ordering
point: an operation admitted before cancellation may still finish afterwards.

Existing keyed receipts remain readable and admitted Canva imports can reconcile.
A previously admitted model call may record its paid outcome after closure. A
refusal does not invent a paid attempt, overwrite evidence, abandon the run or
enter an automatic fallback. A recorded uncertain call still requires reconciliation.
Cancellation does not promise that a provider request already admitted can be undone.

Desk uses the same eligibility rule, keeps read/feedback/abandon controls, disables
new generation where unavailable, and shows requested versus provider-reported
served models from actual call receipts. Missing served model stays unreported.
Transient intake/creation messages do not claim the next task action indefinitely.
Automatic-intake feature flags do not independently disable explicit Studio actions.

## Durable operator controls

Inspection found the legacy cancel endpoint moved tasks to failed_operator, while
pause/resume/retry all targeted design_planning; it also swallowed persistence
failures. Cancel now records cancelled, and pause records paused. Resume requires
an actual operator-pause event and restores that event's prior state; a requester
question is not an operator pause. This conditional operator policy lives in domain
code, separate from normal pipeline transitions. Terminal tasks cannot reopen.

The task lock serializes each control with call admission. A current expectedVersion,
reason, authenticated actor and stable key bind an append-only receipt to the state
change. Replay returns the original receipt even after later progress. Changed keyed
input conflicts. Failure to save the event rolls back the state and returns an error;
there is no memory-only success path. RequestLifecycle ownership is rechecked inside
the lock. The generic retry route refuses without a saved execution checkpoint and
points to explicit saved-run controls; it no longer claims a retry by changing a word.
Desk exposes these durable controls for legacy tasks and requires a reason.

## Verification and limits

Regression coverage includes closed/paused/approved state pairs, historical replay,
no new planner/provider operation, cancellation after context construction,
concurrent task locking, restricted runtime role and revoked membership, retained
paid finalization, and candidate-selection evidence. The deployed candidate adds
HTTP refusal checks for Studio, planner and blank creation with no admitted rows.

See R26 evidence for executed results and failed-first history. Fake external
services do not qualify native Canva editability, live billing, human creative
review or clean-host restoration. The existing studio/workflow foundations remain.
