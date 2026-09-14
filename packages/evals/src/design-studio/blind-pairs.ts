import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export interface BlindPairConfig {
  outputDir: string;
  seed?: string;
  pairs: Array<{
    briefId: string;
    v1PngPath: string;
    v2PngPath: string;
    v1Score?: number;
    v2Score?: number;
  }>;
}

export interface SealedPairKeyEntry {
  pairId: string;
  briefId: string;
  leftIs: 'v1' | 'v2';
  rightIs: 'v1' | 'v2';
  v2Side: 'A' | 'B';
  v1Sha256: string;
  v2Sha256: string;
  v1Score?: number;
  v2Score?: number;
}

export interface SealedPairKey {
  generatedAt: string;
  seed: string;
  totalPairs: number;
  pairs: SealedPairKeyEntry[];
}

export function packageBlindPairs(config: BlindPairConfig): {
  keyPath: string;
  ratingsCsvTemplatePath: string;
  count: number;
} {
  const blindDir = path.join(config.outputDir, 'blind-pairs');
  fs.mkdirSync(blindDir, { recursive: true });

  const seed = config.seed || randomBytes(16).toString('hex');
  const sealedEntries: SealedPairKeyEntry[] = [];
  const csvLines: string[] = [
    '# Human blind preference evaluation: Rate Side A and Side B (1-10) and choose the preferred design',
    '# pairId,briefId,choice (A|B|tie),ratingA (1-10),ratingB (1-10),notes',
    'pairId,briefId,choice,ratingA,ratingB,notes',
  ];

  for (let i = 0; i < config.pairs.length; i++) {
    const pair = config.pairs[i];
    const pairId = `pair-${String(i + 1).padStart(2, '0')}`;

    // Simple deterministic PRNG from seed + pair index
    const hashVal = createHash('sha256').update(`${seed}-${i}`).digest('hex');
    const isV2Left = parseInt(hashVal.substring(0, 2), 16) % 2 === 0;

    const v1Bytes = fs.existsSync(pair.v1PngPath) ? fs.readFileSync(pair.v1PngPath) : Buffer.from('');
    const v2Bytes = fs.existsSync(pair.v2PngPath) ? fs.readFileSync(pair.v2PngPath) : Buffer.from('');

    const v1Sha256 = createHash('sha256').update(v1Bytes).digest('hex');
    const v2Sha256 = createHash('sha256').update(v2Bytes).digest('hex');

    const leftBytes = isV2Left ? v2Bytes : v1Bytes;
    const rightBytes = isV2Left ? v1Bytes : v2Bytes;

    fs.writeFileSync(path.join(blindDir, `${pairId}-L.png`), leftBytes);
    fs.writeFileSync(path.join(blindDir, `${pairId}-R.png`), rightBytes);

    sealedEntries.push({
      pairId,
      briefId: pair.briefId,
      leftIs: isV2Left ? 'v2' : 'v1',
      rightIs: isV2Left ? 'v1' : 'v2',
      v2Side: isV2Left ? 'A' : 'B',
      v1Sha256,
      v2Sha256,
      v1Score: pair.v1Score,
      v2Score: pair.v2Score,
    });

    csvLines.push(`${pairId},${pair.briefId},,,`);
  }

  const sealedKey: SealedPairKey = {
    generatedAt: new Date().toISOString(),
    seed,
    totalPairs: sealedEntries.length,
    pairs: sealedEntries,
  };

  const keyPath = path.join(config.outputDir, 'pair-key.json');
  fs.writeFileSync(keyPath, JSON.stringify(sealedKey, null, 2), 'utf8');

  const ratingsCsvTemplatePath = path.join(config.outputDir, 'human-ratings.csv');
  fs.writeFileSync(ratingsCsvTemplatePath, csvLines.join('\n') + '\n', 'utf8');

  return {
    keyPath,
    ratingsCsvTemplatePath,
    count: sealedEntries.length,
  };
}
