# ADR-113 — Current-native revision admission and reviewed-copy handoff

Date: 2026-09-28. Status: accepted for implementation; live native qualification remains open.

## Evidence and requirements

FR-013/014/029/032/041/042/060/079, NFR-009/024; docs/05, docs/08,
docs/09, docs/10, docs/11, docs/17, docs/18 and docs/30. Studio's parentWinner
loads a generated layout rather than the working Canva master. A local edit and
new PPTX import therefore cannot establish preservation of later manual edits.
The native adapter has no qualified semantic patch operation. Documentation of
Canva autofill does not qualify arbitrary current-design edits on this account.

## Decision

Requests linked to an earlier design cannot enter automatic generation from its
local recipe. Enforce admission at start, resume and fresh import dispatch,
including the older planner route and non-V3 requests. Existing uncertain remote
jobs remain reconcilable; terminal results remain historical evidence.

Use the existing Canva handoff and checked-export path to complete these requests.
Desk shows the scoped parent design and revision directive. An operator duplicates
the current native design, edits the separate copy, links it to the revision task,
and explicitly confirms exact final copy and preservation review. This confirmation
is an immutable task event with actor, expected task/binding/parent basis, request
key and content hash. It is an assertion by a human, not an automated native proof
or an approval. The original request remains unchanged.

Checked exports bind to the current confirmation and active human-authored Client
DNA fonts. New confirmations invalidate earlier export policy for review, approval
and publication. Capture creates a revision from retained real PNG/PPTX evidence,
using the same existing manual review gates. A native copy/source map never becomes
a claimed lossless backup. Later live operation qualification may replace a manual
step without bypassing requested-change and preservation checks.

Both PNG and PPTX carry the same latest confirmation identity. A matching native
timestamp alone cannot pair a previous confirmation's preview with a new source.
The database policy check holds parent/task and binding row locks through its
transaction; these local locks do not fence direct native Canva edits.

RequestLifecycle ownership remains enforced. This slice does not grant a legacy
manual write to lifecycle-owned tasks or change their executor; unsupported cases
remain explicit. No paid work, source reconstruction or fresh Canva create is a
fallback from the handoff. Original submitted jobs can still be reconciled.

## Acceptance

Prove public start/resume/planner/import admission before paid calls or new effects;
nonrevision creation remains available. Prove scoped parent/binding resolution,
explicit human confirmation, keyed replay, stale/concurrent/cross-client refusals,
new-policy invalidation, and reviewed copy flowing through actual export transport
and stored review. Include Desk handoff behavior and runtime-role PostgreSQL checks.
Synthetic transport does not prove actual Canva preservation, native language
quality, account capability or human approval. Keep those release gates open.
