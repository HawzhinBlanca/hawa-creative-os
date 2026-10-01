/** Local palette-decision cost/equivalence, not a pipeline SLO or aesthetic comparison. */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { declaredColorContrast, declaredColorContrastEvaluator } from '../../packages/creative/dist/studio/composite-contrast.js';

const palette = ['#000000', '#FFFFFF', '#666666', '#787878', '#F7B500', '#0000FF', '#FFFF00'];
const layout = { width: 800, height: 1000, background: { color: '#000000', field: {
  kind: 'linear', direction: 'to-bottom', stops: [{ at: 0, color: '#000000' },
    { at: .3, color: '#FFFFFF' }, { at: .7, color: '#0000FF' }, { at: 1, color: '#FFFF00' }],
} }, shapes: [], overlays: [] };
function measure(fn) {
  for (let i = 0; i < 200; i++) fn();
  const batches = [];
  for (let batch = 0; batch < 9; batch++) {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) fn();
    batches.push((performance.now() - start) / 1000);
  }
  return { batchesMsPerDecision: batches, medianMsPerDecision: [...batches].sort((a, b) => a - b)[4] };
}
const cases = [];
for (const box of [{ x: 60, y: 20, width: 680, height: 40 }, { x: 0, y: 0, width: 800, height: 1000 }]) {
  const repeated = () => palette.map(color => declaredColorContrast(layout, box, color));
  const shared = () => { const on = declaredColorContrastEvaluator(layout, box); return palette.map(on); };
  const expected = repeated(), actual = shared();
  if (actual.some((score, i) => score !== expected[i])) throw Error('Palette decision equivalence failed');
  cases.push({ box, exactScoresEqual: true, scores: actual, repeated: measure(repeated), shared: measure(shared) });
}
const proof = { observedAt: new Date().toISOString(), layout, palette, cases,
  providerCalls: 0, dependenciesAdded: 0, persistentCachesAdded: 0,
  fieldEnclosuresPerSevenColorDecision: { repeated: 7, shared: 1 },
  limits: ['Warm local helper timings; not pipeline latency, an SLO, or professional/human preference evidence.',
    'Comparator repeats the same correct spatial authority; no speed claim against the older incorrect flat-color repair.'] };
writeFileSync(new URL('../../plans/content-aware-design-2026-09-30/W5_SPATIAL_INK_BENCHMARK.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(cases.map(c => ({ exactScoresEqual: c.exactScoresEqual,
  repeatedMs: c.repeated.medianMsPerDecision, sharedMs: c.shared.medianMsPerDecision }))));
