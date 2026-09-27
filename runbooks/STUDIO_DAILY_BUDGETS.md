# Studio daily budgets

ADR-092 / migration 051. These limits cover Studio text, image, vision and parity
calls. Evaluation, voice and other ModelGateway paths are not yet included; do not
describe this as an app-wide spending ceiling. Provider invoice totals can differ
from the estimated reservations.

## Reading the balance

Open a Studio run in Desk and expand **Studio daily limits**. The office day is
00:00–24:00 in Asia/Baghdad, regardless of the Core machine's timezone. Each call
must fit the office balance, its client's balance, its model-role balance and its
existing per-run limits. The call retains the policy version and model role.

Recorded costs count on the original admission day. Unfinished or estimated calls
carry their full remaining obligation into later days. They do not expire at
midnight, on cancellation or after a process restart. A complete usage receipt or
an exact-call administrator settlement releases unused funds. Late overruns are
saved even when they exceed the limit. Missing historical quotes on uncertain
calls or run snapshots exceeding their ledger hold new spending for the office.
Historical completed calls without quotes retain their original recorded estimates;
no price bound is retroactively invented.

For uncertain calls, follow [Studio recovery](STUDIO_RECOVERY.md). Never delete a
call, clear a budget file, reset a run counter or create a replacement run to make
the balance appear lower. Incomplete ledger history requires accounting repair;
raising the cap does not clear that hold.

## Configuring limits before rollout

Each tenant starts with USD 30 for office, default client and default model role,
matching the pre-existing office ceiling. These are starter limits, not approval
for a paid run. Review them before deployment. Configure client/role overrides to
make them lower when required. A zero cap stops new spending in that scope.

Until named budget administration is available in Desk, the trusted database
deployment owner installs an append-only policy revision. Runtime application
users cannot insert, update or delete policy revisions. Record a unique action
UUID, the expected next version and a reason. Read the current version first:

```sql
SELECT version, action_id, reason, limits, limits_sha256, recorded_by, recorded_at
FROM hawa.studio_spending_policies
WHERE tenant_id = :'tenant_id'::uuid ORDER BY version DESC;

-- Bind tenant_id, action_id, expected_version and reason through your SQL client.
-- Replace this complete example allocation with the approved office policy.
INSERT INTO hawa.studio_spending_policies
  (tenant_id, version, action_id, reason, limits)
VALUES (:'tenant_id'::uuid, :expected_version + 1, :'action_id'::uuid, :'reason',
  '{"officeUsd":30,"clientUsd":10,"roleUsd":10,"clients":{},
    "roles":{"asset_photoreal":5,"visual_judge":5}}'::jsonb);
```

`clients` maps existing client UUIDs in that tenant to daily USD caps. `roles`
supports `creative_director`, `visual_judge`, `asset_photoreal`. Amounts must be
between zero and one million USD and represent whole micro-dollars. A concurrent
policy edit conflicts; reload and review instead of automatically overwriting it.
On a lost response, look up the same action UUID before attempting a new revision.
Raising a cap preserves every prior obligation. No policy mutation changes the day.

## Verification and operational limits

The local qualification uses isolated databases, concurrent connections, synthetic
provider requests and prior-day fixtures. The full app image, deployed runtime,
real invoices and live office workflow require separate qualification. Check
`plans/research-grade-upgrade-2026-09-25/R21_DAILY_STUDIO_BUDGET_PROOF.json` for the
current evidence and unexecuted gates.
