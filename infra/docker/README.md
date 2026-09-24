# Production stack (infra/docker)

`docker-compose.prod.yml` is the one canonical topology; `deploy.sh` deploys it. The operations
runbook is `docs/25_OPERATIONS_RUNBOOK.md`; this file covers the worker's blue/green deploys.

## Worker deploys: blue/green

*Architecture programme 0.1, ADR-034. Since 2026-09-24.*

### Why

Restate pins every invocation to the deployment that started it, and a deployment is an address.
Until 2026-09-24 the deploy replaced the single worker container behind `http://worker:9080` and
registered that address again, falling back to `force: true`. A design in flight then replayed its
journal on the new code, which Restate's error reference names as the cause of journal mismatches
(RT0016); Restate's admin API warns that `force` "can lead inflight invocations to an unrecoverable
error state". Deploys were safe only when nothing was in flight.

Measured on a scratch Restate (1.7.0 and 1.7.10) on 2026-09-24: registering an address Restate already
holds answers 200 and keeps the old handlers even when the handlers at that address changed, so the
old step never registered a new or renamed handler either (its `force: true` branch ran only when the
first call failed).

### How it works

- Two services, `worker-blue` (`http://worker-blue:9080`) and `worker-green` (`http://worker-green:9080`),
  same build and environment; each knows its own address (`HAWA_WORKER_SELF_URI`). Both sit behind the
  `worker` compose profile, so a plain `docker compose up` (the deploy's own, the watchdog's) never
  creates, recreates or stops either. Images are tagged per colour, so building one never retags the
  image the other runs.
- **The live colour is the one Restate sends new `TaskWorkflow` invocations to** (`GET
  /services/TaskWorkflow` names its deployment). There is no state file of our own: the registration is
  what switches traffic, so the record and the traffic can never disagree, and a deploy stopped halfway
  leaves nothing to reconcile.
- `deploy.sh --apply` (step 4b, then 7b), using `scripts/restate-bluegreen.ts` for every decision:
  1. `plan`: the live colour and the idle one (the other colour; blue after the old single `worker`,
     or when Restate holds no worker at all). While the old single `worker` is live, it also counts the
     paused and backing-off invocations pinned to it (`live_stuck`); the deploy refuses until there
     are none (see "First deploy" below).
  2. `finish-drains --require-drained <idle>`: a drain an earlier deploy left running is finished first.
     Drained deployments are deleted and their containers removed. If the idle colour, or the old
     single `worker`, is still registered after `HAWA_PREVIOUS_DRAIN_WAIT_SECONDS` (default 600), the
     deploy stops before changing anything about the workers, and prints why for each:
     `draining=<colour>:<n>` (n invocations still pinned to it; a paused one never finishes on its own,
     resume or cancel it) or `kept=<colour>:<reason>` (a service is still routed to it, or its delete
     failed).
  3. Build and start the idle colour; wait for its `/health`.
  4. `register <idle>`: `POST /deployments` with `force: false` and no fallback. Success is a new
     deployment at the idle address after which Restate sends every worker service (`TaskWorkflow`,
     `TaskService`, and any other it routed to a worker) there. A 200 counts as that success when
     Restate did not hold the address before this deploy: an earlier attempt was committed and its
     answer lost. When an answer is lost and nothing more comes back, Restate's registry decides.
     - Refused (exit 2): an address Restate held before (never replaced under `force: false`), any
       4xx, or an address that stays unreachable (`META0003`, retried for 60 s).
     - Partial (exit 4): Restate registered the new colour but some service still goes elsewhere (a
       build that no longer hosts it: Restate 1.7.10 moves only the services the new build hosts), or
       where a service goes could not be read.
     Either way the deploy then asks Restate once more (`removable <idle>`). Only when Restate holds no
     deployment at the idle address is the new colour removed; otherwise both colours keep running,
     nothing is drained, and the deploy fails for a person (see "A switch that did not complete").
  5. `finish-drains`: polls `SELECT count(*) FROM sys_invocation WHERE pinned_deployment_id = '<old>'
     AND status <> 'completed'` every 10 s. At 0 the old deployment is deleted (`DELETE
     /deployments/<id>?force=true`; Restate 1.7 answers 501 to a delete without force) and its container
     stopped, unless a service is still routed to it (`GET /services`, read afresh every round):
     deleting that would bring back "service not found" (2026-09-17). At `HAWA_DRAIN_TIMEOUT_SECONDS`
     (default 900) the old colour is left running and the deploy says so and still succeeds: new work
     already goes to the new colour. A container whose deployment was deleted but that will not stop is
     reported and the deploy goes on.
- Restate's admin port is not published. The script runs on the host and makes each admin call with
  node inside the running Core container (`--via-container hawa-production-core-1`).

### Background loops

The outbox consumer is the only loop in the worker besides Restate handlers. It must not run in two
colours: its `FOR UPDATE SKIP LOCKED` lease is exclusive for 60 s only, so a batch that outlives its
lease is leased again by the other colour and a Telegram delivery goes out twice; and the old colour
would run old handlers on commands the new Core writes. So a colour runs it only while it is the live
one (`apps/worker/src/live-colour.ts`): it asks Restate at most every 10 s, stops leasing within one
check of losing the role, and starts only after it has held the role for 70 s
(`HAWA_WORKER_TAKEOVER_MS`), by which time the old colour's last lease has run out. The delay is
skipped when Restate holds no deployment but its own (a restart of the live colour after the old one
was removed), so a crash does not stop the outbox for a minute. A worker that has
never reached Restate stays still; one that was live stays live through a Restate restart. A worker
without `HAWA_WORKER_SELF_URI` (development, tests) runs the consumer as before.

Worker `/health` shows `colour` and `background`: `live`, `taking_over`, `standby` (draining, or not
registered), `unknown` (Restate not reached yet) or `misconfigured`.

**First deploy after this change:** the old single `worker` container runs code without this gate,
so it keeps consuming the outbox until its drain finishes and the deploy removes it; for that window
the two consumers are kept apart by the lease alone. To keep that window short, the deploy refuses
while any paused or backing-off invocation is pinned to the old `worker` (they would never finish on
their own), and every later deploy stops until the old `worker` is gone.

### The Telegram poller (Phase 2.1)

Core asks Telegram for updates by default (`HAWA_TELEGRAM_POLLER=core`, or unset). Core handled one
update at a time for every chat, so a 20 MB file in one chat held all the others for as long as its
download took (the chaos suite's R4 measured 30.9 s). With `HAWA_TELEGRAM_POLLER=worker` the worker's
live colour polls instead (`apps/worker/src/lifecycle/telegram-poller.ts`): it sends each update to its
chat's `ChatInbox` in Restate (key `tg-<update_id>`, so the same update twice is one invocation) and
moves the stored offset only after Restate accepted it. `ChatInbox` runs one update at a time per chat,
chats side by side, and hands each to Core's intake unchanged through `POST /v1/internal/telegram/intake`.
An update intake keeps failing is dead-lettered as before, through `POST /v1/internal/telegram/park`.
Core's "Poll now" answers 409 while the worker polls.

**Before switching, the owner adds `HAWA_WORKER_TOKEN` to `infra/docker/.env.production`**: a long random
value of its own (for example `openssl rand -hex 32`), not the same as any other key. Core and both
worker colours read it from that file. It is the worker's credential for Core's `/v1/internal/*`, the
only routes that accept it, and those routes accept nothing else. Without it the worker does not start
its poller (worker `/health` reports `telegramPoller: misconfigured`), so with `worker` set and no token
nobody polls: set the token first.

- Switch: set `HAWA_TELEGRAM_POLLER=worker` in `infra/docker/.env` (the compose interpolation file; a
  value in `.env.production` is overridden by compose's `environment:` block), then deploy. Core stops
  polling on its restart; the live worker colour starts polling once it has held the role for 30 s
  (`HAWA_POLLER_TAKEOVER_MS`).
- Roll back: set it to `core` (or remove it) and deploy again. Both pollers keep the offset in the same
  Postgres row, so the other one carries on from there. Updates already queued in Restate still go to
  Core's intake, which deduplicates them.
- The kill switch stops the worker's poller too: it reads the channel's `office-kill-switch` row in
  Postgres before every poll (cached 5 s), and asks Telegram for nothing while the switch is thrown or
  cannot be read.
- Worker `/health` shows `telegramPoller`: `off`, `misconfigured` with the reason, or `on` with the
  offset, the count handed on, the last poll and the last error.

### Operating it

- Where would a deploy go: `bash infra/docker/deploy.sh` (pre-flight) prints `live=… idle=…`.
- By hand, from the repository root:
  `npx tsx scripts/restate-bluegreen.ts plan --via-container hawa-production-core-1`, and
  `finish-drains --wait-seconds 0 --via-container hawa-production-core-1` (reports `draining=<colour>:<n>`
  and `kept=<colour>:<reason>` and deletes what has drained; `removable <colour>` says whether Restate
  holds a deployment at that colour's address; stop a deleted colour's container with
  `docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/canva-release.override.yml --env-file infra/docker/.env rm -sf worker-<colour>`).
- Compose and the profile (checked on a scratch project with Docker Compose 5.5.1 on 2026-09-24): a
  plain `up -d`, even with `--force-recreate` and with the service's `depends_on` target recreated,
  leaves a profile service's container alone; `start` does not start one (the watchdog starts existing
  worker containers itself), and `down` does not remove one without `--profile worker`; naming the
  service in `build`, `up` or `rm` works without `--profile`.
- A switch that did not complete (deploy failed with "was NOT removed"): Restate holds the new colour
  and may already send it work. Read `GET /services` (admin API, from inside the Core container) to see
  where each service goes. If every service is on the new colour, run `finish-drains` by hand. If some
  service is still on the old one only (the new build dropped or renamed it), either ship a build that
  hosts it and deploy again, or, once nothing needs that service any more, leave the old colour to
  drain. Never remove a colour any service is routed to.
- A colour that will not drain: look at what is pinned to it in the Restate UI or with
  `SELECT id, target, status, last_failure FROM sys_invocation WHERE pinned_deployment_id = '<id>' AND status <> 'completed'`.
  A suspended invocation waits for a timer or a promise; a paused one waits for a person (resume or
  cancel it). Never delete a deployment that still has invocations pinned to it.
- Health: core `/v1/health` reports `restateInvocations` (`paused`, `backingOff`, `inbox`; asked with a
  1 s timeout, cached 10 s, `unknown` when Restate does not answer) and
  `dependencies.restatePausedInvocations`. Any paused invocation makes health `degraded`, and the
  watchdog alerts on it. `/ready` is the container liveness check (one database ping, nothing else).
- Memory: two workers run only while one drains; the idle colour is otherwise removed.
- Restate: `ghcr.io/restatedev/restate:1.7.10` (patch releases of 1.7). Rolling the image back to
  1.7.0 is safe only while the opt-in one-way migrations of 1.7.x stay off, and all of them are off
  here. The changelog (read 2026-09-24) lists `experimental_enable_vqueues` (1.7.3; one-way, no
  migration back), `experimental-enable-preflight-invocation-termination-retention` (1.7.5; needs 1.7.8
  or newer once applied) and `experimental-enable-vqueue-obsolete-cleanup` (1.7.9; needs 1.7.10 or
  newer once applied). A `restate_data` volume on which any of them has run cannot go back to 1.7.0.
  Test a minor upgrade (1.8) on a copy of `restate_data` first: it migrates partitions one way.
