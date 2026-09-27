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
  constructor(readonly code: 'STUDIO_BUDGET_INVALID' | 'STUDIO_BUDGET_HISTORY_INCOMPLETE' | 'STUDIO_BUDGET_RESERVATION_EXCEEDED', message: string) {
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
  if (!finite(b.maxUsd) || b.maxUsd <= 0 || b.maxUsd > Number.MAX_SAFE_INTEGER / 1_000_000 ||
      !finite(b.spentUsd) || b.spentUsd < 0 || b.spentUsd > Number.MAX_SAFE_INTEGER / 1_000_000 ||
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
  reservedUsd?: number | null;
  costBasis?: StudioCostBasis | null;
}

export type StudioCostBasis = 'usage' | 'estimate' | 'unavailable' | 'not_accepted';

export interface StudioCallReservation {
  version: 1;
  policy: string;
  requestSha256: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Round obligations up; tolerate only binary representation error, never a micro-dollar. */
export function studioUsdMicros(usd: number): number {
  const scaled = usd * 1_000_000;
  if (!Number.isFinite(scaled) || usd < 0 || scaled > Number.MAX_SAFE_INTEGER) throw invalid();
  return Math.max(0, Math.ceil(scaled - Number.EPSILON * Math.max(1, scaled) * 2));
}

export function validateStudioReservation(value: StudioCallReservation): void {
  if (!value || value.version !== 1 || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value.policy) ||
      !/^[0-9a-f]{64}$/.test(value.requestSha256) || typeof value.usd !== 'number' || value.usd <= 0 ||
      !Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0 ||
      !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 1) throw invalid();
  if (studioUsdMicros(value.usd) / 1_000_000 !== value.usd) throw invalid();
}

export interface StudioBudgetUsage {
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

export function studioBudgetUsage(snapshot: unknown, calls: readonly StudioBudgetCall[]): StudioBudgetUsage {
  const usage: StudioBudgetUsage = { maxUsd: null, maxCalls: null, admittedCalls: calls.length,
    knownUsdEstimate: 0, attestedAdditionalUsd: 0, accountedUsd: null,
    reservedAdditionalUsd: 0, committedUsd: null, remainingUsd: null, unresolvedCalls: 0, blocker: null };
  let budget: StudioBudget;
  try { budget = parseStudioBudget(snapshot); } catch { return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' }; }
  usage.maxUsd = budget.maxUsd; usage.maxCalls = budget.maxCalls;
  for (const call of calls) {
    if (!Number.isFinite(call.estimatedUsd) || call.estimatedUsd < 0 || call.estimatedUsd > Number.MAX_SAFE_INTEGER / 1_000_000 ||
        (call.settledUsd !== null && (!Number.isFinite(call.settledUsd) || call.settledUsd < 0 || call.settledUsd > Number.MAX_SAFE_INTEGER / 1_000_000))) {
      return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
    }
    // Uncertainty can coexist with an already reported partial charge. The zero placeholder
    // contributes nothing, but a positive estimate must survive settlement or response loss.
    const known = call.estimatedUsd;
    if (call.reservedUsd != null && (!Number.isFinite(call.reservedUsd) || call.reservedUsd <= 0 || call.reservedUsd > Number.MAX_SAFE_INTEGER / 1_000_000)) {
      return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
    }
    usage.knownUsdEstimate += known;
    usage.attestedAdditionalUsd += Math.max(0, (call.settledUsd ?? 0) - known);
    if (call.status === 'uncertain' && call.settledUsd === null) usage.unresolvedCalls++;
    if (call.reservedUsd != null) {
      const finalCost = call.settledUsd !== null ||
        (call.status !== 'uncertain' && (call.costBasis === 'usage' || call.costBasis === 'not_accepted'));
      if (!finalCost) usage.reservedAdditionalUsd += Math.max(0, call.reservedUsd - known);
      if (studioUsdMicros(Math.max(known, call.settledUsd ?? 0)) > studioUsdMicros(call.reservedUsd)) {
        usage.blocker = 'STUDIO_BUDGET_RESERVATION_EXCEEDED';
      }
    }
  }
  const ledgerUsd = usage.knownUsdEstimate + usage.attestedAdditionalUsd;
  if (!Number.isFinite(ledgerUsd)) return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
  usage.accountedUsd = Math.max(budget.spentUsd, ledgerUsd);
  try {
    usage.committedUsd = studioUsdMicros(usage.accountedUsd + usage.reservedAdditionalUsd) / 1_000_000;
    usage.remainingUsd = Math.max(0, Math.floor(budget.maxUsd * 1_000_000) - studioUsdMicros(usage.committedUsd)) / 1_000_000;
  } catch { return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' }; }
  // PostgreSQL numeric is exact; summing the same receipts in JS in another order can differ.
  const rounding = Number.EPSILON * Math.max(1, ledgerUsd) * Math.max(1, calls.length) * 4;
  if (budget.calls > calls.length || budget.spentUsd > ledgerUsd + rounding) {
    usage.blocker = 'STUDIO_BUDGET_HISTORY_INCOMPLETE';
  } else if (!usage.blocker && (usage.admittedCalls >= budget.maxCalls || usage.remainingUsd === 0)) {
    usage.blocker = 'BUDGET_EXHAUSTED';
  }
  return usage;
}

export function assertStudioBudgetAdmission(usage: StudioBudgetUsage, reservedUsd = 0): void {
  if (usage.blocker === 'BUDGET_EXHAUSTED') throw new StudioBudgetExhaustedError();
  if (usage.blocker === 'STUDIO_BUDGET_INVALID') throw invalid();
  if (usage.blocker === 'STUDIO_BUDGET_HISTORY_INCOMPLETE') {
    throw new StudioBudgetEvidenceError(usage.blocker,
      'The saved Studio spend or call count exceeds its available ledger. Review the history before explicitly requesting a new run.');
  }
  if (usage.blocker === 'STUDIO_BUDGET_RESERVATION_EXCEEDED') {
    throw new StudioBudgetEvidenceError(usage.blocker,
      'A provider cost exceeded its reservation. Review the pricing policy before requesting more work.');
  }
  if (usage.remainingUsd === null || studioUsdMicros(reservedUsd) > studioUsdMicros(usage.remainingUsd)) {
    throw new StudioBudgetExhaustedError('The next request cannot fit within the remaining Studio budget.');
  }
}
