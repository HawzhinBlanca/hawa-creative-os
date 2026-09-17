/**
 * Compares layout-generation quality across models, so the dev tier is chosen on evidence rather
 * than on price alone. Layout generation is where the composition is invented, so a model that is
 * cheap but weak here produces bad designs no amount of downstream critique recovers.
 *
 * Runs the same briefs through each model with identical inputs, applies the same normalisations,
 * and reports the deterministic metrics, the candidate spread, cost and latency. Renders the best
 * candidate per model so the output can be looked at rather than inferred from a score.
 *
 * Usage:
 *   OPENAI_API_KEY=... pnpm tsx scripts/proofs/compare_layout_models.ts <outDir> [briefIds...]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  generateLayoutCandidatesV3,
  normalizeLayoutGeometry,
  evaluateDesignMetrics,
  ExemplarRetrievalIndex,
  OpenAiStudioClient,
  renderLayoutV2,
  type StudioLayoutV2,
} from '../../packages/creative/dist/index.js';
import { QUALIFICATION_BRIEFS } from '../run_p10_qualification.js';

// gpt-6-astra is deliberately absent: a production-model baseline for these briefs already
// exists on disk and has been paid for. Re-generating it would spend production rates to learn
// nothing new.
const CANDIDATE_MODELS = ['o4-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];
const BASELINE_DIR =
  'output/proofs/2026-09-17-research-grade-pipeline/T5_FULL_QUALIFICATION/briefs';
const PALETTE = ['#0A1628', '#C5A059', '#1E3A5F', '#FDF8F3'];

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: compare_layout_models.ts <outDir> [briefIds...]');
  process.exit(2);
}
const wanted = process.argv.slice(3);
const briefs = wanted.length
  ? QUALIFICATION_BRIEFS.filter((b) => wanted.includes(b.id))
  : [QUALIFICATION_BRIEFS[0], QUALIFICATION_BRIEFS[6]];

fs.mkdirSync(outDir, { recursive: true });

const client = new OpenAiStudioClient({ timeoutMs: 240000 });
const retrievalIndex = new ExemplarRetrievalIndex();

interface Row {
  brief: string;
  model: string;
  ok: boolean;
  error?: string;
  candidates?: number;
  bestComposite?: number;
  meanComposite?: number;
  allPassed?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  responseId?: string;
  modelEchoed?: string;
}

const rows: Row[] = [];

for (const brief of briefs) {
  const slotInputs = brief.copyBlocks.map((c) => ({
    index: c.copyIndex,
    text: c.text,
    role: c.role as any,
    script: c.script as 'latin' | 'arabic',
  }));
  const retrieval = retrievalIndex.retrieveTopExemplars(
    `${brief.name} ${brief.copyBlocks.map((c) => c.text).join(' ')}`,
    brief.width,
    brief.height
  );
  const copyText = Object.fromEntries(brief.copyBlocks.map((c) => [c.copyIndex, c.text]));

  for (const model of CANDIDATE_MODELS) {
    const started = Date.now();
    try {
      const gen = await generateLayoutCandidatesV3({
        client,
        brief: `${brief.name}: ${brief.copyBlocks.map((c) => c.text).join(' - ')}`,
        copyBlocks: slotInputs,
        palette: PALETTE,
        canvasWidth: brief.width,
        canvasHeight: brief.height,
        exemplars: retrieval.retrievedExemplars,
        isRtl: brief.language === 'ckb',
        model,
      });

      const scored = gen.layouts.map((layout: StudioLayoutV2) => {
        normalizeLayoutGeometry(layout as any);
        return { layout, metrics: evaluateDesignMetrics(layout) };
      });
      scored.sort((a, b) => b.metrics.compositeScore - a.metrics.compositeScore);

      const dir = path.join(outDir, `${brief.id}__${model.replace(/[^a-z0-9.]/gi, '_')}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(scored[0].layout, null, 2));
      fs.writeFileSync(
        path.join(dir, 'brief.json'),
        JSON.stringify({ id: brief.id, copyBlocks: brief.copyBlocks }, null, 2)
      );
      try {
        const rendered = renderLayoutV2(scored[0].layout, { copyText });
        fs.writeFileSync(path.join(dir, 'preview.png'), rendered.png);
      } catch (e: any) {
        console.warn(`  render failed for ${brief.id}/${model}: ${e.message}`);
      }

      rows.push({
        brief: brief.id,
        model,
        ok: true,
        candidates: gen.layouts.length,
        bestComposite: scored[0].metrics.compositeScore,
        meanComposite:
          scored.reduce((a, x) => a + x.metrics.compositeScore, 0) / scored.length,
        allPassed: scored.filter((x) => x.metrics.passed).length,
        inputTokens: gen.inputTokens,
        cachedTokens: gen.cachedTokens,
        outputTokens: gen.outputTokens,
        costUsd: client.calculateCost(model, {
          prompt_tokens: gen.inputTokens,
          completion_tokens: gen.outputTokens,
          prompt_tokens_details: { cached_tokens: gen.cachedTokens },
        }),
        latencyMs: Date.now() - started,
        responseId: gen.responseId,
      });
      const r = rows[rows.length - 1];
      console.log(
        `${brief.id.padEnd(24)} ${model.padEnd(14)} cands ${r.candidates} ` +
          `best ${r.bestComposite!.toFixed(3)} mean ${r.meanComposite!.toFixed(3)} ` +
          `passed ${r.allPassed}/${r.candidates} $${r.costUsd!.toFixed(6)} ${r.latencyMs}ms`
      );
    } catch (e: any) {
      rows.push({ brief: brief.id, model, ok: false, error: e.message, latencyMs: Date.now() - started });
      console.log(`${brief.id.padEnd(24)} ${model.padEnd(14)} FAILED: ${String(e.message).slice(0, 110)}`);
    }
  }
}

fs.writeFileSync(path.join(outDir, 'COMPARISON.json'), JSON.stringify({ rows }, null, 2));

console.log('\nper model, across the briefs run:');
for (const model of CANDIDATE_MODELS) {
  const mine = rows.filter((r) => r.model === model);
  const ok = mine.filter((r) => r.ok);
  if (ok.length === 0) {
    console.log(`  ${model.padEnd(14)} no successful run (${mine[0]?.error?.slice(0, 80) ?? 'unknown'})`);
    continue;
  }
  const mean = (f: (r: Row) => number) => ok.reduce((a, r) => a + f(r), 0) / ok.length;
  console.log(
    `  ${model.padEnd(14)} ok ${ok.length}/${mine.length}  mean best-composite ${mean((r) => r.bestComposite!).toFixed(4)}` +
      `  mean cost $${mean((r) => r.costUsd!).toFixed(6)}  mean latency ${Math.round(mean((r) => r.latencyMs!))}ms`
  );
}
// Baseline: the production-model layouts already on disk for these same briefs, scored the same way.
const baseline: Record<string, number> = {};
for (const brief of briefs) {
  const idx = QUALIFICATION_BRIEFS.findIndex((b) => b.id === brief.id) + 1;
  const p = path.join(BASELINE_DIR, `brief_${String(idx).padStart(2, '0')}`, 'layout.json');
  if (!fs.existsSync(p)) continue;
  const layout = JSON.parse(fs.readFileSync(p, 'utf8'));
  normalizeLayoutGeometry(layout);
  baseline[brief.id] = evaluateDesignMetrics(layout).compositeScore;
}

if (Object.keys(baseline).length) {
  const baseMean =
    Object.values(baseline).reduce((a, b) => a + b, 0) / Object.values(baseline).length;
  console.log(`\nproduction baseline (gpt-6-astra layouts already on disk): composite ${baseMean.toFixed(4)}`);
  console.log('against it:');
  for (const model of CANDIDATE_MODELS) {
    const ok = rows.filter((r) => r.model === model && r.ok && baseline[r.brief] !== undefined);
    if (!ok.length) continue;
    const q = ok.reduce((a, r) => a + r.bestComposite! - baseline[r.brief], 0) / ok.length;
    const c = ok.reduce((a, r) => a + r.costUsd!, 0) / ok.length;
    console.log(
      `  ${model.padEnd(14)} composite ${q >= 0 ? '+' : ''}${q.toFixed(4)}  mean layout cost $${c.toFixed(6)}`
    );
  }
}
