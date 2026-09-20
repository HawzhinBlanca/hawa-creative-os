/**
 * What does thinking harder at the layout stage actually buy, and what does it cost?
 *
 * The layout call invents the three compositions; everything after it selects, repairs and
 * transfers what this stage imagined. It was asking for `reasoning_effort: 'low'`, the cheapest
 * setting the model offers — not chosen on the merits, but inherited from a fallback written so
 * that callers who cannot know which tier will answer do not send a parameter the cheap models
 * reject. Raising it is a one-line change, so the only real question is whether the designs get
 * better and by how much the bill moves. Both were assumptions until this script.
 *
 * Runs the same briefs through the same model at each effort, with identical inputs, and reports
 * the deterministic metrics the pipeline itself ranks on, the spread between candidates (three
 * near-identical layouts are worth less than three distinct ones), tokens, cost and latency. It
 * also writes each winning layout and its render, because a composite score is not a design and
 * the point of the exercise is designs.
 *
 * This costs real money at production rates — roughly $0.20-$0.30 per brief per effort. Keep the
 * brief list short.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx scripts/experiments/layout-reasoning-effort.ts <outDir> [briefIds...]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  generateLayoutCandidatesV3,
  normalizeLayoutGeometry,
  evaluateDesignMetrics,
  ExemplarRetrievalIndex,
  retrieveExemplarsV3,
  OpenAiStudioClient,
  renderLayoutV2,
  type StudioLayoutV2,
} from '../../packages/creative/dist/index.js';
import { QUALIFICATION_BRIEFS } from '../run_p10_qualification.js';

const EFFORTS = ['low', 'medium', 'high'] as const;
const PALETTE = ['#0A1628', '#C5A059', '#1E3A5F', '#FDF8F3'];

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: layout-reasoning-effort.ts <outDir> [briefIds...]');
  process.exit(2);
}
const wanted = process.argv.slice(3);
// Two briefs by default, one Latin and one Sorani: effort could plausibly help more on the
// right-to-left layout, where the model has more to get wrong.
const briefs = wanted.length
  ? QUALIFICATION_BRIEFS.filter((b: any) => wanted.includes(b.id))
  : [QUALIFICATION_BRIEFS[0], QUALIFICATION_BRIEFS[6]];

fs.mkdirSync(outDir, { recursive: true });
const client = new OpenAiStudioClient({ timeoutMs: 300000 });
const retrievalIndex = new ExemplarRetrievalIndex();

/** How far apart the three candidates are: mean pairwise distance of their text-box geometry. */
function candidateSpread(layouts: StudioLayoutV2[]): number {
  if (layouts.length < 2) return 0;
  const vec = (l: StudioLayoutV2) => l.text.flatMap((t) => [t.x, t.y, t.width, t.height, t.fontSize]);
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < layouts.length; i++) {
    for (let j = i + 1; j < layouts.length; j++) {
      const a = vec(layouts[i]);
      const b = vec(layouts[j]);
      const n = Math.min(a.length, b.length);
      if (!n) continue;
      let sum = 0;
      for (let k = 0; k < n; k++) sum += Math.abs(a[k] - b[k]);
      total += sum / n;
      pairs++;
    }
  }
  return pairs ? Number((total / pairs).toFixed(1)) : 0;
}

interface Row {
  brief: string;
  effort: string;
  ok: boolean;
  error?: string;
  candidates?: number;
  bestComposite?: number;
  meanComposite?: number;
  allPassed?: number;
  spread?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

const rows: Row[] = [];

for (const brief of briefs as any[]) {
  const slotInputs = brief.copyBlocks.map((c: any) => ({
    index: c.copyIndex,
    text: c.text,
    role: c.role,
    script: c.script as 'latin' | 'arabic',
  }));
  const retrieval = retrieveExemplarsV3(
    {
      text: `${brief.name} ${brief.copyBlocks.map((c: any) => c.text).join(' ')}`,
      width: brief.width,
      height: brief.height,
    },
    retrievalIndex
  );
  const copyText = Object.fromEntries(brief.copyBlocks.map((c: any) => [c.copyIndex, c.text]));

  for (const effort of EFFORTS) {
    // The stage reads this itself, so the experiment moves exactly the one thing under test and
    // every other input stays byte-identical between arms.
    process.env.HAWA_LAYOUT_REASONING_EFFORT = effort;
    const started = Date.now();
    try {
      const gen = await generateLayoutCandidatesV3({
        client,
        brief: `${brief.name}: ${brief.copyBlocks.map((c: any) => c.text).join(' - ')}`,
        copyBlocks: slotInputs,
        palette: PALETTE,
        canvasWidth: brief.width,
        canvasHeight: brief.height,
        exemplars: retrieval,
        isRtl: brief.language === 'ckb',
      });

      const scored = gen.layouts.map((layout: StudioLayoutV2) => {
        normalizeLayoutGeometry(layout as any);
        return { layout, metrics: evaluateDesignMetrics(layout) };
      });
      scored.sort((a, b) => b.metrics.compositeScore - a.metrics.compositeScore);

      const dir = path.join(outDir, `${brief.id}__${effort}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(scored[0].layout, null, 2));
      try {
        fs.writeFileSync(path.join(dir, 'winner.png'), renderLayoutV2(scored[0].layout, { copyText }).png);
      } catch (err) {
        fs.writeFileSync(path.join(dir, 'render-failed.txt'), String(err));
      }

      rows.push({
        brief: brief.id,
        effort,
        ok: true,
        candidates: gen.layouts.length,
        bestComposite: Number(scored[0].metrics.compositeScore.toFixed(4)),
        meanComposite: Number(
          (scored.reduce((s, x) => s + x.metrics.compositeScore, 0) / scored.length).toFixed(4)
        ),
        allPassed: scored.filter((x) => x.metrics.passed).length,
        spread: candidateSpread(gen.layouts),
        inputTokens: gen.inputTokens,
        outputTokens: (gen as any).outputTokens,
        costUsd: (gen as any).costUsd,
        latencyMs: Date.now() - started,
      });
    } catch (err: any) {
      // A truncated reply is the failure mode that matters here: reasoning tokens bill as output
      // and count against max_completion_tokens, so a long think can starve the JSON.
      rows.push({ brief: brief.id, effort, ok: false, error: err?.message || String(err), latencyMs: Date.now() - started });
    }
    console.error(`  ${brief.id} @ ${effort}: ${JSON.stringify(rows[rows.length - 1])}`);
  }
}

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2));

console.log('\nbrief                effort  best    mean    passed  spread  out_tok  cost      ms');
for (const r of rows) {
  if (!r.ok) {
    console.log(`${r.brief.padEnd(20)} ${r.effort.padEnd(7)} FAILED: ${r.error}`);
    continue;
  }
  console.log(
    `${r.brief.padEnd(20)} ${r.effort.padEnd(7)} ${String(r.bestComposite).padEnd(7)} ` +
      `${String(r.meanComposite).padEnd(7)} ${String(r.allPassed).padEnd(7)} ${String(r.spread).padEnd(7)} ` +
      `${String(r.outputTokens ?? '?').padEnd(8)} $${String((r.costUsd ?? 0).toFixed(4)).padEnd(8)} ${r.latencyMs}`
  );
}
const total = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
console.log(`\ntotal spent: $${total.toFixed(4)}`);
