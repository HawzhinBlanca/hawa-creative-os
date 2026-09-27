import type { GatewaySpendingReservation } from '@hawa/contracts';

export interface EvaluationCallCostProps {
  allocatedUsd?: number | null;
  estimatedCostUsd?: number | null;
  costBasis?: string | null;
  spending?: GatewaySpendingReservation | null;
}
export function EvaluationCallCost({estimatedCostUsd,costBasis,spending,allocatedUsd}:EvaluationCallCostProps) {
  return <>
    <div>{typeof estimatedCostUsd === 'number' ? `$${estimatedCostUsd.toFixed(6)}` : 'Unknown'}</div>
    <small>{costBasis === 'usage' ? 'Estimate from reported usage' : costBasis === 'local' ? 'Local execution' : 'Usage completeness unverified'}</small>
    {typeof allocatedUsd === 'number' && <div>Daily allocation: ${allocatedUsd.toFixed(6)}</div>}
    {spending && <div>Request bound: ${spending.usd.toFixed(6)} · output cap {spending.outputTokens.toLocaleString()}</div>}
  </>;
}
