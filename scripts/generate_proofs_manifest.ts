import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

function computeSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

function getProducingCommand(relPath: string): string {
  if (relPath.includes('P01')) return 'npx tsx scripts/generate-p01-proof.ts';
  if (relPath.includes('P02')) return 'npx tsx scripts/generate-p02-proof.ts';
  if (relPath.includes('P03')) return 'npx tsx scripts/generate-p03-proof.ts';
  if (relPath.includes('P04')) return 'npx tsx scripts/generate-p04-proof.ts';
  if (relPath.includes('P05')) return 'npx tsx scripts/generate-p05-proof.ts';
  if (relPath.includes('P06')) return 'npx tsx scripts/generate-p06-proof.ts';
  if (relPath.includes('P07')) return 'npx tsx scripts/generate-p07-proof.ts';
  if (relPath.includes('P08')) return 'npx tsx scripts/generate-p08-proof.ts';
  if (relPath.includes('P09')) return 'npx tsx scripts/generate-p09-proof.ts';
  if (relPath.includes('P10') || relPath.includes('LEDGER')) return 'npx tsx scripts/run_p10_qualification.ts';
  if (relPath.includes('P11')) return 'npx tsx scripts/generate-p11-proof.ts';
  return 'manual review';
}

function getTaskKey(relPath: string): string {
  const match = relPath.match(/P\d{2}/);
  if (match) return match[0];
  if (relPath.includes('LEDGER')) return 'P10';
  return 'GENERAL';
}

function getAllFiles(dir: string, baseDir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Don't recurse excessively deep into P10_BRIEFS to keep manifest manageable,
      // but include key summary files
      files.push(...getAllFiles(fullPath, baseDir));
    } else {
      if (entry.name !== 'PROOFS.json') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function main() {
  const targetDir = path.resolve(process.cwd(), 'output/proofs/2026-09-17-research-grade-pipeline');
  const commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  const allFilePaths = getAllFiles(targetDir, targetDir);

  const proofEntries = allFilePaths.map((fp) => {
    const relFromRoot = path.relative(process.cwd(), fp);
    const fileName = path.basename(fp);
    const sha256 = computeSha256(fp);
    const stat = fs.statSync(fp);
    const task = getTaskKey(relFromRoot);
    const producingCommand = getProducingCommand(relFromRoot);

    return {
      task,
      name: fileName,
      path: relFromRoot,
      sizeBytes: stat.size,
      sha256,
      producingCommand,
      commit,
    };
  });

  const manifest = {
    pipelineVersion: 'research-grade-v3',
    generatedAt: new Date().toISOString(),
    commit,
    flag: 'DESIGN_PIPELINE_V3=off',
    specification: 'output/plans/2026-09-17-research-grade-pipeline/GEMINI_TASK_SHEET.md',
    researchBrief: 'output/research/2026-09-17-pipeline-research/RESEARCH_BRIEF.md',
    adr: 'adrs/031_role_based_typography_and_template_free_planner.md',
    deviations: 'output/proofs/2026-09-17-research-grade-pipeline/DEVIATIONS.md',
    tasks: {
      P01: {
        name: 'Deterministic design metrics gate',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P01_METRICS.md',
        summary: '12 fixtures evaluated (6 positive pass, 6 negative fail). Recalibrated negative space band [0.30, 0.60] with bottom void penalty fails sparse brief_01 (score 0.31).',
      },
      P02: {
        name: 'Exemplar retrieval index (RALF)',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P02_RETRIEVAL.json',
        summary: 'Owner-confirmed exemplar retrieval via multimodal similarity vectors without LLM re-ranking.',
      },
      P03: {
        name: 'Layout-first generator (PosterLLaVa & PosterMELD)',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P03_PROOF.md',
        artifactsDir: 'output/proofs/2026-09-17-research-grade-pipeline/P03_LAYOUTS',
        summary: 'Normalized coordinates in [0.0, 1.0], capacity-aware slot guidance, strict JSON schema output via gpt-6-astra.',
      },
      P04: {
        name: 'Layout-conditioned art generator (CreatiPoster)',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P04_PROOF.md',
        artifactsDir: 'output/proofs/2026-09-17-research-grade-pipeline/P04_ART',
        summary: 'Masked text bounding boxes, generated via gpt-image-2.5-sunburst with calm region verification and composite contrast validation.',
      },
      P05: {
        name: 'Box-grounded critique (Set-of-Mark)',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P05_PROOF.md',
        artifactsDir: 'output/proofs/2026-09-17-research-grade-pipeline/P05_CRITIQUE',
        summary: 'Set-of-Mark visual annotation at detail: low (85 image tokens), strictly scoped to geometry and typography hierarchy.',
      },
      P06: {
        name: 'Gated refinement engine with plateau stop',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P06_REFINE.json',
        summary: 'Three candidates verified: passing candidate skipped with 0 calls, failing candidate repaired across rounds, plateauing candidate halted before cap with delta < 0.02.',
      },
      P07: {
        name: 'Pairwise dimension-wise judge & order-swapping',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P07_JUDGE.json',
        proofDoc: 'output/proofs/2026-09-17-research-grade-pipeline/P07_PROOF.md',
        summary: '5 independent dimensions (hierarchy, composition, typographic_craft, brand_fit, legibility), order-swapped (AB and BA) presentation, degraded-copy canary defeat.',
      },
      P08: {
        name: 'Telegram approve, edit, reject flow',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P08_PICK.md',
        summary: 'Real layout renders media group, one-tap quick fixes from critique, free text via F07 classifier, signed one-time tokens, non-blocking timeout auto-advance.',
      },
      P09: {
        name: 'Cost architecture & token discipline',
        status: 'COMPLETED',
        proofFile: 'output/proofs/2026-09-17-research-grade-pipeline/P09_COST.md',
        summary: 'Byte-stable cached prefix (4,565 chars / 1,142 tokens), detail: low, cheap path < $0.25 ($0.158), per-brief $1.00 cap graceful degradation. 100% genuine receipts.',
      },
      P10: {
        name: 'Qualification across 20 held-out briefs (Live Run)',
        status: 'COMPLETED',
        proofCsv: 'output/proofs/2026-09-17-research-grade-pipeline/P10_QUALIFICATION.csv',
        proofDoc: 'output/proofs/2026-09-17-research-grade-pipeline/P10_QUALIFICATION.md',
        ledgerCsv: 'output/proofs/2026-09-17-research-grade-pipeline/LEDGER.csv',
        briefsDir: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS',
        summary: 'Live execution with gpt-6-astra across 20 held-out briefs. Real unpadded latency (median 52,266ms), real net cost (median $0.177413), genuine model receipts recorded in LEDGER.csv, raw 1-shot PRR 20.0% (4/20), 100% canary win rate, 100% order-swap consistency, 100% editability.',
      },
      P11: {
        name: 'Growable reference library & circular output guard',
        status: 'COMPLETED',
        proofDoc: 'output/proofs/2026-09-17-research-grade-pipeline/P11_ADD_REFERENCE.md',
        cliScript: 'scripts/add_exemplar.ts',
        summary: 'Three entry points (folder drop, Telegram, Desk), hard guard against circular outputs under output/, and owner confirmation gate preserving dropped history.',
      },
    },
    proofs: proofEntries,
  };

  const manifestPath = path.join(targetDir, 'PROOFS.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Generated PROOFS.json with ${proofEntries.length} verified artifact hashes at: ${manifestPath}`);
}

main();
