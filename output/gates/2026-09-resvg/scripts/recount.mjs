#!/usr/bin/env node
/**
 * Re-counts resvg's warnings exactly. The gate run (render.mjs --tag container) kept only the first
 * 2,000 characters of each render's stderr, so the warning catalogue in summary.json is a lower
 * bound for the 9 canvases whose stderr was longer. This reads a second run of just the warned
 * canvases, with stderr kept whole:
 *
 *   docker run --rm -v <work>:/work -v <scripts>:/gate:ro hawa-resvg-gate:0.48.1 \
 *     node /gate/render.mjs --work /work --tag recount --kinds canvas --renderers resvg \
 *     --canvas-reps 1 --time none --only '<ids of the warned canvases>'
 *   node recount.mjs --work <work> --out output/gates/2026-09-resvg
 *
 * It checks that each re-render's PNG is byte-identical to the gate run's (so the warnings belong to
 * the same drawing), normalises each warning as analyse.ts does, and writes warning-recount.json.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const work = arg('--work');
const out = arg('--out');
if (!work || !out) throw new Error('--work <dir> --out <dir> are required');

const read = (tag) =>
  fs
    .readFileSync(path.join(work, 'out', tag, 'results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((r) => r.rep !== 'warm');
const gate = new Map(read('container').filter((r) => r.renderer === 'resvg' && r.rep === 1).map((r) => [r.job, r]));
const again = read('recount');

const catalogue = {};
const perCanvas = [];
let hashMismatch = 0;
let truncatedBefore = 0;
for (const r of again) {
  const g = gate.get(r.job);
  if (!g || g.sha256 !== r.sha256) hashMismatch++;
  if (g && g.stderr.length >= 2000) truncatedBefore++;
  const lines = r.stderr.split('\n').filter(Boolean);
  for (const line of lines) {
    // The same key as analyse.ts's warningCatalogue.
    const key = `resvg: ${line.replace(/[^\s]\/U\+[0-9A-F]+/g, '<char>').replace(/\d+/g, 'N').slice(0, 160)}`;
    catalogue[key] = (catalogue[key] ?? 0) + 1;
  }
  perCanvas.push({
    job: r.job,
    missingCharacter: lines.filter((l) => /No fonts with/.test(l)).length,
    fallback: lines.filter((l) => /Fallback from/.test(l)).length,
    other: lines.filter((l) => !/No fonts with|Fallback from/.test(l)).length,
  });
}

const result = {
  canvases: again.length,
  pngIdenticalToGateRun: again.length - hashMismatch,
  truncatedInGateRun: truncatedBefore,
  canvasesWithMissingCharacter: perCanvas.filter((c) => c.missingCharacter > 0).length,
  canvasesWithFallbackOnly: perCanvas.filter((c) => c.missingCharacter === 0 && c.fallback > 0 && c.other === 0).length,
  catalogue: Object.fromEntries(Object.entries(catalogue).sort((a, b) => b[1] - a[1])),
  perCanvas,
};
fs.writeFileSync(path.join(out, 'warning-recount.json'), JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ ...result, perCanvas: undefined }, null, 2));
