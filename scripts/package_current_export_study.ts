import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectPngExport, stripPngStudyMetadata } from '../packages/creative/src/studio/png-export.js';
import type { CorpusManifest } from '../packages/evals/src/corpus/corpus-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'data/evaluations');
const hash = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
const hex64 = /^[0-9a-f]{64}$/;
const hex40 = /^[0-9a-f]{40}$/;

interface ExportProof {
  kind: 'observed_canva_final_export';
  designId: string;
  revisionId: string;
  sourceArtifactSha256: string;
  qcReportSha256: string;
  deploymentReceiptSha256: string;
  sourceCommit: string;
  pngSha256: string;
  width: number;
  height: number;
  capturedAt: string;
}

interface ArmFiles {
  pngPath: string;
  exportProofPath: string;
  deploymentReceiptPath: string;
  sourceArtifactPath: string;
  qcReportPath: string;
}
interface PairInput { caseId: string; briefPath: string; current: ArmFiles; candidate: ArmFiles }
interface StudyConfig {
  corpusManifestPath: string;
  corpusReviewPath: string;
  preregistrationPath: string;
  seed: string;
  judges: string[];
  pairs: PairInput[];
}

interface StudyAnalysisPlan {
  unit: 'duplicateGroup';
  weighting: 'equal_lineage';
  bootstrapIterations: 10_000;
  tieScore: 0.5;
  superiorityPoint: 0.60;
  superiorityLower95: 0.50;
}

interface CheckedArm {
  pngPath: string; sourcePath: string; qcPath: string; proofPath: string; deploymentPath: string;
  proof: ExportProof; proofSha256: string; deploymentReceiptSha256: string;
}
interface CheckedPair { caseId: string; briefPath: string; briefSha256: string; current: CheckedArm; candidate: CheckedArm }

function readReferenced(base: string, reference: string): Buffer {
  if (!reference || typeof reference !== 'string') throw new Error('Missing study source path');
  const full = path.resolve(base, reference);
  const stat = fs.statSync(full);
  if (!stat.isFile() || stat.size < 1 || stat.size > 100 * 1024 * 1024) throw new Error(`Missing or oversized study source: ${reference}`);
  return fs.readFileSync(full);
}

function checkArm(base: string, files: ArmFiles, caseId: string, arm: string): CheckedArm {
  const bytes = readReferenced(base, files.pngPath);
  const proofBytes = readReferenced(base, files.exportProofPath);
  const proof = JSON.parse(proofBytes.toString('utf8')) as ExportProof;
  if (proof.kind !== 'observed_canva_final_export' || !proof.designId || !proof.revisionId ||
      !hex64.test(proof.sourceArtifactSha256 || '') || !hex64.test(proof.qcReportSha256 || '') ||
      !hex64.test(proof.deploymentReceiptSha256 || '') || !hex40.test(proof.sourceCommit || '') ||
      !hex64.test(proof.pngSha256 || '') || !Number.isFinite(Date.parse(proof.capturedAt))) {
    throw new Error(`${caseId}/${arm}: final Canva export provenance is incomplete`);
  }
  if (hash(bytes) !== proof.pngSha256) throw new Error(`${caseId}/${arm}: exported PNG hash differs from its proof`);
  if (hash(readReferenced(base, files.sourceArtifactPath)) !== proof.sourceArtifactSha256 ||
      hash(readReferenced(base, files.qcReportPath)) !== proof.qcReportSha256) {
    throw new Error(`${caseId}/${arm}: source artifact or QC report hash differs from its proof`);
  }
  const dimensions = inspectPngExport(bytes);
  if (dimensions.width !== proof.width || dimensions.height !== proof.height) {
    throw new Error(`${caseId}/${arm}: PNG dimensions differ from its proof`);
  }
  const deploymentBytes = readReferenced(base, files.deploymentReceiptPath);
  const deploymentReceiptSha256 = hash(deploymentBytes);
  const deployment = JSON.parse(deploymentBytes.toString('utf8'));
  if (deploymentReceiptSha256 !== proof.deploymentReceiptSha256 || deployment.evidenceKind !== 'observed_deployment' ||
      deployment.status !== 'image_runtime_migration_verified' || deployment.buildCommit !== proof.sourceCommit) {
    throw new Error(`${caseId}/${arm}: final export is not bound to an observed deployment receipt`);
  }
  for (const service of ['core', 'desk', 'worker']) {
    const image = deployment.images?.[service];
    if (!/^sha256:[0-9a-f]{64}$/.test(image?.imageId || '') || image?.revisionLabel !== proof.sourceCommit) {
      throw new Error(`${caseId}/${arm}: deployment image identity is incomplete`);
    }
  }
  if (!hex64.test(deployment.sourceManifestSha256 || '') || !hex64.test(deployment.migration?.observedApplied?.sha256 || '')) {
    throw new Error(`${caseId}/${arm}: deployment manifest or migration identity is incomplete`);
  }
  return { pngPath: path.resolve(base, files.pngPath), sourcePath: path.resolve(base, files.sourceArtifactPath),
    qcPath: path.resolve(base, files.qcReportPath), proofPath: path.resolve(base, files.exportProofPath),
    deploymentPath: path.resolve(base, files.deploymentReceiptPath),
    proof, proofSha256: hash(proofBytes), deploymentReceiptSha256 };
}

/** Verifies every final-holdout pair before creating any rater files. */
export function checkCurrentExportStudy(configFile: string): {
  config: StudyConfig;
  pairs: CheckedPair[];
  corpusSha256: string;
  reviewSha256: string;
  preregistrationSha256: string;
  analysisPlan: StudyAnalysisPlan;
} {
  const base = path.dirname(path.resolve(configFile));
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as StudyConfig;
  if (!/^[0-9a-f]{32,128}$/i.test(config.seed || '')) throw new Error('A predeclared hex study seed is required');
  if (!Array.isArray(config.judges) || config.judges.length < 3 || new Set(config.judges).size !== config.judges.length ||
      config.judges.some((j) => !/^[a-z0-9_-]{2,40}$/i.test(j))) {
    throw new Error('At least three distinct opaque judge IDs are required');
  }
  const corpusBytes = readReferenced(base, config.corpusManifestPath);
  const corpusSha256 = hash(corpusBytes);
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as CorpusManifest;
  if (corpus.schemaVersion !== 1 || corpus.status !== 'machine_sealed_pending_review' ||
      corpus.counts.total < 200 || corpus.counts.bySplit.final_holdout < 100) {
    throw new Error('Study requires a machine-sealed 200-case corpus with at least 100 final holdout cases');
  }
  const reviewBytes = readReferenced(base, config.corpusReviewPath);
  const review = JSON.parse(reviewBytes.toString('utf8'));
  if (review.corpusManifestSha256 !== corpusSha256 || !review.reviewerId ||
      !Number.isFinite(Date.parse(review.reviewedAt)) ||
      review.rightsConfirmed !== true || review.lineageConfirmed !== true ||
      review.visualDuplicatesChecked !== true || review.strataAccepted !== true) {
    throw new Error('Independent corpus rights, lineage, visual duplicate and strata review is missing');
  }
  const preregistration = readReferenced(base, config.preregistrationPath);
  const holdout = new Map(corpus.cases.filter((c) => c.split === 'final_holdout').map((c) => [c.caseId, c]));
  const prereg = JSON.parse(preregistration.toString('utf8'));
  const analysisPlan = prereg.analysisPlan as StudyAnalysisPlan;
  if (!prereg.studyId || !prereg.registeredBy || !Number.isFinite(Date.parse(prereg.registeredAt)) ||
      prereg.corpusManifestSha256 !== corpusSha256 || prereg.seedSha256 !== hash(config.seed) ||
      prereg.primaryEndpoint !== 'brief_level_preference' || prereg.expectedCases !== holdout.size ||
      prereg.expectedJudges !== config.judges.length || prereg.minValidJudgesPerBrief !== 3 ||
      analysisPlan?.unit !== 'duplicateGroup' || analysisPlan?.weighting !== 'equal_lineage' ||
      analysisPlan?.bootstrapIterations !== 10_000 || analysisPlan?.tieScore !== 0.5 ||
      analysisPlan?.superiorityPoint !== 0.60 || analysisPlan?.superiorityLower95 !== 0.50) {
    throw new Error('Frozen study-specific preregistration does not match corpus, seed, judges or analysis rule');
  }
  if (!Array.isArray(config.pairs) || config.pairs.length !== holdout.size) {
    throw new Error('Every final holdout case needs one current/candidate export pair');
  }
  const seen = new Set<string>();
  const exportHashes = new Set<string>();
  const pairs = config.pairs.map((pair) => {
    if (!holdout.has(pair.caseId) || seen.has(pair.caseId)) throw new Error(`Unknown or duplicate final holdout case: ${pair.caseId}`);
    seen.add(pair.caseId);
    const brief = readReferenced(base, pair.briefPath);
    if (hash(brief) !== holdout.get(pair.caseId)!.briefSha256) throw new Error(`${pair.caseId}: study brief differs from corpus`);
    const current = checkArm(base, pair.current, pair.caseId, 'current');
    const candidate = checkArm(base, pair.candidate, pair.caseId, 'candidate');
    if (current.proof.pngSha256 === candidate.proof.pngSha256) throw new Error(`${pair.caseId}: arms use identical export bytes`);
    for (const digest of [current.proof.pngSha256, candidate.proof.pngSha256]) {
      if (exportHashes.has(digest)) throw new Error(`${pair.caseId}: final export bytes were reused for another case`);
      exportHashes.add(digest);
    }
    if (current.proof.width !== candidate.proof.width || current.proof.height !== candidate.proof.height) {
      throw new Error(`${pair.caseId}: comparison arms have different dimensions`);
    }
    return { caseId: pair.caseId, briefPath: path.resolve(base, pair.briefPath), briefSha256: hash(brief), current, candidate };
  });
  return { config, pairs, corpusSha256, reviewSha256: hash(reviewBytes),
    preregistrationSha256: hash(preregistration), analysisPlan };
}

/** The private key and judge folders are siblings. Only a judge's folder is shared with that judge. */
export function packageCurrentExportStudy(configFile: string, outputDir: string): string {
  const checked = checkCurrentExportStudy(configFile);
  const output = path.resolve(outputDir);
  if (path.dirname(output) !== outputRoot || fs.existsSync(output)) {
    throw new Error('Study output must be a new direct child of data/evaluations');
  }
  if ((fs.existsSync(path.join(root, 'data')) && fs.lstatSync(path.join(root, 'data')).isSymbolicLink()) ||
      (fs.existsSync(outputRoot) && fs.lstatSync(outputRoot).isSymbolicLink())) {
    throw new Error('Study output root cannot be a symlink');
  }
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(outputRoot, '.study-tmp-'));
  try {
    const privateDir = path.join(temporary, 'private');
    const ratersDir = path.join(temporary, 'raters');
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.mkdirSync(ratersDir, { mode: 0o700 });
    const configBase = path.dirname(path.resolve(configFile));
    for (const [name, reference, expected] of [
      ['corpus-manifest.json', checked.config.corpusManifestPath, checked.corpusSha256],
      ['corpus-review.json', checked.config.corpusReviewPath, checked.reviewSha256],
      ['preregistration.json', checked.config.preregistrationPath, checked.preregistrationSha256],
    ] as const) {
      const bytes = readReferenced(configBase, reference);
      if (hash(bytes) !== expected) throw new Error(`${name} changed during study packaging`);
      fs.writeFileSync(path.join(privateDir, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    const evidenceRoot = path.join(privateDir, 'evidence');
    fs.mkdirSync(evidenceRoot, { mode: 0o700 });
    for (const pair of checked.pairs) {
      const pairId = `pair-${hash(`${checked.config.seed}:${pair.caseId}`).slice(0, 12)}`;
      const pairDir = path.join(evidenceRoot, pairId);
      fs.mkdirSync(pairDir, { mode: 0o700 });
      for (const [armName, arm] of [['current', pair.current], ['candidate', pair.candidate]] as const) {
        const armDir = path.join(pairDir, armName);
        fs.mkdirSync(armDir, { mode: 0o700 });
        for (const [name, source, expected] of [
          ['final.png', arm.pngPath, arm.proof.pngSha256],
          ['source.bin', arm.sourcePath, arm.proof.sourceArtifactSha256],
          ['qc.bin', arm.qcPath, arm.proof.qcReportSha256],
          ['export-proof.json', arm.proofPath, arm.proofSha256],
          ['deployment-receipt.json', arm.deploymentPath, arm.deploymentReceiptSha256],
        ] as const) {
          const bytes = fs.readFileSync(source);
          if (hash(bytes) !== expected) throw new Error(`${pair.caseId}/${armName}: ${name} changed during packaging`);
          fs.writeFileSync(path.join(armDir, name), bytes, { flag: 'wx', mode: 0o600 });
        }
      }
    }
    const key: Record<string, unknown>[] = [];
    checked.config.judges.forEach((judgeId, judgeIndex) => {
      const judgeDir = path.join(ratersDir, judgeId);
      fs.mkdirSync(judgeDir, { mode: 0o700 });
      const ordered = [...checked.pairs].sort((a, b) => hash(`${checked.config.seed}:${judgeId}:${a.caseId}`).localeCompare(hash(`${checked.config.seed}:${judgeId}:${b.caseId}`)));
      const rows = ['pairId,choice,reason,defectTags'];
      ordered.forEach((pair, index) => {
        const pairId = `pair-${hash(`${checked.config.seed}:${pair.caseId}`).slice(0, 12)}`;
        const candidateLeft = (index + judgeIndex) % 2 === 0;
        const pairDir = path.join(judgeDir, pairId);
        fs.mkdirSync(pairDir, { mode: 0o700 });
        const left = candidateLeft ? pair.candidate : pair.current;
        const right = candidateLeft ? pair.current : pair.candidate;
        const leftBytes = fs.readFileSync(left.pngPath);
        const rightBytes = fs.readFileSync(right.pngPath);
        const briefBytes = fs.readFileSync(pair.briefPath);
        if (hash(leftBytes) !== left.proof.pngSha256 || hash(rightBytes) !== right.proof.pngSha256 ||
            hash(briefBytes) !== pair.briefSha256) {
          throw new Error(`${pair.caseId}: source bytes changed during study packaging`);
        }
        const blindLeft = stripPngStudyMetadata(leftBytes);
        const blindRight = stripPngStudyMetadata(rightBytes);
        fs.writeFileSync(path.join(pairDir, 'A.png'), blindLeft, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(pairDir, 'B.png'), blindRight, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(pairDir, 'brief.txt'), briefBytes, { flag: 'wx', mode: 0o600 });
        rows.push(`${pairId},,,`);
        key.push({ judgeId, pairId, caseId: pair.caseId, candidateSide: candidateLeft ? 'A' : 'B',
          leftPngSha256: hash(blindLeft), rightPngSha256: hash(blindRight),
          briefSha256: pair.briefSha256,
          currentExportProofSha256: pair.current.proofSha256, candidateExportProofSha256: pair.candidate.proofSha256,
          currentDeploymentReceiptSha256: pair.current.deploymentReceiptSha256,
          candidateDeploymentReceiptSha256: pair.candidate.deploymentReceiptSha256 });
      });
      fs.writeFileSync(path.join(judgeDir, 'ratings.csv'), rows.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    });
    const privateManifest = {
      schemaVersion: 1, status: 'packaged_pending_human_ratings', corpusManifestSha256: checked.corpusSha256,
      corpusReviewSha256: checked.reviewSha256, preregistrationSha256: checked.preregistrationSha256,
      seed: checked.config.seed, judgeCount: checked.config.judges.length, pairCount: checked.pairs.length,
      analysisPlan: checked.analysisPlan, key,
    };
    const bytes = Buffer.from(JSON.stringify(privateManifest, null, 2) + '\n');
    fs.writeFileSync(path.join(privateDir, 'key.json'), bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(privateDir, 'key.sha256'), `${hash(bytes)}  key.json\n`, { flag: 'wx', mode: 0o600 });
    if (fs.existsSync(output)) throw new Error('Study output appeared during packaging; refusing overwrite');
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [config, output] = process.argv.slice(2);
  if (!config || !output) {
    console.error('Usage: package_current_export_study.ts <private-config.json> <data/evaluations/new-study-name>');
    process.exit(2);
  }
  try { console.log(packageCurrentExportStudy(config, output)); }
  catch (error) { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
