# Paid health probe qualification

## 2026-09-27 — Durable paid health probes qualified locally (ADR-100)

Source 01aed17, RLS/migration correction 1886824, tested and fresh runtime
**ec31d95**. Final full suite: **4065 passed,0 failed,59 skipped**,487 passing/7
skipped files,121.81 seconds. Focused 94 tests/8 files and 43 migration correction
tests/4 files pass (overlapping coverage; not added together). Three actual SIGKILL
boundaries prove no repeated request after send, after response/before save, and
after saved outcome.495 strict roots and source/scripts compile; lint979/1053,
nine existing egress exceptions, Desk build, security/11-pattern self-test and
blueprint1001/0/0 pass.

The first full run had three real failures: two stale migration inventories and
new membership predicates evaluated per row. Inventories now include055; RLS
checks membership once per query against the current tenant. The initial failure
and passing correction evidence are retained. No gate was suppressed.

Fresh matching Core/worker/Desk images have zero changed source. One selected
synthetic app scenario passes63 workflow/recovery checks;43 scenarios unselected.
The fake harness still reports two deliberately unmatched Gemini paths, so this
is not complete model-provider coverage.24 actual Chrome/runtime checks pass:
deployed code sends one fake probe, loses its success response, retains unknown
cost, refuses another scheduler, accepts named terminal cost evidence, preserves
the original row, restarts Core and replays evidence without a second model call.
The interval still blocks a new probe after reconciliation. Temporary administrator
revoked; screenshots inspected. Production and real billing unchanged.

Health at12:33:30UTC/15:33Baghdad remains degraded: PostgreSQL/Restate connected,
zero paused/backoff/inbox; live Canva/model/Telegram API unverified, both new design
flags off. Legacy observations gain no invented historical costs.

Remaining: Telegram classifier and Canva planner shared spending; typed result
recovery; Operations SLO zero-sample100%/zero-latency and legacy monthly-budget
defaults found during browser review; live office/provider/native Canva and human
multilingual/design/held-out study; independent-host restore and controlled rollout.
The native Canva after-preview approval remains pending. Whole-app goal active.
See R21_PAID_HEALTH_PROBES_PROOF.json and runbooks/PAID_HEALTH_PROBES.md.

