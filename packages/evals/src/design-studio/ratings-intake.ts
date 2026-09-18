import fs from 'node:fs';
import type {
  HumanRatingRow,
  RatingsIntakeResult,
  BootstrapConfidenceInterval,
} from './types.js';

/**
 * Parses the owner's blind-rating sheet.
 *
 * Every data row must carry an explicit choice (A, B or tie) and both ratings. A blank or
 * unrecognised choice used to be read as a tie and a missing rating as 5, so a half-finished sheet
 * scored as if it were complete. It now refuses, naming the row, because this result decides
 * whether the pipeline ships.
 */
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
  const problems: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((c) => c.trim());
    const rowObj: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      rowObj[header[j]] = parts[j] ?? '';
    }

    const pairId = rowObj.pairid || rowObj.id || '';
    const label = pairId || `data row ${i}`;
    if (!pairId) problems.push(`${label}: no pairId`);

    const rawChoice = (rowObj.choice || rowObj.winner || rowObj.humanchoice || '').toUpperCase();
    const choice = rawChoice === 'A' ? 'A' : rawChoice === 'B' ? 'B' : rawChoice === 'TIE' ? 'tie' : null;
    if (!choice) problems.push(`${label}: choice must be A, B or tie (found "${rawChoice}")`);

    const ratingA = parseRating(rowObj.ratinga ?? rowObj.scorea);
    const ratingB = parseRating(rowObj.ratingb ?? rowObj.scoreb);
    if (ratingA === null) problems.push(`${label}: ratingA must be a number from 1 to 10`);
    if (ratingB === null) problems.push(`${label}: ratingB must be a number from 1 to 10`);

    if (pairId && choice && ratingA !== null && ratingB !== null) {
      rows.push({
        pairId,
        briefId: rowObj.briefid || rowObj.brief || '',
        choice,
        ratingA,
        ratingB,
        notes: rowObj.notes || '',
      });
    }
  }

  if (problems.length > 0) {
    throw new Error(`The rating sheet is not complete:\n  ${problems.join('\n  ')}`);
  }
  return rows;
}

function parseRating(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
}

/**
 * Seeded generator so a bootstrap interval is the same every time the same ratings are scored.
 * Math.random made the reported interval move between runs of an unchanged sheet.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeBootstrapCi(
  values: number[],
  evalFn: (sample: number[]) => number,
  iterations = 10000,
  seed = 20260917
): BootstrapConfidenceInterval {
  const n = values.length;
  if (n === 0) {
    return { pointEstimate: 0, ciLower95: 0, ciUpper95: 0, standardError: 0 };
  }

  const pointEstimate = evalFn(values);
  const bootstrapEstimates: number[] = [];

  const random = mulberry32(seed);
  for (let iter = 0; iter < iterations; iter++) {
    const resample: number[] = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(random() * n);
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

/** Which side each pair's new-pipeline design sits on, and the judge's scores where they exist. */
export type RatingsPairKey = Record<string, { v2Side: 'A' | 'B'; judgeScoreA?: number; judgeScoreB?: number }>;

/**
 * Scores a completed blind-rating sheet against the sealed pair key.
 *
 * The key is required. A pair missing from it used to be scored as if the new pipeline sat on
 * side B, which silently mis-assigns sides; it now throws. Judge statistics are computed only from
 * pairs whose key carries real judge scores, and are null when none do — they used to be derived
 * from invented scores that always favoured the new pipeline.
 */
export function processRatingsIntake(ratings: HumanRatingRow[], pairKey: RatingsPairKey): RatingsIntakeResult {
  const missing = ratings.filter((r) => !pairKey[r.pairId]).map((r) => r.pairId);
  if (missing.length > 0) {
    throw new Error(`These rated pairs are not in the sealed key: ${missing.join(', ')}`);
  }

  let v2Wins = 0;
  let v1Wins = 0;
  let ties = 0;
  const humanScoresV2: number[] = [];
  const humanScoresV1: number[] = [];
  const prefValues: number[] = [];
  const judged: Array<{ humanV2: number; judgeV2: number; agreed: number }> = [];

  for (const r of ratings) {
    const key = pairKey[r.pairId];
    const isV2SideA = key.v2Side === 'A';
    const v2Rating = isV2SideA ? r.ratingA : r.ratingB;
    humanScoresV2.push(v2Rating);
    humanScoresV1.push(isV2SideA ? r.ratingB : r.ratingA);

    const isV2Win = (r.choice === 'A' && isV2SideA) || (r.choice === 'B' && !isV2SideA);
    const isV1Win = r.choice !== 'tie' && !isV2Win;
    if (r.choice === 'tie') ties++;
    else if (isV2Win) v2Wins++;
    else v1Wins++;
    prefValues.push(r.choice === 'tie' ? 0.5 : isV2Win ? 1.0 : 0.0);

    if (typeof key.judgeScoreA === 'number' && typeof key.judgeScoreB === 'number') {
      const judgeTie = Math.abs(key.judgeScoreA - key.judgeScoreB) < 0.2;
      const judgeWinV2 = key.judgeScoreB > key.judgeScoreA ? !isV2SideA : isV2SideA;
      const agreed =
        (r.choice === 'tie' && judgeTie) || (!judgeTie && ((isV2Win && judgeWinV2) || (isV1Win && !judgeWinV2)));
      judged.push({
        humanV2: v2Rating,
        judgeV2: isV2SideA ? key.judgeScoreA : key.judgeScoreB,
        agreed: agreed ? 1.0 : 0.0,
      });
    }
  }

  const mean = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length;
  const preferenceRateV2 = computeBootstrapCi(prefValues, mean);
  const meanRatingV1 = computeBootstrapCi(humanScoresV1, mean);
  const meanRatingV2 = computeBootstrapCi(humanScoresV2, mean);

  let judgeAgreementRate: BootstrapConfidenceInterval | null = null;
  let spearmanRhoWithJudge: BootstrapConfidenceInterval | null = null;
  if (judged.length >= 2) {
    judgeAgreementRate = computeBootstrapCi(judged.map((j) => j.agreed), mean);
    const indices = judged.map((_, i) => i);
    spearmanRhoWithJudge = computeBootstrapCi(indices, (sample) =>
      computeSpearmanRho(
        sample.map((i) => judged[i].humanV2),
        sample.map((i) => judged[i].judgeV2)
      )
    );
  }

  return {
    totalPairs: ratings.length,
    v2WinCount: v2Wins,
    v1WinCount: v1Wins,
    tieCount: ties,
    preferenceRateV2,
    meanRatingV1,
    meanRatingV2,
    spearmanRhoWithJudge,
    judgeAgreementRate,
    pairsWithJudgeScores: judged.length,
  };
}
