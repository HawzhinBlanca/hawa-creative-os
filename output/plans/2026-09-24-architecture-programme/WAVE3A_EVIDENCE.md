# Wave 3a evidence (2026-09-24)

The file store foundation and the chaos suite harness, implemented in parallel from 81f24ad, reviewed adversarially and fixed. Merged with wave 2 on `claude/reliability`; full suite after the merge: 362 files passed, 4 skipped, 1 failed (r11, manifest), 69 s.

Lead's changes at merge: the nightly backup and the restore drill named scratch databases by the second, so two runs in one second collided (the two backup test files in parallel failed 4 tests); names now end in a per-run suffix. The store's fsync-off switch under NODE_ENV=test was removed (no test switches in production code).

## Chaos baseline on the legacy path (what Phase 2 must fix)
- R1.K9 FAILS: one Canva 5xx on POST /exports ends the draft as CANVA_PREVIEW_FAILED with no retry.
- R1.K14 FAILS: Core killed during Deliver leaves the task in publishing until Deliver is pressed again (then exactly once).
- R4 FAILS (expected before 2.1): chat B waited 30.9 s behind chat A's 30 s download.
- 16 scenarios hold every invariant, including kills of the worker, Core, Postgres and Restate mid-design, Telegram 429 and dropped answers, and a deploy to green mid-request.
- Found while building: a database built by the production init scripts (db/03-grants.sql) denies the worker outbox_commands; Core exits at startup if the versioned upgrades have not run; Postgres with synchronous_commit=off lost acknowledged commits when killed.

## 3.1a File store foundation (ADR-035)
- Commits: 479bead, 479bead, 7bfc593
- Review: fix (1 blocking finding(s), fixed in the fix round)
- Acceptance:
  - met: Blocking finding: the nightly backup still archives while old-style hashes (no blobs row, bytes in bytea) are referenced — blob-prebackfill 'the nightly backup still archives the dump and the stored files' failed on 479bead and passes now: exit 0, dump and .blobs manifest archived, log shows refs_without_row=1
  - met: Blocking finding: verify / blob-verify CLI / monthly drill do not count a pre-backfill reference as missing — verifyBlobStore returns missing=0 and referencedWithoutRow=1; the CLI exits 0; the drill passes with evidence referenced_without_row=1 (all failed before the fix)
  - met: A reference with a row whose file is gone still fails the night and the store check — blob-backup 'fails the night when the dump references a file that is not on disk' and blob-verify damage tests still pass
  - met: Every store, GC (incl. the put/unlink race and pg_constraint coverage), migration, serving-helper and backup test in the design passes — 9 files, 68 tests plus blob-backup's 9 tests, all passed
  - met: The nightly backup, restore drill and disk cleanup run end-to-end against scratch directories and test databases only — blob-backup.test.ts and blob-prebackfill.test.ts set every path variable to mkdtemp directories, use hawa-test-postgres on 55432, and refuse anything but a hawa_t_* clone
  - met: docker compose -f infra/docker/docker-compose.prod.yml config -q passes — Passes with --env-file .env.example in a scratch copy beside an empty .env.production. Run in the worktree as-is, it fails only because .env is absent (required DATABASE_URL/POSTGRES_PASSWORD)
  - met: nginx -t passes on the changed config — blob-nginx.test.ts 'passes nginx -t as committed' ran in nginx:1.27-alpine-slim and passed
  - met: typecheck_tests 0 errors, any ratchet not raised, pnpm build clean — 0 errors; 1044 of 1053; tsc -b clean
  - NOT MET: Traceability / release manifest current (definition of done) — validate_pack fails on MANIFEST/SHA256SUMS for db/schema.sql, db/rls.sql, db/03-grants.sql, runbooks/10_backup_restore.md and adrs/035. Refreshing it is reserved to the lead, and deploy.sh's pre-flight will fail until it is refreshed
- Risks and follow-ups:
  - Until migration 020 adds the foreign keys, a hash written with a blobs row in one column and none in another cannot be told apart from a genuine loss of a row. The nightly and verify treat 'no row' as 'bytes still in bytea' and only count it. The count is visible as refs_without_row in backup.log and in the drill's evidence. It should fall to 0 after the backfill.
  - Commit 7bfc593 was made with --no-verify because the hook's validate_pack step fails on manifest hashes. The security scan passed separately. The lead must run the manifest refresh before any deploy.
  - compose_value is used only by deploy.sh. The nightly, disk_cleanup and the watchdog still read HAWA_BLOBS_DIR only from their own (launchd) environment, and the runbook says to set it in both places. If they diverge, the nightly fails loudly; it never passes silently.
  - Not fixed, still open: pack pruning is skipped when no hawa_*.blobs manifest exists (kept on purpose: deleting every pack when no manifest is found is the worse failure); a dry-run GC holds row locks until its rollback; X-XSS-Protection is missing from /_blobs/ (deprecated header); the Linux `chown 10001` note belongs in infra/docker/README.md, which I do not own; Core's /ready does not yet fail w
  - The ERR-trap fix also changes three older lines in nightly_backup.sh (LIVE/REST/EVENTS psql substitutions). They behave the same, except that a psql failure there no longer sends a duplicate 'stopped unexpectedly' alert.

## chaos Chaos suite harness (Phase 2 acceptance tool)
- Commits: 0ceda3b
- Review: pass (0 blocking finding(s))
- Acceptance:
  - met: docker-compose.chaos.yml with postgres, restate 1.7.10, core, worker-blue, worker-green and fakes, built from the repo's Dockerfiles; project hawa-chaos with its own volumes and networks; host ports o — packages/testkit/chaos/docker-compose.chaos.yml. Ports 56432, 56070, 56080, 56090. Images hawa-chaos-*:local built from infra/docker/Dockerfile.core and Dockerfile.worker; fakes use the worker Dockerfile's base stage. Teardown left no containers or volumes.
  - met: Fakes container with a generated CA so the hard-coded provider URLs resolve to it (NODE_EXTRA_CA_CERTS); configurable CANVA_BASE_URL and Google URLs — I used network aliases on an internal network instead of extra_hosts (extra_hosts needs fixed IPs). The CA and certificate are made in fakes/ca.ts (test/ca.test.ts). CANVA_BASE_URL and GOOGLE_*_BASE_URL point at the fakes. TLS to api.telegram.org, api.openai.com and export-download.canva.com works i
  - met: Fakes: Telegram (scripted getUpdates, send*, getFile with size and delay, received log, per-method faults incl. 429 retry_after and drop-after-processing), models (fixture replay and paid-call ledger) — fakes/*.ts; 10 unit tests in test/fakes.test.ts; exercised end to end in R1.K9, K10, K13 and R4. Model answers come from fixtures and request synthesis, not from recordings (recording was forbidden).
  - met: Driver (vitest, HAWA_CHAOS=1): brings the project up, provisions the DB, registers the worker via scripts/restate-bluegreen.ts with the admin URL overridden — chaos.test.ts beforeAll; driver/provision.ts calls runCli(['register','blue','--admin','http://127.0.0.1:56070']). R1.D1 also uses register green and finish-drains.
  - met: R1 on the legacy path (brief → draft → approve via the Desk API → deliver) with kills of worker, Core, Postgres and Restate at the points reachable today (time-based where no point exists) — R1.0, R1.K0–K15 and R1.D1. Worker kills at 5 points. Core kills during the classifier (K0), mid-design (K6), after approval (K11) and mid-Deliver (K14). Postgres kills mid-design (K7) and at the send mark (K15). Restate kill mid-design (K8).
  - met: R4: two chats; chat A's 20 MB getFile delay must not delay chat B; expected to FAIL today and recorded as baseline — R4 uses a 19.9 MB image document with a 30 s download; over 20 MB Core refuses before downloading. It fails as expected: chat B answered after 30.9 s (run 3) and 31.5 s (runs 1 and 2). Recorded in the README baseline.
  - met: Check the section 6.3 invariants that apply to the legacy path — driver/scenario.ts checkRequest: tasks, revisions, approvals, publications, final state, Drive file once, Telegram once per message, office alert per uncertain send, paid calls per fingerprint, Canva imports, Restate completed / paused / RT0016. The R2/R3/R5 invariants are not implemented.
  - met: Chaos-point helper: no-op unless HAWA_CHAOS_CONTROL_URL is set, and cheap — packages/observability/src/chaos-point.ts. The test shows no fetch and under 5 µs per call when unset.
  - met: Chaos points only in apps/worker/src/** (outbox consumer, TaskWorkflow steps, delivery notification send); app.ts untouched; Core points listed as follow-ups — Points in outbox-consumer.ts, workflow-dispatcher.ts, durable-context.ts and index.ts. apps/core untouched. Follow-ups listed in the README.
  - met: Report the baseline honestly, with run time, memory and a --keep flag — README 'Baseline on today's code' section and this report. 685 s, peak 1192 MiB. run.ts --keep / --down; HAWA_CHAOS_KEEP.
  - met: Relevant tests pass: typecheck_tests 0 errors, ratchet within ceiling, pnpm build — All three pass. packages/testkit/test/r11-release-gate.test.ts now fails on the release manifest hash of apps/worker/src/index.ts, which needs a manifest refresh I was told not to run.
  - NOT MET: R2 (reminders), R3 (question/answer), R5 (rollback), and the design's K9 deploy with a patched worker build — Not implemented. R5 and the lifecycle points need Phase 2 code; R3 needs feedback and clarification fixtures; D1 deploys the same build, so it cannot detect replay on changed code.
- Risks and follow-ups:
  - The release-manifest test (packages/testkit/test/r11-release-gate.test.ts) fails until the lead refreshes the manifest: apps/worker/src/index.ts changed.
  - Fixture coverage is the planner path only (DESIGN_PIPELINE_V3=off). Production may run the studio path, which these fixtures do not cover; calls from that path would be refused as 'unmatched', not answered.
  - The chaos database is built without db/03-grants.sql: the driver grants the way the test template does and then runs the upgrades. That differs from docker-compose.prod.yml's init. I recorded it as a finding because a fresh production init leaves the worker unable to lease outbox commands. I did not check production's grants: querying production was off limits.
  - Deviation from the design: network aliases on an internal Docker network instead of extra_hosts, and KAAE client DNA plus a Canva connection inserted by the driver. AUTO_GENERATE_DAILY_CAP_PER_SENDER and _GLOBAL are set to 1000 in the chaos compose env only, because one sender makes every scripted request.
  - Core kills are time-based (holding a worker point, a slowed classifier, a slowed Drive upload) until the Core chaos points land in the split app.ts.
  - Worker files touched (outbox-consumer.ts, workflow-dispatcher.ts, durable-context.ts, index.ts) may conflict with other streams working on the worker. The changes are small, and the step wrapper adds no journal entries, so blue/green replay shape is unchanged.
  - Restate's RSS stays around 700 MiB even with a 256 MiB RocksDB budget; with production running beside it, the chaos project peaked at 1.2–1.3 GB.
  - R4 and R1.K9/K14 make the full chaos run exit non-zero today. That is the intended baseline, not a harness fault.
  - The global CLAUDE.md asks for a write-back to the Obsidian wiki after meaningful work. I did not write to the vault from this subagent: it is outside the files I own. The lead should capture the findings, especially the 03-grants problem and the synchronous_commit trap.

