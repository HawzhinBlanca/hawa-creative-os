import { describe, it, expect, vi } from 'vitest';
import { LiveRunner } from '../src/design-studio/live-runner.js';
import { EvaluationRunner } from '../src/runner.js';
import { generateMarkdownReport } from '../src/design-studio/report-generator.js';
import type { StudioEvalReport, StudioGoldenBrief } from '../src/design-studio/types.js';

describe('R01: Evidence Truthfulness and Preserved Failing Baseline', () => {
  const brief: StudioGoldenBrief = {
    id: 'test-audit-brief',
    name: 'Truthfulness Probe',
    language: 'en',
    clientId: 'synthetic',
    width: 1080,
    height: 1080,
    aspectLabel: '1:1',
    instructions: 'audit',
    rawRequestText: 'Create a test banner for audit',
    copyBlocks: [{ copyIndex: 0, text: 'Headline', role: 'title', script: 'latin' }],
  };

  it('rejects incomplete evidence and does not synthesize passing scores (Audit Probe 1)', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const payload =
        callCount === 1
          ? { id: 'task-incomplete-evidence' }
          : callCount === 2
            ? { runId: 'run-incomplete-evidence', status: 'transferred' }
            : callCount === 3
              ? { run: { status: 'transferred' } } // No winner, candidate, scores, or QA
              : null;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const runner = new LiveRunner({ baseUrl: 'http://127.0.0.1:9999', bearerToken: 'test' });
      const result = await runner.runBrief(brief);

      // Must NOT invent passing winnerScore 8.5
      expect(result.winnerScore).toBeUndefined();

      // Must NOT invent canary pass with 9.0 scores
      expect(result.canary.passed).toBe(false);
      expect(result.canary.verdict).toBe('UNMEASURED');
      expect(result.canary.scoreAgainstDegraded1Normal).toBeUndefined();

      // Must NOT invent tournament 1.0 swap consistency
      expect(result.tournament.swapConsistencyRate).toBeUndefined();
      expect(result.tournament.pairwiseRounds).toBe(0);

      // Must NOT invent parity 'match'
      expect(result.parity).toBeUndefined();

      // Status must reflect missing evidence, not claim clean transfer
      expect(result.status).toBe('incomplete');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails an always-abstaining model on non-abstaining cases (Audit Probe 2)', async () => {
    const alwaysAbstainGateway = {
      generateStructured: async () => ({
        ok: true,
        value: { value: { decision: 'abstain', confidence: 1.0 } },
      }),
    };

    const runner = new EvaluationRunner(alwaysAbstainGateway as any);
    const summary = await runner.runRoutingAndBriefTournament();

    // Out of 200 cases, exactly 5 require abstention, 195 must route
    expect(summary.totalCases).toBe(200);
    expect(summary.passedCases).toBe(5);
    expect(summary.failedCases).toBe(195);
    expect(summary.passRate).toBe(2.5);
  });

  it('detects and fails wrong-client negative controls', async () => {
    const wrongClientGateway = {
      generateStructured: async () => ({
        ok: true,
        value: {
          value: {
            decision: 'route_matched',
            clientId: 'WRONG_CLIENT_INTENTIONAL',
            confidence: 0.95,
          },
        },
      }),
    };

    const runner = new EvaluationRunner(wrongClientGateway as any);
    const summary = await runner.runRoutingAndBriefTournament();

    // All non-abstain cases should fail client matching
    expect(summary.failedCases).toBe(200);
    expect(summary.passRate).toBe(0);
  });

  it('detects corrupted numbers and confidence out of bounds as critical violations', async () => {
    const badConfidenceGateway = {
      generateStructured: async () => ({
        ok: true,
        value: {
          value: {
            decision: 'route_matched',
            confidence: 1.5, // invalid confidence > 1.0
          },
        },
      }),
    };

    const runner = new EvaluationRunner(badConfidenceGateway as any);
    const summary = await runner.runRoutingAndBriefTournament();

    expect(summary.criticalViolations).toBe(200);
    expect(summary.failedCases).toBe(200);
    expect(summary.passRate).toBe(0);
  });

  it('fails closed in markdown report generation when evidence is incomplete or unmeasured', () => {
    const incompleteReport: StudioEvalReport = {
      timestamp: new Date().toISOString(),
      mode: 'live',
      totalBriefs: 24,
      completedBriefs: 24,
      degradedBriefs: 0,
      failedBriefs: 0,
      canaryPassRate: 1.0,
      tournamentSwapConsistencyRate: 1.0,
      meanWinnerScore: 8.5,
      minWinnerScore: 8.0,
      hardQaEscapeCount: 0,
      totalSpentUsd: 10.0,
      meanSpentUsd: 0.4,
      meanDurationSeconds: 20,
      parityVerdicts: { match: 24, minor: 0, major: 0 },
      results: [
        {
          briefId: 'brief-1',
          briefName: 'Test',
          language: 'en',
          dimensions: '1080x1080',
          status: 'incomplete',
          ladderRung: 0,
          rungsTriggered: [],
          callsCount: 5,
          spentUsd: 0.4,
          durationMs: 20000,
          winnerScore: undefined, // missing score!
          canary: { winnerId: '', passed: false, verdict: 'UNMEASURED' },
          tournament: { winnerId: '', candidateScores: {} },
          hardQaEscapes: undefined, // missing QA!
          parity: undefined, // missing parity!
          fontFidelity: 'unmeasured',
        },
      ],
    };

    const md = generateMarkdownReport(incompleteReport);

    // Ensure gates fail closed
    expect(md).toContain('| Hard QA Escapes | 0 | 0 | FAIL |');
    expect(md).toContain('| Mean Winner Score | 8.50/10 | ≥ 8.0/10 | FAIL |');
    expect(md).toContain('| Canary Pass Rate | 100.0% (24/24) | ≥ 95.8% (≥23/24) | FAIL |');
  });
});
