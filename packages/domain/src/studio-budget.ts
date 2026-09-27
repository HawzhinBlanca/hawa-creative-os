export interface StudioBudget {
  maxUsd: number;
  maxCalls: number;
  spentUsd: number;
  calls: number;
}

export class StudioBudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED';
  constructor(message = 'The Studio run has reached its spending or call limit.') {
    super(message);
    this.name = 'StudioBudgetExhaustedError';
  }
}

export class StudioBudgetEvidenceError extends Error {
  constructor(readonly code: 'STUDIO_BUDGET_INVALID' | 'STUDIO_BUDGET_HISTORY_INCOMPLETE', message: string) {
    super(message);
    this.name = 'StudioBudgetEvidenceError';
  }
}

const invalid = () => new StudioBudgetEvidenceError('STUDIO_BUDGET_INVALID',
  'Studio budget limits or cost evidence are invalid. Correct the configuration before requesting new work.');

export function parseStudioBudget(value: unknown): StudioBudget {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw invalid(); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const b = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (!finite(b.maxUsd) || b.maxUsd <= 0 || !finite(b.spentUsd) || b.spentUsd < 0 ||
      !finite(b.maxCalls) || !Number.isSafeInteger(b.maxCalls) || b.maxCalls < 1 ||
      !finite(b.calls) || !Number.isSafeInteger(b.calls) || b.calls < 0) throw invalid();
  return { maxUsd: b.maxUsd, maxCalls: b.maxCalls, spentUsd: b.spentUsd, calls: b.calls };
}

export function newStudioBudget(maxUsd: unknown = 2, maxCalls: unknown = 24): StudioBudget {
  // Full numeric conversion refuses suffixes and fractional call caps; no truthiness defaults.
  return parseStudioBudget({ maxUsd: typeof maxUsd === 'string' ? Number(maxUsd) : maxUsd,
    maxCalls: typeof maxCalls === 'string' ? Number(maxCalls) : maxCalls, spentUsd: 0, calls: 0 });
}

export interface StudioBudgetCall {
  status: 'ok' | 'error' | 'uncertain';
  estimatedUsd: number;
  settledUsd: number | null;
}

export interface StudioBudgetUsage {
  maxUsd: number | null;
  maxCalls: number | null;
  admittedCalls: number;
  knownUsdEstimate: number;
  attestedAdditionalUsd: number;
  accountedUsd: number | null;
  unresolvedCalls: number;
  blocker: 'STUDIO_BUDGET_INVALID' | 'STUDIO_BUDGET_HISTORY_INCOMPLETE' | 'BUDGET_EXHAUSTED' | null;
}

export function studioBudgetUsage(snapshot: unknown, calls: readonly StudioBudgetCall[]): StudioBudgetUsage {
  const usage: StudioBudgetUsage = { maxUsd: null, maxCalls: null, admittedCalls: calls.length,
    knownUsdEstimate: 0, attestedAdditionalUsd: 0, accountedUsd: null, unresolvedCalls: 0, blocker: null };
  let budget: StudioBudget;
  try { budget = parseStudioBudget(snapshot); } catch { return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' }; }
  usage.maxUsd = budget.maxUsd; usage.maxCalls = budget.maxCalls;
  for (const call of calls) {
    if (!Number.isFinite(call.estimatedUsd) || call.estimatedUsd < 0 ||
        (call.settledUsd !== null && (!Number.isFinite(call.settledUsd) || call.settledUsd < 0))) {
      return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
    }
    // Uncertainty can coexist with an already reported partial charge. The zero placeholder
    // contributes nothing, but a positive estimate must survive settlement or response loss.
    const known = call.estimatedUsd;
    usage.knownUsdEstimate += known;
    usage.attestedAdditionalUsd += Math.max(0, (call.settledUsd ?? 0) - known);
    if (call.status === 'uncertain' && call.settledUsd === null) usage.unresolvedCalls++;
  }
  const ledgerUsd = usage.knownUsdEstimate + usage.attestedAdditionalUsd;
  if (!Number.isFinite(ledgerUsd)) return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
  usage.accountedUsd = Math.max(budget.spentUsd, ledgerUsd);
  // PostgreSQL numeric is exact; summing the same receipts in JS in another order can differ.
  const rounding = Number.EPSILON * Math.max(1, ledgerUsd) * Math.max(1, calls.length) * 4;
  if (budget.calls > calls.length || budget.spentUsd > ledgerUsd + rounding) {
    usage.blocker = 'STUDIO_BUDGET_HISTORY_INCOMPLETE';
  } else if (usage.admittedCalls >= budget.maxCalls || usage.accountedUsd >= budget.maxUsd) {
    usage.blocker = 'BUDGET_EXHAUSTED';
  }
  return usage;
}

export function assertStudioBudgetAdmission(usage: StudioBudgetUsage): void {
  if (usage.blocker === 'BUDGET_EXHAUSTED') throw new StudioBudgetExhaustedError();
  if (usage.blocker === 'STUDIO_BUDGET_INVALID') throw invalid();
  if (usage.blocker === 'STUDIO_BUDGET_HISTORY_INCOMPLETE') {
    throw new StudioBudgetEvidenceError(usage.blocker,
      'The saved Studio spend or call count exceeds its available ledger. Review the history before explicitly requesting a new run.');
  }
}
