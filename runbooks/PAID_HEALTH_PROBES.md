# Scheduled paid model health probes

Applies to ADR-100, migration 055, FR-060/064/065/079.

## Operation

The existing `HAWA_BILLING_PROBE_ENABLED=on` switch opts into a billable OpenAI
one-token ping. `HAWA_BILLING_PROBE_MINUTES` defaults to 30, bounded to 5–1440.
The PostgreSQL ledger admits at most one new probe after the longer of the previous
and current intervals. Multiple Core instances, restart and credential/model
changes cannot reset that interval or an unresolved original attempt.

Before transport, the exact serialized standard-tier request receives the existing
Studio quote and reserves against the shared office allowance and `health_probe`
role. Zero office or role allowance stops it. Missing database, incomplete ledger
history or unpriced/expired policy stops it. No ordinary health GET sends a probe.

## Interpreting health

- `connected`: the configured provider returned a usable receipt with positive,
  complete usage within the admitted bound. This is not invoice or design quality
  verification. Its age and credential/model fingerprint still control freshness.
- `reconciliation_required`: a retained probe lacks terminal evidence. Health
  includes its call ID. This includes a crash before transport: without independent
  evidence the database cannot determine whether the provider received it.
- `budget_held`: inspect `lastPaidProbe.detail` / integration `spendingStatus` for
  `budget_held`, `history_incomplete` or `unquotable`. This is a local admission
  problem, not proof the provider is down.
- Existing stale, disabled, unauthorized and billing states retain their meanings.
  A stale observation is never refreshed by an administrator's financial evidence.

## Recovering an uncertain call

Open **Operations → Call cost accounting**, locate the exact `health_probe` call
and inspect its original receipt, request reference, cost and reservation. Follow
[exact-call accounting](CALL_COST_ACCOUNTING.md) with independently obtained terminal
provider evidence and a current named administrator session. A timeout alone does
not establish non-acceptance or a zero charge.

Evidence appends a revision; it never rewrites the original attempt. It releases
unused allocation while retaining the greatest known charge. After the interval,
the existing enabled schedule may admit a *new* probe under current limits. It
never sends the original attempt again. Set `health_probe` daily allowance to zero
before reconciliation if you want all new probes to stay stopped.

A failed final database write keeps the original start/reservation. Do not delete
it or restart the service to “clear” it. Reconcile it as above. Schema changes,
model mismatch, output overrun and missing usage similarly remain visible holds.

## Evidence limits

Conservative standard-tier estimates can exceed an invoice; no invoice matching
is automated. The reviewed rate policy requires renewal before 2026-11-22.
Pre-migration observations remain historical health data, without invented cost
records. Telegram classification and Canva planning have separate outstanding
spending admission work. Local synthetic acceptance cannot establish live billing.
