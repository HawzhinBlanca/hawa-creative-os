export interface EvaluationCallSettlement {
  callId: string;
  conclusion: 'provider_not_accepted' | 'provider_finished';
  reportedCostUsd: number;
  evidenceReference: string;
  evidenceSha256: string;
}
export interface EvaluationSettlementInput {
  expectedSnapshot: string;
  reason: string;
  calls: EvaluationCallSettlement[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));

/** Provider evidence is an attributed human assertion, never inferred from a timeout. */
export function parseEvaluationSettlement(value: unknown): EvaluationSettlementInput | null {
  if (!object(value) || !keys(value, ['expectedSnapshot', 'reason', 'calls']) ||
      typeof value.expectedSnapshot !== 'string' || !hash.test(value.expectedSnapshot) ||
      typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 ||
      !Array.isArray(value.calls) || value.calls.length > 1000) return null;
  const calls: EvaluationCallSettlement[] = [];
  for (const c of value.calls) {
    if (!object(c) || !keys(c, ['callId','conclusion','reportedCostUsd','evidenceReference','evidenceSha256']) ||
        typeof c.callId !== 'string' || !uuid.test(c.callId) ||
        !['provider_not_accepted','provider_finished'].includes(String(c.conclusion)) ||
        typeof c.reportedCostUsd !== 'number' || !Number.isFinite(c.reportedCostUsd) ||
        c.reportedCostUsd < 0 || c.reportedCostUsd > 1_000_000 ||
        (c.conclusion === 'provider_not_accepted' && c.reportedCostUsd !== 0) ||
        typeof c.evidenceReference !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(c.evidenceReference) ||
        typeof c.evidenceSha256 !== 'string' || !hash.test(c.evidenceSha256)) return null;
    calls.push(c as unknown as EvaluationCallSettlement);
  }
  if (new Set(calls.map(c => c.callId)).size !== calls.length) return null;
  return { expectedSnapshot:value.expectedSnapshot, reason:value.reason.trim(), calls:calls.sort((a,b)=>a.callId.localeCompare(b.callId)) };
}

export function coversUnsettledEvaluationCalls(calls: EvaluationCallSettlement[], ledger: Array<{id:string;status:string}>): boolean {
  const unsettled = ledger.filter(c => c.status === 'pending' || c.status === 'uncertain');
  return calls.length === unsettled.length && unsettled.every(c => calls.some(s => s.callId === c.id));
}
