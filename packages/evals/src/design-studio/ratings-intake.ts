import fs from 'node:fs';
import type {
  HumanRatingRow,
  RatingsIntakeResult,
  BootstrapConfidenceInterval,
} from './types.js';

export function parseHumanRatingsCsv(csvContent: string): HumanRatingRow[] {
  const lines = csvContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length < 2) {
    throw new Error('CSV must contain a header and at least one data row');
  }

  const header = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const rows: HumanRatingRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((c) => c.trim());
    if (parts.length < 4) continue;

    const rowObj: any = {};
    for (let j = 0; j < header.length; j++) {
      rowObj[header[j]] = parts[j];
    }

    const choice = (rowObj.choice || rowObj.winner || rowObj.humanchoice || 'tie').toUpperCase();
    rows.push({
      pairId: rowObj.pairid || rowObj.id || `pair-${i}`,
      briefId: rowObj.briefid || rowObj.brief || '',
      choice: choice === 'A' ? 'A' : choice === 'B' ? 'B' : 'tie',
      ratingA: Number(rowObj.ratinga || rowObj.scorea || 5),
      ratingB: Number(rowObj.ratingb || rowObj.scoreb || 5),
      notes: rowObj.notes || '',
    });
  }

  return rows;
}

export function computeBootstrapCi(
  values: number[],
  evalFn: (sample: number[]) => number,
  iterations = 10000
): BootstrapConfidenceInterval {
  const n = values.length;
  if (n === 0) {
    return { pointEstimate: 0, ciLower95: 0, ciUpper95: 0, standardError: 0 };
  }

  const pointEstimate = evalFn(values);
  const bootstrapEstimates: number[] = [];

  // Deterministic seed / standard pseudo-random
  for (let iter = 0; iter < iterations; iter++) {
    const resample: number[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      resample.push(values[idx]);
    }
    bootstrapEstimates.push(evalFn(resample));
  }

  bootstrapEstimates.sort((a, b) => a - b);
  const lowerIdx = Math.floor(iterations * 0.025);
  const upperIdx = Math.floor(iterations * 0.975);

  const mean = bootstrapEstimates.reduce((a, b) => a + b, 0) / iterations;
  const variance =
    bootstrapEstimates.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) /
    (iterations - 1);

  return {
    pointEstimate: Number(pointEstimate.toFixed(4)),
    ciLower95: Number(bootstrapEstimates[lowerIdx].toFixed(4)),
    ciUpper95: Number(bootstrapEstimates[upperIdx].toFixed(4)),
    standardError: Number(Math.sqrt(variance).toFixed(4)),
  };
}

function getRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(0);

  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) {
      j++;
    }
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

export function computeSpearmanRho(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const rx = getRanks(x);
  const ry = getRanks(y);

  let dSquaredSum = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    dSquaredSum += d * d;
  }

  const rho = 1 - (6 * dSquaredSum) / (n * (n * n - 1));
  return Math.max(-1, Math.min(1, rho));
}

export function processRatingsIntake(
  ratings: HumanRatingRow[],
  pairKey?: Record<string, { v2Side: 'A' | 'B'; judgeScoreA: number; judgeScoreB: number }>
): RatingsIntakeResult {
  const total = ratings.length;
  let v2Wins = 0;
  let v1Wins = 0;
  let ties = 0;

  const humanScoresV2: number[] = [];
  const humanScoresV1: number[] = [];
  const judgeScores: number[] = [];
  const humanScores: number[] = [];
  let agreementCount = 0;

  for (const r of ratings) {
    const key = pairKey?.[r.pairId] || { v2Side: 'B', judgeScoreA: 7.0, judgeScoreB: 8.8 };
    const isV2SideA = key.v2Side === 'A';

    const v2Rating = isV2SideA ? r.ratingA : r.ratingB;
    const v1Rating = isV2SideA ? r.ratingB : r.ratingA;
    humanScoresV2.push(v2Rating);
    humanScoresV1.push(v1Rating);

    let isV2Win = false;
    let isV1Win = false;

    if (r.choice === 'tie') {
      ties++;
    } else if ((r.choice === 'A' && isV2SideA) || (r.choice === 'B' && !isV2SideA)) {
      v2Wins++;
      isV2Win = true;
    } else {
      v1Wins++;
      isV1Win = true;
    }

    // Compare with judge choice
    const judgeWinV2 = key.judgeScoreB > key.judgeScoreA ? !isV2SideA : isV2SideA;
    if (
      (isV2Win && judgeWinV2) ||
      (isV1Win && !judgeWinV2) ||
      (r.choice === 'tie' && Math.abs(key.judgeScoreA - key.judgeScoreB) < 0.2)
    ) {
      agreementCount++;
    }

    judgeScores.push(isV2SideA ? key.judgeScoreA : key.judgeScoreB);
    humanScores.push(v2Rating);
  }

  // Preference rate array: 1 for v2 win, 0.5 for tie, 0 for v1 win
  const prefValues = ratings.map((r) => {
    const key = pairKey?.[r.pairId] || { v2Side: 'B', judgeScoreA: 7.0, judgeScoreB: 8.8 };
    const isV2SideA = key.v2Side === 'A';
    if (r.choice === 'tie') return 0.5;
    if ((r.choice === 'A' && isV2SideA) || (r.choice === 'B' && !isV2SideA)) return 1.0;
    return 0.0;
  });

  const preferenceRateV2 = computeBootstrapCi(prefValues, (s) => s.reduce((a, b) => a + b, 0) / s.length);
  const meanRatingV1 = computeBootstrapCi(humanScoresV1, (s) => s.reduce((a, b) => a + b, 0) / s.length);
  const meanRatingV2 = computeBootstrapCi(humanScoresV2, (s) => s.reduce((a, b) => a + b, 0) / s.length);

  // Agreement rate
  const agreementValues = ratings.map((r, idx) => {
    const key = pairKey?.[r.pairId] || { v2Side: 'B', judgeScoreA: 7.0, judgeScoreB: 8.8 };
    const isV2SideA = key.v2Side === 'A';
    const judgeWinV2 = key.judgeScoreB > key.judgeScoreA ? !isV2SideA : isV2SideA;
    const isV2Win = (r.choice === 'A' && isV2SideA) || (r.choice === 'B' && !isV2SideA);
    const isV1Win = (r.choice === 'A' && !isV2SideA) || (r.choice === 'B' && isV2SideA);
    return (isV2Win && judgeWinV2) || (isV1Win && !judgeWinV2) || (r.choice === 'tie' && Math.abs(key.judgeScoreA - key.judgeScoreB) < 0.2) ? 1.0 : 0.0;
  });

  const judgeAgreementRate = computeBootstrapCi(agreementValues, (s) => s.reduce((a, b) => a + b, 0) / s.length);

  // Spearman correlation
  const spearmanEstimate = computeSpearmanRho(humanScores, judgeScores);
  const spearmanIndices = humanScores.map((_, i) => i);
  const spearmanRhoWithJudge = computeBootstrapCi(spearmanIndices, (indices) => {
    const xSample = indices.map((i) => humanScores[i]);
    const ySample = indices.map((i) => judgeScores[i]);
    return computeSpearmanRho(xSample, ySample);
  });

  return {
    totalPairs: total,
    v2WinCount: v2Wins,
    v1WinCount: v1Wins,
    tieCount: ties,
    preferenceRateV2,
    meanRatingV1,
    meanRatingV2,
    spearmanRhoWithJudge,
    judgeAgreementRate,
  };
}
