# ADR-102: Operations uses only evidence from the stated authority

Date: 2026-09-27
Status: implementation and qualification in progress
Requirements: FR-064, FR-079, NFR-002, NFR-006
Sources: docs/10_WORKFLOW_RELIABILITY.md; docs/17_UI_UX.md; MASTER_SPEC.md

## Findings

The production SLO route exposes SyntheticTrafficDaemon, whose fake editor,
in-memory history and seeded test probes cannot establish office availability.
Its empty summary reports 100% success, zero latency and compliance. Its HTTP run
route can publish synthetic work through a configured publisher. The old monthly
budget routes expose an independently seeded CostGovernor; Desk invents a cap,
zero spend and a billing month when fields are missing. Those balances do not
represent the shared paid-call ledger qualified in ADRs 092–101.

Operations also retains an old SLO/audit after a failed refresh, lets an older
request overwrite newer results, calls audit anomalies repaired, and labels local
receipt consistency as 100% external storage synchronization.

## Decision

Remove the synthetic daemon from Core and its operational context. GET reliability
reports the specified 99.5% monthly office intake/review target and explicitly null
observed availability, compliance and latency until durable independent measurements
exist. Reading this report sends no probe. Retire the HTTP synthetic-run endpoint
with 410; keep the benchmark in testkit and make its empty statistics unknown. Its
fixture error budget must use its stated 99% success target, not an unrelated 10%
allowance. Neither fixture timings nor a closed local breaker qualify NFR-002.

Retire the three old monthly-budget HTTP routes with 410 and a pointer to the
existing /spending/policy API. Preserve existing local governor data; never migrate
seeded balances into paid-call evidence or reinterpret monthly limits as daily ones.
Desk uses its existing named daily-policy/accounting controls for actual spending.
No replacement balance or dependency is introduced.

Give Operations a typed reliability contract and visible unavailable states.
Refreshes replace evidence atomically only if they are still the newest request;
failed or malformed results clear prior green data. Reconciliation must display its
actual stored-receipt basis, timestamp, audited counts and anomalies, with zero-task
audits explicitly empty. It must not imply external Drive/Sheets reads or repairs.

## Qualification

Prove the old false-green cases before the change; then test empty and failed reads,
out-of-order refreshes, zero-task and divergent audits, refusal of synthetic HTTP
execution and old budget writes, and continued named daily-policy administration.
Run the complete suite, source/test compilation, lint, security and Desk build once
at a coherent qualification point; inspect the fresh deployed Operations UI.

A live availability observation series, external storage checks, production provider
admission and human creative-quality gates remain separate and unqualified.

## Deployed browser finding — private API caching

The first Chrome fault-injection check exposed a second response path: the service
worker fetches and stores authenticated JSON independently of page interception,
then replays cached responses after a network exception. Cache Storage is not
partitioned by signed-in office identity. This can hide unreadable telemetry and
expose earlier task/budget evidence after a session change.

Remove all same-origin API response caching, including binary and JSON responses,
and purge all legacy Hawa API caches on activation. Keep public shell/assets and
fonts eligible for offline caching. Desk JSON requests explicitly use no-store to
avoid a separate HTTP-cache fallback. Verify actual service-worker activation,
legacy-cache removal and offline refusal in Chrome; do not disable the worker to
make the browser test pass. The prior candidate's full suite remains recorded but
does not qualify this correction.

## Visual review finding — clipped mobile evidence

The 390px document-width assertion passed while fixed-width inner grids were
hidden by the screen's overflow rule. Screenshot review found inaccessible metric
cards, component health and inspection actions. Bound the Operations grids to their
container, render labelled failure rows on narrow screens, and bound the inspection
dialog to the viewport. Verify the actual card/field bounds and opening/closing an
inspection in Chrome, then inspect screenshots; document width alone is insufficient.
The earlier browser assertion is retained as incomplete evidence, not a mobile pass.
