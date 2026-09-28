# Runbook 20: Operating the new architecture

*Architecture programme Phase 4 (output/plans/2026-09-24-architecture-programme/PLAN.md). Written
2026-09-25 against `studio-v2` at 1c1316d.*

This runbook covers what changed with the programme: two worker colours and their drains, Restate
invocations that wait for a person, the Phase 2 flags, one request's logs, the file store, the test
databases, the chaos suite and the load test. Background: `infra/docker/README.md` (blue/green, the
poller), `runbooks/10_backup_restore.md` (backups), ADR-034 to ADR-037.

## How to read the commands

**Every command block below was run by the author on the chaos stack or on the test server, never on
production.** The first line of each block says which, and when. A test
(`scripts/load/test/runbook.test.ts`) fails if a block does not say so, or names production's
containers, port or database.

- **Chaos stack**: the compose project `hawa-chaos` (`packages/testkit/chaos`), a copy of production
  (Postgres 17, Restate 1.7.10, Core, the worker colours) whose provider hosts are fakes on an internal
  network. Restate's admin API is on `127.0.0.1:56070`, Postgres on `127.0.0.1:56432` (database
  `hawa_chaos`), and Core is reached through the fakes' proxy at `127.0.0.1:56090/__core`. Only one
  chaos stack can exist on the machine at a time: before starting one, check `docker ps` shows no
  container named `hawa-chaos-*`, and always take it down afterwards.
- **Test server**: `hawa-test-postgres` on `127.0.0.1:55432`.

**On production**, the same operations differ only in where they point. The substitutions, which the
author has not run:

| Chaos stack | Production |
|---|---|
| `--admin http://127.0.0.1:56070` (restate-bluegreen.ts) | `--via-container hawa-production-core-1` (the admin port is not published) |
| `curl http://127.0.0.1:56070/...` (Restate admin API) | the same request made from inside the Core container, whose network reaches Restate at `http://restate:9070` (what `restate-bluegreen.ts --via-container` does) |
| `http://127.0.0.1:56090/__core/v1/...` | `https://<desk host>/v1/...` through nginx |
| `docker compose -p hawa-chaos -f packages/testkit/chaos/docker-compose.chaos.yml --env-file packages/testkit/chaos/.run/chaos.env …` | `bash infra/docker/deploy.sh` (dry run) and then its apply step, which the owner runs |
| `hawa-chaos-postgres-1`, database `hawa_chaos` | `hawa-production-postgres-1`, database `hawa` (never ad-hoc SQL on production: read it through Core's API or the Restate journal) |
| `npx tsx scripts/load/with-chaos-db.ts <tool>` (puts the chaos owner URL in `DATABASE_URL`) | the tool as `infra/backup/*.sh` and the launch agents run it |

In the blocks, `S` is a scratch directory; the author's was
`$TMPDIR/…/scratchpad/load/filestore`.

## Worker deploys: blue/green

The live colour is the one Restate sends new work to; a deploy starts the other colour, registers it
with `force: false`, and deletes the old deployment only once nothing is pinned to it
(`infra/docker/README.md` has the why). `deploy.sh --apply` does all of it; by hand it is:

```sh
# Ran on the chaos stack, 2026-09-24 21:16Z: where would a deploy go?
npx tsx scripts/restate-bluegreen.ts plan --admin http://127.0.0.1:56070
# live=blue
# live_deployment=dp_13aB1bFnHcXzMrinxtpHKc9
# idle=green
# live_stuck=
```

```sh
# Ran on the chaos stack, 2026-09-24 21:16Z: start the idle colour, register it, try to finish the drain.
CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos -f packages/testkit/chaos/docker-compose.chaos.yml \
  --env-file packages/testkit/chaos/.run/chaos.env up -d --no-build --no-deps --wait worker-green
npx tsx scripts/restate-bluegreen.ts register green --admin http://127.0.0.1:56070
# deployment=dp_13LbWNiF8KhV6MW2q24pJHH
npx tsx scripts/restate-bluegreen.ts finish-drains --wait-seconds 0 --admin http://127.0.0.1:56070
# draining=blue:1
```

After `register`, `plan` says `live=green`: new work already goes to green. Blue keeps running for what
is pinned to it.

### A stuck drain

`draining=blue:1` that does not go down means an invocation pinned to the old colour is not finishing
by itself. The deploy leaves the old colour running and still succeeds (after
`HAWA_DRAIN_TIMEOUT_SECONDS`); the next deploy refuses to go on until that drain is finished
(`finish-drains --require-drained`). Look at what is pinned:

```sh
# Ran on the chaos stack, 2026-09-24 21:16Z: what keeps blue from draining.
curl -s http://127.0.0.1:56070/query -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"query\":\"SELECT id, target, status, retry_count, next_retry_at FROM sys_invocation WHERE pinned_deployment_id = 'dp_13aB1bFnHcXzMrinxtpHKc9' AND status <> 'completed'\"}"
# {"rows":[{"id":"inv_1eC7FuOzjLTO4txeTfIUpz4yOrcPlZbjxE","target":"ChatInbox/9500001/handleUpdate","status":"backing-off","retry_count":4,…}]}
```

What each status means, and what to do:

| Status | Means | Do |
|---|---|---|
| `running`, `suspended` | Working, or waiting for a timer or a promise (a design polling Canva). | Wait; it finishes on the colour it started on. |
| `backing-off` | A step failed and Restate will retry it (`last_failure` says why). | Fix the cause (here Core was down), then resume it to retry now (next section). |
| `paused` | Retries ran out; it waits for a person. It never finishes by itself. | Fix the cause, then resume it, or cancel it (next section). |

**Never delete a deployment that still has invocations pinned to it**, and never register with
`force: true`: both break invocations in flight (RT0016). In the drill, blue was stuck because Core was
stopped; once Core was back and the invocation resumed (next section), the drain finished:

```sh
# Ran on the chaos stack, 2026-09-24 21:17Z: finish the drain, then remove the drained colour's container.
npx tsx scripts/restate-bluegreen.ts finish-drains --wait-seconds 60 --admin http://127.0.0.1:56070
# deleted=blue
npx tsx scripts/restate-bluegreen.ts removable blue --admin http://127.0.0.1:56070
# registered=            (Restate holds nothing at blue's address: the container may go)
CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos -f packages/testkit/chaos/docker-compose.chaos.yml \
  --env-file packages/testkit/chaos/.run/chaos.env rm -sf worker-blue
npx tsx scripts/restate-bluegreen.ts plan --admin http://127.0.0.1:56070
# live=green … idle=blue
```

The worker's own view after the switch (the new colour takes over the outbox and the poller after its
takeover delay; `background` goes from `taking_over` to `live`):

```sh
# Ran on the chaos stack, 2026-09-24 21:17Z.
docker exec hawa-chaos-worker-green-1 node -e "fetch('http://localhost:9080/health').then(r=>r.json()).then(j=>console.log(JSON.stringify({colour:j.colour,background:j.background,telegramPoller:j.telegramPoller})))"
# {"colour":"green","background":"taking_over","telegramPoller":{"mode":"on","background":"live","offset":90284190566,…}}
```

## Paused and backing-off invocations

**How you learn of them.** Core's `/v1/health` reports `restateInvocations` (`paused`, `backingOff`,
`inbox`; cached 10 s) and `dependencies.restatePausedInvocations`. Any paused invocation makes health
`degraded`, and the watchdog alerts on it. The drill paused the invocation above (as Restate does when
its retries run out, after about an hour) and read health:

```sh
# Ran on the chaos stack, 2026-09-24 21:16Z: pause (drill only), then read what the office's health shows.
curl -s -o /dev/null -w "pause HTTP %{http_code}\n" -X PATCH http://127.0.0.1:56070/invocations/inv_1eC7FuOzjLTO4txeTfIUpz4yOrcPlZbjxE/pause
# pause HTTP 202
docker start hawa-chaos-core-1        # the cause fixed (Core had been stopped for the drain drill)
curl -s http://127.0.0.1:56090/__core/v1/health | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], d['restateInvocations'], d['dependencies'].get('restatePausedInvocations'))"
# degraded {'status': 'ok', 'paused': 1, 'backingOff': 0, 'inbox': 0, …} 1
```

**Which ones, and why.** `last_failure` carries the error the handler threw:

```sh
# Ran on the chaos stack, 2026-09-24 21:16Z.
curl -s http://127.0.0.1:56070/query -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"query\":\"SELECT id, target, status, retry_count, last_failure, pinned_deployment_id FROM sys_invocation WHERE status IN ('paused', 'backing-off')\"}"
# … "status":"backing-off","last_failure":"[500 Internal] Core is unreachable, update 90284190566 waits: fetch failed …"
```

**Resume** once the cause is fixed. A paused invocation continues from its journal; a backing-off one
retries at once instead of at `next_retry_at`. It resumes on the deployment it is pinned to (the
admin API can move it with `?deployment=`, which replays its journal on that build: only for the same
code, never across a change of handlers):

```sh
# Ran on the chaos stack, 2026-09-24 21:17Z.
curl -s -w "\nresume HTTP %{http_code}\n" -X PATCH http://127.0.0.1:56070/invocations/inv_1eC7FuOzjLTO4txeTfIUpz4yOrcPlZbjxE/resume
# resume HTTP 200
curl -s http://127.0.0.1:56070/query -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"query\":\"SELECT id, status, pinned_deployment_id FROM sys_invocation WHERE id = 'inv_1eC7FuOzjLTO4txeTfIUpz4yOrcPlZbjxE'\"}"
# {"rows":[{"id":"inv_1eC7Fu…","status":"completed","pinned_deployment_id":"dp_13aB1bFnHcXzMrinxtpHKc9"}]}
```

The requester got the brief's acknowledgement once. A resume of an invocation that already finished
answers `409` ("is completed, cannot be resumed"), which is harmless: in the token drill below the
invocation's own retry had won the race.

**Cancel or kill** only when the work must not happen at all. `PATCH /invocations/<id>/cancel` stops
it and keeps its object state consistent; `…/kill` does not (Restate's warning: no guarantee for
object state or calls in flight), so prefer cancel. Neither was needed in the drills. After a cancel,
look at the task in the Desk: a request whose `ChatInbox` update was cancelled never reached intake.

## Phase 2 flags per chat, and rolling back

| Flag | Read by | Values | Where it is set in production |
|---|---|---|---|
| `HAWA_TELEGRAM_POLLER` | Core and the worker, at start | `core` (default) or `worker` | `infra/docker/.env` (compose interpolation), then deploy |
| `HAWA_LIFECYCLE_CHATS` | Core, when Deliver is pressed | chat ids, comma-separated, or `*`; empty enrols nobody | `infra/docker/.env.production`, then deploy |
| `HAWA_WORKER_TOKEN` | Core (`/v1/internal/*`) and every worker colour | a long random value of its own (`openssl rand -hex 32`) | `infra/docker/.env.production`, then deploy |

Each is read when the process starts: a change takes a restart of Core and the worker, which in
production is a deploy. On the chaos stack the author recreated the containers with the new value.

### The poller: switching and rolling back

The worker polls only if `HAWA_TELEGRAM_POLLER=worker` **and** it has `HAWA_WORKER_TOKEN`; set the
token first. Both pollers keep the offset in the same Postgres row, so either carries on where the
other stopped.

```sh
# Ran on the chaos stack, 2026-09-24 21:17Z: roll back from worker to core.
CHAOS_TELEGRAM_POLLER=core docker compose -p hawa-chaos -f packages/testkit/chaos/docker-compose.chaos.yml \
  --env-file packages/testkit/chaos/.run/chaos.env up -d --no-build --no-deps --wait core worker-green
curl -s http://127.0.0.1:56090/__core/v1/adapters/telegram/status | python3 -c "import json,sys; d=json.load(sys.stdin); print('core says poller =', d['poller'], '| bridge mode', d['bridge']['mode'])"
# core says poller = core | bridge mode live_polling
docker exec hawa-chaos-worker-green-1 node -e "fetch('http://localhost:9080/health').then(r=>r.json()).then(j=>console.log('worker telegramPoller', JSON.stringify(j.telegramPoller)))"
# worker telegramPoller {"mode":"off"}
```

A brief sent after the rollback was answered once by Core, from the offset the worker had stored.
Updates already handed to `ChatInbox` before a rollback still go to Core's intake, which deduplicates
them. Switching forward is the same with `worker`; the worker starts polling once its colour has been
live for 30 s (`HAWA_POLLER_TAKEOVER_MS`), and its health then shows `"mode":"on"` with `handedOn`
counting updates. Core's "Poll now" answers 409 while the worker polls.

### The worker token: rotating, and a half-done rotation

Rotate by giving Core and every worker colour the same new value and restarting them together:

```sh
# Ran on the chaos stack, 2026-09-24 21:18Z: rotate the token (generated inline, never printed) and switch to the worker poller.
CHAOS_WORKER_TOKEN=$(openssl rand -hex 24) CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml --env-file packages/testkit/chaos/.run/chaos.env \
  up -d --no-build --no-deps --wait core worker-green
curl -s http://127.0.0.1:56090/__core/v1/adapters/telegram/status | python3 -c "import json,sys; print('core says poller =', json.load(sys.stdin)['poller'])"
# core says poller = worker
```

**Symptom of a token on one side only** (the drill restarted Core alone with a new value): nothing is
lost, but every update waits. `ChatInbox` invocations back off with a 401:

```sh
# Ran on the chaos stack, 2026-09-24 21:18Z: Core alone gets a new token, then a brief arrives (chat 9500004).
CHAOS_WORKER_TOKEN=$(openssl rand -hex 24) CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml --env-file packages/testkit/chaos/.run/chaos.env \
  up -d --no-build --no-deps --wait core
curl -s http://127.0.0.1:56070/query -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"query\":\"SELECT id, status, retry_count, last_failure FROM sys_invocation WHERE target LIKE 'ChatInbox/9500004/%'\"}"
# … "status":"backing-off", "last_failure":"[500 Internal] Core refused the worker's intake call with HTTP 401 (Authentication Required); update 90284190569 waits until this deployment is fixed …"
```

The fix is to give both the same value and restart both (the rotation block above). The waiting
invocation then finishes on its next retry, or at once with a resume. A Delivery workflow whose calls
to Core meet the 401 waits the same way. Rolling back a token is the same operation with the old
value.

### The lifecycle chats: enrolling a chat and rolling back

`HAWA_LIFECYCLE_CHATS` decides, when Deliver is pressed, whether the Restate `Delivery` workflow
delivers the task (`publications.executor = 'restate'`) or Core's own delivery does (`core`). A
publication the workflow owns stays the workflow's even after its chat is taken off the list, and one
Core started stays Core's: taking a chat off the list never moves a delivery in flight. The chaos
compose file lists its chats literally, so the drill set the value with an override file
(`services: core: environment: HAWA_LIFECYCLE_CHATS: ${DRILL_LIFECYCLE_CHATS:-}`, saved as
`$S/lifecycle-override.yml`). The author recreated Core first and the worker second; the worker's
recreate was needed only because the token drill had left it with a token of its own (see the note
after these blocks):

```sh
# Ran on the chaos stack, 2026-09-24 21:19Z: enrol chat 9500005 only, then deliver one request there.
DRILL_LIFECYCLE_CHATS=9500005 CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml -f $S/lifecycle-override.yml \
  --env-file packages/testkit/chaos/.run/chaos.env up -d --no-build --no-deps --wait core
docker exec hawa-chaos-core-1 printenv HAWA_LIFECYCLE_CHATS
# 9500005
DRILL_LIFECYCLE_CHATS=9500005 CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml -f $S/lifecycle-override.yml \
  --env-file packages/testkit/chaos/.run/chaos.env up -d --no-build --no-deps --wait worker-green
npx tsx scripts/load/deliver-one.ts 9500005
# Deliver: HTTP 202, executor restate
# delivered: publications [{"executor":"restate","state":"complete"}]
```

```sh
# Ran on the chaos stack, 2026-09-24 21:20Z: roll back (nobody enrolled), deliver in another chat.
DRILL_LIFECYCLE_CHATS= CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml -f $S/lifecycle-override.yml \
  --env-file packages/testkit/chaos/.run/chaos.env up -d --no-build --no-deps --wait core
npx tsx scripts/load/deliver-one.ts 9500006
# delivered: publications [{"executor":"core","state":"complete"}]
docker exec hawa-chaos-postgres-1 psql -U hawa_owner -d hawa_chaos -Atc "SELECT p.executor, p.state, count(*) FROM hawa.publications p GROUP BY 1, 2 ORDER BY 1"
# core|complete|1
# restate|complete|1
```

Recreating only Core also gives it whatever worker token that compose invocation carries: the
author's first recreate here put Core back on the env file's token while the worker still had the
one from the token drill (the 401 above), and the worker had to be recreated too. Restart Core and
the workers together, from one environment.

## Reading one request's logs

`scripts/request_logs.ts <requestId | taskId>` prints every line of one request across Core, the
worker and nginx, from the daily files Vector writes (`~/.hawa/logs/containers/<day>/<service>.ndjson`),
so it also finds lines of containers a deploy has replaced. Where the id comes from: the
`x-request-id` response header, `tg-<update_id>` for a Telegram update, a task id.

The chaos stack runs no Vector, so the drill exported its containers' logs into Vector's layout
first (`scripts/load/export-chaos-logs.ts`), then read them:

```sh
# Ran on the chaos stack, 2026-09-24 21:20Z.
npx tsx scripts/load/export-chaos-logs.ts $S/../chaos-logs
# core: 15 line(s)  worker-green: 85 line(s)  postgres: 271 line(s)  restate: 1089 line(s) …
npx tsx scripts/request_logs.ts 5c4fd738-b47d-4071-aa53-da5fcab14be9 --dir $S/../chaos-logs
# 2026-09-24 21:20:00.558Z core info [tg-90284190571] request {"chatId":"9500006","method":"POST","path":"/api/webhooks/telegram",…}
# …
# 13 line(s) for 5c4fd738-b47d-4071-aa53-da5fcab14be9 in 5 file(s): core
```

Two things the drill showed:

- **A task id finds Core's lines, not the worker's** (fixed 2026-09-28). The worker's Restate lines
  name the task only inside the invocation's key, `[TaskWorkflow/task-wf-<taskId>/run][inv_…]`, and
  `request_logs.ts` matched whole tokens, where a leading `-` belongs to the token. It now also takes
  the id inside the keys that carry one (`task-wf-<id>`, `task-wf-<id>-redrive-<n>`, `dr-<id>[-a<n>]`,
  `dl-<id>-<approvalId>[:archive:<n>]`; a lifecycle Delivery's key carries the request id, not the
  task's), and follows the `inv_…` ids on those lines the way it follows request ids, including the
  worker's lines logged under `restate-inv_…`. Searching by the invocation id still works:

  ```sh
  # Ran on the chaos stack, 2026-09-28 13:51Z.
  npx tsx scripts/load/export-chaos-logs.ts $S/chaos-logs
  npx tsx scripts/request_logs.ts 399c154a-fef8-4182-a9d1-a2a1a2141780 --dir $S/chaos-logs
  # … worker-blue  [restate][2026-09-28T10:44:54.595Z][TaskWorkflow/task-wf-399c154a-…/run][inv_1jQLgVMhRi8800zKle1fGXCpKb7JarQsHN] INFO: Starting invocation.
  # 35 line(s) for 399c154a-fef8-4182-a9d1-a2a1a2141780 in 5 file(s): core, worker-blue
  #   (before the fix: 13 line(s) … : core)
  ```

  Restate's own log records span several lines (the error, then `restate.invocation.id`,
  `restate.invocation.target`, …), and each is stored as its own line: the `target` line is found by
  the task id, the error text above it is not. Read Restate's lines around that time for the rest.

- **`docker logs` goes with its container.** Core had been recreated four times in the drills and its
  export held 15 lines: the first delivery's Core lines were gone. That is why production keeps
  Vector's files; `docker logs` alone is not enough after a deploy.

## The file store

Files live content-addressed under `~/.hawa/blobs` (ADR-035); `hawa.blobs` rows name them and
`hawa.blob_references` lists every reference. Three jobs keep it safe, all described in
`runbooks/10_backup_restore.md`: the nightly backup (dump, then the files the dump references, then
the garbage collector), the monthly restore drill, and a restore for real. The drill ran each one
against the chaos database and a scratch store, with the same scripts the launch agents run, pointed
elsewhere through their environment; `HAWA_BACKUP_NOTIFY_ENV` names a file that does not exist, so no
alert can be sent.

Bytes still in the database (written before the store) are copied out by the backfill. The chaos
stack's twelve plan sources (PPTX) were:

```sh
# Ran on the chaos stack, 2026-09-24 21:21Z. S/blobs holds sha256/, tmp/ and the marker .hawa-blob-store ("sha256-v1").
HAWA_BLOB_DIR=$S/blobs npx tsx scripts/load/with-chaos-db.ts npx tsx scripts/blob_backfill.ts --phase plan_sources --mode copy
# {"database":"hawa_chaos","mode":"copy",…,"reports":[{"phase":"plan_sources","scanned":12,"stored":12,…,"problems":[]}],"log":"/Users/…/.hawa/logs/blob_backfill_2026-09-24T21-21-26-892Z.ndjson"}
```

Without `--log <file>` the backfill writes its log into `~/.hawa/logs`, the office's own log
directory, even for the chaos database; the author moved that file out afterwards. Give `--log` when
rehearsing.

### Nightly backup

```sh
# Ran on the chaos stack, 2026-09-24 21:22Z.
HAWA_BACKUP_SNAPSHOT_DIR=$S/snapshots HAWA_BACKUP_ARCHIVE_DEST=$S/archive HAWA_BACKUP_ARCHIVE_KEYFILE=$S/passphrase \
  HAWA_BACKUP_PG_CONTAINER=hawa-chaos-postgres-1 HAWA_BACKUP_DB=hawa_chaos HAWA_BACKUP_NOTIFY_ENV=$S/no-such-env \
  HAWA_BLOBS_DIR=$S/blobs HAWA_BLOB_DIR=$S/blobs HAWA_BLOB_GC_CMD="node apps/core/dist/tools/blob-gc.js" \
  npx tsx scripts/load/with-chaos-db.ts bash infra/backup/nightly_backup.sh
# ✓ backup …/hawa_20260924T212201Z.dump (36400707 bytes), restore verified: tasks=5016 events=20056, files=12 (12 new), archived to …/archive
tail -2 $S/snapshots/backup.log
# … GC 20260924T212201Z {"graceDays":15,"dryRun":false,"marked":0,…,"deleted":0,…,"storeFiles":12,"storeBytes":18726961}
# … OK 20260924T212201Z bytes=36400707 tasks=5016 events=20056 sha256=d2e2f918b9211ae9 dump_s=1 blobs=12 blob_bytes=18726961 new_blobs=12 refs_without_row=0 gc_deleted=0
```

What to look at: the `OK` line (a `FAIL` line says why, and alerts); `refs_without_row` (files whose
bytes are still in the database: run the backfill); the archive holds the encrypted dump, its
`.blobs` manifest and a `blobs/blobpack_<stamp>.tar.enc` of the new files.

### Monthly restore drill

```sh
# Ran on the chaos stack, 2026-09-24 21:22Z.
HAWA_BACKUP_ARCHIVE_DEST=$S/archive HAWA_BACKUP_ARCHIVE_KEYFILE=$S/passphrase HAWA_BACKUP_PG_CONTAINER=hawa-chaos-postgres-1 \
  HAWA_BACKUP_DB=hawa_chaos HAWA_BACKUP_NOTIFY_ENV=$S/no-such-env HAWA_DRILL_DIR=$S/drill \
  npx tsx scripts/load/with-chaos-db.ts bash infra/backup/restore_drill.sh
# ✓ restore drill: hawa_20260924T212201Z.dump.enc restored, 12 of 12 file rows checked, missing=0, in 3 s
docker exec hawa-chaos-postgres-1 psql -U hawa_owner -d hawa_chaos -Atc "SELECT * FROM hawa.backup_drills ORDER BY 1 DESC LIMIT 1"
# …|passed|{"dump": "hawa_20260924T212201Z.dump.enc", "missing": 0, "drill_type": "data_and_blobs", "rto_seconds": 3, "blobs_checked": 12, …}
```

`missing` must be 0. The drill drops its scratch database and directory at the end (checked: no
`hawa_drill_*` database was left on the chaos server).

### The collector and the store check by hand

`blob-gc` deletes files unreferenced for longer than the grace (15 days; under 7 is refused), and
only after a verified backup: the nightly backup runs it. Run it by hand only as a dry run:

```sh
# Ran on the chaos stack, 2026-09-24 21:22Z.
HAWA_BLOB_DIR=$S/blobs npx tsx scripts/load/with-chaos-db.ts node apps/core/dist/tools/blob-gc.js --dry-run
# {"graceDays":15,"dryRun":true,"marked":0,"cleared":0,"deleted":0,"unlinked":0,"orphans":0,"tmp":0,"bytesFreed":0,"storeFiles":12,"storeBytes":18726961}
npx tsx scripts/load/with-chaos-db.ts node apps/core/dist/tools/blob-verify.js --dir $S/blobs
# {"rows":12,"references":12,"checked":12,"missing":0,"corrupt":0,"referencedWithoutRow":0,"orphanFiles":0,"problems":[]}
```

After a restore for real, `blob-verify` must show `missing: 0` before anything is started
(`runbooks/10_backup_restore.md`, "Restoring for real").

## Per-file test databases

Every test file gets its own pair of databases, cloned from templates named after a hash of the
schema, RLS, seed, fixtures and migrations (`packages/db/src/test-template.ts`). Templates are built
once per schema change under an advisory lock (worktrees share the server); clones are dropped when
their file finishes, and clones older than 6 hours (a killed run) are pruned at the next run's start.
The connection guard refuses anything but the test server's per-file names, and production outright.

```sh
# Ran on the test server, 2026-09-24 21:24Z: the server and its two base databases (idempotent; it re-applies db/test-fixtures.sql to hawa_test).
pnpm test:db
# hawa_test already exists; versioned upgrades applied=0 verified=22. …
# ready: hawa_test, hawa_repair on hawa-test-postgres (127.0.0.1:55432)
```

```sh
# Ran on the test server, 2026-09-24 20:58Z: a file run clones its own databases.
HAWA_TEST_WORKERS=2 npx vitest run scripts/load/test/load-stats.test.ts
# [test databases] per-file clones of hawa_tpl_test_0b95675010215311 and hawa_tpl_repair_0b95675010215311 (25 ms)
```

```sh
# Ran on the test server, 2026-09-24 21:25Z: which template this checkout uses, and the clones alive now.
npx tsx -e "import('./packages/db/src/test-template.ts').then((m) => console.log(m.templateName('test', m.templateHash(process.cwd()))))"
# hawa_tpl_test_0b95675010215311
docker exec hawa-test-postgres psql -U hawa_owner -d postgres -Atc "SELECT datname FROM pg_database WHERE datname ~ '^hawa_(t|tr)_' ORDER BY 1"
# (nothing while no test file runs)
```

- The Mac also runs the office: keep `HAWA_TEST_WORKERS` at 2 and run the files you need.
- A template whose sources changed is rebuilt by the next run; old templates beyond the newest four are
  pruned. Several `hawa_tpl_*` names side by side are worktrees on different schemas, not a leak.
- `HAWA_TEST_SHARED_DB=1` puts every file back on the shared `hawa_test`/`hawa_repair`, only to
  reproduce something on them.

## The chaos suite

`packages/testkit/chaos` (its README lists every scenario): scripted requests through the whole stack
with Core, the worker, Postgres and Restate killed at named points, and the invariants checked after
each (one task, one revision, each message once, no paid call twice, nothing paused, no RT0016). It is
the acceptance test of every Phase 2 slice. One stack at a time on the machine; the runner always
starts from nothing and takes the project down with its volumes unless `--keep`.

```sh
# Ran on the chaos stack, 2026-09-24 21:23Z: a legacy request and a flagged-chat (Delivery workflow) request.
npx tsx packages/testkit/chaos/run.ts --only R1.0,L2.0
# Tests  2 passed | 33 skipped (35)      (72 s; peak memory 956 MiB)
# .run/last-run.json: R1.0 13 s, 14 of 14 invariants hold; L2.0 13 s, 18 of 18 invariants hold
```

```sh
# Ran on the chaos stack, 2026-09-24 21:23Z: take a kept project down (with its volumes and throwaway secrets).
npx tsx packages/testkit/chaos/run.ts --down
# hawa-chaos is down; its volumes and throwaway secrets are gone.
```

`--poller worker` runs the Phase 2.1 scenarios; `--keep` leaves the stack up for inspection (the
drills in this runbook ran on a stack the load test kept). Results: `packages/testkit/chaos/.run/last-run.json`.

The chaos compose file on `studio-v2` at 1c1316d named `HAWA_WORKER_TOKEN` twice in one mapping (the
merges of slices 2.1 and 2.2 each added it) and Docker Compose 5.5.1 refused to parse it, so no chaos
run could start; the duplicate was removed on 2026-09-25.

## The load test

`scripts/load/run.ts` (Phase 4, PLAN.md section 5): on a fresh chaos stack, 5,000 tasks seeded in the
Desk's tenant before Core starts, three Desk tabs (the Desk's own App, query cache, API client and
event stream in jsdom, one process each: `scripts/load/desk-tab.ts`), 3 idle minutes, then 10
Telegram chats sending a brief at the same moment while one tab pages 20 pages back and forth and
another opens ten tasks, then 2 more idle minutes. Results go to
`packages/testkit/chaos/.run/load-<poller>.json`.

```sh
# Ran on the chaos stack, 2026-09-24 21:02Z to 21:09Z and 21:09Z to 21:16Z.
npx tsx scripts/load/run.ts --poller core
npx tsx scripts/load/run.ts --poller worker --keep
```

Results (Mac with production running beside it; fakes answer every provider at once, so design times
exclude real model and Canva latency):

| Measure | Core polls | Worker polls (Phase 2.1) |
|---|---|---|
| Brief to first draft, 10 chats at once, p50 / p95 (fake Telegram clock, from pickup) | 11.5 s / 35.7 s | 11.3 s / 35.4 s |
| The same from the host, from sending the brief | 12.4 s / 36.8 s | 12.4 s / 36.8 s |
| Drafts shown | 10 of 10 | 10 of 10 |
| `GET /v1/tasks` per page at 5,000 tasks, p50 / p95 / max (client, through the fakes' proxy; n=56 and 55) | 15.9 / 66.9 / 97.4 ms | 14.0 / 49.1 / 67.0 ms |
| The same, Core's own handler time from its request log | 12.5 / 47.5 / 93 ms | 10 / 25.4 / 53 ms |
| Pressing Older or Newer until the page shows, p50 / p95 (n=40) | 52 / 53 ms | 52 / 54 ms |
| Requests per idle tab per minute: all / `GET /v1/tasks` | 38 / 0 | 38 / 0 |
| Memory before → peak during load (MiB): Core, worker, Postgres, Restate | 79→132, 47→61, 113→230, 606→636 | 83→127, 66→80, 122→229, 619→637 |
| Errors: failed tab requests, stream drops, Core or worker error lines, unmatched model calls, paused invocations, RT0016 | none | none |

A repeat with Core polling (21:26Z to 21:33Z) gave brief to draft p50 11.5 s, p95 35.7 s (10 of 10);
`GET /v1/tasks` p50 14.0, p95 54.3, max 69.6 ms (Core's handler: 10 / 23.7 / 52 ms); 38 requests
per idle tab per minute, 0 of them the list; Core 81→154 MiB, Postgres 120→213 MiB, Restate 601→629
MiB; no errors of any kind. In the first two runs each tab's only "console error" was Node's notice
that EventSource is experimental; the tabs now start with that notice turned off.

What the numbers say:

- **The list meets its target.** Every page read at 5,000 tasks, under load, stayed under 100 ms
  end to end (target: p95 ≤ 150 ms), and an idle tab reads the list **0** times a minute while the
  stream is up (target ≤ 2).
- **An idle tab still makes 38 requests a minute**: 36 of them are the Canva panel beside the selected
  task (`apps/desk/src/components/CanvaTaskPanel.tsx`, a 5 s `setInterval` reading
  `/tasks/:id/canva`, `/tasks/:id/canva/plans` and `/integrations/canva/status`), plus 2 health
  reads. Three idle tabs make about 114 requests a minute. The panel is not on the query cache or the
  event stream yet.
- **The draft tail is the planner's limit, not the poller.** Core plans at most two designs at a time
  for the whole office (`apps/core/src/services/canva-design-planner.ts`, `PLANNING_BUSY`, HTTP 429);
  the other workflows retry after 2, 4, 8 and 16 s, so ten briefs finish in pairs at about 5, 7, 11, 19
  and 35 s. The fakes plan instantly; with real model calls each pair takes longer and the tail grows
  with it. Which poller runs makes no measurable difference here (both hand ten briefs to intake within
  about 100 ms).
- **Restate is most of the memory** (about 610–650 MiB of the stack's ~1.1 GiB); Postgres doubles
  during the burst and falls back.
