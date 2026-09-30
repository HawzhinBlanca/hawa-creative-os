# ADR-158 — Production release directories and operations repairs

Date: 2026-09-30
Status: implemented and tested on branch `claude/fix-ops`; not deployed. Host steps are in
runbooks/PRODUCTION_RELEASE_DIRECTORIES.md, for the lead to run at deploy time.
Requirements: FR-064, FR-070, FR-071, NFR-002, NFR-003, NFR-006, NFR-013, NFR-023.
Sources: audit of 2026-09-30 (items #1, #2, #3, the operations P2 items C1/C4 and the P3 log
items); production container logs of 2026-09-28 to 2026-09-30; infra/ops/README.md; ADR-034,
ADR-135, ADR-141.

## What happened

Postgres crashed twice in 48 hours (2026-09-29 09:11, eight minutes; 2026-09-30 07:26, eleven
minutes). Both times Restate logged "Severe lag … in failure detector internal timer" for five to
ten minutes first, a server process died, and crash recovery spent over a minute syncing the data
directory file by file while every client was refused. The Docker VM (20.2 GiB, 8 CPUs) had swapped
14.5 of 15 GB: the test Postgres, the chaos stack and builds share it with production. The watchdog
had one 30-minute cooldown for all problems; an alert at 07:17 held back the outage until 07:47.
Production itself ran from /Users/hawzhin/Hawdesign, the checkout other tools work in, which was on
another tool's branch: the launch agents, the nginx and Vector bind mounts and the watchdog's restart
all read it, and the watchdog stamped a restart with that branch's HEAD.

## Decisions and reasons

**Release directories.** `deploy.sh` makes `~/.hawa/releases/<commit>` with `git worktree add
--detach`, links the host-local files from `~/.hawa/shared` (the two env files, the snapshot and
receipt folders, and what the release gate's suite needs), runs `pnpm install --offline
--frozen-lockfile && pnpm build && pnpm --filter @hawa/desk build` once, and re-executes the release's
own `deploy.sh`, so pre-flight, gates, build and apply all read one immutable tree. `--apply` points
`~/.hawa/current` at the release with one rename (`os.replace`; `ln -sfn` unlinks first and `mv` onto
a link to a directory moves into it) after images are verified, migrations applied and the new
nginx.conf and vector.yaml checked, just before `compose up -d`; `~/.hawa/previous` names the release
before. Compose binds repository files through `${HAWA_RELEASE_ROOT:-${HOME}/.hawa/current}`, so the
bind string is the same for every deploy and no container is recreated because a path changed;
deploy's one-off `nginx -t` and `vector validate` set `HAWA_RELEASE_ROOT` to the new release. The
launch agents and systemd units run `~/.hawa/current/infra/...`; scripts pin their release with
`pwd -P`. Current, previous and the newest five releases are kept. A worktree was chosen over
`git archive` because `deploy.sh`, the release gate and the watchdog's build stamp all read git; the
worktree is detached and nothing checks a branch out in it. `.gitignore` now matches the snapshot
and receipt links as well as folders. The local state audit and the app role rotation follow the
links (the rotation would have replaced the env-file link with a file of the release's own).

**Postgres and the VM.** `recovery_init_sync_method=syncfs` and `mem_reservation: 1g` (cgroup
memory.low) for production Postgres. The test Postgres gets 2 GB without extra swap and 3 CPUs; every
chaos service a memory ceiling without swap and a CPU share, so a heavy run is killed inside its own
container instead of swapping the VM. Docker Desktop's own settings are the owner's: the runbook
recommends 24 GB, 2 GB swap and 10 CPUs, and moving tests and chaos off the production host.

**Watchdog.** A red alert goes out when the problem set differs from the last one sent (numbers
aside, so "3 parked messages" and "4" are the same problem), or when the same set has lasted another
30 minutes. Each pass reads the Postgres and Restate log lines since the previous pass and reports
crash recovery and severe lag. Every line it writes starts with its UTC time. The disk is judged by
free space (clean up below 40 GiB, alert below 25 GiB, hourly below 10 GiB): 90% of this disk still
left 96 GiB. It works on the release `current` names and accepts Core's "disabled".

**Health.** With the paid probe unscheduled the model provider is "disabled", with `everyMinutes:
null`, and not degraded; Canva's "unverified" is not degraded because no Canva probe exists (an
expired connection is still "reconnect_required"); `lastVerifiedProgressAt` is null until a paid probe
was sent; `flags.DESIGN_PIPELINE_V3_CHATS` counts the pilot chats, never naming them. Production had
been "degraded" permanently for the first two alone.

**Backups and disk.** The weekly schema drill records `static_schema_parity`, `restore_performed:
false`, no target time or RPO, and counts read from the files; it recorded a "passed" clean-host
recovery with written-in counts. `disk_cleanup.sh` logs every removal and failure. Its build-cache
cap never held because, with the containerd image store, most of "Build Cache" is layers shared with
images, which `--max-used-space` does not count; while over the cap it now removes Hawa's own images
that no container uses, that production's compose files do not name and that are older than 7 days,
then prunes again, and says what remains.

**nginx.** Refusals are 429. Rate zones key on the session cookie, else the Authorization header,
else the address, with a per-address ceiling; Core's health is never limited; sign-in allows 30 a
minute per caller.

**Logs.** A failed publication-inspection pass logs its cause without URLs or token-like strings;
pool errors are one line (the idle-client error carried the whole pg Client); HAWA_LIFECYCLE_CHATS is
logged at info level as ignored.

## Consequences

The switch-over deploy restarts Postgres once (new command, reservation and bind paths) and nginx and
Vector once (bind paths); later deploys do not. A release costs a worktree, its `node_modules` (hard
links from the pnpm store) and its build. Rollback is deploying `~/.hawa/previous`; a pre-ADR-158
commit is rolled back to through a worktree of its own (runbook). The watchdog may alert more often
while problems change; that is intended. Disk alerts stop until less than 25 GiB is free.

## Verification

New tests: packages/testkit/test/release-directories.test.ts (15), watchdog-alerts.test.ts (6),
production-vm-resources.test.ts (3), disk-cleanup-logging.test.ts (4), nginx-rate-limits.test.ts (5,
served by nginx:1.27-alpine-slim), backup-restore-drill-honesty.test.ts (2);
apps/core/test/health-semantics.test.ts (2), retired-telegram-settings.test.ts (2);
packages/db/test/pool-error-logging.test.ts (2); new or changed cases in
publication-inspection-schedule, app-role-rotation, watchdog-host-role (free-space disk alert),
core and paid-model-health ("disabled"). Each new test failed against 6bd479c1's files and passes now.
Nothing was run against production or its VM settings; the switch-over itself is unexercised until
the lead runs the runbook.

## Addendum (2026-09-30, found at the first pre-flight)

The release gate's stage 7 refused the first release directory: it required a branch with an upstream, and a
release directory is a detached worktree, which tracks nothing. The check exists so that only a published
commit is certified, so `scripts/enforce_release_gate.sh` now also accepts a detached HEAD that some remote
branch contains, and still refuses a detached commit that is on no remote branch (checked both ways by hand
against `~/.hawa/releases/973f725d…` and an unpushed empty commit on top of it).
