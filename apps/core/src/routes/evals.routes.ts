import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RouteContext } from './types.js';

export function registerEvalsRoutes(ctx: RouteContext) {
  const { registerRoute, evaluationRunner, evalRuns, problem } = ctx;

  // Evaluation Runs
  registerRoute('post', '/evaluations/runs', async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    const runId = crypto.randomUUID();

    const evalReport = await evaluationRunner.runFullTournament();
    const run = {
      runId,
      name: body.name || 'Hawa Creative Full Tournament',
      report: evalReport,
      createdAt: new Date().toISOString(),
    };
    evalRuns.set(runId, run);

    return c.json(run, 201);
  });

  registerRoute('get', '/evaluations/runs', (c: any) => {
    return c.json(Array.from(evalRuns.values()));
  });

  registerRoute('get', '/evaluations/runs/:runId', (c: any) => {
    const runId = c.req.param('runId');
    const run = evalRuns.get(runId);
    if (!run) return problem(c, 404, 'Evaluation Run Not Found');
    return c.json(run);
  });

  registerRoute('get', '/evaluations/datasets', (c: any) => {
    return c.json([
      { id: 'brief', name: 'Brief Builder', casesCount: 200, status: 'ok', file: 'evals/routing_brief.jsonl', description: 'Blind holdout · exact versions · no production state mutation' },
      { id: 'rtl', name: 'RTL Golden Suite', casesCount: 40, status: 'ok', file: 'evals/rtl_golden_cases.jsonl', description: 'UAX #9 bidi paragraph embedding, isolate formatting, and Sorani numerals' },
      { id: 'retrieval', name: 'Retrieval & Leakage', casesCount: 20, status: 'ok', file: 'evals/retrieval_eval.jsonl', description: 'Cross-client leakage tests, negative context filtering, and scope locks' },
    ]);
  });

  registerRoute('get', '/evaluations/datasets/:datasetId/cases', (c: any) => {
    const datasetId = c.req.param('datasetId');
    let relFile = 'evals/routing_brief.jsonl';
    if (datasetId === 'rtl') relFile = 'evals/rtl_golden_cases.jsonl';
    else if (datasetId === 'retrieval') relFile = 'evals/retrieval_eval.jsonl';

    try {
      const p1 = path.resolve(process.cwd(), relFile);
      const p2 = path.resolve(process.cwd(), '../../', relFile);
      const targetPath = fs.existsSync(p1) ? p1 : p2;
      const content = fs.readFileSync(targetPath, 'utf-8');
      const cases = content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      return c.json({ datasetId, total: cases.length, cases });
    } catch (err: any) {
      return problem(c, 500, 'Dataset Read Error', `Unable to load dataset ${datasetId}: ${err.message}`);
    }
  });
}
