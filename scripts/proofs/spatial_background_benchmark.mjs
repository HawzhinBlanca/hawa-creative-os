/** Local declared-surface cost only. No provider, DB, shipping qualification or taste claim. */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { backgroundFieldLuminanceBounds, backgroundFieldRgbBounds } from '../../packages/creative/dist/studio/background-field.js';
import { rgbToLuminance } from '../../packages/creative/dist/studio/luminance.js';

const field = { kind: 'linear', direction: 'to-bottom', stops: [
  { at: 0, color: '#000000' }, { at: .3, color: '#FFFFFF' },
  { at: .7, color: '#0000FF' }, { at: 1, color: '#FFFF00' },
] };
const localBox = { x: 60, y: 20, width: 680, height: 40 };
const fullBox = { x: 0, y: 0, width: 800, height: 1000 };
const previous = () => {
  const bounds = backgroundFieldRgbBounds(field);
  return { min: rgbToLuminance(...bounds.min), max: rgbToLuminance(...bounds.max) };
};
const local = () => backgroundFieldLuminanceBounds(field, 800, 1000, localBox);
const worstExtent = () => backgroundFieldLuminanceBounds(field, 800, 1000, fullBox);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(fn) {
  for (let i = 0; i < 200; i++) fn();
  const batches = [];
  for (let batch = 0; batch < 9; batch++) {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) fn();
    batches.push((performance.now() - start) / 1000);
  }
  return { batches, medianMsPerEvaluation: median(batches) };
}
const proof = { observedAt: new Date().toISOString(), fixture: { field, localBox, fullBox },
  previousWholeCanvasBounds: previous(), localBounds: local(), wholeFootprintBounds: worstExtent(),
  measurements: { previousWholeCanvas: measure(previous), localFootprint: measure(local),
    maximumStopFootprint: measure(worstExtent) },
  boundedSubintervals: 96, providerCalls: 0, dependenciesAdded: 0,
  limitations: ['Warm local helper measurements, not pipeline latency or a production SLO.',
    'Extra local computation buys spatial conservative accuracy; no speed improvement is claimed.',
    'This does not establish native Canva fidelity, human preference or superiority.'] };
writeFileSync(new URL('../../plans/content-aware-design-2026-09-30/W5_SPATIAL_BACKGROUND_BENCHMARK.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ previousMs: proof.measurements.previousWholeCanvas.medianMsPerEvaluation,
  localMs: proof.measurements.localFootprint.medianMsPerEvaluation,
  maximumStopMs: proof.measurements.maximumStopFootprint.medianMsPerEvaluation, providerCalls: 0 }));
