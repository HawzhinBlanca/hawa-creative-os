import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PROOFS_DIR = path.join(ROOT, 'output/proofs/2026-09-16-flawless-system');

function computeSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getTaskForFile(relPath: string): string {
  if (relPath.startsWith('F01') || relPath.includes('DEPLOY')) return 'F01';
  if (relPath.startsWith('F02')) return 'F02';
  if (relPath.startsWith('F03')) return 'F03';
  if (relPath.startsWith('F04')) return 'F04';
  if (relPath.startsWith('F05')) return 'F05';
  if (relPath.startsWith('F06')) return 'F06';
  if (relPath.startsWith('F07')) return 'F07';
  if (relPath.startsWith('F08')) return 'F08';
  if (relPath.startsWith('F09')) return 'F09';
  if (relPath.startsWith('F10')) return 'F10';
  if (relPath.startsWith('F11') || relPath === 'LEDGER.csv') return 'F11';
  if (relPath.startsWith('F12') || relPath.startsWith('f12')) return 'F12';
  if (relPath.startsWith('F13')) return 'F13';
  return 'GENERAL';
}

function getProducingCommand(relPath: string): string {
  if (relPath.startsWith('F04_THREE_PLANS/')) return 'npx tsx scripts/export_live_f04_proof.ts';
  if (relPath.startsWith('F05_REVISIONS/')) return 'automated test suite & plan diff extraction';
  if (relPath.startsWith('F06')) return 'npx tsx scripts/generate_f06_proof.ts';
  if (relPath.startsWith('F07')) return 'npx tsx scripts/run_f07_live_eval.ts';
  if (relPath.startsWith('F10')) return 'npx tsx scripts/generate_f10_proof.ts';
  if (relPath === 'LEDGER.csv') return 'npx tsx scripts/populate_ledger.ts';
  if (relPath.startsWith('f12-')) return 'packages/qa/src/canva-pptx-check.ts';
  return 'manual audit';
}

function walkDir(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'PROOFS.json') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  return files;
}

function main() {
  const relativeFiles = walkDir(PROOFS_DIR, PROOFS_DIR).sort();

  const proofs = relativeFiles.map(file => {
    const fullPath = path.join(PROOFS_DIR, file);
    const sha = computeSha256(fullPath);
    const task = getTaskForFile(file);
    const cmd = getProducingCommand(file);

    return {
      task,
      name: path.basename(file),
      path: `output/proofs/2026-09-16-flawless-system/${file}`,
      sha256: sha,
      producingCommand: cmd,
      commit: "HEAD"
    };
  });

  const manifest = {
    round: "2026-09-16-flawless-system",
    generatedAt: new Date().toISOString(),
    commit: "HEAD",
    proofs
  };

  const outPath = path.join(PROOFS_DIR, 'PROOFS.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Wrote ${proofs.length} proof items to ${outPath}`);
}

main();
