import { DailySpendingSummary, type DailySpendingUsage } from './DailySpendingSummary.js';
export interface StudioBudgetUsage {
  daily?: DailySpendingUsage | null;
  maxUsd: number | null;
  maxCalls: number | null;
  admittedCalls: number;
  knownUsdEstimate: number;
  attestedAdditionalUsd: number;
  accountedUsd: number | null;
  reservedAdditionalUsd: number;
  committedUsd: number | null;
  remainingUsd: number | null;
  unresolvedCalls: number;
  blocker: 'STUDIO_BUDGET_INVALID' | 'STUDIO_BUDGET_HISTORY_INCOMPLETE' | 'STUDIO_BUDGET_RESERVATION_EXCEEDED' | 'BUDGET_EXHAUSTED' | null;
}

export function StudioBudgetSummary({ usage }: { usage?: StudioBudgetUsage | null }) {
  if (!usage) return <div role="status">Budget accounting unavailable. Refresh before requesting more work.</div>;
  const money = (value: number | null) => value === null ? 'unknown' : `$${value.toFixed(3)}`;
  return <div aria-label="Studio spending" style={{ marginTop: 6 }}>
    <div><strong>Spending counted:</strong> {money(usage.accountedUsd)} / {money(usage.maxUsd)}
      <span style={{ marginLeft: 14 }}><strong>Calls:</strong> {usage.admittedCalls} / {usage.maxCalls ?? 'unknown'}</span></div>
    <div>Recorded estimates: {money(usage.knownUsdEstimate)}.
      {usage.attestedAdditionalUsd > 0 && ` Additional administrator-reported cost: ${money(usage.attestedAdditionalUsd)}.`}</div>
    <div>Reserved for unfinished or estimated calls: {money(usage.reservedAdditionalUsd)}.
      {' '}Available within this run: {money(usage.remainingUsd)}.</div>
    {usage.unresolvedCalls > 0 && <div role="status">Final cost unknown for {usage.unresolvedCalls} call(s); the counted amount is incomplete.</div>}
    {usage.blocker && <div role="status">{usage.blocker === 'BUDGET_EXHAUSTED'
      ? 'Spending or call limit reached. Further model calls are blocked.'
      : usage.blocker === 'STUDIO_BUDGET_HISTORY_INCOMPLETE'
        ? 'Spending history is incomplete. Review the saved calls before requesting a new run.'
        : usage.blocker === 'STUDIO_BUDGET_RESERVATION_EXCEEDED'
          ? 'A provider cost exceeded its reservation. Review pricing before continuing.'
          : 'Budget settings or cost evidence are invalid. Further model calls are blocked.'}</div>}
    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Every new call must fit within the available budget. Reservations use conservative price estimates; provider billing can differ.</div>
    <DailySpendingSummary daily={usage.daily} />
  </div>;
}
