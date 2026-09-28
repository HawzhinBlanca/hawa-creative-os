/**
 * ADR-124 judge experiment: incumbent P07 judge versus the brief-bound challenger.
 *
 *   Build the development corpus from the 24 golden briefs (no provider call):
 *     pnpm exec tsx scripts/run_judge_experiment.ts build-synthetic-corpus --out <new-dir>
 *
 *   Quote every exact request with the ADR-091 reservation policy, dispatching nothing:
 *     pnpm exec tsx scripts/run_judge_experiment.ts run --corpus <dir> --out <new-dir> --provider quote_only
 *
 *   End to end with the synthetic provider (needs HAWA_SPEND_STATE_DIR, so pretend spend stays out
 *   of the office ledger):
 *     HAWA_SPEND_STATE_DIR=<scratch> pnpm exec tsx scripts/run_judge_experiment.ts run --corpus <dir> --out <new-dir> \
 *       --provider synthetic --max-usd 20
 *
 *   Paid (owner only): the office daily ledger and cap apply, the run cap is mandatory, and the frozen
 *   plan hash must be typed back:
 *     OPENAI_API_KEY=... pnpm exec tsx scripts/run_judge_experiment.ts run --corpus <dir> --out <new-dir> \
 *       --provider openai --max-usd <cap> --confirm-plan <JUDGE_EXPERIMENT_PLAN_SHA256>
 *
 *   Analyse again, optionally with human labels collected blind to both judges:
 *     pnpm exec tsx scripts/run_judge_experiment.ts analyze --run <dir>/run.json --out <file> [--labels <labels.json>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGoldenBriefs } from '../packages/evals/src/design-studio/loader.js';
import {
  JUDGE_EXPERIMENT_PLAN_SHA256,
  analyzeJudgeExperiment,
  buildSyntheticJudgeCorpus,
  createJudgeExperimentClient,
  defaultJudgeExperimentModel,
  loadJudgeExperimentCorpus,
  runJudgeExperiment,
  type JudgeExperimentProvider,
  type JudgeExperimentRun,
} from '../packages/evals/src/judge-experiment.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const writeOnce = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

async function main() {
  const command = process.argv[2];
  if (command === 'build-synthetic-corpus') {
    const out = arg('out') ?? fail('--out <new-directory> is required');
    const result = buildSyntheticJudgeCorpus({ briefs: loadGoldenBriefs(), outDir: path.resolve(out) });
    console.log(`Built ${result.cases} cases at ${result.corpusPath}`);
    return;
  }
  if (command === 'analyze') {
    const runFile = arg('run') ?? fail('--run <run.json> is required');
    const out = arg('out') ?? fail('--out <analysis.json> is required');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8')) as JudgeExperimentRun;
    const labels = arg('labels') ? JSON.parse(fs.readFileSync(arg('labels')!, 'utf8')) : {};
    const analysis = analyzeJudgeExperiment(run, labels);
    writeOnce(out, analysis);
    console.log(`${analysis.decision}: ${out}`);
    return;
  }
  if (command !== 'run') fail('Usage: run_judge_experiment.ts build-synthetic-corpus|run|analyze (see the header)');

  const provider = (arg('provider') ?? fail('--provider synthetic|quote_only|openai is required')) as JudgeExperimentProvider;
  if (!['synthetic', 'quote_only', 'openai'].includes(provider)) fail(`Unknown provider ${provider}`);
  const corpusDir = arg('corpus') ?? fail('--corpus <directory> is required');
  const out = path.resolve(arg('out') ?? fail('--out <new-directory> is required'));
  if (fs.existsSync(out)) fail(`Refusing to overwrite ${out}`);
  const model = arg('model') ?? defaultJudgeExperimentModel();
  const maxUsd = provider === 'quote_only' ? 0 : Number(arg('max-usd') ?? fail('--max-usd <cap> is required for a dispatching run'));
  if (provider !== 'quote_only' && !(Number.isFinite(maxUsd) && maxUsd > 0 && maxUsd <= 100)) fail('--max-usd must be above 0 and at most 100');

  if (provider === 'openai') {
    if (arg('confirm-plan') !== JUDGE_EXPERIMENT_PLAN_SHA256) {
      fail(`A paid run must confirm the frozen plan: --confirm-plan ${JUDGE_EXPERIMENT_PLAN_SHA256}`);
    }
    if (!process.env.OPENAI_API_KEY) fail('OPENAI_API_KEY is required for a paid run');
  } else {
    // Nothing leaves this machine; operator alerts cannot fire for pretend spend.
    delete process.env.HAWA_OPERATOR_ALERTS;
    if (provider === 'synthetic' && !process.env.HAWA_SPEND_STATE_DIR) {
      fail('A synthetic run needs HAWA_SPEND_STATE_DIR, so its pretend spend stays out of the office ledger.');
    }
  }

  const corpus = loadJudgeExperimentCorpus(corpusDir);
  const client = createJudgeExperimentClient({ provider, model, apiKey: process.env.OPENAI_API_KEY });
  const run = await runJudgeExperiment({ corpus, client, provider, model, budget: { maxUsd, officeLedger: provider !== 'quote_only' } });
  fs.mkdirSync(out, { recursive: false, mode: 0o700 });
  writeOnce(path.join(out, 'run.json'), run);
  const analysis = analyzeJudgeExperiment(run);
  writeOnce(path.join(out, 'analysis.json'), analysis);
  console.log(JSON.stringify({ decision: analysis.decision, stoppedReason: run.stoppedReason, calls: run.calls.length,
    spentUsd: run.budget.spentUsd, quotedUsd: run.budget.quotedUsd, counts: analysis.counts, out }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
