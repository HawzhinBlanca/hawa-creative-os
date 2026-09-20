// Read-only offline probes: no provider, database or network access and no file writes.
// Run at repository root with node --import tsx <this file>.
import { EvaluationRunner } from '../../../packages/evals/src/runner.ts';
import { FakeModelGateway } from '../../../packages/testkit/src/fake-model-gateway.ts';
import { LiveRunner } from '../../../packages/evals/src/design-studio/live-runner.ts';
import { generateMarkdownReport } from '../../../packages/evals/src/design-studio/report-generator.ts';

globalThis.fetch = async () => { throw new Error('Network forbidden in audit'); };
const out = { source: '9c22026f444c81494d286354960a0b10efaa1176', scope: 'offline counterexamples, no external effects' };
out.alwaysAbstain = await new EvaluationRunner({ generateStructured: async () => ({ ok: true, value: { value: { decision: 'abstain', confidence: 1 } } }) }).runRoutingAndBriefTournament();
out.defaultFakeGateway = await new EvaluationRunner().runRoutingAndBriefTournament();
class MissingIdentity extends FakeModelGateway {
  async generateStructured(ctx, req) {
    const result = await super.generateStructured(ctx, req);
    if (result.ok) result.value.value = { decision: result.value.value.decision, confidence: result.value.value.confidence };
    return result;
  }
}
out.missingClientProjectAndBrief = await new EvaluationRunner(new MissingIdentity()).runRoutingAndBriefTournament();
const synthetic = new LiveRunner({ bearerToken: 'audit-synthetic', baseUrl: 'http://invalid.local' });
let i = 0;
synthetic.runBrief = async () => ({
  briefId: `counterexample-${++i}`, briefName: 'Aggregate missing swaps', language: 'en', dimensions: '100x100',
  status: 'transferred', ladderRung: 0, rungsTriggered: [], callsCount: 1, spentUsd: 0, durationMs: 1,
  winnerScore: 9, canary: { passed: true, verdict: 'RELIABLE', winnerId: 'synthetic' },
  tournament: { winnerId: 'synthetic', candidateScores: {}, swapConsistencyRate: i === 1 ? 1 : undefined, pairwiseRounds: i === 1 ? 4 : 0 },
  hardQaEscapes: 0, canvaDesignId: 'synthetic', previewSha256: 'synthetic',
  parity: { parity: 'match', divergences: [], fontSubstituted: false, textReflowed: false, copyVisibleIdentical: true }, fontFidelity: 'exact',
});
const log = console.log;
console.log = () => {};
const report = await synthetic.runAll(Array.from({ length: 24 }, () => ({ id: 'synthetic', name: 'synthetic' })));
console.log = log;
out.missingSwapMeasurements = {
  measuredRuns: 1, totalRuns: 24, aggregateSwapConsistency: report.tournamentSwapConsistencyRate,
  emittedRow: generateMarkdownReport(report).split('\n').find(l => l.includes('| Tournament Swap Consistency |')),
};
console.log(JSON.stringify(out, null, 2));
