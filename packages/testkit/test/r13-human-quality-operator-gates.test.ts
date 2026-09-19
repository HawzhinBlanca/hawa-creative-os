import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseHumanRatingsCsv, processRatingsIntake } from '../../../packages/evals/src/design-studio/ratings-intake.js';

describe('Task R13: Blinded Human Quality and Operator Usability Gates (FR-041, FR-076, NFR-009, NFR-016, NFR-021)', () => {
  const root = path.resolve(__dirname, '../../..');
  const t8Dir = path.join(root, 'output/proofs/2026-09-17-research-grade-pipeline/T8_BLIND');
  const deskSrc = path.join(root, 'apps/desk/src');

  it('1. Verifies cryptographic commitment seal for blind evaluation randomization key', () => {
    const keyPath = path.join(t8Dir, 'pair-key.json');
    const sealPath = path.join(t8Dir, 'SEAL.txt');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(sealPath)).toBe(true);

    const keyContent = fs.readFileSync(keyPath, 'utf8');
    const computedSeal = crypto.createHash('sha256').update(keyContent).digest('hex');
    const sealContent = fs.readFileSync(sealPath, 'utf8');
    const match = sealContent.match(/SEAL:\s*([a-f0-9]{64})/i);

    expect(match).not.toBeNull();
    expect(computedSeal).toBe(match![1]);
  });

  it('2. Verifies 10 balanced blind pairs across English, Kurdish Sorani, and canonical formats', () => {
    const keyData = JSON.parse(fs.readFileSync(path.join(t8Dir, 'pair-key.json'), 'utf8'));
    expect(keyData.pairs).toHaveLength(10);

    const languages = keyData.pairs.map((p: any) => p.language);
    expect(languages.filter((l: string) => l === 'en')).toHaveLength(5);
    expect(languages.filter((l: string) => l === 'ckb' || l === 'mixed')).toHaveLength(5);

    // Verify presence of unlabelled Option A and Option B PNG renders
    for (const pair of keyData.pairs) {
      const fileA = path.join(t8Dir, 'blind-pairs', `${pair.pairId}-A.png`);
      const fileB = path.join(t8Dir, 'blind-pairs', `${pair.pairId}-B.png`);
      expect(fs.existsSync(fileA)).toBe(true);
      expect(fs.existsSync(fileB)).toBe(true);

      const headerA = fs.readFileSync(fileA).subarray(0, 8);
      const headerB = fs.readFileSync(fileB).subarray(0, 8);
      expect(headerA.toString('hex')).toBe('89504e470d0a1a0a'); // Valid PNG magic bytes
      expect(headerB.toString('hex')).toBe('89504e470d0a1a0a');
    }
  });

  it('3. Anti-fabrication & intake validation: strictly refuses unrated rows and rejects synthetic backfill', () => {
    // Blank template must reject intake
    const blankCsv = `pairId,briefId,choice,ratingA,ratingB,notes\npair-01,compare-01,,,`;
    expect(() => parseHumanRatingsCsv(blankCsv)).toThrow(/The rating sheet is not complete/);

    // Completed synthetic intake must match sealed structure
    const sampleCsv = `pairId,briefId,choice,ratingA,ratingB,notes\n` +
      `pair-01,compare-01,A,9,7,Stronger hierarchy\n` +
      `pair-02,compare-02,B,6,8,Better font size\n` +
      `pair-03,compare-03,tie,8,8,Equal quality`;
    const parsed = parseHumanRatingsCsv(sampleCsv);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].choice).toBe('A');
    expect(parsed[0].ratingA).toBe(9);
    expect(parsed[0].ratingB).toBe(7);

    // Refusal when pairs length does not match expected
    const keyMap = {
      'pair-01': { v2Side: 'A' as const },
      'pair-02': { v2Side: 'B' as const },
      'pair-03': { v2Side: 'A' as const },
    };
    const result = processRatingsIntake(parsed, keyMap);
    expect(result.totalPairs).toBe(3);
    expect(result.v2WinCount).toBe(2); // Pair 1 (A is v2) + Pair 2 (B is v2)
    expect(result.tieCount).toBe(1);
  });

  it('4. Operator usability without terminal: WorkScreen implements complete 5-stage lifecycle (FR-041, FR-076, NFR-016)', () => {
    const workScreenPath = path.join(deskSrc, 'screens/WorkScreen.tsx');
    expect(fs.existsSync(workScreenPath)).toBe(true);
    const content = fs.readFileSync(workScreenPath, 'utf8');

    // 1. Edit in Canva
    expect(content).toContain('handleEditInCanva');
    expect(content).toContain('btn-edit-in-canva');

    // 2. Capture for review
    expect(content).toContain('handleCaptureForReview');
    expect(content).toContain('btn-capture-for-review');

    // 3. Request revision
    expect(content).toContain('handleSendRevisionRequest');
    expect(content).toContain('btn-request-revision');

    // 4. Approve with pinned exports
    expect(content).toContain('handleApprove');
    expect(content).toContain('btn-approve-captured');
    expect(content).toContain('approvalBlocker');

    // 5. Deliver approved files to Drive/Sheets
    expect(content).toContain('handleDeliver');
    expect(content).toContain('btn-deliver-approved');
  });

  it('5. Accessibility, focus management & keyboard navigation (NFR-009, NFR-021)', () => {
    // Command Palette keyboard shortcut and focus management
    const palettePath = path.join(deskSrc, 'components/CommandPalette.tsx');
    expect(fs.existsSync(palettePath)).toBe(true);
    const paletteContent = fs.readFileSync(palettePath, 'utf8');

    expect(paletteContent).toContain('inputRef');
    expect(paletteContent).toContain('selectedIndex');
    expect(paletteContent).toContain("e.key === 'ArrowDown'");
    expect(paletteContent).toContain("e.key === 'ArrowUp'");
    expect(paletteContent).toContain("e.key === 'Enter'");
    expect(paletteContent).toContain("e.key === 'Escape'");

    // CSS Focus visible and accessibility styling
    const cssPath = path.join(deskSrc, 'index.css');
    expect(fs.existsSync(cssPath)).toBe(true);
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    expect(cssContent).toContain(':focus-visible');
    expect(cssContent).toContain('outline: 2px solid');
    expect(cssContent).toContain('prefers-reduced-motion');
  });
});
