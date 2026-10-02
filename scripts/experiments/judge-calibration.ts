/**
 * ADR-274 item 6: does the poster judge agree with people? A calibration harness, PREPARED, NOT RUN.
 *
 * The production judge (P07, `pairwise-judge-v3.ts`) chooses which design a requester sees. It has
 * never been measured against a human preference: the research (DESIGN_10_RESEARCH.md, section 5,
 * lever 6) says calibrated selection helps only when it agrees with a human panel, and natural pairs
 * are near chance for many models. This harness runs the judge over a frozen set of pairs (our renders
 * against the office's own published posts, and our shipped document pages against our posters), each
 * pair in both presentation orders, and reports how often it agrees with the blind panel of 2026-10-02.
 *
 * What it sends is the poster client's production judge: the ADR-274 system prompt
 * (`buildPairwiseJudgeSystemPrompt` with `posterImpact`, the client profile and the KAAE
 * guideline-fidelity rule), the five-dimension schema, the production image detail, output allowance
 * and reasoning effort. One difference, stated in every request: an office post has no layout record,
 * so no legibility facts can be measured for it; the facts block says so and asks for judging by eye,
 * for both images alike.
 *
 * Spending. Nothing is sent unless all three hold: `--execute`, OPENAI_API_KEY, and
 * HAWA_JUDGE_CALIBRATION_APPROVED naming the owner's approval of the spend (it is recorded in the
 * report). Without them the harness prints the plan and its expected cost and exits. The frozen set
 * has 47 pairs: 94 calls. At the production judge's measured rate (ADR-237: $0.0143-0.0198 a call on
 * gpt-6.1-sol, two 1080-wide images) a run costs about $1.34-1.86; `--office-reference` adds a third
 * image to every call and is not part of the plan's estimate unless passed.
 *
 * Usage (plan only, free):
 *   npx tsx scripts/experiments/judge-calibration.ts --images <dir>
 * Run (paid; needs the owner's approval of the spend):
 *   OPENAI_API_KEY=... HAWA_JUDGE_CALIBRATION_APPROVED="owner 2026-10-0x: judge calibration <= $2" \
 *     npx tsx scripts/experiments/judge-calibration.ts --images <dir> --execute [--model gpt-6.1-sol] \
 *       [--set plans/judge-calibration-2026-10-02/frozen-set.json] [--limit 47] [--out <report.json>]
 *
 * `--images` holds the blinded panel images as <id>.jpg or <id>.png (d01 ... d33), or each image under
 * its own file name; office posts fall back to packages/creative/assets/exemplars.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildPairwiseJudgeSystemPrompt,
  judgeImageDetail,
  judgeMaxTokens,
  JUDGE_DIMENSIONS,
  PAIRWISE_DIMENSION_JSON_SCHEMA,
  type JudgeDimension,
} from '../../packages/creative/src/studio/pairwise-judge-v3.js';
import { guidelineFidelityRule, pageGrammarFromRaw } from '../../packages/creative/src/studio/page-grammar.js';
import { OpenAiStudioClient } from '../../packages/creative/src/studio/openai-studio-client.js';

const ROOT = resolve(import.meta.dirname, '../..');

export interface FrozenImage { id: string; group: string; file: string; panelOverall: number }
export interface FrozenPair { a: string; b: string; kind: string }
export interface FrozenSet { version: number; tieMargin: number; images: FrozenImage[]; pairs: FrozenPair[] }
export type Preference = 'a' | 'b' | 'tie';

/** Measured cost of one production judge call on gpt-6.1-sol (ADR-237, 2026-10-01). */
export const JUDGE_CALL_USD = { low: 0.0143, high: 0.0198 } as const;
/** One more 864-1080 px image at high detail on gpt-6.1-sol: about 1,500-1,800 input tokens at $2 per million. */
export const OFFICE_REFERENCE_USD_PER_CALL = { low: 0.003, high: 0.0036 } as const;

/** The panel's preference for a pair: the higher mean overall score, or a tie inside the margin. */
export function panelLabel(set: FrozenSet, pair: FrozenPair): Preference {
  const score = (id: string) => {
    const image = set.images.find((i) => i.id === id);
    if (!image) throw new Error(`The frozen set has no image ${id}.`);
    return image.panelOverall;
  };
  const diff = score(pair.a) - score(pair.b);
  return Math.abs(diff) < set.tieMargin ? 'tie' : diff > 0 ? 'a' : 'b';
}

/** What a run would send and cost: two calls a pair. */
export function calibrationPlan(set: FrozenSet, options: { limit?: number; officeReference?: boolean } = {}) {
  const pairs = set.pairs.slice(0, options.limit ?? set.pairs.length);
  const calls = 2 * pairs.length;
  const extra = options.officeReference ? OFFICE_REFERENCE_USD_PER_CALL : { low: 0, high: 0 };
  const usd = { low: round(calls * (JUDGE_CALL_USD.low + extra.low)), high: round(calls * (JUDGE_CALL_USD.high + extra.high)) };
  const labels = pairs.map((p) => panelLabel(set, p));
  return { pairs, calls, usd, labelCounts: { a: count(labels, 'a'), b: count(labels, 'b'), tie: count(labels, 'tie') } };
}

/** One pair's judged outcome: the winner by majority in each order, and the order-consistent verdict. */
export interface JudgedPair {
  pair: FrozenPair;
  label: Preference;
  /** The design that won with `a` shown first, and with `b` shown first. */
  winnerAFirst: 'a' | 'b';
  winnerBFirst: 'a' | 'b';
  /** The consistent winner, or a tie when the two orders disagree (the production rule). */
  verdict: Preference;
  votes: { aFirst: Record<JudgeDimension, 'A' | 'B'>; bFirst: Record<JudgeDimension, 'A' | 'B'> };
  costUsd: number;
}

export function verdictOf(winnerAFirst: 'a' | 'b', winnerBFirst: 'a' | 'b'): Preference {
  return winnerAFirst === winnerBFirst ? winnerAFirst : 'tie';
}

/**
 * Agreement with the panel. `decided` counts the pairs both the judge and the panel decided, and how
 * many the judge got the panel's way; `threeWay` counts exact matches with ties as a third answer;
 * `positionConsistency` is the share of pairs the judge decided the same way in both orders; `kappa`
 * is Cohen's kappa over the three answers.
 */
export function summarizeCalibration(results: JudgedPair[]) {
  const decided = results.filter((r) => r.label !== 'tie' && r.verdict !== 'tie');
  const agreeDecided = decided.filter((r) => r.label === r.verdict).length;
  const exact = results.filter((r) => r.label === r.verdict).length;
  const answers: Preference[] = ['a', 'b', 'tie'];
  const n = results.length;
  const expected = n ? answers.reduce((s, k) => s + (count(results.map((r) => r.label), k) / n) * (count(results.map((r) => r.verdict), k) / n), 0) : 0;
  const observed = n ? exact / n : 0;
  const byKind: Record<string, { pairs: number; agreeDecided: number; decided: number }> = {};
  for (const r of results) {
    const k = (byKind[r.pair.kind] ??= { pairs: 0, agreeDecided: 0, decided: 0 });
    k.pairs++;
    if (r.label !== 'tie' && r.verdict !== 'tie') {
      k.decided++;
      if (r.label === r.verdict) k.agreeDecided++;
    }
  }
  return {
    pairs: n,
    positionConsistency: n ? round(results.filter((r) => r.winnerAFirst === r.winnerBFirst).length / n) : 0,
    decided: { pairs: decided.length, agree: agreeDecided, rate: decided.length ? round(agreeDecided / decided.length) : null },
    threeWay: { agree: exact, rate: n ? round(observed) : null },
    kappa: n && expected < 1 ? round((observed - expected) / (1 - expected)) : null,
    byKind,
    costUsd: round(results.reduce((s, r) => s + r.costUsd, 0)),
  };
}

function count<T>(values: T[], value: T): number {
  return values.filter((v) => v === value).length;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function imagePath(dir: string, image: FrozenImage): string {
  const candidates = [join(dir, `${image.id}.jpg`), join(dir, `${image.id}.png`), join(dir, image.file),
    join(ROOT, 'packages/creative/assets/exemplars', image.file)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No image for ${image.id} (${image.file}) under ${dir}.`);
  return found;
}

function dataUrl(path: string): string {
  const mime = extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

/** The facts block this harness sends in place of measured metrics, which an office post cannot have. */
export const CALIBRATION_FACTS =
  'LEGIBILITY FACTS: not available for this comparison (one of the images may be a published post with no layout record). Judge both candidates by eye.';

async function judgeOrder(
  client: OpenAiStudioClient, model: string, system: string, first: string, second: string, office?: string
): Promise<{ winner: 'A' | 'B'; votes: Record<JudgeDimension, 'A' | 'B'>; costUsd: number }> {
  const detail = judgeImageDetail(model);
  const text = `${CALIBRATION_FACTS}

Attached are two images rendered at detail '${detail}':
- Image 1: Candidate A
- Image 2: Candidate B

TASK:
Examine Candidate A and Candidate B visually and evaluate them independently across all ${JUDGE_DIMENSIONS.length} dimensions.${office
    ? '\n\nImage 3 is one of the client\'s own published posts, shown as the standard of impact and brand fit the client sets: the standard, not a design to copy.' : ''}`;
  const res = await client.createStructuredCompletion<{ dimensions: Record<JudgeDimension, { winner: 'A' | 'B' }> }>({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: first, detail } },
        { type: 'image_url', image_url: { url: second, detail } },
        ...(office ? [{ type: 'image_url' as const, image_url: { url: office, detail } }] : []),
      ] },
    ],
    jsonSchema: { name: 'PairwiseDimensionVerdict', schema: PAIRWISE_DIMENSION_JSON_SCHEMA, strict: true },
    reasoningEffort: 'low',
    maxTokens: judgeMaxTokens(model),
  });
  const votes = {} as Record<JudgeDimension, 'A' | 'B'>;
  for (const d of JUDGE_DIMENSIONS) {
    const w = res.data.dimensions?.[d]?.winner;
    if (w !== 'A' && w !== 'B') throw new Error(`The judge returned no vote for ${d}; the run stops rather than count a missing answer.`);
    votes[d] = w;
  }
  const a = JUDGE_DIMENSIONS.filter((d) => votes[d] === 'A').length;
  return { winner: a >= 3 ? 'A' : 'B', votes, costUsd: res.receipt.costUsd };
}

async function main(): Promise<void> {
  const setPath = resolve(ROOT, arg('set') ?? 'plans/judge-calibration-2026-10-02/frozen-set.json');
  const set = JSON.parse(readFileSync(setPath, 'utf8')) as FrozenSet;
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const officeReference = process.argv.includes('--office-reference');
  const plan = calibrationPlan(set, { limit, officeReference });
  const model = arg('model') ?? 'gpt-6.1-sol';
  console.log(JSON.stringify({ plan: { set: setPath, model, pairs: plan.pairs.length, calls: plan.calls, expectedUsd: plan.usd,
    panelLabels: plan.labelCounts, officeReference } }, null, 2));

  const approval = process.env.HAWA_JUDGE_CALIBRATION_APPROVED?.trim();
  if (!process.argv.includes('--execute') || !approval || !process.env.OPENAI_API_KEY) {
    console.log('Plan only: nothing was sent. A paid run needs --execute, OPENAI_API_KEY and HAWA_JUDGE_CALIBRATION_APPROVED (the owner\'s approval of the spend).');
    return;
  }
  const dir = resolve(arg('images') ?? '.');
  const raw = JSON.parse(readFileSync(join(ROOT, 'packages/creative/assets/kaae-reference.json'), 'utf8'));
  const system = buildPairwiseJudgeSystemPrompt({
    photoBrief: false, posterImpact: true, houseRules: [guidelineFidelityRule(pageGrammarFromRaw(raw)!)],
    // The client pack's profile, as production passes it (design-studio-service: pack.profile).
    clientProfile: (JSON.parse(readFileSync(join(ROOT, 'packages/creative/assets/clients/kaae.json'), 'utf8')) as { profile?: string }).profile,
  });
  const office = officeReference ? dataUrl(join(ROOT, 'packages/creative/assets/exemplars/photo11_peer_evaluators_call_en.jpg')) : undefined;
  const client = new OpenAiStudioClient({ primaryModel: model });
  const results: JudgedPair[] = [];
  for (const pair of plan.pairs) {
    const image = (id: string) => dataUrl(imagePath(dir, set.images.find((i) => i.id === id)!));
    const [a, b] = [image(pair.a), image(pair.b)];
    const aFirst = await judgeOrder(client, model, system, a, b, office);
    const bFirst = await judgeOrder(client, model, system, b, a, office);
    const winnerAFirst = aFirst.winner === 'A' ? 'a' : 'b';
    const winnerBFirst = bFirst.winner === 'A' ? 'b' : 'a';
    results.push({ pair, label: panelLabel(set, pair), winnerAFirst, winnerBFirst, verdict: verdictOf(winnerAFirst, winnerBFirst),
      votes: { aFirst: aFirst.votes, bFirst: bFirst.votes }, costUsd: aFirst.costUsd + bFirst.costUsd });
    console.log(`${pair.a} vs ${pair.b}: panel ${results.at(-1)!.label}, judge ${results.at(-1)!.verdict}`);
  }
  const report = { model, approval, set: setPath, ranAt: new Date().toISOString(), officeReference, summary: summarizeCalibration(results), results };
  const out = arg('out');
  if (out) writeFileSync(resolve(out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
