# Independent office availability observations

Requirements: NFR-002, FR-064, NFR-006. Decision: ADR-104.

## What this measures

The standalone Python collector checks the office edge, built Desk HTML/module/CSS,
intake/review storage access, a rolled-back isolated write/read/update witness,
registration of all eight workflow services and at least one active worker with
connected PostgreSQL and no stale outbox. It never creates a task, approves a design,
calls a model, publishes files or sends a message.

The indicator is **sampled office readiness**, one observation per closed UTC minute.
It does not prove the full browser journey, native Canva editability, live delivery
or design quality. Its latency is successful probe round-trip latency.

Use a physically independent Linux/macOS host with trusted office HTTPS access and
synchronized UTC time. A same-host installation misses host outages; those slots
remain unknown. Local fake-provider tests do not establish production availability.

## Configure and start

1. Apply migration 058 using the existing reviewed schema-upgrade procedure. The
   normal runtime role remains `hawa_app`; the service automation user must retain
   active office membership. No historical observations are seeded.
2. Generate a dedicated UUID and a random secret of at least 32 characters. Store
   the secret in protected environment files on Core and the collector host, never
   in commands, source, screenshots, logs or the browser. It must differ from all
   office, worker and webhook credentials.
3. Set `HAWA_AVAILABILITY_MONITOR_ID`, `HAWA_AVAILABILITY_TARGET_ORIGIN` (exact origin,
   no trailing slash/path/query/credentials) and `HAWA_AVAILABILITY_MONITOR_SECRET`
   on both processes. Core also needs `HAWA_AVAILABILITY_WORKER_URLS`, a comma-separated
   list of at most four trusted `/health` URLs. Production Compose supplies the blue
   and green worker URLs. One absent colour is allowed if the other is active.
4. Copy the reviewed `infra/monitoring/availability_collector.py` to that host. Use
   Python 3.12 or later; no pip dependencies. Create a private persistent directory
   for its spool. Inject the protected environment through the host service manager.
5. Run the first observation and inspect the result:

   ```sh
   python3 infra/monitoring/availability_collector.py --spool /var/lib/hawa-monitor/observations.sqlite --once
   ```

6. Start the same command with `--run` under the host's existing process supervisor,
   with automatic restart on failure. `--once` can instead run every minute from
   that supervisor. Do not put a secret in the command line. Do not run two collectors
   for one monitor identity. The exclusive OS lock refuses a second local owner.
7. Open Desk Operations. Verify the correct target and monitor UUID, the received
   observation, fresh collection, coverage and explicit missing earlier minutes.
   Only closed minute slots contribute; the newest in-flight minute is excluded.
   Record the collector host identity, source revision and start date in admission
   evidence before beginning a real monthly observation period.

No service job is installed by the application migration or qualification tests.
The existing watchdog remains independent; it may restart services and send alerts,
so do not invoke it merely to take an availability measurement.

## Outage, recovery and rotation

Each minute is claimed with one UUID and an unknown payload committed to SQLite
before any network request. Completed observations are committed before upload.
A crash during a probe recovers that claim as interrupted/unknown; it never reruns
the old minute or invents success. Missed minutes are not backfilled. Clock rollback
cannot duplicate an earlier claimed minute.

Core/PostgreSQL outages leave observations pending locally. `--run`, `--once` and
`--flush` replay at most 50 pending observations per pass within a bounded transport
window. SQL has unique minute/scope and observation identities. A lost success reply
replays the exact bytes and returns the original receipt. The collector checks the
identity, slot and canonical observation SHA-256 before acknowledging it locally;
SQL separately hashes its authoritative JSONB payload. The spool retains acknowledged
rows; monitor disk usage and preserve it during host maintenance.

- `upload_http_401`: correct the distinct monitor credential. Never substitute an
  office administrator or worker credential.
- `upload_http_409`: inspect conflicting identity/scope. Do not rewrite the saved
  observation, delete the spool or assign new IDs to force acceptance.
- `upload_http_400`: inspect UTC clock/contract version/retention (400 days). Do not
  alter original timestamps. Keep the original evidence for an operator review.
- `upload_unconfirmed` or 5xx: retain the spool and retry after service recovery.
- `collector_configuration_or_storage_unavailable`: inspect permissions, free space,
  environment and exclusive ownership locally. No raw exception or secret is logged.
- Stale status with recent receipt time: an old backlog arrived; it does not prove
  that the collector is observing the current minute.

Credential rotation preserves the monitor UUID, target and spool. Update both ends;
401 intervals stay unknown. A changed monitor/target/protocol requires a new spool
and explicit identity; retained PostgreSQL evidence remains separate. Never merge
unrelated targets into a favorable monthly report.

Back up the private spool through the host's existing backup process. PostgreSQL
observations are part of normal office backups. Do not delete pending local records
until their authoritative receipts are verified. A lost spool cannot recover a
measurement that never reached Core; those intervals remain missing.

## Reading the month

Months use Asia/Baghdad boundaries. Operations shows successful, failed, unknown
and missing minute slots; known-outcome coverage; success among known observations;
and lower/upper bounds when unknown time is included. A current month is provisional.
Compliance remains null until a completed month has full valid coverage. Even a
measured passing readiness month does not replace the live workflow, independent-host
restore or human design/language acceptance gates.

## Reproduce local controls

```sh
python3 -m unittest discover -s infra/monitoring -p 'test_*.py' -v
pnpm exec tsc -b
pnpm exec vitest run packages/domain/test/availability.test.ts apps/core/test/availability-observations.test.ts apps/desk/test/availability-panel.test.ts packages/testkit/test/availability-collector.test.ts
```

The TypeScript suite uses only its guarded isolated PostgreSQL server (55432).
The Python controls use loopback HTTP, temporary SQLite spools and an actual killed
child process. Deployed Core/PostgreSQL outage and Chrome evidence are required
separately before this implementation is locally qualified.
