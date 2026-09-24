import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildCorpusManifest, type CorpusCandidate } from '../src/corpus/corpus-manifest.js';
import { loadCorpusCandidates } from '../../../scripts/build_eval_corpus.js';

const hash = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const seed = '1234567890abcdef1234567890abcdef';

function candidate(i: number): CorpusCandidate {
  const text = hash(`distinct approved brief ${i}`);
  return {
    caseId: `case-${i}`, clientId: `client-${i % 3}`, campaignId: `campaign-${i}`,
    requestLineageId: `request-${i}`, language: (['ckb', 'en', 'ar', 'mixed'] as const)[i % 4],
    format: 'square', taskClass: 'event', sourceKind: 'historical',
    sourceRecordedAt: '2026-09-01', evaluationApprovedBy: `approval-actor-${i}`,
    evaluationApprovedAt: '2026-09-20', approvalEvidenceSha256: hash(`approval-${i}`),
    previouslyUsedForTuning: false, briefSha256: hash(text), assetSha256: [], normalizedBrief: text,
  };
}

describe('private research corpus split and provenance', () => {
  it('keeps derivatives, sibling requests and tuning material out of the final holdout', () => {
    const cases = [candidate(1), candidate(2), candidate(3), candidate(4)];
    cases[1].campaignId = cases[0].campaignId;
    cases[1].clientId = cases[0].clientId;
    cases[2].derivativeOf = cases[0].caseId;
    cases[2].previouslyUsedForTuning = true;
    const manifest = buildCorpusManifest(cases, seed);
    expect(manifest.cases.filter((c) => [cases[0].caseId, cases[1].caseId, cases[2].caseId].includes(c.caseId)).map((c) => c.split))
      .toEqual(['development', 'development', 'development']);
    expect(manifest.cases[0].duplicateGroup).toBe(manifest.cases[1].duplicateGroup);
    expect(JSON.stringify(manifest)).not.toContain(cases[0].normalizedBrief);
    expect(() => buildCorpusManifest(cases, seed, true)).toThrow(/at least 200 authorized cases/);
  });

  it('seals only a sufficiently large, multi-client and reproducible holdout', () => {
    const cases = Array.from({ length: 200 }, (_, i) => candidate(i));
    const first = buildCorpusManifest(cases, seed, true);
    const again = buildCorpusManifest([...cases].reverse(), seed, true);
    expect(first.status).toBe('machine_sealed_pending_review');
    expect(first.counts).toMatchObject({ total: 200, clients: 3,
      bySplit: { development: 80, calibration: 20, final_holdout: 100 } });
    expect(again.cases.map((c) => `${c.caseId}:${c.split}`)).toEqual(first.cases.map((c) => `${c.caseId}:${c.split}`));
  });

  it('refuses missing approval evidence and a private-source path escaping through a symlink', () => {
    expect(() => buildCorpusManifest([{ ...candidate(1), approvalEvidenceSha256: '' }], seed)).toThrow(/source hashes required/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-corpus-'));
    try {
      fs.writeFileSync(path.join(dir, 'approval.txt'), 'approved fixture');
      fs.symlinkSync('/etc/hosts', path.join(dir, 'outside.txt'));
      fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify({ cases: [{
        ...candidate(1), briefFile: 'outside.txt', approvalFile: 'approval.txt', assetFiles: [],
      }] }));
      expect(() => loadCorpusCandidates(path.join(dir, 'cases.json'))).toThrow(/escapes the private corpus directory/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
