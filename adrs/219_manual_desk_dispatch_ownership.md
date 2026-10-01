# ADR219 — Manual Desk task dispatch ownership

Date: 2026-10-01. Status: proposed; qualification pending.
Requirements: FR-006, FR-004, FR-060, FR-061, NFR-014.
Sources: docs/09_MESSAGING_AND_OFFICE_INBOX.md, docs/10_WORKFLOW_RELIABILITY.md,
docs/30_CURRENT_STUDIO_CONTRACT.md, MASTER_SPEC.md, ADR126.

## Evidence and reason

Current deployed synthetic recovery candidate2e556564 fails manual Desk generation
with TASK_CHANGED. Retained actual events show a canva_manual task created at
15:18:28.599Z/version1; the worker dispatches its pending creation command and
reports MANUAL_DESIGN_REQUIRED at15:18:28.788Z, changing it to failed_operator/
version2 during materialization. Another candidate's later Studio settlement
failed without response diagnostics; this same race is a possible cause, not an
established explanation for that earlier failure. No model or revision guard
should be weakened to hide it.

## Decision

Use the existing atomic task/event/outbox creation pattern. An explicitly manual
Desk intake records a distinct manual-owned, already-recorded creation receipt,
not a claimable automatic workflow command. Keep original submitted-body identity,
scope, client/DNA evidence and replay behavior. Preserve default automatic and
lifecycle-recorded receipts. No migration, worker permission expansion or new queue.

An old pending creation command may already be executing. Core may acknowledge its
specific no-automatic-job MANUAL_DESIGN_REQUIRED callback as ignored only when the
immutable task.created source explicitly selects canva_manual, the task is not
lifecycle-owned and no design/run is presented. Do not mutate task/version, enqueue
messages, claim a draft or rewrite old receipt history. Other automatic outcomes,
request ownership, current-revision checks and explicit office actions retain
existing admission.

## Qualification

Preserve deployed generation/race and earlier unknown settlement failures. Actual
Core/PostgreSQL tests must prove atomic manual receipt/cold retry, exclusion from
worker claims, unchanged task/event/version on repeated old no-job callbacks,
default automatic dispatch, document source/recovery receipts and existing outcome/
lifecycle/control/revision fences. Repeat exact current Docker source/asset/recovery/
delivery scenario with real worker active; inspect manual task state/version/receipt
and zero unwanted TaskWorkflow submission. Run strict/build/lint and exact engineering
gate; production-dump transfer, native/human/product admission remain separate.

Original actual Core regression:5 passed/2 failed. The first connected run used
the stale built DB package:41 passed/1 failed/1 skipped; rebuilt normal workspace
packages. Expanded14 files176 passed/1 failed: the new negative control expected
failed_operator even when a design ID was presented; inherited outcome semantics
correctly sent that draft to human_review. Fix only its expected state, preserve
the distinct no-job fence, and rerun. All original failures retained.

ADR219 connected: manual Desk creation records an unclaimable MANUAL_DESK_OWNED outbox receipt while preserving atomic task/event/receipt identity. Old source-bound no-job callbacks cannot alter manual task/version; actual default/draft/lifecycle outcome semantics remain. Original Core5pass/2fail and deployed TaskChanged race retained; stale-build and negative-fixture failures retained.14files177passed/0failed/0skipped; actual PDF31checks/four SIGKILL/six restarts/fresh dump+file restore PASS;698 strict roots/build/lint/standalone chaos types PASS. Exact current Docker and engineering gate pending. No deployment/native/human/product/RPO admission. W6_MANUAL_DESK_DISPATCH_PROOF.json.

Exact clean55542978 engineering gate:6922 passed/0 failed/67 skipped,691 passed
files/six skipped,698 strict roots,1792 package checks,seven stages and mandatory
negative refusal. Production-dump Stage3 NOT_RUN; prior transfer authorization
still pending. Its Docker source/download/restore/delivery and manual generation
passed155 controls before a new fixture sent a generic worker credential to a
nonexistent /internal design callback and parsed nginx404 HTML as JSON. Retained
actual readback confirms the worker's real dedicated design credential and exact
/v1/tasks/:id/notifications/canva-status route return200/MANUAL_DESK_OWNED, no
notification, received/version1/one recorded receipt and zero TaskWorkflow runs.
Correct only the harness credential/route to the actual worker implementation.
Application/test/infra source is unchanged from55542978; full corrected rehearsal
pending. Both credential boundaries remain strict.
