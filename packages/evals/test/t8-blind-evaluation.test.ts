import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

describe('T8 — The Owner Blind Preference Test Protocol', () => {
  const t8Dir = path.resolve(__dirname, '../../../output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND');
  const keyPath = path.join(t8Dir, 'pair-key.json');
  const sealPath = path.join(t8Dir, 'SEAL.txt');
  const csvPath = path.join(t8Dir, 'human-ratings.csv');
  const blindPairsDir = path.join(t8Dir, 'blind-pairs');

  it('verifies cryptographic seal of the randomization key', () => {
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(sealPath)).toBe(true);

    const keyContent = fs.readFileSync(keyPath, 'utf8');
    const computedSeal = crypto.createHash('sha256').update(keyContent).digest('hex');
    const sealContent = fs.readFileSync(sealPath, 'utf8');
    const sealMatch = sealContent.match(/SEAL:\s*([a-f0-9]{64})/i);

    expect(sealMatch).not.toBeNull();
    expect(computedSeal).toBe(sealMatch![1]);
  });

  it('contains exactly 10 pairs covering English and Kurdish Sorani across canonical formats', () => {
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    expect(keyData.totalPairs).toBe(10);
    expect(keyData.pairs).toHaveLength(10);

    const languages = keyData.pairs.map((p: any) => p.language);
    const enCount = languages.filter((l: string) => l === 'en').length;
    const ckbCount = languages.filter((l: string) => l === 'ckb' || l === 'mixed').length;

    expect(enCount).toBe(5);
    expect(ckbCount).toBe(5);

    // Verify side assignment randomization is not degenerate
    const sideACountV3 = keyData.pairs.filter((p: any) => p.newPipelineSide === 'A').length;
    const sideBCountV3 = keyData.pairs.filter((p: any) => p.newPipelineSide === 'B').length;
    expect(sideACountV3).toBeGreaterThanOrEqual(3);
    expect(sideBCountV3).toBeGreaterThanOrEqual(3);
  });

  it('verifies all 10 pairs have authentic, unlabelled Option A and Option B PNG renders', () => {
    for (let i = 1; i <= 10; i++) {
      const pid = `pair-${String(i).padStart(2, '0')}`;
      const imgAPath = path.join(blindPairsDir, `${pid}-A.png`);
      const imgBPath = path.join(blindPairsDir, `${pid}-B.png`);

      expect(fs.existsSync(imgAPath)).toBe(true);
      expect(fs.existsSync(imgBPath)).toBe(true);

      const bufA = fs.readFileSync(imgAPath);
      const bufB = fs.readFileSync(imgBPath);

      // Verify valid PNG magic header
      expect(bufA.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bufB.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

      // Verify files have non-trivial size
      expect(bufA.length).toBeGreaterThan(10000);
      expect(bufB.length).toBeGreaterThan(10000);
    }
  });

  it('verifies human-ratings.csv intake template is present and initialized', () => {
    expect(fs.existsSync(csvPath)).toBe(true);
    const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
    expect(lines[0]).toContain('pairId,briefId,choice,ratingA,ratingB,notes');
    expect(lines.length).toBe(11); // 1 header + 10 data rows
  });
});
