# ADR183 — Independent worker credentials, database grants and nginx admission

Date: 2026-09-30. Status: accepted for implementation; live qualification pending.
Requirements: NFR-006, FR-060, FR-063, FR-071, FR-074, NFR-012.
Sources: MASTER_SPEC, docs/10_WORKFLOW_RELIABILITY.md, docs/14_SECURITY_THREAT_MODEL.md;
owner's Claude verification handoff, 2026-09-30. Amends ADR163's initial migration.

Single-file Docker mounts retain an inode. Write the office proxy include through its
existing inode under the configuration lock, flush/fsync, and validate both mounted
files plus live nginx -t before an explicit checked reload. Restart when a stale mount
is observed. Every failing validation/restart/reload stops deploy; it is never swallowed.

Give the design worker a generated independent current credential. Rotate retired
ordinary operator aliases together when they match its previous value; otherwise a
draining worker could become an operator on rollback. Core accepts the previous design
credential only under the existing exact worker route scope, including denying session
exchange. Keep it out of the new worker environment. Unsafe pre-74618004 releases are
ineligible and removed only after confirming they are inactive and unmodified. Git
history and shared configuration/backups remain. Rotation coordinates Core and worker
colors and requires live negative controls; no login UI is added.

Create a separate worker database group/login with no membership in hawa_app, no role
creation, schema creation, ownership or RLS bypass. Explicit grants cover actual outbox,
poll cursor, send-mark, fallback outcome and delivery-source reads. Approval, publication,
provider/identity configuration and general task mutation stay unavailable. RLS still
applies, but table/function grants independently limit authority even under a forged
application context. Remove PUBLIC execution on application-schema functions while
preserving Core's existing inherited PUBLIC permissions explicitly; grant only the
required RLS helpers to the worker. Future functions default to no PUBLIC execution.
Provision a separate generated database credential through owner-local configuration,
verify its effective privileges and use it in both worker colors. Never log credentials.

Acceptance: retained open proof fd/inode sees repeated updates; executable nginx failure
controls; stable independent credentials and legacy-alias retirement; previous/current
worker route/session denials; PostgreSQL positive worker operations and negative
approval/config/function/role/schema controls, tenant isolation, native outbox recovery;
exact release migration/backup/deploy/readback. A source test is not live qualification.


Exact release execution: the 8b517972 full gate found the gate's pnpm commands still ran
from the launching source checkout after deploy re-exec. Enter the gate's own ROOT_DIR
before any command; an executable fixture launched elsewhere must show its stage1 pnpm
runs in the release. Preserve the original failed full run (6190 pass/3fail/3expected-fail/
67skip), fix the actual boundary and stale migration/mount expectations, and repeat the
mandatory full gate on a newly sealed source. Do not weaken the Desk bundle budget.


Live mount follow-up, 1 October2026: the qualified a482cf20 rollout applied migration073,
independent credentials and Core, then refused when Vector's restart reused a retired1737c8f2
bind path. A digest does not prove the bind path is durable. Recreate stale-source nginx/Vector
containers even when their bytes match; preserve checked restart for a stale nginx inode on a
current source. Check both sources and hashes after recovery. Retire unsafe releases only after
bind qualification, worker handoff/drain and a verified receipt. Live recovery recreated Vector
against current, reconciled the same sealed worker image through Restate, drained/removed green,
corrected a missing manual build stamp using the immutable image, and recorded the receipt.
Current/previous design session/operator denials and separate restricted DB login pass live;
these manual actions do not qualify the unshipped forward deployment-helper change.

Integrated correction, 1 October 2026: ADR158 addendum3 replaces current-link binds with a
permanent real runtime directory, in-place validated copies, and fail-closed Docker/history-aware
pruning. This supersedes the temporary 95d4954d source-path helper; both branch histories are kept.
Live4e500451 verifies all three identity/bind repairs, eight stable mounts and retirement of the
requested unsafe release directories. Exact proof: plans/service-boundary-repair-2026-09-30/
LIVE_4E500451_READBACK.json. Do not redeploy the obsolete helper over the newer live runtime.
