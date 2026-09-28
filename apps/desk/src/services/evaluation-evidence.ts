import type { EvaluationDatasetSource } from '@hawa/contracts';

export const EVALUATION_SUITES = [
  ['routing', 'Routing fixtures'],
  ['retrieval', 'Synthetic retrieval contracts'],
  ['copyGuard', 'Protected-copy fixtures'],
  ['visualJudge', 'Synthetic visual rubric'],
  ['adversarialSafety', 'Attack-pattern fixtures'],
] as const;
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? `${Math.round(value)}%` : '—';
export const recordedTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').slice(0,19) + ' UTC' : null;

export function statsFromReport(value: unknown) {
  const report = object(value);
  const suites = EVALUATION_SUITES.map(([key]) => object(report[key])).filter(suite => Object.keys(suite).length);
  const validCounts = suites.length > 0 && suites.every(suite => count(suite.totalCases) && count(suite.passedCases) && suite.passedCases <= suite.totalCases);
  const total = validCounts ? suites.reduce((n, suite) => n + Number(suite.totalCases), 0) : 0;
  const missing = suites.some(suite => Number(suite.unreportedCases) > 0 || Number(object(suite.execution).unexecutedCases) > 0);
  return {
    copyGuard: percent(object(report.copyGuard).passRate),
    recall: percent(object(report.retrieval).passRate),
    overall: report.executionStatus === 'stopped' || missing || (suites.length > 0 && !validCounts) ? '—' : percent(report.overallPassRate),
    testsPassed: total > 0 ? suites.reduce((n, suite) => n + Number(suite.passedCases), 0) : null,
    totalTests: total > 0 ? total : null,
  };
}

/** An aggregate cannot prove a case; a result for different corpus bytes cannot prove this case. */
export function caseOutcome(value: unknown, source: EvaluationDatasetSource | null, caseId: string) {
  const report = object(value);
  const suites = EVALUATION_SUITES.map(([key]) => object(report[key]));
  if (!source || !/^[a-f0-9]{64}$/.test(source.sha256)) return 'Not reported';
  const matching = suites.filter(suite => object(suite.source).file === source.file);
  if (!matching.length) return suites.some(suite => Array.isArray(suite.caseResults)) ? 'Not executed by this tournament' : 'Not reported';
  if (matching.length !== 1 || object(matching[0].source).sha256 !== source.sha256) return 'Dataset changed';
  const results = matching[0].caseResults;
  if (!Array.isArray(results)) return 'Not reported';
  const found = results.map(object).filter(result => result.caseId === caseId);
  if (found.length !== 1) return 'Not reported';
  const labels: Record<string, string> = {passed:'Passed',failed:'Failed',not_executed:'Not executed',unreported:'Not reported'};
  return typeof found[0].status === 'string' ? labels[found[0].status] || 'Not reported' : 'Not reported';
}
