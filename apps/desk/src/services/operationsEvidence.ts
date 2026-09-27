import type { OperationsReliabilityReport } from '@hawa/contracts';

/** Accept only the versioned evidence the current screen understands. */
export function parseOperationsReliability(value: unknown): OperationsReliabilityReport | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const a = v.availability as Record<string, unknown> | undefined;
  const l = v.latency as Record<string, unknown> | undefined;
  if (v.schemaVersion !== 1 || v.evidenceKind !== 'unmeasured' || typeof v.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(v.checkedAt)) || typeof v.nextAction !== 'string' || !v.nextAction ||
      !a || a.targetPercent !== 99.5 || a.window !== 'calendar_month' || a.timeZone !== 'Asia/Baghdad' ||
      a.observedPercent !== null || a.sloCompliant !== null || a.observationCount !== 0 ||
      !l || l.p50Ms !== null || l.p95Ms !== null || l.p99Ms !== null || l.observationCount !== 0) return null;
  return v as unknown as OperationsReliabilityReport;
}
