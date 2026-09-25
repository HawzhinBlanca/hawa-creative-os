import { describe, it, expect, vi } from 'vitest';
import { EvaluationRunner } from '../src/runner.js';
import { ResilientModelGateway } from '@hawa/integrations';

describe('Evals: Tournament & Acceptance Benchmarks', () => {
  const runner = new EvaluationRunner();

  it('evaluates routing and brief holdout cases with 0 critical violations', async () => {
    const summary = await runner.runRoutingAndBriefTournament();
    expect(summary.totalCases).toBe(200);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
  });

  it('checks the label-derived retrieval fixture without claiming independent relevance', async () => {
    const summary = await runner.runRetrievalEvaluation();
    expect(summary.totalCases).toBe(20);
    expect(summary.passRate).toBe(100);
    expect(summary.criticalViolations).toBe(0);
    expect(summary.admissionEligible).toBe(false);
    expect(summary.dataset).toContain('synthetic label-derived contract');
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
    expect(full.admissionEligible).toBe(false);
  });

  it('does not call an uncredentialed provider or qualify its failed tournament', async () => {
    const keys = ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
    const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected provider request'); });
    try {
      const full = await new EvaluationRunner(new ResilientModelGateway()).runFullTournament();
      expect(full.routing.failedCases).toBe(full.routing.totalCases);
      expect(full.routing.passRate).toBe(0);
      expect(full.overallPassRate).toBeLessThan(95);
      expect(full.admissionEligible).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  }, 25000);
});
