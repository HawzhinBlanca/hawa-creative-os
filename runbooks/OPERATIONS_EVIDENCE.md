# Reading Operations evidence

Authority: ADR-102; FR-064/079 and the NFR-002 measurement boundary.

## Reliability

Office intake and review target 99.5% monthly availability. Operations reports
availability and latency as unmeasured until a durable independent observation
series exists. The status-read timestamp is not a successful operation timestamp.
A successful current health check cannot establish a month of uptime. Synthetic
benchmarks remain test fixtures and cannot publish through Operations.

## Spending

Use Daily spending policy and Call cost accounting in Operations. They read the
shared PostgreSQL policy and original paid-call ledger. Policy changes require a
named administrator, expected revision/hash, reviewed limits and a reason. Use the
saved action after an uncertain response. The previous sample monthly budgets
and their adjustment API are retired with 410; no monthly cap was converted into
a daily limit and no fixture balance was copied into billing history.

Failed refreshes clear unavailable figures and selected details. Saved pending
accounting and policy actions remain retained; reload authoritative evidence to
continue. Unknown accounting is not zero spend.

## Stored publication audit

The audit compares PostgreSQL tasks with the delivery receipts already stored by
Core. Its timestamp and basis identify that snapshot. An empty audit proves no
tasks were examined. Anomalies are findings; no files or rows were repaired. The
audit does not check current external Drive or Sheets content. Refresh failures
must remove the prior displayed result, and late older responses cannot replace
newer evidence.

## Admission still required

Independent availability monitoring, durable scope-bound audit history, external
storage verification, native Canva editing, live office integrations, human design
and multilingual review, held-out evaluation, independent-host recovery and
controlled rollout remain separate requirements. This correction does not qualify
the full app for production or satisfy the monthly availability target.
