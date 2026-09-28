import { describe, expect, it } from 'vitest';
import { analyzeCurrentExportVotes, parseStudyRatingsCsv, type StudyKey } from '../src/research-study/analyze.js';
import type { CorpusManifest } from '../src/corpus/corpus-manifest.js';

const hash = 'a'.repeat(64);
const corpus = {
  schemaVersion: 1, status: 'machine_sealed_pending_review', seedSha256: hash,
  counts: { total: 200, clients: 3,
    bySplit: { development: 80, calibration: 20, final_holdout: 100 },
    byLanguage: { en: 50, ckb: 50, ar: 50, mixed: 50 } },
  cases: [
    { caseId: 'case-1', split: 'final_holdout', duplicateGroup: 'same-lineage', clientId: 'client-a', language: 'en' },
    { caseId: 'case-2', split: 'final_holdout', duplicateGroup: 'same-lineage', clientId: 'client-a', language: 'ckb' },
  ],
} as CorpusManifest;

const key: StudyKey = {
  schemaVersion: 1, status: 'packaged_pending_human_ratings', seed: '1234567890abcdef1234567890abcdef',
  analysisPlan: { unit: 'duplicateGroup', weighting: 'equal_lineage', bootstrapIterations: 10_000,
    tieScore: 0.5, superiorityPoint: 0.60, superiorityLower95: 0.50 },
  key: ['j1', 'j2', 'j3'].flatMap((judgeId) => ['case-1', 'case-2'].map((caseId) => ({
    judgeId, caseId, pairId: `pair-${caseId.slice(-1)}`, candidateSide: 'A' as const,
    leftPngSha256: hash, rightPngSha256: hash, briefSha256: hash,
  }))),
};

describe('brief-lineage-clustered study analysis', () => {
  it('parses quoted notes and counts a completed all-candidate preference without declaring product admission', () => {
    expect(parseStudyRatingsCsv('pairId,choice,reason,defectTags\npair-1,A,"better, cleaner","type, crop"\n')[0].reason)
      .toBe('better, cleaner');
    const ratingsByJudge = Object.fromEntries(['j1', 'j2', 'j3'].map((j) => [j,
      'pairId,choice,reason,defectTags\npair-1,A,,\npair-2,A,,\n']));
    const result = analyzeCurrentExportVotes({ key, corpus, ratingsByJudge });
    expect(result.status).toBe('ANALYSIS_PENDING_INDEPENDENT_VERIFICATION');
    expect(result.admissionQualified).toBe(false);
    expect(result.counts).toMatchObject({ cases: 2, independentLineages: 1, validVotes: 6, missing: 0 });
    expect(result.preference).toMatchObject({ point: 1, lower95: 1, upper95: 1, superiorityThresholdMet: true });
    expect(analyzeCurrentExportVotes({ key, corpus, ratingsByJudge })).toEqual(result);
  });

  it('keeps missing and cannot-judge votes in the denominator and refuses duplicate pair rows', () => {
    const ratingsByJudge = {
      j1: 'pairId,choice,reason,defectTags\npair-1,tie,,\npair-2,cannot_judge,,\n',
      j2: 'pairId,choice,reason,defectTags\npair-1,B,,\npair-2,,,\n',
    };
    const result = analyzeCurrentExportVotes({ key, corpus, ratingsByJudge });
    expect(result.status).toBe('INCOMPLETE');
    expect(result.counts).toMatchObject({ expectedVotes: 6, validVotes: 2, ties: 1, cannotJudge: 1, missing: 3, casesBelowThreeValidVotes: 2 });
    expect(result.preference?.superiorityThresholdMet).toBe(false);
    expect(() => analyzeCurrentExportVotes({ key, corpus, ratingsByJudge: {
      ...ratingsByJudge, j1: ratingsByJudge.j1 + 'pair-1,A,,\n',
    } })).toThrow(/unknown or duplicate pair/);
  });
});
