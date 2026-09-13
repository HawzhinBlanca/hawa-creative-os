# Independent review of the "10/10 qualification" working tree

**Date:** 13 September 2026, 20:10 Baghdad · **Reviewer:** Claude (Fable 5.1), lead engineer session
**Subject:** the uncommitted working tree behind `10_OUT_OF_10_QUALIFICATION_REPORT.md` (HEAD `15f2534`)
**Verdict:** **Not ship-ready as found. Remediated in this session; production redeploy and credential rotation still required (user actions in section 5).**

The verification method for every claim is stated inline. Nothing here was accepted from a report; each item was reproduced against the working tree, the running containers or the database. No secret value appears in this file.

## 1. What the 10/10 report claimed versus what reproduced

| Claim in the report | Reproduced result (before this session's fixes) | How verified |
|---|---|---|
| 111 test files, 753 tests, 0 failures, 1 skipped | 108 passed + 4 skipped files; 695 passed + 64 skipped tests | `npx vitest run` |
| Pack validation PASS=485, FAIL=0 | PASS=483, **FAIL=3** (two untracked scripts missing from SHA256SUMS) | `python3 scripts/validate_pack.py` |
| "Zero live secrets" | The scanner had been weakened (skip-list on words such as *test*, *audit*, *oauth_token*; whole directories ignored). The HEAD version of the same scanner reports 8 hits. Neither version detects a 64-hex AES key or a `postgresql://user:<password>@` URL. | ran both scanner versions |
| Isolation suite "10/10 on hawa_repair" | Database `hawa_repair` **did not exist** on the local PostgreSQL; the five DB-gated suites could not run | gated vitest run answered `database "hawa_repair" does not exist` |
| Telegram open intake with Director lock | True, and live: the production env sets the intake allowlist to `*` and automatic drafting to `true`; every stranger's message triggered a paid Claude Opus 5 call plus a Canva import, attributed to KAAE (section 2.3) | container env inspection (variable names and flags only) |

## 2. Confirmed defects and what was done

### 2.1 Live credentials committed in git (P0)
- The production **Telegram bot token** in the running core container is byte-identical to the token hardcoded in the tracked file `scripts/dispatch_authentic_kaae_telegram.ts`, and to the token flagged as leaked in commit `1397756`. It was never rotated.
- The production **webhook secret** equals the literal default that was committed in `infra/docker/docker-compose.prod.yml`, the same string the test suite labels "revoked". Because `verifyRequestAuth` accepted that header as an operator credential on every route, anyone with repository access had operator-level API access on the edge port.
- The untracked `scripts/export_design.js` contained the live Canva token encryption key (it decrypted production Canva tokens successfully); `scripts/generate_task_canva.ts` embedded the runtime database password. Both would have entered git with the next `git add -A`.
- The PostgreSQL owner and runtime passwords were the compose defaults and appeared in 13 test files.

**Done:** deleted the two leaking scripts; made the dispatch, drain, reconcile and critique scripts environment-driven; removed every credential default from the compose file (missing values now fail `docker compose config`); scoped the webhook secret to `/api/webhooks/*` only, with a negative-control test; centralised the local test database URL in `vitest.config.ts` (one justified allowlist entry) and removed the 13 fallbacks; `createDb` no longer has a default connection string; added `apps/core/src/tools/rotate-canva-token-key.ts` (transactional re-encryption with dry run).
**Still yours:** rotation (section 5).

### 2.2 Two competing Canva generation paths, one retrying forever (P0)
The webhook handler ran `CanvaDesignPlanner` inline (key `tg_<task>`, 1080×1350, up to 90 s of model call plus 30 s of polling inside the request) while the Restate worker also ran `runCanvaDraft` for the same task (key `workflow-<task>`, 1200×1697). The second caller received `GENERATION_CONFLICT`; because every non-2xx answer was treated as retryable, Restate retried the step indefinitely. Requesters received two messages or none, and failures (Kurdish copy, non-KAAE clients, uncertain results) were never reported.
**Done (ADR-026):** removed the inline path; the worker is the single durable path; the requested artboard size travels in the outbox payload; 4xx answers are terminal and converted to Restate `TerminalError`; every terminal outcome is reported through `POST /v1/tasks/:id/notifications/canva-status` with an honest, HTML-escaped message (new `canva-status-message.ts`, unit-tested). Worker tests cover rejection, transient failure, sizing and unscoped tasks.

### 2.3 Strangers attributed to KAAE (P0, tenancy)
`durableClient` fell back to the KAAE client id for any unrecognised sender, reversing the earlier "pause as unscoped" rule; combined with open intake this spent the model budget and used KAAE's logo and reference pack for anyone.
**Done:** unknown aliases persist with `client_id = NULL` and never schedule automatic drafting; known aliases resolve to the seeded rows; the requester is told the art director will assign the client. A DB-gated regression test was added.

### 2.4 Quality gates that had been bent (P1)
- `SyntheticTrafficDaemon(12)` seeded twelve fabricated successful SLO probes. The wiki records this as fixed to 0 on 11 September; no commit ever contained that fix. **Done:** 0 seeds; the test now asserts the daemon starts empty.
- Secret scanner weakened (above). **Done:** rewritten to scan exactly `git ls-files -co --exclude-standard` with eight typed patterns, a `--self-test`, and an explicit allowlist with a justification per entry; stale entries fail the gate. CI runs the self-test.
- Manifest and checksums were hand-maintained. **Done:** `scripts/refresh_manifest.py` regenerates both with the validator's own rules.
- A stale tunnel hostname was the fallback Desk link. **Done:** removed.

### 2.5 Missing isolated test database (P1, evidence)
**Done:** `packages/db/src/provision-isolated-test-db.ts` creates `hawa_repair` from `db/schema.sql`, `db/rls.sql`, `db/seed.sql` and the nine versioned upgrades. Provisioned locally; all five gated suites pass (section 3).

## 3. Gates after remediation (all run in this session)

| Gate | Result |
|---|---|
| `pnpm typecheck` (`tsc -b`, 13 packages) | exit 0 |
| `npx vitest run` (CI parity, no DB env) | 107 files passed, 4 env-gated skipped; 692 tests passed, 66 skipped, 0 failed |
| DB-gated suites on `hawa_repair` (planner, connect boundary, chat intake, binding isolation, schema upgrade) | 5 files, 64 tests passed, 0 failed |
| `python3 scripts/validate_pack.py` | PASS=487 WARN=0 FAIL=0 |
| `python3 infra/security/security_scan.py --self-test` and scan | 8/8 patterns; 0 secrets in committable files; 28 justified allowlist hits |
| `pnpm --filter @hawa/desk build` | exit 0 |
| `pnpm db:check` | 52 tables, 11 enums, 24 policies, PASSED |
| `docker compose … config` with `infra/docker/.env.example` | valid |

Skipped-test note: the four skipped files are the DB-gated suites; they run only with `HAWA_ISOLATED_TEST_DB` (and `HAWA_ISOLATED_RUNTIME_DB`) pointing at `hawa_repair`, and the disaster drill only with `POSTGRES_DISASTER_DRILL_ENABLED` plus explicit owner and app credentials. Any "all tests green" statement that omits these variables covers the in-memory suites only.

## 4. What this session deliberately did not do
- No production container was rebuilt or restarted; the running stack still executes the pre-fix code (inline planner, KAAE fallback, twelve seed probes, open intake).
- No production data or database roles were changed. The `hawa` database still holds 1,478 tasks.
- The production env file was **not** edited (the session's policy blocks writing secrets); the required edits are listed below.
- No commit was made. The full change set is in the working tree; a backup patch is at `/private/tmp/claude-501/-Users-hawzhin-Hawdesign/d8c554b7-ad52-4a91-9015-75cbc53f3599/scratchpad/remediation-tracked.patch`.

## 5. Required user actions, in order
1. **Stop concurrent agents on this working tree.** During this session another agent (Antigravity IDE) staged 46 file deletions and edited `apps/core/src/routes/system.routes.ts` and `packages/creative/src/index.ts`. Two autonomous agents editing one checkout is how work gets lost or half-committed. Review its staged deletions separately with `git diff --cached --stat`.
2. **Rotate the Telegram bot token** in @BotFather, then put the new token in `infra/docker/.env.production`.
3. **Rotate the webhook secret**: give `TELEGRAM_WEBHOOK_SECRET` in `infra/docker/.env.production` a fresh random value. It is still the committed literal today.
4. **Create `infra/docker/.env`** from `infra/docker/.env.example` with the current owner password and runtime `DATABASE_URL` (the values the stack already uses), then rotate both role passwords with `ALTER ROLE` and update the file. The compose file no longer carries them.
5. **Rotate the Canva token encryption key** with `apps/core/src/tools/rotate-canva-token-key.ts` (run with `--dry-run` first; the tool's header documents the three environment variables), then update the production env file.
6. **Decide the intake policy.** An intake allowlist of `*` with automatic drafting on means any Telegram user can trigger a paid model call. The documented office model (`docs/09`, `docs/14`) is allowlisted senders. Recommended: list the office user IDs.
7. **Commit** the remediation after reviewing `git status` (keep the other agent's staged deletions separate), then **rebuild and redeploy** core and worker with the production compose files. Take a `pg_dump` first (`infra/backup`).
8. After redeploy, send one English KAAE brief and one Kurdish brief from an allowlisted account and confirm each receives a final status message: the Canva link, or the stated manual-design reason.

## 6. Boundaries that remain (honest scope)
- Automatic drafting supports **English copy for KAAE only** (the planner rejects Arabic-script copy and clients without a verified reference pack). Requesters are now told so; the capability itself is not built.
- Canva font substitution (Minion to Arimo) and print/CMYK qualification remain open as recorded in ADR-024 and the 13 September ship-readiness report.
- Desk sessions are held in memory; a core restart logs every Desk user out.

## 7. Adversarial audit workflow: outcome and second remediation batch (22:40 Baghdad)

Nine independent finder lenses produced 90 deduplicated findings. The refutation stage verified 23 of them (three refuters each); the remaining 67 could not be verified by the workflow because its agents hit the session limit at 22:10. Those 67 are **unverified, not refuted**. I re-checked the serious ones by hand (code reading plus read-only production queries) before acting.

### 7.1 Verified by the workflow and by me, fixed in this batch
| Finding | Evidence | Fix |
|---|---|---|
| Live HAWA admin/reviewer/operator API keys hardcoded in tracked scripts and in `output/audits/2026-09-13-honest-completion-audit/REPRODUCE.md` (three of the literals match the running container's values by length and equality check) | `scripts/verify_live_h01_h03.ts`, `verify_all_h01_h14.ts`, `run_independent_completion_audit.ts`; container env comparison (counts only) | Scripts now require the variables from the environment and fail without them; the audit doc's bearer values are redacted; scanner gained `long_credential_assignment` and `env_fallback_literal` patterns (10 patterns, self-tested). **Rotate the keys (section 8).** |
| Telegram webhook registration and deletion callable without administrator credentials | `system.routes.ts` register/delete/poll-now handlers had no auth | Explicit administrator credential required (401 without a header, 403 for operators); tests updated with negative checks |
| `POST /api/ingress/unified` accepted anonymous, self-declared "verified" messages and a caller-chosen tenant | `app.ts` handler | Authentication required before validation; `verified` is always server-set; a body tenant is honoured only for administrators |
| Dozens of mutating routes registered without any auth check | `registerRoute` wrapper | Deny-by-default: every non-GET route registered through the wrapper requires an authenticated caller except `/auth/session` and `/webhooks/*` (which verify their own secret). Full suite green after adding credentials to three tests. |
| Telegram reply and feedback lookups used a tenant id that does not exist (`a0000000-…`) | `app.ts` three sites | Replaced with the default tenant constant |
| `/status` and `/review` bypassed the sender allowlist | `handleCommand` called without the sender id | Sender id now passed |
| Fallback HMAC secret literals in library code (`outbound-notifier.ts`, `telegram-security.ts`) and a fallback webhook secret in `setup_public_tunnel.ts` (that one equals the live value) | code | Removed; missing configuration throws instead of signing with a committed literal |
| Restate 400 rejections dead-lettered 18 `task.created` commands (2026-09-12 21:32 to 2026-09-13 11:31) with no diagnostic and no requeue path | `hawa.outbox_commands` (18 rows, `state=failed`, attempts 5) | Rejection body is now recorded in `last_error`; `POST /v1/system/outbox/requeue` (administrator) resets selected or all failed rows. Restate reports 10 completed `TaskWorkflow` invocations; the 18 predate the current deployment and can be requeued after redeploy. |

### 7.2 Unverified by the workflow, confirmed by me, fixed in this batch
| Finding | How I confirmed it | Fix |
|---|---|---|
| A Telegram update without text (sticker, photo without caption, chat-member event) made the webhook return 503, the poller rethrew, the offset never advanced, and every later message was blocked | Code path: empty `rawText` → `persistChatIntake` throws → 503 → poller throws → `pollOnce` does not advance | The webhook acknowledges and skips such updates (200, `ignored`) and tells the sender to send text; the poller also abandons any update after three failed deliveries |
| A voice note that could not be transcribed was replaced by a hardcoded Aster Pharmacy Nawroz brief | `voice-transcriber.ts` fallback literal | Transcriber returns an empty, honest result; the webhook asks the requester for text instead of creating a fabricated task |
| WhatsApp strangers were attributed to Drustee by default; the webhook accepted unauthenticated traffic in production when no secret was configured | `app.ts` and `waha-ingress.ts` | No default client; production refuses WhatsApp intake without a configured secret |
| The production Anthropic credential is rejected: every Telegram-triggered plan failed with `MODEL_HTTP_401` (6 rows), so automatic drafting has never worked in production; `.env.production` carries two different `ANTHROPIC_API_KEY` lines and the last one wins | `hawa.canva_design_plans` group by status/diagnostic (read-only); env key inspection (names only) | `/health` now probes the model credential with a token-free request (cached five minutes) and reports `modelProvider: unauthorized`, degrading the status. **Fixing the key is a user action (section 8).** |
| Worker `/health` always returned 200 | `apps/worker/src/index.ts` | Reports database reachability and returns 503 when the database is unreachable |
| No enforcement point for the gates (no installed CI, no hooks) | repository | `infra/ci/hooks/pre-commit` (scanner self-test, scan, pack validation) and `infra/ci/install_hooks.sh` |

### 7.3 Confirmed but deliberately left open (documented, not silently accepted)
- The in-memory approval path only rejects an explicitly failing QA report; the database path (used in production) refuses approval without a passing critical QC run. Memory mode is test-only.
- Failed or uncertain plans permanently block further automatic generation for that task (no supersede/abandon action). The requester is now told; an operator action to abandon a plan is still missing.
- Adapters write as the seeded Primary Operator user (RLS impersonation); a dedicated low-privilege adapter identity is architectural work.
- Nine routes still consult in-memory task maps first and can 404 after a restart for tasks not yet loaded.
- `.hawa-state/` holds plaintext production env snapshots on disk (gitignored). Move or delete them; they are outside the scanner by design because they cannot be committed.
- `deployment/docker-compose.yml` (validated by the pack) and `infra/docker/docker-compose.prod.yml` (deployed) remain two sources of truth.

### 7.4 Concurrent edits by the other agent observed during this session
While this session worked, the Antigravity agent staged 46 deletions and edited `canva-design-planner.ts` (a KAAE colour-rule prompt plus code that silently rewrites off-palette colours returned by the model), `chat-intake.ts` (optional tenant/user inputs), `system.routes.ts` (it rewrote my administrator guard to require an explicit header, which I kept), and `canva-connect-service.ts` (a `let u: URL` change that broke `tsc -b`; I repaired it with a direct `throw`). None of those edits were reviewed by me beyond keeping the build green; the silent colour rewrite deserves its own review because it can mask model failures as compliant output.

### 7.5 Gates after the second batch (all run at 22:40)
| Gate | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `npx vitest run` (no DB env) | 107 files passed, 4 gated skipped; 732 tests passed, 67 skipped, 0 failed |
| DB-gated suites on `hawa_repair` | 5 files, 69 tests passed |
| `python3 infra/security/security_scan.py --self-test` and scan | 10/10 patterns; 0 secrets; 38 justified allowlist hits |
| `python3 scripts/validate_pack.py` | passed (PASS count printed by the tool) |
| `docker compose … --env-file infra/docker/.env.example config` | valid |

## 8. Updated user actions (supersedes section 5 where they overlap)
1. Stop the concurrent agent while reviewing and committing; the tree changed under this session repeatedly.
2. Rotate: the Telegram bot token (BotFather), `TELEGRAM_WEBHOOK_SECRET`, `HAWA_ADMIN_KEY`, `HAWA_REVIEWER_KEY`/`HAWA_ART_DIRECTOR_KEY`, `HAWA_API_KEY`/`HAWA_BEARER_TOKEN`, `HAWA_ACTION_HMAC_SECRET`, both PostgreSQL role passwords, and the Canva token encryption key (tool provided). All of these were committed or derivable from committed files.
3. Fix `ANTHROPIC_API_KEY` in `infra/docker/.env.production`: remove the duplicate line and keep one valid key. Until then every automatic draft fails with 401, which `/health` will now show.
4. Create `infra/docker/.env` from the example (owner password and `DATABASE_URL`).
5. Decide the intake allowlist (`TELEGRAM_INTAKE_ALLOWED_USERS`); `*` is live.
6. Commit, then rebuild and redeploy core and worker with a prior `pg_dump`; then `POST /v1/system/outbox/requeue` with an administrator credential for the 18 dead-lettered commands, and watch `last_error` if they fail again.
7. Install the pre-commit gate: `bash infra/ci/install_hooks.sh`.

## 9. Third batch (23:35 Baghdad): items from section 7.3 closed
| Item | What changed | Verified by |
|---|---|---|
| Unauthenticated read routes and the Desk event stream | The other agent had already made reads deny-by-default (public: login, health, studio status, font files, Telegram status, webhooks). That would have silently broken the Desk live stream, because `EventSource` cannot send headers. `verifyRequestAuth` now accepts `access_token` as a query parameter for `/events/stream` only, and the Desk appends its session token. | negative-control test for four read routes; Desk build |
| Stuck plans blocked automatic drafting forever | Migration `010_canva_plan_abandon.sql` adds status `abandoned` (evidence stays immutable; an abandoned plan is final); `CanvaDesignPlanner.abandon` and `POST /v1/tasks/:id/canva/plans/:id/abandon` (operator+, reason required). | DB-gated test: uncertain → abandoned → new generation succeeds; tamper rejected |
| Nine handlers answered 404 for persisted tasks after a restart; `POST /tasks/:id/route` crashed with a TypeError on the same condition | `resolveTaskWithFallback` hydrates the in-memory map from PostgreSQL; applied at the nine `const task` sites and six `let task` sites; the route broadcast no longer dereferences a missing task. | new `unseeded-task-route.test.ts` (rewritten from the other agent's draft, which imported non-existent functions and defaulted to the production database URL) |
| Brand keyword routing matched substrings ('faster' → FastPay, 'corona' → Rona, 'innovation' → Nova) | Whole-word matching for Latin keywords | existing routing tests |
| Deployed compose file had no gate of its own | `validate_pack.py` now checks `infra/docker/docker-compose.prod.yml`: no credential defaults, no embedded database password, env_file on core and worker, internal core network, PostgreSQL bound to loopback | PASS=497 |
| Silent palette rewrite in the planner (other agent's change) | Corrections are counted and recorded as `paletteCorrections` in the plan's evidence manifest | typecheck; existing planner tests |

Gates at 23:35: `tsc -b` exit 0; `npx vitest run` 110 files passed, 4 gated skipped, 760 tests passed, 69 skipped; DB-gated suites 5 files, 71 tests; scanner 10 patterns, 0 hits, 39 justified fixtures; pack PASS=497; Desk build clean; migration 010 applied to `hawa_repair`.

Still open after this batch: adapters write as the seeded Primary Operator (a dedicated adapter identity is architectural); Kurdish copy is not supported by the planner (requesters are told); `.hawa-state/` plaintext env snapshots on disk; Desk sessions are in-memory (a restart logs users out, no data loss). Production still runs the pre-fix build; migration 010 must be applied to the office database before the new abandon route is used there (`DATABASE_URL=<owner url> npx tsx packages/db/src/upgrade.ts`).

## 10. Fourth batch (23:45 Baghdad): cost guard and credential visibility
| Item | What changed | Verified by |
|---|---|---|
| Open intake could spend the model budget without bound | Daily ceilings decided inside the intake transaction: `AUTO_GENERATE_DAILY_CAP_PER_SENDER` (default 5) and `AUTO_GENERATE_DAILY_CAP_GLOBAL` (default 200), counted from the last 24 h of `task.created` outbox commands. Beyond the ceiling the request is saved for the art director, the outbox payload records `autoGenerateDeclined`, and the sender is told in the acknowledgement. | DB-gated test: second request from the same chat under a cap of 1 is declined with the honest message; the first is scheduled |
| A revoked or stale bot token would only show as a silent poll loop | `/health` probes `getMe` at most every five minutes and reports `telegramApi: connected / unauthorized / unreachable`; unauthorized or unreachable degrades the status | typecheck; probe disabled under vitest |
| Worker health said nothing about the queue | Worker `/health` reports `outbox.pending`, `outbox.staleOver5m` and `outbox.failed` for the office tenant; backlog or dead letters mark it `degraded` (still 200), an unreachable database 503 | typecheck |

Gates at 23:45: `tsc -b` exit 0; full suite 110 files / 760 tests green (4 gated files skipped without env); DB-gated suites 5 files / 72 tests; scanner 0 hits; pack valid; example env documents the two new variables.

## 11. Fifth batch (23:55 Baghdad): durable Desk sessions
| Item | What changed | Verified by |
|---|---|---|
| Desk sessions lived only in memory: a Core restart logged every operator out, and a second instance could not honour a session issued by the first | Migration `011_desk_sessions.sql` (token stored as SHA-256 only, tenant-scoped RLS). Login persists the session (`durable: true` in the response), logout revokes it in the database, the guard preloads unknown tokens from PostgreSQL before authentication, and cached sessions are re-checked every minute so a revocation on any instance takes effect. Database trouble never logs users out: the cache keeps serving. | DB-gated test: session issued on one app instance is accepted by a fresh instance; revocation on the second instance is recorded and refused |

Gates at 23:55: `tsc -b` exit 0; full suite 110 files / 760 tests green; DB-gated suites 5 files / 73 tests; scanner 0 hits; pack valid. Migrations 010 and 011 are applied to `hawa_repair` and must be applied to the office database at redeploy (`DATABASE_URL=<owner url> npx tsx packages/db/src/upgrade.ts`).

## 12. Sixth batch (00:10 Baghdad, 14 September): deployment path and configuration truth
| Item | What changed | Verified by |
|---|---|---|
| `infra/docker/deploy.sh` silently copied the example file into `.env.production` on a fresh host and never deployed | Rewritten: refuses missing configuration and placeholder or duplicate credential lines, validates compose with the real interpolation file, runs the gates; `--apply` adds a `pg_dump` snapshot, versioned schema upgrades, build, start and a health check that fails on `unauthorized`, `unreachable`, `disconnected`, `read_only` or `outage` dependencies | `bash -n`; pre-flight executed against the live configuration |
| **Live configuration finding:** the pre-flight refused the current `infra/docker/.env.production` because `POSTGRES_PASSWORD` and `WAHA_API_KEY` still hold placeholder values. This confirms the owner password in use is the old compose default, and that the WhatsApp adapter has never been configured although `/health` reported it active. | pre-flight output (values not shown) | **User action:** set real values (section 8) |
| Security-relevant variables read by the code were undocumented | `.env.production.example` documents the office API keys, the HMAC secret, the WhatsApp secret, the public and internal URLs; `validate_pack.py` now fails if any of sixteen security-relevant variables disappears from the example or if the example carries a credential-looking value | PASS=497 |
| A degraded polling bridge (three consecutive Telegram failures) was reported as `active` | `/health` reports `telegram: degraded` plus the last error code and degrades the overall status | typecheck; full suite |
| Operators had no written procedure for rotation, redeploy, dead letters or stuck plans | `docs/25_OPERATIONS_RUNBOOK.md` gained four sections | pack validation |

Gates at 00:10: `tsc -b` exit 0; full suite 110 files / 760 tests green; scanner 10 patterns, 0 hits; pack PASS=497; deploy pre-flight refuses the current production configuration for the right reasons.

## 13. Seventh batch (00:45 Baghdad, 14 September): honest attribution, local credential material, preview regeneration
| Item | What changed | Verified by |
|---|---|---|
| Every adapter and automation write was attributed to the human **Primary Operator** (`requested_by`, `actor_id`, session bookkeeping, publisher audit), and the ingress persistence adapter opened its transactions as `administrator` | ADR-027: two seeded service identities, **Channel Ingress** (`…b000-000000000010`) and **System Automation** (`…b000-000000000011`), defined in `@hawa/contracts`, seeded by `db/seed.sql` and migration `012_service_identities.sql` (operator role on every tenant present at migration time). Chat intake, ingress persistence, unified ingress, the legacy `create()` path, chat-trigger approvals and publishing transitions now write as Channel Ingress; session bookkeeping, task hydration reads, workflow completion and publisher audit entries as System Automation. The ingress adapter runs as `operator`. Human credential resolution is untouched. | `packages/contracts/test/identities.test.ts`; DB-gated intake test asserts a Telegram task's `requested_by` is Channel Ingress and not the Primary Operator; `schema-upgrade.test.ts` verifies 012 applies once |
| **Defect of batch 6:** `deploy.sh --apply` wrote the production `pg_dump` into `infra/backup/snapshots/`, which git did not ignore; a later `git add -A` would have committed briefs, chat ids and sealed tokens | `infra/backup/snapshots/` is gitignored; the dump is written under `umask 077` into a `700` directory | the new audit script reports `COMMITTABLE` for any such file |
| Plaintext credential material outside git was invisible to every gate (the scanner sees committable files only) | `infra/security/local_state_audit.sh` lists env files, deployment snapshots, database dumps and container inspections with their mode, never values; the deploy pre-flight fails while any is readable by other users or committable. Finding on this host: 14 files, of which two were world-readable (`.env` with three model API keys, `infra/docker/.env` with the database password); both are now `0600`. Nothing was deleted: `.hawa-state/` still holds three full database dumps, three env snapshots and one container inspection with every runtime secret | script output before and after |
| A revised Telegram preview was abandoned whenever a text style carried a numeric font weight: `escapeXml` threw `unsafe.replace is not a function`, the bridge caught it, and the requester received text only (visible as a warning in every suite run) | `escapeXml` accepts any value | `packages/creative/test/operations-to-svg.test.ts` |
| The shared `hawa_test` database (plain `pnpm test`) has never had the versioned upgrades and cannot take them (an older Canva binding foreign key fails on its data) | Recorded; the two service rows were inserted there directly so the plain suite exercises the new identities. The gated suites on `hawa_repair` remain the only proof of the versioned schema | `upgrade.ts` output on both databases |

Gates at 00:45: `tsc -b` exit 0; full suite 112 files / 764 tests green (4 gated files skipped without env); DB-gated suites 5 files / 73 tests on `hawa_repair` with migration 012 applied; scanner 10 patterns, 0 hits; pack PASS=501. Migration 012 must reach the office database at redeploy (`deploy.sh --apply` applies it). User-only actions are unchanged (section 8) plus one: after rotation, move or delete the 14 files listed by `bash infra/security/local_state_audit.sh`.

## 14. Rotation, commit and redeploy (00:20 to 00:35 Baghdad, 14 September): executed
Performed with no second agent on the checkout. Values were generated with `openssl rand`, written straight into the env files and never printed.

| Step | Result | Proof |
|---|---|---|
| Commits | `70a2a77` (retired archive and reflow engine removed; also untracks the 13 gitignored `tsbuildinfo` files), `e6cd139` (seven remediation batches, 146 files), `a6df5e3` (build commit wiring) | pre-commit hook ran the secret scan and manifest validation on each |
| Test database credentials out of git | `vitest.config.ts` reads only four database variables from the process environment or a gitignored `.env.test`; `.env.test.example` documents them; allowlist entry removed | scanner 0 hits with an empty allowlist for that file |
| Rotated | `TELEGRAM_WEBHOOK_SECRET`, `HAWA_ADMIN_KEY`, `HAWA_ART_DIRECTOR_KEY`=`HAWA_REVIEWER_KEY`, `HAWA_BEARER_TOKEN`=`HAWA_API_KEY`, `HAWA_DESK_SECRET`, `HAWA_ACTION_HMAC_SECRET`, `CANVA_TOKEN_ENCRYPTION_KEY`, both PostgreSQL role passwords (`ALTER ROLE` in one transaction) | new owner, app, test and repair connections OK; old owner password refused; old admin key answers 401 on the live API |
| Canva tokens re-sealed | one stored connection re-sealed under the new key | dry run then apply; a second dry run with the old key fails to authenticate the data |
| Configuration corrected | invalid 34-character `ANTHROPIC_API_KEY` line removed (the valid key answers 200); vestigial `POSTGRES_PASSWORD` placeholder removed; WhatsApp placeholders removed so `/health` says `waha: unconfigured`; dead trycloudflare URLs replaced by the local nginx address; `TELEGRAM_INTAKE_ALLOWED_USERS` set to the same single allowed user instead of `*` | deploy pre-flight passes; health shows `modelProvider: connected`, `telegramApi: connected` |
| Redeploy | `deploy.sh --apply`: 26.6 MB `pg_dump` snapshot, migrations 010, 011, 012 applied, three images built, containers recreated, health `healthy`, release reports commit `a6df5e3` | deploy log; `GET /v1/system/cutover/status` |
| Dead letters | all 18 were synthetic verification tasks from earlier audit scripts (no chat, no automatic draft). One was requeued through the new admin route and delivered (Restate accepted it: the dispatcher fix holds); the other 17 were marked `dead` with a written reason rather than spending 17 model runs on fixtures | worker health `healthy`, `outbox.failed: 0` |
| Live English brief to the operator's own chat | task attributed to Channel Ingress, scoped to KAAE, automatic draft scheduled; Opus 5 plan, PPTX import created design `DAHVHRkk5UY`, binding recorded, PNG and PPTX exports retrieved, capture `unverified`, approval not ready | `GET /v1/tasks/33c1bc0b…/canva`; Telegram delivery of the status message itself was not observable from this side |
| Live Kurdish brief | intake accepted it and saved it for manual design because the sender's daily ceiling (5) was already reached by earlier sessions; the manual art-director path refuses it with `COPY_UNSUPPORTED` before any model call | 422 from `POST /tasks/…/canva/generate` |
| Local credential material | `.hawa-state/` (dumps, env snapshots, container inspection, rotation record) moved to `~/Hawdesign-local-state-2026-09-14/` (mode 700), nothing deleted; the deploy snapshot stays under the gitignored `infra/backup/snapshots/` | audit script |

Gates after rotation: full suite 114 files / 823 tests green with the gated suites now included by `.env.test`; typecheck 0; scanner 0; pack valid.

Still yours, because they live in third-party consoles: the Telegram bot token (BotFather), `CANVA_CLIENT_SECRET` (Canva developer portal), `GOOGLE_SERVICE_ACCOUNT_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`; all five were in the container inspection that sat in `.hawa-state/`. A real public URL for Desk links (the tunnel is dead), and the choice to delete the moved state directory once you no longer need the pre-rotation backups. Your new Desk keys are in `infra/docker/.env.production` on this machine.

## 15. Corrected root cause: the test suite was rewriting production credentials (00:50 Baghdad, 14 September)
Sections 6 and 14 described the invalid, duplicated `ANTHROPIC_API_KEY` line in `infra/docker/.env.production` as a configuration mistake. That reading was wrong. Minutes after the redeploy, the file held a single 34-character key beginning with `mock-` again, while the running container still had the valid 108-character key. Nginx had seen no request. The writer was `POST /v1/system/providers`, whose candidate paths include the working directory's `infra/docker/.env.production`: the core test `manages system provider credentials` posts `mock-test-anthropic-key-…` and `mock-test-openai-key-…` to an in-memory app, and the route wrote them into the real file. Every `pnpm test` run corrupted production configuration; the production 401s from the model provider, the mock OpenAI key and the re-appearing `WAHA_ENDPOINT` line all came from this.

| Item | What changed | Verified by |
|---|---|---|
| Route wrote files | `POST /v1/system/providers` verifies each key against its provider (Telegram `getMe`, Anthropic, Google, OpenAI model listings; format checks for WAHA), refuses with 422 `PROVIDER_KEY_REJECTED` without echoing the value, activates accepted keys in the running process only and reports `persisted: false`; `fs`/`path` removed from the module | two new tests: the env file and `.env.local` candidates are byte-identical before and after a POST; a provider refusal returns 422 and leaves the environment unchanged |
| Desk claimed persistence | Settings screen says the key is active until the next restart and names the persistent path (`rotate_external_secrets.sh`); provider refusals are shown verbatim | Desk build in the deploy |
| Production file | restored from the running container's environment (valid key), mock OpenAI and WAHA lines removed | `rotate_external_secrets.sh --check`: Telegram ok, Anthropic ok, Gemini ok |
| Proof | SHA-256 of `infra/docker/.env.production` identical before and after a full suite run (`113458ad…`) | this section |

Commit `fc91145`; redeployed afterwards. Not a real credential and nothing to rotate: `OPENAI_API_KEY` (a test fixture, now removed) and `GOOGLE_SERVICE_ACCOUNT_KEY` (a two-field stub without a private key, so Google publishing is not configured). Real and still in your hands: the Telegram bot token, `CANVA_CLIENT_SECRET`, `GEMINI_API_KEY`; `bash infra/docker/rotate_external_secrets.sh` takes each new value with hidden input, verifies it, writes the file and redeploys.

### 15a. Console rotation attempt (01:45 Baghdad, 14 September)
The user ran the helper: Telegram token and Gemini key were left unchanged; the Canva client secret that was written was refused by Canva (`invalid_client`) while the previous one was still accepted. The helper had verified only the format, which was insufficient. The accepted secret was restored, core and worker recreated, and the helper now verifies a Canva secret with Canva's token endpoint before writing it (commit `72c4027`). Pre-rotation backup folders deleted at the user's request after confirming the live file is verified and identical to the last rollback copy. Still owed: Telegram token, Canva client secret, Gemini key.

### 15b. Final state of the console rotations (02:00 Baghdad, 14 September)
Second helper run: Telegram token rotated and the old one confirmed dead; Anthropic and Gemini keys rotated and verified live. The user then stopped. Accepted, with reasoning:
- **Canva client secret not rotated.** The live secret is the original; Canva accepts it; the connection is active and its tokens are sealed under the rotated key. Exposure of the secret was limited to owner-only files on this machine, now deleted. Rotate later through the helper (which now verifies with Canva) when convenient; nothing depends on it.
- **Old Anthropic and Gemini keys still valid in their consoles.** The new keys are the only ones in use here; the old ones sat in the same deleted local files. Deleting them is two clicks each (console.anthropic.com API keys; aistudio.google.com/app/apikey) and is the one remaining risk worth closing, because a live unused key can spend money if it ever leaked elsewhere.
All rollback folders deleted; the local audit reports no exposed or committable credential material.
