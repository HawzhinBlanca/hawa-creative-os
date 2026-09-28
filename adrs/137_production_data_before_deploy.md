# ADR-137: Migrations and the Chaos Suite Meet Production's Own Data Before a Deploy

**Date:** 2026-09-28
**Status:** Proposed by the implementing agent on 2026-09-28, on the owner's request to close the gap ADR-133 exposed.
**Requirements:** NFR-013 (upgrades require backup, compatibility suite, canary and rollback), FR-074 (upgraded only through compatibility testing), NFR-024 (third-party adapters have contract fakes).
**Changes a foundation:** the release gate (`scripts/enforce_release_gate.sh`, R11) gains a stage; the chaos harness (`packages/testkit/chaos`) gains a seeded mode. No runtime behaviour of Core, the worker or the database changes.

## 1. Context

On 2026-09-28 a release passed the full gate (4,800+ unit tests; chaos 17/19 in core mode, 42/43 in worker mode) and then refused every paid call in production. Migrations 051 and 056 counted 79 records from before daily admission as "history incomplete" (ADR-133, fixed by migration 067). Every test, template and chaos database is built from `db/*.sql`, fixtures and synthetic requests. None of them holds a record from before migration 051, so no gate could see the fault.

Production's data is already on disk as files. `deploy.sh` writes `infra/backup/snapshots/predeploy_<stamp>.dump` before every deploy, and the nightly job writes `hawa_<stamp>.dump`. The test server (`hawa-test-postgres`, 127.0.0.1:55432) can restore a 46 MiB dump in about 6 s. Nobody may run SQL against production itself: a crash once coincided with an ad-hoc read.

## 2. Decision

1. **Gate stage 3, "pending migrations on production's newest dump"** (`packages/db/src/predeploy-dump-check.ts`):
   - It restores the newest dump file into `hawa_drill_predeploy_<stamp>_<pid>` on the test server and applies the candidate's migrations with the upgrader `deploy.sh` runs (`upgrade.ts`).
   - It then runs read-only invariants in rolled-back transactions (`predeploy-invariants.ts`):
     - `budget-history`: no spending scope is `historyIncomplete` for any tenant or client;
     - `admission`: a zero-dollar `admit_office_spending` is accepted for every tenant, client and role, and zero is never "exhausted";
     - `app-role`: `hawa_app` reads tasks, clients and the outbox under RLS;
     - `constraints`: every `NOT VALID` constraint validates;
     - `schema-parity`: compared with a database built from the checkout, nothing is missing or different, and extra production privileges are reported.
   - It drops both scratch databases on every exit path.
   - The stage is on by default. It is skipped with a message only when no dump exists, and a failure stops the gate.
2. **`upgradeCanvaSchema(url, { through })`**: an optional ceiling so the check can replay a past release (`--through 066`). A deploy never passes it, and the default applies every migration, as before.
3. **Chaos on a copy of production** (`run.ts --seed-dump <file>`, `driver/seed.ts`):
   - After the init scripts create the roles, the chaos database is replaced by the dump and upgraded exactly as a deploy upgrades it.
   - The driver then removes restored credentials (Canva connections and OAuth states, desk and OIDC sessions, integration configs). It refuses to continue while any credential-shaped column still holds a value.
   - Before any scenario, the run proves the egress fence from inside Core and the worker. The harness's fakes remain the only providers.
   - `--lifecycle-chats all` enrols every chat on the Restate lifecycle, as production does.
   - The chaos project lock (`hawa-chaos-lock`, from `claude/objective-hellman-2d66cb`) is ported here, so seeded runs never overlap another checkout's run.

## 3. How restored data cannot reach a real service

- **Network.** Core and the workers are on internal Docker networks only. Every provider host (`api.telegram.org`, `api.openai.com`, the Gemini and Anthropic hosts, the Canva and Google hosts) is a network alias of the fakes container. Nothing else resolves, and there is no route out. `verifyEgressFence()` checks this with Node's resolver and sockets inside both containers: each provider name resolves to the fakes' address, five unfaked names do not resolve, and 1.1.1.1:443 and 8.8.8.8:53 cannot be reached. A seeded run refuses to start otherwise.
- **Credentials.** The stack's keys and bot token are placeholders or throwaway values in `.run/chaos.env`. Production's `.env` files are never read. The restored Canva tokens were sealed with production's key. They are deleted before any application process starts, and the chaos operator's connection is sealed afresh with the chaos key.
- **Identifiers.** Real chat ids, Canva design ids and Drive folder ids stay in the rows. Any call they cause lands in the fakes.

## 4. Consequences

- The gate takes about 10 s longer. It now depends on the test server, which Stage 8 already needs.
- The dump holds client data. It is restored only into the test server's scratch databases or the chaos volume. Both are dropped: the scratch databases at the end of the check, the chaos volume by `down -v` at the start and end of every run. Reports hold counts and schema-object names only.
- A migration that breaks production's history, grants or constraints fails before deploy.
- Replaying migrations through 066 on the 13:50Z dump of 2026-09-28 fails `budget-history` (11 scopes) and `admission` (55 refusals). Through 067 it passes. So this stage would have stopped the release ADR-133 repaired.

## 5. Verification

- `packages/db/test/predeploy-invariants.test.ts` (7 tests):
  - dump choice;
  - restore errors never carry row values;
  - an unfrozen pre-admission Studio call fails `budget-history` and `admission`;
  - freezing it, as 067 does, passes;
  - the check changes no rows.
- `packages/testkit/chaos/test/seed.test.ts` (3 tests): the credential-column rule, and the compose file's internal networks and provider aliases.
- The evidence and chaos results on production data are in `plans/lean-design-implementation-2026-09-28/CHAOS_ON_PRODUCTION_DATA_PROOF.json`.
- Gate stage run as the gate calls it, on `predeploy_20260928T181301Z.dump`: passed in 21 s wall time (restore 15.6 s). No scratch database was left.
- Seeded chaos runs on the same dump, with an egress fence of 17 checks from inside Core and the worker:
  - worker poller with `HAWA_LIFECYCLE_CHATS=*`: 35 of 37 applicable scenarios passed in one run, and 6 legacy-only scenarios were not applicable. R1.K14 and R1.D1 passed on rerun after fixes to the harness only.
  - core poller: 17 of 19 passed. The two failures, R1.K14 and R4, are the documented baselines without production data.
  - No product defect came from production data.
- Two harness defects were found and fixed:
  - the load runner tore down a project it did not own after giving up its wait, which took down a seeded run mid-suite;
  - a queued suite was killed by its own hook timeout while it waited for the lock.
