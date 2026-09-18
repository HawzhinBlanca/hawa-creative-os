import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseHumanRatingsCsv,
  processRatingsIntake,
  type RatingsPairKey,
} from '../packages/evals/src/design-studio/ratings-intake.js';

async function main() {
  const packageArg = process.argv.indexOf('--package');
  if (packageArg < 0 || !process.argv[packageArg + 1]) {
    console.error('usage: verify_t8_ratings.ts --package <dir written by package_t8_blind_eval.ts>');
    process.exit(2);
  }
  const t8Dir = path.resolve(process.argv[packageArg + 1]);
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

  // Refuses an unfinished sheet: a blank choice is not a tie and a blank rating is not a 5.
  const ratings = parseHumanRatingsCsv(csvContent);
  const pairKeyData = JSON.parse(keyContent);

  // Only the side assignment comes from the key. It carries no judge scores, so none are invented:
  // this script used to fill in 8.8 for the new pipeline and 7.0 for the old on every pair.
  const keyMap: RatingsPairKey = {};
  for (const p of pairKeyData.pairs) {
    keyMap[p.pairId] = { v2Side: p.newPipelineSide };
  }

  const expected = pairKeyData.pairs.length;
  if (ratings.length !== expected) {
    console.error(`The sheet rates ${ratings.length} pairs; the sealed key has ${expected}. Rate every pair before scoring.`);
    process.exit(1);
  }

  const result = processRatingsIntake(ratings, keyMap);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const ci = (c: { pointEstimate: number; ciLower95: number; ciUpper95: number }, f: (v: number) => string) =>
    `${f(c.pointEstimate)} (95% CI ${f(c.ciLower95)}–${f(c.ciUpper95)})`;

  console.log('\n=== T8 Blind Preference Results ===');
  console.log(`Total Pairs Evaluated: ${result.totalPairs}`);
  console.log(`New Pipeline (v3) Wins: ${result.v2WinCount}`);
  console.log(`Legacy Planner (v1) Wins: ${result.v1WinCount}`);
  console.log(`Ties: ${result.tieCount}`);
  console.log(`New Pipeline Win Rate: ${ci(result.preferenceRateV2, pct)}`);
  console.log(`Mean Score v3: ${ci(result.meanRatingV2, (v) => v.toFixed(2))} out of 10`);
  console.log(`Mean Score v1: ${ci(result.meanRatingV1, (v) => v.toFixed(2))} out of 10`);

  const passed = result.v2WinCount >= 8;
  console.log(`\nThreshold (>= 8/10): ${passed ? 'PASSED' : 'NOT_MET'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
