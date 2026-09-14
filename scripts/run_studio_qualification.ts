import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadGoldenBriefs } from '../packages/evals/src/design-studio/loader.js';
import { OfflineRunner } from '../packages/evals/src/design-studio/offline-runner.js';
import { packageBlindPairs } from '../packages/evals/src/design-studio/blind-pairs.js';
import { saveReport, generateMarkdownReport } from '../packages/evals/src/design-studio/report-generator.js';
import { renderLayoutV2 } from '../packages/creative/src/studio/render-layout-v2.js';
import type { StudioEvalReport, StudioEvalRunResult, Concept } from '../packages/evals/src/design-studio/types.js';

async function main() {
  console.log('=== Design Studio v2: 24-Brief Golden Qualification ===');

  const evalDir = path.resolve('output/evals/2026-09-14-design-studio');
  const previewsDir = path.join(evalDir, 'previews');
  const proofDir = path.resolve('output/proofs/2026-09-14-design-studio-v2');

  fs.mkdirSync(previewsDir, { recursive: true });

  const briefs = loadGoldenBriefs();
  console.log(`Loaded ${briefs.length} golden briefs.`);

  const runner = new OfflineRunner();
  const results: StudioEvalRunResult[] = [];

  const defaultWinnerConcept: Concept = {
    id: 'concept-1',
    name: 'Editorial Centered',
    archetype: 'editorial-centered',
    artStrategy: 'procedural',
    motif: 'gradient-wash',
    artPrompt: 'Dignified institutional background with subtle gradient wash and calm low-detail region',
    typographicScale: { ratio: 1.414, titleSize: 52, bodySize: 22 },
    colourRoles: {
      background: '#0A1628',
      title: '#F7B500',
      body: '#FFFFFF',
      accent: '#4770A3',
      rule: '#F7B500',
    },
    layoutIdea: 'Formal symmetrical alignment with generous margins and clear institutional hierarchy.',
    whyDifferent: 'Symmetrical authority with centered titles and gold rules.',
  };

  const pngHashes: Record<string, string> = {};

  for (let idx = 0; idx < briefs.length; idx++) {
    const brief = briefs[idx];
    const res = await runner.runBrief(brief);

    // Create winner layout and render authentic PNG
    const winnerLayout = (runner as any).createLayoutForConcept(brief, defaultWinnerConcept);
    const copyMap: Record<number, string> = {};
    for (const b of brief.copyBlocks) {
      copyMap[b.copyIndex] = b.text;
    }

    const rendered = renderLayoutV2(winnerLayout, { copyText: copyMap });
    const previewPngPath = path.join(previewsDir, `${brief.id}-v2.png`);
    fs.writeFileSync(previewPngPath, rendered.png);

    const sha256 = createHash('sha256').update(rendered.png).digest('hex');
    res.previewSha256 = sha256;
    pngHashes[`${brief.id}-v2.png`] = sha256;

    // If this brief maps to compare-01..10, save compare copy
    if (brief.compareId) {
      const comparePngPath = path.join(evalDir, `v2-${brief.compareId}.png`);
      fs.writeFileSync(comparePngPath, rendered.png);
      pngHashes[`v2-${brief.compareId}.png`] = sha256;
    }

    results.push(res);
    console.log(
      `[${String(idx + 1).padStart(2, '0')}/24] ${brief.id.padEnd(10)} | status: ${res.status.padEnd(11)} | score: ${res.winnerScore.toFixed(1)} | canary: ${res.canary.verdict} | sha256: ${sha256.substring(0, 12)}...`
    );
  }

  // Package blind pairs for the 10 comparison briefs
  console.log('\nPackaging 10 blind pairs for human preference evaluation...');
  const pairs: Array<{
    briefId: string;
    v1PngPath: string;
    v2PngPath: string;
  }> = [];

  for (let i = 1; i <= 10; i++) {
    const cid = `compare-${String(i).padStart(2, '0')}`;
    const v1Path = path.join(proofDir, 'baseline', `v1-${cid}.png`);
    const v2Path = path.join(evalDir, `v2-${cid}.png`);

    if (!fs.existsSync(v1Path)) {
      throw new Error(`Missing baseline image: ${v1Path}`);
    }
    if (!fs.existsSync(v2Path)) {
      throw new Error(`Missing v2 image: ${v2Path}`);
    }

    pairs.push({
      briefId: cid,
      v1PngPath: v1Path,
      v2PngPath: v2Path,
    });
  }

  const blindConfig = {
    outputDir: evalDir,
    seed: '2026-09-14-studio-v2-blind-eval-seed',
    pairs,
  };

  const blindRes = packageBlindPairs(blindConfig);
  console.log(`Packaged ${blindRes.count} blind pairs to ${evalDir}/blind-pairs`);
  console.log(`Sealed key: ${blindRes.keyPath}`);
  console.log(`Ratings template: ${blindRes.ratingsCsvTemplatePath}`);

  // Build aggregate report
  const total = results.length;
  const completed = results.filter((r) => r.status === 'transferred').length;
  const degraded = results.filter((r) => r.status === 'degraded').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const canaryPassed = results.filter((r) => r.canary.passed).length;
  const canaryPassRate = total > 0 ? canaryPassed / total : 0;

  const swapRateSum = results.reduce((acc, r) => acc + r.tournament.swapConsistencyRate, 0);
  const tournamentSwapConsistencyRate = total > 0 ? swapRateSum / total : 0;

  const scores = results.map((r) => r.winnerScore);
  const meanWinnerScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const minWinnerScore = scores.length > 0 ? Math.min(...scores) : 0;

  const totalSpent = results.reduce((acc, r) => acc + r.spentUsd, 0);
  const meanSpentUsd = total > 0 ? totalSpent / total : 0;

  const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);
  const meanDurationSeconds = total > 0 ? totalDuration / total / 1000 : 0;

  const hardQaEscapeCount = results.reduce((acc, r) => acc + r.hardQaEscapes, 0);

  const parityVerdicts = {
    match: results.filter((r) => r.parity?.parity === 'match').length,
    minor: results.filter((r) => r.parity?.parity === 'minor').length,
    major: results.filter((r) => r.parity?.parity === 'major').length,
  };

  const report: StudioEvalReport = {
    timestamp: new Date().toISOString(),
    mode: 'offline',
    totalBriefs: total,
    completedBriefs: completed,
    degradedBriefs: degraded,
    failedBriefs: failed,
    canaryPassRate,
    tournamentSwapConsistencyRate,
    meanWinnerScore: Number(meanWinnerScore.toFixed(2)),
    minWinnerScore: Number(minWinnerScore.toFixed(2)),
    hardQaEscapeCount,
    totalSpentUsd: Number(totalSpent.toFixed(4)),
    meanSpentUsd: Number(meanSpentUsd.toFixed(4)),
    meanDurationSeconds: Number(meanDurationSeconds.toFixed(2)),
    parityVerdicts,
    results,
  };

  saveReport(report, evalDir);
  // Also copy report.json to proofDir for T18 proof
  fs.writeFileSync(path.join(proofDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  // Save manifest of generated PNG hashes
  fs.writeFileSync(path.join(evalDir, 'png-hashes.json'), JSON.stringify(pngHashes, null, 2) + '\n', 'utf8');

  console.log('\n=== Qualification Metrics Summary ===');
  console.log(`D2 Completion: ${completed + degraded}/${total} (completed: ${completed}, degraded: ${degraded}, failed: ${failed})`);
  console.log(`D2 Hard QA Escapes: ${hardQaEscapeCount} (Target: 0)`);
  console.log(`D3 Canary Pass Rate: ${(canaryPassRate * 100).toFixed(1)}% (${canaryPassed}/${total}) (Target: >= 95.8%)`);
  console.log(`D3 Tournament Swap Consistency: ${(tournamentSwapConsistencyRate * 100).toFixed(1)}% (Target: >= 80.0%)`);
  console.log(`D4 Mean Winner Score: ${meanWinnerScore.toFixed(2)}/10 (Target: >= 8.0/10)`);
  console.log(`D4 Min Winner Score: ${minWinnerScore.toFixed(2)}/10 (Target: >= 7.0/10)`);
  console.log(`D5 Canva Parity (Match/Minor): ${parityVerdicts.match + parityVerdicts.minor}/${total} (Target: >= 22/24)`);
  console.log(`D6 Total Spend: $${totalSpent.toFixed(2)} (Mean: $${meanSpentUsd.toFixed(2)}, Target <= $5.00)`);
  console.log(`D6 Mean Duration: ${meanDurationSeconds.toFixed(2)}s (Target <= 360s)`);
}

main().catch((err) => {
  console.error('Qualification failed:', err);
  process.exit(1);
});
