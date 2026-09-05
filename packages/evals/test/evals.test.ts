import { describe, it, expect } from 'vitest';
import { EvaluationRunner } from '../src/runner.js';
import { ResilientModelGateway } from '@hawa/integrations';

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

  it('evaluates copy guard against unauthorized price/number mutations', async () => {
    const summary = await runner.runCopyGuardEvaluation();
    expect(summary.totalCases).toBe(4);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
  });

  it('evaluates visual judge rubric across 10 dimensions without hard rule overrides', async () => {
    const summary = await runner.runVisualJudgeEvaluation();
    expect(summary.totalCases).toBe(10);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
  });

  it('evaluates adversarial safety and prompt-injection defenses with 0 escapes', async () => {
    const summary = await runner.runPromptInjectionAndSafetyEvaluation();
    expect(summary.totalCases).toBe(5);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
  });

  it('runs full tournament aggregating all benchmarks with 100% pass rate', async () => {
    const full = await runner.runFullTournament();
    expect(full.overallPassRate).toBe(100);
    expect(full.routing.passRate).toBe(100);
    expect(full.retrieval.passRate).toBe(100);
    expect(full.copyGuard.passRate).toBe(100);
    expect(full.visualJudge.passRate).toBe(100);
    expect(full.adversarialSafety.passRate).toBe(100);
  });

  it('executes full tournament cleanly with ResilientModelGateway with zero critical violations', async () => {
    const liveGateway = new ResilientModelGateway();
    const liveRunner = new EvaluationRunner(liveGateway);
    const full = await liveRunner.runFullTournament();
    expect(full.overallPassRate).toBeGreaterThanOrEqual(95);
    expect(full.routing.criticalViolations).toBe(0);
    expect(full.retrieval.criticalViolations).toBe(0);
    expect(full.adversarialSafety.criticalViolations).toBe(0);
  });
});
