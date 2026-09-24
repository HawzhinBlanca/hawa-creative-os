import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { analyzeCurrentExportVotes, type StudyKey } from '../packages/evals/src/research-study/analyze.js';
import type { CorpusManifest } from '../packages/evals/src/corpus/corpus-manifest.js';

const hash = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');

export function analyzeStudyDirectory(studyDirectory: string, corpusFile?: string): { file: string; status: string } {
  const study = fs.realpathSync(studyDirectory);
  const privateDir = path.join(study, 'private');
  const keyBytes = fs.readFileSync(path.join(privateDir, 'key.json'));
  const declaredKeyHash = fs.readFileSync(path.join(privateDir, 'key.sha256'), 'utf8').trim().split(/\s+/)[0];
  if (hash(keyBytes) !== declaredKeyHash) throw new Error('Study key seal differs from private key bytes');
  const key = JSON.parse(keyBytes.toString('utf8')) as StudyKey & { corpusManifestSha256: string };
  const corpusBytes = fs.readFileSync(corpusFile || path.join(privateDir, 'corpus-manifest.json'));
  if (hash(corpusBytes) !== key.corpusManifestSha256) throw new Error('Analysis corpus differs from packaged corpus');
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as CorpusManifest;
  const judges = new Set(key.key.map((entry) => entry.judgeId));
  const ratingsByJudge: Record<string, string> = {};
  const ratingHashes: Record<string, string | null> = {};
  for (const entry of key.key) {
    if (!/^[a-z0-9_-]{2,40}$/i.test(entry.judgeId) || !/^pair-[0-9a-f]{12}$/.test(entry.pairId)) {
      throw new Error('Study key contains unsafe rater path');
    }
    const pairDir = path.join(study, 'raters', entry.judgeId, entry.pairId);
    for (const [name, expected] of [['A.png', entry.leftPngSha256], ['B.png', entry.rightPngSha256], ['brief.txt', entry.briefSha256]] as const) {
      if (hash(fs.readFileSync(path.join(pairDir, name))) !== expected) {
        throw new Error(`Rater package bytes changed: ${entry.judgeId}/${entry.pairId}/${name}`);
      }
    }
  }
  for (const judgeId of judges) {
    const ratingsFile = path.join(study, 'raters', judgeId, 'ratings.csv');
    if (fs.existsSync(ratingsFile)) {
      const bytes = fs.readFileSync(ratingsFile);
      ratingsByJudge[judgeId] = bytes.toString('utf8');
      ratingHashes[judgeId] = hash(bytes);
    } else ratingHashes[judgeId] = null;
  }
  const result = analyzeCurrentExportVotes({ key, corpus, ratingsByJudge });
  const evidence = { schemaVersion: 1, keySha256: hash(keyBytes), corpusSha256: hash(corpusBytes),
    ratingFileSha256: ratingHashes, result };
  const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
  const file = path.join(privateDir, `analysis-${hash(bytes).slice(0, 16)}.json`);
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) throw new Error('Analysis hash collision or altered prior report');
  } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return { file, status: result.status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [study, corpus] = process.argv.slice(2);
  if (!study) {
    console.error('Usage: analyze_current_export_study.ts <private-study-directory> [sealed-corpus-manifest.json]');
    process.exit(2);
  }
  try {
    const result = analyzeStudyDirectory(study, corpus);
    console.log(`${result.status}: ${result.file}`);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
