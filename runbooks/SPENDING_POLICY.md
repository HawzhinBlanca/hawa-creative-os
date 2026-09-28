# Review and change daily spending limits

Requirements: FR-060, FR-062, FR-065, FR-079, NFR-001. ADR-098.

1. Open **Operations → Review budget policy**. Confirm the office, current revision,
   daily usage and held obligations. These are the shared Studio, fixture-evaluation
   and retained-voice limits; other paid paths are still outside this boundary.
2. Sign in with a current named office administrator account to edit. A shared
   administrator key may inspect permitted data but cannot change this policy.
3. Enter office, default client and default role daily USD limits. Set explicit
   overrides only where needed. Blank role overrides and **Use default for…** client
   actions inherit the displayed defaults. Zero stops new paid admissions in scope.
4. Supply a reason and select **Review budget changes**. Check previous/proposed
   amounts and any warning that the office cap is below existing obligations.
5. Select **Apply reviewed limits**. Keep the result or saved action available until
   confirmed. The revision applies to subsequent admissions; admitted work and its
   original policy identity, costs and reservations remain unchanged.

## Unconfirmed or refused changes

- If the response is lost, **Retry saved budget action** submits the exact saved
  action and proposal. Reloading the page preserves it in that browser tab for the
  same office and user. A newer policy does not prevent replay of a previously
  committed action. Do not create a replacement to guess whether the first worked.
- A definite stale-policy refusal admits nothing. Reload the policy and review a
  new proposal against the current limits. A reused action with changed inputs is
  a conflict and must not be silently replaced.
- Sign-in or permission failures do not prove an earlier attempt failed. Restore
  current named authority before retrying the saved action.
- If browser storage is unavailable, no new request is dispatched; retain the open
  proposal until storage works. No credential is stored with the pending action.

## Accounting and audit

The Asia/Baghdad day is fixed. Lower limits never erase recorded or reserved costs;
raising limits never resolves uncertain execution or incomplete ledger history.
Use separate exact-call accounting/recovery evidence where appropriate. Policy
changes neither call providers nor cancel/restart work.

History is append-only and paginated. Named revisions record the user, server time,
reason, action UUID and canonical limits hash. Historical owner/bootstrap revisions
retain their database identity with no invented human attribution. Application
table mutations remain denied; the scoped SQL function is the runtime writer.

Production changes require the actual office configuration and release admission.
Synthetic test limits and administrators do not establish live spending authority.
