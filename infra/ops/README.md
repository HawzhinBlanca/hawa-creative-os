# infra/ops

Scripts the owner runs on the office Mac. Each explains itself in its header.

| Script | What it does |
|---|---|
| `install_launch_agents.sh` | Installs the watchdog and the nightly backup as launch agents |
| `watchdog.sh` | Starts Docker and the stack at login, alerts the operator chat |
| `stack_containers.sh` | The watchdog's container checks: the six stack services by name, the worker, Vector |
| `disk_cleanup.sh` | Keeps dumps, Docker's build cache and container logs (30 days, 2 GB) bounded |
| `rotate_app_role.sh` | Rotates the application's database password without downtime (below) |
| `../../scripts/request_logs.ts` | Prints every log line of one request or task (below) |

## Logs of one request

Core and the worker write one JSON line per event (pino, `apps/*/src/logging.ts`, shared code in
`packages/observability/src/logging.ts`). Every line carries the context of the work it belongs to:
`requestId`, and `taskId`, `chatId`, `tenantId` once they are known. The request id is:

| Where the work started | Its request id |
|---|---|
| An HTTP request through nginx (the Desk, a webhook) | the caller's `X-Request-Id` when it is a plain token, else one nginx makes; nginx logs it as `rid=` and passes it to Core |
| A Telegram update the poller read | `tg-<update_id>`, the same for every retry of that update |
| A design the worker runs | the id of the request that queued it: Core stores it in the outbox command's `payload.requestId`, the worker sends it to Restate as `x-request-id`, the handler logs under it and sends it back to Core on every call |
| An outbox command written outside any request | `outbox-<command id>` |

Core returns it in the `x-request-id` response header, and a task event written inside a request
records its id in `task_events.trace_id` (Core's background loops, such as the Canva sweeper and the
draft reminders, run outside any request: their lines and events have none). Secrets never reach a line: any key named like a token, secret,
password, authorization, API key or cookie is replaced, and so are tokens in query strings, bot URLs,
bearer headers, database URLs, secret-named fields inside JSON strings, and a comparison judge's
link token (`/judge/<token>` is written `/judge/***`, as nginx writes it).

The `vector` service (`infra/docker/vector.yaml`) copies the logs of every `hawa-production`
container into `~/.hawa/logs/containers/<YYYY-MM-DD>/<service>.ndjson` (UTC days). The files outlive
the containers, so a deploy loses nothing. `disk_cleanup.sh` deletes days older than 30, nightly,
and then the oldest days until the rest fit in `HAWA_LOG_MAX_MB` (2048; Docker's own driver capped
each container at 250 MB, Vector caps nothing). Today's day is never deleted.

```bash
npx tsx scripts/request_logs.ts <requestId>               # one request: nginx, Core, worker, in time order
npx tsx scripts/request_logs.ts <taskId>                  # a task, and every request that touched it
npx tsx scripts/request_logs.ts <id> --since 2026-09-20   # read fewer days
npx tsx scripts/request_logs.ts <id> --json               # the stored lines, for jq
```

To find an id: the `x-request-id` header of a response, `trace_id` on the task's events, or
`tg-<update_id>`. Things to know:

- **Vector reads through the Docker socket**, mounted read-only, but the socket is the whole Docker
  API. The image is pinned by digest and the container has no network.
- **Lines written while Vector is down are not in the files.** It starts reading at the moment it
  starts; `docker logs` still has them until the container is replaced. The watchdog starts a
  stopped Vector with the rest of the stack and alerts while it is not running.
- **Log level** is `LOG_LEVEL` (default `info`; `debug` adds a line for every `/ready` and `/health`).

## Rotating the application's database password

### Why it works this way

Postgres keeps one password per role, so the password of the role Core and the worker log in as
cannot change while they still use the old one. Two login roles take turns instead:

- `hawa_app` is the **group**. Every grant (`db/03-grants.sql`, migrations 005–015), every table
  privilege the provisioners give and every `GRANT EXECUTE` names it. After the first rotation it is
  `NOLOGIN` with no stored password.
- `hawa_app_a` and `hawa_app_b` are the **login roles**. Each is an `INHERIT` member of `hawa_app` and
  holds nothing of its own. The services use one of them; the other is idle.
- A rotation gives the idle one a fresh password, moves the services to it, and retires the other.

Nothing else depends on the role name (checked 2026-09-24):

- Row-level security: all policies are `TO public` (0 name a role on the test database) and key on
  `hawa.current_tenant_id` / `hawa.current_user_id` settings, never on `current_user`.
- The application never runs `SET ROLE`; `packages/db/src/client.ts` sets `search_path`,
  `statement_timeout` and `idle_in_transaction_session_timeout` per connection, not per role.
- No `ALTER DEFAULT PRIVILEGES`; every table belongs to `hawa_owner`; no role-level settings or
  connection limit on `hawa_app` in the repository. The script copies any it finds on the server.
- Core and the worker read only `DATABASE_URL` (`apps/core/src/app.ts`, `apps/worker/src/index.ts`).
  `scripts/export_live_f04_proof.ts` and `scripts/populate_ledger.ts` read it from the running core
  container, so they follow automatically.
- Backups are `pg_dump --no-owner`; the grants in a dump name `hawa_app`, which exists on any server
  this repository initialises (`infra/docker/00-init-roles.sql` now also accepts a `DATABASE_URL` that
  names `hawa_app_a` or `hawa_app_b`: it creates `hawa_app NOLOGIN` and the login role inheriting it).
- `scripts/disaster_recovery_drill.sh` creates `hawa_app` (NOLOGIN) and uses `SET ROLE hawa_app`: unchanged.
- The test server (`pnpm test:db`) keeps a plain `hawa_app` login; tests may keep connecting as it.

The script (`packages/db/src/rotate-app-role.ts`, run by `rotate_app_role.sh`):

- takes the server explicitly (`--url`, which must not carry a password) and refuses the production
  server (port 54332, database `hawa`, host `postgres`) unless `--production` is given;
- reads the admin password from a key of an env file (`--password-env-file`, `--password-key`), never argv;
- generates a 43-character password, writes it only to `~/.hawa/db-roles/<db>-<role>-<time>.env`
  (directory 0700, file 0600) **before** changing the role, and sends Postgres only its SCRAM verifier;
- verifies the new role before anything moves to it: it logs in with the new password; its
  privileges on every table, column, sequence, function, schema and the database equal
  `hawa_app`'s; and in one shared snapshot, read-only, both roles see the same rows in every `hawa`
  table with no context, as three tenants, and as each tenant's administrator. A role that differs is
  set back to `NOLOGIN` and its file removed. Each context's counts are one statement a side, limited
  to 30 s for all the tables together (30 s a table before 2026-09-24); with no context the counts
  read every table in full, since RLS hides every row;
- refuses to give a password to a role that has open sessions, to start a third password while
  both login roles can log in, and to retire a role that has sessions or is the last that can log in.

### The owner's sequence (production)

From the repository root on the office Mac, with the stack running. Nothing is printed that holds a
password. Allow 10 minutes; the services are down only for the few seconds step 4 recreates them.

```bash
cd /Users/hawzhin/Hawdesign
CONN=(--url postgresql://hawa_owner@127.0.0.1:54332/hawa --production \
      --password-env-file infra/docker/.env --password-key POSTGRES_PASSWORD)

# 1. Where things stand. First time: hawa_app LOGIN with sessions; hawa_app_a and _b absent.
bash infra/ops/rotate_app_role.sh status "${CONN[@]}"

# 2. Create hawa_app_a with a fresh password and verify it. It prints the secret file's path
#    (~/.hawa/db-roles/hawa-hawa_app_a-<time>.env) and these same steps with real paths.
bash infra/ops/rotate_app_role.sh rotate "${CONN[@]}"

# 3. Point DATABASE_URL in infra/docker/.env at the new role. Only its user and password change;
#    the old file is kept as ~/.hawa/db-roles/env.<time>.bak (0600). Note that path for step 7.
bash infra/ops/rotate_app_role.sh install-env --secret-file ~/.hawa/db-roles/hawa-hawa_app_a-<time>.env \
     --env-file infra/docker/.env

# 4. Recreate core and the worker with the images they run now. First make sure no design is in
#    flight (a replaced worker replays running invocations): the count must be 0.
docker exec hawa-production-worker-1 node -e "fetch('http://restate:9070/query',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({query:\"SELECT count(*) AS n FROM sys_invocation WHERE status <> 'completed'\"})}).then(r=>r.text()).then(console.log)"
cd infra/docker
export HAWA_BUILD_COMMIT="$(docker inspect hawa-production-core-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^HAWA_BUILD_COMMIT=//p')"
docker compose -f docker-compose.prod.yml -f canva-release.override.yml --env-file .env \
  up -d --no-deps --no-build --force-recreate core worker   # after blue/green (0.1): every worker service
cd ../..

# 5. Confirm: hawa_app has 0 sessions and hawa_app_a has some; core is healthy (its /health reaches
#    the database). Repeat status until hawa_app shows 0.
bash infra/ops/rotate_app_role.sh status "${CONN[@]}"
docker inspect --format '{{.State.Health.Status}}' hawa-production-core-1

# 6. Retire hawa_app: NOLOGIN, stored password removed. Refused while anything still connects as it.
bash infra/ops/rotate_app_role.sh retire --role hawa_app "${CONN[@]}"

# 7. Prove the leaked password is dead, using the backup from step 3. Expect
#    "refused (28P01): password authentication failed for user "hawa_app"" (exit 0; exit 3 means accepted).
bash infra/ops/rotate_app_role.sh check-login --url postgresql://127.0.0.1:54332/hawa --production \
     --credentials-env-file ~/.hawa/db-roles/env.<time>.bak --credentials-key DATABASE_URL
```

Later rotations are the same commands: `rotate` picks `hawa_app_b` (then `a`, and so on), and step 6
retires the previous login role instead (`--role hawa_app_a`). `hawa_app` stays NOLOGIN.

**If step 4 goes wrong** (core unhealthy, the worker cannot connect): `hawa_app` still logs in until
step 6, so put the backup back and recreate again:
`cp ~/.hawa/db-roles/env.<time>.bak infra/docker/.env`, then the `docker compose … up` of step 4.
After step 6 the way back is another `rotate`.

**Afterwards:** delete the `.bak` of step 3 once step 7 passed (it holds the dead password), and keep
the secret file of the live role or delete it (the password is also in `infra/docker/.env`).

### Risks and things to know

- **postgres is recreated by the next deploy.** Compose passes `DATABASE_URL` to the postgres service
  as `HAWA_APP_DATABASE_URL` (used only by `00-init-roles.sql` on an empty data directory). Step 4
  leaves postgres alone with `--no-deps`, but the next `deploy.sh` sees the changed value and recreates
  the postgres container once, on the same volume: a restart of a few seconds during that deploy. The
  standing post-deploy check of the volume's creation time still applies.
- **Replacing the worker replays in-flight work.** Same code (`--no-build`), so no journal mismatch,
  but do step 4 only when the in-flight count is 0.
- **Core's in-memory state** is lost on any recreate, as on every deploy.
- **`.env.production` may carry its own `DATABASE_URL` line.** Compose's `environment:` overrides it,
  so it is not used; if it exists it still holds the old password (dead after step 6). Check with
  `grep -c '^DATABASE_URL=' infra/docker/.env.production`; remove the line or update it with
  `install-env --env-file infra/docker/.env.production`.
- **pg_hba.** The postgres image's default rule admits every user with SCRAM. The script warns when a
  rule names `hawa_app` but not the new role, and its login check fails the rotation if it is refused.
- **Other programs that log in as `hawa_app`** (a hand-run script with an old URL) show up as sessions
  in `status` and block `retire`. That is intended: find them first.
- **Local copies of the leaked literal** (checkpoint refs of another tool, pre-rotation backups) stop
  mattering once step 7 reports refused.

## Google Drive delivery

Approved designs are archived to Google Drive and mirrored to a Sheet by Core
(`packages/integrations/src/google-publisher.ts`). Without a key every delivery reports
`CREDENTIALS_MISSING`: the requester still gets the file in Telegram, and nothing reaches Drive.

What the owner supplies (names only; no value belongs in the repository):

1. **A service account key** in `infra/docker/.env.production` (read by core and the worker through
   `env_file`), as one of:
   - `GOOGLE_SERVICE_ACCOUNT_KEY` = the whole JSON key file on one line (the form Google issues; its
     `client_email` is used). This is the placeholder `REPLACE_WITH_SERVICE_ACCOUNT_JSON_ON_ONE_LINE`
     in `.env.production.example`; `deploy.sh` refuses to deploy while any `REPLACE_WITH` value remains.
   - or `GOOGLE_SERVICE_ACCOUNT_KEY` = only the PEM private key, plus `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
   - `GOOGLE_APPLICATION_CREDENTIALS` (a path to the key file) also works in code, but the compose file
     mounts no such file into the containers, so it cannot be used in production as is.
   - `GOOGLE_OAUTH_TOKEN` overrides all of these with a short-lived bearer token; never set it in production.
   One way to write the JSON on one line without showing it:
   `python3 -c 'import json,sys; print("GOOGLE_SERVICE_ACCOUNT_KEY=" + json.dumps(json.load(open(sys.argv[1])), separators=(",", ":")))' ~/Downloads/<key>.json >> infra/docker/.env.production`
   (check first that the file has no `GOOGLE_SERVICE_ACCOUNT_KEY` line already; `deploy.sh` refuses duplicates only for some keys).
2. **Access in Google.** In the Google Cloud project of that service account, the Drive API and the
   Sheets API enabled. The service account's email (`client_email`) added to the client's Shared Drive
   as Content manager, and as editor of the reporting spreadsheet. Core asks for the `drive` and
   `spreadsheets` scopes and uses `supportsAllDrives`.
3. **Where each client's files go** is not in an env file: it is the client's DNA in Postgres
   (`client_dna_versions.dna.destinations`): `productionFolderId` (required, the Drive folder id),
   `spreadsheetId` (optional; without it no Sheet row, reported as unsynced) and `googleSharedDriveId`.
   Delivery is refused when `productionFolderId` is missing. `GOOGLE_SHARED_DRIVE_ID` and
   `GOOGLE_SPREADSHEET_ID` in `.env.production.example` are read by no code.

Then recreate core and the worker (step 4 above, which picks up a changed `.env.production`), approve
a real request in the Desk, and check the file in the Drive folder. `GET /v1/integrations/health`
reports `google_drive: healthy` as soon as the variable is set; it does not test the key, so only a
real delivery proves it.
