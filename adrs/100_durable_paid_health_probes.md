# ADR-100: Durable admission and accounting for scheduled paid health probes

Date: 2026-09-27
Status: Implementing; qualification pending
Requirements: FR-060, FR-064, FR-065, FR-079

## Problem

The opt-in OpenAI health probe dispatches before any database admission. Multiple
Core instances and restarts can repeat it; a lost response has no retained cost
allocation. Studio, evaluation and voice daily caps therefore do not bound it.

## Decision

Keep the existing opt-in schedule and one-token probe. Quote its exact frozen body
using the existing Studio standard-tier price policy before transport. Add an
explicit `health_probe` spending role and original PostgreSQL call ledger. Under
the existing office admission lock, the database enforces a minimum five-minute
interval, the longer of the previous and requested intervals, and shared office
and role limits. A changed credential/model never bypasses an unresolved call or
the previous interval. No database, unknown price or failed admission means no
provider request. Health GETs remain read-only.

An admitted attempt is never automatically dispatched again. Its one immutable
outcome retains actual identifiers, response digest, latency and complete usage;
missing facts remain null. Timeouts, 408/5xx, unusable success, served-model changes
and bound overruns require reconciliation. Unknown allocations survive midnight.
Known higher costs are retained even when they exceed the original reservation.
Observation and outcome commit together; a lost commit response does not repeat
the provider operation. Legacy observations remain readable and carry no invented
billing receipt.

Extend existing exact-call accounting and Desk Operations to this ledger. A
current named administrator may attest terminal provider evidence using the
existing snapshot/revision/action contract. This can release allocation and allow
a *new scheduled probe* after its interval. It never replays the old transport,
rewrites the original outcome or treats financial evidence as a healthy provider.
This explicit narrow recovery rule differs from continuing a design workflow:
the health probe has no downstream creative result to resume.

## Verification required

Real PostgreSQL tests must prove concurrent/restarted schedulers dispatch once,
office/role zero caps stop before transport, shared ledgers count both ways,
uncertainty survives restart/config change/midnight, and named terminal evidence
permits only a later new probe. Test malformed usage, model mismatches, HTTP failure,
database failures, append-only identity/outcomes, RLS and read-only health. Browser
accounting, fresh candidate and full regression qualification remain required.

## Limits

Recorded usage is a conservative policy estimate, not invoice verification. This
does not qualify real credentials, native Canva, Telegram classification or Canva
planner spending. It does not invent historical costs for pre-ledger observations.
