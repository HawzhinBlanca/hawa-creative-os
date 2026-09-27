# Live pilot prerequisites and migration rehearsal — 2026-09-27

Runtime candidate: `be2b70c` (font-QA implementation `67c8ce8`).
**Real office pilot and production release remain unqualified.**

## Observed live state

The read-only preflight found healthy production HTTP/Canva connection, 22 applied
migrations out of 46, and no configured Google Workspace reviewer OIDC fields.
Production images have no recorded OCI revision label, so their exact source
identity is unknown. The prior isolated candidate was `a3de8c3`.

`preflight-initial.json` preserves two probe mistakes: `/health` reached the nginx
HTML route instead of `/v1/health`, and two guessed table names did not correspond
to the actual migration schema. They are not application failures. The corrected
`preflight.json` uses actual table names and records HTTP 200 / healthy.

## Live-data migration rehearsal

`migration-2026-09-27T03-26-47.870Z.json` is the accepted SHA-256 run. The earlier
03:25 run used MD5 comparison and remains historical; the current recipe uses
SHA-256 for every row and aggregate comparison.

1. Open a repeatable-read, read-only transaction on live PostgreSQL 17.11 and
   export its snapshot. Freeze existing table columns and aggregate fingerprints.
2. Stream `pg_dump --snapshot` into `pg_restore --single-transaction` on a fresh,
   randomly named database in the separate `hawa-test-postgres` server. Compare
   the restored copy against all 76 source tables from that same snapshot.
3. Run the actual current `upgradeCanvaSchema` against the isolated target.
   All 24 pending migrations (023–046) apply; the 22 existing checksums match.
4. Compare every historical row using only its original columns. All 76 tables
   match, including 1,612 tasks, 110 approvals, 47 publications, 198 revisions,
   117 QC runs, 152 inbox events and 1,626 outbox commands. Only the expected new
   migration receipts and voice-transcriber role are excluded from old-row comparison.
5. Reinvoke the upgrade: zero migrations applied, all 46 verified. Legacy tasks
   retain Core ownership; no named sessions or reviewer assignments are invented.
6. Read the current task-list query as `hawa_app` under the existing operator's
   RLS scope: 20 returned from 1,600 visible tasks. This is a bounded read check,
   not a full authorization matrix.
7. Drop the temporary private database. Both runs confirm cleanup. No live dump,
   row contents, keys or private configuration was written to host artifacts.

The accepted stream was 338,707,264 bytes; the whole rehearsal took about 21 s.
The SQL upgrade itself took 81 ms on this test server. These timings **are not**
production downtime, RPO or RTO promises. The test server disables durability;
this is schema/data compatibility evidence, not power-loss or clean-host recovery.
No production migration, app restart, approval, model call or message occurred.

## Fresh deployed candidate

The normal isolated candidate command rebuilt and started Core, Desk, worker,
nginx, PostgreSQL, Restate, real offline Docling and synthetic external providers.
The rehearsal passed **36/36 invariants**, covering PDF/voice source handoff,
duplicate intake, Restate/worker restart, bilingual exact copy, manual/blank Canva
capture, task closure controls and simulated approval/publication. Vitest reports
1 selected scenario passed and 43 deliberately unselected scenarios skipped.

`candidate-rehearsal.json` preserves exact images, timestamps, events and scope.
`candidate-font-qa.json` additionally reads four checked tasks through deployed
nginx/Core: list/detail agree on family evidence and RTL visual-review state,
and glyph coverage is null throughout. Core/Desk/worker image labels all match
`be2b70c`; runtime source changes are empty. The candidate remains at
`http://127.0.0.1:56081` with **synthetic providers and identities**. Production
remains at `http://127.0.0.1:8080` with its existing schema/images.

## Remaining prerequisites

- Register/configure the office's reviewer OAuth client, allowed Workspace domain
  and HTTPS callback; bootstrap verified identities/memberships and reviewer scope.
  A domain question is pending with the user. Never manufacture a Google subject.
- Retain and verify the production backup and rollback artifacts before cutover.
  This disposable database copy is not a production recovery package.
- Qualify the exact production candidate and migrations, then run a real office
  brief through native Canva editing, human review and verified delivery.
- Finish native Sorani/Arabic review, real office corpus, independent-host/off-host
  recovery, and held-out design/retrieval/model quality-cost measurements.

No release, native-language approval, real delivery or 10/10 conclusion follows
from these migration and simulated workflow results.

## Commands used

```sh
node --import tsx output/acceptance/2026-09-27-live-pilot/preflight.mts
node --import tsx output/acceptance/2026-09-27-live-pilot/migration-rehearsal.mts
node --import tsx packages/testkit/chaos/run.ts --candidate --only R1.S3.SOURCES --poller worker --keep
node --import tsx output/acceptance/2026-09-27-live-pilot/check-candidate.mts
```

The migration script refuses a changed live migration baseline or target outside
the dedicated test container/port. It creates a fresh private clone and removes
it in `finally`. A hard process/host crash still requires checking the recorded
target database for cleanup; do not infer cleanup from a stale receipt.
The candidate command replaces only the disposable `hawa-chaos` stack.
