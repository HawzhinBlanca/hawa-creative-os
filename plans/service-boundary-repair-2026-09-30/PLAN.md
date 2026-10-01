# Service-boundary repair — 30 September 2026

Implements ADR183 for NFR-006/FR-060/FR-063/FR-071.

1. Keep the nginx proof inode; validate both live binds and configuration, check reload failures.
2. Separate the design credential and retire matching operator aliases; retain scoped drain identity.
3. Restrict worker database/table/column/function and poll-row authority; read-only file mount.
4. Remove inactive clean pre-foundation release worktrees, guard incompatible activation.
5. Qualify sealed source on newest dump/full release gate, deploy coordinated Core/worker colors, verify live identities and denials.

Initial checkpoint: local focused checks passed (see LOCAL_PROOF.json); step5 was then pending. Superseded by the live verification below. Old predecessor is not a qualified rollback after migration; use a compatible forward release. Broader design W3/W5/W6/native/human gates remain separate and open.


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

## Integrated stable-runtime verification — 1 October 2026

Claude deployed 4e500451 concurrently with the final 95d4954d gate. The older deployment was
stopped during image build, before release activation; its full suite had passed 6199 / 0 failed /
3 expected failures / 67 skipped. Preserve that result, but do not deploy its superseded helpers.
Both histories are merged. ADR158 addendum3 supersedes the temporary current-link bind approach:
use a permanent real runtime directory, in-place checked file copies, and Docker/history-aware
pruning for both ordinary and security-floor retirement. Runtime and test sources in this merge
are byte-for-byte those of the already deployed 4e500451; no additional rollout is needed.

Independent live readback passes: nginx -t, eight stable read-only static binds, no production
release-bound mount, exact checked runtime bytes/proof, receipt image/revision agreement,
independent current/scoped previous credentials and operator/session/internal denials,
restricted hawa_worker_login with no hawa_app membership/approval/task/schema/temp authority,
read-only worker blobs, office access200 and healthy Core. Requested old release directories
051d5606/1737c8f2/353c9e0c and 6af16cb8 are absent. Green is the live worker; no source/current
pointer was reverted. See LIVE_4E500451_READBACK.json. Merged executable mount/prune/nginx tests:
62 passed / 0 failed across3 files. Live release gate declares6210 passed / 0 failed; this readback
does not claim to repeat that full gate. The earlier18 historic dead outbox rows are retained.

The three known natural-language defects remain: title inferred from a date line; two-design
requests opening only one design; and hold requests recorded as notes while drafting continues.
Broader content-aware W3/W5/W6, exact photo-count semantics and native/human qualification remain
open. This closes the three requested service-boundary repairs, not full product admission.
