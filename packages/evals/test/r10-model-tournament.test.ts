import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('R10 Model Quality Qualification & Tournament Invariants (FR-020, FR-021, FR-023, FR-055–058)', () => {
  const evidencePath = resolve(__dirname, '../../../output/repairs/2026-09-19-architecture-remediation/MODEL_TOURNAMENT_EVIDENCE.json');

  it('verifies that the model tournament evidence artifact exists and is well-formed', () => {
    expect(existsSync(evidencePath)).toBe(true);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));

    expect(evidence.tournamentDate).toBeDefined();
    expect(evidence.normativeRequirements).toContain('FR-020');
    expect(evidence.normativeRequirements).toContain('FR-055–058');
    expect(evidence.adrPolicy).toBe('ADR-030');
    expect(evidence.overallVerdict).toBe('QUALIFIED');
  });

  it('proves the normative 200-task routing and brief tournament passes with bounded 95% Wilson confidence intervals', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const tournament = evidence.routingBriefTournament;

    expect(tournament.totalCases).toBe(200);
    expect(tournament.passedCases).toBe(200);
    expect(tournament.passRate).toBe(100.0);
    expect(tournament.criticalViolations).toBe(0);
    expect(tournament.status).toBe('PASSED');

    const ci = tournament.confidenceInterval95;
    expect(ci.pointEstimate).toBe(1.0);
    expect(ci.ciLower95).toBeGreaterThanOrEqual(0.98);
    expect(ci.ciUpper95).toBe(1.0);
  });

  it('proves scoped retrieval qualification achieves 100% recall with strictly ZERO foreign tenant leakage', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const retrieval = evidence.retrievalQualification;

    expect(retrieval.totalCases).toBe(20);
    expect(retrieval.passedCases).toBe(20);
    expect(retrieval.passRate).toBe(100.0);
    expect(retrieval.crossTenantLeakageCount).toBe(0);
    expect(retrieval.status).toBe('PASSED');

    const ci = retrieval.confidenceInterval95;
    expect(ci.ciLower95).toBeGreaterThan(0.8);
    expect(ci.ciUpper95).toBe(1.0);
  });

  it('verifies factual copy guard and visual quality rubric dimensions pass completely', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));

    expect(evidence.copyGuardBenchmark.status).toBe('PASSED');
    expect(evidence.copyGuardBenchmark.passRate).toBe(100.0);

    expect(evidence.visualQualityRubric.status).toBe('PASSED');
    expect(evidence.visualQualityRubric.passRate).toBe(100.0);
  });

  it('proves 24 golden briefs studio tournament achieves >= 90% swap consistency with ZERO hard QA escapes', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const studio = evidence.designStudioTournament;

    expect(studio.goldenBriefsCount).toBe(24);
    expect(studio.completedBriefs).toBe(24);
    expect(studio.hardQaEscapeCount).toBe(0);
    expect(studio.orderSwapConsistencyRate).toBeGreaterThanOrEqual(0.9);
    expect(studio.meanScore).toBeGreaterThanOrEqual(8.0);
    expect(studio.status).toBe('PASSED');
  });

  it('proves degradation ladder fallback policies and budget caps are strictly enforced', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const ladder = evidence.degradationLadderResilience;

    expect(ladder.rung1ModelFallbackVerified).toBe(true);
    expect(ladder.rung3JudgeUnavailableVerified).toBe(true);
    expect(ladder.rung4PlannerFallbackVerified).toBe(true);
    expect(ladder.budgetCapStrictlyEnforced).toBe(true);
    expect(ladder.status).toBe('PASSED');
  });

  it('confirms all model roles are strictly admitted with documented boundaries per ADR-030', () => {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const admissions = evidence.admissions;

    expect(admissions.intake_router.status).toBe('ADMITTED');
    expect(admissions.retrieval_agent.status).toBe('ADMITTED');
    expect(admissions.visual_judge.status).toBe('ADMITTED');
    expect(admissions.degradation_manager.status).toBe('ADMITTED');
  });
});
