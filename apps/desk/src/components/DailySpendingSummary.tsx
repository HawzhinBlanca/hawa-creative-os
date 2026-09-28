export interface DailySpendingUsage {
  day: string;
  timezone: 'Asia/Baghdad';
  policyVersion: number;
  scopes: Array<{ scope: 'office' | 'client' | 'role'; subject: string; maxUsd: number;
    spentUsd: number; heldUsd: number; remainingUsd: number; historyIncomplete: boolean }>;
}

export function DailySpendingSummary({daily}:{daily?:DailySpendingUsage|null}) {
  if(daily === undefined) return null;
  if(daily === null) return <div role="status">Daily spending information is unavailable for this account.</div>;
  const money=(value:number)=>`$${value.toFixed(3)}`;
  return <>
    {daily.scopes.some(scope=>scope.scope!=='role'&&(scope.historyIncomplete||scope.remainingUsd===0))&&
      <div role="status">Shared daily spending is blocked. Review daily limits and saved calls before requesting more work.</div>}
    <details>
      <summary>Shared daily limits · {daily.day} ({daily.timezone})</summary>
      <p>These limits combine Studio, evaluation and retained-voice calls. Unfinished or estimated charges from earlier days remain held.</p>
      <ul>{daily.scopes.map(scope=><li key={`${scope.scope}:${scope.subject}`}>
        {scope.subject.replaceAll('_',' ')}: {money(scope.remainingUsd)} available / {money(scope.maxUsd)};
        {' '}{money(scope.spentUsd)} recorded today, {money(scope.heldUsd)} held.
        {scope.historyIncomplete&&' Historical cost is unresolved; new spending is blocked.'}
      </li>)}</ul>
    </details>
  </>;
}
