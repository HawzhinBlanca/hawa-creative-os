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

## Addendum 2 (2026-09-30, the first --apply)

The first `--apply` stopped before any service changed except Postgres: deploy.sh's pre-backup `up -d postgres`
recreated Postgres with its new definition (syncfs, the init files bound through `~/.hawa/current`) before
`current` existed, so Docker created the missing bind sources as empty directories, and the switch then refused
to rename over that directory. Data was unaffected (the init files are read only for an empty data directory;
same volume, clean shutdown). Fixes: the pre-backup start is `up -d --no-recreate postgres` (the definition is
applied by the full `up -d` after the switch), and `hawa_release_activate` removes a `current` that is a tree of
empty directories and refuses one holding any file. Tests: `packages/testkit/test/release-directories.test.ts`
(the placeholder case fails without the fix; a guard that no pre-switch `up -d … postgres` lacks `--no-recreate`).

## Addendum 3 (2026-09-30, 20:58Z: a pruned release under a running container)

**What happened.** Vector's restart failed with a missing `/host_mnt/Users/hawzhin/.hawa/releases/1737c8f2…/infra/docker/vector.yaml`.
Compose bound nginx.conf, vector.yaml, the Postgres init files and the office proof through
`${HOME}/.hawa/current/...`, on the reasoning above that an unchanged bind string means no recreation. That
reasoning was the fault: Docker Desktop resolves the link when it *creates* the container and keeps the release
path it found, while `docker inspect` still shows the unresolved string. Because the string never changed,
nothing recreated vector (created 09:49:56Z, a second after 1737c8f2 was activated), nginx (pinned to
b2edf657) or Postgres (created before `current` existed, bound to Addendum 2's placeholder directories, since
deleted), and `hawa_release_prune`, which assumed no container bound into a release, removed 1737c8f2 at the end
of the 20:58Z deploy. Vector could not restart, and Postgres would not have started after any restart. The lead
restored the release by hand. Separately, `nginx -t` inside nginx failed: `prepare_service_boundaries.py`
replaces `.office-proxy-header.conf` by a rename, and a single-file bind mount keeps the inode it bound.

**Decisions.**
- *A stable runtime directory.* `${HAWA_RUNTIME_DIR:-$HOME/.hawa/runtime}` is a real directory (a link is refused:
  Docker would pin its target), never switched and never pruned. `hawa_runtime_sync` copies every file compose
  binds into it at the same relative path (`HAWA_RUNTIME_FILES` from the release, the office proof from
  `~/.hawa/shared`), writing in place (`cat src > dst`: the same inode, so a running container's single-file
  mount sees the new bytes; never a rename). Mode follows the source (the proof stays 0600). A missing source,
  the proof included, fails the deploy naming it. Codex's writer is unchanged; the proof is copied after it runs.
  `release.sh runtime-sync [commit]` does the same by hand. Compose binds these eight files, for nginx, vector
  and Postgres, from the runtime directory only; nothing is bound through `current`, `previous` or `releases`.
  The launch agents and the watchdog still run scripts through `~/.hawa/current`: scripts are not bind-mounted.
- *Deploy order.* This release's files and the proof are staged into a fresh `~/.hawa/runtime.candidate`, checked
  by one-off containers of the same images with compose's own mounts pointed at it (`nginx -t` with the proof it
  includes; `vector validate`), and only those checked bytes are copied into the runtime directory, after the
  checks and before the switch and `up -d`. Before the pre-backup Postgres start, runtime files that do not exist
  yet are seeded (only those), so no container is ever created against a missing source (Addendum 2's trap).
  After `up -d`, nginx must see the runtime nginx.conf and proof and pass `nginx -t` inside before it is reloaded;
  a failed check or reload restarts it, a restart that does not help recreates it, and the deploy stops if it
  still does not see them. Vector is restarted when vector.yaml changed (in place, it already sees the bytes but
  has not read them) or when it does not see the deployed file, recreated if a restart does not help.
- *Prune safety.* `hawa_release_prune` asks Docker for every container, running or stopped
  (`infra/ops/release_mounts.py` over `docker inspect`), and keeps any release one may still bind: sources under
  `~/.hawa/releases/<commit>` (with or without Docker Desktop's `/host_mnt` prefix), and sources through `current`
  or `previous` resolved against `.history` at the container's Created time and its last start, keeping the
  releases on both sides of an activation within three seconds (the history line is written just after the
  switch, and the VM clock may differ). A container created before any activation bound placeholders, not a
  release. When Docker cannot be asked, the history is missing or a time cannot be read, no release is removed.

**Consequences.** The first deploy with this change recreates nginx, vector and Postgres once, because their bind
strings change (Postgres: 10 to 30 s of 503s from Core, retried; nginx: a few seconds of refused connections;
the worker is blue/green as always). Later deploys recreate none of them for a file: the strings stay the same
and the content is rewritten in place. A rollback to a release before this addendum binds through `current`
again (recreating the three) and prunes without the check: run it with `HAWA_RELEASES_KEEP=50`.

**Verification.** `packages/testkit/test/release-directories.test.ts`: runtime sync (paths, proof from shared at
0600, the same inode after a changed sync, missing proof refused, link refused, placeholders, `missing` mode,
`release.sh runtime-sync`); prune with faked `docker inspect` (the 2026-09-30 replay keeps 1737c8f2 and
b2edf657, which the old prune removed; direct and `/host_mnt` binds; the activation window and last start;
nothing removed when unsure); compose's resolved binds (all eight under the runtime directory, none through
`current`, `previous` or `releases`, and exactly the files the sync copies); deploy order; and in the real
`nginx:1.27-alpine-slim` image, `nginx -t` with compose's own nginx mounts from a synced runtime directory, and
a running container that sees a synced proof at once but not one replaced by a rename.
`deploy-sh-operations-findings.test.ts`: nginx reload, restart, recreate and refusal; vector restart on an
in-place change and recreate for a pinned mount. The new tests fail on b7f32cbb and pass with the change. Read
against production's containers (`docker inspect`, read-only, 21:05Z), the check keeps 1737c8f2, b2edf657,
36369a12 and b7f32cbb.

**Merged with ADR-183 (a482cf20, 2026-09-30).** ADR-183's `hawa_release_prune_unsafe`, which retires releases
older than its security floor in step 6, removed 1737c8f2 a second time under the running vector and Postgres. It
now uses the same mount check: a bound release is kept (and removed by a later deploy once its container is
recreated), and when the check cannot be sure none is removed. ADR-183's live-mount admission
(`infra/ops/nginx_reload.sh`) compares nginx with the runtime copies it binds, and recreates nginx when a restart
keeps a stale mount. Its worker identity preparation, which may rewrite the office proof, runs before the live
copy; if the proof changed, the candidate is staged and `nginx -t` checked again.
