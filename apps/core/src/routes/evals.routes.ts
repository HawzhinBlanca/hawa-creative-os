import fs from 'node:fs';
import path from 'node:path';
import type { RouteContext } from './types.js';
import { EvaluationError } from '../services/durable-evaluations.js';

export function registerEvalsRoutes(ctx: RouteContext) {
  const { registerRoute, evaluationService, verifyRequestAuth, problem } = ctx;
  const scope = (c: any) => {
    const auth = verifyRequestAuth(c);
    return { tenantId: auth.tenantId!, userId: auth.userId!, role: auth.role };
  };
  registerRoute('post', '/evaluations/runs', async (c: any) => {
    if (!evaluationService) return problem(c, 503, 'Evaluation Database Required', 'No model work started; durable evaluation storage is unavailable.');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(c,400,'Evaluation Input Invalid');
    try {
      const actionId = c.req.header('Idempotency-Key');
      if (body.actionId && body.actionId !== actionId) return problem(c,400,'Conflicting Action IDs');
      return c.json(await evaluationService.run(scope(c), {actionId, name:body.name}), 200);
    } catch (error) {
      if (error instanceof EvaluationError) return problem(c,error.status,error.code,error.message);
      return problem(c,503,'Evaluation Outcome Unavailable','Reload or retry the same action. A request may already have been admitted; do not start a fresh run.');
    }
  });
  registerRoute('get', '/evaluations/runs', async (c: any) => {
    if (!evaluationService) return problem(c,503,'Evaluation Database Required');
    return c.json(await evaluationService.list(scope(c)));
  });
  registerRoute('get', '/evaluations/runs/:runId', async (c: any) => {
    if (!evaluationService) return problem(c,503,'Evaluation Database Required');
    const run = await evaluationService.get(scope(c),c.req.param('runId'));
    return run ? c.json(run) : problem(c,404,'Evaluation Run Not Found');
  });

  registerRoute('get', '/evaluations/datasets', (c: any) => {
    return c.json([
      { id: 'brief', name: 'Brief Builder', casesCount: 200, status: 'ok', file: 'evals/routing_brief.jsonl', description: 'Fixture diagnostics · not model admission evidence' },
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
