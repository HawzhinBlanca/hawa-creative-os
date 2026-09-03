import { describe, it, expect } from 'vitest';
import { EvaluationRunner } from '../src/runner.js';

describe('Evals: Tournament & Acceptance Benchmarks', () => {
  const runner = new EvaluationRunner();

  it('evaluates routing and brief holdout cases with 0 critical violations', async () => {
    const summary = await runner.runRoutingAndBriefTournament();
    expect(summary.totalCases).toBe(60);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
  });

  it('evaluates retrieval benchmark dataset with 100% precision', async () => {
    const summary = await runner.runRetrievalEvaluation();
    expect(summary.totalCases).toBe(20);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
  });
});
