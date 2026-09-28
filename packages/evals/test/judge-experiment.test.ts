import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { OpenAiStudioClient, BRIEF_BOUND_JUDGE_PROMPT_VERSION, getDailyOfficeSpend, type BriefBoundVerdict } from '@hawa/creative';
import { loadGoldenBriefs } from '../src/design-studio/loader.js';
import {
  JUDGE_EXPERIMENT_PLAN,
  JUDGE_EXPERIMENT_PLAN_SHA256,
  analyzeJudgeExperiment,
  buildSyntheticJudgeCorpus,
  createSyntheticJudgeFetch,
  loadJudgeExperimentCorpus,
  runJudgeExperiment,
  type JudgeExperimentCaseRecord,
  type JudgeExperimentRun,
} from '../src/judge-experiment.js';

/**
 * ADR-124: the incumbent and the brief-bound challenger are compared on one retained corpus, with
 * predeclared metrics, effect sizes and regression margins. The synthetic provider proves the whole
 * path runs; it cannot produce a quality result. Paid runs use the same path under the existing
 * pre-dispatch reservation policy and office daily ledger.
 */

const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `hawa-judge-${label}-`));

let spendDir: string;
let previousSpendDir: string | undefined;
beforeEach(() => {
  previousSpendDir = process.env.HAWA_SPEND_STATE_DIR;
  spendDir = tmp('spend');
  process.env.HAWA_SPEND_STATE_DIR = spendDir;
});
afterEach(() => {
  if (previousSpendDir === undefined) delete process.env.HAWA_SPEND_STATE_DIR;
  else process.env.HAWA_SPEND_STATE_DIR = previousSpendDir;
});

let corpusDir: string | undefined;
function syntheticCorpus(): string {
  if (corpusDir) return corpusDir;
  const briefs = loadGoldenBriefs().filter((b) => ['golden-01', 'golden-06'].includes(b.id));
  expect(briefs).toHaveLength(2);
  corpusDir = path.join(tmp('corpus'), 'corpus');
  buildSyntheticJudgeCorpus({ briefs, outDir: corpusDir });
  return corpusDir;
}

const clientFor = (fetcher: typeof fetch) => new OpenAiStudioClient({ apiKey: 'test-key', fetcher, timeoutMs: 5000 });

describe('ADR-124 judge experiment — predeclared plan', () => {
  it('freezes endpoints, effect sizes and regression margins before any result exists', () => {
    expect(JUDGE_EXPERIMENT_PLAN.version).toBe('judge-challenger-experiment-v1');
    expect(JUDGE_EXPERIMENT_PLAN.challenger.id).toBe(BRIEF_BOUND_JUDGE_PROMPT_VERSION);
    expect(JUDGE_EXPERIMENT_PLAN.primary).toMatchObject({ endpoint: 'seeded_defect_detection', worthwhileEffect: 0.10 });
    expect(JUDGE_EXPERIMENT_PLAN.margins).toMatchObject({
      human_agreement: { margin: -0.05 }, order_consistency: { margin: -0.05 },
      clean_control_false_critical: { ceiling: 0.05 }, cost_per_case_ratio: { ceiling: 2 },
    });
    expect(JUDGE_EXPERIMENT_PLAN.bootstrap).toMatchObject({ iterations: 10_000, unit: 'lineage' });
    expect(JUDGE_EXPERIMENT_PLAN_SHA256).toBe(sha(JSON.stringify(JUDGE_EXPERIMENT_PLAN)));
    expect(Object.isFrozen(JUDGE_EXPERIMENT_PLAN)).toBe(true);
  });
});

describe('ADR-124 judge experiment — retained corpus', { timeout: 60000 }, () => {
  it('builds a pinned development corpus from the golden briefs with seeded and clean pairs', () => {
    const corpus = loadJudgeExperimentCorpus(syntheticCorpus());
    expect(corpus.manifest.split).toBe('development');
    expect(corpus.manifest.source).toBe('synthetic_golden_briefs');
    expect(corpus.manifest.cases).toHaveLength(6);
    const kinds = corpus.manifest.cases.map((c) => c.truth.kind === 'seeded_defect' ? `${c.truth.defectClass}` : c.truth.kind).sort();
    expect(kinds).toEqual(['clean_control', 'clean_control', 'copy', 'copy', 'layout', 'layout']);
    // Correlated siblings share their brief's lineage and are clustered, never counted as independent.
    expect(new Set(corpus.manifest.cases.map((c) => c.lineageId))).toEqual(new Set(['golden-01', 'golden-06']));
    const copyCase = corpus.manifest.cases.find((c) => c.truth.kind === 'seeded_defect' && c.truth.defectClass === 'copy')!;
    const bad = copyCase.truth.kind === 'seeded_defect' ? copyCase.truth.badCandidate : 'A';
    expect(copyCase.candidates[bad].renderedCopy).not.toEqual(copyCase.candidates[bad === 'A' ? 'B' : 'A'].renderedCopy);
    expect(copyCase.brief.copy.map((c) => c.text)).toEqual(Object.values(copyCase.candidates[bad === 'A' ? 'B' : 'A'].renderedCopy!));
    for (const c of corpus.manifest.cases) {
      expect(corpus.images.get(`${c.caseId}:A`)!.equals(corpus.images.get(`${c.caseId}:B`)!)).toBe(false);
      expect(sha(corpus.images.get(`${c.caseId}:A`)!)).toBe(c.candidates.A.sha256);
    }
    expect(corpus.manifestSha256).toBe(sha(fs.readFileSync(path.join(syntheticCorpus(), 'corpus.json'))));
  });

  it('refuses changed image bytes, escaping paths and repeated cases', () => {
    const source = syntheticCorpus();
    const copy = (label: string) => {
      const dir = path.join(tmp(label), 'corpus');
      fs.cpSync(source, dir, { recursive: true });
      return dir;
    };
    const tampered = copy('tampered');
    const manifest = JSON.parse(fs.readFileSync(path.join(tampered, 'corpus.json'), 'utf8'));
    const file = path.join(tampered, manifest.cases[0].candidates.A.file);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 20] ^= 1;
    fs.writeFileSync(file, bytes);
    expect(() => loadJudgeExperimentCorpus(tampered)).toThrow();

    const escaping = copy('escape');
    const m2 = JSON.parse(fs.readFileSync(path.join(escaping, 'corpus.json'), 'utf8'));
    m2.cases[0].candidates.A.file = '../outside.png';
    fs.writeFileSync(path.join(escaping, 'corpus.json'), JSON.stringify(m2));
    expect(() => loadJudgeExperimentCorpus(escaping)).toThrow(/inside the corpus/);

    const repeated = copy('repeated');
    const m3 = JSON.parse(fs.readFileSync(path.join(repeated, 'corpus.json'), 'utf8'));
    m3.cases[1].caseId = m3.cases[0].caseId;
    fs.writeFileSync(path.join(repeated, 'corpus.json'), JSON.stringify(m3));
    expect(() => loadJudgeExperimentCorpus(repeated)).toThrow(/repeated/);
  });
});

describe('ADR-124 judge experiment — end to end with the synthetic provider', { timeout: 120000 }, () => {
  it('runs both judges in both orders on every case, under reservation and the office ledger', async () => {
    const corpus = loadJudgeExperimentCorpus(syntheticCorpus());
    const bodies: string[] = [];
    const synthetic = createSyntheticJudgeFetch();
    const fetcher = (async (url: string, init: RequestInit) => { bodies.push(String(init.body)); return synthetic(url, init); }) as typeof fetch;
    const run = await runJudgeExperiment({ corpus, client: clientFor(fetcher), provider: 'synthetic', model: 'gpt-6-astra',
      budget: { maxUsd: 5, officeLedger: true } });
    expect(run.stoppedReason).toBeNull();
    expect(run.calls).toHaveLength(24);
    expect(bodies).toHaveLength(24);
    expect(run.calls.every((c) => c.status === 'complete' && c.quoteUsd! >= c.costUsd!)).toBe(true);
    expect(run.cases.every((c) => c.incumbent.orders.length === 2 && c.challenger.orders.length === 2)).toBe(true);
    // Each record binds the exact corpus bytes, so the R06 calibration analyzer can read the same run.
    expect(run.cases.map((c) => [c.imageASha256, c.imageBSha256]))
      .toEqual(corpus.manifest.cases.map((c) => [c.candidates.A.sha256, c.candidates.B.sha256]));
    const incumbentBodies = bodies.filter((b) => b.includes('PairwiseDimensionVerdict'));
    const challengerBodies = bodies.filter((b) => b.includes('BriefBoundDimensionVerdict'));
    expect(incumbentBodies).toHaveLength(12);
    expect(challengerBodies).toHaveLength(12);
    // The incumbent is run exactly as production runs it; the challenger never sees a metric.
    expect(incumbentBodies.every((b) => b.includes('GROUND TRUTH DETERMINISTIC METRICS'))).toBe(true);
    expect(challengerBodies.some((b) => /Composite Score|GROUND TRUTH|prestige/.test(b))).toBe(false);
    const sorani = corpus.manifest.cases.find((c) => c.language !== 'en')!;
    expect(challengerBodies.some((b) => b.includes(JSON.stringify(sorani.brief.copy[0].text).slice(1, -1)))).toBe(true);
    expect(getDailyOfficeSpend()).toBeCloseTo(run.budget.spentUsd, 6);

    const analysis = analyzeJudgeExperiment(run);
    expect(analysis.decision).toBe('SYNTHETIC_PLUMBING_ONLY');
    expect(analysis.admissionQualified).toBe(false);
    expect(analysis.counts).toMatchObject({ cases: 6, lineages: 2, seededDefectCases: 4, cleanControlCases: 2 });
    expect(analysis.primary.difference).toHaveProperty('lower95');
  });

  it('quotes every exact request without dispatching any in quote-only mode', async () => {
    const corpus = loadJudgeExperimentCorpus(syntheticCorpus());
    let fetched = 0;
    const fetcher = (async () => { fetched++; throw new Error('must not dispatch'); }) as unknown as typeof fetch;
    const run = await runJudgeExperiment({ corpus, client: clientFor(fetcher), provider: 'quote_only', model: 'gpt-6-astra',
      budget: { maxUsd: 0, officeLedger: false } });
    expect(fetched).toBe(0);
    expect(run.calls).toHaveLength(24);
    expect(run.calls.every((c) => c.status === 'quoted' && c.quoteUsd! > 0 && c.costUsd === null)).toBe(true);
    expect(run.budget.quotedUsd).toBeCloseTo(run.calls.reduce((s, c) => s + c.quoteUsd!, 0), 6);
    const challengerQuote = run.calls.filter((c) => c.judge === 'challenger').reduce((s, c) => s + c.quoteUsd!, 0);
    const incumbentQuote = run.calls.filter((c) => c.judge === 'incumbent').reduce((s, c) => s + c.quoteUsd!, 0);
    expect(challengerQuote).toBeGreaterThan(0);
    expect(incumbentQuote).toBeGreaterThan(0);
    expect(analyzeJudgeExperiment(run).decision).toBe('QUOTE_ONLY');
  });

  it('stops before dispatch when the run cap or the office daily cap cannot cover the next reservation', async () => {
    const corpus = loadJudgeExperimentCorpus(syntheticCorpus());
    let fetched = 0;
    const synthetic = createSyntheticJudgeFetch();
    const fetcher = (async (url: string, init: RequestInit) => { fetched++; return synthetic(url, init); }) as typeof fetch;
    const capped = await runJudgeExperiment({ corpus, client: clientFor(fetcher), provider: 'synthetic', model: 'gpt-6-astra',
      budget: { maxUsd: 0.001, officeLedger: true } });
    expect(fetched).toBe(0);
    expect(capped.stoppedReason).toBe('budget_exhausted');
    expect(capped.calls).toEqual([expect.objectContaining({ status: 'refused_before_dispatch', costUsd: null })]);
    expect(capped.cases.filter((c) => c.incumbent.status === 'not_run')).toHaveLength(6);
    expect(analyzeJudgeExperiment({ ...capped, provider: 'openai' }).decision).toBe('INCOMPLETE');

    const previous = process.env.HAWA_DAILY_CAP_USD;
    process.env.HAWA_DAILY_CAP_USD = '0.01';
    try {
      const office = await runJudgeExperiment({ corpus, client: clientFor(fetcher), provider: 'synthetic', model: 'gpt-6-astra',
        budget: { maxUsd: 5, officeLedger: true } });
      expect(fetched).toBe(0);
      expect(office.stoppedReason).toBe('office_daily_cap');
    } finally {
      if (previous === undefined) delete process.env.HAWA_DAILY_CAP_USD;
      else process.env.HAWA_DAILY_CAP_USD = previous;
    }
  });

  it('counts an unusable reply as a billed failure of that judge and continues the run', async () => {
    const corpus = loadJudgeExperimentCorpus(syntheticCorpus());
    let fetched = 0;
    const synthetic = createSyntheticJudgeFetch();
    const fetcher = (async (url: string, init: RequestInit) => {
      fetched++;
      const body = String(init.body);
      const reply = (content: string) => ({ ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ id: `bad-${fetched}`, model: 'gpt-6-astra', choices: [{ message: { content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3000, completion_tokens: 100, total_tokens: 3100 } }) }) as unknown as Response;
      // Case 1: the challenger answers something that is not JSON, then a verdict with an overall winner.
      if (fetched === 3) return reply('I prefer the first poster.');
      if (fetched === 4) return reply(JSON.stringify({ winner: 'A', findings: [] }));
      return synthetic(url, init);
    }) as typeof fetch;
    const run = await runJudgeExperiment({ corpus, client: clientFor(fetcher), provider: 'synthetic', model: 'gpt-6-astra',
      budget: { maxUsd: 5, officeLedger: true } });
    expect(run.stoppedReason).toBeNull();
    expect(fetched).toBe(24);
    expect(run.cases[0].challenger.status).toBe('invalid_reply');
    expect(run.cases[0].incumbent.status).toBe('complete');
    expect(run.calls[2]).toMatchObject({ status: 'failed', errorCode: 'MODEL_OUTPUT_UNPARSEABLE' });
    expect(run.calls[2].costUsd).toBeGreaterThan(0);
    expect(run.calls[3]).toMatchObject({ status: 'complete', errorCode: 'BRIEF_BOUND_JUDGE_INVALID_REPLY' });
    expect(run.cases.slice(1).every((c) => c.challenger.status === 'complete')).toBe(true);
    // Measured as a failure, never dropped from the denominator.
    expect(analyzeJudgeExperiment({ ...run, provider: 'openai' }).counts).toMatchObject({ invalidReplies: 1, notRunOrIncomplete: 0 });
  });

  it('stops at the first provider refusal and keeps every later case in the denominator', async () => {
    const corpus = loadJudgeExperimentCorpus(syntheticCorpus());
    let fetched = 0;
    const synthetic = createSyntheticJudgeFetch();
    const fetcher = (async (url: string, init: RequestInit) => {
      fetched++;
      if (fetched === 3) {
        return { ok: false, status: 429, headers: { get: () => null },
          text: async () => JSON.stringify({ error: { code: 'insufficient_quota', message: 'You have no credits remaining' } }) } as unknown as Response;
      }
      return synthetic(url, init);
    }) as typeof fetch;
    const run = await runJudgeExperiment({ corpus, client: clientFor(fetcher), provider: 'synthetic', model: 'gpt-6-astra',
      budget: { maxUsd: 5, officeLedger: true } });
    expect(fetched).toBe(3);
    expect(run.stoppedReason).toBe('provider_error');
    expect(run.calls.at(-1)).toMatchObject({ status: 'failed', errorCode: 'INSUFFICIENT_QUOTA', costUsd: 0 });
    expect(run.cases[0].challenger.status).toBe('incomplete');
    expect(run.cases.slice(1).every((c) => c.incumbent.status === 'not_run' && c.challenger.status === 'not_run')).toBe(true);
    expect(analyzeJudgeExperiment({ ...run, provider: 'openai' }).decision).toBe('INCOMPLETE');
  });
});

describe('ADR-124 judge experiment — analysis and decision rule', () => {
  const dims = (c: string, m: string, a: string): BriefBoundVerdict['dimensions'] => ({
    correctness: { choice: c as any, reason: 'r' }, communication: { choice: m as any, reason: 'r' }, aesthetic: { choice: a as any, reason: 'r' },
  });
  /** A synthetic record of a paid run, built from raw per-order answers the analysis re-derives. */
  function record(options: { lineages: number; challengerDetects: number; incumbentDetects: number; clean: number;
    humanAgree?: boolean; challengerCost?: number; incumbentCost?: number;
    cleanChallenger?: 'tie' | 'critical' | 'invalid_reply' }): JudgeExperimentRun {
    const cases: JudgeExperimentCaseRecord[] = [];
    const calls: JudgeExperimentRun['calls'] = [];
    const add = (caseId: string, lineageId: string, truth: JudgeExperimentCaseRecord['truth'], incumbentPicks: 'A' | 'B' | 'flip',
      challenger: BriefBoundVerdict['dimensions'][], humanVote?: 'A' | 'B' | 'tie') => {
      const ab = incumbentPicks === 'flip' ? 'A' : incumbentPicks;
      const ba = incumbentPicks === 'flip' ? 'A' : incumbentPicks === 'A' ? 'B' : 'A';
      const cleanMode = truth.kind === 'clean_control' ? options.cleanChallenger ?? 'tie' : 'tie';
      const findings = cleanMode === 'critical'
        ? [{ candidate: 'A' as const, dimension: 'correctness' as const, severity: 'critical' as const,
          region: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, copyIndex: null, explanation: 'Claimed missing fact.' }]
        : [];
      cases.push({ caseId, lineageId, language: 'ckb', format: '1080x1350', truth,
        imageASha256: sha(`${caseId}:A`), imageBSha256: sha(`${caseId}:B`),
        humanVotes: humanVote ? ['h1', 'h2', 'h3'].map((judgeId) => ({ judgeId, vote: humanVote })) : [],
        incumbent: { status: 'complete', orders: [{ order: 'AB', winner: ab }, { order: 'BA', winner: ba }] },
        challenger: cleanMode === 'invalid_reply' ? { status: 'invalid_reply', orders: [] } : { status: 'complete', orders: [
          { order: 'AB', verdict: { dimensions: challenger[0], findings }, packetSha256: sha(`${caseId}:AB`) },
          { order: 'BA', verdict: { dimensions: challenger[1], findings }, packetSha256: sha(`${caseId}:BA`) }] } });
      for (const judge of ['incumbent', 'challenger'] as const) for (const order of ['AB', 'BA'] as const) {
        const cost = judge === 'incumbent' ? options.incumbentCost ?? 0.04 : options.challengerCost ?? 0.05;
        calls.push({ caseId, judge, order, status: 'complete', quoteUsd: cost * 2, costUsd: cost, latencyMs: 1000, responseId: `${caseId}-${judge}-${order}`, model: 'gpt-6-astra' });
      }
    };
    for (let i = 0; i < options.lineages; i++) {
      // Candidate B is always the defective one here; the good choice is A.
      const truth = { kind: 'seeded_defect' as const, badCandidate: 'B' as const, severity: 'major' as const, defectClass: 'layout' as const };
      const challengerGood = i < options.challengerDetects;
      const incumbentGood = i < options.incumbentDetects;
      add(`seeded-${i}`, `lineage-${i}`, truth, incumbentGood ? 'A' : 'flip',
        challengerGood ? [dims('A', 'A', 'tie'), dims('B', 'B', 'tie')] : [dims('abstain', 'A', 'A'), dims('abstain', 'B', 'B')],
        options.humanAgree === undefined ? undefined : 'A');
    }
    for (let i = 0; i < options.clean; i++) {
      add(`clean-${i}`, `clean-lineage-${i}`, { kind: 'clean_control' }, 'A', [dims('tie', 'tie', 'tie'), dims('tie', 'tie', 'tie')]);
    }
    return { schemaVersion: 1, planVersion: JUDGE_EXPERIMENT_PLAN.version, planSha256: JUDGE_EXPERIMENT_PLAN_SHA256,
      corpus: { corpusId: 'fixture', manifestSha256: 'c'.repeat(64), split: 'calibration', source: 'retained_exports' },
      provider: 'openai', model: 'gpt-6-astra', startedAt: '2026-09-28T00:00:00.000Z', finishedAt: '2026-09-28T00:10:00.000Z',
      cases, calls, budget: { maxUsd: 20, spentUsd: calls.reduce((s, c) => s + (c.costUsd ?? 0), 0), quotedUsd: 0, officeLedger: true },
      stoppedReason: null };
  }

  it('reports a paired lineage-clustered effect size with its interval and discordant pairs', () => {
    const run = record({ lineages: 24, challengerDetects: 22, incumbentDetects: 12, clean: 12, humanAgree: true });
    const analysis = analyzeJudgeExperiment(run);
    expect(analysis.primary.incumbent.rate).toBeCloseTo(12 / 24, 6);
    expect(analysis.primary.challenger.rate).toBeCloseTo(22 / 24, 6);
    expect(analysis.primary.difference.point).toBeCloseTo(10 / 24, 6);
    expect(analysis.primary.difference.lower95).toBeGreaterThan(0);
    expect(analysis.primary.discordant).toEqual({ challengerOnly: 10, incumbentOnly: 0 });
    expect(analysis.decision).toBe('CHALLENGER_ELIGIBLE_FOR_SHADOW');
    expect(analysis.admissionQualified).toBe(false);
    // Seeded, reproducible: the same record gives the same interval.
    expect(analyzeJudgeExperiment(run).primary.difference).toEqual(analysis.primary.difference);
  });

  it('holds a superior challenger for human labels, and refuses regressions and small samples', () => {
    expect(analyzeJudgeExperiment(record({ lineages: 24, challengerDetects: 22, incumbentDetects: 12, clean: 12 })).decision)
      .toBe('PENDING_HUMAN_LABELS');
    expect(analyzeJudgeExperiment(record({ lineages: 24, challengerDetects: 22, incumbentDetects: 12, clean: 12, humanAgree: true,
      challengerCost: 0.2, incumbentCost: 0.04 })).decision).toBe('CHALLENGER_REGRESSES');
    expect(analyzeJudgeExperiment(record({ lineages: 24, challengerDetects: 13, incumbentDetects: 12, clean: 12, humanAgree: true })).decision)
      .toBe('NO_WORTHWHILE_DIFFERENCE');
    expect(analyzeJudgeExperiment(record({ lineages: 8, challengerDetects: 8, incumbentDetects: 0, clean: 12, humanAgree: true })).decision)
      .toBe('INSUFFICIENT_SAMPLE');
  });

  it('counts abstentions and flips as failures and refuses a run bound to another plan', () => {
    const run = record({ lineages: 24, challengerDetects: 0, incumbentDetects: 0, clean: 12 });
    const analysis = analyzeJudgeExperiment(run);
    expect(analysis.primary.challenger.rate).toBe(0);
    expect(analysis.primary.incumbent.rate).toBe(0);
    expect(analysis.reported.challengerAbstentionRate).toBeCloseTo(24 / 36, 6);
    expect(() => analyzeJudgeExperiment({ ...run, planSha256: 'd'.repeat(64) })).toThrow(/plan/);
    const labels = { 'seeded-0': { humanVotes: [{ judgeId: 'h1', vote: 'A' as const }, { judgeId: 'h1', vote: 'B' as const }] } };
    expect(() => analyzeJudgeExperiment(run, labels)).toThrow(/distinct/);
    expect(() => analyzeJudgeExperiment(run, { unknown: { humanVotes: [] } })).toThrow(/unknown case/);
  });
  it('counts a clean control the challenger did not answer validly as a failure of the false-critical margin', () => {
    // Replies full of findings are the ones most likely to fail validation; an invalid reply must
    // never pass the margin that exists to catch over-flagging.
    const flagged = analyzeJudgeExperiment(record({ lineages: 20, challengerDetects: 20, incumbentDetects: 0, clean: 10,
      cleanChallenger: 'critical' }));
    expect(flagged.margins.clean_control_false_critical).toBe(false);
    expect(flagged.decision).toBe('CHALLENGER_REGRESSES');
    const invalid = analyzeJudgeExperiment(record({ lineages: 20, challengerDetects: 20, incumbentDetects: 0, clean: 10,
      cleanChallenger: 'invalid_reply' }));
    expect(invalid.counts.invalidReplies).toBe(10);
    expect(invalid.margins.cleanControlFalseCriticalRate).toBe(1);
    expect(invalid.margins.clean_control_false_critical).toBe(false);
    expect(invalid.decision).not.toBe('PENDING_HUMAN_LABELS');
    expect(invalid.decision).toBe('CHALLENGER_REGRESSES');
    expect(invalid.margins.cleanControl).toEqual({ cases: 10, critical: 0, notValidlyAnswered: 10 });
  });

  it('never credits an incumbent order flip with agreement when the human consensus is a tie', () => {
    // Every seeded case: the incumbent flips, the challenger ties in both orders, the humans say tie.
    const run = record({ lineages: 24, challengerDetects: 0, incumbentDetects: 0, clean: 12 });
    for (const c of run.cases.filter((x) => x.truth.kind === 'seeded_defect')) {
      c.challenger.orders = c.challenger.orders.map((o) => ({ ...o, verdict: { dimensions: dims('tie', 'tie', 'tie'), findings: [] } }));
    }
    const labels = Object.fromEntries(run.cases.filter((c) => c.truth.kind === 'seeded_defect')
      .map((c) => [c.caseId, { humanVotes: ['h1', 'h2', 'h3'].map((judgeId) => ({ judgeId, vote: 'tie' as const })) }]));
    const analysis = analyzeJudgeExperiment(run, labels);
    expect(analysis.secondary.humanAgreement.cases).toBe(24);
    expect(analysis.secondary.humanAgreement.incumbent.rate).toBe(0);
    expect(analysis.secondary.humanAgreement.challenger.rate).toBe(1);
  });

  it('reports the challenger through the R06 calibration analyzer, per dimension, from the same run and labels', () => {
    const run = record({ lineages: 24, challengerDetects: 22, incumbentDetects: 12, clean: 12 });
    const seeded = run.cases.filter((c) => c.truth.kind === 'seeded_defect');
    const labels = Object.fromEntries(seeded.map((c) => [c.caseId, {
      humanVotes: ['h1', 'h2', 'h3'].map((judgeId) => ({ judgeId, vote: 'A' as const })),
      humanDimensionVotes: ['h1', 'h2', 'h3'].flatMap((judgeId) => [
        { judgeId, dimension: 'correctness' as const, vote: 'A' as const },
        { judgeId, dimension: 'aesthetic' as const, vote: 'B' as const }]),
    }]));
    const analysis = analyzeJudgeExperiment(run, labels);
    const calibration = analysis.reported.challengerCalibration;
    expect(calibration.status).toBe('offline_diagnostic_only');
    expect(calibration.caseCount).toBe(36);
    expect(calibration.protocols).toEqual({ [BRIEF_BOUND_JUDGE_PROMPT_VERSION]: 36 });
    // Correctness: the 22 detecting cases pick A in both orders; the 2 others abstain (uncertain).
    expect(calibration.dimensions.correctness).toMatchObject({ humanQualified: 24, comparable: 22, agreement: 22, judgeUncertain: 2 });
    // Aesthetic: the detecting cases tie; humans said B, so none agree. Labels are never pooled across dimensions.
    expect(calibration.dimensions.aesthetic).toMatchObject({ humanQualified: 24, agreement: 0 });
    expect(calibration.dimensions.communication).toMatchObject({ humanQualified: 0 });
    // Diagnostic only: the frozen plan's decision is unchanged by dimension labels.
    expect(analysis.decision).toBe(analyzeJudgeExperiment(run, Object.fromEntries(Object.entries(labels)
      .map(([k, v]) => [k, { humanVotes: v.humanVotes }]))).decision);
    expect(() => analyzeJudgeExperiment(run, { 'seeded-0': { humanVotes: [], humanDimensionVotes: [
      { judgeId: 'h1', dimension: 'correctness', vote: 'A' }, { judgeId: 'h1', dimension: 'correctness', vote: 'B' }] } }))
      .toThrow(/dimension/);
  });
});
