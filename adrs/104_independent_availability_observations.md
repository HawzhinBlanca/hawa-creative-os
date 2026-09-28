# ADR-104: Independent durable office availability observations

Date: 2026-09-27
Status: accepted; locally qualified; independent-host and monthly production admission pending
Requirements: NFR-002, FR-064, NFR-006
Sources: MASTER_SPEC.md; docs/02_PRD.md; docs/10_WORKFLOW_RELIABILITY.md;
docs/17_UI_UX.md; infra/ops/watchdog.sh; ADR-102

## Evidence and objective

The host watchdog reports current trouble and remembers only its latest alert
state. Core's Operations route correctly reports availability as unmeasured.
Neither can reconstruct a month, retain an observation while PostgreSQL is down,
or distinguish an unobserved interval from a successful one. NFR-002 targets 99.5%
monthly availability for office intake and review; fixture model timings do not
measure it. Implement independent observations, durable outage delivery and a
coverage-aware report without running creative work or sending messages.

## Decision and data flow

Use a small standalone Python standard-library collector, runnable on a separate
supported Linux/macOS host. No new monitoring framework or paid service is needed.

```text
independent collector -> office HTTPS edge -> Desk shell/assets
                      -> office HTTPS edge -> authenticated readiness probe
                      -> local SQLite spool (FULL synchronous, exclusive process lock)
                      -> authenticated append/replay -> PostgreSQL observations
Desk Operations       -> named office read          -> monthly evidence report
```

PostgreSQL is the authoritative retained office record. The collector's SQLite
file is a durable transport spool: it allows observations of Core/database outages
to survive until ingestion recovers. It carries no office content or credentials.
Its immutable configuration binds a monitor UUID, target origin and protocol.
One collector owns the spool; the OS releases its lock after a crash. A minute
slot is claimed durably before probing. An interrupted probe becomes unknown,
never an invented successful measurement. Never backfill missed minutes.

The collector checks the actual Desk HTML and its same-origin module/stylesheets,
then a dedicated Core readiness endpoint through the configured office edge.
Core checks intake/review storage access and a real write/read/update rolled back
in an isolated probe table, plus current workflow-service registration. It never
creates office requests, approvals, model calls, publications or adapter messages.
The measured indicator is **sampled office readiness**, not completed creative
work or proof of every possible user interaction. Live workflow and human quality
admission remain separate gates. Probe round-trip latency is labelled as such.

## Authority and replay

A dedicated monitor credential, distinct from office and worker keys, can only
probe and append observations. It cannot read client data or perform office
actions. Browser cookies and office API credentials cannot ingest measurements.
Probe responses bind the caller's nonce; ingestion binds a stable observation UUID,
minute slot and configured monitor/target fingerprint. Idempotency-Key equals the
observation UUID. Exact replay returns the original receipt; changed content or a
second identity for the same slot conflicts. SQL computes the payload hash and
protects append-only rows with tenant RLS. Historical observations are never
invented during migration.

Use HTTPS except explicit loopback HTTP for local qualification. Do not follow
cross-origin redirects or fetch arbitrary URLs named in HTML. Bound response size,
probe duration and upload batches. Record categorical failures, status codes and
timings, never response bodies, session credentials or environment values.

## Coverage, time and truthfulness

Use fixed UTC minute slots and calendar-month boundaries evaluated in
Asia/Baghdad. Count elapsed slots, successful observations, failed observations,
explicitly unknown probes and missing slots separately. A stopped collector or
late backlog cannot inflate availability. The ratio among known observations is
an estimate, always shown beside coverage and lower/upper bounds including unknown
slots. A current month is provisional. Monthly compliance is not true unless a
completed month has complete, valid coverage; missing evidence remains unknown.
No samples keep percentiles null. Missing/stale monitoring stays visible after
Core restarts. Configuration changes cannot silently merge unrelated targets.

The collector runs independently of Core. Running it on the same physical host
cannot observe a host outage: those gaps remain unknown. Deploy it on an independent
host before claiming supported-infrastructure monthly availability. A local outage
drill qualifies mechanics only; it cannot supply a month of production evidence.

## Alternatives and trade-offs

- Core timers miss their own failures and cannot retain database-outage evidence.
- Reusing the alert watchdog would mix restart/cleanup/message side effects with
  measurement and still lose history.
- A new monitoring stack adds operational dependencies before office scale or
  measured load requires them. One fixed minute costs at most 1,440 small records
  daily; monthly reads and upload batches are bounded.
- SQLite is used only in the independently operated collector because its atomic
  journal and OS locking avoid a custom append-log recovery protocol. No SQLite
  becomes office workflow truth. Revisit the collector transport if measured scale
  or supported-host requirements outgrow this design.

## Required evidence

Prove empty/missing/stale/partial/month-boundary summaries, exact replay and
conflicting slots, RLS and dedicated-credential isolation, SQL immutability,
historical migration, spool restart after process death, database/Core outage
backlog replay without duplicate observations, malformed/oversized/redirected
responses, missing Desk assets, unavailable workflow registration, and no provider
or office mutations. Qualify a fresh deployment and actual narrow/wide Desk
screens, with failed reads clearing old evidence. Preserve failures and state
which host, month coverage and live gates remain unqualified.

## Local qualification — 2026-09-27

Source c35d6415, runtime 1f07c9b3 and inventory-only correction/full-suite 684540dd.
4169 tests passed, 59 skipped; 507 strict roots; 14 Python controls; 63 synthetic
workflow invariants and 26 deployed runtime/Chrome checks passed. Collector death
after server acceptance and real worker/Core/PostgreSQL failures preserve immutable
observations and exact replay. First failures remain in the evidence. No production
change or real provider call. See `R02_AVAILABILITY_PROOF.json` and the dated
acceptance STATUS; independent-host/month/live/human/restore gates remain open.
