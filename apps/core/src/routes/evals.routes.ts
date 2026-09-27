import { fixtureDatasetCatalog, readFixtureDataset } from '@hawa/evals';
import { createHash } from 'node:crypto';
import type { RouteContext } from './types.js';
import { EvaluationError } from '../services/durable-evaluations.js';

export function registerEvalsRoutes(ctx: RouteContext) {
  const { registerRoute, evaluationService, verifyRequestAuth, problem } = ctx;
  const scope = (c: any) => {
    const auth = verifyRequestAuth(c);
    const token=ctx.bearerTokenOf?.(c);
    return { tenantId: auth.tenantId!, userId: auth.userId!, role: auth.role,
      sessionHash:auth.authMethod==='google_oidc' && token ? createHash('sha256').update(token).digest('hex') : undefined };
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
  registerRoute('post', '/evaluations/runs/:runId/settlement', async (c: any) => {
    if (!evaluationService) return problem(c,503,'Evaluation Database Required');
    try {
      return c.json(await evaluationService.settle(scope(c),c.req.param('runId'),c.req.header('Idempotency-Key'),await c.req.json().catch(()=>null)));
    } catch(error) {
      if(error instanceof EvaluationError) return problem(c,error.status,error.code,error.message);
      return problem(c,503,'Settlement Outcome Unavailable','Retry the same settlement action or reload its recorded evidence.');
    }
  });

  registerRoute('get', '/evaluations/datasets', (c: any) => {
    c.header('Cache-Control', 'no-store');
    return c.json(fixtureDatasetCatalog());
  });

  registerRoute('get', '/evaluations/datasets/:datasetId/cases', (c: any) => {
    c.header('Cache-Control', 'no-store');
    try {
      const dataset = readFixtureDataset(c.req.param('datasetId'));
      if (!dataset) return problem(c, 404, 'Dataset Not Found');
      return c.json({ datasetId: dataset.id, total: dataset.cases.length, source: dataset.source, cases: dataset.cases });
    } catch {
      return problem(c, 503, 'Dataset Unavailable', 'The fixture corpus could not be read or validated. No case results are available.');
    }
  });
}
