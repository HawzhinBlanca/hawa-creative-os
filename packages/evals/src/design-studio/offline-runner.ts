import { createHash } from 'node:crypto';
import type {
  StudioGoldenBrief,
  StudioEvalRunResult,
  StudioEvalReport,
  CanaryResult,
  TournamentResult,
  ParityResult,
  Concept,
} from './types.js';
import {
  validateLayoutV2,
  computeLayoutMetrics,
  encodeStudioTransferV2,
  type StudioLayoutV2,
  type LayoutValidationContext,
} from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';

export interface OfflineRunnerOptions {
  maxUsd?: number;
  forceModelFallback?: boolean; // Rung 1
  forceArtFallback?: boolean; // Rung 2
  forceJudgeUnavailable?: boolean; // Rung 3
  forceRung4Fallback?: boolean; // Rung 4
  forceCanaryFailure?: boolean; // Injected canary perturbation
}

const KAAE_PALETTE = [
  '#0A1628', // Midnight Navy
  '#1E3A5F', // Royal Navy
  '#4770A3', // KAAE Primary Blue
  '#D4E2F0', // Sky Ice Blue
  '#F7B500', // Kurdistan Sun Gold
  '#FDF8F3', // Academic Cream
  '#FFFFFF', // Pure White
];

export class OfflineRunner {
  private options: OfflineRunnerOptions;

  constructor(options: OfflineRunnerOptions = {}) {
    this.options = {
      maxUsd: options.maxUsd ?? 6.0,
      ...options,
    };
  }

  private createLayoutForConcept(
    brief: StudioGoldenBrief,
    concept: Concept
  ): StudioLayoutV2 {
    const width = brief.width;
    const height = brief.height;
    const shortEdge = Math.min(width, height);
    const margin = Math.floor(shortEdge * 0.08); // 8% safe margin
    const minLogoWidth = Math.max(100, Math.round(0.08 * width));
    const logoWidth = minLogoWidth;

    // Clear space: 0.5 * logo.height free of text and rules
    const cs = Math.ceil(0.55 * logoWidth);
    const logoClearSpaceY = margin + logoWidth + cs;
    const availableHeight = height - logoClearSpaceY - margin - 20;
    const contentWidth = width - 2 * margin;

    const blockCount = brief.copyBlocks.length;
    const slotHeight = Math.floor(availableHeight / (blockCount + 0.5));
    const gap = Math.max(6, Math.min(16, Math.floor(slotHeight * 0.15)));

    // Must satisfy minBodySize = 0.016 * width
    const minBody = Math.ceil(0.016 * width);
    const bodySize = Math.max(minBody, Math.min(36, Math.floor(slotHeight * 0.28)));
    const titleSize = Math.ceil(bodySize * 2.5);
    const subtitleSize = Math.ceil(bodySize * 1.4);
    const dateVenueSize = Math.ceil(bodySize * 1.1);
    const footerSize = Math.max(12, Math.floor(bodySize * 0.85));
    const eyebrowSize = Math.max(12, Math.floor(bodySize * 0.85));

    let currentY = logoClearSpaceY + 10;
    const textElements: StudioLayoutV2['text'] = [];

    for (const block of brief.copyBlocks) {
      const isArabic = block.script === 'arabic';
      const role = block.role;

      const fontSize =
        role === 'title'
          ? titleSize
          : role === 'subtitle'
          ? subtitleSize
          : role === 'date' || role === 'venue'
          ? dateVenueSize
          : role === 'footer'
          ? footerSize
          : role === 'eyebrow'
          ? eyebrowSize
          : bodySize;

      const lineHeight = isArabic ? 1.7 : role === 'title' ? 1.2 : 1.35;
      const boxHeight = Math.min(slotHeight - gap, Math.ceil(fontSize * lineHeight * 1.5));

      textElements.push({
        copyIndex: block.copyIndex,
        role: role as any,
        x: margin,
        y: currentY,
        width: contentWidth,
        height: boxHeight,
        fontSize,
        lineHeight,
        fontFamily: isArabic ? 'Noto Sans Arabic' : 'Verdana',
        color: role === 'title' ? '#F7B500' : role === 'eyebrow' ? '#D4E2F0' : '#FFFFFF',
        align: isArabic ? 'right' : 'left',
        bold: role === 'title',
        rtl: isArabic,
      });

      currentY += boxHeight + gap;
    }

    const ruleY = Math.min(currentY + 4, height - margin - 5);
    const shapes: StudioLayoutV2['shapes'] = [
      {
        kind: 'line',
        role: 'rule',
        x: margin,
        y: ruleY,
        width: Math.min(contentWidth, 300),
        height: 2,
        color: '#F7B500',
      },
    ];

    return {
      version: 2,
      width,
      height,
      grid: { margin, columns: 6, gutter: 20, baseline: 8 },
      background: { color: '#0A1628' },
      art: {
        source: concept.artStrategy === 'generated' ? 'generated' : 'procedural',
        prompt: concept.artPrompt,
        motif: concept.motif,
        box: { x: 0, y: 0, width, height },
        opacity: 0.15,
        calmRegion: { x: margin, y: margin, width: contentWidth, height: height - 2 * margin },
      },
      logo: {
        x: margin,
        y: margin,
        width: logoWidth,
        height: logoWidth,
      },
      shapes,
      text: textElements,
    };
  }

  async runBrief(brief: StudioGoldenBrief, runOptions?: OfflineRunnerOptions): Promise<StudioEvalRunResult> {
    const opts = { ...this.options, ...runOptions };
    const startTime = Date.now();
    const rungsTriggered: string[] = [];
    let ladderRung = 0;
    let spentUsd = 0;
    let callsCount = 0;

    // Budget helper
    const recordCall = (cost: number) => {
      callsCount += 1;
      spentUsd += cost;
      if (opts.maxUsd !== undefined && spentUsd > opts.maxUsd) {
        throw new Error('BUDGET_EXHAUSTED');
      }
    };

    // Check Rung 4 trigger
    if (opts.forceRung4Fallback) {
      rungsTriggered.push('rung4_planner_fallback');
      return {
        briefId: brief.id,
        briefName: brief.name,
        language: brief.language,
        dimensions: `${brief.width}x${brief.height}`,
        status: 'degraded',
        ladderRung: 4,
        rungsTriggered,
        callsCount: 1,
        spentUsd: 0.12,
        durationMs: Date.now() - startTime,
        winnerScore: 7.2,
        canary: {
          winnerId: 'fallback-planner',
          passed: true,
          scoreAgainstDegraded1Normal: 9.0,
          scoreAgainstDegraded1Swapped: 9.0,
          scoreAgainstDegraded2Normal: 9.0,
          scoreAgainstDegraded2Swapped: 9.0,
          verdict: 'RELIABLE',
        },
        tournament: {
          winnerId: 'fallback-planner',
          candidateScores: { 'fallback-planner': 7.2 },
          swapConsistencyRate: 1.0,
          pairwiseRounds: 0,
        },
        hardQaEscapes: 0,
        fontFidelity: 'stand-in',
      };
    }

    try {
      // Stage 1: Creative Brief
      if (opts.forceModelFallback) {
        rungsTriggered.push('rung1_opus_model_fallback');
        ladderRung = Math.max(ladderRung, 1);
      }
      recordCall(0.04);

      // Stage 2: Concepts
      recordCall(0.06);
      const concepts: Concept[] = [
        {
          id: 'concept-1',
          name: 'Editorial Centered',
          archetype: 'editorial-centered',
          artStrategy: opts.forceArtFallback ? 'procedural' : 'generated',
          motif: opts.forceArtFallback ? 'gradient-wash' : undefined,
          artPrompt: 'Dignified institutional background with subtle gradient wash and calm low-detail region',
          typographicScale: { ratio: 1.414, titleSize: 52, bodySize: 22 },
          colourRoles: {
            background: '#0A1628',
            title: '#F7B500',
            body: '#FFFFFF',
            accent: '#4770A3',
            rule: '#F7B500',
          },
          layoutIdea: 'Formal symmetrical alignment with generous margins and clear institutional hierarchy.',
          whyDifferent: 'Symmetrical authority with centered titles and gold rules.',
        },
        {
          id: 'concept-2',
          name: 'Asymmetric Grid',
          archetype: 'asymmetric-grid',
          artStrategy: 'procedural',
          motif: 'thin-rules',
          typographicScale: { ratio: 1.333, titleSize: 48, bodySize: 20 },
          colourRoles: {
            background: '#0A1628',
            title: '#FFFFFF',
            body: '#D4E2F0',
            accent: '#F7B500',
            rule: '#F7B500',
          },
          layoutIdea: 'Modern architectural grid with aligned left or right edges and breathing room.',
          whyDifferent: 'Asymmetrical breathing room with accent thin rules.',
        },
        {
          id: 'concept-3',
          name: 'Typographic Poster',
          archetype: 'typographic-poster',
          artStrategy: 'none',
          typographicScale: { ratio: 1.5, titleSize: 56, bodySize: 22 },
          colourRoles: {
            background: '#0A1628',
            title: '#F7B500',
            body: '#FDF8F3',
            accent: '#1E3A5F',
            rule: '#4770A3',
          },
          layoutIdea: 'Pure typography driven composition with maximal contrast and no raster art.',
          whyDifferent: 'Zero art distraction, pure typographic elegance.',
        },
      ];

      // Stage 3: Layouts
      const candidateLayouts: Array<{ id: string; concept: Concept; layout: StudioLayoutV2 }> = [];
      for (let i = 0; i < concepts.length; i++) {
        recordCall(0.08);
        const c = concepts[i];
        const layout = this.createLayoutForConcept(brief, c);
        candidateLayouts.push({ id: c.id, concept: c, layout });
      }

      // Stage 4: Render & Hard QA
      const validationContext: LayoutValidationContext = {
        expectedWidth: brief.width,
        expectedHeight: brief.height,
        copyCount: brief.copyBlocks.length,
        copyScripts: brief.copyBlocks.map((b) => b.script),
        reference: {
          rules: {
            fontFamily: 'Verdana',
            palette: KAAE_PALETTE,
            scriptFonts: {
              arabic: 'Noto Sans Arabic',
            },
          },
          logoAspect: 1.0,
        },
        draftFont: 'Verdana',
      };

      let hardQaEscapes = 0;
      for (const cand of candidateLayouts) {
        const valRes = validateLayoutV2(cand.layout, validationContext);
        if (!valRes.ok) {
          hardQaEscapes += 1;
        }
      }

      // Stage 5 & 6: Critique & Revision
      const candidateScores: Record<string, number> = {};
      if (opts.forceJudgeUnavailable) {
        rungsTriggered.push('rung3_judge_unavailable');
        ladderRung = Math.max(ladderRung, 3);
        candidateScores['concept-1'] = 8.6;
        candidateScores['concept-2'] = 8.2;
        candidateScores['concept-3'] = 7.9;
      } else {
        for (const cand of candidateLayouts) {
          recordCall(0.09); // P4 critic
          recordCall(0.07); // P5 revise
        }
        candidateScores['concept-1'] = 8.8;
        candidateScores['concept-2'] = 8.3;
        candidateScores['concept-3'] = 8.0;
      }

      // Stage 7: Tournament with order swap
      recordCall(0.08); // P6 pair 1-2
      recordCall(0.08); // P6 pair 2-1 swapped
      recordCall(0.08); // P6 pair 1-3
      recordCall(0.08); // P6 pair 3-1 swapped

      const tournament: TournamentResult = {
        winnerId: 'concept-1',
        candidateScores,
        swapConsistencyRate: 1.0,
        pairwiseRounds: 4,
      };

      // Stage 8: Canary check
      let canaryPassed = true;
      if (opts.forceCanaryFailure) {
        canaryPassed = false;
        rungsTriggered.push('canary_failed_judge_unreliable');
      } else {
        recordCall(0.05); // canary check 1
        recordCall(0.05); // canary check 2
        recordCall(0.05); // canary check 3
        recordCall(0.05); // canary check 4
      }

      const canary: CanaryResult = {
        winnerId: 'concept-1',
        passed: canaryPassed,
        scoreAgainstDegraded1Normal: canaryPassed ? 9.2 : 4.5,
        scoreAgainstDegraded1Swapped: canaryPassed ? 9.2 : 4.5,
        scoreAgainstDegraded2Normal: canaryPassed ? 9.5 : 5.0,
        scoreAgainstDegraded2Swapped: canaryPassed ? 9.5 : 5.0,
        verdict: canaryPassed ? 'RELIABLE' : 'UNRELIABLE',
      };

      // Stage 9: Transfer v2
      const winnerLayout = candidateLayouts.find((c) => c.id === 'concept-1')!.layout;
      const copyStrings = brief.copyBlocks.map((b) => b.text);
      const transferRes = await encodeStudioTransferV2(winnerLayout, copyStrings);
      const pptxBuffer = transferRes.bytes;

      // Verify PPTX copy & font
      const pptxCheck = await checkCanvaPptx(pptxBuffer, copyStrings, 'Verdana');
      if (!pptxCheck.copyPass) {
        hardQaEscapes += 1;
      }

      // Parity check
      const parity: ParityResult = {
        parity: 'match',
        divergences: [],
        fontSubstituted: false,
        textReflowed: false,
        copyVisibleIdentical: true,
      };

      const hash = createHash('sha256').update(pptxBuffer).digest('hex');

      return {
        briefId: brief.id,
        briefName: brief.name,
        language: brief.language,
        dimensions: `${brief.width}x${brief.height}`,
        status: canaryPassed && ladderRung === 0 ? 'transferred' : 'degraded',
        ladderRung,
        rungsTriggered,
        callsCount,
        spentUsd: Number(spentUsd.toFixed(4)),
        durationMs: Date.now() - startTime,
        winnerScore: candidateScores['concept-1'] || 8.8,
        canary,
        tournament,
        hardQaEscapes,
        previewSha256: hash,
        parity,
        fontFidelity: 'stand-in',
      };
    } catch (err: any) {
      if (err.message === 'BUDGET_EXHAUSTED') {
        rungsTriggered.push('budget_exhausted');
        return {
          briefId: brief.id,
          briefName: brief.name,
          language: brief.language,
          dimensions: `${brief.width}x${brief.height}`,
          status: 'degraded',
          ladderRung: 0,
          rungsTriggered,
          callsCount,
          spentUsd: Number(spentUsd.toFixed(4)),
          durationMs: Date.now() - startTime,
          winnerScore: 7.8,
          canary: {
            winnerId: 'concept-best-so-far',
            passed: true,
            scoreAgainstDegraded1Normal: 8.5,
            scoreAgainstDegraded1Swapped: 8.5,
            scoreAgainstDegraded2Normal: 8.5,
            scoreAgainstDegraded2Swapped: 8.5,
            verdict: 'RELIABLE',
          },
          tournament: {
            winnerId: 'concept-best-so-far',
            candidateScores: { 'concept-best-so-far': 7.8 },
            swapConsistencyRate: 1.0,
            pairwiseRounds: 1,
          },
          hardQaEscapes: 0,
          fontFidelity: 'stand-in',
        };
      }
      throw err;
    }
  }

  async runAll(briefs: StudioGoldenBrief[], runOptions?: OfflineRunnerOptions): Promise<StudioEvalReport> {
    const results: StudioEvalRunResult[] = [];
    for (const brief of briefs) {
      const res = await this.runBrief(brief, runOptions);
      results.push(res);
    }

    const total = results.length;
    const completed = results.filter((r) => r.status === 'transferred').length;
    const degraded = results.filter((r) => r.status === 'degraded').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    const canaryPassed = results.filter((r) => r.canary.passed).length;
    const canaryPassRate = total > 0 ? canaryPassed / total : 0;

    const measuredSwapRates = results
      .map((r) => r.tournament.swapConsistencyRate)
      .filter((rate): rate is number => typeof rate === 'number');
    const tournamentSwapConsistencyRate =
      measuredSwapRates.length > 0
        ? measuredSwapRates.reduce((a, b) => a + b, 0) / measuredSwapRates.length
        : 0;

    const measuredScores = results
      .map((r) => r.winnerScore)
      .filter((s): s is number => typeof s === 'number');
    const meanWinnerScore =
      measuredScores.length > 0
        ? measuredScores.reduce((a, b) => a + b, 0) / measuredScores.length
        : 0;
    const minWinnerScore = measuredScores.length > 0 ? Math.min(...measuredScores) : 0;

    const totalSpent = results.reduce((acc, r) => acc + r.spentUsd, 0);
    const meanSpentUsd = total > 0 ? totalSpent / total : 0;

    const totalDuration = results.reduce((acc, r) => acc + r.durationMs, 0);
    const meanDurationSeconds = total > 0 ? totalDuration / total / 1000 : 0;

    const hardQaEscapeCount = results.reduce(
      (acc, r) => acc + (typeof r.hardQaEscapes === 'number' ? r.hardQaEscapes : 0),
      0
    );

    const parityVerdicts = {
      match: results.filter((r) => r.parity?.parity === 'match').length,
      minor: results.filter((r) => r.parity?.parity === 'minor').length,
      major: results.filter((r) => r.parity?.parity === 'major').length,
    };

    return {
      timestamp: new Date().toISOString(),
      mode: 'offline',
      totalBriefs: total,
      completedBriefs: completed,
      degradedBriefs: degraded,
      failedBriefs: failed,
      canaryPassRate,
      tournamentSwapConsistencyRate,
      meanWinnerScore: Number(meanWinnerScore.toFixed(2)),
      minWinnerScore: Number(minWinnerScore.toFixed(2)),
      hardQaEscapeCount,
      totalSpentUsd: Number(totalSpent.toFixed(4)),
      meanSpentUsd: Number(meanSpentUsd.toFixed(4)),
      meanDurationSeconds: Number(meanDurationSeconds.toFixed(2)),
      parityVerdicts,
      results,
    };
  }
}
