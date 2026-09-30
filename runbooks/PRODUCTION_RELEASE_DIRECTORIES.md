# Production release directories and the 2026-09-30 operations repairs

ADR-158. Audit of 2026-09-30, items #1, #2, #3 and the operations P2/P3 items. This runbook holds
the host steps the lead runs at deploy time; the repository changes are on branch `claude/fix-ops`.
Nothing here was run against production when it was written.

## What changes

| Before | After |
|---|---|
| Production ran from `/Users/hawzhin/Hawdesign`, the checkout other tools work in | Each deploy runs from `~/.hawa/releases/<commit>`, a detached git worktree of that commit |
| Launch agents ran `/Users/hawzhin/Hawdesign/infra/...` | They run `~/.hawa/current/infra/...`; a deploy switches `current`, no reinstall needed |
| nginx, Vector and the Postgres init files were bound from the checkout (`./nginx.conf`) | They are bound through `~/.hawa/current/...`, the same path for every deploy |
| Credentials, backups and receipts sat in the checkout | They live once in `~/.hawa/shared/` at the same relative paths; every release links to them |
| The watchdog stamped a restart with the checkout's HEAD | It stamps it with the release `current` names |

Layout:

```
~/.hawa/current   -> ~/.hawa/releases/<commit being run>
~/.hawa/previous  -> ~/.hawa/releases/<commit before it>      (the rollback target)
~/.hawa/releases/<commit>/                                     git worktree add --detach, then pnpm install + build
~/.hawa/releases/.history                                      one line per activation: <UTC time> <commit>
~/.hawa/shared/infra/docker/.env.production                   container credentials (0600)
~/.hawa/shared/infra/docker/.env                              compose values (0600)
~/.hawa/shared/infra/backup/snapshots/                        pre-deploy and nightly dumps, backup.log
~/.hawa/shared/infra/backup/release-receipts/                 deployment receipts
~/.hawa/shared/.env.test, output/audits/2026-09-29-product-flow-fixes/   what the release gate's suite needs
```

`deploy.sh` makes the release, links the shared files, runs `pnpm install --offline --frozen-lockfile &&
pnpm build && pnpm --filter @hawa/desk build` once per release (log in `~/.hawa/releases/.build-<commit>.log`),
and continues from the release's own copy of itself. Pre-flight never touches `current`. `--apply` switches
`current` (one rename) after the images are built and verified, the migrations applied and the new
`nginx.conf` and `vector.yaml` validated, just before `compose up -d`. After a successful deploy it keeps
`current`, `previous` and the newest five releases (`HAWA_RELEASES_KEEP`) and removes the rest.

## Before the switch-over

1. The branch is merged and the release commit is chosen (`REL=<40-character commit>`).
2. A clean checkout of that commit that nobody else works in. Not `/Users/hawzhin/Hawdesign`:
   ```bash
   git -C /Users/hawzhin/Hawdesign fetch
   git -C /Users/hawzhin/Hawdesign worktree add --detach ~/hawa-deploy-src "$REL"
   SRC=~/hawa-deploy-src
   ```
3. Not between 03:25 and 04:30 (nightly backup and Restate cold copy) and not during a design in
   progress if avoidable: the switch-over deploy restarts Postgres once (below).
4. No chaos run and no full test suite running on this Mac (`docker ps --filter name=hawa-chaos`,
   `docker ps --filter name=hawa-test`).
5. At least 25 GiB free on the disk (`df -h ~`): the release is a second copy with its own
   `node_modules` (hard links from the pnpm store) and build output.

## One-time switch-over (exact steps)

```bash
UID_=$(id -u)
# 1. Pause the five launch agents. Their plists stay in place, so the settings added by hand
#    (archive destination, passphrase file, off-site target) are carried over in step 7.
for l in watchdog nightly-backup backup-restore-drill restore-drill offsite-copy; do
  launchctl bootout "gui/$UID_/design.hawa.$l" 2>/dev/null || true
done

# 2. Move the host-local files into ~/.hawa/shared. Credentials are copied (0600); the snapshot and
#    receipt folders are moved (same disk, a rename) and a link is left at the old place.
bash "$SRC/infra/ops/release.sh" adopt /Users/hawzhin/Hawdesign
ls -l ~/.hawa/shared/infra/docker/ ~/.hawa/shared/infra/backup/

# 3. HAWA_LIFECYCLE_CHATS does nothing since ADR-135 (Core now says so at info level): remove it.
#    Also remove any stale HAWA_TELEGRAM_POLLER line other than =worker. Edit the shared copy only.
grep -n '^HAWA_LIFECYCLE_CHATS=' ~/.hawa/shared/infra/docker/.env.production
sed -i '' '/^HAWA_LIFECYCLE_CHATS=/d' ~/.hawa/shared/infra/docker/.env.production

# 4. Limit the test Postgres now, without restarting it (the compose file has the same values).
docker update --memory 2g --memory-swap 2g --cpus 3 hawa-test-postgres

# 5. Pre-flight from the release directory (creates ~/.hawa/releases/$REL, installs, builds, runs the gates).
bash "$SRC/infra/docker/deploy.sh"

# 6. The deploy. It continues from ~/.hawa/releases/$REL and switches ~/.hawa/current before up -d.
bash "$SRC/infra/docker/deploy.sh" --apply

# 7. Reinstall the launch agents from the current release (they now run ~/.hawa/current/infra/...).
bash ~/.hawa/current/infra/ops/install_launch_agents.sh
```

What the switch-over deploy restarts, once: Postgres (its command gains
`recovery_init_sync_method=syncfs`, it gains `mem_reservation: 1g`, and its init-file bind paths
change; expect 10 to 30 s in which Core answers 503 and requests retry), nginx and Vector (their bind
paths change to `~/.hawa/current/...`; a few seconds of refused connections on port 8080). The worker
is deployed blue/green as always. Later deploys do not restart any of them for a path: the bind path is
the same string every time, and `deploy.sh` reloads or restarts nginx only when `nginx.conf` changed.

## Verify

```bash
bash ~/.hawa/current/infra/ops/release.sh status                 # current -> ~/.hawa/releases/$REL
docker inspect hawa-production-nginx-1 --format '{{range .Mounts}}{{.Source}} {{end}}'     # .../.hawa/current/infra/docker/nginx.conf
docker inspect hawa-production-vector-1 --format '{{range .Mounts}}{{.Source}} {{end}}'    # .../.hawa/current/infra/docker/vector.yaml
docker inspect hawa-production-postgres-1 --format '{{json .Config.Cmd}}'                  # contains recovery_init_sync_method=syncfs
docker inspect hawa-production-postgres-1 --format '{{.HostConfig.MemoryReservation}}'     # 1073741824
plutil -p ~/Library/LaunchAgents/design.hawa.watchdog.plist | grep -E 'hawa/current'      # program and working directory
launchctl print "gui/$(id -u)/design.hawa.watchdog" | grep -E 'state|program'
bash ~/.hawa/current/infra/ops/watchdog.sh --status             # every line starts with a UTC time; "healthy"
curl -s http://127.0.0.1:8080/v1/health | python3 -c 'import json,sys; h=json.load(sys.stdin); print(h["status"], h["flags"], h["lastPaidProbe"]["status"], h["lastPaidProbe"]["everyMinutes"], h["lastVerifiedProgressAt"])'
#   expected with HAWA_BILLING_PROBE_ENABLED unset: healthy {... 'DESIGN_PIPELINE_V3_CHATS': 2 ...} disabled None None
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/health; done | sort | uniq -c   # all 200
docker logs --since 10m hawa-production-core-1 2>&1 | grep -E 'HAWA_LIFECYCLE_CHATS|Client \{' || echo clean
tail -5 ~/.hawa/logs/design.hawa.watchdog.log                    # next pass, timestamped
```

After a day of clean watchdog passes, the lead may delete `/Users/hawzhin/Hawdesign/infra/docker/.env.production`
and `.env` (nothing reads them any more; `~/.hawa/shared` holds the live copies) and remove the source
worktree (`git -C /Users/hawzhin/Hawdesign worktree remove ~/hawa-deploy-src`).

## Every later deploy

From any clean checkout of the commit (a fresh `git worktree add --detach` is simplest):

```bash
bash <checkout>/infra/docker/deploy.sh            # pre-flight in ~/.hawa/releases/<commit>
bash <checkout>/infra/docker/deploy.sh --apply
```

Or run the release's own copy: `bash ~/.hawa/releases/<commit>/infra/docker/deploy.sh --apply`. Nothing
else changes: the worker goes blue/green, `current` switches just before `up -d`, the watchdog and the
launch agents follow `current` at their next run. `HAWA_RELEASE_DIRS=off` runs from the checkout as
before and must not be used on the production host after the switch-over.

## Rollback

**To the previous release** (any release made after the switch-over). Migrations are forward-only, as
before; this is the same "deploy the previous release" as ADR-135/136:

```bash
bash "$(readlink ~/.hawa/previous)/infra/docker/deploy.sh" --apply
```

It runs from that release directory (already installed and built), switches `current` back and deploys
the worker blue/green. `bash ~/.hawa/current/infra/ops/release.sh status` shows both links.

**To a commit from before ADR-158** (for example `6bd479c1`). Its `deploy.sh` knows nothing of release
directories, so it is run from a worktree of its own that links the shared files, and `current` is
pointed at it by hand so the watchdog agrees:

```bash
OLD=6bd479c1<rest of the commit>
git -C /Users/hawzhin/Hawdesign worktree add --detach ~/.hawa/releases/$OLD $OLD
for f in infra/docker/.env.production infra/docker/.env infra/backup/snapshots infra/backup/release-receipts \
         .env.test output/audits/2026-09-29-product-flow-fixes; do
  mkdir -p "$(dirname ~/.hawa/releases/$OLD/$f)"; ln -s ~/.hawa/shared/$f ~/.hawa/releases/$OLD/$f
done
(cd ~/.hawa/releases/$OLD && pnpm install --offline --frozen-lockfile && pnpm build && pnpm --filter @hawa/desk build)
bash ~/.hawa/current/infra/ops/release.sh activate $OLD          # current -> the old release
# The old .gitignore ignores the snapshot folders only as folders, so its clean-tree check sees the two
# links as untracked files: they are the only difference, hence ALLOW_DIRTY_DEPLOY (check git status first).
git -C ~/.hawa/releases/$OLD status --short                      # only infra/backup/snapshots and release-receipts
ALLOW_DIRTY_DEPLOY=1 bash ~/.hawa/releases/$OLD/infra/docker/deploy.sh --apply   # binds ./nginx.conf etc. from that worktree
bash ~/.hawa/releases/$OLD/infra/ops/install_launch_agents.sh    # the old installer: agents run that worktree
```

This restarts Postgres, nginx and Vector once (their command and bind paths change back). Production
then runs from `~/.hawa/releases/$OLD`, not from `/Users/hawzhin/Hawdesign`, so the checkout stays free.

**Undo the switch-over itself** (only if release directories misbehave): the same as the previous
block, which already leaves production on a plain worktree of a pre-ADR-158 commit with the old
installer's agents. The shared files stay where they are; the old scripts read them through the links.

## The other repairs in this release

- **Watchdog** (`infra/ops/watchdog.sh`): a new or changed set of problems is sent at once; only the
  same set is held back for 30 minutes. It reads each pass's new Postgres and Restate log lines and
  alerts on crash recovery (`terminating any other active server processes`, `database system was
  interrupted`) and on Restate `Severe lag`, which preceded both crashes by 5 to 10 minutes. Every line
  of its log starts with a UTC time. The disk is judged by free space: cleanup below 40 GiB, alert below
  25 GiB (`HAWA_DISK_CLEAN_GIB`, `HAWA_DISK_ALERT_GIB`), hourly reminders below 10 GiB. The state file
  gains `alert_key` and `last_pass`; an old state file works (they start empty).
- **Health**: with `HAWA_BILLING_PROBE_ENABLED` unset the model provider is `disabled` (not degraded,
  `everyMinutes: null`); Canva `unverified` is not degraded; `lastVerifiedProgressAt` is `null` until a
  paid probe has been sent; `flags.DESIGN_PIPELINE_V3_CHATS` is the number of pilot chats (never ids).
  Production should read `healthy` for the first time since the paid probe was switched off.
- **nginx**: refusals are 429; `/v1/health` is never limited; API and sign-in limits are per caller
  (session cookie, else Authorization header, else address) with a per-address ceiling.
- **Backups**: the weekly `backup_restore_drill.sh` records `static_schema_parity` with
  `restore_performed: false`; the monthly `restore_drill.sh` is still the data restore.
  `disk_cleanup.sh` logs what each step freed; the nightly backup appends its output to
  `~/.hawa/logs/disk_cleanup.log`. While Docker's build cache is over 8 GB it removes Hawa's own images
  that no container uses, that production's compose files do not name and that are older than 7 days.
  Expect the first run to remove images such as `hawa-core:verify-head` and `hawa-core:verdana-check`.
- **Logs**: a failed publication-inspection pass names its cause; pool errors are one line (no Client
  object with connection parameters).

## Docker VM sizing (recommendation; not applied)

Measured on 2026-09-30: the Docker Desktop VM has 20.2 GiB of memory and 8 CPUs on a Mac with 36 GB
and 14 cores, and its swap reached 14.5 of 15 GB before the 07:26 crash. Production's own peak is
about 13 GB (the cut-out service may take 8 GB of its 12 GB limit during a cut, Restate about 1 GB,
Postgres 1 GB reserved, Core, the workers, the Desk, nginx and Vector under 1 GB together). The test
Postgres is now capped at 2 GB and the chaos stack at about 5 GB, but BuildKit builds are not limited.

Recommended, for the owner to decide in Docker Desktop, Settings, Resources:

1. Memory 24 GB (leaves 12 GB for macOS and the tools), swap 2 GB: a small swap makes the kernel
   kill a capped container rather than stall the whole VM for minutes, which is what took Postgres down.
2. CPUs 10.
3. Do not run the chaos suite, a full test run and a deploy build at the same time on this Mac; better,
   move tests and chaos to another machine, and production to the dedicated host of
   `plans/hosting/PRODUCTION_HOSTING_PLAN.md`, where none of them share its VM.

## 2026-09-30 — Office and provider service boundaries (ADR-163/165)

The production deploy prepares three owner-only shared files before linking the
candidate release: `.env.service-boundaries`, `.env.worker` and
`.office-proxy-header.conf`. nginx overwrites `X-Hawa-Office-Proof` in every Core
proxy location; Core still checks the private office origin and write header.
A trusted-office Core without the generated proof refuses to start. The proof is
never supplied to the Desk or worker.

The worker environment has an explicit allowlist. It contains its internal token,
Telegram/runtime settings and `HAWA_DESIGN_WORKER_TOKEN`; it excludes provider,
administrator, proxy and ordinary operator key names. The first migration adopts
the legacy static operator key's value and restricts it to the design principal
in current Core. This keeps previous-Core rollback able to finish requests on a
newer worker. Current Core refuses that key for task listing, office sessions,
approval, delivery, provider changes and other administrator actions. Separate
named operator sessions still work. Existing identical static operator aliases
are retired with the same value. Do not independently rotate it: coordinate the
previous release, active/draining colours and compatibility before changing it.

The shared configuration revision is read back from Core and the activated
worker. The deployment receipt refuses a mismatch with the canonical provider
file, as well as mismatched source/image/migration identities. Older receipts
remain historical observations and are not rewritten as new configuration proof.

Provider credentials have one activation path:

```sh
bash ~/.hawa/current/infra/docker/rotate_external_secrets.sh
```

It verifies each supplied credential (including OpenAI), keeps hidden input in a
unique owner-only temporary directory, requires an operator reason, records a
value-free pending-deployment audit receipt, atomically replaces the canonical
shared file and deploys the active sealed release. A failed deployment is a
failure, not activation. The matching successful deployment receipt identifies
which configuration revision actually ran. Replaced credentials are revoked in
their provider console as applicable; changing an application setting does not
itself revoke an old provider key. Canva OAuth grant recovery retains its existing
durable encrypted connection flow.

Settings no longer accepts transient process-only key overrides. Its status is
presence in the actual running Core; it does not assert provider qualification.
No browser-selected provider endpoint is contacted. Never copy these generated
files or the canonical credentials into the repository, test fixtures, wiki,
provider prompts or logs.

## Independent worker identities (ADR183, 2026-09-30)

Deploy now prepares an independent design token and worker database URL. Preflight retains an
existing shared token until apply. After backup/migration and image/configuration qualification,
apply retires matching ordinary operator aliases, retains the old design token only as a scoped
drain identity, provisions `hawa_worker_login`, then replaces Core and deploys the idle worker color.
The previous design value is never copied into the new worker environment. Credentials stay in
owner-private shared files, not command arguments, logs, receipts or Git.

Migration073 preserves existing Core function capabilities explicitly and removes PUBLIC execution
on application-schema routines. The worker inherits only required RLS helpers and outbox/poll/send
operations. Poll writes cannot change the office kill switch or create provider configuration.
Its blob mount is read-only. Production verifies both nginx binds, live `nginx -t`, a checked reload
and post-reload validation. Missing/stale binds require a checked restart.

Pre-foundation release worktrees (before74618004) are retired only when inactive, clean and registered
in this repository. Current/previous and shared files are preserved. Git history remains available.
Once `.worker-identity-v2` exists, the new release tooling refuses activation of releases missing
migration073 and its provisioning implementation. The old predecessor is **not a qualified rollback**
after this identity upgrade: its configuration preparer refuses the independent-token file. Recover
by redeploying the qualified repair release, or ship a compatible forward fix. A backup does not
justify reverting migrations or restoring an old full-operator worker credential.

Retaining a previous design token permits a draining color to finish scoped design calls. Remove it
only after Restate reports no invocations pinned to that deployment and its container is stopped;
then requalify the Core reload. A finished source test does not prove a running color uses the new
DB login: inspect only its username and effective privilege booleans, verify health/polling/outbox,
and exercise current/previous scoped authorization plus negative operator/session controls.
