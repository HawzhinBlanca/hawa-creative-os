import crypto from 'node:crypto';
import type { CorpusManifest } from '../corpus/corpus-manifest.js';

export type VoteChoice = 'A' | 'B' | 'tie' | 'cannot_judge' | '';
export interface StudyVote { pairId: string; choice: VoteChoice; reason: string; defectTags: string }

/** CSV reader for the four-column rater sheet, including quoted commas/newlines. */
export function parseStudyRatingsCsv(text: string): StudyVote[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      if (field) throw new Error('Malformed CSV quote');
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field.replace(/\r$/, '')); field = '';
      if (row.some((v) => v.length)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  if (rows[0]?.join(',') !== 'pairId,choice,reason,defectTags') throw new Error('Unexpected rating sheet header');
  return rows.slice(1).map((cells) => {
    if (cells.length !== 4) throw new Error('Rating row must have four fields');
    const choice = cells[1].trim() as VoteChoice;
    if (!['A', 'B', 'tie', 'cannot_judge', ''].includes(choice)) throw new Error(`Invalid vote choice for ${cells[0]}`);
    if (!cells[0]) throw new Error('Rating row has no pair ID');
    return { pairId: cells[0], choice, reason: cells[2], defectTags: cells[3] };
  });
}

interface PairKey {
  judgeId: string; pairId: string; caseId: string; candidateSide: 'A' | 'B';
  leftPngSha256: string; rightPngSha256: string; briefSha256: string;
}
export interface StudyKey {
  schemaVersion: 1;
  status: 'packaged_pending_human_ratings';
  seed: string;
  key: PairKey[];
  analysisPlan: {
    unit: 'duplicateGroup'; weighting: 'equal_lineage'; bootstrapIterations: number;
    tieScore: 0.5; superiorityPoint: number; superiorityLower95: number;
  };
}

export function rng(seed: string): () => number {
  let state = parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Percentile bootstrap over independent lineages. Each row holds one lineage's values; whole rows
 * are resampled together, so paired columns stay paired. Returns the 95% interval of each column's
 * mean. Shared by the R-study preference analysis and the ADR-124 judge experiment.
 */
export function bootstrapLineageMeans(rows: number[][], seed: string, iterations: number): Array<{ lower95: number; upper95: number }> {
  if (!rows.length) return [];
  const width = rows[0].length;
  const random = rng(seed);
  const draws = Array.from({ length: width }, () => [] as number[]);
  for (let i = 0; i < iterations; i++) {
    const totals = new Array<number>(width).fill(0);
    for (let j = 0; j < rows.length; j++) {
      const row = rows[Math.floor(random() * rows.length)];
      for (let k = 0; k < width; k++) totals[k] += row[k];
    }
    for (let k = 0; k < width; k++) draws[k].push(totals[k] / rows.length);
  }
  return draws.map((column) => {
    column.sort((a, b) => a - b);
    return { lower95: column[Math.floor(column.length * 0.025)], upper95: column[Math.floor(column.length * 0.975)] };
  });
}

export function analyzeCurrentExportVotes(input: {
  key: StudyKey;
  corpus: CorpusManifest;
  ratingsByJudge: Record<string, string>;
}): {
  status: 'INCOMPLETE' | 'ANALYSIS_PENDING_INDEPENDENT_VERIFICATION';
  admissionQualified: false;
  counts: { cases: number; independentLineages: number; expectedVotes: number; validVotes: number; ties: number; cannotJudge: number; missing: number; casesBelowThreeValidVotes: number };
  preference: { point: number; lower95: number; upper95: number; superiorityThresholdMet: boolean } | null;
  byLanguage: Record<string, { cases: number; mean: number | null }>;
  byClient: Record<string, { cases: number; mean: number | null }>;
} {
  const { key, corpus } = input;
  if (key.schemaVersion !== 1 || key.status !== 'packaged_pending_human_ratings' ||
      key.analysisPlan?.unit !== 'duplicateGroup' || key.analysisPlan?.weighting !== 'equal_lineage' ||
      key.analysisPlan.bootstrapIterations !== 10_000 || key.analysisPlan.tieScore !== 0.5) {
    throw new Error('Missing or changed frozen analysis plan');
  }
  const cases = new Map(corpus.cases.filter((c) => c.split === 'final_holdout').map((c) => [c.caseId, c]));
  const judges = new Set(key.key.map((entry) => entry.judgeId));
  const keyIdentities = key.key.map((entry) => `${entry.judgeId}:${entry.caseId}`);
  if (new Set(keyIdentities).size !== keyIdentities.length) throw new Error('Study key repeats a judge/case pair');
  const eligibleLineages = new Set([...cases.values()].map((c) => c.duplicateGroup));
  const choices = new Map<string, StudyVote>();
  let missing = 0, cannotJudge = 0, validVotes = 0, ties = 0;
  for (const judgeId of judges) {
    const source = input.ratingsByJudge[judgeId];
    if (source === undefined) { missing += key.key.filter((entry) => entry.judgeId === judgeId).length; continue; }
    const expected = new Set(key.key.filter((entry) => entry.judgeId === judgeId).map((entry) => entry.pairId));
    const observed = new Set<string>();
    for (const vote of parseStudyRatingsCsv(source)) {
      if (!expected.has(vote.pairId) || observed.has(vote.pairId)) throw new Error(`${judgeId}: unknown or duplicate pair ID ${vote.pairId}`);
      observed.add(vote.pairId);
      choices.set(`${judgeId}:${vote.pairId}`, vote);
    }
    missing += expected.size - observed.size;
  }
  const scores = new Map<string, number[]>();
  for (const entry of key.key) {
    if (!cases.has(entry.caseId)) throw new Error(`Pair key references non-holdout case ${entry.caseId}`);
    const vote = choices.get(`${entry.judgeId}:${entry.pairId}`);
    if (!vote || vote.choice === '') { if (vote) missing++; continue; }
    if (vote.choice === 'cannot_judge') { cannotJudge++; continue; }
    validVotes++;
    if (vote.choice === 'tie') ties++;
    const score = vote.choice === 'tie' ? 0.5 : vote.choice === entry.candidateSide ? 1 : 0;
    scores.set(entry.caseId, [...(scores.get(entry.caseId) || []), score]);
  }
  const caseScores = new Map<string, number>();
  let belowThree = 0;
  for (const caseId of cases.keys()) {
    const votes = scores.get(caseId) || [];
    if (votes.length < 3) belowThree++;
    if (votes.length) caseScores.set(caseId, mean(votes));
  }
  const groups = new Map<string, number[]>();
  for (const [caseId, score] of caseScores) {
    const group = cases.get(caseId)!.duplicateGroup;
    groups.set(group, [...(groups.get(group) || []), score]);
  }
  const groupScores = [...groups.values()].map(mean);
  const complete = missing === 0 && cannotJudge === 0 && belowThree === 0 &&
    key.key.length === cases.size * judges.size && groupScores.length === eligibleLineages.size && groupScores.length > 0;
  let preference: { point: number; lower95: number; upper95: number; superiorityThresholdMet: boolean } | null = null;
  if (groupScores.length) {
    const point = mean(groupScores);
    const [{ lower95, upper95 }] = bootstrapLineageMeans(groupScores.map((score) => [score]), key.seed,
      key.analysisPlan.bootstrapIterations);
    preference = { point, lower95, upper95,
      superiorityThresholdMet: complete && point >= key.analysisPlan.superiorityPoint && lower95 > key.analysisPlan.superiorityLower95 };
  }
  const summary = (field: 'language' | 'clientId'): Record<string, { cases: number; mean: number | null }> => {
    const by = new Map<string, number[]>();
    const totals = new Map<string, number>();
    for (const [caseId, c] of cases) {
      const label = c[field];
      totals.set(label, (totals.get(label) || 0) + 1);
      if (caseScores.has(caseId)) by.set(label, [...(by.get(label) || []), caseScores.get(caseId)!]);
    }
    return Object.fromEntries([...totals].map(([label, count]) => [label, { cases: count, mean: by.get(label)?.length ? mean(by.get(label)!) : null }]));
  };
  return { status: complete ? 'ANALYSIS_PENDING_INDEPENDENT_VERIFICATION' : 'INCOMPLETE', admissionQualified: false,
    counts: { cases: cases.size, independentLineages: eligibleLineages.size, expectedVotes: key.key.length, validVotes, ties, cannotJudge, missing, casesBelowThreeValidVotes: belowThree },
    preference, byLanguage: summary('language'), byClient: summary('clientId') };
}
