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
     or when Restate holds no worker at all).
  2. `finish-drains --require-drained <idle>`: a drain an earlier deploy left running is finished first.
     Drained deployments are deleted and their containers removed. If the idle colour still has
     invocations pinned to it after `HAWA_PREVIOUS_DRAIN_WAIT_SECONDS` (default 600), the deploy stops
     before changing anything about the workers, since replacing that colour would replay them.
  3. Build and start the idle colour; wait for its `/health`.
  4. `register <idle>`: `POST /deployments` with `force: false` and no fallback. Success is a 201 after
     which Restate sends both `TaskWorkflow` and `TaskService` to the new deployment. A 200 (address
     already held), any 4xx, or an address that stays unreachable (`META0003`, retried for 60 s) is a
     refusal: the new colour is removed, the live colour is untouched, and the deploy fails with
     Restate's reason.
  5. `finish-drains`: polls `SELECT count(*) FROM sys_invocation WHERE pinned_deployment_id = '<old>'
     AND status <> 'completed'` every 10 s. At 0 the old deployment is deleted (`DELETE
     /deployments/<id>?force=true`; Restate 1.7 answers 501 to a delete without force) and its container
     stopped. At `HAWA_DRAIN_TIMEOUT_SECONDS` (default 900) the old colour is left running and the
     deploy says so and still succeeds: new work already goes to the new colour.
- Restate's admin port is not published. The script runs on the host and makes each admin call with
  node inside the running Core container (`--via-container hawa-production-core-1`).

### Background loops

The outbox consumer is the only loop in the worker besides Restate handlers. It must not run in two
colours: its `FOR UPDATE SKIP LOCKED` lease is exclusive for 60 s only, so a batch that outlives its
lease is leased again by the other colour and a Telegram delivery goes out twice; and the old colour
would run old handlers on commands the new Core writes. So a colour runs it only while it is the live
one (`apps/worker/src/live-colour.ts`): it asks Restate at most every 10 s, stops leasing within one
check of losing the role, and starts only after it has held the role for 70 s
(`HAWA_WORKER_TAKEOVER_MS`), by which time the old colour's last lease has run out. A worker that has
never reached Restate stays still; one that was live stays live through a Restate restart. A worker
without `HAWA_WORKER_SELF_URI` (development, tests) runs the consumer as before.

Worker `/health` shows `colour` and `background`: `live`, `taking_over`, `standby` (draining, or not
registered), `unknown` (Restate not reached yet) or `misconfigured`.

**First deploy after this change:** the old single `worker` container runs code without this gate,
so it keeps consuming the outbox until its drain finishes and the deploy removes it; for that window
the two consumers are kept apart by the lease alone.

### Operating it

- Where would a deploy go: `bash infra/docker/deploy.sh` (pre-flight) prints `live=… idle=…`.
- By hand, from the repository root:
  `npx tsx scripts/restate-bluegreen.ts plan --via-container hawa-production-core-1`, and
  `finish-drains --wait-seconds 0 --via-container hawa-production-core-1` (reports `draining=<colour>:<n>`
  and deletes what has drained; stop a deleted colour's container with
  `docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/canva-release.override.yml --env-file infra/docker/.env rm -sf worker-<colour>`).
- Compose and the profile (checked on a scratch project with Docker Compose 5.5.1 on 2026-09-24): a
  plain `up -d`, even with `--force-recreate` and with the service's `depends_on` target recreated,
  leaves a profile service's container alone; `start` does not start one (the watchdog starts existing
  worker containers itself), and `down` does not remove one without `--profile worker`; naming the
  service in `build`, `up` or `rm` works without `--profile`.
- A colour that will not drain: look at what is pinned to it in the Restate UI or with
  `SELECT id, target, status, last_failure FROM sys_invocation WHERE pinned_deployment_id = '<id>' AND status <> 'completed'`.
  A suspended invocation waits for a timer or a promise; a paused one waits for a person (resume or
  cancel it). Never delete a deployment that still has invocations pinned to it.
- Health: core `/v1/health` reports `restateInvocations` (`paused`, `backingOff`, `inbox`; asked with a
  1 s timeout, cached 10 s, `unknown` when Restate does not answer) and
  `dependencies.restatePausedInvocations`. Any paused invocation makes health `degraded`, and the
  watchdog alerts on it. `/ready` is the container liveness check (one database ping, nothing else).
- Memory: two workers run only while one drains; the idle colour is otherwise removed.
- Restate: `ghcr.io/restatedev/restate:1.7.10` (patch releases of 1.7). Leave
  `experimental-enable-vqueue-obsolete-cleanup` off (it is one-way). Test a minor upgrade (1.8) on a
  copy of `restate_data` first: it migrates partitions one way.
