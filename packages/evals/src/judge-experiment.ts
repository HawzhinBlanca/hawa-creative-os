/**
 * ADR-124 — incumbent versus brief-bound challenger judge experiment.
 *
 * One predeclared plan (endpoints, effect size, regression margins, sample minimum, decision rule)
 * is frozen and hashed before any result exists. The harness runs both judges on the same pinned
 * image pairs, in both presentation orders, with the same model, through the existing transport:
 * the incumbent exactly as production calls it (evaluatePairOrder, metrics shown), the challenger
 * through evaluateBriefBoundPairOrder. Every request is quoted with the existing ADR-091 Studio
 * reservation policy before dispatch and admitted against a run cap and, for paid runs, the office
 * daily ledger that paid qualification scripts already use. The first provider refusal stops the
 * run; cases not run stay in every denominator.
 *
 * The synthetic provider proves the path end to end. It cannot produce a quality result, and the
 * analysis says so. No outcome admits the challenger to production.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BRIEF_BOUND_JUDGE_PROMPT_VERSION,
  OpenAiModelParseError,
  OpenAiModelRefusalError,
  OpenAiModelTruncatedError,
  OpenAiStudioClient,
  briefBoundOrderChoice,
  buildBriefBoundJudgeText,
  checkOfficeDailyBudget,
  createDegradedCanaryLayout,
  decideBriefBoundPair,
  evaluateBriefBoundPairOrder,
  evaluateHardQa,
  evaluatePairOrder,
  getKaaeOfficialLogoDataUri,
  inspectPngExport,
  measureDesignV3,
  measureTextGeometry,
  recordOfficeDailySpend,
  renderLayoutV2,
  reserveStudioText,
  stripPngStudyMetadata,
  validateBriefBoundVerdict,
  type BriefBoundJudgeBrief,
  type BriefBoundVerdict,
  type CostLedgerEntry,
  type OpenAiStructuredResponse,
  type StudioLayoutV2,
} from '@hawa/creative';
import { resolveModel } from '@hawa/domain';
import { OfflineRunner } from './design-studio/offline-runner.js';
import type { Concept, StudioGoldenBrief } from './design-studio/types.js';
import { rng } from './research-study/analyze.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * Frozen before any comparison was run. Changing any field changes the hash, and a run bound to one
 * plan cannot be analyzed under another.
 */
export const JUDGE_EXPERIMENT_PLAN = Object.freeze({
  version: 'judge-challenger-experiment-v1',
  incumbent: Object.freeze({
    id: 'pairwise-judge-v3',
    description: 'Five forced A/B dimension votes, deterministic metric scores shown as ground truth, majority winner.',
  }),
  challenger: Object.freeze({
    id: BRIEF_BOUND_JUDGE_PROMPT_VERSION,
    description: 'Actual brief and exact copy; correctness, communication and aesthetic preference judged separately with tie ' +
      'and abstention; no score shown; overall outcome derived by the versioned rule correctness > communication > aesthetic.',
  }),
  pairing: 'Same case, same exact image bytes, same model and reasoning effort, both presentation orders, for both judges.',
  successCounting: 'A seeded case succeeds only when the order-stable choice names the non-defective candidate. Ties, ' +
    'abstentions, position flips, invalid replies, failed and missing calls count as failures and stay in the denominator.',
  bootstrap: Object.freeze({ iterations: 10_000, unit: 'lineage', interval: 0.95, seed: 'judge-challenger-experiment-v1' }),
  primary: Object.freeze({
    endpoint: 'seeded_defect_detection',
    estimand: 'Challenger minus incumbent detection rate, paired within case, averaged within lineage, lineages weighted equally.',
    worthwhileEffect: 0.10,
    rule: 'Superior when the point difference is at least 0.10 and the lower 95% bound is above 0.',
  }),
  margins: Object.freeze({
    human_agreement: Object.freeze({ kind: 'non_inferiority_difference', margin: -0.05,
      rule: 'Required once human consensus labels exist: lower 95% bound of challenger minus incumbent agreement above -0.05. ' +
        'Abstention counts as disagreement.' }),
    order_consistency: Object.freeze({ kind: 'non_inferiority_difference', margin: -0.05,
      rule: 'Lower 95% bound of challenger minus incumbent same-answer-in-both-orders rate above -0.05.' }),
    clean_control_false_critical: Object.freeze({ kind: 'absolute_ceiling', ceiling: 0.05,
      rule: 'Challenger rate of clean controls with any critical finding at most 0.05 (the incumbent has no findings).' }),
    cost_per_case_ratio: Object.freeze({ kind: 'ratio_ceiling', ceiling: 2,
      rule: 'Challenger mean known USD per case at most twice the incumbent, with no unknown-cost call on either side.' }),
  }),
  reported: Object.freeze(['copy_defect_detection', 'layout_defect_detection', 'challenger_abstention_rate',
    'challenger_tie_rate', 'latency_p50_p95_ms', 'by_language', 'by_format']),
  minimumSample: Object.freeze({ seededDefectLineages: 20, cleanControlLineages: 10 }),
  decisionRule: 'In order: a quote-only run is QUOTE_ONLY; a synthetic run is SYNTHETIC_PLUMBING_ONLY; a stopped run or any ' +
    'case not run to completion is INCOMPLETE; fewer lineages than the minimum is INSUFFICIENT_SAMPLE; a failed order, ' +
    'clean-control or cost margin is CHALLENGER_REGRESSES; no primary superiority is NO_WORTHWHILE_DIFFERENCE; no human ' +
    'consensus labels is PENDING_HUMAN_LABELS; a failed human-agreement margin is CHALLENGER_REGRESSES; otherwise ' +
    'CHALLENGER_ELIGIBLE_FOR_SHADOW.',
  admission: 'No outcome admits the challenger to production. The best outcome is eligibility for a shadow run ' +
    '(docs/07 section 8) with human-approved canary tasks.',
});
export const JUDGE_EXPERIMENT_PLAN_SHA256 = sha256(JSON.stringify(JUDGE_EXPERIMENT_PLAN));

// ---------------------------------------------------------------------------------------------
// Corpus

export type JudgeExperimentTruth =
  | { kind: 'seeded_defect'; badCandidate: 'A' | 'B'; severity: 'minor' | 'major' | 'critical'; defectClass: 'layout' | 'copy' }
  | { kind: 'clean_control' }
  | { kind: 'ordinary' };

export interface JudgeExperimentHumanVote { judgeId: string; vote: 'A' | 'B' | 'tie' | 'cannot_judge' }

export interface JudgeExperimentCandidate {
  /** Relative to the corpus directory. */
  file: string;
  sha256: string;
  /** The layout the image was rendered from; the incumbent is measured from it, as in production. */
  layout: StudioLayoutV2;
  /** The copy actually drawn, by copyIndex, when it differs from the brief's exact copy. */
  renderedCopy?: Record<number, string>;
  /** Deterministic hard QA of this candidate when the corpus was built; clean sides are empty. */
  hardQaDefects?: string[];
}

export interface JudgeExperimentCase {
  caseId: string;
  lineageId: string;
  language: 'en' | 'ckb' | 'ar' | 'mixed';
  format: string;
  brief: BriefBoundJudgeBrief;
  candidates: { A: JudgeExperimentCandidate; B: JudgeExperimentCandidate };
  truth: JudgeExperimentTruth;
  humanVotes?: JudgeExperimentHumanVote[];
}

export interface JudgeExperimentCorpusManifest {
  schemaVersion: 1;
  corpusId: string;
  split: 'development' | 'calibration' | 'final_holdout';
  source: 'synthetic_golden_briefs' | 'retained_exports';
  note: string;
  cases: JudgeExperimentCase[];
}

export interface LoadedJudgeCorpus {
  dir: string;
  manifest: JudgeExperimentCorpusManifest;
  manifestSha256: string;
  /** Verified bytes by `${caseId}:A` and `${caseId}:B`. */
  images: Map<string, Buffer>;
}

const SHA = /^[a-f0-9]{64}$/;
const LANGUAGES = ['en', 'ckb', 'ar', 'mixed'];

function validateHumanVotes(votes: unknown, label: string): JudgeExperimentHumanVote[] {
  if (votes === undefined) return [];
  if (!Array.isArray(votes) || votes.some((v) => !v || typeof v.judgeId !== 'string' || !v.judgeId ||
      !['A', 'B', 'tie', 'cannot_judge'].includes(v.vote))) {
    throw new Error(`${label}: human votes need identified judges and valid choices`);
  }
  if (new Set(votes.map((v) => v.judgeId)).size !== votes.length) throw new Error(`${label}: human votes need distinct judges`);
  return votes as JudgeExperimentHumanVote[];
}

/** Reads and verifies a corpus: paths stay inside, bytes match hashes, PNGs decode, metadata is stripped. */
export function loadJudgeExperimentCorpus(dir: string): LoadedJudgeCorpus {
  const root = fs.realpathSync(dir);
  const raw = fs.readFileSync(path.join(root, 'corpus.json'));
  const manifest = JSON.parse(raw.toString('utf8')) as JudgeExperimentCorpusManifest;
  if (manifest?.schemaVersion !== 1 || typeof manifest.corpusId !== 'string' || !manifest.corpusId ||
      !['development', 'calibration', 'final_holdout'].includes(manifest.split) ||
      !['synthetic_golden_briefs', 'retained_exports'].includes(manifest.source) ||
      !Array.isArray(manifest.cases) || manifest.cases.length === 0 || manifest.cases.length > 1000) {
    throw new Error('Invalid judge experiment corpus manifest');
  }
  if (manifest.source === 'synthetic_golden_briefs' && manifest.split !== 'development') {
    throw new Error('Golden-brief material is development data and cannot form a calibration or holdout split');
  }
  const images = new Map<string, Buffer>();
  const ids = new Set<string>();
  for (const c of manifest.cases) {
    if (!c?.caseId || typeof c.caseId !== 'string' || ids.has(c.caseId)) throw new Error('Invalid or repeated corpus case');
    ids.add(c.caseId);
    if (!c.lineageId || typeof c.lineageId !== 'string' || !LANGUAGES.includes(c.language) || !c.format) {
      throw new Error(`${c.caseId}: lineage, language and format are required`);
    }
    buildBriefBoundJudgeText(c.brief);
    const t = c.truth;
    if (!t || !['seeded_defect', 'clean_control', 'ordinary'].includes(t.kind) || (t.kind === 'seeded_defect' &&
        (!['A', 'B'].includes(t.badCandidate) || !['minor', 'major', 'critical'].includes(t.severity) ||
          !['layout', 'copy'].includes(t.defectClass)))) {
      throw new Error(`${c.caseId}: invalid truth label`);
    }
    validateHumanVotes(c.humanVotes, c.caseId);
    const dims: Array<{ width: number; height: number }> = [];
    for (const side of ['A', 'B'] as const) {
      const candidate = c.candidates?.[side];
      if (!candidate || typeof candidate.file !== 'string' || !SHA.test(candidate.sha256) || candidate.layout?.version !== 2) {
        throw new Error(`${c.caseId}: candidate ${side} needs a file, SHA-256 and version-2 layout`);
      }
      const resolved = path.resolve(root, candidate.file);
      if (path.isAbsolute(candidate.file) || !resolved.startsWith(root + path.sep)) {
        throw new Error(`${c.caseId}: candidate ${side} must stay inside the corpus directory`);
      }
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(root + path.sep)) throw new Error(`${c.caseId}: candidate ${side} must stay inside the corpus directory`);
      const bytes = fs.readFileSync(real);
      if (sha256(bytes) !== candidate.sha256) throw new Error(`${c.caseId}: candidate ${side} bytes do not match their SHA-256`);
      dims.push(inspectPngExport(bytes));
      if (!stripPngStudyMetadata(bytes).equals(bytes)) throw new Error(`${c.caseId}: candidate ${side} carries metadata`);
      images.set(`${c.caseId}:${side}`, bytes);
    }
    if (c.candidates.A.sha256 === c.candidates.B.sha256) throw new Error(`${c.caseId}: identical candidate images`);
    if (dims[0].width !== dims[1].width || dims[0].height !== dims[1].height) throw new Error(`${c.caseId}: unequal dimensions`);
  }
  return { dir: root, manifest, manifestSha256: sha256(raw), images };
}

/**
 * The offline runner's boxes ignore wrapping, so a long title spills into the blocks below it. Each
 * block here gets the height its copy actually needs (the same measurement hard QA uses), stacked in
 * source order; the type steps down together until the stack fits above the bottom margin.
 */
function fitStack(layout: StudioLayoutV2, copy: Record<number, string>): StudioLayoutV2 {
  const bottom = layout.height - (layout.grid?.margin ?? Math.round(Math.min(layout.width, layout.height) * 0.08));
  const minimum = Math.ceil(0.016 * layout.width);
  for (let attempt = 0, scale = 1; attempt < 14; attempt++, scale *= 0.92) {
    const clone = JSON.parse(JSON.stringify(layout)) as StudioLayoutV2;
    clone.text = clone.text.map((t) => ({ ...t, fontSize: Math.max(minimum, Math.round(t.fontSize * scale)) }));
    const measured = measureTextGeometry(clone, copy);
    let cursor = layout.text[0]?.y ?? 0;
    clone.text = clone.text.map((t, i) => {
      const m = measured[i];
      if (m.status !== 'measured') throw new Error(`Synthetic corpus block ${t.copyIndex} is unmeasurable (${m.reason})`);
      const placed = { ...t, y: cursor, height: Math.ceil(m.requiredHeightPx) + 4 };
      cursor += placed.height + Math.max(10, Math.round(t.fontSize * 0.45));
      return placed;
    });
    clone.shapes = (clone.shapes ?? []).map((s) => (s.role === 'rule' ? { ...s, y: Math.min(cursor, bottom - s.height) } : s));
    if (cursor + 8 <= bottom) return clone;
  }
  throw new Error('The synthetic corpus copy cannot fit its canvas');
}

/** Deterministic hard QA of a corpus candidate, recorded with it; clean sides must pass. */
function corpusHardQa(layout: StudioLayoutV2, copy: Record<number, string>, scripts: Array<'latin' | 'arabic'>): string[] {
  const palette = [...new Set([layout.background?.color, ...layout.text.map((t) => t.color),
    ...(layout.shapes ?? []).map((s) => s.color)].filter((c): c is string => typeof c === 'string'))];
  return evaluateHardQa(layout, {
    width: layout.width, height: layout.height, copyScripts: scripts, latinFont: 'Verdana', arabicFont: 'Noto Sans Arabic',
    palette, logoAspect: layout.logo ? layout.logo.width / layout.logo.height : 1, copyText: copy,
  }).defectCodes;
}

/** The one clean alternative: the same design with every block centred. Nothing is defective. */
function centredVariant(layout: StudioLayoutV2): StudioLayoutV2 {
  const clone = JSON.parse(JSON.stringify(layout)) as StudioLayoutV2;
  clone.text = clone.text.map((t) => ({ ...t, align: 'center' }));
  return clone;
}

/** A wrong fact: the first digit in the copy moves by one; without digits, the title loses its last word. */
function alterOneFact(copy: Record<number, string>, titleIndex: number): Record<number, string> {
  const altered = { ...copy };
  for (const [key, text] of Object.entries(copy)) {
    const match = /[0-9٠-٩۰-۹]/.exec(text);
    if (!match) continue;
    const ch = match[0];
    const zero = ch <= '9' ? 48 : ch.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660;
    const next = String.fromCharCode(zero + ((ch.charCodeAt(0) - zero + 1) % 10));
    altered[Number(key)] = text.slice(0, match.index) + next + text.slice(match.index + 1);
    return altered;
  }
  const words = (copy[titleIndex] ?? '').split(' ');
  altered[titleIndex] = words.length > 1 ? words.slice(0, -1).join(' ') : `${words[0]}${words[0]}`;
  return altered;
}

/**
 * A development corpus from the golden briefs: per brief a layout-defect pair (the existing
 * degraded-canary transform), a copy-defect pair (one wrong fact) and a clean control (two clean
 * variants). All three share the brief's lineage. The defective side is chosen by case hash.
 */
export function buildSyntheticJudgeCorpus(input: { briefs: StudioGoldenBrief[]; outDir: string; logoDataUri?: string }) {
  if (fs.existsSync(input.outDir)) throw new Error(`Refusing to overwrite ${input.outDir}`);
  const logoDataUri = input.logoDataUri ?? getKaaeOfficialLogoDataUri();
  if (!logoDataUri) throw new Error('The packaged client logo is unavailable');
  const staging = `${input.outDir}.partial-${process.pid}`;
  fs.mkdirSync(path.join(staging, 'images'), { recursive: true });
  const runner = new OfflineRunner();
  const concept: Concept = {
    id: 'judge-corpus', name: 'Typographic', archetype: 'typographic-poster', artStrategy: 'none',
    typographicScale: { ratio: 1.5, titleSize: 56, bodySize: 22 },
    colourRoles: { background: '#0A1628', title: '#F7B500', body: '#FDF8F3', accent: '#1E3A5F', rule: '#4770A3' },
    layoutIdea: 'Typography only', whyDifferent: 'Deterministic development basis',
  };
  const cases: JudgeExperimentCase[] = [];
  for (const brief of input.briefs) {
    const copy: Record<number, string> = Object.fromEntries(brief.copyBlocks.map((b) => [b.copyIndex, b.text]));
    const offline = runner.createLayoutForConcept(brief, concept);
    delete offline.art;
    const base = fitStack(offline, copy);
    const scripts = brief.copyBlocks.slice().sort((a, b) => a.copyIndex - b.copyIndex).map((b) => b.script);
    const judgeBrief: BriefBoundJudgeBrief = {
      instructions: brief.instructions,
      copy: brief.copyBlocks.map((b) => ({ copyIndex: b.copyIndex, text: b.text, role: b.role })),
    };
    const titleIndex = brief.copyBlocks.find((b) => b.role === 'title')?.copyIndex ?? 0;
    const render = (layout: StudioLayoutV2, text: Record<number, string>) =>
      stripPngStudyMetadata(renderLayoutV2(layout, { copyText: text, logoDataUri }).png);
    const variants: Array<{ suffix: string; truth: (bad: 'A' | 'B') => JudgeExperimentTruth;
      good: { layout: StudioLayoutV2; copy: Record<number, string> }; other: { layout: StudioLayoutV2; copy: Record<number, string> } }> = [
      { suffix: 'layout', truth: (bad) => ({ kind: 'seeded_defect', badCandidate: bad, severity: 'major', defectClass: 'layout' }),
        good: { layout: base, copy }, other: { layout: createDegradedCanaryLayout(base), copy } },
      { suffix: 'copy', truth: (bad) => ({ kind: 'seeded_defect', badCandidate: bad, severity: 'critical', defectClass: 'copy' }),
        good: { layout: base, copy }, other: { layout: base, copy: alterOneFact(copy, titleIndex) } },
      { suffix: 'clean', truth: () => ({ kind: 'clean_control' }),
        good: { layout: base, copy }, other: { layout: centredVariant(base), copy } },
    ];
    for (const v of variants) {
      const caseId = `${brief.id}-${v.suffix}`;
      const bad: 'A' | 'B' = parseInt(sha256(caseId).slice(0, 2), 16) % 2 === 0 ? 'A' : 'B';
      const sides = bad === 'A' ? { A: v.other, B: v.good } : { A: v.good, B: v.other };
      const candidates = {} as JudgeExperimentCase['candidates'];
      for (const side of ['A', 'B'] as const) {
        const hardQaDefects = corpusHardQa(sides[side].layout, sides[side].copy, scripts);
        const mustBeClean = v.suffix === 'clean' || side !== bad;
        if (mustBeClean && hardQaDefects.length) {
          throw new Error(`${caseId}: the clean candidate ${side} fails hard QA (${hardQaDefects.join(', ')})`);
        }
        const bytes = render(sides[side].layout, sides[side].copy);
        const file = `images/${caseId}-${side}.png`;
        fs.writeFileSync(path.join(staging, file), bytes, { flag: 'wx' });
        candidates[side] = { file, sha256: sha256(bytes), layout: sides[side].layout, renderedCopy: sides[side].copy, hardQaDefects };
      }
      cases.push({ caseId, lineageId: brief.id, language: brief.language, format: `${brief.width}x${brief.height}`,
        brief: judgeBrief, candidates, truth: v.truth(bad) });
    }
  }
  const manifest: JudgeExperimentCorpusManifest = {
    schemaVersion: 1, corpusId: `synthetic-golden-${sha256(input.briefs.map((b) => b.id).join(',')).slice(0, 12)}`,
    split: 'development', source: 'synthetic_golden_briefs',
    note: 'Deterministic renders of KAAE golden-brief development material. Seeded defects are the existing degraded-canary ' +
      'transform and one altered fact; clean controls are two clean variants. Siblings share a lineage. Not a holdout.',
    cases,
  };
  fs.writeFileSync(path.join(staging, 'corpus.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  fs.renameSync(staging, input.outDir);
  return { corpusPath: input.outDir, cases: cases.length };
}

// ---------------------------------------------------------------------------------------------
// Synthetic provider

/**
 * A deterministic stand-in for the provider: well-formed replies for both judge schemas, derived
 * from the request hash, never from the truth labels. It proves the path; it measures nothing.
 */
export function createSyntheticJudgeFetch(): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = String(init?.body ?? '');
    const payload = JSON.parse(body) as { model: string; response_format?: { json_schema?: { name?: string } } };
    const h = Buffer.from(sha256(body), 'hex');
    const schema = payload.response_format?.json_schema?.name;
    let data: unknown;
    if (schema === 'PairwiseDimensionVerdict') {
      const dims = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'];
      const votes = dims.map((_, i) => (h[i] % 2 ? 'A' : 'B'));
      const a = votes.filter((v) => v === 'A').length;
      data = { dimensions: Object.fromEntries(dims.map((d, i) => [d, { winner: votes[i], rationale: 'synthetic' }])),
        majorityWinner: a >= 3 ? 'A' : 'B', summary: 'synthetic' };
    } else if (schema === 'BriefBoundDimensionVerdict') {
      const choices = ['A', 'B', 'tie', 'abstain'];
      const pick = (i: number) => choices[h[i] % 4];
      data = { dimensions: {
        correctness: { choice: pick(0), reason: 'synthetic' },
        communication: { choice: pick(1), reason: 'synthetic' },
        aesthetic: { choice: pick(2), reason: 'synthetic' } }, findings: [] };
    } else {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'unsupported synthetic request' } as unknown as Response;
    }
    const images = (body.match(/"type":"image_url"/g) ?? []).length;
    const promptTokens = 1500 + 800 * images;
    return {
      ok: true, status: 200, headers: { get: () => `synthetic-${h.subarray(0, 4).toString('hex')}` },
      json: async () => ({ id: `synthetic-${h.subarray(4, 12).toString('hex')}`, model: payload.model,
        choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 200, total_tokens: promptTokens + 200 } }),
    } as unknown as Response;
  }) as typeof fetch;
}

/** The production judge model; the plan compares protocols on the same model. */
export const defaultJudgeExperimentModel = (): string => resolveModel('judge', 'production');

/** The one transport both judges use: the existing studio client, with the chosen provider behind it. */
export function createJudgeExperimentClient(input: { provider: JudgeExperimentProvider; model: string; apiKey?: string }): OpenAiStudioClient {
  if (input.provider === 'openai' && !input.apiKey) throw new Error('A paid run needs an API key');
  const fetcher = input.provider === 'openai' ? fetch
    : input.provider === 'synthetic' ? createSyntheticJudgeFetch()
      : (async () => { throw new Error('A quote-only run must not dispatch'); }) as unknown as typeof fetch;
  return new OpenAiStudioClient({ apiKey: input.provider === 'openai' ? input.apiKey : 'no-network', fetcher,
    primaryModel: input.model });
}

// ---------------------------------------------------------------------------------------------
// Runner

export type JudgeExperimentProvider = 'synthetic' | 'openai' | 'quote_only';
export type JudgeName = 'incumbent' | 'challenger';

export interface JudgeExperimentCall {
  caseId: string;
  judge: JudgeName;
  order: 'AB' | 'BA';
  status: 'complete' | 'quoted' | 'refused_before_dispatch' | 'failed';
  quoteUsd: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  responseId: string | null;
  model: string;
  errorCode?: string;
}

export interface JudgeExperimentCaseRecord {
  caseId: string;
  lineageId: string;
  language: string;
  format: string;
  truth: JudgeExperimentTruth;
  humanVotes: JudgeExperimentHumanVote[];
  incumbent: { status: JudgeCaseStatus; orders: Array<{ order: 'AB' | 'BA'; winner: 'A' | 'B' }> };
  challenger: { status: JudgeCaseStatus; orders: Array<{ order: 'AB' | 'BA'; verdict: BriefBoundVerdict; packetSha256: string }> };
}
export type JudgeCaseStatus = 'complete' | 'invalid_reply' | 'incomplete' | 'not_run' | 'quoted';

export interface JudgeExperimentRun {
  schemaVersion: 1;
  planVersion: string;
  planSha256: string;
  corpus: { corpusId: string; manifestSha256: string; split: string; source: string };
  provider: JudgeExperimentProvider;
  model: string;
  startedAt: string;
  finishedAt: string;
  cases: JudgeExperimentCaseRecord[];
  calls: JudgeExperimentCall[];
  budget: { maxUsd: number; spentUsd: number; quotedUsd: number; officeLedger: boolean };
  stoppedReason: null | 'budget_exhausted' | 'office_daily_cap' | 'unquotable' | 'provider_error' | 'reservation_exceeded' | 'ledger_error';
}

class QuotedOnly extends Error {}
class StopRun extends Error {
  constructor(readonly reason: NonNullable<JudgeExperimentRun['stoppedReason']>, message: string) { super(message); }
}

const micros = (usd: number) => Math.round(usd * 1_000_000);
const usd = (m: number) => m / 1_000_000;

/**
 * Each dispatch is quoted from its exact body with the ADR-091 policy and admitted only when the
 * run cap (and the office daily ledger, when enabled) covers spent plus this reservation.
 */
function scopedClient(base: OpenAiStudioClient, state: {
  provider: JudgeExperimentProvider; maxUsd: number; officeLedger: boolean; spent: number; quoted: number;
  current: JudgeExperimentCall | null; calls: JudgeExperimentCall[];
}): OpenAiStudioClient {
  const createStructuredCompletion = async <T>(params: Parameters<OpenAiStudioClient['createStructuredCompletion']>[0]):
    Promise<OpenAiStructuredResponse<T>> => {
    const call = state.current!;
    let quote = 0;
    try {
      const result = await base.createStructuredCompletion<T>({ ...params, beforeDispatch: async (body) => {
        let reservation;
        try { reservation = reserveStudioText(body); } catch (error) {
          call.status = 'refused_before_dispatch';
          throw new StopRun('unquotable', error instanceof Error ? error.message : String(error));
        }
        quote = micros(reservation.usd);
        call.quoteUsd = reservation.usd;
        state.quoted += quote;
        if (state.provider === 'quote_only') { call.status = 'quoted'; throw new QuotedOnly(); }
        if (state.spent + quote > micros(state.maxUsd)) {
          call.status = 'refused_before_dispatch';
          throw new StopRun('budget_exhausted', `The next reservation of USD ${reservation.usd} exceeds the run cap of USD ${state.maxUsd}.`);
        }
        if (state.officeLedger) {
          const office = checkOfficeDailyBudget(reservation.usd);
          if (!office.allowed) { call.status = 'refused_before_dispatch'; throw new StopRun('office_daily_cap', office.reason ?? 'Office daily cap'); }
        }
      } });
      const cost = micros(result.receipt.costUsd);
      state.spent += cost;
      call.status = 'complete';
      call.costUsd = result.receipt.costUsd;
      call.latencyMs = result.receipt.latencyMs;
      call.responseId = result.receipt.responseId || null;
      if (state.officeLedger) {
        try { recordOfficeDailySpend(result.receipt.costUsd, ledgerEntry(call, result.receipt.costUsd)); } catch (error) {
          throw new StopRun('ledger_error', error instanceof Error ? error.message : String(error));
        }
      }
      if (cost > quote) throw new StopRun('reservation_exceeded', 'A provider cost exceeded its reservation; review pricing before continuing.');
      return result;
    } catch (error) {
      if (error instanceof QuotedOnly || error instanceof StopRun || call.status === 'complete') throw error;
      // Dispatched and failed. A known billed amount is recorded; an unknown outcome keeps its whole reservation.
      const billed = Number((error as { costUsd?: unknown })?.costUsd);
      const uncertain = (error as { isUncertain?: unknown })?.isUncertain === true;
      const status = (error as { status?: unknown })?.status;
      call.status = 'failed';
      const code = (error as { code?: unknown })?.code;
      call.errorCode = typeof code === 'string' && code ? code : typeof status === 'number' ? `HTTP_${status}` : 'CALL_FAILED';
      const spent = uncertain ? quote : billed > 0 ? micros(billed) : 0;
      call.costUsd = uncertain ? null : usd(spent);
      state.spent += spent;
      if (state.officeLedger && spent > 0) {
        try { recordOfficeDailySpend(usd(spent), ledgerEntry(call, usd(spent))); } catch (ledgerError) {
          throw new StopRun('ledger_error', ledgerError instanceof Error ? ledgerError.message : String(ledgerError));
        }
      }
      const modelLevel = error instanceof OpenAiModelParseError || error instanceof OpenAiModelTruncatedError ||
        error instanceof OpenAiModelRefusalError;
      if (modelLevel) throw error;
      throw new StopRun('provider_error', error instanceof Error ? error.message : String(error));
    }
  };
  return { createStructuredCompletion, calculateCost: base.calculateCost?.bind(base), circuitBreaker: base.circuitBreaker,
    primaryModel: base.primaryModel, fallbackModel: base.fallbackModel } as unknown as OpenAiStudioClient;
}

/** Judge calls are P07 spend in the office ledger; the call ID names the experiment case, judge and order. */
function ledgerEntry(call: JudgeExperimentCall, costUsd: number): CostLedgerEntry {
  return { callId: `judge-experiment:${call.caseId}:${call.judge}:${call.order}:${call.responseId ?? 'no-response'}`,
    stage: 'P07_JUDGE', model: call.model, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
    grossCostUsd: costUsd, cacheDiscountUsd: 0, netCostUsd: costUsd, timestamp: new Date().toISOString() };
}

export async function runJudgeExperiment(input: {
  corpus: LoadedJudgeCorpus;
  client: OpenAiStudioClient;
  provider: JudgeExperimentProvider;
  model: string;
  budget: { maxUsd: number; officeLedger: boolean };
}): Promise<JudgeExperimentRun> {
  const { corpus, provider, model } = input;
  if (!(Number.isFinite(input.budget.maxUsd) && input.budget.maxUsd >= 0)) throw new Error('A finite run cap is required');
  if (provider !== 'quote_only' && input.budget.maxUsd <= 0) throw new Error('A dispatching run needs a positive cap');
  const state = { provider, maxUsd: input.budget.maxUsd, officeLedger: provider !== 'quote_only' && input.budget.officeLedger,
    spent: 0, quoted: 0, current: null as JudgeExperimentCall | null, calls: [] as JudgeExperimentCall[] };
  const client = scopedClient(input.client, state);
  const startedAt = new Date().toISOString();
  let stoppedReason: JudgeExperimentRun['stoppedReason'] = null;
  const cases: JudgeExperimentCaseRecord[] = corpus.manifest.cases.map((c) => ({
    caseId: c.caseId, lineageId: c.lineageId, language: c.language, format: c.format, truth: c.truth,
    humanVotes: c.humanVotes ?? [], incumbent: { status: 'not_run', orders: [] }, challenger: { status: 'not_run', orders: [] },
  }));

  const attempt = async (record: JudgeExperimentCaseRecord, judge: JudgeName, order: 'AB' | 'BA', run: () => Promise<void>) => {
    const call: JudgeExperimentCall = { caseId: record.caseId, judge, order, status: 'refused_before_dispatch',
      quoteUsd: null, costUsd: null, latencyMs: null, responseId: null, model };
    state.current = call;
    state.calls.push(call);
    const side = record[judge];
    try {
      await run();
      if (side.status === 'not_run') side.status = 'incomplete';
    } catch (error) {
      if (error instanceof QuotedOnly) { side.status = 'quoted'; return; }
      if (error instanceof StopRun) {
        side.status = side.orders.length || call.status !== 'refused_before_dispatch' ? 'incomplete' : side.status;
        throw error;
      }
      // A reply that arrived but is not a usable verdict: measured as a failure, the run continues.
      side.status = 'invalid_reply';
      call.errorCode = call.errorCode ?? String((error as { code?: unknown })?.code ?? 'INVALID_REPLY');
    } finally {
      state.current = null;
    }
  };

  try {
    for (const [index, c] of corpus.manifest.cases.entries()) {
      const record = cases[index];
      const imgA = corpus.images.get(`${c.caseId}:A`)!;
      const imgB = corpus.images.get(`${c.caseId}:B`)!;
      const copyText: Record<number, string> = Object.fromEntries(c.brief.copy.map((b) => [b.copyIndex, b.text]));
      const incumbentInput = (side: 'A' | 'B', png: Buffer) => ({
        id: side, layout: c.candidates[side].layout, renderedPng: png,
        deterministicMetrics: measureDesignV3(c.candidates[side].layout, { text: c.candidates[side].renderedCopy ?? copyText }),
      });
      const A = incumbentInput('A', imgA), B = incumbentInput('B', imgB);
      const settle = (judge: JudgeName) => {
        if (record[judge].status === 'incomplete' && record[judge].orders.length === 2) record[judge].status = 'complete';
      };
      for (const order of ['AB', 'BA'] as const) {
        await attempt(record, 'incumbent', order, async () => {
          const [left, right] = order === 'AB' ? [A, B] : [B, A];
          const result = await evaluatePairOrder(left, right, order, { client, model, renderOptions: { copyText } });
          record.incumbent.orders.push({ order, winner: result.majorityWinner });
        });
      }
      settle('incumbent');
      for (const order of ['AB', 'BA'] as const) {
        await attempt(record, 'challenger', order, async () => {
          const [left, right] = order === 'AB' ? [{ id: 'A', png: imgA }, { id: 'B', png: imgB }] : [{ id: 'B', png: imgB }, { id: 'A', png: imgA }];
          const result = await evaluateBriefBoundPairOrder(left, right, order, { brief: c.brief, client, model });
          record.challenger.orders.push({ order, verdict: result.verdict, packetSha256: result.packetSha256 });
        });
      }
      settle('challenger');
    }
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
    stoppedReason = error.reason;
  }
  return {
    schemaVersion: 1, planVersion: JUDGE_EXPERIMENT_PLAN.version, planSha256: JUDGE_EXPERIMENT_PLAN_SHA256,
    corpus: { corpusId: corpus.manifest.corpusId, manifestSha256: corpus.manifestSha256, split: corpus.manifest.split,
      source: corpus.manifest.source },
    provider, model, startedAt, finishedAt: new Date().toISOString(), cases, calls: state.calls,
    budget: { maxUsd: input.budget.maxUsd, spentUsd: usd(state.spent), quotedUsd: usd(state.quoted), officeLedger: state.officeLedger },
    stoppedReason,
  };
}

// ---------------------------------------------------------------------------------------------
// Analysis

type SourceChoice = 'A' | 'B' | 'tie' | 'abstain' | null;

function incumbentChoice(record: JudgeExperimentCaseRecord): { choice: SourceChoice; consistent: boolean | null } {
  if (record.incumbent.status !== 'complete') return { choice: null, consistent: null };
  const ab = record.incumbent.orders.find((o) => o.order === 'AB')!.winner;
  const ba = record.incumbent.orders.find((o) => o.order === 'BA')!.winner === 'A' ? 'B' : 'A';
  // An order flip is the incumbent's discarded pair: no choice.
  return { choice: ab === ba ? ab : 'tie', consistent: ab === ba };
}

function challengerChoice(record: JudgeExperimentCaseRecord): { choice: SourceChoice; consistent: boolean | null; critical: boolean } {
  if (record.challenger.status !== 'complete') return { choice: null, consistent: null, critical: false };
  const ab = validateBriefBoundVerdict(record.challenger.orders.find((o) => o.order === 'AB')!.verdict);
  const ba = validateBriefBoundVerdict(record.challenger.orders.find((o) => o.order === 'BA')!.verdict);
  const decision = decideBriefBoundPair(ab, ba);
  const swap = (c: string) => (c === 'A' ? 'B' : c === 'B' ? 'A' : c);
  const perAB = briefBoundOrderChoice(ab), perBA = swap(briefBoundOrderChoice(ba));
  const choice = decision.outcome === 'first' ? 'A' : decision.outcome === 'second' ? 'B' : decision.outcome === 'tie' ? 'tie' : 'abstain';
  return { choice, consistent: perAB === perBA,
    critical: [...ab.findings, ...ba.findings].some((f) => f.severity === 'critical') };
}

function consensus(votes: JudgeExperimentHumanVote[]): 'A' | 'B' | 'tie' | null {
  const valid = votes.filter((v) => v.vote !== 'cannot_judge');
  if (valid.length < 3) return null;
  for (const choice of ['A', 'B', 'tie'] as const) if (valid.filter((v) => v.vote === choice).length > valid.length / 2) return choice;
  return null;
}

interface Rate { rate: number | null; lower95: number | null; upper95: number | null }
interface PairedEndpoint {
  cases: number;
  lineages: number;
  incumbent: Rate;
  challenger: Rate;
  difference: { point: number | null; lower95: number | null; upper95: number | null };
  discordant: { challengerOnly: number; incumbentOnly: number };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/** Paired per case, averaged within lineage, lineages resampled with the plan's seed. */
function pairedEndpoint(name: string, rows: Array<{ lineageId: string; incumbent: number; challenger: number }>): PairedEndpoint {
  const byLineage = new Map<string, Array<{ incumbent: number; challenger: number }>>();
  for (const row of rows) byLineage.set(row.lineageId, [...(byLineage.get(row.lineageId) ?? []), row]);
  const groups = [...byLineage.values()].map((g) => ({ inc: mean(g.map((r) => r.incumbent)), chal: mean(g.map((r) => r.challenger)) }));
  const discordant = { challengerOnly: rows.filter((r) => r.challenger === 1 && r.incumbent === 0).length,
    incumbentOnly: rows.filter((r) => r.incumbent === 1 && r.challenger === 0).length };
  if (!groups.length) {
    const none = { rate: null, lower95: null, upper95: null };
    return { cases: 0, lineages: 0, incumbent: none, challenger: none, difference: { point: null, lower95: null, upper95: null }, discordant };
  }
  const random = rng(`${JUDGE_EXPERIMENT_PLAN.bootstrap.seed}:${name}`);
  const inc: number[] = [], chal: number[] = [], diff: number[] = [];
  for (let i = 0; i < JUDGE_EXPERIMENT_PLAN.bootstrap.iterations; i++) {
    let a = 0, b = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(random() * groups.length)];
      a += g.inc; b += g.chal;
    }
    inc.push(a / groups.length); chal.push(b / groups.length); diff.push((b - a) / groups.length);
  }
  const interval = (draws: number[]) => {
    draws.sort((x, y) => x - y);
    return { lower95: draws[Math.floor(draws.length * 0.025)], upper95: draws[Math.floor(draws.length * 0.975)] };
  };
  const incRate = mean(groups.map((g) => g.inc)), chalRate = mean(groups.map((g) => g.chal));
  return { cases: rows.length, lineages: groups.length,
    incumbent: { rate: incRate, ...interval(inc) }, challenger: { rate: chalRate, ...interval(chal) },
    difference: { point: chalRate - incRate, ...interval(diff) }, discordant };
}

export type JudgeExperimentDecision =
  | 'QUOTE_ONLY' | 'SYNTHETIC_PLUMBING_ONLY' | 'INCOMPLETE' | 'INSUFFICIENT_SAMPLE' | 'CHALLENGER_REGRESSES'
  | 'NO_WORTHWHILE_DIFFERENCE' | 'PENDING_HUMAN_LABELS' | 'CHALLENGER_ELIGIBLE_FOR_SHADOW';

const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

/** Applies the frozen plan. Human labels collected after the run may be supplied per case. */
export function analyzeJudgeExperiment(run: JudgeExperimentRun, labels: Record<string, { humanVotes: JudgeExperimentHumanVote[] }> = {}) {
  if (run.schemaVersion !== 1 || run.planVersion !== JUDGE_EXPERIMENT_PLAN.version || run.planSha256 !== JUDGE_EXPERIMENT_PLAN_SHA256) {
    throw new Error('This run is bound to a different experiment plan');
  }
  const known = new Set(run.cases.map((c) => c.caseId));
  for (const [caseId, label] of Object.entries(labels)) {
    if (!known.has(caseId)) throw new Error(`Human labels name an unknown case: ${caseId}`);
    validateHumanVotes(label.humanVotes, caseId);
  }
  const rows = run.cases.map((c) => {
    const inc = incumbentChoice(c), chal = challengerChoice(c);
    const humanVotes = labels[c.caseId]?.humanVotes ?? c.humanVotes;
    return { c, inc, chal, human: consensus(humanVotes) };
  });
  const seeded = rows.filter((r) => r.c.truth.kind === 'seeded_defect');
  const good = (r: typeof rows[number]) => (r.c.truth.kind === 'seeded_defect' ? (r.c.truth.badCandidate === 'A' ? 'B' : 'A') : null);
  const detection = (subset: typeof rows, name: string) => pairedEndpoint(name, subset.map((r) => ({ lineageId: r.c.lineageId,
    incumbent: r.inc.choice === good(r) ? 1 : 0, challenger: r.chal.choice === good(r) ? 1 : 0 })));
  const primary = detection(seeded, 'seeded_defect_detection');
  const byClass = (cls: 'copy' | 'layout') => detection(seeded.filter((r) => r.c.truth.kind === 'seeded_defect' && r.c.truth.defectClass === cls), `${cls}_defect_detection`);
  const orderConsistency = pairedEndpoint('order_consistency', rows.map((r) => ({ lineageId: r.c.lineageId,
    incumbent: r.inc.consistent ? 1 : 0, challenger: r.chal.consistent ? 1 : 0 })));
  const labelled = rows.filter((r) => r.human !== null);
  const humanAgreement = pairedEndpoint('human_agreement', labelled.map((r) => ({ lineageId: r.c.lineageId,
    incumbent: r.inc.choice === r.human ? 1 : 0, challenger: r.chal.choice === r.human ? 1 : 0 })));
  const clean = rows.filter((r) => r.c.truth.kind === 'clean_control');
  const falseCritical = clean.length ? clean.filter((r) => r.chal.critical).length / clean.length : null;

  const costs = (judge: JudgeName) => {
    const calls = run.calls.filter((c) => c.judge === judge && c.status !== 'quoted' && c.status !== 'refused_before_dispatch');
    const known = calls.filter((c) => c.costUsd !== null).reduce((s, c) => s + c.costUsd!, 0);
    const casesRun = new Set(calls.map((c) => c.caseId)).size;
    const latencies = calls.filter((c) => c.latencyMs !== null).map((c) => c.latencyMs!);
    return { calls: calls.length, knownUsd: Number(known.toFixed(6)), unknownCostCalls: calls.filter((c) => c.costUsd === null).length,
      meanUsdPerCase: casesRun ? known / casesRun : null, latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95),
      quotedUsd: Number(run.calls.filter((c) => c.judge === judge).reduce((s, c) => s + (c.quoteUsd ?? 0), 0).toFixed(6)) };
  };
  const cost = { incumbent: costs('incumbent'), challenger: costs('challenger') };
  const costRatio = cost.incumbent.meanUsdPerCase && cost.challenger.meanUsdPerCase !== null
    ? cost.challenger.meanUsdPerCase / cost.incumbent.meanUsdPerCase : null;

  const lineagesOf = (subset: typeof rows) => new Set(subset.map((r) => r.c.lineageId)).size;
  const counts = { cases: rows.length, lineages: lineagesOf(rows), seededDefectCases: seeded.length, seededDefectLineages: lineagesOf(seeded),
    cleanControlCases: clean.length, cleanControlLineages: lineagesOf(clean), humanLabelledCases: labelled.length,
    incumbentComplete: rows.filter((r) => r.c.incumbent.status === 'complete').length,
    challengerComplete: rows.filter((r) => r.c.challenger.status === 'complete').length,
    invalidReplies: rows.filter((r) => r.c.incumbent.status === 'invalid_reply' || r.c.challenger.status === 'invalid_reply').length,
    notRunOrIncomplete: rows.filter((r) => !['complete', 'invalid_reply'].includes(r.c.incumbent.status) ||
      !['complete', 'invalid_reply'].includes(r.c.challenger.status)).length };

  const m = JUDGE_EXPERIMENT_PLAN.margins;
  const margins = {
    order_consistency: orderConsistency.difference.lower95 !== null && orderConsistency.difference.lower95 > m.order_consistency.margin,
    clean_control_false_critical: falseCritical !== null && falseCritical <= m.clean_control_false_critical.ceiling,
    cost_per_case_ratio: costRatio !== null && costRatio <= m.cost_per_case_ratio.ceiling &&
      cost.incumbent.unknownCostCalls === 0 && cost.challenger.unknownCostCalls === 0,
    human_agreement: labelled.length ? humanAgreement.difference.lower95! > m.human_agreement.margin : null,
  };
  const superior = primary.difference.point !== null && primary.difference.lower95 !== null &&
    primary.difference.point >= JUDGE_EXPERIMENT_PLAN.primary.worthwhileEffect && primary.difference.lower95 > 0;

  let decision: JudgeExperimentDecision;
  if (run.provider === 'quote_only') decision = 'QUOTE_ONLY';
  else if (run.provider === 'synthetic') decision = 'SYNTHETIC_PLUMBING_ONLY';
  else if (run.stoppedReason !== null || counts.notRunOrIncomplete > 0) decision = 'INCOMPLETE';
  else if (counts.seededDefectLineages < JUDGE_EXPERIMENT_PLAN.minimumSample.seededDefectLineages ||
    counts.cleanControlLineages < JUDGE_EXPERIMENT_PLAN.minimumSample.cleanControlLineages) decision = 'INSUFFICIENT_SAMPLE';
  else if (!margins.order_consistency || !margins.clean_control_false_critical || !margins.cost_per_case_ratio) decision = 'CHALLENGER_REGRESSES';
  else if (!superior) decision = 'NO_WORTHWHILE_DIFFERENCE';
  else if (margins.human_agreement === null) decision = 'PENDING_HUMAN_LABELS';
  else if (!margins.human_agreement) decision = 'CHALLENGER_REGRESSES';
  else decision = 'CHALLENGER_ELIGIBLE_FOR_SHADOW';

  const completeChallenger = rows.filter((r) => r.chal.choice !== null);
  const strata = (field: 'language' | 'format') => {
    const out: Record<string, { cases: number; lineages: number; incumbentDetected: number; challengerDetected: number; seeded: number }> = {};
    for (const r of rows) {
      const key = r.c[field];
      const s = (out[key] ||= { cases: 0, lineages: 0, incumbentDetected: 0, challengerDetected: 0, seeded: 0 });
      s.cases++;
      if (r.c.truth.kind === 'seeded_defect') {
        s.seeded++;
        if (r.inc.choice === good(r)) s.incumbentDetected++;
        if (r.chal.choice === good(r)) s.challengerDetected++;
      }
    }
    for (const key of Object.keys(out)) out[key].lineages = lineagesOf(rows.filter((r) => r.c[field] === key));
    return out;
  };
  return {
    schemaVersion: 1 as const,
    planVersion: JUDGE_EXPERIMENT_PLAN.version,
    planSha256: JUDGE_EXPERIMENT_PLAN_SHA256,
    runProvider: run.provider,
    corpus: run.corpus,
    decision,
    admissionQualified: false as const,
    counts,
    primary,
    secondary: { copyDefectDetection: byClass('copy'), layoutDefectDetection: byClass('layout'), orderConsistency, humanAgreement },
    margins: { ...margins, cleanControlFalseCriticalRate: falseCritical, costPerCaseRatio: costRatio, superiority: superior },
    reported: {
      challengerAbstentionRate: completeChallenger.length ? completeChallenger.filter((r) => r.chal.choice === 'abstain').length / completeChallenger.length : null,
      challengerTieRate: completeChallenger.length ? completeChallenger.filter((r) => r.chal.choice === 'tie').length / completeChallenger.length : null,
      byLanguage: strata('language'),
      byFormat: strata('format'),
    },
    cost,
    stoppedReason: run.stoppedReason,
    limits: 'Case counts include correlated siblings; intervals resample lineages. Seeded defects are constructed, not observed. ' +
      'Model agreement is not design quality. A synthetic or quote-only run measures nothing about judgment.',
  };
}
