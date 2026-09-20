// Instruments the real qualification script, replacing expensive dependencies with explicit
// failure returns and intercepting its artifact write. No application/source file is changed.
import fs from 'node:fs';
import { EvaluationRunner } from '../../../packages/evals/src/runner.ts';
import { OfflineRunner } from '../../../packages/evals/src/design-studio/offline-runner.ts';

globalThis.fetch = async () => { throw new Error('Network forbidden in audit'); };
const fail = async () => ({ dataset: 'audit-all-fail', totalCases: 200, passedCases: 0, failedCases: 200, passRate: 0, criticalViolations: 200 });
for (const method of ['runRoutingAndBriefTournament', 'runRetrievalEvaluation', 'runCopyGuardEvaluation', 'runVisualJudgeEvaluation']) EvaluationRunner.prototype[method] = fail;
OfflineRunner.prototype.runAll = async () => ({ totalBriefs: 24, completedBriefs: 0, meanWinnerScore: 0, canaryPassRate: 0, tournamentSwapConsistencyRate: 0, hardQaEscapeCount: 24 });
OfflineRunner.prototype.runBrief = async () => ({ rungsTriggered: [], spentUsd: 0 });
const write = fs.writeFileSync;
const mkdir = fs.mkdirSync;
const log = console.log;
console.log = () => {};
fs.mkdirSync = () => undefined;
fs.writeFileSync = (file, bytes) => {
  if (!String(file).endsWith('/MODEL_TOURNAMENT_EVIDENCE.json')) throw new Error('Unexpected file write refused');
  const evidence = JSON.parse(bytes);
  fs.writeFileSync = write;
  fs.mkdirSync = mkdir;
  console.log = log;
  console.log(JSON.stringify({
    source: '9c22026f444c81494d286354960a0b10efaa1176', scope: 'all component failures injected, output write intercepted',
    routingStatus: evidence.routingBriefTournament.status, retrievalStatus: evidence.retrievalQualification.status,
    visualStatus: evidence.visualQualityRubric.status, studioStatus: evidence.designStudioTournament.status,
    failedFallbacks: evidence.degradationLadderResilience, admissions: evidence.admissions, overallVerdict: evidence.overallVerdict,
  }, null, 2));
};
await import('../../../scripts/run_model_tournament.ts');
