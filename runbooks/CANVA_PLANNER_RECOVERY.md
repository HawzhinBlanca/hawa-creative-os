# Canva planner recovery and spending

Authority: ADR-101; FR-060/064/065/079. Qualification is recorded separately in the
research-grade plan. These controls do not prove live Canva or visual quality.

## What is saved

Each new plan has one immutable paid-call identity: its plan UUID. Before any
model request, PostgreSQL reserves the exact bounded request against the shared
office, client and creative_director allowance. Receipt identifiers, complete
native usage, conservative usage cost, original acceptance and uncertainty are
separate from the reservation and any later administrator evidence.

A validated layout is saved before editable file encoding. Exact copy, logo and
reference hashes remain frozen. Resume never calls a model. It rechecks current
task/client ownership and reference authority before making an editable source.
Local storage errors leave the saved layout recoverable; input validation errors
leave the original paid-call evidence intact. Concurrent recovery keeps one source.

## Operator actions

1. Open the task's Canva design panel. Inspect the saved plan and any retained
   layout or cost-evidence notice. Resume a saved design to recover available work.
2. If cost evidence is missing, open Operations → Call cost accounting and select
   the canva_planner call with this plan UUID. A named office administrator records
   terminal provider evidence, its hash, known final cost and a reason against the
   current evidence snapshot. A timeout by itself is not terminal provider evidence.
3. If a typed layout survived, resume that original plan after accounting. The
   original usage remains unknown where it was missing; the attestation is separate.
4. If no usable layout survived, retire the plan with a reason. Request a new design
   explicitly only after the charge is reconciled. This spends under current limits.
   Retirement alone never clears the financial obligation or bypasses the Studio hold.

Reusing a failed/abandoned key returns that original plan. A `redrive_` prefix has
no special authority. Changing a key, restarting Core, or midnight cannot erase
an unresolved obligation. An unconfigured or unquotable model sends no request.

## Historical plans

Plans created before ADR-101 have no invented paid-call records. Missing accounting
appears as history_incomplete and blocks further shared spending until named
terminal evidence is recorded. Historical model replies cannot be reconstructed
from costs or health observations. Existing editable sources remain readable.

## Failure drills

The isolated tests kill an actual process after send, after receipt before save,
and after the committed typed reply before materialization. Check one synthetic
provider request, durable reservation/outcome, unchanged exact replay, alternate
lane refusal, and successful local reconstruction only for the saved-reply case.
Do not point these drills at production or use real paid credentials.
