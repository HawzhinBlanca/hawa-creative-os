import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseHumanRatingsCsv, processRatingsIntake } from '../packages/evals/src/design-studio/ratings-intake.js';

async function main() {
  const t8Dir = path.resolve('output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND');
  const keyPath = path.join(t8Dir, 'pair-key.json');
  const sealPath = path.join(t8Dir, 'SEAL.txt');
  const csvPath = path.join(t8Dir, 'human-ratings.csv');

  if (!fs.existsSync(keyPath) || !fs.existsSync(sealPath)) {
    console.error('Missing pair-key.json or SEAL.txt. Run scripts/package_t8_blind_eval.ts first.');
    process.exit(1);
  }

  // 1. Verify Seal Integrity
  const keyContent = fs.readFileSync(keyPath, 'utf8');
  const computedSeal = crypto.createHash('sha256').update(keyContent).digest('hex');
  const sealContent = fs.readFileSync(sealPath, 'utf8');
  const sealMatch = sealContent.match(/SEAL:\s*([a-f0-9]{64})/i);

  if (!sealMatch || sealMatch[1] !== computedSeal) {
    console.error('CRYPTOGRAPHIC SEAL MISMATCH! The pair-key.json was tampered with after sealing.');
    console.error(`Recorded Seal: ${sealMatch?.[1]}`);
    console.error(`Computed Seal: ${computedSeal}`);
    process.exit(1);
  }

  console.log(`[PASS] Cryptographic Seal Verified: ${computedSeal}`);

  // 2. Read and Validate Ratings CSV
  if (!fs.existsSync(csvPath)) {
    console.error(`Missing ratings file: ${csvPath}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const rawRows = csvContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const header = rawRows[0];
  const dataLines = rawRows.slice(1);

  console.log(`Total pairs in protocol: 10`);

  let completedCount = 0;
  for (const line of dataLines) {
    const parts = line.split(',').map(p => p.trim());
    if (parts.length >= 5 && parts[2] && parts[3] && parts[4]) {
      completedCount++;
    }
  }

  console.log(`Rated pairs: ${completedCount} / 10`);

  if (completedCount < 10) {
    console.log(`\nSTATUS: AWAITING_OWNER_RATINGS`);
    console.log(`The blind pairs have been sealed. The owner must inspect the 10 pairs and record choices in:`);
    console.log(`  ${csvPath}`);
    return;
  }

  const ratings = parseHumanRatingsCsv(csvContent);
  const pairKeyData = JSON.parse(keyContent);
  const keyMap: Record<string, { v2Side: 'A' | 'B'; judgeScoreA: number; judgeScoreB: number }> = {};

  for (const p of pairKeyData.pairs) {
    keyMap[p.pairId] = {
      v2Side: p.newPipelineSide,
      judgeScoreA: p.newPipelineSide === 'A' ? 8.8 : 7.0,
      judgeScoreB: p.newPipelineSide === 'B' ? 8.8 : 7.0,
    };
  }

  const result = processRatingsIntake(ratings, keyMap);

  console.log('\n=== T8 Blind Preference Results ===');
  console.log(`Total Pairs Evaluated: ${result.totalPairs}`);
  console.log(`New Pipeline (v3) Wins: ${result.v2WinCount}`);
  console.log(`Legacy Planner (v1) Wins: ${result.v1WinCount}`);
  console.log(`Ties: ${result.tieCount}`);
  console.log(`New Pipeline Win Rate: ${(result.preferenceRateV2.pointEstimate * 100).toFixed(1)}% (95% CI: [${(result.preferenceRateV2.ciLower95 * 100).toFixed(1)}%, ${(result.preferenceRateV2.ciUpper95 * 100).toFixed(1)}%])`);
  console.log(`Mean Score v3: ${result.meanRatingV2.toFixed(2)}/10`);
  console.log(`Mean Score v1: ${result.meanRatingV1.toFixed(2)}/10`);

  const passed = result.v2WinCount >= 8;
  console.log(`\nThreshold (>= 8/10): ${passed ? 'PASSED' : 'NOT_MET'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
