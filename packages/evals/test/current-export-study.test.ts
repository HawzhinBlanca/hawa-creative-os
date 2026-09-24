import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { buildCorpusManifest, type CorpusCandidate } from '../src/corpus/corpus-manifest.js';
import { checkCurrentExportStudy, packageCurrentExportStudy } from '../../../scripts/package_current_export_study.js';
import { analyzeStudyDirectory } from '../../../scripts/analyze_current_export_study.js';

const sha = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
const seed = '1234567890abcdef1234567890abcdef';
const commit = 'a'.repeat(40);
const hex64 = 'b'.repeat(64);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const label = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([size, label, data, checksum]);
}

function pngFor(id: string): Buffer {
  const width = 16, height = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const key = Buffer.from(sha(id), 'hex');
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const pixel = offset + 1 + x * 4;
      raw[pixel] = key[(x + y) % key.length];
      raw[pixel + 1] = key[(x * 3 + y) % key.length];
      raw[pixel + 2] = key[(x + y * 5) % key.length];
      raw[pixel + 3] = 255;
    }
  }
  const metadata = id.endsWith('-candidate') ? chunk('tEXt', Buffer.from('Arm\0candidate-arm-secret')) : Buffer.alloc(0);
  const colorProfile = id.endsWith('-candidate')
    ? chunk('iCCP', Buffer.concat([Buffer.from('candidate-profile-name\0\0'), deflateSync(Buffer.from('fixture color profile'))]))
    : Buffer.alloc(0);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), metadata, colorProfile,
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('current final-export blind study', () => {
  it('packages every sealed holdout export into blind judge folders and refuses tampered bytes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawa-study-'));
    const output = path.resolve(`data/evaluations/study-test-${crypto.randomBytes(6).toString('hex')}`);
    try {
      const candidates: CorpusCandidate[] = Array.from({ length: 200 }, (_, i) => {
        const brief = Buffer.from(`Private synthetic brief ${sha(`brief-${i}`)}`);
        fs.writeFileSync(path.join(tmp, `brief-${i}.txt`), brief);
        return {
          caseId: `case-${i}`, clientId: `client-${i % 3}`, campaignId: `campaign-${i}`,
          requestLineageId: `request-${i}`, language: (['en', 'ckb', 'ar', 'mixed'] as const)[i % 4],
          format: 'square', taskClass: 'event', sourceKind: 'historical', sourceRecordedAt: '2026-09-01',
          evaluationApprovedBy: 'fixture-reviewer', evaluationApprovedAt: '2026-09-20',
          approvalEvidenceSha256: sha(`approval-${i}`), previouslyUsedForTuning: false,
          briefSha256: sha(brief), assetSha256: [], normalizedBrief: sha(`unique-${i}`),
        };
      });
      const corpus = buildCorpusManifest(candidates, seed, true);
      const corpusBytes = Buffer.from(JSON.stringify(corpus));
      fs.writeFileSync(path.join(tmp, 'corpus.json'), corpusBytes);
      fs.writeFileSync(path.join(tmp, 'review.json'), JSON.stringify({
        corpusManifestSha256: sha(corpusBytes), reviewerId: 'independent-fixture', reviewedAt: '2026-09-24',
        rightsConfirmed: true, lineageConfirmed: true, visualDuplicatesChecked: true, strataAccepted: true,
      }));
      fs.writeFileSync(path.join(tmp, 'prereg.json'), JSON.stringify({
        studyId: 'synthetic-study', registeredBy: 'fixture-reviewer', registeredAt: '2026-09-24',
        corpusManifestSha256: sha(corpusBytes), seedSha256: sha(seed), primaryEndpoint: 'brief_level_preference',
        expectedCases: 100, expectedJudges: 3, minValidJudgesPerBrief: 3,
        analysisPlan: { unit: 'duplicateGroup', weighting: 'equal_lineage', bootstrapIterations: 10_000,
          tieScore: 0.5, superiorityPoint: 0.60, superiorityLower95: 0.50 },
      }));
      const deployment = {
        evidenceKind: 'observed_deployment', status: 'image_runtime_migration_verified', buildCommit: commit,
        sourceManifestSha256: hex64, migration: { observedApplied: { sha256: hex64 } },
        images: Object.fromEntries(['core', 'desk', 'worker'].map((service) => [service, { imageId: `sha256:${hex64}`, revisionLabel: commit }])),
      };
      const deploymentBytes = Buffer.from(JSON.stringify(deployment));
      fs.writeFileSync(path.join(tmp, 'deployment.json'), deploymentBytes);
      const pairs = corpus.cases.filter((c) => c.split === 'final_holdout').map((c) => {
        const arms = Object.fromEntries(['current', 'candidate'].map((arm) => {
          const base = `${c.caseId}-${arm}`;
          const png = pngFor(base);
          const source = Buffer.from(`source ${base}`);
          const qc = Buffer.from(`qc ${base}`);
          fs.writeFileSync(path.join(tmp, `${base}.png`), png);
          fs.writeFileSync(path.join(tmp, `${base}.source`), source);
          fs.writeFileSync(path.join(tmp, `${base}.qc`), qc);
          const proof = { kind: 'observed_canva_final_export', designId: `design-${base}`, revisionId: `rev-${base}`,
            sourceArtifactSha256: sha(source), qcReportSha256: sha(qc), deploymentReceiptSha256: sha(deploymentBytes),
            sourceCommit: commit, pngSha256: sha(png), width: 16, height: 16, capturedAt: '2026-09-24' };
          fs.writeFileSync(path.join(tmp, `${base}.proof.json`), JSON.stringify(proof));
          return [arm, { pngPath: `${base}.png`, exportProofPath: `${base}.proof.json`, sourceArtifactPath: `${base}.source`,
            qcReportPath: `${base}.qc`, deploymentReceiptPath: 'deployment.json' }];
        }));
        return { caseId: c.caseId, briefPath: `brief-${c.caseId.slice(5)}.txt`, ...arms };
      });
      fs.writeFileSync(path.join(tmp, 'study.json'), JSON.stringify({ corpusManifestPath: 'corpus.json',
        corpusReviewPath: 'review.json', preregistrationPath: 'prereg.json', seed,
        judges: ['judge-1', 'judge-2', 'judge-3'], pairs }));
      const config = path.join(tmp, 'study.json');
      expect(checkCurrentExportStudy(config).pairs).toHaveLength(100);
      expect(packageCurrentExportStudy(config, output)).toBe(output);
      const key = JSON.parse(fs.readFileSync(path.join(output, 'private/key.json'), 'utf8'));
      expect(key.status).toBe('packaged_pending_human_ratings');
      expect(key.key).toHaveLength(300);
      expect(fs.existsSync(path.join(output, 'private', 'corpus-manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(output, 'private', 'evidence', key.key[0].pairId, 'candidate', 'final.png'))).toBe(true);
      expect(fs.readFileSync(path.join(output, 'private', 'evidence', key.key[0].pairId, 'candidate', 'final.png')).toString('latin1'))
        .toContain('candidate-arm-secret');
      expect(fs.readFileSync(path.join(output, 'private', 'evidence', key.key[0].pairId, 'candidate', 'final.png')).toString('latin1'))
        .toContain('candidate-profile-name');
      for (const judge of ['judge-1', 'judge-2', 'judge-3']) {
        const folder = path.join(output, 'raters', judge);
        expect(fs.existsSync(path.join(folder, 'key.json'))).toBe(false);
        expect(fs.readdirSync(folder).filter((name) => name.startsWith('pair-'))).toHaveLength(100);
        expect(key.key.filter((entry: any) => entry.judgeId === judge && entry.candidateSide === 'A')).toHaveLength(50);
      }
      const analysis = analyzeStudyDirectory(output);
      expect(analysis.status).toBe('INCOMPLETE');
      for (const judge of ['judge-1', 'judge-2', 'judge-3']) {
        const rows = key.key.filter((entry: any) => entry.judgeId === judge)
          .map((entry: any) => `${entry.pairId},${entry.candidateSide},,`);
        fs.writeFileSync(path.join(output, 'raters', judge, 'ratings.csv'),
          ['pairId,choice,reason,defectTags', ...rows].join('\n') + '\n');
      }
      const rated = analyzeStudyDirectory(output);
      const ratedEvidence = JSON.parse(fs.readFileSync(rated.file, 'utf8'));
      expect(rated.status).toBe('ANALYSIS_PENDING_INDEPENDENT_VERIFICATION');
      expect(ratedEvidence.result.admissionQualified).toBe(false);
      expect(ratedEvidence.result.preference.point).toBe(1);
      const raterImage = path.join(output, 'raters', key.key[0].judgeId, key.key[0].pairId, 'A.png');
      const originalRaterImage = fs.readFileSync(raterImage);
      expect(originalRaterImage.toString('latin1')).not.toContain('candidate-arm-secret');
      expect(originalRaterImage.toString('latin1')).not.toContain('candidate-profile-name');
      expect(fs.readFileSync(path.join(path.dirname(raterImage), 'B.png')).toString('latin1'))
        .not.toContain('candidate-arm-secret');
      expect(fs.readFileSync(path.join(path.dirname(raterImage), 'B.png')).toString('latin1'))
        .not.toContain('candidate-profile-name');
      fs.appendFileSync(raterImage, 'tampered');
      expect(() => analyzeStudyDirectory(output)).toThrow(/Rater package bytes changed/);
      fs.writeFileSync(raterImage, originalRaterImage);
      expect(() => packageCurrentExportStudy(config, output)).toThrow(/new direct child/);
      const first = pairs[0] as any;
      const reviewFile = path.join(tmp, 'review.json');
      const originalReview = fs.readFileSync(reviewFile);
      fs.writeFileSync(reviewFile, JSON.stringify({ ...JSON.parse(originalReview.toString()), rightsConfirmed: false }));
      expect(() => checkCurrentExportStudy(config)).toThrow(/rights, lineage/);
      fs.writeFileSync(reviewFile, originalReview);
      const preregFile = path.join(tmp, 'prereg.json');
      const originalPrereg = fs.readFileSync(preregFile);
      fs.writeFileSync(preregFile, JSON.stringify({ ...JSON.parse(originalPrereg.toString()), expectedCases: 99 }));
      expect(() => checkCurrentExportStudy(config)).toThrow(/Frozen study-specific preregistration/);
      fs.writeFileSync(preregFile, originalPrereg);
      const sourceFile = path.join(tmp, first.current.sourceArtifactPath);
      const originalSource = fs.readFileSync(sourceFile);
      fs.appendFileSync(sourceFile, 'tampered');
      expect(() => checkCurrentExportStudy(config)).toThrow(/source artifact or QC report hash differs/);
      fs.writeFileSync(sourceFile, originalSource);
      const deploymentFile = path.join(tmp, 'deployment.json');
      const originalDeployment = fs.readFileSync(deploymentFile);
      const proofFile = path.join(tmp, first.current.exportProofPath);
      const originalProof = fs.readFileSync(proofFile);
      const forgedDeployment = JSON.parse(originalDeployment.toString());
      forgedDeployment.images.core.revisionLabel = 'wrong';
      const forgedBytes = Buffer.from(JSON.stringify(forgedDeployment));
      fs.writeFileSync(deploymentFile, forgedBytes);
      fs.writeFileSync(proofFile, JSON.stringify({ ...JSON.parse(originalProof.toString()), deploymentReceiptSha256: sha(forgedBytes) }));
      expect(() => checkCurrentExportStudy(config)).toThrow(/deployment image identity is incomplete/);
      fs.writeFileSync(deploymentFile, originalDeployment);
      fs.writeFileSync(proofFile, originalProof);
      fs.appendFileSync(path.join(tmp, first.candidate.pngPath), 'tampered');
      expect(() => checkCurrentExportStudy(config)).toThrow(/PNG hash differs/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(output, { recursive: true, force: true });
    }
  });
});
