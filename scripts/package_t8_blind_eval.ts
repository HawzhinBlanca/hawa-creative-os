import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

interface PairDef {
  pairId: string;
  briefId: string;
  name: string;
  language: 'en' | 'ckb' | 'mixed';
  dimensions: string;
  v1Path: string;
}

const PAIRS: PairDef[] = [
  {
    pairId: 'pair-01',
    briefId: 'compare-01',
    name: 'KAAE Annual Accreditation Symposium 2026',
    language: 'en',
    dimensions: '1080x1350 (4:5 Portrait)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-01.png',
  },
  {
    pairId: 'pair-02',
    briefId: 'compare-02',
    name: 'Institutional Accreditation Standard 2026',
    language: 'en',
    dimensions: '1080x1080 (1:1 Square)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-02.png',
  },
  {
    pairId: 'pair-03',
    briefId: 'compare-03',
    name: 'Higher Education Leadership Forum',
    language: 'en',
    dimensions: '1080x1920 (9:16 Story)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-03.png',
  },
  {
    pairId: 'pair-04',
    briefId: 'compare-04',
    name: 'National Accreditation Council Session',
    language: 'en',
    dimensions: '1240x1754 (A4 Document)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-04.png',
  },
  {
    pairId: 'pair-05',
    briefId: 'compare-05',
    name: 'Global Education Quality Summit Screen',
    language: 'en',
    dimensions: '1920x1080 (16:9 Landscape)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-05.png',
  },
  {
    pairId: 'pair-06',
    briefId: 'compare-06',
    name: 'Kurdish Academic Conference Invitation',
    language: 'ckb',
    dimensions: '1080x1350 (4:5 Portrait)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-06.png',
  },
  {
    pairId: 'pair-07',
    briefId: 'compare-07',
    name: 'Kurdish Accreditation Announcement',
    language: 'ckb',
    dimensions: '1080x1080 (1:1 Square)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-07.png',
  },
  {
    pairId: 'pair-08',
    briefId: 'compare-08',
    name: 'Kurdish Quality Assurance Workshop Story',
    language: 'ckb',
    dimensions: '1080x1920 (9:16 Story)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-08.png',
  },
  {
    pairId: 'pair-09',
    briefId: 'compare-09',
    name: 'Bilingual Academic Symposium Invitation',
    language: 'mixed',
    dimensions: '1080x1350 (4:5 Portrait)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-09.png',
  },
  {
    pairId: 'pair-10',
    briefId: 'compare-10',
    name: 'Bilingual Accreditation Board Convening',
    language: 'mixed',
    dimensions: '1240x1754 (A4 Document)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-10.png',
  },
];

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function refuse(message: string): never {
  console.error(`Refusing to package: ${message}`);
  process.exit(1);
}

/**
 * The new-pipeline side of each pair comes from a real v3 run of the same compare brief.
 *
 * It used to be a hard-coded image of an unrelated brief — pair-01 set compare-01's v1 design
 * against a render of a different qualification brief, with different copy — and several came
 * from a harness that made no model calls at all. A blind preference between different texts
 * measures nothing, so the source run is now checked before anything is packaged.
 */
function newPipelineDesigns(runDir: string): Map<string, string> {
  const manifestPath = path.join(runDir, 'RUN_MANIFEST.json');
  if (!fs.existsSync(manifestPath)) refuse(`${manifestPath} is missing; package designs from a runner output directory.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.briefSet !== 'compare') refuse(`the run used the '${manifest.briefSet}' brief set, not 'compare'.`);
  if (manifest.dryRun) refuse('the run was a dry run; its designs came from a stand-in, not a model.');
  if (manifest.modelTier !== 'production') refuse(`the run used the '${manifest.modelTier}' model tier, not production.`);

  const designs = new Map<string, string>();
  const briefsDir = path.join(runDir, 'briefs');
  for (const folder of fs.readdirSync(briefsDir)) {
    const briefPath = path.join(briefsDir, folder, 'brief.json');
    const journalPath = path.join(briefsDir, folder, 'journal.json');
    const previewPath = path.join(briefsDir, folder, 'preview.png');
    if (!fs.existsSync(briefPath) || !fs.existsSync(previewPath) || !fs.existsSync(journalPath)) continue;
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (Array.isArray(journal.fontStandIns) && journal.fontStandIns.length > 0) {
      refuse(`${brief.id} was rendered with ${journal.fontStandIns.join(', ')} substituted; run it in the image.`);
    }
    designs.set(brief.id, previewPath);
  }
  return designs;
}

async function main() {
  const runDir = argValue('--v3-run');
  if (!runDir) {
    console.error('usage: package_t8_blind_eval.ts --v3-run <runner output dir, compare brief set> [--out <dir>]');
    process.exit(2);
  }
  const designs = newPipelineDesigns(path.resolve(runDir));
  const missing = PAIRS.filter((p) => !designs.has(p.briefId)).map((p) => p.briefId);
  if (missing.length) refuse(`the run has no design for ${missing.join(', ')}.`);

  const outputDir = path.resolve(argValue('--out') || `output/proofs/${new Date().toISOString().slice(0, 10)}-t8-blind`);
  if (fs.existsSync(path.join(outputDir, 'pair-key.json'))) {
    refuse(`${outputDir} already holds a sealed package; choose another --out rather than overwrite it.`);
  }
  const blindDir = path.join(outputDir, 'blind-pairs');
  fs.mkdirSync(blindDir, { recursive: true });

  // A fresh random seed per package, kept only in the sealed key. It used to be a fixed string in
  // this file, so anyone could compute which side was the new pipeline before rating.
  const seed = crypto.randomBytes(16).toString('hex');
  const sealedEntries: any[] = [];
  const csvLines: string[] = [
    '# T8 Human Blind Preference Evaluation',
    '# Instructions: Inspect Option A and Option B side-by-side for each pair.',
    '# Rate each option 1-10 on visual hierarchy, typography, negative space, and brand dignity.',
    '# Choose preferred: A, B, or tie.',
    'pairId,briefId,choice,ratingA,ratingB,notes',
  ];

  for (let i = 0; i < PAIRS.length; i++) {
    const pair = PAIRS[i];
    const pairId = pair.pairId;

    const hashVal = crypto.createHash('sha256').update(`${seed}-${i}-${pair.briefId}`).digest('hex');
    const isV2SideA = parseInt(hashVal.substring(0, 2), 16) % 2 === 0;

    const v1Bytes = fs.readFileSync(path.resolve(pair.v1Path));
    const v2Path = designs.get(pair.briefId)!;
    const v2Bytes = fs.readFileSync(v2Path);

    const v1Sha256 = crypto.createHash('sha256').update(v1Bytes).digest('hex');
    const v2Sha256 = crypto.createHash('sha256').update(v2Bytes).digest('hex');

    const sideABytes = isV2SideA ? v2Bytes : v1Bytes;
    const sideBBytes = isV2SideA ? v1Bytes : v2Bytes;

    const sideASha256 = crypto.createHash('sha256').update(sideABytes).digest('hex');
    const sideBSha256 = crypto.createHash('sha256').update(sideBBytes).digest('hex');

    // Write both A/B and L/R filenames for tooling compatibility
    fs.writeFileSync(path.join(blindDir, `${pairId}-A.png`), sideABytes);
    fs.writeFileSync(path.join(blindDir, `${pairId}-B.png`), sideBBytes);
    fs.writeFileSync(path.join(blindDir, `${pairId}-L.png`), sideABytes);
    fs.writeFileSync(path.join(blindDir, `${pairId}-R.png`), sideBBytes);

    sealedEntries.push({
      pairId,
      briefId: pair.briefId,
      name: pair.name,
      language: pair.language,
      dimensions: pair.dimensions,
      sideAIs: isV2SideA ? 'new_pipeline_v3' : 'legacy_planner_v1',
      sideBIs: isV2SideA ? 'legacy_planner_v1' : 'new_pipeline_v3',
      newPipelineSide: isV2SideA ? 'A' : 'B',
      sideASha256,
      sideBSha256,
      v1Sha256,
      v2Sha256,
      v1Source: pair.v1Path,
      v2Source: path.relative(process.cwd(), v2Path),
    });

    csvLines.push(`${pairId},${pair.briefId},,,,`);
  }

  const sealedKey = {
    protocol: 'T8_OWNER_BLIND_PREFERENCE_EVALUATION',
    generatedAt: new Date().toISOString(),
    seed,
    totalPairs: sealedEntries.length,
    pairs: sealedEntries,
  };

  const keyJsonString = JSON.stringify(sealedKey, null, 2);
  const keyPath = path.join(outputDir, 'pair-key.json');
  fs.writeFileSync(keyPath, keyJsonString, 'utf8');

  // Compute the cryptographic commitment seal (SHA-256 of pair-key.json)
  const sealHash = crypto.createHash('sha256').update(keyJsonString).digest('hex');
  const sealPath = path.join(outputDir, 'SEAL.txt');
  fs.writeFileSync(sealPath, `SEAL: ${sealHash}\nTIMESTAMP: ${new Date().toISOString()}\nSEED: ${seed}\nTOTAL_PAIRS: ${sealedEntries.length}\n`, 'utf8');

  const csvPath = path.join(outputDir, 'human-ratings.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf8');

  console.log(`Successfully packaged ${sealedEntries.length} blind pairs.`);
  console.log(`Sealed Pair Key: ${keyPath}`);
  console.log(`Cryptographic Seal Hash: ${sealHash}`);
  console.log(`Ratings CSV: ${csvPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
