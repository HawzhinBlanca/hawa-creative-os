# Operations Runbook Overview

Detailed procedures live under `runbooks/`.

## Daily

- inspect blocked/failed task queue;
- verify Telegram/WAHA cursors and session health;
- inspect GPU/model provider capacity and budget;
- reconcile pending Drive/Sheet publications;
- confirm last database/file backup success;
- review critical security/integrity alerts.

## Weekly

- review quality/revision trends;
- examine repeated feedback/rule proposals;
- sample approved work and source packages;
- review provider/model fallbacks and costs;
- check disk/DB growth and staging cleanup;
- test one non-destructive workflow replay.

## Monthly

- patch OS/container dependencies through candidate environment;
- review users/roles/integrations;
- rotate selected credentials according to policy;
- audit ComfyUI node/workflow allowlist;
- export/check representative `.hyc` sources;
- evaluate new model candidates only when they address a measured gap.

## Quarterly

- clean-host database/file restore drill;
- full critical RTL/editor regression;
- fallback studio migration sample;
- incident/tabletop exercise;
- retention/deletion review;
- model and upstream-dependency architecture review.

## Incident priorities

### P0

Cross-client disclosure, source corruption, unauthorized approval/publication, credential compromise, unrecoverable database failure.

Immediate isolate, preserve evidence, revoke access, stop side effects, restore/repair through incident runbook.

### P1

Core intake/review unavailable, widespread workflow failure, Drive publication blocked, HyCanvas unusable for all tasks.

Activate degraded mode and recover within RTO.

### P2

Single adapter/provider/GPU failure, isolated task corruption caught before publication, Sheet divergence.

Use fallback/reconciliation and track root cause.

## Credential rotation

- Rotate together: Telegram bot token (BotFather), `TELEGRAM_WEBHOOK_SECRET`, `HAWA_ADMIN_KEY`, `HAWA_ART_DIRECTOR_KEY`, `HAWA_BEARER_TOKEN`, `HAWA_ACTION_HMAC_SECRET`, `WAHA_WEBHOOK_SECRET`. Update `infra/docker/.env.production`, then redeploy.
- Canva token key: run `apps/core/src/tools/rotate-canva-token-key.ts` with `--dry-run`, then for real, then update `CANVA_TOKEN_ENCRYPTION_KEY` and redeploy.
- Database roles: `ALTER ROLE hawa_owner PASSWORD …` and `ALTER ROLE hawa_app PASSWORD …`, then update `infra/docker/.env` (`POSTGRES_PASSWORD`, `DATABASE_URL`).
- Never keep a credential in a script, a test, a compose default or an audit document; `infra/security/security_scan.py` blocks commits that do.

Rotation record: generated values go only into `infra/docker/.env.production`, `infra/docker/.env` and
`.env.test` (all `0600`, all gitignored). Test suites read their database credentials from `.env.test`
(see `.env.test.example`); rotate the PostgreSQL passwords with `ALTER ROLE` and update all three files
in the same step, then redeploy so the containers pick up the new values. Keep the pre-rotation copies
outside the checkout.

## Redeploy

- `bash infra/docker/deploy.sh` runs the pre-flight (configuration present, no placeholders, compose valid, gates). `--apply` adds a `pg_dump` snapshot, versioned schema upgrades, build, start and a truthful health check (`/v1/health` dependencies must not be `unauthorized`, `unreachable`, `disconnected`, `read_only` or `outage`).
- After a deploy, send one English and one Kurdish brief from an allowlisted Telegram account and confirm each receives a final status message.

## Dead-lettered outbox commands

- Worker `/health` reports `outbox.failed` and `outbox.staleOver5m`. Read `last_error` on the failed rows, fix the cause, then `POST /v1/system/outbox/requeue` with `{"all":true}` or `{"ids":[…]}` as an administrator.

## Stuck automatic drafts

- A plan in `failed`, `uncertain` or `planned` state blocks further automatic drafting for its task. After checking the model receipt, an operator may `POST /v1/tasks/:taskId/canva/plans/:planId/abandon` with a reason; the evidence stays, and the task may be planned again.
- Daily ceilings (`AUTO_GENERATE_DAILY_CAP_PER_SENDER`, `AUTO_GENERATE_DAILY_CAP_GLOBAL`) decline further automatic drafts; declined requests are saved for manual design and the sender is told.

## Service identities

Rows nobody pressed a button for are written by two seeded service users, not by a person (ADR-027):
**Channel Ingress** (`…b000-000000000010`, chat and WhatsApp intake, chat-trigger transitions) and
**System Automation** (`…b000-000000000011`, session bookkeeping, workflow completion, publisher
audit). Migration 012 seeds them with the `operator` role on every tenant that exists at that time.
When a tenant is added later, insert the same two `tenant_memberships` rows for it, or adapter writes
for that tenant will be refused by RLS. To audit who or what created work: join `tasks.requested_by`
to `users.display_name`.

## Local credential material

`bash infra/security/local_state_audit.sh` lists every plaintext env file, deployment snapshot,
database dump and container inspection on this host that git ignores, with its mode. The deploy
pre-flight runs it and refuses to continue while any such file is readable by other users or is
committable. It never deletes anything: after a rotation, move old snapshots off the checkout to an
encrypted location or delete them yourself.

## Backups

`infra/backup/nightly_backup.sh` runs every night at 03:30 (launch agent `design.hawa.nightly-backup`)
and on demand. It takes a `pg_dump` in custom format compressed with zstd (`--compress=zstd:long`:
about 41 MB, against 319 MB with the default compression, because the dump repeats the same images),
writes a SHA-256 sidecar, restores the dump into a scratch database on the same server to prove it
loads and holds the live task count, drops the scratch database, keeps the 14 newest dumps, copies an
encrypted one to the archive destination, and sends a Telegram alert to the operator chat only on
failure. `--list` shows what exists; `backup.log` in `infra/backup/snapshots/` records every run.

The deploy script writes `predeploy_<stamp>.dump` (same format, with its table of contents checked)
before every migration. Both live under the gitignored, owner-only `infra/backup/snapshots/`. Restore
either: `pg_restore -U hawa_owner -d hawa --clean --if-exists <file>` inside the postgres container,
after stopping core and worker. Pre-deploy dumps from before 2026-09-23 are plain SQL compressed as
`.sql.zst`: `zstd -d --long=27 -c <file> | docker exec -i hawa-production-postgres-1 psql -U hawa_owner -d hawa`.

`infra/ops/disk_cleanup.sh` bounds Hawa's own disk use: the newest ten pre-deploy dumps; one dump a
day for 30 days in the old deploy archive `~/.hawa/snapshots_archive` (nothing writes there any more);
Docker's build cache held to 8 GB and images nothing uses. The deploy runs it after health passes, the
nightly backup runs its dump part, and the watchdog runs it when the disk passes 88%. `--report` only
prints what Hawa holds.

## Watchdog and self-healing

`infra/ops/watchdog.sh` runs at login and every five minutes (launch agent `design.hawa.watchdog`).
Docker Desktop is not configured to start at login, so the watchdog starts it, brings the stack up
with `compose up -d --no-build` when fewer than six containers run, then checks core `/v1/health` and
the worker health. Any problem is sent to the operator chat at most once per 30 minutes; recovery is
announced once, saying what it was. A disk over 90% full after Hawa's own cleanup is reported with how
much of it is Hawa's, every 6 hours (hourly past 97%), since the rest is other files on the Mac. `--status` prints the assessment without acting; `--announce` proves the alert path.
Agents run only while this user is logged in; after a reboot, log in and the stack returns on its own.
Install or refresh both agents with `bash infra/ops/install_launch_agents.sh` (`--uninstall` removes).

## Sorani Kurdish drafts

Automatic drafts set English and Sorani Kurdish copy (ADR-028). Kurdish blocks are set right-to-left in
the script typeface declared in `packages/creative/assets/kaae-reference.json` (`rules.scriptFonts.arabic`,
currently the provisional `Noto Sans Arabic`; Canva has it and keeps it on export). When the client's
Kurdish typeface is confirmed, change that one field and delete `scriptFontNote`; requesters stop seeing
the provisional note automatically. QA evidence on the exported PPTX: `copyPass` (exact copy), `fontPass`
(brand font on Latin objects, script typeface on Arabic objects), `rtlNote` (Canva exports omit the
paragraph direction flag; direction is checked visually). Any other script or emoji is refused before a
paid call with `COPY_UNSUPPORTED` and saved for manual design.

## Design Studio v2

Design Studio v2 operates a multi-stage, durable pipeline (`see` → `judge` → `revise`) guarded by Restate, Core advisory locks, and append-only database journals (Migration 013).

### 1. Operational Configuration & Feature Flags
- `DESIGN_STUDIO_V2`: Defaults to `'off'`. When off, standard intake uses the legacy single-shot planner. When `'on'`, Telegram intake dispatches into the studio pipeline.
- `DESIGN_STUDIO_TIER_DEFAULT`: Defaults to `'standard'` (3 candidates, 1 revision loop). May be set to `'premium'` for high-touch briefs.
- `DESIGN_STUDIO_MAX_USD`: Hard budget ceiling per run (default `$2.00` since 2026-09-23; `DESIGN_STUDIO_MAX_CALLS` defaults to 24). Real designs cost $0.33–0.78 with at most 10 calls. If accumulated costs in `hawa.design_studio_calls` reach this ceiling, the run ends `failed` with the stage, spend and call count in its diagnostic.
- Explicit Route: `POST /v1/tasks/:taskId/canva/studio` is available regardless of the feature flag for Desk testing and qualification evaluations.

### 2. Operational Database Inspection Queries
To verify run progression, cost accounting, and call receipts:
```sql
-- View recent Design Studio runs and statuses
SELECT id, task_id, status, tier, total_stages, current_stage, budget_usd_cap, spent_usd, created_at
FROM hawa.design_studio_runs
ORDER BY created_at DESC LIMIT 10;

-- Audit paid provider calls and verify receipt response_ids for a run
SELECT id, stage, provider, model_id, response_id, prompt_tokens, completion_tokens, cached_tokens, usd_estimate, created_at
FROM hawa.design_studio_calls
WHERE run_id = '<run_id>'
ORDER BY created_at ASC;

-- Verify sum of call receipts strictly matches run spent_usd
SELECT r.id, r.spent_usd, COALESCE(SUM(c.usd_estimate), 0) AS calculated_usd,
       (r.spent_usd = COALESCE(SUM(c.usd_estimate), 0)) AS ledger_balanced
FROM hawa.design_studio_runs r
LEFT JOIN hawa.design_studio_calls c ON c.run_id = r.id
GROUP BY r.id;
```

### 3. Fault Injection & Incident Procedures

#### Scenario (a): Worker crash or container restart during active run
- **Symptom**: `hawa-production-worker-1` restarts or exits during an in-flight stage (e.g., `critiquing`).
- **Mechanism**: Restate retains the execution journal up to the last completed step. When the worker recovers, it queries Core with the same task ID and idempotency key.
- **Invariants**: Stages prior to the interrupted step are not re-executed; calls already committed to `hawa.design_studio_calls` are preserved; ledger call count and USD spend remain unchanged (zero duplicate billing).
- **Verification**: `docker restart hawa-production-worker-1; npx tsx scripts/studio_fault_injection.ts`.

#### Scenario (b): Provider outage & degraded art fallback
- **Symptom**: Gemini API key is missing, invalid, or returns 429/5xx during art generation.
- **Mitigation**: The art stage automatically triggers Degradation Ladder Rung 2 (`rung2_art_procedural_fallback`).
- **Behavior**: The server generates a deterministic SVG procedural motif (`gradient-wash`, `thin-rules`, `sun-rays`, or `guilloche`) using brand palette colors. Diagnostic metadata records `artFallback: 'procedural'` and status note reflects the fallback honestly.

#### Scenario (c): Transient provider overloading (HTTP 529)
- **Symptom**: Anthropic API returns HTTP 529 (`overloaded_error`).
- **Mitigation**: `StudioModelClient` executes exponential backoff with jitter across up to 3 retries (1s, 3s, 9s). If 5 consecutive failures occur, the provider circuit breaker trips to open state for 60 seconds.
- **Receipts**: Call receipts record total attempt counts (`attempts: 4`) and exact token usage.

#### Scenario (d): Hard budget cap enforcement (`BUDGET_EXHAUSTED`)
- **Symptom**: Run cost reaches or exceeds `DESIGN_STUDIO_MAX_USD` (default $2.00, or office override).
- **Mitigation**: `DesignStudioService` stops current stage execution immediately and halts further paid calls.
- **Behavior**: The run promotes the highest-scoring candidate evaluated so far (or metric-best if critique is incomplete), marks run status as `degraded`, and appends an honest budget exhaustion note to the delivery message.

#### Scenario (e): Canary failure & judge unreliability
- **Symptom**: Critic vision judge fails to prefer the winning design over deterministic degradations (e.g. 40% font size reduction, logo text collision) across both presentation orders.
- **Mitigation**: `canary.stage` flags `judgeStatus: 'UNRELIABLE'`.
- **Behavior**: The tournament verdict is overridden; the run promotes the candidate with the highest deterministic layout metrics, logs the canary failure, and appends a notice to the requester stating that the vision judge was unreliable and human review is required.

## Golden rule

Do not “fix” an incident by manually editing database state or deleting evidence. Use audited repair/reconciliation commands or a documented migration reviewed by another operator.

