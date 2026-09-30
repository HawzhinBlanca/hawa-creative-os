export interface StudioBudget {
  maxUsd: number;
  maxCalls: number;
  spentUsd: number;
  calls: number;
}

/**
 * A single request whose advance reservation is larger than what its run has left, although the run
 * itself is far from its limit (ADR-142). Nothing was sent for it and nothing was spent. It is not a
 * run that "reached its limit": the office is told the reservation, the remainder and the limit, and
 * the design can be run again once the limit fits it.
 */
export interface StudioReservationShortfall {
  reservedUsd: number;
  remainingUsd: number;
  maxUsd: number | null;
  accountedUsd: number | null;
}

export class StudioBudgetExhaustedError extends Error {
  readonly code: 'BUDGET_EXHAUSTED' | 'OFFICE_DAY_EXHAUSTED' = 'BUDGET_EXHAUSTED';
  constructor(message = 'The Studio run has reached its spending or call limit.', readonly shortfall?: StudioReservationShortfall) {
    super(message);
    this.name = 'StudioBudgetExhaustedError';
  }
}

/** The office day runs midnight to midnight in Baghdad (UTC+3 all year, no daylight saving). */
const OFFICE_DAY_OFFSET_MS = 3 * 3_600_000;
export function nextOfficeDayStart(now: number = Date.now()): Date {
  const local = new Date(now + OFFICE_DAY_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - OFFICE_DAY_OFFSET_MS);
}

/**
 * The shared daily allowance (office, client or role) is used up, not the run's own limit (ADR-159).
 * Nothing was sent for the request; it can run again when the office day resets, or once the office
 * raises its daily limit. It used to be reported as "no candidates passed hard QA".
 */
export class OfficeDayExhaustedError extends StudioBudgetExhaustedError {
  override readonly code = 'OFFICE_DAY_EXHAUSTED' as const;
  constructor(readonly scope: string, readonly neededUsd: number | null, readonly availableUsd: number | null,
    readonly resetsAt: Date, databaseDetail?: string) {
    super(`The ${scope === 'office' ? "office's" : scope === 'client' ? "client's" : `${scope} role's`} daily model allowance is used up` +
      `${neededUsd !== null && availableUsd !== null ? ` ($${neededUsd.toFixed(2)} needed, $${availableUsd.toFixed(2)} left)` : ''}; ` +
      `it resets at ${resetsAt.toISOString()} (midnight in Baghdad).${databaseDetail ? ` [${databaseDetail}]` : ''}`);
    this.name = 'OfficeDayExhaustedError';
  }
}

/** Reads the database's "STUDIO_SCOPE_BUDGET_EXHAUSTED: <scope> needs $x; $y available for the office day". */
export function officeDayExhaustedFrom(message: string, now: number = Date.now()): OfficeDayExhaustedError | null {
  const m = /^STUDIO_SCOPE_BUDGET_EXHAUSTED:\s*(\S+) needs \$([0-9.]+); \$([0-9.]+) available/.exec(message);
  if (!m && !message.startsWith('STUDIO_SCOPE_BUDGET_EXHAUSTED:')) return null;
  const amount = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  // The database's own words stay at the end, for the logs and the run's diagnostic.
  return new OfficeDayExhaustedError(m?.[1] ?? 'office', amount(m?.[2]), amount(m?.[3]), nextOfficeDayStart(now), message.slice(0, 300));
}

/**
 * A price policy is valid until a person has to check its prices again (runbooks/SPENDING_POLICY.md).
 * From 14 days before that instant it is `expiring` (a /v1/health warning); from the instant, `expired`
 * and paid calls priced by it are refused (ADR-093, ADR-159).
 */
export function spendingPolicyValidity(reviewBy: string, now: number = Date.now(), warnDays = 14): {
  status: 'valid' | 'expiring' | 'expired'; reviewBy: string; daysLeft: number;
} {
  const until = Date.parse(reviewBy);
  const left = until - now;
  const daysLeft = Number.isFinite(left) ? Math.floor(left / 86_400_000) : 0;
  const status = !Number.isFinite(left) || left <= 0 ? 'expired' : left <= warnDays * 86_400_000 ? 'expiring' : 'valid';
  return { status, reviewBy, daysLeft: Math.max(0, daysLeft) };
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
  /** Financial evidence alone never clears an execution-uncertainty hold. */
  attestedUsd?: number | null;
  reservedUsd?: number | null;
  costBasis?: StudioCostBasis | null;
}

/** `price_list`: a published per-item price (a Gemini image at its size) is the charge itself (ADR-159). */
export type StudioCostBasis = 'usage' | 'estimate' | 'unavailable' | 'not_accepted' | 'price_list';

export interface StudioCallReservation {
  version: 1;
  policy: string;
  requestSha256: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Non-content evidence used to bound media input; retained in the admission JSON. */
  nativeInputCount?: {
    version: 1;
    model: string;
    requestSha256: string;
    inputTokens: number;
    object: string;
  };
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
  const count = value.nativeInputCount;
  if (count && (count.version !== 1 || typeof count.model !== 'string' || !count.model ||
      typeof count.object !== 'string' || !count.object || count.requestSha256 !== value.requestSha256 ||
      !Number.isSafeInteger(count.inputTokens) || count.inputTokens <= 0 || count.inputTokens > value.inputTokens)) throw invalid();
}

export interface StudioBudgetUsage {
  daily?: StudioDailyBudget | null;
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

/** Shared Studio/evaluation/retained-voice daily aggregates; historical name retained. */
export interface StudioDailyBudget {
  day: string;
  timezone: 'Asia/Baghdad';
  policyVersion: number;
  scopes: Array<{ scope: 'office' | 'client' | 'role'; subject: string; maxUsd: number;
    spentUsd: number; heldUsd: number; remainingUsd: number; historyIncomplete: boolean }>;
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
        (call.settledUsd !== null && (!Number.isFinite(call.settledUsd) || call.settledUsd < 0 || call.settledUsd > Number.MAX_SAFE_INTEGER / 1_000_000)) ||
        (call.attestedUsd != null && (!Number.isFinite(call.attestedUsd) || call.attestedUsd < 0 || call.attestedUsd > Number.MAX_SAFE_INTEGER / 1_000_000))) {
      return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
    }
    // Uncertainty can coexist with an already reported partial charge. The zero placeholder
    // contributes nothing, but a positive estimate must survive settlement or response loss.
    const known = call.estimatedUsd;
    if (call.reservedUsd != null && (!Number.isFinite(call.reservedUsd) || call.reservedUsd <= 0 || call.reservedUsd > Number.MAX_SAFE_INTEGER / 1_000_000)) {
      return { ...usage, blocker: 'STUDIO_BUDGET_INVALID' };
    }
    usage.knownUsdEstimate += known;
    const attributed = Math.max(call.settledUsd ?? 0, call.attestedUsd ?? 0);
    usage.attestedAdditionalUsd += Math.max(0, attributed - known);
    if (call.status === 'uncertain' && call.settledUsd === null) usage.unresolvedCalls++;
    if (call.reservedUsd != null) {
      const finalCost = call.settledUsd !== null || call.attestedUsd != null ||
        (call.status !== 'uncertain' && (call.costBasis === 'usage' || call.costBasis === 'not_accepted' || call.costBasis === 'price_list'));
      if (!finalCost) usage.reservedAdditionalUsd += Math.max(0, call.reservedUsd - known);
      if (studioUsdMicros(Math.max(known, attributed)) > studioUsdMicros(call.reservedUsd)) {
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
    throw new StudioBudgetExhaustedError(`The next request needs a $${reservedUsd.toFixed(6)} reservation; $${(usage.remainingUsd ?? 0).toFixed(6)} remains.`,
      { reservedUsd, remainingUsd: usage.remainingUsd ?? 0, maxUsd: usage.maxUsd, accountedUsd: usage.accountedUsd });
  }
}
