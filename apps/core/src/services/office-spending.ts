import type { AppError } from '@hawa/contracts';

/** Translate only the database's explicit admission refusals; connection loss stays uncertain. */
export function officeSpendingRefusal(error: unknown): AppError | null {
  const code = error instanceof Error ? /OFFICE_BUDGET_(EXHAUSTED|HISTORY_INCOMPLETE|INVALID):/.exec(error.message)?.[1] : undefined;
  if (!code) return null;
  return { code: `MODEL_BUDGET_DAILY_${code}`, message: code === 'EXHAUSTED'
    ? 'The shared daily spending allowance is exhausted.'
    : code === 'HISTORY_INCOMPLETE' ? 'Historical paid work has unresolved cost evidence.'
      : 'The shared spending admission is invalid.',
    retryable: false, safeAction: 'Review the office spending policy and saved call evidence before requesting paid work.',
    detail: { acceptance: 'not_dispatched', requiresReconciliation: false, estimatedCostUsd: 0 } };
}
