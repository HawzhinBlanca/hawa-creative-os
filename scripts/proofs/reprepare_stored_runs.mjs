#!/usr/bin/env node
/**
 * Re-prepares every stored design of one or more qualification runs with the current preparation
 * and reports production's hard QA and the design metrics, before and after. No model calls.
 *
 * The regression gate for any change to preparation (`prepareGeneratedLayoutV3`): run it over every
 * stored run before paying for a new one. On 2026-09-18 it found every mechanical QA failure left in
 * 140 stored designs, each of which became a regression test.
 *
 *   pnpm --filter @hawa/creative build
 *   node scripts/proofs/reprepare_stored_runs.mjs output/proofs/<run> [...]
 *
 * Exits 1 if preparation makes a shippable design worse: a design that passed QA before and fails
 * after, or one that passes QA after with a design metric it did not fail before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const c = await import(path.join(root, 'packages/creative/dist/index.js'));
const reference = c.studioReferenceFromRaw(
  JSON.parse(fs.readFileSync(path.join(root, 'packages/creative/assets/kaae-reference.json'), 'utf8'))
);
// The official logo's width over height, from its PNG header, as the studio computes it.
const logoPng = fs.readFileSync(path.join(root, 'packages/creative/assets/logos/kaae-official-logo.png'));
const logoAspect = logoPng.readUInt32BE(16) / (logoPng.readUInt32BE(20) || 1);

const runs = process.argv.slice(2);
if (!runs.length) {
  console.error('usage: node scripts/proofs/reprepare_stored_runs.mjs <runDir> [...]');
  process.exit(2);
}

let regressions = 0;
for (const run of runs) {
  const briefsDir = path.join(run, 'briefs');
  if (!fs.existsSync(briefsDir)) {
    console.error(`${run}: no briefs directory`);
    process.exit(2);
  }
  const tally = { n: 0, qaBefore: 0, qaAfter: 0, bothAfter: 0 };
  const remaining = {};
  const lines = [];
  for (const id of fs.readdirSync(briefsDir).sort()) {
    const layoutPath = path.join(briefsDir, id, 'layout.json');
    const briefPath = path.join(briefsDir, id, 'brief.json');
    if (!fs.existsSync(layoutPath) || !fs.existsSync(briefPath)) continue;
    const raw = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    const text = {};
    const scripts = {};
    const copyScripts = [];
    for (const block of brief.copyBlocks) {
      text[block.copyIndex] = block.text;
      scripts[block.copyIndex] = block.script;
      copyScripts[block.copyIndex] = block.script;
    }
    const copy = { text, scripts };
    const qaContext = {
      width: raw.width,
      height: raw.height,
      copyScripts,
      latinFont: reference.latinFont,
      arabicFont: reference.arabicFont,
      palette: reference.palette,
      logoAspect,
    };
    const judge = (layout) => ({ metrics: c.measureDesignV3(layout, copy), qa: c.evaluateHardQa(layout, qaContext) });
    const before = judge(JSON.parse(JSON.stringify(raw)));
    const prepared = c.prepareGeneratedLayoutV3(JSON.parse(JSON.stringify(raw)), copy, {
      width: raw.width,
      height: raw.height,
      logoAspect,
      palette: reference.palette,
    });
    const after = judge(prepared);

    tally.n++;
    if (before.qa.passed) tally.qaBefore++;
    if (after.qa.passed) tally.qaAfter++;
    if (after.qa.passed && after.metrics.passed) tally.bothAfter++;
    for (const code of new Set(after.qa.defectCodes)) remaining[code] = (remaining[code] || 0) + 1;
    const newlyFailing = after.metrics.failingMetrics.filter((m) => !before.metrics.failingMetrics.includes(m));
    const worse = (before.qa.passed && !after.qa.passed) || (after.qa.passed && newlyFailing.length > 0);
    if (worse) regressions++;
    if (!after.qa.passed || newlyFailing.length) {
      lines.push(
        `  ${worse ? 'REGRESSION ' : ''}${id}: ${after.qa.passed ? 'QA pass' : after.qa.messages.join(' | ')}` +
          (newlyFailing.length ? ` | newly failing: ${newlyFailing.join(', ')}` : '')
      );
    }
  }
  console.log(`== ${run}`);
  console.log(
    `  production QA ${tally.qaBefore}/${tally.n} before, ${tally.qaAfter}/${tally.n} after; ` +
      `QA and metrics together after: ${tally.bothAfter}/${tally.n}; remaining: ${JSON.stringify(remaining)}`
  );
  for (const line of lines) console.log(line);
}
if (regressions) {
  console.error(`${regressions} shippable design(s) made worse by preparation`);
  process.exit(1);
}
