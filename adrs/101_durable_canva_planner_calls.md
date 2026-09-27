# ADR-101: Durable Canva planner calls and retained layout recovery

Date: 2026-09-27
Status: implemented; full regression and deployed qualification pending
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

Old plans without paid-call records remain visibly incomplete accounting evidence.
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
