# Service-boundary repair — 30 September 2026

Implements ADR183 for NFR-006/FR-060/FR-063/FR-071.

1. Keep the nginx proof inode; validate both live binds and configuration, check reload failures.
2. Separate the design credential and retire matching operator aliases; retain scoped drain identity.
3. Restrict worker database/table/column/function and poll-row authority; read-only file mount.
4. Remove inactive clean pre-foundation release worktrees, guard incompatible activation.
5. Qualify sealed source on newest dump/full release gate, deploy coordinated Core/worker colors, verify live identities and denials.

Local focused checks pass (see LOCAL_PROOF.json). Steps1–4 source implementation complete; step5 pending. Live nginx was repaired by restart and verified; token/database changes are not yet live. Old predecessor is not a qualified rollback after migration; use a compatible forward release. Broader design W3/W5/W6/native/human gates remain separate and open.


## Reconciled live checkpoint — 1 October2026

Seal a482cf20 passes exact-release full gate:6194pass/0fail/3expected-fail/67skip,647 typed
roots,1476 blueprint checks and newest-dump migration. Migration073/current+previous scoped
identity/operator-alias retirement are live. Blue uses the restricted independent login and
read-only file store; green drained/deleted; office/API healthy; live denials and image/migration
receipt pass. See LIVE_A482CF20_READBACK.json. Eighteen historic legacy-dead outbox rows are
observed; no uncertain deliveries were replayed or cleared. Vector's stale retired mount caused
an apply refusal, manually recovered and handoff reconciled. New forward helpers validate actual
bind paths and recreate stale sources; retirement moves after successful bind/handoff/receipt.
31 connected helper tests pass; final reseal/full gate/deployment for that correction pending.
Compatible predecessor rollback and content-aware/native/human design gates remain open.
