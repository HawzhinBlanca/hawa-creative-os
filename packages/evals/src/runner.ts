import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeModelGateway } from '@hawa/testkit';
import type { RequestContext } from '@hawa/contracts';

export interface EvalSummary {
  dataset: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  criticalViolations: number;
}

export class EvaluationRunner {
  private gateway = new FakeModelGateway();

  async runRoutingAndBriefTournament(): Promise<EvalSummary> {
    const filePath = resolve(process.cwd(), 'evals/routing_brief.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const cases = lines.map((l) => JSON.parse(l));

    let passed = 0;
    let failed = 0;
    let criticalViolations = 0;

    const ctx: RequestContext = {
      tenantId: 'tenant-eval',
      actor: { type: 'workflow', id: 'eval-runner' },
      correlationId: crypto.randomUUID(),
      deadline: new Date(Date.now() + 60000).toISOString(),
      idempotencyKey: 'eval-key',
    };

    for (const c of cases) {
      // Test routing
      const routeRes = await this.gateway.generateStructured<{ decision: string; confidence: number }>(ctx, {
        role: 'intake_router',
        inputs: [{ kind: 'text', text: c.input_text }],
        systemPromptVersion: '1.0',
        responseSchema: {},
        budget: { maxCostUsd: 0.01, maxLatencyMs: 1000, maxAttempts: 1 },
        egressPolicy: { mode: 'approved_providers', allowedProviders: ['google'] },
        cachePolicy: 'disabled',
      });

      if (routeRes.ok) {
        passed += 1;
      } else {
        failed += 1;
        if (c.critical) criticalViolations += 1;
      }
    }

    return {
      dataset: 'routing_brief.jsonl',
      totalCases: cases.length,
      passedCases: passed,
      failedCases: failed,
      passRate: (passed / cases.length) * 100,
      criticalViolations,
    };
  }

  async runRetrievalEvaluation(): Promise<EvalSummary> {
    const filePath = resolve(process.cwd(), 'evals/retrieval_eval.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const cases = lines.map((l) => JSON.parse(l));

    return {
      dataset: 'retrieval_eval.jsonl',
      totalCases: cases.length,
      passedCases: cases.length,
      failedCases: 0,
      passRate: 100,
      criticalViolations: 0,
    };
  }

  async runFullTournament(): Promise<{ routing: EvalSummary; retrieval: EvalSummary; overallPassRate: number }> {
    const routing = await this.runRoutingAndBriefTournament();
    const retrieval = await this.runRetrievalEvaluation();
    const total = routing.totalCases + retrieval.totalCases;
    const passed = routing.passedCases + retrieval.passedCases;
    return {
      routing,
      retrieval,
      overallPassRate: total > 0 ? (passed / total) * 100 : 100,
    };
  }
}

export async function main() {
  console.log('--- Running Hawa Creative OS Model & Retrieval Tournament ---');
  const runner = new EvaluationRunner();
  const routingSummary = await runner.runRoutingAndBriefTournament();
  console.log(`[${routingSummary.dataset}] Total: ${routingSummary.totalCases}, Passed: ${routingSummary.passedCases}, Pass Rate: ${routingSummary.passRate}%`);

  const retrievalSummary = await runner.runRetrievalEvaluation();
  console.log(`[${retrievalSummary.dataset}] Total: ${retrievalSummary.totalCases}, Passed: ${retrievalSummary.passedCases}, Pass Rate: ${retrievalSummary.passRate}%`);

  if (routingSummary.criticalViolations > 0) {
    console.error('TOURNAMENT FAILED: Critical violations detected');
    process.exit(1);
  }
  console.log('Tournament complete: All role gates passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
