import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCorpusManifest, type CorpusCandidate } from '../packages/evals/src/corpus/corpus-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateOutputRoot = path.join(root, 'data/evaluations');
const sha = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');

interface SourceRecord extends Omit<CorpusCandidate, 'briefSha256' | 'assetSha256' | 'normalizedBrief' | 'approvalEvidenceSha256'> {
  briefFile: string;
  assetFiles: string[];
  approvalFile: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function inside(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

function readAuthorizedFile(base: string, relative: string, maxBytes: number): Buffer {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Expected a path relative to the private corpus directory`);
  const resolved = fs.realpathSync(path.resolve(base, relative));
  if (!inside(base, resolved)) throw new Error('Source path escapes the private corpus directory');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) throw new Error(`Empty, non-file, or oversized source: ${relative}`);
  return fs.readFileSync(resolved);
}

export function loadCorpusCandidates(inputFile: string): CorpusCandidate[] {
  const realInput = fs.realpathSync(inputFile);
  const base = path.dirname(realInput);
  const parsed = JSON.parse(fs.readFileSync(realInput, 'utf8'));
  if (!Array.isArray(parsed.cases)) throw new Error('Input must contain a cases array');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return (parsed.cases as SourceRecord[]).map((record) => {
    if (!Array.isArray(record.assetFiles) || record.assetFiles.length > 20) {
      throw new Error(`${record.caseId || 'case'}: assetFiles must be an array of at most 20 paths`);
    }
    const brief = readAuthorizedFile(base, record.briefFile, 1024 * 1024);
    const approval = readAuthorizedFile(base, record.approvalFile, 1024 * 1024);
    const text = decoder.decode(brief);
    const assetSha256 = record.assetFiles.map((file) => sha(readAuthorizedFile(base, file, 50 * 1024 * 1024)));
    const { briefFile: _briefFile, assetFiles: _assetFiles, approvalFile: _approvalFile, ...meta } = record;
    return { ...meta, approvalEvidenceSha256: sha(approval), briefSha256: sha(brief), assetSha256,
      normalizedBrief: text.normalize('NFKC').replace(/\s+/g, ' ').trim() };
  });
}

export function main(args = process.argv.slice(2)): void {
  const input = option(args, '--input');
  const out = option(args, '--out');
  const seed = option(args, '--seed');
  const seal = args.includes('--seal');
  if (!input || !out || !seed || args.some((a) => a.startsWith('--') && !['--input', '--out', '--seed', '--seal'].includes(a))) {
    throw new Error('Usage: build_eval_corpus.ts --input <private cases.json> --out <data/evaluations/new-directory> --seed <hex> [--seal]');
  }
  const output = path.resolve(out);
  if (path.dirname(output) !== privateOutputRoot || !inside(privateOutputRoot, output)) {
    throw new Error('Corpus output must be a new direct child of data/evaluations');
  }
  if ((fs.existsSync(path.join(root, 'data')) && fs.lstatSync(path.join(root, 'data')).isSymbolicLink()) ||
      (fs.existsSync(privateOutputRoot) && fs.lstatSync(privateOutputRoot).isSymbolicLink())) {
    throw new Error('Corpus output root cannot be a symlink');
  }
  if (fs.existsSync(output)) throw new Error('Corpus output already exists; a sealed or inventoried run cannot be overwritten');
  const candidates = loadCorpusCandidates(path.resolve(input));
  const manifest = buildCorpusManifest(candidates, seed, seal);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(privateOutputRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'manifest.sha256'), `${sha(bytes)}  manifest.json\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'split-seed.txt'), `${seed}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`${manifest.status}: ${manifest.counts.total} cases, ${manifest.counts.clients} clients; ${output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
