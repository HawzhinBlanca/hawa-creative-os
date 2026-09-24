# Chaos suite

The acceptance test of every Phase 2 slice (architecture programme `PLAN.md` Phase 2, design in
`PHASE2_DESIGN.md` section 6): scripted requests through the whole stack, with Core, the worker,
Postgres and Restate killed at named points, and the invariants of section 6.3 checked after each
request. Today it drives the **legacy path** (Core intake → outbox → `TaskWorkflow` in the blue
worker → Canva → outcome → Desk approval → delivery). The same scenarios are meant to run against
the Restate lifecycle once its slices land.

## Run it

```sh
pnpm install --offline && pnpm build     # the driver imports packages/db and scripts from source
npx tsx packages/testkit/chaos/run.ts                  # every scenario, then tear the project down
npx tsx packages/testkit/chaos/run.ts --only R1.0,R4   # some scenarios
npx tsx packages/testkit/chaos/run.ts --keep           # leave hawa-chaos running to inspect it
npx tsx packages/testkit/chaos/run.ts --down           # take a kept project down, with its volumes
```

`run.ts` sets `HAWA_CHAOS=1` (and `HAWA_CHAOS_KEEP`, `HAWA_CHAOS_ONLY`) and runs `chaos.test.ts` with
vitest; `HAWA_CHAOS=1 npx vitest run packages/testkit/chaos/chaos.test.ts` does the same. Without
`HAWA_CHAOS=1` the scenarios are skipped, so the ordinary suite never starts containers. Every run
starts from nothing (`down -v`, build, up) and, unless kept, ends with `down -v`. Results, per
scenario (invariants, events, time) with peak memory per container, are written to
`.run/last-run.json` (gitignored) and printed.

The unit tests of the fakes (`test/*.test.ts`) run in the ordinary suite; they need no Docker.
Typecheck this directory with `npx tsc -p packages/testkit/chaos/tsconfig.json`.

## Isolation and safety

- Compose project `hawa-chaos` (`docker-compose.chaos.yml`): its own volumes (`chaos_postgres`,
  `chaos_restate`, `chaos_ca`), networks and images (`hawa-chaos-core:local`,
  `hawa-chaos-worker:local`, `hawa-chaos-fakes:local`) built from this checkout's Dockerfiles. It never
  names `hawa-production` or `hawa-test`; `driver/stack.ts` refuses to kill a container whose name
  does not start with `hawa-chaos-`.
- Host ports, all on 127.0.0.1: Postgres 56432 (database `hawa_chaos`), Restate admin 56070 and
  ingress 56080, fakes 56090. Core has no host port; the driver reaches it through the fakes
  (`/__core/...`).
- **No paid or real provider call can happen.** Core and the workers are on the `chaos` network only,
  which is `internal: true`: no route to the internet. The provider hosts written into the code
  (`api.telegram.org`, `api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`,
  `api.canva.com`, `export-download.canva.com`, `oauth2.googleapis.com`, `www.googleapis.com`,
  `sheets.googleapis.com`) are network aliases of the fakes container there, and the fakes' own CA
  (`fakes/ca.ts`, made at the project's first start) is trusted through `NODE_EXTRA_CA_CERTS`. So the
  real URL code runs unchanged over real TLS, and a host nobody faked does not resolve. Provider keys
  are placeholders. The design's "record once against the real APIs" step is **not** used.
- Throwaway credentials are generated per project into `.run/chaos.env` (mode 0600, gitignored) and
  never printed.
- Memory: limits of 512 MiB (Postgres), 768 MiB (Restate, Core), 384 MiB (each worker), 256 MiB
  (fakes); Restate's RocksDB budget is 256 MiB. The green worker is only started by a deploy scenario
  (profile `green`).

## Topology

| Service | Image | Notes |
|---|---|---|
| `postgres` | `pgvector/pgvector:pg17` | Init scripts as production (`00-init-roles.sql`, schema, RLS, `03-grants.sql`, seed); `fsync=off` (process kills only). The driver then runs the versioned upgrades through deploy.sh's runner (`packages/db/src/upgrade.ts`), with no grants of its own, stores the operator's Canva connection (sealed with the chaos key) and KAAE's client DNA with a Drive folder and sheet. |
| `restate` | `ghcr.io/restatedev/restate:1.7.10` | The blue worker is registered by `scripts/restate-bluegreen.ts register blue --admin http://127.0.0.1:56070`, the deploy's own code. |
| `core` | `infra/docker/Dockerfile.core` | `NODE_ENV=production`, polls the fake Telegram, `DESIGN_PIPELINE_V3=off` (planner path), `CANVA_BASE_URL` and `GOOGLE_*_BASE_URL` at the fakes, `GOOGLE_APPLICATION_CREDENTIALS` a throwaway key the fakes write. |
| `worker-blue`, `worker-green` | `infra/docker/Dockerfile.worker` | `HAWA_WORKER_SELF_URI` per colour; the outbox runs in the live colour only. |
| `fakes` | node base stage of `Dockerfile.worker` | `fakes/server.ts`, run by Node's type stripping, no dependencies. |

## Fakes (`fakes/`)

- **Telegram** (`telegram.ts`): `getUpdates` from a scripted queue (ids grow with the clock, so a
  restarted fake stays above the bot's stored offset), `sendMessage`, `sendPhoto`, `sendDocument`
  (multipart parsed), `answerCallbackQuery`, `getFile` and file downloads of a configured size and
  delay, `getMe`. Every send is logged with a text hash or document SHA-256. Faults per method and
  chat: `429` with `retry_after`, `5xx`, `drop-after-processing` (the message reaches the chat and the
  answer is lost: the "uncertain" case), `delay`; `skip` lets the first N matching calls through.
- **Models** (`models.ts`): OpenAI chat completions answered from `fixtures/models/*.json` by the
  caller's JSON schema name, and the Canva planner's layout built from the request it carries (each
  copy block once, the logo at the requested aspect: what Core validates). A **paid-call ledger**
  keyed by a fingerprint of model, system prompt and first user message. Any call no fixture answers
  (OpenAI images or responses, Gemini, Anthropic) is refused with HTTP 500 and ledgered as
  `unmatched`, so a stage the fixtures do not cover shows up in the results.
- **Canva Connect** (`canva.ts`): `/oauth/token`, `/imports[/:id]`, `/designs[/:id]`,
  `/exports[/:id]`, and downloads on `export-download.canva.com`. The PPTX export of an imported deck
  is the deck itself, so Core's copy-and-font check reads what Core sent. 5xx and 429 faults per
  method and path. A ledger of imports, exports and downloads.
- **Google** reuses `packages/integrations/test/fake-drive-server.ts` unchanged (proxied at `/google`
  and on `www.googleapis.com` / `sheets.googleapis.com`); `oauth2.googleapis.com/token` is faked.
- **Chaos control** (`chaos-control.ts`, at `/__chaos`): `POST /hold {point, match, n}` arms a point;
  `GET /wait?point=` long-polls until a process holds it; `POST /release`; `GET /reached` lists every
  point every process passed.
- The driver's control of the fakes is at `/__fakes`: `reset`, `faults/clear` (armed faults, delays
  and chaos holds; logs stay), `telegram/updates|faults|files|sent|polls`, `canva/faults|ledger`,
  `models/ledger|delays` (a slow answer for one schema, and the requests as they arrive),
  `google/faults` (a slow Drive or Sheets call), `drive/files`.

### Which pipeline stages the fixtures cover

Covered on the legacy path, end to end: Telegram intake and the intake classifier (fixture), the
daily cap, the outbox dispatch, the `TaskWorkflow` planner path (`/canva/generate`: the planner model
call, PPTX build, Canva import, preview and PPTX exports, the copy-and-font check), the outcome report
and Core's draft message and photo, the Desk approval with a pinned PNG, delivery (Drive upload and
Sheets row in the fake Drive, `notify.published` with the approved file and the notice in Telegram).

Not covered (a scenario that reaches them shows `unmatched` model calls): the design studio
(`DESIGN_PIPELINE_V3` / `designStudio`: layout, imagery, critique, judge, parity models), voice
transcription, brand-guidelines PDF reading, feedback revisions and clarifying questions, person
cut-outs (no cut-out service in the project), WhatsApp.

## Chaos points

`chaosPoint(name, detail)` (`packages/observability/src/chaos-point.ts`) does nothing unless
`HAWA_CHAOS_CONTROL_URL` is set (only this compose file sets it); when set it reports the point and
waits while the control holds it. Unreachable control never stops the caller.

Placed today, in the worker only:

| Point | Where | A kill there means |
|---|---|---|
| `worker.outbox.after-claim` | `outbox-consumer.ts` `processClaim`, before the handler | claimed, nothing done; the lease must run out and another claim act once |
| `worker.outbox.before-record` | after the handler, before the result is recorded | acted, not recorded; the handler's own checks must stop a second act |
| `worker.dispatch.after-submit` | `workflow-dispatcher.ts`, after Restate accepted the workflow | a re-dispatch must meet Restate's 409 |
| `worker.step.after-action` (`detail.step`) | `durable-context.ts` `withStepChaosPoints`, inside every `TaskWorkflow` step after its action, before Restate journals it | the step runs again on replay; Core's idempotency keys must make it harmless |
| `worker.sender.after-telegram` (`detail.kind`, `step`) | `outbox-consumer.ts` `sendOnce`, after the Telegram send, before the `sent` mark | the send is only `attempted` on record: must end uncertain, never sent twice, one office alert |

**Follow-ups (not placed: `apps/core/src/app.ts` is being split by another stream).** The design names
`core.intake.after-decision`, `core.project.after-commit`, `core.outcome.after-bridge` and
`core.delivery.after-drive`; `worker.poller.after-enqueue` and `worker.rl.after-project` belong to
Phase 2 code that does not exist yet. Until then Core, Postgres and Restate are killed time-based:
while a worker point is held (`killWhileHeld`), or a fixed time into a request.

## Scenarios (`chaos.test.ts`)

Each scenario uses its own chat, waits for quiescence (no Restate invocation open, no outbox command
due, the fake Telegram quiet for 5 s) and then checks the invariants that apply to the legacy path:

- one task per scripted request; one design revision per task; one approval; one publication, `complete`;
  the final task state;
- each message, photo and file reaches the requester once (a 429 or 5xx answer was not shown); an
  uncertain send has exactly one office alert;
- no paid model call twice (classifier allowance configurable); one Canva import per task;
- one `TaskWorkflow` invocation, completed; nothing paused; no `RT0016`.

| Name | What |
|---|---|
| R1.0 | happy path, no faults |
| R1.K0 | Core killed while the intake classifier (a paid call, slowed to 4 s) is answering; classifier allowance 2 |
| R1.K1 | worker killed at `worker.outbox.after-claim` (task.created) |
| R1.K2 | worker killed at `worker.dispatch.after-submit` |
| R1.K3 | worker killed after `canva-create-draft` (planner and import done) |
| R1.K4 | worker killed after `canva-export-copy-font-check` |
| R1.K5 | worker killed after `canva-notify-canva_draft_ready_for_visual_review` (Core took the outcome) |
| R1.K6 | Core killed while the worker is held after `canva-read-binding` |
| R1.K7 | Postgres killed while the worker is held after `canva-export-preview` |
| R1.K8 | Restate killed while the worker is held inside `canva-create-draft` |
| R1.K9 | Canva 5xx ×3 then 429 on export creation |
| R1.K10 | Telegram 429 (`retry_after` 3) on the draft message |
| R1.K11 | Core killed right after the Desk approval |
| R1.K12 | worker killed at `worker.sender.after-telegram` for the approved file (one uncertain send expected) |
| R1.K13 | Telegram takes the approved file and the answer is lost (one uncertain send expected) |
| R1.K14 | Core killed in the middle of a Deliver request (the fake Drive upload slowed to 8 s); Deliver pressed again once |
| R1.K15 | Postgres killed while the worker is held at `worker.sender.after-telegram` for the approved file |
| R1.D1 | deploy mid-request: the design is held on blue, green is started and registered (`restate-bluegreen.ts register green`), the design finishes, `finish-drains` must delete blue; the invocation must stay pinned to blue |
| R4 | two chats: a 19.9 MB picture whose download takes 30 s in chat A; chat B's text must be answered in under 5 s |

Not yet: R1 kill points that need Phase 2 code (poller, `ChatInbox`, `RequestLifecycle`); the design's
K9 with a *patched* worker build (R1.D1 deploys the same build, so it proves the drain and the pinning
but cannot show replay on changed code); R2 (reminders), R3 (question and answer; no fixtures for
feedback revisions yet), R5 (rollback of the per-chat flag, which does not exist yet).

Faults a scenario arms and does not use up are dropped when it ends (`/__fakes/faults/clear`), so they
never reach the next scenario.

## Baseline on today's code (2026-09-24, `studio-v2` at 81f24ad plus this suite)

Full run: 19 scenarios in 685 s (plus about 30 s to build from cache and start); peak memory of the
project 1,192 MiB (Restate 693, Core 195, Postgres 123, fakes 87, workers 68 and 41). Every model
call was answered by a fixture (no `unmatched` calls). 16 scenarios hold every invariant; 3 do not:

| Scenario | Result on the legacy path |
|---|---|
| R1.0, R1.K0–K8, K10–K13, K15, R1.D1 | hold: one task, one revision, one approval, one complete publication, one Drive file, each Telegram message once, one office alert per uncertain send, no paid call twice (classifier twice only in K0, allowed), one Canva import, one completed `TaskWorkflow`, nothing paused, no RT0016; D1: the held design finished on the blue deployment it started on and `finish-drains` deleted blue |
| R1.K9 | **fails**: one Canva 5xx on `POST /exports` ends the draft as `CANVA_PREVIEW_FAILED` at once. `startExport` records the export `failed` (Canva answered, so nothing was created) and the workflow's preview loop retries only `submitted`, `creating` and `stale`; the requester gets "draft created, with a check to resolve" and there is nothing to approve |
| R1.K14 | **fails**: Core killed during a Deliver request (Drive upload in progress) leaves the task in `publishing` after the restart, until someone presses Deliver again (PHASE2_DESIGN.md 1.1 step 9: `reopenInterruptedDelivery` checks an in-memory set). The second press delivered once: one Drive file, one document in Telegram |
| R4 | **fails, as expected before Phase 2.1**: chat B's text was answered after 30.9 s, behind chat A's 30 s picture download (Core's poller handles one update at a time) |

Since then (2026-09-24, Phase 2 fixes): R1.K9 holds every invariant. The Canva client asks a
create call again within about 15 s when Canva refused it for the moment (429 on every create call,
5xx on `POST /exports` only; `packages/integrations/src/canva-connect-client.ts` `createWithRetry`).
`--only R1.0,R1.K9` passed on a database built with `db/03-grants.sql`, in 76 s, peak 851 MiB.

Found while building the stack (not scenarios):
- A database built by `docker-compose.prod.yml`'s init scripts includes `db/03-grants.sql`, which
  revoked `UPDATE` on `hawa.outbox_commands` (and `inbox_events`, `approvals`, `publications`, …) from
  `hawa_app`; a worker on it failed every poll with "permission denied for table outbox_commands".
  Fixed: the file grants back the columns the code moves, and this project now mounts it
  (`apps/worker/test/fresh-production-init.test.ts` builds such a database on every test run).
- Core started on a database without the versioned upgrades exited at once (unhandled rejection:
  relation "client_dna_versions" does not exist). Fixed: Core checks `hawa.schema_upgrades` before it
  starts, logs one line naming the missing upgrades and exits 1 (`apps/core/src/schema-check.ts`).
- Postgres with `synchronous_commit=off` (as `docker-compose.test.yml` runs it) loses commits it had
  acknowledged when the process is killed; the first run of R1.K7 reported lost Canva rows for that
  reason alone. This project keeps `synchronous_commit` on.
