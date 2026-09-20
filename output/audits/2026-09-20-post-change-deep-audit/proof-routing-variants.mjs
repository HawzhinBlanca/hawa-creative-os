import fs from 'node:fs';
import { EvaluationRunner } from '../../../packages/evals/src/runner.ts';
import { FakeModelGateway } from '../../../packages/testkit/src/fake-model-gateway.ts';
globalThis.fetch = async () => { throw new Error('Audit forbids network'); };
const cases = fs.readFileSync('evals/routing_brief.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const allClients = [...new Set(cases.map(c => c.expected.client).filter(Boolean))].join('|');
const allProjects = [...new Set(cases.map(c => c.expected.project).filter(Boolean))].join('|');
class AmbiguousIdentity extends FakeModelGateway {
  async generateStructured(ctx, request) {
    const result = await super.generateStructured(ctx, request);
    if (result.ok) Object.assign(result.value.value, {
      clientId: `UNRESOLVED:${allClients}`, projectId: `UNRESOLVED:${allProjects}`,
      exactCopy: ['Incorrect factual text: price 9999999; date 2099-01-01'],
    });
    return result;
  }
}
console.log(JSON.stringify({
  scope: 'Actual evaluator with offline injected response; no database/network/files written',
  source: '6d3c583791a404c914e25b77dda558b16d26bd6c',
  defaultSentinelIdentity: await new EvaluationRunner().runRoutingAndBriefTournament(),
  singleAmbiguousIdentityForAllCases: await new EvaluationRunner(new AmbiguousIdentity()).runRoutingAndBriefTournament(),
  invalidVisualResponse: await new EvaluationRunner({ generateStructured: async () => ({ ok: true, value: { value: { decision: 'NOT_A_VALID_VERDICT', passed: 'false' } } }) }).runVisualJudgeEvaluation(),
}, null, 2));
