/** Fixture diagnostics only; these results never grant model or editor admission. */
export interface EvaluationCaseResult {
  caseId: string;
  status: 'passed' | 'failed' | 'not_executed' | 'unreported';
  criticalViolations: number;
}

export interface EvaluationDatasetSource {
  file: string;
  sha256: string;
}
