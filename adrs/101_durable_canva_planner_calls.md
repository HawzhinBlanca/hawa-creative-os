# ADR-101: Durable Canva planner calls and retained layout recovery

Date: 2026-09-27
Status: locally qualified; real provider/native Canva admission pending
Requirements: FR-060, FR-064, FR-065, FR-079
Sources: docs/10_WORKFLOW_RELIABILITY.md; docs/17_UI_UX.md; docs/30_CURRENT_STUDIO_CONTRACT.md

## Evidence and decision

The planner currently persists a plan before dispatch, but does not reserve the
office allowance. A `redrive_` key can retire uncertain work and dispatch again.
Successful replies exist only in process memory until editable source encoding
finishes. A crash can therefore lose a paid result. Missing usage defaults to zero.

Keep one immutable paid attempt per plan. Quote the exact bounded native request
using the existing reviewed rate policy, then commit admission against the same
office/client/creative_director allowance and PostgreSQL lock as other paid paths.
Persist actual receipt metadata, complete usage, acceptance, uncertainty, and a
schema-validated layout before materialization. Do not retain raw provider errors.

Same-key replay always returns the original plan, including failed or abandoned
plans. No timestamp retry key or redrive exception is allowed. Abandonment retains
financial and execution evidence. Unresolved planner calls block alternate Studio
work on the task. Named terminal cost evidence may resolve the charge; it cannot
invent a layout, retry a transport, or approve a design. A fresh paid plan requires
an explicit new key and retirement of the previous active plan.

Resume materializes a retained typed layout against frozen copy/reference inputs
without contacting a model. It rechecks task/client ownership and active reference
before creating a new editable source/import. A changed model setting does not
invalidate retained results. Concurrent resumes may compute source locally but only
one source wins; subsequent imports use the existing stable plan operation key.

Studio-produced transfer files carry an immutable foreign key to their scoped Studio run;
that run owns their paid-call accounting. Matching historical Studio receipts are
classified by their actual tenant/task/client/run/hash relationship. This avoids
counting transfer files as second planner calls.

Old planner plans without paid-call records remain visibly incomplete accounting evidence.
They are not assigned invented usage or zero costs. They can be reconciled through
the same named accounting surface before more office spending is admitted.

## Verification required

Exact replay and concurrent admission; zero allowance before transport; immutable
identity/outcome and tenant isolation; malformed/missing usage, mismatched models,
5xx/timeouts and output overruns; redrive/abandon/alternate-lane non-bypass; terminal
cost evidence; retained-result recovery across actual process death without another
model call; source/reference changes; browser accounting and runtime restart.
Full regression, traceability and source/evidence hashes are required before this
decision is called locally qualified. Real provider/native Canva admission remains
a separate gate.

## Local qualification — 2026-09-27

Corrected candidate `6c1f8b5`: 4,104 tests passed, zero failed, 59 skipped; 498
strict test roots and source/scripts compile. Lint, Desk build and security checks
pass. Fresh matching Core/worker/Desk images pass 63 synthetic workflow invariants.
Twenty-nine Chrome/runtime checks prove named terminal accounting, an unchanged
original receipt, actual Core restart, saved-layout reconstruction and one Canva
import operation with zero additional model requests. Three actual SIGKILL
boundaries and a pre-056 database upgrade are covered by the full suite.

The first full candidate had ten Studio failures: transfer artifacts share the
plan table but already have Studio paid-call accounting. The explicit validated
Studio origin and historical backfill fixed the misclassification. Initial
failures and corrected results are retained in
`plans/research-grade-upgrade-2026-09-25/R21_CANVA_PLANNER_CALLS_PROOF.json`.
This qualification uses synthetic providers; 43 app scenarios were unselected
and two unmatched fake Gemini paths remain. No real provider call or production
change occurred. Live/human/full-app admission remains open.
