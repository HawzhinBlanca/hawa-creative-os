/**
 * Does a cheap model judge these designs as well as the expensive one?
 *
 * The judging stage is 27% of a production run's cost ($0.171 of $0.629 per design, measured over
 * 16 runs in hawa.design_studio_calls) and it invents nothing: it compares two already-rendered
 * posters across five named dimensions, and it is handed the deterministic metric scores as facts.
 * That makes it the obvious stage to move down a tier — but only if it picks the same designs.
 *
 * This measures that without paying the expensive model again. Every past run stored its judge's
 * per-dimension votes in hawa.design_studio_judgments, with the receipt naming the model, and the
 * candidates it judged still carry the exact preview PNGs it saw. So the expensive side of the
 * comparison is already bought and paid for; only the cheap side is re-run.
 *
 * Two independent measurements, because agreement alone would not be enough:
 *
 *   1. AGREEMENT — replay each stored comparison with the cheap model, same A, same B, same
 *      presentation order, same images, same stated metrics. Report per-dimension and winner
 *      agreement. Caveat, stated in the output: runs made after 2026-09-19 also showed the judge
 *      the client's reference image, which is not stored on the judgment, so those replays see a
 *      slightly shorter prompt than the original did.
 *
 *   2. CANARY — the pipeline's own reliability test, and the one with a known right answer. It
 *      pits a layout against a deliberately degraded copy of itself (createDegradedCanaryLayout:
 *      body text at half size, title displaced over the logo). A judge that cannot see that
 *      difference is not a judge. This needs no expensive baseline at all, so it is free of the
 *      confound above.
 *
 * Read the source database from a restore of a nightly dump, never from production:
 *   docker exec hawa-test-postgres psql -U hawa_owner -d postgres -c 'CREATE DATABASE hawa_costlab'
 *   docker exec hawa-test-postgres pg_restore -U hawa_owner -d hawa_costlab --no-owner --no-acl <dump>
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx scripts/experiments/judge-model-agreement.ts [--model gpt-4.1-mini]
 *                                                                          [--limit 24] [--canary-only]
 */
import { execFileSync } from 'node:child_process';
import { evaluatePairOrder, type CandidateJudgeInput } from '../../packages/creative/src/studio/pairwise-judge-v3.js';
import { createDegradedCanaryLayout } from '../../packages/creative/src/studio/pairwise-judge-v3.js';
import { renderLayoutV2 } from '../../packages/creative/src/studio/render-layout-v2.js';
import type { StudioLayoutV2 } from '../../packages/creative/src/studio/layout-v2.js';

const JUDGE_DIMENSIONS = ['hierarchy', 'composition', 'typographic_craft', 'brand_fit', 'legibility'] as const;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const CHEAP_MODEL = arg('model', 'gpt-4.1-mini')!;
const LIMIT = Number(arg('limit', '24'));
const CANARY_ONLY = process.argv.includes('--canary-only');
// Read through the test container's own psql rather than a driver: the restored analysis database
// lives inside it, `pg` is a dependency of @hawa/db and not of this script, and going through psql
// keeps this script from being able to reach a production DSN even by accident.
const CONTAINER = process.env.COSTLAB_CONTAINER || 'hawa-test-postgres';
const COSTLAB_DB = process.env.COSTLAB_DB || 'hawa_costlab';

interface StoredJudgment {
  id: string;
  run_id: string;
  order_swapped: boolean;
  verdict: any;
  a_layouts: any[];
  a_metrics: any;
  a_preview: Buffer;
  b_layouts: any[];
  b_metrics: any;
  b_preview: Buffer;
  baseline_model: string;
}

/** The layout that actually shipped for a candidate: the last one it recorded. */
const finalLayout = (layouts: any[]): StudioLayoutV2 => {
  const last = layouts[layouts.length - 1];
  return (typeof last === 'string' ? JSON.parse(last) : last) as StudioLayoutV2;
};

async function load(): Promise<StoredJudgment[]> {
  // Only judgments whose judge ran on the production model, that carry the rich per-dimension
  // shape, and whose two candidates still have the preview PNGs that judge was actually shown.
  // Layouts are jsonb[]; to_jsonb turns the array into JSON, and the PNGs travel as base64.
  const query = `
    SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text FROM (
      SELECT j.id, j.run_id, j.order_swapped, j.verdict,
             to_jsonb(a.layouts) AS a_layouts, a.metrics AS a_metrics,
             encode(a.preview_png, 'base64') AS a_preview,
             to_jsonb(b.layouts) AS b_layouts, b.metrics AS b_metrics,
             encode(b.preview_png, 'base64') AS b_preview,
             j.verdict->'receipt'->>'model' AS baseline_model
        FROM hawa.design_studio_judgments j
        JOIN hawa.design_studio_candidates a ON a.id = j.candidate_a AND a.preview_png IS NOT NULL
        JOIN hawa.design_studio_candidates b ON b.id = j.candidate_b AND b.preview_png IS NOT NULL
       WHERE j.kind = 'pairwise'
         AND j.verdict ? 'votes'
         AND j.verdict->'receipt'->>'model' = 'gpt-6-astra'
       ORDER BY j.created_at
       LIMIT ${Number(LIMIT)}
    ) t`;
  const raw = execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', 'hawa_owner', '-d', COSTLAB_DB, '-At', '-c', query],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 }
  );
  return (JSON.parse(raw) as any[]).map((r) => ({
    ...r,
    a_preview: Buffer.from(r.a_preview, 'base64'),
    b_preview: Buffer.from(r.b_preview, 'base64'),
  })) as StoredJudgment[];
}

/**
 * The candidate as the judge sees it. `deterministicMetrics` is deliberately NOT taken from the
 * candidate row: that column stores the hard-QA measurements (overlapCount, marginMin, lines per
 * block), not the `DesignMetricsResult` the judge is given as facts, and feeding it through throws.
 * Leaving it undefined makes `evaluatePairOrder` measure both candidates itself, identically.
 *
 * The caveat that follows, stated here rather than buried: the original judge's facts block was
 * measured with the real copy's wrapped lines, and this one is measured from the boxes, so a few
 * numbers in the prompt's GROUND TRUTH section differ from the originals. Both sides of each pair
 * are measured the same way, so the comparison the judge is asked to make is still like-for-like,
 * and the images — which are the dominant input — are the exact bytes the expensive judge saw.
 */
const judgeInput = (id: string, layout: StudioLayoutV2, png: Buffer): CandidateJudgeInput => ({
  id,
  layout,
  renderedPng: png,
});

async function agreement(rows: StoredJudgment[]) {
  let dimsAgree = 0;
  let dimsTotal = 0;
  let winnersAgree = 0;
  let cheapCost = 0;
  let baselineCost = 0;
  const perDimension: Record<string, { agree: number; total: number }> = {};
  const disagreements: Array<{ id: string; dim: string; baseline: string; cheap: string }> = [];

  for (const [i, row] of rows.entries()) {
    const a = judgeInput('A', finalLayout(row.a_layouts), row.a_preview);
    const b = judgeInput('B', finalLayout(row.b_layouts), row.b_preview);
    const order = row.order_swapped ? 'BA' : 'AB';

    let res;
    try {
      res = await evaluatePairOrder(a, b, order as 'AB' | 'BA', { model: CHEAP_MODEL });
    } catch (err: any) {
      console.error(`  [${i + 1}/${rows.length}] ${row.id.slice(0, 8)} FAILED: ${err?.message || err}`);
      continue;
    }

    cheapCost += res.receipt.costUsd;
    baselineCost += Number(row.verdict?.receipt?.costUsd || 0);

    for (const dim of JUDGE_DIMENSIONS) {
      const base = row.verdict?.votes?.[dim];
      const cheap = res.votes[dim];
      if (!base) continue;
      perDimension[dim] ||= { agree: 0, total: 0 };
      perDimension[dim].total++;
      dimsTotal++;
      if (base === cheap) {
        perDimension[dim].agree++;
        dimsAgree++;
      } else {
        disagreements.push({ id: row.id.slice(0, 8), dim, baseline: base, cheap: cheap ?? 'none' });
      }
    }
    const sameWinner = row.verdict?.majorityWinner === res.majorityWinner;
    if (sameWinner) winnersAgree++;
    console.error(
      `  [${i + 1}/${rows.length}] ${row.id.slice(0, 8)} winner ${row.verdict?.majorityWinner}->${res.majorityWinner} ` +
        `${sameWinner ? 'same' : 'DIFFERENT'} ($${res.receipt.costUsd.toFixed(5)})`
    );
  }

  return {
    comparisons: rows.length,
    winnerAgreementPct: rows.length ? (100 * winnersAgree) / rows.length : 0,
    dimensionAgreementPct: dimsTotal ? (100 * dimsAgree) / dimsTotal : 0,
    perDimension: Object.fromEntries(
      Object.entries(perDimension).map(([d, v]) => [d, `${((100 * v.agree) / v.total).toFixed(0)}% (${v.agree}/${v.total})`])
    ),
    cheapCostUsd: Number(cheapCost.toFixed(5)),
    baselineCostUsd: Number(baselineCost.toFixed(5)),
    disagreements,
  };
}

/**
 * The canary has a known right answer, so it measures the cheap judge on its own, with no expensive
 * baseline and no prompt confound. A layout is pitted against a degraded copy of itself; the intact
 * one must win, in both presentation orders.
 */
async function canary(rows: StoredJudgment[]) {
  let passed = 0;
  let orderConsistent = 0;
  let attempted = 0;
  let cost = 0;
  const failures: string[] = [];

  // One canary per distinct candidate layout, deduplicated by run so the sample spans runs.
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.run_id)) continue;
    seen.add(row.run_id);

    const good = finalLayout(row.a_layouts);
    const degraded = createDegradedCanaryLayout(good);
    const goodIn = judgeInput('chosen', good, row.a_preview);
    const badIn = judgeInput('canary', degraded, renderLayoutV2(degraded, {}).png);

    attempted++;
    try {
      const ab = await evaluatePairOrder(goodIn, badIn, 'AB', { model: CHEAP_MODEL });
      const ba = await evaluatePairOrder(badIn, goodIn, 'BA', { model: CHEAP_MODEL });
      cost += ab.receipt.costUsd + ba.receipt.costUsd;
      const consistent = ab.winnerCandidateId === ba.winnerCandidateId;
      if (consistent) orderConsistent++;
      const caught = ab.winnerCandidateId === 'chosen' && ba.winnerCandidateId === 'chosen';
      if (caught) passed++;
      else failures.push(`${row.run_id.slice(0, 8)}: AB->${ab.winnerCandidateId}, BA->${ba.winnerCandidateId}`);
      console.error(`  canary ${row.run_id.slice(0, 8)} ${caught ? 'PASS' : 'FAIL'} (AB ${ab.winnerCandidateId}, BA ${ba.winnerCandidateId})`);
    } catch (err: any) {
      failures.push(`${row.run_id.slice(0, 8)}: ERROR ${err?.message || err}`);
    }
  }

  return {
    attempted,
    passed,
    passRatePct: attempted ? (100 * passed) / attempted : 0,
    orderConsistentPct: attempted ? (100 * orderConsistent) / attempted : 0,
    costUsd: Number(cost.toFixed(5)),
    failures,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
  const rows = await load();
  if (!rows.length) throw new Error(`No replayable gpt-6-astra pairwise judgments in ${COSTLAB_DB}`);
  console.error(`Replaying ${rows.length} stored comparisons against ${CHEAP_MODEL}\n`);

  const out: any = { cheapModel: CHEAP_MODEL, baselineModel: 'gpt-6-astra' };
  if (!CANARY_ONLY) {
    console.error('AGREEMENT');
    out.agreement = await agreement(rows);
  }
  console.error('\nCANARY (known right answer)');
  out.canary = await canary(rows);

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
