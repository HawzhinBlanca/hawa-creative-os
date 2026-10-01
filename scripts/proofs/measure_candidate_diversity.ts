/**
 * Measures how different the three candidates for one brief actually are.
 *
 * The prompt demands three distinct archetypes from a list of fourteen, and the production run's
 * winners were 16-of-20 monolith_centered with fifteen of twenty judge pairs splitting 3-2. Those
 * facts are consistent with diverse candidates of equal merit AND with near-identical candidates,
 * and the run did not record the pairwise distances, so this measures it directly.
 */
import {
  generateLayoutCandidatesV3,
  ExemplarRetrievalIndex,
  retrieveExemplarsV3,
  OpenAiStudioClient,
  evaluateDesignMetrics,
} from '../../packages/creative/dist/index.js';
import { QUALIFICATION_BRIEFS } from '../run_p10_qualification.js';

const wanted = process.argv.slice(2);
const briefs = wanted.length
  ? QUALIFICATION_BRIEFS.filter((b) => wanted.includes(b.id))
  : QUALIFICATION_BRIEFS.slice(0, 3);

const client = new OpenAiStudioClient({ timeoutMs: 240000 });
const index = new ExemplarRetrievalIndex();

for (const brief of briefs) {
  // The index takes a query object; this used to pass (text, width, height), so the text
  // was dropped and every brief retrieved the same exemplars.
  const retrieval = { retrievedExemplars: retrieveExemplarsV3({ text: `${brief.name} ${brief.copyBlocks.map((c) => c.text).join(' ')}`, width: brief.width, height: brief.height }, index) };
  const gen = await generateLayoutCandidatesV3({
    client,
    brief: `${brief.name}: ${brief.copyBlocks.map((c) => c.text).join(' - ')}`,
    copyBlocks: brief.copyBlocks.map((c) => ({
      index: c.copyIndex, text: c.text, role: c.role as any, script: c.script as any,
    })),
    palette: ['#0A1628', '#F7B500', '#1E3A5F', '#FDF8F3'],
    canvasWidth: brief.width,
    canvasHeight: brief.height,
    exemplars: retrieval.retrievedExemplars,
    isRtl: brief.language === 'ckb',
  });

  const archetypes = gen.rawCandidates.map((c: any) => c.compositionArchetype);
  const scores = gen.layouts.map((l) => evaluateDesignMetrics(l).compositeScore);
  const d = gen.degeneracyCheck;
  console.log(`${brief.id}`);
  console.log(`  archetypes:        ${JSON.stringify(archetypes)}`);
  console.log(`  distinct:          ${new Set(archetypes).size} of ${archetypes.length}`);
  console.log(`  pairwise distance: ${JSON.stringify(d.pairwiseDistances)}px  degenerate=${d.isDegenerate}`);
  console.log(`  composite scores:  ${JSON.stringify(scores.map((s) => Number(s.toFixed(3))))}`);
  console.log(`  score spread:      ${(Math.max(...scores) - Math.min(...scores)).toFixed(4)}`);
}
