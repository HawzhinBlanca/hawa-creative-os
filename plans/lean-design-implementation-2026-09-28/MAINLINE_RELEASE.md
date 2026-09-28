# Mainline release record (2026-09-28)

Owner's decision, 2026-09-28: `codex/research-grade-design-system` is the mainline. This release is that
branch at `7b8de71e` (Codex, ADRs 038-121) plus Claude's continuation after Codex's usage limit:
ADR-122..126 (lean-design packages), ADR-127 (studio-v2 integration: client packs, CI, deploy retry,
Canva panel poll, load test and runbook, file-store fixes), ADR-128..130 (Phase 4 security, operations
and lifecycle fixes), two build/test fixes and the chaos driver brought up to the branch's rules.
studio-v2's own history is recorded with a merge that keeps this tree (every studio-v2 commit is
accounted for in ADR-127 and STUDIO_V2_INTEGRATION_PROOF.json; its RequestLifecycle and migration 023
are superseded by this branch's own).

## Gate

| Check | Result |
|---|---|
| `pnpm build`, Desk build | pass |
| `pnpm run typecheck` (source, scripts, strict test roots), `pnpm run lint` (explicit any 957 of 1,053; provider egress) | pass |
| Full unit suite, `HAWA_TEST_WORKERS=3` | 4,820 passed, 60 skipped; 1 failed before the release manifest (r11-release-gate). The triage agent's later run had one extra timeout, `durable-evaluations.test.ts` at 30 s under load, which passes 13/13 alone. |
| Chaos, production mode (Core poller, flags off), `70be33b2` | 17 of 19 pass (685 s, peak 1,060 MiB). Fail: R1.K14 and R4, the documented legacy baselines (WAVE3A_EVIDENCE.md). |
| Chaos, `--poller worker`, `70be33b2` | 42 of 43 pass (1,079 s, peak 1,059 MiB). Fail: R1.K14, the legacy baseline. |
| Migrations 023-066 on the 2026-09-28 nightly dump restored into a scratch database on the test server | 44 applied in 0.70 s; 1,612 tasks and 2,090 events unchanged; a second run applied 0 and verified 66; scratch database dropped. |
| Worker image | builds (it did not at 7b8de71e: `spawnSync pkg-config ENOENT`, fixed in 497b5255) |

Chaos triage found no product defect: every failure it fixed was the driver or an invariant predating a
documented rule of this branch (3e900a08 approval pins, 82b28988 local intake classification, ADR-045
sent-mark retry, ADR-052/059 executor pinning, ADR-065 request-owned delivery, ADR-113/114 native
revision handoff, ADR-043/045/046 uncertain sends held for staff).

## Production configuration checked before deploy (names and hashes only, no values)

- `HAWA_GOOGLE_OIDC_*` unset: named-reviewer mode (ADR-064) stays off; shared-key Desk approvals keep working.
- `HAWA_WORKER_TOKEN` is 64 characters and equals no other key; `HAWA_DEV_TOKEN` is unset (ADR-128).
- `HAWA_LIFECYCLE_CHATS` empty and `HAWA_TELEGRAM_POLLER=core`: every lifecycle path stays off.
- The compose file adds no required variable production lacks.

## Deliberately not done here

No paid model runs, no live Canva native operation, no human quality study, no Google sign-in
configuration, no Restate backup enablement, no release-B blob keys. Each needs the owner (see the
ledger and each proof's `next`).

## Deployed (2026-09-28 16:50 +03)

`bash infra/docker/deploy.sh --apply` from the main checkout at `b94de6a6`, after a Restate check showed
no invocation in flight. Pre-deploy dump `predeploy_20260928T135006Z.dump` (48,339,287 B); migrations
023-066 applied; Core, Desk and worker-green images stamped with the release; Restate routes new work to
green (`dp_10SVKnLdqCV8uoaQFN4XpBv`), blue drained and stopped; nginx and Vector on their deployed
configuration; release receipt `infra/backup/release-receipts/deploy_20260928T135006Z_b94de6a63be4.json`.
Afterwards: green worker healthy, `background: live`, `outboxActive: true`; Desk 200; GET /v1/tasks
answers (1,600 tasks); no error lines in Core or the worker.

Two earlier attempts stopped inside the release gate, before any change to production: the branch had
no upstream (published to origin), and the gate's suite, which runs in the main checkout, failed a
watchdog test that read production's `.env.production` and logged its bot token into the (gitignored)
gate log; nothing was sent (curl was stubbed). The log was redacted and the test fixed (c6dd90ce).

After the deploy, Core's status is "degraded" only because Canva and the model provider are
"unverified" (e981e59f: no scheduled paid probe runs while `HAWA_BILLING_PROBE_ENABLED` is off). The
watchdog now pages only for named failures (96821a92); `watchdog.sh --status` reads healthy.

## Second deploy: ADR-131 and studio-v2 history (2026-09-28 17:45 +03)

studio-v2 gained two commits during the day (50b3a94a request_logs, 0a2acd0a ADR-131 planning slots),
both ported onto the mainline (089b7bea; c2eb23a4, cebe5dbd). With every studio-v2 commit accounted
for, its history was merged keeping the mainline tree (a7350009) and origin/studio-v2 fast-forwarded to
the release `0bbbf81a`; codex/research-grade-design-system is the same commit. ADR-131 on the mainline:
10 briefs at once, p50/p95 brief to first draft 8.1/9.4 s with instant plans and 65.4/97.4 s with 30 s
plans (chaos load test; 2 slots on studio-v2 measured 11.2/35.4 s and 125.4/245.6 s). Full suite
4,844 passed, only the release-manifest test failing before the manifest; release gate passed.
Deployed with no invocation in flight: Restate routes to blue (`dp_13w77Jmt5o7Ko35otsdydyh`), green
drained and stopped, blue `background: live`, `outboxActive: true`, Desk 200, watchdog healthy.
