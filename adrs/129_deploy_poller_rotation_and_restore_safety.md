# ADR-129 — Deploy ordering, poller health, token rotation and restore by swap

Date: 2026-09-28 (review fixes the same day). Status: implementation; production use remains open.
Requirements: NFR-001/002/003/006/013/017, FR-060. Normative sources: MASTER_SPEC.md,
docs/10_WORKFLOW_RELIABILITY.md, docs/25_OPERATIONS_RUNBOOK.md, runbooks/10_backup_restore.md,
infra/docker/README.md. Phase 4 adversarial review, operations findings 1, 2, 3, 4, 6 and 26.

## Decision

**Poller switch (finding 1).** `deploy.sh` recreated Core with a changed `HAWA_TELEGRAM_POLLER`
at step 7, before the worker colour that takes over was built, started and registered. A failure in
between left nobody polling, and the failure message said nothing had changed. Core now keeps the
value it runs with (or `core`, when no Core container exists) until `register` succeeds. It is then
recreated once with the new value. The idle colour's image is built and verified before step 7
whenever 4b could name the colour. A deploy that stops after step 7 prints the poller Core runs with.

**Rollback split (finding 2).** Restate never un-routes a service. A build that lacks a routed
service moves only what it hosts, and every later deploy then stops at `finish-drains`. `register`
now reads the new colour's own `/ready` service list (`--hosts`) and refuses such a build before
sending anything. A build without a list (every build before Phase 2.1) counts as hosting TaskWorkflow
and TaskService only. An unreadable route list also refuses. A worker rollback below a build that
added a service is documented as unsupported, and the earlier README advice, which could not work, is
removed. An older commit's `deploy.sh` lacks the check; the runbook says to compare service lists first.

**Poller health (finding 3).** Production Core probes getMe whichever process polls, and `/v1/health`
names the intended poller. The worker's `/health` degrades the polling colour when its poller did not
start, Telegram refuses the token (401/404), or no cycle has worked for five minutes. A readable kill
switch counts as a working cycle. The watchdog alerts when Core names the worker and no running
colour reports its poller on and live, always or taking over.

**Worker token rotation (finding 4).** Core accepted one worker token, and a draining colour keeps
the value it was created with. `HAWA_WORKER_TOKEN_PREVIOUS` is accepted beside the current token on
`/v1/internal/*`, the delivery routes and design proofs. It has the same length and distinctness rules.
While it is set, Core signs office decisions, native reviews and delivery claims with it. The draining
colour, which Restate still routes new work to until the new colour is registered, verifies it. Worker
verifiers accept either value; workers still present the current one. Rotation takes two deploys.
`deploy.sh` refuses, after 4b and before any backup or change, a running Core or worker token that is
neither value. It also says when the previous value is no longer used by a running worker. Values are
compared in memory and never printed.

**Log shipper configuration (finding 6).** `vector.yaml` is handled like `nginx.conf`. It is validated
with `vector validate --no-environment` in a one-off container before step 7 starts anything. Vector
is restarted when the running container's file hash differs, and must then see the deployed file.

**Restore (finding 26).** Restoring with `--clean` over the live database fails once a newer
migration depends on the dump's objects. By then pg_restore has already dropped the dump's policies
and most foreign keys. A dump is now restored into a new database in one transaction. Its policies,
foreign keys and triggers are checked against the dump's own table of contents. It is then swapped in
by two renames in one transaction, and the replaced database is kept until the operator drops it.
Launch agents and application containers are stopped first, because the watchdog restarts a stopped
Core. `infra/backup/drill_restore_swap.sh` runs the runbook's block, read from the file, against the
test server.

No migration is needed.

## Acceptance

Bash functions taken from `deploy.sh` and `watchdog.sh` with Docker, Compose and Restate stubbed:
hold/release, exit report, build order, hosts, token rotation cases, vector validate/restart. The
Restate fake refuses the rollback before POST. Core app requests accept the previous token and report
revoked getMe. Worker delivery claims and gateway events verify with either value, and poller health
is judged by the stated rules. On a copy of a production pre-deploy dump with this branch's migrations
applied, the old command must fail and the runbook block must restore the pre-deploy schema, policies
and application-role visibility. All of this is local. Production deploy, rotation and restore are
separate gates that need the owner.

## Local qualification — 2026-09-28

The initial red run had 44 tests: 42 failed, 2 passed, and one worker file did not load. Missing
functions made up most failures; four were behavioural. The Restate fake registered the rollback
build, Core returned 401 to the previous token, production options skipped getMe, and health had no
poller owner. After the fix, 49 new and directly affected files ran 447 tests: 444 passed, 1 failed,
and 2 opt-in process-kill drills were skipped. The failure is the stale LAST constant in
`startup-schema-check.test.ts`. The full suite (539 files, 4563 tests) had 8 failures in 7 files. The
same 8 tests fail on the unchanged base source at 7b8de71e, so none comes from this change. Details
are in `plans/lean-design-implementation-2026-09-28/OPERATIONS_FIXES_PROOF.json`.

The restore drill used `predeploy_20260924T204736Z.dump` from production on the test server
(127.0.0.1:55432), with counts only. Migrations 022-064 took the copy from 116/194/28 to 160/258/70
(policies/FKs/triggers). The old runbook command exited 1 and left 44 policies, and the application
role then saw 0 tasks. The docs/25 variant exited 1 with 84 errors and a mixed schema. The runbook
block restored 116/194/28 and schema_upgrades 021, and the application role saw the same 1612 tasks
as before the migrations with its tenant context, and 0 without it. Every scratch database was dropped.

Not executed: `deploy.sh --apply`, a live poller switch, rotation or restore on production, Compose's
own `run`/`restart` of vector, a real Restate registration with `--hosts`, and the plain-SQL restore
path. The watchdog's live alert path was not exercised.

## Review fixes — 2026-09-28

A separate review of the first version (commit 72cb6fae) found one blocking defect and three smaller
ones. Each has a failing test or drill first.

**Poller hold in the wrong direction (blocking).** Core was held at the value it ran with in both
directions. On a switch back to Core (worker -> core), Core stayed at `worker` while the new colour was
created with `core`. When `register` exited 4 (Restate registered the new colour but could not confirm
that every service moved), the new colour was kept, `release_core_poller` never ran, and Restate could
route ChatInbox to the new colour. Then nobody polled: not Core, not the new colour, and not the old
colour, whose gate follows ChatInbox. The exit note said the live worker colour polled. Now only a move
to the worker is held. A move back to Core takes effect at step 7, as before ADR-129: Core polls at
once, and the old colour may poll beside it until Restate moves ChatInbox. Two pollers cost a 409 from
Telegram and a duplicate that intake drops; nobody polling costs time. `abandon_idle` also releases
Core when it keeps a colour that will not poll. The exit note now states Core's own value and the rule
for worker colours (the colour Restate routes ChatInbox to polls when it was created with `worker`),
because the script does not know where Restate routes ChatInbox.

**`--hosts unknown`.** `unknown` passed the service-name pattern and became a service named
`unknown`, so the pre-Phase-2.1 fallback never applied through the CLI. `unknown`, and a list with
any unusable name, now mean "no list". The refusal says the list may also have been unreadable.

**Hosts check after step 7.** The check ran in 7b, after step 7 had replaced Core and the Desk with the
refused build. `deploy.sh` now reads `WORKER_SERVICE_NAMES` from the built worker image
(`apps/worker/dist/services.js`, in a container without network) right after the image is verified.
`restate-bluegreen.ts check-hosts` refuses the build before anything is started. `register` still
checks again with `/ready`. When 4b could not name the idle colour (the stack was down), only the 7b
check applies.

**Database grants and settings on restore.** `pg_dump -Fc` without `--create` carries neither the
database's grants nor its settings (`ALTER DATABASE ... SET`, `ALTER ROLE ... IN DATABASE ... SET`).
A rename leaves them with the old database. The restore-swap block now copies the owner, grants and
scalar settings from the live database to the restored one (`infra/backup/restore_copy_props.sql`). A
setting whose value is a list is refused, as `rotate-app-role.ts` refuses it. The block then compares
owner, encoding, locale, grants and settings (`infra/backup/restore_props.sql`), and swaps only when
they are equal. Production's catalogs were not read (no SQL against production); the block checks them
at restore time instead.

**getMe in worker mode.** The review also noted that with `worker` set, Core's getMe probe can fail
step 8 after the switch. This is intended (finding 3). The README and the exit note now say that the
switch stands and the new colour is registered.

Local qualification: the red run of the new tests had 36 tests, with 13 failed and 23 passed; the
restore-swap block test had 4 tests, with 2 failed. The restore drill with the earlier block and the
same production pre-deploy dump swapped in a database without the grants and settings: `hawa_app`
could connect, and the login role lost `statement_timeout` and `work_mem`. With the new block both were
kept and the login role saw 1612 tasks. Details, and the results of the full suite, are in
`plans/lean-design-implementation-2026-09-28/OPERATIONS_REVIEW_FIXES_PROOF.json`.
