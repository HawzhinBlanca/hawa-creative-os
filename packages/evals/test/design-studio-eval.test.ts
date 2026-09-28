import { describe, it, expect } from 'vitest';
import {
  loadGoldenBriefs,
  loadCompareBriefs,
  getBriefById,
  OfflineRunner,
  parseHumanRatingsCsv,
  processRatingsIntake,
  computeSpearmanRho,
  computeBootstrapCi,
  packageBlindPairs,
} from '../src/index.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Design Studio v2 Evaluation Harness (T15)', () => {
  it('loads and validates all 24 golden briefs with exact language and format breakdown', () => {
    const briefs = loadGoldenBriefs();
    expect(briefs).toHaveLength(24);

    const langCounts: Record<string, number> = {};
    const formatCounts: Record<string, number> = {};

    for (const b of briefs) {
      langCounts[b.language] = (langCounts[b.language] || 0) + 1;
      const dim = `${b.width}x${b.height}`;
      formatCounts[dim] = (formatCounts[dim] || 0) + 1;

      expect(b.copyBlocks.length).toBeGreaterThan(0);
      for (let i = 0; i < b.copyBlocks.length; i++) {
        expect(b.copyBlocks[i].copyIndex).toBe(i);
        expect(b.copyBlocks[i].text.trim().length).toBeGreaterThan(0);
        expect(['latin', 'arabic']).toContain(b.copyBlocks[i].script);
      }
    }

    // Task sheet requirement: 12 English, 8 Sorani, 4 mixed
    expect(langCounts.en).toBe(12);
    expect(langCounts.ckb).toBe(8);
    expect(langCounts.mixed).toBe(4);

    // Formats: 1080x1350, 1080x1080, 1080x1920, 1240x1754, 1920x1080
    expect(formatCounts['1080x1350']).toBe(6);
    expect(formatCounts['1080x1080']).toBe(6);
    expect(formatCounts['1080x1920']).toBe(4);
    expect(formatCounts['1240x1754']).toBe(4);
    expect(formatCounts['1920x1080']).toBe(4);
  });

  it('verifies the 10 compare briefs are an exact subset', () => {
    const compareBriefs = loadCompareBriefs();
    expect(compareBriefs).toHaveLength(10);

    for (let i = 1; i <= 10; i++) {
      const num = String(i).padStart(2, '0');
      const comp = getBriefById(`compare-${num}`);
      const gold = getBriefById(`golden-${num}`);

      expect(comp).toBeDefined();
      expect(gold).toBeDefined();
      expect(gold?.name).toBe(comp?.name);
      expect(gold?.width).toBe(comp?.width);
      expect(gold?.height).toBe(comp?.height);
      expect(gold?.copyBlocks).toEqual(comp?.copyBlocks);
    }
  });

  it('runs the offline runner through all stages on an authentic brief', async () => {
    const runner = new OfflineRunner();
    const brief = getBriefById('golden-01')!;
    const result = await runner.runBrief(brief);

    expect(result.status).toBe('transferred');
    expect(result.briefId).toBe('golden-01');
    expect(result.ladderRung).toBe(0);
    expect(result.callsCount).toBeGreaterThan(0);
    expect(result.spentUsd).toBeGreaterThan(0);
    expect(result.winnerScore).toBeGreaterThanOrEqual(8.0);
    expect(result.hardQaEscapes).toBe(0);
    expect(result.canary.verdict).toBe('RELIABLE');
    expect(result.tournament.swapConsistencyRate).toBe(1.0);
    expect(result.previewSha256).toBeDefined();
    expect(result.parity?.parity).toBe('match');
  });

  it('correctly simulates and records degradation ladder rungs', async () => {
    const runner = new OfflineRunner();
    const brief = getBriefById('golden-06')!; // Sorani brief

    // Rung 1: Opus fallback
    const rung1 = await runner.runBrief(brief, { forceModelFallback: true });
    expect(rung1.ladderRung).toBe(1);
    expect(rung1.rungsTriggered).toContain('rung1_opus_model_fallback');

    // Rung 3: Judge unavailable
    const rung3 = await runner.runBrief(brief, { forceJudgeUnavailable: true });
    expect(rung3.ladderRung).toBe(3);
    expect(rung3.rungsTriggered).toContain('rung3_judge_unavailable');

    // Rung 4: Planner fallback
    const rung4 = await runner.runBrief(brief, { forceRung4Fallback: true });
    expect(rung4.ladderRung).toBe(4);
    expect(rung4.status).toBe('degraded');
    expect(rung4.rungsTriggered).toContain('rung4_planner_fallback');
  });

  it('enforces budget cap and terminates stage with honest BUDGET_EXHAUSTED', async () => {
    const runner = new OfflineRunner();
    const brief = getBriefById('golden-02')!;

    // Cap at $0.05 (less than needed for all stages)
    const result = await runner.runBrief(brief, { maxUsd: 0.05 });
    expect(result.status).toBe('degraded');
    expect(result.rungsTriggered).toContain('budget_exhausted');
    expect(result.spentUsd).toBeLessThanOrEqual(0.15);
  });

  it('handles canary failure by flagging judge as UNRELIABLE', async () => {
    const runner = new OfflineRunner();
    const brief = getBriefById('golden-03')!;

    const result = await runner.runBrief(brief, { forceCanaryFailure: true });
    expect(result.canary.verdict).toBe('UNRELIABLE');
    expect(result.canary.passed).toBe(false);
    expect(result.status).toBe('degraded');
  });

  it('processes human ratings intake with bootstrap 95% confidence intervals and Spearman correlation', () => {
    const csvData = `
pairId,briefId,choice,ratingA,ratingB,notes
pair-01,compare-01,B,6,9,v2 has far better hierarchy
pair-02,compare-02,B,7,9,v2 is much cleaner
pair-03,compare-03,B,5,8,v2 typography is superior
pair-04,compare-04,B,6,8,v2 fits A4 format well
pair-05,compare-05,B,5,9,v2 widescreen layout is balanced
pair-06,compare-06,B,6,9,v2 Kurdish typography is correct
pair-07,compare-07,B,7,8,v2 contrast is stronger
pair-08,compare-08,B,6,9,v2 story layout flows nicely
pair-09,compare-09,A,8,7,v1 was slightly preferred
pair-10,compare-10,B,6,8,v2 bilingual separation is clean
`;

    const parsed = parseHumanRatingsCsv(csvData);
    expect(parsed).toHaveLength(10);

    // The sealed key says which side is the new pipeline; here it is B for every pair.
    const key = Object.fromEntries(parsed.map((r) => [r.pairId, { v2Side: 'B' as const }]));
    const intake = processRatingsIntake(parsed, key);
    expect(intake.totalPairs).toBe(10);
    expect(intake.v2WinCount).toBe(9);
    expect(intake.v1WinCount).toBe(1);

    // D4 requirement: blind preference v2 over v1 >= 8 of 10 pairs
    expect(intake.preferenceRateV2.pointEstimate).toBe(0.9);
    expect(intake.preferenceRateV2.ciLower95).toBeGreaterThan(0.5);
    expect(intake.preferenceRateV2.ciUpper95).toBeLessThanOrEqual(1.0);
    expect(intake.meanRatingV2.pointEstimate).toBeCloseTo(8.4, 5);

    // No judge scores in the key, so there is no judge statistic — not one computed from guesses.
    expect(intake.pairsWithJudgeScores).toBe(0);
    expect(intake.spearmanRhoWithJudge).toBeNull();
    expect(intake.judgeAgreementRate).toBeNull();

    // The same sheet scored twice gives the same interval.
    expect(processRatingsIntake(parsed, key).preferenceRateV2).toEqual(intake.preferenceRateV2);

    // Swapping the sides in the key swaps the result: the key, not a default, decides.
    const swapped = Object.fromEntries(parsed.map((r) => [r.pairId, { v2Side: 'A' as const }]));
    expect(processRatingsIntake(parsed, swapped).v2WinCount).toBe(1);
  });

  it('refuses an unfinished rating sheet instead of scoring blanks as ties', () => {
    const csv = `pairId,briefId,choice,ratingA,ratingB,notes
pair-01,compare-01,B,6,9,
pair-02,compare-02,,,,
pair-03,compare-03,A,11,4,`;
    expect(() => parseHumanRatingsCsv(csv)).toThrow(/pair-02: choice must be A, B or tie/);
    expect(() => parseHumanRatingsCsv(csv)).toThrow(/pair-03: ratingA must be a number from 1 to 10/);
  });

  it('refuses to score a pair the sealed key does not contain', () => {
    const parsed = parseHumanRatingsCsv(`pairId,briefId,choice,ratingA,ratingB,notes
pair-01,compare-01,B,6,9,
pair-99,compare-99,A,8,7,`);
    expect(() => processRatingsIntake(parsed, { 'pair-01': { v2Side: 'B' } })).toThrow(/pair-99/);
  });

  it('measures judge agreement only from judge scores that exist', () => {
    const parsed = parseHumanRatingsCsv(`pairId,briefId,choice,ratingA,ratingB,notes
pair-01,compare-01,B,6,9,
pair-02,compare-02,A,8,6,
pair-03,compare-03,B,5,8,`);
    const intake = processRatingsIntake(parsed, {
      'pair-01': { v2Side: 'B', judgeScoreA: 6, judgeScoreB: 9 },
      'pair-02': { v2Side: 'B', judgeScoreA: 5, judgeScoreB: 9 },
      'pair-03': { v2Side: 'B' },
    });
    expect(intake.pairsWithJudgeScores).toBe(2);
    // pair-01 the judge and the human both chose B; pair-02 the judge chose B, the human A.
    expect(intake.judgeAgreementRate?.pointEstimate).toBe(0.5);
  });

  it('packages blind pairs and generates a sealed pair key', () => {
    const tmpDir = fs.mkdtempSync(path.resolve('/tmp/hawa-eval-blind-test-'));

    // Create dummy pngs
    const dummyV1 = path.join(tmpDir, 'v1.png');
    const dummyV2 = path.join(tmpDir, 'v2.png');
    fs.writeFileSync(dummyV1, Buffer.from('v1-png-data'));
    fs.writeFileSync(dummyV2, Buffer.from('v2-png-data'));

    const res = packageBlindPairs({
      outputDir: tmpDir,
      seed: 'test-seed-123',
      pairs: [
        { briefId: 'compare-01', v1PngPath: dummyV1, v2PngPath: dummyV2, v1Score: 7.2, v2Score: 8.8 },
        { briefId: 'compare-02', v1PngPath: dummyV1, v2PngPath: dummyV2, v1Score: 6.9, v2Score: 8.6 },
      ],
    });

    expect(res.count).toBe(2);
    expect(fs.existsSync(res.keyPath)).toBe(true);
    expect(fs.existsSync(res.ratingsCsvTemplatePath)).toBe(true);

    const keyContent = JSON.parse(fs.readFileSync(res.keyPath, 'utf8'));
    expect(keyContent.seed).toBe('test-seed-123');
    expect(keyContent.pairs).toHaveLength(2);
    expect(keyContent.pairs[0].leftIs).toBeDefined();
    expect(keyContent.pairs[0].rightIs).toBeDefined();

    expect(() => packageBlindPairs({
      outputDir: tmpDir,
      pairs: [{ briefId: 'compare-01', v1PngPath: dummyV1, v2PngPath: dummyV2 }],
    })).toThrow(/already exists/);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a missing blind image before writing any pair', () => {
    const tmpDir = fs.mkdtempSync(path.resolve('/tmp/hawa-eval-missing-'));
    try {
      const valid = path.join(tmpDir, 'valid.png');
      fs.writeFileSync(valid, Buffer.from('image fixture'));
      expect(() => packageBlindPairs({
        outputDir: tmpDir,
        pairs: [{ briefId: 'case-1', v1PngPath: valid, v2PngPath: path.join(tmpDir, 'absent.png') }],
      })).toThrow(/both exported images must exist/);
      expect(fs.existsSync(path.join(tmpDir, 'blind-pairs'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs all 24 briefs through the offline runner and generates report', async () => {
    const runner = new OfflineRunner();
    const briefs = loadGoldenBriefs();
    expect(briefs).toHaveLength(24);

    const report = await runner.runAll(briefs);
    expect(report.totalBriefs).toBe(24);
    expect(report.completedBriefs).toBe(24);
    expect(report.failedBriefs).toBe(0);
    expect(report.hardQaEscapeCount).toBe(0);
    expect(report.canaryPassRate).toBe(1.0);
    expect(report.tournamentSwapConsistencyRate).toBe(1.0);
    expect(report.meanWinnerScore).toBeGreaterThanOrEqual(8.0);
    expect(report.results).toHaveLength(24);
  });
});
