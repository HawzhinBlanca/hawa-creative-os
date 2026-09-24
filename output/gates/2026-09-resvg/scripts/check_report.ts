#!/usr/bin/env tsx
/**
 * Checks REPORT.md against the measurements it reports, so a claim the data does not support fails
 * here rather than reaching the owner. Exits 1 on the first failed check.
 *
 *   npx tsx output/gates/2026-09-resvg/scripts/check_report.ts
 *
 * It exists because the first version of this gate shipped without a report, and an earlier
 * reading of the font fallback probe called a setup "working" that drops a whole line.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(GATE, 'REPORT.md');
const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(GATE, rel), 'utf8'));

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`ok  ${name}`);
}

check('REPORT.md exists', () => assert.ok(fs.existsSync(reportPath), `${reportPath} is missing`));
const report = fs.readFileSync(reportPath, 'utf8');
const summary = json('summary.json');
const recount = json('warning-recount.json');
const probe = json('samples/fallback-probe.json');
// Numbers are written with thousands separators in the report.
const n = (x: number) => x.toLocaleString('en-US');

check('every ADR-036 2.3 criterion has a verdict row', () => {
  for (const c of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']) {
    assert.match(report, new RegExp(`^\\| ${c} \\|.*\\| (\\*\\*)?(GO|NO-GO|OPEN)`, 'm'), `no verdict row for ${c}`);
  }
  assert.match(report, /^\| C8 \|.*OPEN \(owner\)/m, 'the human sign-off must stay open');
});

check('the overall verdict follows from the rows', () => {
  const failing = [...report.matchAll(/^\| (C\d) \|.*\| \*\*NO-GO\*\*/gm)].map((m) => m[1]);
  assert.ok(failing.length > 0 ? /\*\*Verdict: NO-GO\.\*\*/.test(report) : /\*\*Verdict: GO/.test(report), 'overall verdict disagrees with the rows');
});

check('the font fallback claim matches the probe', () => {
  const drawingBoth = probe.setups.filter((s: { bothDrawn: boolean }) => s.bothDrawn).map((s: { setup: string }) => s.setup);
  if (drawingBoth.length === 0) {
    assert.match(report, /No tested font setup draws both lines correctly/);
    assert.doesNotMatch(report, /dejavu[^.\n|]*\bworks\b/i, 'the report calls a failing setup working');
    const dejavu = probe.setups.find((s: { setup: string }) => s.setup === 'dejavu-and-noto');
    const verdanaLine = dejavu.lines.find((l: { line: string }) => l.line === 'verdana-with-sorani');
    assert.equal(verdanaLine.inkPixels, 0, 'the probe no longer shows DejaVu + Noto dropping the Verdana line');
    assert.match(report, /DejaVu Sans plus Noto Sans Arabic\s+does not work/);
  } else {
    assert.doesNotMatch(report, /No tested font setup draws both lines correctly/);
  }
});

check('warning counts: the exact count, and the gate run stated as a lower bound', () => {
  const key = Object.keys(recount.catalogue).find((k) => /No fonts with a <char> character were found\./.test(k))!;
  assert.ok(report.includes(n(recount.catalogue[key])), `exact missing-character count ${recount.catalogue[key]} not in the report`);
  const gateKey = Object.keys(summary.warningCatalogue).find((k) => /No fonts with a <char> character were found\./.test(k))!;
  assert.match(report, new RegExp(`\\*\\*at least\\*\\* ${n(summary.warningCatalogue[gateKey])}`));
  assert.equal(recount.pngIdenticalToGateRun, recount.canvases, 'the recount drew different pictures');
  assert.ok(report.includes(`${recount.canvasesWithMissingCharacter} of ${summary.gateCanvases}`) || report.includes(`${recount.canvases} of ${summary.gateCanvases}`));
});

check('C4 numbers match summary.json', () => {
  assert.ok(report.includes(summary.overall.ssimMedian.toFixed(4)), 'median SSIM');
  assert.ok(report.includes(summary.overall.ssimMin.toFixed(4)), 'minimum SSIM');
  assert.match(report, new RegExp(`${summary.overall.ssimBelow097} canvases below 0\\.97`));
});

check('C6 states which set its times use', () => {
  assert.ok(report.includes(String(summary.overall.msRsvg.p95)) && report.includes(String(summary.overall.msResvg.p95)), 'the with-stress p95 values');
  assert.match(report, /Including the 3 stress canvases/);
});

check('C3 names the glow bakes and the re-measure after 3.2', () => {
  for (const b of summary.overall.bakes.filter((x: { id: string }) => /^bake-glow-\d+-/.test(x.id))) {
    const size = /^bake-glow-(\d+)-/.exec(b.id)![1];
    assert.match(report, new RegExp(`\\| glow ${size} \\| ${b.boxDelta} \\|`), `glow ${size} row`);
  }
  assert.match(report, /C3 must be measured again after Phase 3\.2/);
});

check('C2 says what the out-of-tolerance Arabic lines have in common, and no more', () => {
  assert.match(report, /every one on a line with a resvg font warning/);
  assert.doesNotMatch(report, /every one a line where resvg drew \.notdef/);
});

check('the word-order threshold is disclosed as chosen after the data', () => {
  assert.match(report, /That threshold was set after looking at the first run/);
  assert.ok(report.includes(`(${summary.lineSummary.all.wordOrderFlaggedAt090}\n`) || report.includes(`${summary.lineSummary.all.wordOrderFlaggedAt090}`));
  assert.ok(report.includes(`all ${summary.wordOrderDetector.controlsDetected} are flagged`));
});

check('the 30 lowest-SSIM pairs are on disk and listed', () => {
  const files = fs.readdirSync(path.join(GATE, 'lowest-ssim')).filter((f) => f.endsWith('.png'));
  assert.equal(files.length, 30);
  for (const f of files) {
    const id = f.replace(/^\d+-/, '').replace(/\.png$/, '');
    assert.ok(report.includes(id), `${id} not listed`);
  }
});

check('the Phase 0.5 markup comparison is attributed, not claimed', () => {
  assert.match(report, /That comparison is Phase 0\.5's evidence, not this gate's/);
});

console.log(`${checks} checks passed`);
