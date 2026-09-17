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
  v2Path: string;
}

const PAIRS: PairDef[] = [
  {
    pairId: 'pair-01',
    briefId: 'compare-01',
    name: 'KAAE Annual Accreditation Symposium 2026',
    language: 'en',
    dimensions: '1080x1350 (4:5 Portrait)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-01.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/T6_DEFECTS/brief_05_after.png',
  },
  {
    pairId: 'pair-02',
    briefId: 'compare-02',
    name: 'Institutional Accreditation Standard 2026',
    language: 'en',
    dimensions: '1080x1080 (1:1 Square)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-02.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/T6_DEFECTS/brief_01_after.png',
  },
  {
    pairId: 'pair-03',
    briefId: 'compare-03',
    name: 'Higher Education Leadership Forum',
    language: 'en',
    dimensions: '1080x1920 (9:16 Story)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-03.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_09/preview.png',
  },
  {
    pairId: 'pair-04',
    briefId: 'compare-04',
    name: 'National Accreditation Council Session',
    language: 'en',
    dimensions: '1240x1754 (A4 Document)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-04.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_13/preview.png',
  },
  {
    pairId: 'pair-05',
    briefId: 'compare-05',
    name: 'Global Education Quality Summit Screen',
    language: 'en',
    dimensions: '1920x1080 (16:9 Landscape)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-05.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_17/preview.png',
  },
  {
    pairId: 'pair-06',
    briefId: 'compare-06',
    name: 'Kurdish Academic Conference Invitation',
    language: 'ckb',
    dimensions: '1080x1350 (4:5 Portrait)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-06.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/T6_DEFECTS/brief_07_after.png',
  },
  {
    pairId: 'pair-07',
    briefId: 'compare-07',
    name: 'Kurdish Accreditation Announcement',
    language: 'ckb',
    dimensions: '1080x1080 (1:1 Square)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-07.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_03/preview.png',
  },
  {
    pairId: 'pair-08',
    briefId: 'compare-08',
    name: 'Kurdish Quality Assurance Workshop Story',
    language: 'ckb',
    dimensions: '1080x1920 (9:16 Story)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-08.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_11/preview.png',
  },
  {
    pairId: 'pair-09',
    briefId: 'compare-09',
    name: 'Bilingual Academic Symposium Invitation',
    language: 'mixed',
    dimensions: '1080x1350 (4:5 Portrait)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-09.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_08/preview.png',
  },
  {
    pairId: 'pair-10',
    briefId: 'compare-10',
    name: 'Bilingual Accreditation Board Convening',
    language: 'mixed',
    dimensions: '1240x1754 (A4 Document)',
    v1Path: 'output/proofs/2026-09-14-design-studio-v2/baseline/v1-compare-10.png',
    v2Path: 'output/proofs/2026-09-17-research-grade-pipeline/P10_BRIEFS/brief_15/preview.png',
  },
];

async function main() {
  const outputDir = path.resolve('output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND');
  const blindDir = path.join(outputDir, 'blind-pairs');
  fs.mkdirSync(blindDir, { recursive: true });

  // Cryptographic seed for deterministic but sealed random assignment
  const seed = '2026-09-17-t8-research-grade-blind-eval-commitment-seed';
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
    const v2Bytes = fs.readFileSync(path.resolve(pair.v2Path));

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
      v2Source: pair.v2Path,
    });

    csvLines.push(`${pairId},${pair.briefId},,,`);
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
