/**
 * Verifies the two clustered spacing fixes against the eighteen real T5 layouts, with no model
 * calls: applies the committed normalisations to each saved layout in the same order the generator
 * runs them — centerLoneTextInPanels then centerSeparatorsInGaps, since moving a text block changes
 * the gaps a separator sits in — and reports the deterministic design metrics before and after.
 *
 * The saved layouts were generated before the fix, so this is a fix-verification pass over
 * existing data. It is NOT a qualification run and its output is kept out of the proof set.
 *
 * Usage (from the repo root):
 *   node scripts/proofs/verify_spacing_fixes.mjs <briefsDir> [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';

const gen = await import('../../packages/creative/dist/studio/layout-generator-v3.js');
const metrics = await import('../../packages/creative/dist/studio/design-metrics.js');
const { normalizeLayoutGeometry, findAsymmetricSeparators, verifySlotCapacity } = gen;
const { evaluateDesignMetrics } = metrics;

const briefsDir = process.argv[2];
const outDir = process.argv[3];
if (!briefsDir) {
  console.error('usage: verify_spacing_fixes.mjs <briefsDir> [outDir]');
  process.exit(2);
}
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const rows = [];
let movedTotal = 0;

for (const name of fs.readdirSync(briefsDir).sort()) {
  const layoutPath = path.join(briefsDir, name, 'layout.json');
  if (!fs.existsSync(layoutPath)) continue;
  const before = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const after = JSON.parse(JSON.stringify(before));

  const mBefore = evaluateDesignMetrics(before);
  const geo = normalizeLayoutGeometry(after);
  const textCentred = geo.textCentred;
  const moved = geo.separators;
  const drifted = geo.drifted;
  const marginBalanced = geo.marginBalanced;
  const residual = findAsymmetricSeparators(after.shapes, after.text).length;

  // The copy still has to fit every box after normalisation.
  const briefPathForCopy = path.join(briefsDir, name, 'brief.json');
  let capacityOk = null;
  if (fs.existsSync(briefPathForCopy)) {
    const brief = JSON.parse(fs.readFileSync(briefPathForCopy, 'utf8'));
    capacityOk = verifySlotCapacity(
      after,
      (brief.copyBlocks || []).map((b) => ({
        index: b.copyIndex,
        text: b.text,
        role: b.role,
        script: b.script,
      }))
    ).ok;
  }
  const mAfter = evaluateDesignMetrics(after);
  movedTotal += moved;

  const score = (m, k) => m.metrics?.[k]?.score;
  rows.push({
    brief: name,
    separatorsMoved: moved,
    textCentred,
    drifted,
    marginBalanced,
    capacityOk,
    residual,
    composite: { before: mBefore.compositeScore, after: mAfter.compositeScore },
    whitespace: { before: score(mBefore, 'negativeSpace'), after: score(mAfter, 'negativeSpace') },
    alignment: { before: score(mBefore, 'alignment'), after: score(mAfter, 'alignment') },
    balance: { before: score(mBefore, 'balance'), after: score(mAfter, 'balance') },
    regularity: { before: score(mBefore, 'regularity'), after: score(mAfter, 'regularity') },
    passed: { before: mBefore.passed, after: mAfter.passed },
  });

  if (outDir) {
    fs.mkdirSync(path.join(outDir, name), { recursive: true });
    fs.writeFileSync(path.join(outDir, name, 'layout.json'), JSON.stringify(after, null, 2));
    const briefPath = path.join(briefsDir, name, 'brief.json');
    if (fs.existsSync(briefPath)) fs.copyFileSync(briefPath, path.join(outDir, name, 'brief.json'));
  }
}

const f = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n));
console.log(
  `${'brief'.padEnd(9)} ${'drf'.padStart(4)} ${'txt'.padStart(4)} ${'sep'.padStart(4)} ${'mgn'.padStart(4)} ${'composite'.padStart(16)} ${'negativeSpace'.padStart(16)}`
);
for (const r of rows) {
  const arrow = (b, a) => `${f(b)}->${f(a)}${a > b ? ' +' : a < b ? ' -' : '  '}`;
  console.log(
    `${r.brief.padEnd(9)} ${String(r.drifted).padStart(4)} ${String(r.textCentred).padStart(4)} ` +
      `${String(r.separatorsMoved).padStart(4)} ${String(r.marginBalanced).padStart(4)} ` +
      `${arrow(r.composite.before, r.composite.after).padStart(16)} ` +
      `${arrow(r.whitespace.before, r.whitespace.after).padStart(16)}`
  );
}

const mean = (k) => rows.reduce((a, r) => a + (r[k].after ?? 0) - (r[k].before ?? 0), 0) / rows.length;
const textTotal = rows.reduce((a, r) => a + r.textCentred, 0);
const residualTotal = rows.reduce((a, r) => a + r.residual, 0);
console.log(
  `\nlayouts: ${rows.length} | drifted blocks snapped: ${rows.reduce((a, r) => a + r.drifted, 0)}` +
    ` | text centred in panel: ${textTotal} | separators recentred: ${movedTotal}` +
    ` | compositions margin-balanced: ${rows.reduce((a, r) => a + r.marginBalanced, 0)}`
);
console.log(`asymmetric separators left after normalisation: ${residualTotal}`);
const capFail = rows.filter((r) => r.capacityOk === false).map((r) => r.brief);
console.log(
  capFail.length
    ? `SLOT CAPACITY REGRESSED on: ${capFail.join(', ')}`
    : 'every layout still passes slot capacity after fitting'
);
for (const k of ['composite', 'whitespace', 'alignment', 'balance', 'regularity']) {
  const d = mean(k);
  console.log(`mean ${k.padEnd(11)} change ${d >= 0 ? '+' : ''}${d.toFixed(4)}`);
}
const regressed = rows.filter((r) => r.composite.after < r.composite.before);
console.log(regressed.length ? `composite regressed on: ${regressed.map((r) => r.brief).join(', ')}` : 'no layout regressed on composite score');
if (outDir) console.log(`adjusted layouts written to ${outDir}`);
