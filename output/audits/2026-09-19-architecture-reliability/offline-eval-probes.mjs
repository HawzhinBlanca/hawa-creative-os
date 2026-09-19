// Read-only counterexample probes. All network calls are intercepted; no credentials,
// database, provider APIs, or production services are accessed.
// Run from repository root: node --import tsx output/audits/2026-09-19-architecture-reliability/offline-eval-probes.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { LiveRunner } from '../../../packages/evals/src/design-studio/live-runner.ts';
import { EvaluationRunner } from '../../../packages/evals/src/runner.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.chdir(root);
const output = {
  auditDate: '2026-09-19',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'Offline counterexamples only; no claim about deployed runtime or live providers',
};

const originalFetch = globalThis.fetch;
let interceptedCalls = 0;
globalThis.fetch = async () => {
  interceptedCalls += 1;
  const payload = interceptedCalls === 1
    ? { id: 'audit-synthetic-task' }
    : interceptedCalls === 2
      ? { runId: 'audit-run', status: 'transferred' }
      : interceptedCalls === 3
        ? { run: { status: 'transferred' } }
        : null;
  if (!payload) throw new Error('Unexpected fetch: offline probe refuses any additional request');
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const result = await new LiveRunner({ baseUrl: 'http://invalid.local', bearerToken: 'synthetic' }).runBrief({
    id: 'audit', name: 'No QA evidence', clientId: 'synthetic', rawRequestText: 'test',
    width: 100, height: 100, language: 'en', copyBlocks: [], instructions: '',
  });
  output.missingEvidence = {
    stimulus: 'API returns transferred status but no winner, image, QA, canary, tournament, or parity evidence',
    expected: 'Missing evidence must be unknown/failed and cannot constitute qualification',
    interceptedCalls,
    observed: {
      status: result.status, winnerScore: result.winnerScore, canary: result.canary,
      tournament: result.tournament, parity: result.parity, hardQaEscapes: result.hardQaEscapes,
      previewSha256: result.previewSha256,
    },
    defectReproduced: result.winnerScore === 8.5 && result.canary.passed === true && result.parity?.parity === 'match',
  };
} finally {
  globalThis.fetch = originalFetch;
}

const cases = readFileSync(resolve(root, 'evals/routing_brief.jsonl'), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const alwaysAbstain = {
  generateStructured: async () => ({ ok: true, value: { value: { decision: 'abstain', confidence: 1 } } }),
};
const routing = await new EvaluationRunner(alwaysAbstain).runRoutingAndBriefTournament();
output.alwaysAbstain = {
  stimulus: 'Every case gets only decision=abstain and confidence=1; no client, project, brief, or exact copy',
  expected: 'This response cannot demonstrate correct routing/brief generation for all cases',
  datasetCases: cases.length,
  casesNotRequiringAbstention: cases.filter((entry) => entry.expected?.must_abstain === false).length,
  observed: routing,
  defectReproduced: routing.passRate === 100,
};
console.log(JSON.stringify(output, null, 2));
