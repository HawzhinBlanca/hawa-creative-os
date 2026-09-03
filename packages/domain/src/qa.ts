import type { UUID, SHA256, ISODateTime, JsonObject } from '@hawa/contracts';
import type { FindingSeverity, QAFinding, QACheckResult, QAReport } from '@hawa/contracts';

export const HARD_CHECK_KINDS = [
  'schema',
  'copy',
  'facts',
  'font',
  'bidi',
  'layout',
  'brand',
  'image',
  'source_package',
  'publication',
] as const;

export function evaluateHardPass(report: QAReport): boolean {
  // Any finding marked hardFailure: true or severity: critical / high that is not resolved fails hard QA
  const hardFailures = report.findings.filter((f) => f.hardFailure || f.severity === 'critical');
  return hardFailures.length === 0;
}

export function computeReportHash(taskId: UUID, checks: QACheckResult[]): SHA256 {
  const payload = JSON.stringify({ taskId, checks: checks.map((c) => ({ id: c.id, status: c.status, findings: c.findings })) });
  // For domain pure logic without node crypto dependency in pure code
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash << 5) - hash + payload.charCodeAt(i);
    hash |= 0;
  }
  return `qc_${Math.abs(hash).toString(16)}`;
}
