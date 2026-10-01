# Runbook 20: Operating the new architecture

*Architecture programme Phase 4 (output/plans/2026-09-24-architecture-programme/PLAN.md). Written
2026-09-25 against `studio-v2` at 1c1316d; carried to `codex/research-grade-design-system`, the
mainline since the owner's decision of 2026-09-28, under ADR-127.*

This runbook covers what changed with the programme: two worker colours and their drains, Restate
invocations that wait for a person, the Phase 2 flags, one request's logs, the file store, the test
databases, the chaos suite and the load test. Background: `infra/docker/README.md` (blue/green, the
poller), `runbooks/10_backup_restore.md` (backups, authoritative for this branch's Restate and
PostgreSQL recovery), ADR-034 to ADR-037, and this branch's lifecycle ADRs from ADR-052 and ADR-059 on.

## How to read the commands

**Every command block below was run by its author on the chaos stack or on the test server, never on
production.** The first line of each block says which, when, and on which branch. Most blocks were run
on studio-v2's chaos stack before the two branches' lifecycle work was reconciled; those say **not
re-run on this branch**, and their output is studio-v2's. Blocks run again on
`codex/research-grade-design-system` say so. A test (`scripts/load/test/runbook.test.ts`) fails if a
block does not say both, or names production's containers, port or database.

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
(`infra/docker/README.md` has the why). `deploy.sh --apply` does all of it; by hand it is below.
`scripts/restate-bluegreen.ts` is the same on both branches (`plan`, `register`, `removable`,
`finish-drains`).

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:16Z; not re-run on this branch): where would a deploy go?
npx tsx scripts/restate-bluegreen.ts plan --admin http://127.0.0.1:56070
# live=blue
# live_deployment=dp_13aB1bFnHcXzMrinxtpHKc9
# idle=green
# live_stuck=
```

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:16Z; not re-run on this branch): start the idle colour, register it, try to finish the drain.
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
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:16Z; not re-run on this branch): what keeps blue from draining.
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
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:17Z; not re-run on this branch): finish the drain, then remove the drained colour's container.
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
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:17Z; not re-run on this branch).
docker exec hawa-chaos-worker-green-1 node -e "fetch('http://localhost:9080/health').then(r=>r.json()).then(j=>console.log(JSON.stringify({colour:j.colour,background:j.background,telegramPoller:j.telegramPoller})))"
# {"colour":"green","background":"taking_over","telegramPoller":{"mode":"on","background":"live","offset":90284190566,…}}
```

## Paused and backing-off invocations

**How you learn of them.** Core's `/v1/health` reports `restateInvocations` (`paused`, `backingOff`,
`inbox`; cached 10 s) and `dependencies.restatePausedInvocations`; on this branch both are in
`apps/core/src/app.ts`. Any paused invocation makes health `degraded`, and the watchdog alerts on it.
The drill paused the invocation above (as Restate does when its retries run out, after about an hour)
and read health:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:16Z; not re-run on this branch): pause (drill only), then read what the office's health shows.
curl -s -o /dev/null -w "pause HTTP %{http_code}\n" -X PATCH http://127.0.0.1:56070/invocations/inv_1eC7FuOzjLTO4txeTfIUpz4yOrcPlZbjxE/pause
# pause HTTP 202
docker start hawa-chaos-core-1        # the cause fixed (Core had been stopped for the drain drill)
curl -s http://127.0.0.1:56090/__core/v1/health | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'], d['restateInvocations'], d['dependencies'].get('restatePausedInvocations'))"
# degraded {'status': 'ok', 'paused': 1, 'backingOff': 0, 'inbox': 0, …} 1
```

**Which ones, and why.** `last_failure` carries the error the handler threw:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:16Z; not re-run on this branch).
curl -s http://127.0.0.1:56070/query -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"query\":\"SELECT id, target, status, retry_count, last_failure, pinned_deployment_id FROM sys_invocation WHERE status IN ('paused', 'backing-off')\"}"
# … "status":"backing-off","last_failure":"[500 Internal] Core is unreachable, update 90284190566 waits: fetch failed …"
```

**Resume** once the cause is fixed. A paused invocation continues from its journal; a backing-off one
retries at once instead of at `next_retry_at`. It resumes on the deployment it is pinned to (the
admin API can move it with `?deployment=`, which replays its journal on that build: only for the same
code, never across a change of handlers):

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:17Z; not re-run on this branch).
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
On this branch a `RequestLifecycle` object (one per request) holds the request's stage: cancelling one
of its invocations can leave the request waiting for an event that will not come. Read its state with
the object's `get` handler before and after, and prefer fixing the cause and resuming.

## Phase 2 flags per chat, and rolling back

This section describes `codex/research-grade-design-system`'s own lifecycle (ADR-034, ADR-052,
ADR-059 and the admissions after it), which replaced studio-v2's, as ADR-135 left it on 2026-09-28:
**every Telegram chat is owned by `RequestLifecycle`**, and no setting can send a new request down the
old path. studio-v2 read `HAWA_LIFECYCLE_CHATS` when Deliver was pressed; this branch does not read it
at all any more.

| Flag | Read by | Values | Where it is set in production |
|---|---|---|---|
| `HAWA_TELEGRAM_POLLER` | the worker, at start (Core only logs a value other than `worker`) | `worker`; `deploy.sh` refuses anything else | `infra/docker/.env` (compose interpolation, default `worker`), then deploy |
| `HAWA_LIFECYCLE_CHATS` | nobody since ADR-135 (Core logs that it is set and ignored) | remove it | was `infra/docker/.env.production` |
| `HAWA_WORKER_TOKEN` | Core (`/v1/internal/*`) and every worker colour | a long random value of its own (`openssl rand -hex 32`) | `infra/docker/.env.production`, then deploy |

Each is read from the process environment, which a container gets when it starts: a change takes a
restart of Core and the worker, which in production is a deploy.

**What happens to a Telegram update.** Only the worker's poller reaches `ChatInbox`. A new brief (no
waiting request, or an explicit `/new`) makes Core prepare a versioned new-brief draft under the
update's identity and answer `open-request`; `ChatInbox` then sends one keyed `RequestLifecycle.open`,
and the request object alone creates and owns the task (ADR-059). Such a task is pinned to the Restate
executor when it is created (`delivery_executor_pin = 'restate'`); the pin never changes afterwards
(ADR-052; only a committed lifecycle open may claim Restate, `apps/core/src/services/chat-intake.ts`).
Media and PDF sources have their own admissions (ADR-061, ADR-068, ADR-069, ADR-071).

There is no old intake any more (ADR-135 stage 2, 2026-09-29). A press of a button under one of its
messages, or a reply to one, is answered as a stale reply ("That design is no longer waiting for
changes…") and changes nothing. Greetings, questions, thanks, standing rules, `/status`, `/rules`,
`/forget`, `/start`, `/help` and a chat `/approve` are answered by Core's intake
(`apps/core/src/services/lifecycle-chat-answers.ts`) and sent by `ChatInbox`. Old tasks keep
`delivery_executor_pin = 'core'` and stay readable in the Desk; Core refuses to deliver one that came
from a Telegram chat (`409 LEGACY_TELEGRAM_DELIVERY_RETIRED`): cancel it, and ask the requester to send
it again.

`GET /v1/operations/legacy-path` (administrators) stays as a standing check: open legacy Telegram
tasks, Core requester sends still queued, legacy Delivery workflow runs in flight, and the newest legacy
task should all stay 0 (or unchanged), with `stage2Ready: true`. Anything else means an old row was
reopened by hand; the removed code will not finish it.

Once a chat's first lifecycle request opens, `ChatInbox` keeps that chat in lifecycle mode for good
(`apps/worker/src/lifecycle/chat-inbox.ts`, `setMode`): replies to a request's notices keep reaching
that request. A request-owned task is delivered through its request: the Desk's Deliver needs an office
reviewer and a UUID `Idempotency-Key` (`apps/core/src/routes/delivery.routes.ts`), and the older
omnichannel publisher answers `409 LIFECYCLE_OWNED`.

### The poller: rolling back

The worker polls only if `HAWA_TELEGRAM_POLLER=worker` **and** it has `HAWA_WORKER_TOKEN`. Core does
not poll, whatever the variable says (ADR-135): its poller fed only the old intake, so a rollback to it
would start requests on the old path, which the owner ruled out on 2026-09-28. `deploy.sh` refuses a
value other than `worker` before it changes anything. "Poll now" and webhook registration are gone
(stage 2 of ADR-135); before that they answered 409.

Rolling back a broken worker poller therefore means rolling back the worker: the previous colour stays
registered until the new one is (blue/green above; `register` refuses a build that does not host every
routed service, ADR-129), and a bad release is replaced by deploying the previous one. Both pollers
keep the offset in the same Postgres row, so the colour that takes over carries on where the other
stopped. The watchdog alerts when no worker colour polls (Core's `/v1/health` always names the worker).

Rolling back to a release from before ADR-135 is deploying that release's checkout as any release,
with `HAWA_TELEGRAM_POLLER=worker` and `HAWA_LIFECYCLE_CHATS=*` left in place (those builds still read
the chat list; empty would send older chats' new briefs to the old intake). Requests in flight stay
with their owner: a delivery or design running on the newer colour finishes there before the drain
deletes it, the Desk approves and delivers the rest, and requesters' replies keep reaching their
requests through `ChatInbox`. Drilled on the chaos stack as `R10.K1` (`npx tsx
packages/testkit/chaos/run.ts --only R10.H1,R10.K1,R10.K2`, which builds the previous release's images
from its commit); not run on production. ADR-136's Core-poller rollback, which forwarded lifecycle chats
from Core's poller to `ChatInbox`, went with Core's poller (ADR-135).

### The worker token: rotating, and a half-done rotation

Rotate by giving Core and every worker colour the same new value and restarting them together:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:18Z; not re-run on this branch): rotate the token (generated inline, never printed) and switch to the worker poller.
CHAOS_WORKER_TOKEN=$(openssl rand -hex 24) CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml --env-file packages/testkit/chaos/.run/chaos.env \
  up -d --no-build --no-deps --wait core worker-green
curl -s http://127.0.0.1:56090/__core/v1/adapters/telegram/status | python3 -c "import json,sys; print('core says poller =', json.load(sys.stdin)['poller'])"
# core says poller = worker
```

**Symptom of a token on one side only** (the drill restarted Core alone with a new value): nothing is
lost, but every update waits. `ChatInbox` invocations back off with a 401:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:18Z; not re-run on this branch): Core alone gets a new token, then a brief arrives (chat 9500004).
CHAOS_WORKER_TOKEN=$(openssl rand -hex 24) CHAOS_TELEGRAM_POLLER=worker docker compose -p hawa-chaos \
  -f packages/testkit/chaos/docker-compose.chaos.yml --env-file packages/testkit/chaos/.run/chaos.env \
  up -d --no-build --no-deps --wait core
curl -s http://127.0.0.1:56070/query -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"query\":\"SELECT id, status, retry_count, last_failure FROM sys_invocation WHERE target LIKE 'ChatInbox/9500004/%'\"}"
# … "status":"backing-off", "last_failure":"[500 Internal] Core refused the worker's intake call with HTTP 401 (Authentication Required); update 90284190569 waits until this deployment is fixed …"
```

The fix is to give both the same value and restart both (the rotation block above). The waiting
invocation then finishes on its next retry, or at once with a resume. On this branch the
`RequestLifecycle`, `Delivery` and design-proof calls to Core's `/v1/internal/*` use the same token and
wait the same way. Rolling back a token is the same operation with the old value. Recreating only
Core also gives it whatever worker token that compose invocation carries: restart Core and the workers
together, from one environment.

### The lifecycle chats: no enrolment any more

`HAWA_LIFECYCLE_CHATS` enrolled chats one by one until ADR-135 (2026-09-28); since then every chat is
enrolled and the variable is ignored. There is nothing to roll back per chat: a chat cannot be sent
back to the old intake. Requests already open keep their owner, their pin and their delivery
executor (ADR-052); a delivery already started keeps its recorded executor.

The evidence is the lifecycle intake, projection and delivery tests
(`apps/core/test/lifecycle-internal-intake.test.ts`, `apps/core/test/lifecycle-only-telegram.test.ts`,
`apps/core/test/delivery-workflow.test.ts`, `apps/core/test/chat-intake-flag-scoping.test.ts`) and the
chaos suite, whose scenarios all run through the lifecycle path since ADR-135.
The chaos scenarios `R10.H1` (requests made on the previous release while Core polled, continued after
this release's deploy), `R10.K1` (this release rolled back to the previous one and forward) and
`R10.K2` (the chat list emptied on this release changes nothing) drill it as deploys.

## Reading one request's logs

`scripts/request_logs.ts <requestId | taskId>` prints every line of one request across Core, the
worker and nginx, from the daily files Vector writes (`~/.hawa/logs/containers/<day>/<service>.ndjson`),
so it also finds lines of containers a deploy has replaced. Where the id comes from: the
`x-request-id` response header, `tg-<update_id>` for a Telegram update, a task id.

The chaos stack runs no Vector, so the drill exported its containers' logs into Vector's layout
first (`scripts/load/export-chaos-logs.ts`), then read them:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:20Z; not re-run on this branch).
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
  # Ran on the chaos stack (studio-v2 at 50b3a94a, 2026-09-28 13:51Z; not re-run on this branch).
  npx tsx scripts/load/export-chaos-logs.ts $S/chaos-logs
  npx tsx scripts/request_logs.ts 399c154a-fef8-4182-a9d1-a2a1a2141780 --dir $S/chaos-logs
  # … worker-blue  [restate][2026-09-28T10:44:54.595Z][TaskWorkflow/task-wf-399c154a-…/run][inv_1jQLgVMhRi8800zKle1fGXCpKb7JarQsHN] INFO: Starting invocation.
  # 35 line(s) for 399c154a-fef8-4182-a9d1-a2a1a2141780 in 5 file(s): core, worker-blue
  #   (before the fix: 13 line(s) … : core)
  ```

  Restate's own log records span several lines (the error, then `restate.invocation.id`,
  `restate.invocation.target`, …), and each is stored as its own line: the `target` line is found by
  the task id, the error text above it is not. Read Restate's lines around that time for the rest.

  For a lifecycle request on this branch, also search by its request id: the `RequestLifecycle` object
  is keyed by it.

- **`docker logs` goes with its container.** Core had been recreated four times in the drills and its
  export held 15 lines: the first delivery's Core lines were gone. That is why production keeps
  Vector's files; `docker logs` alone is not enough after a deploy.

## The file store

Files live content-addressed under `~/.hawa/blobs` (ADR-035); `hawa.blobs` rows name them and
`hawa.blob_references` lists every reference (on this branch it also covers the lifecycle photo,
album and source uploads, client documents, retained studio results and pinned visual inputs). Three
jobs keep it safe, all described in `runbooks/10_backup_restore.md`: the nightly backup (dump, then
the files the dump references, the paired Restate archive when enabled, then the garbage collector),
the monthly restore drill, and a restore for real. The drill ran each one against the chaos database
and a scratch store, with the same scripts the launch agents run, pointed elsewhere through their
environment; `HAWA_BACKUP_NOTIFY_ENV` names a file that does not exist, so no alert can be sent.

Bytes still in the database (written before the store) are copied out by the backfill. The chaos
stack's twelve plan sources (PPTX) were:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:21Z; not re-run on this branch). S/blobs holds sha256/, tmp/ and the marker .hawa-blob-store ("sha256-v1").
HAWA_BLOB_DIR=$S/blobs npx tsx scripts/load/with-chaos-db.ts npx tsx scripts/blob_backfill.ts --phase plan_sources --mode copy
# {"database":"hawa_chaos","mode":"copy",…,"reports":[{"phase":"plan_sources","scanned":12,"stored":12,…,"problems":[]}],"log":"/Users/…/.hawa/logs/blob_backfill_2026-09-24T21-21-26-892Z.ndjson"}
```

Without `--log <file>` the backfill writes its log into `~/.hawa/logs`, the office's own log
directory, even for the chaos database; the author moved that file out afterwards. Give `--log` when
rehearsing. The backfill's exit status: 0 done and clean, 1 done with problems to read, 3 stopped
with rows left (run it again), 2 refused. `--mode verify` counts the rows release B's foreign keys
would reject (`blocksForeignKey`), which are staged in
`output/plans/2026-09-24-architecture-programme/staged/blob_fks.sql`.

### Nightly backup

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:22Z; not re-run on this branch).
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
`.blobs` manifest and a `blobs/blobpack_<stamp>.tar.enc` of the new files. On this branch the `OK`
line also carries `restate=<off|paired_archive>` before `gc_deleted` (ADR-055), the whole night holds
the archive lock (ADR-081), and a Restate backup cut off by a kill is put back by the watchdog
(ADR-127).

### Monthly restore drill

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:22Z; not re-run on this branch).
HAWA_BACKUP_ARCHIVE_DEST=$S/archive HAWA_BACKUP_ARCHIVE_KEYFILE=$S/passphrase HAWA_BACKUP_PG_CONTAINER=hawa-chaos-postgres-1 \
  HAWA_BACKUP_DB=hawa_chaos HAWA_BACKUP_NOTIFY_ENV=$S/no-such-env HAWA_DRILL_DIR=$S/drill \
  npx tsx scripts/load/with-chaos-db.ts bash infra/backup/restore_drill.sh
# ✓ restore drill: hawa_20260924T212201Z.dump.enc restored, 12 of 12 file rows checked, missing=0, in 3 s
docker exec hawa-chaos-postgres-1 psql -U hawa_owner -d hawa_chaos -Atc "SELECT * FROM hawa.backup_drills ORDER BY 1 DESC LIMIT 1"
# …|passed|{"dump": "hawa_20260924T212201Z.dump.enc", "missing": 0, "drill_type": "data_and_blobs", "rto_seconds": 3, "blobs_checked": 12, …}
```

`missing` must be 0. The drill drops its scratch database and directory at the end (checked: no
`hawa_drill_*` database was left on the chaos server). On this branch the drill also verifies the
paired Restate archive when the Restate backup is enabled (ADR-055 to ADR-057).

### The collector and the store check by hand

`blob-gc` deletes files unreferenced for longer than the grace (15 days; under 7 is refused), and
only after a verified backup: the nightly backup runs it. Run it by hand only as a dry run:

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:22Z; not re-run on this branch).
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
# Ran on the test server (studio-v2 at 1c1316d, 2026-09-24 21:24Z; not re-run on this branch, whose server other worktrees' agents were using): the server and its two base databases (idempotent; it re-applies db/test-fixtures.sql to hawa_test).
pnpm test:db
# hawa_test already exists; versioned upgrades applied=0 verified=22. …
# ready: hawa_test, hawa_repair on hawa-test-postgres (127.0.0.1:55432)
```

```sh
# Ran on the test server on codex/research-grade-design-system, 2026-09-28 08:03Z: a file run clones its own databases.
HAWA_TEST_WORKERS=2 npx vitest run scripts/load/test/load-stats.test.ts
# [test databases] per-file clones of hawa_tpl_test_92dd954bd4e8519e and hawa_tpl_repair_92dd954bd4e8519e (31 ms)
```

```sh
# Ran on the test server on codex/research-grade-design-system, 2026-09-28 08:03Z: which template this checkout uses, and the clones alive now.
npx tsx -e "import('./packages/db/src/test-template.ts').then((m) => console.log(m.templateName('test', m.templateHash(process.cwd()))))"
# hawa_tpl_test_92dd954bd4e8519e
docker exec hawa-test-postgres psql -U hawa_owner -d postgres -Atc "SELECT count(*) FILTER (WHERE datname ~ '^hawa_(t|tr)_') AS clones, count(*) FILTER (WHERE datname ~ '^hawa_tpl_') AS templates FROM pg_database"
# 2|8        (two clones of other worktrees' running files; eight templates of several worktrees' schemas)
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
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:23Z; not re-run on this branch): a legacy request and a flagged-chat (Delivery workflow) request.
npx tsx packages/testkit/chaos/run.ts --only R1.0,L2.0
# Tests  2 passed | 33 skipped (35)      (72 s; peak memory 956 MiB)
# .run/last-run.json: R1.0 13 s, 14 of 14 invariants hold; L2.0 13 s, 18 of 18 invariants hold
```

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:23Z; not re-run on this branch): take a kept project down (with its volumes and throwaway secrets).
npx tsx packages/testkit/chaos/run.ts --down
# hawa-chaos is down; its volumes and throwaway secrets are gone.
```

`--poller worker` runs the Phase 2.1 scenarios; `--keep` leaves the stack up for inspection (the
drills in this runbook ran on a stack the load test kept). Results: `packages/testkit/chaos/.run/last-run.json`.
This branch's suite has more scenarios than studio-v2's (its README: the isolated candidate rehearsal,
coordinated recovery, PDF sources, confirmed albums); run the ones for the slice you change.

studio-v2's compose file at 1c1316d named `HAWA_WORKER_TOKEN` twice in one mapping, which Docker Compose
5.5.1 refused. This branch's compose file does not: a duplicate-key YAML load of
`packages/testkit/chaos/docker-compose.chaos.yml` finds none (checked 2026-09-28; the same check finds
the duplicate in studio-v2's file at 1c1316d).

## The load test

`scripts/load/run.ts` (Phase 4, PLAN.md section 5): on a fresh chaos stack, 5,000 tasks seeded in the
Desk's tenant before Core starts, three Desk tabs (the Desk's own App, query cache, API client and
event stream in jsdom, one process each: `scripts/load/desk-tab.ts`), 3 idle minutes, then 10
Telegram chats sending a brief at the same moment while one tab pages 20 pages back and forth and
another opens ten tasks, then 2 more idle minutes. Results go to
`packages/testkit/chaos/.run/load-<poller>.json`. The chats (9400001 onwards) are not enrolled, so
their requests take the legacy path on both branches.

```sh
# Ran on the chaos stack (studio-v2 at 1c1316d, 2026-09-24 21:02Z to 21:09Z and 21:09Z to 21:16Z; not re-run on this branch).
npx tsx scripts/load/run.ts --poller core
npx tsx scripts/load/run.ts --poller worker --keep
```

On this branch the seeded rows were written into a per-file test clone of its schema
(`scripts/load/test/seed-desk-tasks.test.ts`), which shows they still fit its tables; the load test
itself has not been run here.

Results on studio-v2 (Mac with production running beside it; fakes answer every provider at once, so
design times exclude real model and Canva latency):

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

- **The list met its target.** Every page read at 5,000 tasks, under load, stayed under 100 ms
  end to end (target: p95 ≤ 150 ms), and an idle tab read the list **0** times a minute while the
  stream was up (target ≤ 2).
- **An idle tab still made 38 requests a minute**: 36 of them were the Canva panel beside the
  selected task (`apps/desk/src/components/CanvaTaskPanel.tsx`, a 5 s `setInterval` reading
  `/tasks/:id/canva`, `/tasks/:id/canva/plans` and `/integrations/canva/status`), plus 2 health
  reads. The panel now polls every 5 s only while Canva or the planner is working and otherwise once
  a minute, and refreshes on the task's live event (studio-v2 ecc9af71, ported to this branch); the
  new rate has not been measured with the load test.
- **The draft tail was the planner's limit, not the poller** (as measured on 2026-09-24; ADR-131
  changed both halves, see "Planning slots and plan time" below). Core planned at most two designs at a
  time for the whole office (`apps/core/src/services/canva-design-planner.ts`, `PLANNING_BUSY`, HTTP
  429); the other workflows retried after 2, 4, 8 and 16 s, so ten briefs finished in pairs at about
  5, 7, 11, 19 and 35 s. The fakes plan instantly; with real model calls each pair takes longer and
  the tail grows with it. Which poller runs made no measurable difference (both handed ten briefs to
  intake within about 100 ms).
- **Restate was most of the memory** (about 610–650 MiB of the stack's ~1.1 GiB); Postgres doubled
  during the burst and fell back.

### Planning slots and plan time (ADR-131)

The fakes plan instantly, which hides how long a draft waits for a planning slot. `--plan-ms` makes
every planner call take that long in the fakes (real calls took 23–47 s), and `--planning-slots` sets
Core's `HAWA_CANVA_PLANNING_SLOTS` (left out, Core's default of 4). The result file's name carries
both: `load-core-plan30000-slots2.json`.

```sh
# Ran on the chaos stack (ADR-131 port on codex/research-grade-design-system's line, claude/mainline c2eb23a4, 2026-09-28 13:47Z to 14:02Z).
npx tsx scripts/load/run.ts --poller core
npx tsx scripts/load/run.ts --poller core --plan-ms 30000
```

Brief to first draft, 10 chats at once, from pickup (10 of 10 drafts, no errors, in every run). The
"before" rows and the 2- and 5-slot rows are studio-v2's (2026-09-28); they were not re-run here.

| Code | Plan call | Slots | p50 / p95 | Drafts shown at (s) |
|---|---|---|---|---|
| before ADR-131 (studio-v2) | instant | 2 | 11.2 / 35.4 s | 5, 7, 11, 19, 35 (pairs) |
| after, this line | instant | 4 | 8.1 / 9.4 s | 6.5, 6.6 ×3, 8.0–8.7 ×5, 10.1 |
| before ADR-131 (studio-v2) | 30 s | 2 | 125.4 / 245.6 s | 35, 65, 125, 185, 246 (pairs) |
| after (studio-v2) | 30 s | 2 | 97.6 / 161.9 s | 35, 65, 98, 130, 162 (pairs) |
| after, this line | 30 s | 4 | 65.4 / 97.4 s | 34.9–35.0 ×4, 65.4 ×4, 97.4 ×2 |
| after (studio-v2) | 30 s | 5 | 50.5 / 65.8 s | 35.1 ×5, 65.8 ×5 |

- **The planning step no longer doubles its sleep.** Core answers a brief beyond the slots with
  429 `PLANNING_BUSY` and `Retry-After` (until the oldest running plan should finish, 2–15 s), and the
  workflow waits exactly that, journalled, for up to 15 minutes, on the legacy TaskWorkflow and on a
  RequestLifecycle DesignRun alike. Before, Restate's step retry waited 2, 4, 8, 16 and then 30 s.
- **Why 4 slots and not more:** every draft is imported and exported through the office's one Canva
  connection, and Canva allows 20 exports a minute per user. A draft makes two, so 4 slots keep a
  ten-brief burst to at most 16 exports in a minute, and 5 put all 20 into one.
- **A plan left in `planning` by a Core that died mid-call** stops holding a slot after 3 minutes.
  Nothing else about it changes: its paid call stays unresolved and its task is not planned again
  until an operator reconciles it (ADR-101).
- **A refused brief costs nothing:** no plan row, no admitted call, no allowance reserved.

### Scoped live updates (ADR223, 1 October 2026)

Live updates use the same current PostgreSQL task/client access as ordinary reads.
A designer can have several assigned clients; the stream honors new grants and
withdrawals without reconnecting. Shared trusted-office access keeps its existing
office-wide operator identity. A named credential retains its own permissions.

The stream sends no resource payload when its current scope cannot be verified.
It closes on an authorization/read/write error or 64 pending events. Desk asks
for a fresh one-use ticket on reconnect and uses its existing polling fallback
while the stream is unavailable. Closing one subscription does not cancel a task
or change a committed approval/publication. Same-instance sign-out is checked
before the next event; other-instance session revocation retains the existing
60-second refresh cache and 15-second heartbeat policy. Client/tenant memberships
are never cached by the event disclosure check.

Connected reproduction and exact candidate evidence:
`plans/content-aware-design-2026-09-30/W6_STREAM_ISOLATION_PROOF.json`.
